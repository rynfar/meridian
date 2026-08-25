#!/usr/bin/env bun
/**
 * Multi-turn passthrough conversation through the REAL proxy.
 *
 * probe-passthrough-accumulation.mjs proves the defect and the supported
 * forkSession repair at the SDK level. This drives Meridian itself the way
 * OpenCode does: send a request with tools, execute the returned calls, replay
 * the history plus tool_results, and continue until the model answers.
 *
 * The gate asserts behavior, cache continuity, exact tool-call batching, and
 * the ACTIVE fork's transcript. Superseded source sessions may retain the deny
 * tail that forkSession cut; they are not live history and are reported only
 * for retention accounting.
 *
 *   bun scripts/e2e-passthrough-turns.mjs [--stream]
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { snapshotSessionFiles as snapshot, readRows, blocksOf } from "./lib/passthrough-jsonl.mjs"
import { isForwardedDenial } from "../src/proxy/passthroughDenial.ts"

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

// Keep proxy logs out of the probe's verdict while retaining lineage events.
const say = console.log.bind(console)
const proxyLog = []
// claudeLog events use console.debug and request lines use console.error.
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

// Prompt-cache continuity across resumes. Forking changes session/message
// metadata, not Anthropic prompt content, so each continuation must read the
// previous turn's full cached prefix.
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
const continuationPrefixes = []
const toolCallBatchSizes = []
let liveSessionPrefix
let finalText = ""

for (let turn = 1; turn <= MAX_TURNS; turn++) {
  const logFrom = proxyLog.length
  const res = await send(messages)
  const { blocks, usage } = await assistantBlocks(res)
  const calls = blocks.filter(b => b.type === "tool_use")
  const text = blocks.filter(b => b.type === "text").map(b => b.text).join("")
  const turnLog = proxyLog.slice(logFrom)
  const lineage = turnLog.map(l => l.match(/lineage=\S+ session=\S+/)?.[0]).find(Boolean) ?? "?"
  const resumedPrefix = lineage.match(/lineage=continuation session=(\S+)/)?.[1]
  if (resumedPrefix) {
    continuationPrefixes.push(resumedPrefix)
    liveSessionPrefix = resumedPrefix
  }
  say(`\n=== turn ${turn} (stream=${STREAM}) http ${res.status} ===`)
  say(`  calls: ${calls.map(c => `${c.name}(${String(c.input?.file_path ?? "").slice(-5)})#${short(c.id)}`).join(", ") || "none"}`)
  if (text) say(`  text: ${JSON.stringify(text.slice(0, 200))}`)
  say(`  lineage: ${lineage}`)
  say(`  usage: ${usageLine(usage)}`)
  checkCache(`turn ${turn}`, usage, lineage)
  if (res.status !== 200) { say(`  body: ${JSON.stringify(blocks).slice(0, 300)}`); break }

  messages.push({ role: "assistant", content: blocks.map(({ type, id, name, input, text }) => type === "tool_use" ? { type, id, name, input } : { type, text }) })
  if (calls.length === 0) { finalText = text; break }
  toolCallBatchSizes.push(calls.length)

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

// One more turn after the answer. This resumes the final live fork through all
// delivered results and proves both the active transcript and its cache prefix.
if (finalText) {
  const logFrom = proxyLog.length
  const res = await send([...messages, { role: "user", content: "Reply with the single word OK." }])
  const { usage } = await assistantBlocks(res)
  const lineage = proxyLog.slice(logFrom).map(l => l.match(/lineage=\S+ session=\S+/)?.[0]).find(Boolean) ?? "?"
  const resumedPrefix = lineage.match(/lineage=continuation session=(\S+)/)?.[1]
  if (resumedPrefix) {
    continuationPrefixes.push(resumedPrefix)
    liveSessionPrefix = resumedPrefix
  }
  say(`\n=== follow-up turn (stream=${STREAM}) http ${res.status} ===`)
  say(`  lineage: ${lineage}`)
  say(`  usage: ${usageLine(usage)}`)
  checkCache("follow-up", usage, lineage)
}

// The CLI flushes the transcript as the query settles; give it a beat.
await new Promise(r => setTimeout(r, 1500))
const touched = [...snapshot().entries()].filter(([p, m]) => !before.has(p) || before.get(p) !== m).map(([p]) => p)

say(`\n=== verdict (stream=${STREAM}, parallel=${PARALLEL}) ===`)
const quotes = Object.values(CONTENT).filter(w => finalText.includes(w))
const claimsUnanswered = /forwarded|no content|not returned|never returned|no result/i.test(finalText)
const toolShapeOk = PARALLEL
  ? toolCallBatchSizes.length === 1 && toolCallBatchSizes[0] === 3
  : toolCallBatchSizes.length === 3 && toolCallBatchSizes.every(n => n === 1)
const uniqueContinuations = new Set(continuationPrefixes)
const forkShapeOk = uniqueContinuations.size === toolCallBatchSizes.length + 1
say(`  tool-call batches: ${toolCallBatchSizes.join(" + ") || "none"}${toolShapeOk ? "" : "   <-- WRONG TURN SHAPE"}`)
say(`  continuation session prefixes: ${[...uniqueContinuations].join(" -> ") || "none"}${forkShapeOk ? "" : "   <-- FORK CHAIN NOT DURABLE"}`)
say(`  final reply quotes ${quotes.length}/3 contents: ${quotes.join(",") || "none"}${claimsUnanswered ? "   <-- claims a call went unanswered" : ""}`)

const activeFiles = liveSessionPrefix
  ? touched.filter(file => file.split("/").at(-1)?.startsWith(liveSessionPrefix))
  : []
const supersededFiles = touched.filter(file => !activeFiles.includes(file))
const activeAnswerProblems = []
for (const file of activeFiles) {
  const answerBlocks = readRows(file).flatMap(row => blocksOf(row).filter(block =>
    block?.type === "tool_result" && delivered.has(block.tool_use_id)
  ))
  for (const id of delivered) {
    const answers = answerBlocks.filter(block => block.tool_use_id === id)
    const denials = answers.filter(isForwardedDenial)
    const real = answers.filter(block => !isForwardedDenial(block))
    if (denials.length !== 0 || real.length !== 1) {
      activeAnswerProblems.push(`${short(id)}: real=${real.length} denial=${denials.length}`)
    }
  }
  say(`  active fork ${file}: ${activeAnswerProblems.length ? activeAnswerProblems.join(", ") : "exactly one real answer per delivered call"}`)
}
say(`  superseded fork files still present: ${supersededFiles.length}`)
say(`  prompt cache: ${cacheMisses.length ? cacheMisses.join("; ") + "   <-- PREFIX LOST" : "every continuation read the prior cached prefix"}`)
if (touched.length === 0) say("  no session JSONL was written — inconclusive")
if (activeFiles.length !== 1) say(`  expected one active fork, found ${activeFiles.length}`)
const pass = quotes.length === 3 &&
  !claimsUnanswered &&
  delivered.size === 3 &&
  toolShapeOk &&
  forkShapeOk &&
  activeFiles.length === 1 &&
  activeAnswerProblems.length === 0 &&
  cacheMisses.length === 0
say(`  ${pass ? "PASS" : "FAIL"}: active history has one call, one real answer`)

await inst.stop?.()
process.exit(pass ? 0 : 1)
