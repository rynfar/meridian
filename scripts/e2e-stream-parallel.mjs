#!/usr/bin/env bun
/**
 * Live E2E: streaming passthrough with parallel tool calls (#552 red reads).
 *
 * This is the test that mocked suites CANNOT provide: it runs the REAL Claude
 * CLI through the REAL proxy in SSE mode and validates the client-facing
 * contract that kabo's and Stefan's transcripts showed breaking. The CLI
 * dispatches PreToolUse hooks per-block while later parallel blocks are still
 * generating, and a deny landing mid-generation cancels the in-flight request
 * — behavior no mock reproduced, which is how two releases shipped with
 * "verified" fixes that failed in the field.
 *
 * Requires: Claude Max auth (`claude login`). Run before releases touching
 * the passthrough tool loop (see E2E.md):
 *
 *   bun scripts/e2e-stream-parallel.mjs
 *
 * Asserts, per attempt:
 *   1. At least 2 parallel tool_use blocks reach the client
 *   2. Every content_block_start has a matching content_block_stop (no
 *      dangling blocks → no `tool {}` "Tool execution aborted" renders)
 *   3. Every tool_use block carries complete, parseable input JSON
 *   4. Exactly one message_stop (clean envelope)
 *   5. The instant follow-up turn RESUMES the session (no fresh replay)
 */
import { startProxyServer } from "../src/proxy/server.ts"

const PORT = 3499
const ATTEMPTS = Number(process.env.E2E_ATTEMPTS ?? 3)
const inst = await startProxyServer({ port: PORT, host: "127.0.0.1", silent: true })

const TOOLS = [
  { name: "bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "glob", description: "Find files by glob pattern", input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { name: "read", description: "Read a file", input_schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
]

let failures = 0
const fail = (attempt, msg) => {
  failures++
  console.error(`  ✗ attempt ${attempt}: ${msg}`)
}

async function sse(sid, messages, maxTokens = 700) {
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "x", "x-opencode-session": sid, "user-agent": "opencode/1.0.0" },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: maxTokens, stream: true, tools: TOOLS, messages }),
  })
  const text = await r.text()
  const parse = (ev) => [...text.matchAll(new RegExp(`event: ${ev}\\ndata: (.*)`, "g"))].map((m) => JSON.parse(m[1]))
  const starts = parse("content_block_start")
  const stopIdx = parse("content_block_stop").map((s) => s.index)
  const deltas = parse("content_block_delta")
  const tools = starts
    .filter((s) => s.content_block?.type === "tool_use")
    .map((s) => ({
      id: s.content_block.id,
      name: s.content_block.name,
      inputJson: deltas.filter((d) => d.index === s.index && d.delta?.type === "input_json_delta").map((d) => d.delta.partial_json).join(""),
      closed: stopIdx.includes(s.index),
    }))
  return {
    tools,
    danglingIdx: starts.map((s) => s.index).filter((i) => !stopIdx.includes(i)),
    messageStops: (text.match(/event: message_stop/g) || []).length,
  }
}

for (let n = 1; n <= ATTEMPTS; n++) {
  const sid = `e2e-par-${n}-${Math.random().toString(36).slice(2, 6)}`
  const messages = [{ role: "user", content: "Run `ls /tmp` with bash AND find *.md files with glob AND read /etc/hostname — issue ALL THREE tool calls in parallel in this single response." }]

  const t1 = await sse(sid, messages)
  if (t1.tools.length < 2) fail(n, `expected ≥2 parallel tool calls, got ${t1.tools.length}`)
  if (t1.danglingIdx.length > 0) fail(n, `dangling blocks (red reads): idx=[${t1.danglingIdx.join(",")}]`)
  if (t1.messageStops !== 1) fail(n, `expected 1 message_stop, got ${t1.messageStops}`)
  for (const t of t1.tools) {
    if (!t.closed) fail(n, `tool ${t.name} block never closed`)
    try {
      const input = JSON.parse(t.inputJson || "{}")
      if (Object.keys(input).length === 0) fail(n, `tool ${t.name} has EMPTY input (the '{} Tool execution aborted' render)`)
    } catch {
      fail(n, `tool ${t.name} has unparseable input: ${t.inputJson.slice(0, 60)}`)
    }
  }

  // Instant follow-up (the fast-client race): must resume, not fresh-replay.
  // Detect via a second round: send results, expect a final answer without
  // the model disowning or re-issuing the calls.
  messages.push({ role: "assistant", content: t1.tools.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: JSON.parse(t.inputJson || "{}") })) })
  messages.push({ role: "user", content: t1.tools.map((t) => ({ type: "tool_result", tool_use_id: t.id, content: `ok: fake result for ${t.name}` })) })
  const t2 = await sse(sid, messages, 400)
  if (t2.danglingIdx.length > 0) fail(n, `follow-up has dangling blocks: idx=[${t2.danglingIdx.join(",")}]`)
  const reissued = t2.tools.filter((t) => t1.tools.some((p) => p.name === t.name && p.inputJson === t.inputJson))
  if (reissued.length > 0) fail(n, `model re-issued identical calls (lost memory of turn 1): ${reissued.map((t) => t.name).join(",")}`)

  console.log(`  ✓ attempt ${n}: ${t1.tools.length} parallel calls intact (${t1.tools.map((t) => t.name).join(", ")}), follow-up clean`)
}

await inst.close?.()
if (failures > 0) {
  console.error(`\nE2E FAILED: ${failures} assertion(s) across ${ATTEMPTS} attempts`)
  process.exit(1)
}
console.log(`\nE2E PASSED: ${ATTEMPTS}/${ATTEMPTS} attempts clean`)
process.exit(0)
