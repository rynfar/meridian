#!/usr/bin/env bun
/**
 * Phase 1 ground-truth probe for the passthrough synthetic-denial defect.
 * See ~/ss/claude/meridian-passthrough-spec.md — this answers questions 1-4
 * by reading the session JSONL the SDK actually writes, not by reasoning
 * about Meridian's code.
 *
 * It drives the raw Agent SDK in the exact passthrough shape (deny hook +
 * maxTurns 1), then dumps every JSONL row so the answers are observed:
 *
 *   Q3  Is the deny stored as the call's tool_result?
 *   Q3b Does it survive `resumeSessionAt` truncation, which slices the loaded
 *       transcript to (0, checkpointIndex + 1)?  Interleaved per-block
 *       assistant messages would leave earlier denies INSIDE the slice.
 *   Q4  What happens when the resumed turn supplies a real tool_result for a
 *       tool_use_id the session already answered?
 *
 * Costs a few cents of real tokens and needs Claude Max.
 *
 *   bun scripts/probe-passthrough-transcript.mjs
 */
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findSessionFile, readRows, toolResultText, isDenyResult } from "./lib/passthrough-jsonl.mjs"
import { resolveClaudeExecutableAsync } from "../src/proxy/models.ts"

const MODEL = process.env.PROBE_MODEL ?? "sonnet"
const WORKDIR = mkdtempSync(join(tmpdir(), "meridian-probe-"))
const A = join(WORKDIR, "a.txt")
const B = join(WORKDIR, "b.txt")
writeFileSync(A, "alpha\n")
writeFileSync(B, "bravo\n")

const DENY_REASON =
  "This tool call has been forwarded to the client for execution. " +
  "The result will be delivered in a future turn. " +
  "Do not retry, do not call additional tools, and do not generate further text — end your turn now."

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
function options(maxTurns, extra = {}) {
  return {
    executable: "node",
    maxTurns,
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
    hooks: {
      PreToolUse: [{
        matcher: "",
        hooks: [async (input) => {
          if (input.tool_name === "ToolSearch" || input.tool_name === "StructuredOutput") return {}
          return { decision: "block", reason: DENY_REASON }
        }],
      }],
    },
    ...extra,
  }
}

/** Drive one query, recording the iterator's view of the turn. */
async function drive(prompt, maxTurns, extra) {
  const out = {
    sessionId: "",
    subtype: null,
    text: "",
    /** every forwarded tool_use, in iterator order */
    calls: [],
    /** the assistant UUID Meridian would freeze as the checkpoint */
    checkpointUuid: "",
    /** iterator-order log of assistant/user messages */
    iterator: [],
  }
  try {
    for await (const m of query({ prompt, options: options(maxTurns, extra) })) {
      if (m.session_id && !out.sessionId) out.sessionId = m.session_id
      if (m.type === "assistant") {
        const blocks = m.message?.content ?? []
        out.iterator.push(`assistant[${blocks.map(b => b.type).join(",")}] uuid=${short(m.uuid)}`)
        let armed = false
        for (const b of blocks) {
          if (b.type === "tool_use") {
            out.calls.push({ id: b.id, name: b.name, input: b.input })
            armed = true
          }
          if (b.type === "text") out.text += b.text
        }
        // noteAssistantMessage: a newer tool-bearing message supersedes the
        // older checkpoint.
        if (armed) out.checkpointUuid = m.uuid ?? ""
      }
      if (m.type === "user") {
        const blocks = Array.isArray(m.message?.content) ? m.message.content : []
        out.iterator.push(
          `user[${blocks.map(b => b.type + (b.tool_use_id ? `:${short(b.tool_use_id)}` : "")).join(",")}]`,
        )
      }
      if (m.type === "result") out.subtype = m.subtype
    }
  } catch (e) {
    out.threw = e instanceof Error ? e.message : String(e)
  }
  return out
}

const short = s => (typeof s === "string" && s.length > 10 ? s.slice(-8) : String(s))

/** One-line summary of a JSONL row: what it is and what it answers. */
function describe(row) {
  const kind = row.type ?? "?"
  const content = row.message?.content
  let blocks = ""
  if (Array.isArray(content)) {
    blocks = content
      .map(b => {
        if (b.type === "tool_use") return `tool_use:${short(b.id)}(${b.name})`
        if (b.type === "tool_result") {
          const text = toolResultText(b)
          return `tool_result:${short(b.tool_use_id)}${b.is_error ? "!err" : ""}=${isDenyResult(b) ? "DENY" : JSON.stringify(text.slice(0, 24))}`
        }
        return b.type
      })
      .join(",")
  } else if (typeof content === "string") {
    blocks = JSON.stringify(content.slice(0, 40))
  }
  return `${kind}${row.isMeta ? "/meta" : ""}${row.subtype ? `/${row.subtype}` : ""} uuid=${short(row.uuid)} [${blocks}]`
}

/** Every tool_result id carried by a row, with whether it is a deny. */
function toolResultsIn(row) {
  const content = row.message?.content
  if (!Array.isArray(content)) return []
  const out = []
  for (const b of content) {
    if (b?.type !== "tool_result") continue
    out.push({ id: b.tool_use_id, deny: isDenyResult(b), text: toolResultText(b) })
  }
  return out
}

function dump(label, file) {
  const rows = readRows(file)
  console.log(`\n--- ${label}: ${rows.length} rows — ${file}`)
  rows.forEach((r, i) => console.log(`  [${String(i).padStart(2)}] ${describe(r)}`))
  return rows
}

// ---------------------------------------------------------------------------

console.log(`model=${MODEL}  workdir=${WORKDIR}`)

console.log("\n=== 1. capped passthrough turn with PARALLEL calls ===")
const turn = await drive(
  `Read both ${A} and ${B} using the read tool, in parallel in a single step.`,
  1,
)
console.log(`  session=${turn.sessionId} subtype=${turn.subtype} calls=${turn.calls.length}`)
console.log(`  checkpoint(assistant uuid)=${short(turn.checkpointUuid)}`)
console.log("  iterator order:")
for (const line of turn.iterator) console.log(`    ${line}`)

const file = findSessionFile(turn.sessionId)
if (!file) {
  console.log("\nFAIL: no session JSONL found — cannot answer Q3/Q4.")
  process.exit(1)
}
const rows = dump("JSONL after the capped turn", file)

// Q3 — is the deny stored as the call's tool_result?
const denies = rows.flatMap((r, i) => toolResultsIn(r).filter(t => t.deny).map(t => ({ ...t, index: i })))
console.log("\n=== Q3: is the deny persisted as the call's tool_result? ===")
console.log(`  ${denies.length > 0 ? "YES" : "NO"} — ${denies.length} deny tool_result(s) on disk`)
for (const d of denies) console.log(`    row ${d.index}  tool_use_id=${short(d.id)}`)

// Q3b — does it survive resumeSessionAt truncation?
const checkpointIndex = rows.findIndex(r => r.uuid === turn.checkpointUuid)
console.log("\n=== Q3b: does the deny survive resumeSessionAt truncation? ===")
console.log(`  checkpoint row index = ${checkpointIndex} of ${rows.length - 1}`)
if (checkpointIndex < 0) {
  console.log("  the checkpoint UUID is NOT in the JSONL — resume would fail with missing-message")
} else {
  const kept = rows.slice(0, checkpointIndex + 1)
  const survivors = kept.flatMap((r, i) => toolResultsIn(r).filter(t => t.deny).map(t => ({ ...t, index: i })))
  console.log(`  slice(0, ${checkpointIndex + 1}) keeps ${kept.length} rows`)
  console.log(`  deny tool_results INSIDE the slice: ${survivors.length}`)
  for (const s of survivors) console.log(`    row ${s.index}  tool_use_id=${short(s.id)}  <-- REPLAYED TO THE MODEL`)
  if (survivors.length === 0) {
    console.log("  => the truncation removes every deny; the resumed history is clean")
  }
  const callIds = new Set(turn.calls.map(c => c.id))
  const keptCalls = kept.flatMap(r =>
    (Array.isArray(r.message?.content) ? r.message.content : [])
      .filter(b => b?.type === "tool_use" && callIds.has(b.id))
      .map(b => b.id))
  console.log(`  forwarded tool_use blocks inside the slice: ${keptCalls.length} of ${callIds.size}`)
  const missing = [...callIds].filter(id => !keptCalls.includes(id))
  if (missing.length) console.log(`    MISSING from the slice: ${missing.map(short).join(", ")} <-- dangling client result`)
}

// Q4 — resume with a real tool_result for an already-answered id.
console.log("\n=== 2. resume at the checkpoint with REAL tool_results ===")
const realResults = turn.calls.map(c => ({
  type: "tool_result",
  tool_use_id: c.id,
  content: `REALOUTPUT[${c.input?.file_path?.endsWith("a.txt") ? "alpha" : "bravo"}]`,
}))
const delta = (async function* () {
  yield {
    type: "user",
    session_id: turn.sessionId,
    parent_tool_use_id: null,
    message: { role: "user", content: realResults },
  }
})()
const resumed = await drive(delta, 1, { resume: turn.sessionId, resumeSessionAt: turn.checkpointUuid })
console.log(`  subtype=${resumed.subtype} threw=${resumed.threw ?? "no"}`)
console.log(`  text=${JSON.stringify(resumed.text.slice(0, 200))}`)
console.log(`  quotes the real output: ${resumed.text.includes("alpha") || resumed.text.includes("bravo") || resumed.text.includes("REALOUTPUT")}`)
console.log(`  re-called the tool: ${resumed.calls.length > 0} (${resumed.calls.length} call(s))`)

const resumedFile = findSessionFile(resumed.sessionId) ?? file
const rows2 = dump("JSONL after the resume", resumedFile)
console.log(`  resumed session id ${resumed.sessionId === turn.sessionId ? "REUSED" : `FORKED (${resumed.sessionId})`}`)

console.log("\n=== Q4: two results for one tool_use_id? ===")
const byId = new Map()
for (const [i, r] of rows2.entries()) {
  for (const t of toolResultsIn(r)) {
    if (!byId.has(t.id)) byId.set(t.id, [])
    byId.get(t.id).push({ index: i, deny: t.deny, text: t.text.slice(0, 40) })
  }
}
for (const [id, hits] of byId) {
  console.log(`  ${short(id)}: ${hits.length} result(s) — ${hits.map(h => `row ${h.index}:${h.deny ? "DENY" : "REAL"}`).join(", ")}`)
}
const dupes = [...byId.values()].filter(h => h.length > 1)
console.log(`  ids answered more than once: ${dupes.length}`)

console.log(`\nworkdir kept for inspection: ${WORKDIR}`)
console.log(`session file: ${file}`)
