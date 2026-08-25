#!/usr/bin/env bun
/**
 * Multi-turn probe for the passthrough synthetic-denial defect.
 * See ~/ss/claude/meridian-passthrough-spec.md — *Phase 3 field test*.
 *
 * A single-turn probe cannot see this defect: `resumeSessionAt` cuts a suffix,
 * so it removes the current turn's denials and never a previous turn's. This
 * one drives the raw Agent SDK through a chain of dependent tool calls, one
 * per turn, resuming at the checkpoint each time exactly as Meridian does, and
 * records WHAT THE MODEL WAS SENT via a recording proxy on ANTHROPIC_BASE_URL.
 * The transcript on disk is shown too, with its parentUuid topology, because
 * the CLI loads by walking that chain and then splicing back "orphaned"
 * tool_results — which is how a logically truncated denial comes back.
 *
 * The one assertion that matters: on the wire, every call whose real result
 * was delivered is answered exactly once, by that real result. "Answered more
 * than once" is not enough — the CLI dedups tool_results per id and keeps the
 * FIRST, so the observed failure is the denial winning and the real result
 * vanishing.
 *
 *   bun scripts/probe-passthrough-accumulation.mjs            # measure: FAILs
 *   bun scripts/probe-passthrough-accumulation.mjs --rewrite  # with the
 *       shipped repair (src/proxy/passthroughTranscript.ts) applied before
 *       each resume, exactly where server.ts applies it: PASSes
 *
 * Deleting the denial rows instead is not an option: the loader starts its
 * chain walk from the `last-prompt` leaf hint, which points at the deleted
 * row, and the resume fails with "No message found with message.uuid".
 *
 * Costs a few cents of real tokens and needs Claude Max.
 */
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import http from "node:http"
import https from "node:https"
import { findSessionFile, readRows, blocksOf, toolResultText, isDenyResult } from "./lib/passthrough-jsonl.mjs"
import { resolveClaudeExecutableAsync } from "../src/proxy/models.ts"
import { PASSTHROUGH_DENY_REASON, repairForwardedDenials, transcriptConfigDirs } from "../src/proxy/passthroughTranscript.ts"

const FIX = process.argv.includes("--rewrite") ? "rewrite" : "none"
const MODEL = process.env.PROBE_MODEL ?? "sonnet"
const MAX_TURNS = Number(process.env.PROBE_TURNS ?? 5)
const WORKDIR = mkdtempSync(join(tmpdir(), "meridian-probe-acc-"))
const FILES = ["a.txt", "b.txt", "c.txt"].map(f => join(WORKDIR, f))
const CONTENT = { "a.txt": "alpha", "b.txt": "bravo", "c.txt": "charlie" }
for (const f of FILES) writeFileSync(f, CONTENT[f.slice(-5)] + "\n")

const short = s => (typeof s === "string" && s.length > 10 ? s.slice(-8) : String(s))

// ---------------------------------------------------------------- wire tap
/**
 * Minimal recording proxy: the CLI talks to it as ANTHROPIC_BASE_URL, it
 * forwards to the real API and keeps every request body, labelled with the
 * probe turn that produced it. Responses stream straight through.
 */
const wire = []
let currentTurn = 0
const UPSTREAM = new URL(process.env.PROBE_UPSTREAM ?? "https://api.anthropic.com")
const tap = http.createServer((req, res) => {
  const chunks = []
  req.on("data", c => chunks.push(c))
  req.on("end", () => {
    const raw = Buffer.concat(chunks)
    let body = null
    try { body = JSON.parse(raw.toString("utf8")) } catch { /* not JSON */ }
    if (body?.messages) wire.push({ turn: currentTurn, path: req.url, body })
    const client = UPSTREAM.protocol === "https:" ? https : http
    const up = client.request(
      { hostname: UPSTREAM.hostname, port: UPSTREAM.port || undefined, path: req.url, method: req.method,
        headers: { ...req.headers, host: UPSTREAM.host } },
      u => { res.writeHead(u.statusCode ?? 502, u.headers); u.pipe(res) },
    )
    up.on("error", e => { res.writeHead(502); res.end(String(e)) })
    up.end(raw)
  })
})
await new Promise(r => tap.listen(0, "127.0.0.1", r))
const TAP_URL = `http://127.0.0.1:${tap.address().port}`

// ---------------------------------------------------------------- SDK drive
const claudeExecutable = await resolveClaudeExecutableAsync()

function mkServer() {
  const server = createSdkMcpServer({ name: "oc" })
  server.instance.registerTool(
    "read",
    { description: "Read a file from disk", inputSchema: { file_path: z.string() } },
    async () => ({ content: [{ type: "text", text: "passthrough" }] }),
  )
  return server
}

/** Mirrors the passthrough shape buildQueryOptions produces. */
function options(extra = {}) {
  return {
    executable: "node",
    maxTurns: 1,
    cwd: WORKDIR,
    model: MODEL,
    pathToClaudeCodeExecutable: claudeExecutable,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    tools: [],
    allowedTools: ["mcp__oc__read"],
    mcpServers: { oc: mkServer() },
    settingSources: [],
    plugins: [],
    systemPrompt: "",
    env: { ...process.env, ANTHROPIC_BASE_URL: TAP_URL },
    hooks: {
      PreToolUse: [{
        matcher: "",
        hooks: [async (input) => {
          if (input.tool_name === "ToolSearch" || input.tool_name === "StructuredOutput") return {}
          return { decision: "block", reason: PASSTHROUGH_DENY_REASON }
        }],
      }],
    },
    ...extra,
  }
}

async function drive(prompt, extra) {
  const out = { sessionId: "", subtype: null, text: "", calls: [], checkpointUuid: "", threw: undefined }
  try {
    for await (const m of query({ prompt, options: options(extra) })) {
      if (m.session_id && !out.sessionId) out.sessionId = m.session_id
      if (m.type === "assistant") {
        let armed = false
        for (const b of m.message?.content ?? []) {
          if (b.type === "tool_use") { out.calls.push({ id: b.id, name: b.name, input: b.input }); armed = true }
          if (b.type === "text") out.text += b.text
        }
        if (armed) out.checkpointUuid = m.uuid ?? ""
      }
      if (m.type === "result") out.subtype = m.subtype
    }
  } catch (e) {
    out.threw = e instanceof Error ? e.message : String(e)
  }
  return out
}

// ---------------------------------------------------------------- reporting
function describeRow(row, index) {
  const blocks = blocksOf(row).map(b => {
    if (b.type === "tool_use") return `tool_use:${short(b.id)}(${b.name})`
    if (b.type === "tool_result") return `tool_result:${short(b.tool_use_id)}=${isDenyResult(b) ? "DENY" : JSON.stringify(toolResultText(b).slice(0, 20))}`
    return b.type
  })
  const content = typeof row.message?.content === "string" ? JSON.stringify(row.message.content.slice(0, 30)) : blocks.join(",")
  return `[${String(index).padStart(2)}] ${(row.type ?? "?").padEnd(9)} uuid=${short(row.uuid)} parent=${short(row.parentUuid) ?? "-"}  ${content}`
}

function dumpTranscript(label, file) {
  const rows = readRows(file)
  console.log(`  --- ${label}: ${rows.length} rows on disk`)
  rows.forEach((r, i) => console.log("    " + describeRow(r, i)))
  return rows
}

/** tool_use_id -> list of answers, from a request body's messages. */
function answersOnWire(body) {
  const byId = new Map()
  for (const m of body.messages ?? []) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b?.type !== "tool_result") continue
      const list = byId.get(b.tool_use_id) ?? []
      list.push(isDenyResult(b) ? "DENY" : "REAL")
      byId.set(b.tool_use_id, list)
    }
  }
  return byId
}

/**
 * The wire report for one probe turn: what the model saw for every id.
 * Returns how many DELIVERED ids were misanswered — anything other than a
 * single REAL result.
 */
function reportWire(turn, delivered) {
  // The first turn also fires side requests (title generation); only the
  // conversation requests carry history worth reading.
  const reqs = wire.filter(w => w.turn === turn && w.body.messages.length > 1)
  if (reqs.length === 0) { console.log(`  wire: ${delivered.size === 0 ? "first turn, nothing to check" : "NO REQUEST RECORDED (is ANTHROPIC_BASE_URL honoured?)"}`); return 0 }
  let bad = 0
  for (const [i, r] of reqs.entries()) {
    const byId = answersOnWire(r.body)
    const wrong = [...delivered].filter(id => (byId.get(id) ?? []).join() !== "REAL")
    bad += wrong.length
    const denialTexts = JSON.stringify(r.body).split(PASSTHROUGH_DENY_REASON.slice(0, 40)).length - 1
    console.log(`  wire request ${i + 1}/${reqs.length}: ${r.body.messages.length} messages, ` +
      `${byId.size} id(s) answered, ${wrong.length} delivered id(s) MISANSWERED, denial text present ${denialTexts}x`)
    for (const [id, answers] of byId) {
      const verdict = !delivered.has(id) ? "" : answers.join() === "REAL" ? "  ok" : "  <-- WRONG (real result was delivered)"
      console.log(`    ${short(id)}: ${answers.join(" then ")}${verdict}`)
    }
  }
  return bad
}

// ---------------------------------------------------------------- run
console.log(`model=${MODEL} fix=${FIX} workdir=${WORKDIR} tap=${TAP_URL}`)

const prompt =
  `Use the read tool to read ${FILES[0]}. Only after its content has been returned to you, ` +
  `read ${FILES[1]}. Only after that content has been returned, read ${FILES[2]}. ` +
  `Make exactly one read call per step, never in parallel, and once you have all three ` +
  `reply with the three contents on one line and nothing else.`

let sessionId = ""
let checkpoint = ""
let pendingCalls = []
let file = null
let totalBad = 0
let lastText = ""
const delivered = new Set()

for (let turn = 1; turn <= MAX_TURNS; turn++) {
  currentTurn = turn
  console.log(`\n=== turn ${turn} ${turn === 1 ? "(first)" : `(resume at ${short(checkpoint)}, answering ${pendingCalls.map(c => short(c.id)).join(",")})`} ===`)

  let result
  if (turn === 1) {
    result = await drive(prompt)
  } else {
    const realResults = pendingCalls.map(c => ({
      type: "tool_result",
      tool_use_id: c.id,
      content: `REALOUTPUT[${CONTENT[String(c.input?.file_path ?? "").slice(-5)] ?? "?"}]`,
    }))
    if (FIX === "rewrite") {
      const repair = repairForwardedDenials({ sessionId, configDirs: transcriptConfigDirs(process.env), results: realResults })
      console.log(`  repair: rewrote ${repair.rewritten} denial(s) in ${repair.file ?? "(no transcript found)"}`)
    }
    for (const c of pendingCalls) delivered.add(c.id)
    const delta = (async function* () {
      yield { type: "user", session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content: realResults } }
    })()
    result = await drive(delta, { resume: sessionId, resumeSessionAt: checkpoint })
  }

  if (turn === 1) sessionId = result.sessionId
  console.log(`  subtype=${result.subtype} threw=${result.threw ?? "no"} calls=${result.calls.map(c => `${c.name}(${String(c.input?.file_path ?? "").slice(-5)})`).join(",") || "none"}`)
  if (result.text) console.log(`  text=${JSON.stringify(result.text.slice(0, 160))}`)
  lastText = result.text

  file ??= findSessionFile(sessionId)
  if (!file) { console.log("FAIL: no session JSONL found"); process.exit(1) }
  dumpTranscript(`transcript after turn ${turn}`, file)
  totalBad += reportWire(turn, delivered)

  if (result.calls.length === 0) break
  pendingCalls = result.calls
  checkpoint = result.checkpointUuid
}

console.log(`\n=== verdict (fix=${FIX}) ===`)
const quotes = ["alpha", "bravo", "charlie"].filter(w => lastText.includes(w))
console.log(`  delivered ids misanswered on the wire, summed over turns: ${totalBad}`)
console.log(`  final reply quotes ${quotes.length}/3 contents: ${quotes.join(",") || "none"}`)
const pass = totalBad === 0 && quotes.length === 3
console.log(`  ${pass ? "PASS" : "FAIL"}: one call, one answer, the real one`)
console.log(`\nsession file: ${file}`)
tap.close()
process.exit(pass ? 0 : 1)
