#!/usr/bin/env bun
/**
 * Multi-turn passthrough conversation through the REAL proxy.
 *
 * probe-passthrough-accumulation.mjs proves the defect and the repair at the
 * SDK level. This drives Meridian itself the way OpenCode does: send a
 * request with tools, execute the tool_use blocks it returns, replay the
 * whole history plus tool_results as the next request, repeat until the
 * model answers in text. The proxy strips ANTHROPIC_BASE_URL from the SDK
 * subprocess, so the wire is not observable here; the verdict rests on two
 * things that are:
 *
 *   - the model's final answer quotes every file it was handed, and it never
 *     says a call went unanswered
 *   - the session JSONL holds no forwarded denial for an id whose real result
 *     was delivered
 *
 * Run it against the fix and it passes; stash src/proxy/server.ts and it
 * fails on both counts by the third turn.
 *
 *   bun scripts/e2e-passthrough-turns.mjs [--stream]
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { snapshotSessionFiles as snapshot, readRows, blocksOf } from "./lib/passthrough-jsonl.mjs"
import { isForwardedDenial } from "../src/proxy/passthroughTranscript.ts"

process.env.MERIDIAN_PASSTHROUGH = "1"
process.env.OPENCODE_CLAUDE_PROVIDER_DEBUG = "1"
const { startProxyServer } = await import("../src/proxy/server.ts")

const STREAM = process.argv.includes("--stream")
const PORT = Number(process.env.PROBE_PORT ?? 3522)
const MODEL = process.env.PROBE_MODEL ?? "claude-sonnet-5"
const MAX_TURNS = Number(process.env.PROBE_TURNS ?? 6)

const WORKDIR = mkdtempSync(join(tmpdir(), "meridian-probe-proxy-"))
const CONTENT = { "a.txt": "alpha", "b.txt": "bravo", "c.txt": "charlie" }
const FILES = Object.keys(CONTENT).map(f => join(WORKDIR, f))
for (const f of FILES) writeFileSync(f, CONTENT[f.slice(-5)] + "\n")

const READ_TOOL = {
  name: "read",
  description: "Read a file from disk",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string", description: "Absolute path" } },
    required: ["file_path"],
  },
}

// The proxy logs on stdout and stderr; keep both out of the probe's own
// output and readable for the per-turn repair line.
const say = console.log.bind(console)
const proxyLog = []
// claudeLog events go through console.debug, plog through console.error;
// both must be captured or the repair readout below can never see its event.
for (const k of ["log", "error", "debug"]) console[k] = (...args) => { proxyLog.push(args.map(String).join(" ")) }
const inst = await startProxyServer({ port: PORT, host: "127.0.0.1" })
const short = s => (typeof s === "string" && s.length > 10 ? s.slice(-8) : String(s))

/** Parse either response shape into assistant content blocks plus usage. */
async function assistantBlocks(res) {
  const text = await res.text()
  if (!STREAM) { const body = JSON.parse(text); return { blocks: body.content ?? [], usage: body.usage ?? {} } }
  const blocks = []
  let usage = {}
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    let ev
    try { ev = JSON.parse(line.slice(5)) } catch { continue }
    if (ev.type === "message_start") usage = { ...usage, ...(ev.message?.usage ?? {}) }
    if (ev.type === "message_delta" && ev.usage) usage = { ...usage, ...ev.usage }
    if (ev.type === "content_block_start") blocks[ev.index] = { ...ev.content_block, ...(ev.content_block.type === "tool_use" ? { _json: "" } : {}) }
    if (ev.type === "content_block_delta") {
      const b = blocks[ev.index]
      if (ev.delta.type === "text_delta") b.text = (b.text ?? "") + ev.delta.text
      if (ev.delta.type === "input_json_delta") b._json += ev.delta.partial_json
    }
  }
  return { usage, blocks: blocks.filter(Boolean).map(b => {
    if (b.type === "tool_use") { const { _json, ...rest } = b; return { ...rest, input: _json ? JSON.parse(_json) : (b.input ?? {}) } }
    return b
  }) }
}

/** One line of prompt-cache accounting: what was read from cache vs paid for. */
const usageLine = u => {
  const read = u.cache_read_input_tokens ?? 0, created = u.cache_creation_input_tokens ?? 0, fresh = u.input_tokens ?? 0
  const total = read + created + fresh
  return `cache_read=${read} cache_create=${created} input=${fresh} (${total ? Math.round(100 * read / total) : 0}% of ${total} input read from cache)`
}

// Prompt-cache continuity across resumes. Every continuation turn's prompt is
// the previous turn's prompt plus a delta, so its cache_read must cover what
// the previous turn had in cache (cache_read + cache_create). Measured, the
// two are equal to the token; a shortfall means the resumed transcript no
// longer matches what was sent — which is exactly what a repair that wrote a
// different byte than the client delivered would cause.
const CACHE_FLOOR = 0.95
let priorCached = 0
const cacheMisses = []
function checkCache(label, usage, lineage) {
  const read = usage.cache_read_input_tokens ?? 0
  if (lineage.includes("continuation") && priorCached > 0 && read < CACHE_FLOOR * priorCached) {
    cacheMisses.push(`${label}: cache_read=${read} < ${CACHE_FLOOR} x prior cached ${priorCached}`)
  }
  priorCached = read + (usage.cache_creation_input_tokens ?? 0)
}

async function send(messages) {
  return fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "dummy", "x-opencode-session": sessionId, "user-agent": "opencode/1.0.0" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, stream: STREAM, tools: [READ_TOOL], messages }),
  })
}

const sessionId = `probe-turns-${STREAM ? "stream" : "nonstream"}-${process.pid}`
// PROBE_PARALLEL=1 asks for all three reads in one turn, so the hook's denies
// arrive while the turn is still generating and are HELD. Pair it with
// DENY_HOLD_TIMEOUT_MS=1 to make the hold expire, which refuses the checkpoint
// and forces the next turn through the text-path resume — the one way to
// exercise that path from outside the proxy.
const PARALLEL = process.env.PROBE_PARALLEL === "1"
const messages = [{
  role: "user",
  content: PARALLEL
    ? `Use the read tool to read ${FILES.join(", ")} — all three in a single turn, in parallel. ` +
      `Once you have all three contents reply with them on one line and nothing else.`
    : `Use the read tool to read ${FILES[0]}. Only after its content has been returned to you, ` +
      `read ${FILES[1]}. Only after that content has been returned, read ${FILES[2]}. ` +
      `Make exactly one read call per step, never in parallel, and once you have all three ` +
      `reply with the three contents on one line and nothing else.`,
}]

const before = snapshot()
const delivered = new Set()
// Session-id prefixes the proxy actually RESUMED. Only their transcripts are
// ever loaded again, so only they can replay a stale denial; a session the
// proxy abandoned (lineage=new on the next turn) is dead and irrelevant.
const resumedSessions = new Set()
let finalText = ""

for (let turn = 1; turn <= MAX_TURNS; turn++) {
  const logFrom = proxyLog.length
  const res = await send(messages)
  const { blocks, usage } = await assistantBlocks(res)
  const calls = blocks.filter(b => b.type === "tool_use")
  const text = blocks.filter(b => b.type === "text").map(b => b.text).join("")
  const turnLog = proxyLog.slice(logFrom)
  const repaired = turnLog.filter(l => l.includes("denials_rewrit"))
  const lineage = turnLog.map(l => l.match(/lineage=\S+ session=\S+/)?.[0]).find(Boolean) ?? "?"
  const resumedPrefix = lineage.match(/lineage=continuation session=(\S+)/)?.[1]
  if (resumedPrefix) resumedSessions.add(resumedPrefix)
  say(`\n=== turn ${turn} (stream=${STREAM}) http ${res.status} ===`)
  say(`  calls: ${calls.map(c => `${c.name}(${String(c.input?.file_path ?? "").slice(-5)})#${short(c.id)}`).join(", ") || "none"}`)
  if (text) say(`  text: ${JSON.stringify(text.slice(0, 200))}`)
  say(`  lineage: ${lineage}`)
  say(`  usage: ${usageLine(usage)}`)
  checkCache(`turn ${turn}`, usage, lineage)
  say(`  proxy repair log: ${repaired.length ? repaired.map(l => l.replace(/^.*denials_rewrit/, "denials_rewrit").slice(0, 220)).join(" | ") : "none"}`)
  if (res.status !== 200) { say(`  body: ${JSON.stringify(blocks).slice(0, 300)}`); break }

  messages.push({ role: "assistant", content: blocks.map(({ type, id, name, input, text }) => type === "tool_use" ? { type, id, name, input } : { type, text }) })
  if (calls.length === 0) { finalText = text; break }

  // Execute the forwarded calls like a client would.
  const results = calls.map(c => {
    const p = String(c.input?.file_path ?? "")
    let content
    try { content = readFileSync(p, "utf8").trim() } catch (e) { content = `ERROR: ${e.message}` }
    delivered.add(c.id)
    return { type: "tool_result", tool_use_id: c.id, content: `REALOUTPUT[${content}]` }
  })
  messages.push({ role: "user", content: results })
}

// One more turn after the answer. Its prompt runs THROUGH the repaired rows —
// the CLI's loader now splices them back beside the real results — so this is
// where a byte of difference between what turn N+1 sent and what the repair
// wrote would show up as a cache miss. Expect cache_read to cover the prior turn.
if (finalText) {
  const logFrom = proxyLog.length
  const res = await send([...messages, { role: "user", content: "Reply with the single word OK." }])
  const { usage } = await assistantBlocks(res)
  const lineage = proxyLog.slice(logFrom).map(l => l.match(/lineage=\S+ session=\S+/)?.[0]).find(Boolean) ?? "?"
  say(`\n=== follow-up turn (stream=${STREAM}) http ${res.status} ===`)
  say(`  lineage: ${lineage}`)
  say(`  usage: ${usageLine(usage)}`)
  checkCache("follow-up", usage, lineage)
}

// The CLI flushes the transcript as the query settles; give it a beat.
await new Promise(r => setTimeout(r, 1500))
const touched = [...snapshot().entries()].filter(([p, m]) => !before.has(p) || before.get(p) !== m).map(([p]) => p)

say(`\n=== verdict (stream=${STREAM}) ===`)
const quotes = Object.values(CONTENT).filter(w => finalText.includes(w))
const claimsUnanswered = /forwarded|no content|not returned|never returned|no result/i.test(finalText)
say(`  turns used: ${messages.filter(m => m.role === "assistant").length}, calls delivered: ${delivered.size}`)
say(`  final reply quotes ${quotes.length}/3 contents: ${quotes.join(",") || "none"}${claimsUnanswered ? "   <-- and claims a call went unanswered" : ""}`)
const resumedFiles = touched.filter(f => [...resumedSessions].some(p => f.includes(`${p}`)))
let staleDenials = 0
for (const f of resumedFiles) {
  const denials = readRows(f).flatMap(r => blocksOf(r).filter(b => isForwardedDenial(b) && delivered.has(b.tool_use_id)))
  staleDenials += denials.length
  say(`  ${f}\n    forwarded denials still stored for delivered ids: ${denials.length}${denials.length ? "   <-- REPLAYED ON THE NEXT RESUME" : "   (clean)"}`)
}
say(`  prompt cache across resumes: ${cacheMisses.length ? cacheMisses.join("; ") + "   <-- PREFIX LOST" : "every continuation read the prior turn's cache in full"}`)
if (touched.length === 0) say("  no session JSONL was written — inconclusive")
else if (resumedFiles.length === 0) say(`  no turn resumed a session (${touched.length} file(s) touched, all abandoned) — the stale-denial check cannot apply; the defect needs a resume`)
const pass = quotes.length === 3 && !claimsUnanswered && staleDenials === 0 && resumedFiles.length > 0 && cacheMisses.length === 0
say(`  ${pass ? "PASS" : "FAIL"}: one call, one answer, the real one`)

await inst.stop?.()
process.exit(pass ? 0 : 1)
