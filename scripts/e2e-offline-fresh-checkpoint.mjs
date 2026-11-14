#!/usr/bin/env bun
// Real Meridian HTTP handler → real SDK/CLI → loopback-only canned Anthropic SSE.
// No provider credentials, live model calls, or existing Meridian state are used.
// bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/absolute/path/to/claude
// Optional: --thinking --calls=1|2|3 --transient-tail (client-history mutation control).
// --calls=1 retains the rejection checkpoint and resumes. --calls=2|3 evicts it
// and the follow-up is a fresh replay carrying every real client result.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

const executable = process.argv.find(arg => arg.startsWith("--claude="))?.slice(9)
assert(executable, "pass --claude=/absolute/path/to/claude")
const cli = resolve(executable)
const callCount = Number(process.argv.find(arg => arg.startsWith("--calls="))?.slice(8) ?? 1)
assert(Number.isInteger(callCount) && callCount > 0 && callCount <= 3, "--calls must be 1, 2, or 3")
const thinking = process.argv.includes("--thinking")
const transientTail = process.argv.includes("--transient-tail")
const calls = Array.from({ length: callCount }, (_, index) => ({
  type: "tool_use", id: index === 0 ? "toolu_offline" : "toolu_offline_" + index,
  name: "read", input: { file_path: "new-" + index },
}))
const root = mkdtempSync(join(process.cwd(), ".fresh-checkpoint-e2e-"))
// Start without inherited provider credentials or operational overrides.
for (const key of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|MERIDIAN_)/.test(key)) delete process.env[key]
}
Object.assign(process.env, {
  HOME: root,
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  MERIDIAN_CONFIG_DIR: join(root, "config"),
  MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root,
  MERIDIAN_CLAUDE_PATH: cli,
  MERIDIAN_PASSTHROUGH: "1",
  MERIDIAN_TELEMETRY_PERSIST: "0",
})
const wire = []
const upstream = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/messages")
    const body = await request.json()
    wire.push(body)
    assert.equal(body.stream, true)
    assert(body.tools.some(tool => tool.name === "mcp__oc__read"))
    const first = wire.length === 1
    assert(wire.length <= 2, "no retry or hidden digest is permitted")
    const blocks = first
      ? [...(thinking ? [{ type: "thinking", thinking: "offline thought", signature: "offline-signature" }] : []), ...calls]
      : [{ type: "text", text: "read complete" }]
    const events = [
      ["message_start", { type: "message_start", message: {
        id: "msg_offline_" + wire.length, type: "message", role: "assistant", model: body.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
      } }],
      ...blocks.flatMap((block, index) => [
        ["content_block_start", { type: "content_block_start", index, content_block: block.type === "tool_use"
          ? { ...block, input: {} } : block.type === "thinking" ? { ...block, thinking: "", signature: "" } : { ...block, text: "" } }],
        ...(block.type === "thinking" ? [
          ["content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }],
          ["content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } }],
        ] : [["content_block_delta", { type: "content_block_delta", index, delta: block.type === "tool_use"
          ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
          : { type: "text_delta", text: block.text } }]]),
        ["content_block_stop", { type: "content_block_stop", index }],
      ]),
      ["message_delta", { type: "message_delta", delta: {
        stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null,
      }, usage: { output_tokens: 10 } }],
      ["message_stop", { type: "message_stop" }],
    ]
    return new Response(events.map(([event, data]) =>
      "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n").join(""),
    { headers: { "content-type": "text/event-stream" } })
  },
})
let proxy
try {
  const version = Bun.spawnSync([cli, "--version"], { env: process.env }).stdout.toString().trim()
  const { createProxyServer } = await import("../src/proxy/server.ts")
  const { lookupSharedSession } = await import("../src/proxy/sessionStore.ts")
  const { telemetryStore } = await import("../src/telemetry/index.ts")
  const { computeMessageHashes, verifyLineage } = await import("../src/proxy/session/lineage.ts")
  const { parseSSE } = await import("../src/__tests__/helpers.ts")
  proxy = createProxyServer({ silent: true, profiles: [
    { id: "offline", type: "api", apiKey: "offline-test-key", baseUrl: upstream.url.origin },
  ], defaultProfile: "offline" })
  const session = "offline-fresh-checkpoint"
  const tools = [{ name: "read", input_schema: {
    type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"],
  } }]
  const history = [
    { role: "user", content: "read old file" },
    { role: "assistant", content: [{ type: "tool_use", id: "old-call", name: "read", input: { file_path: "old" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "old-call", content: "old data" }] },
    { role: "assistant", content: "old file read" },
    { role: "user", content: "now read new file" },
  ]
  const post = messages => proxy.app.fetch(new Request("http://offline.invalid/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-meridian-agent": "pi",
      "user-agent": "pi/1.4.0", "x-session-affinity": session },
    body: JSON.stringify({ model: "opus[1m]", max_tokens: 400, stream: true, tools, messages }),
  }))
  const suffix = transientTail ? [
    { role: "user", content: "request-only context" },
    { role: "user", content: [{ type: "text", text: "request-only notice" }] },
  ] : []
  const firstHistory = [...history, ...suffix]
  const first = await post(firstHistory)
  const firstBody = await first.text()
  assert.equal(first.status, 200)
  assert(!firstBody.includes("event: error"), firstBody)
  assert(firstBody.includes('"stop_reason":"tool_use"'), firstBody)
  const retainCheckpoint = callCount === 1
  const mapping = lookupSharedSession("offline:" + session)
  const rejectionText = "<tool_use_error>Error: No such tool available: read</tool_use_error>"
  if (retainCheckpoint) {
    assert(mapping, "fresh canonical rejection lost its mapping")
    assert.deepEqual(mapping.messageHashes, computeMessageHashes(firstHistory))
    assert.deepEqual(mapping.passthroughToolCallIds, calls.map(call => call.id))
    assert(mapping.passthroughToolCallAssistantUuid)
    const file = readdirSync(root, { recursive: true }).find(path =>
      String(path).endsWith(mapping.claudeSessionId + ".jsonl"))
    assert(file, "mapped CLI transcript must exist before terminal delivery")
    const rows = readFileSync(join(root, String(file)), "utf8").trim().split("\n").map(line => JSON.parse(line))
    assert(rows.some(row => row.type === "assistant" && row.uuid === mapping.passthroughToolCallAssistantUuid))
    assert(rows.some(row => row.message?.content?.some?.(block => block.type === "tool_result" &&
      block.content === rejectionText)))
    console.log("PASS fresh: CLI rejected bare read before PreToolUse; canonical transcript and checkpoint exist")
  } else {
    assert.equal(mapping, undefined, "multi-call canonical rejection must evict its mapping")
    const transcripts = readdirSync(root, { recursive: true }).filter(path => String(path).endsWith(".jsonl"))
    assert(transcripts.length > 0, "CLI transcript must exist even when the mapping is evicted")
    const rows = transcripts.flatMap(file => readFileSync(join(root, String(file)), "utf8").trim().split("\n").map(line => JSON.parse(line)))
    assert(rows.some(row => row.message?.content?.some?.(block => block.type === "tool_result" &&
      block.content === rejectionText)), "CLI must still have rejected the calls before PreToolUse")
    console.log("PASS fresh: CLI rejected " + callCount + " bare reads before PreToolUse; mapping evicted")
  }
  // Assemble the exact client-visible assistant from the emitted stream, not
  // from the canned upstream or the CLI's assistant metadata.
  const content = []
  const json = new Map()
  for (const { event, data } of parseSSE(firstBody)) {
    const index = data.index
    if (event === "content_block_start") content[index] = { ...data.content_block }
    if (event !== "content_block_delta") continue
    const delta = data.delta
    if (delta.type === "thinking_delta") content[index].thinking += delta.thinking
    if (delta.type === "signature_delta") content[index].signature += delta.signature
    if (delta.type === "input_json_delta") json.set(index, (json.get(index) ?? "") + delta.partial_json)
  }
  for (const [index, value] of json) content[index].input = JSON.parse(value)
  assert.deepEqual(content.filter(block => block.type === "tool_use"), calls)
  if (thinking) assert.equal(content[0].type, "thinking")
  const nextHistory = [...history,
    { role: "assistant", content },
    { role: "user", content: calls.map(call => ({ type: "tool_result", tool_use_id: call.id, content: "REAL_CLIENT_RESULT" })) },
    ...suffix,
  ]
  if (retainCheckpoint) {
    const lineage = verifyLineage({ ...mapping, lastAccess: 0 }, nextHistory)
    assert.equal(lineage.type, transientTail ? "diverged" : "continuation")
    if (!transientTail) console.log("PASS lineage: exact streamed assistant plus client results is continuation")
    if (transientTail) {
      assert.equal(lineage.reason, "modified-history")
      assert.equal(lineage.mismatch.index, firstHistory.length - 2)
      assert.equal(firstHistory[lineage.mismatch.index].role, "user")
      assert.equal(lineage.mismatch.incomingShape.role, "assistant")
      console.log("PASS diagnostic: incoming assistant replaces a stored transient USER slot at count - 2")
    }
  }
  const next = await post(nextHistory)
  const nextBody = await next.text()
  assert.equal(next.status, 200)
  assert(!nextBody.includes("event: error"), nextBody)
  assert(nextBody.includes("read complete"), nextBody)
  assert.equal(wire.length, 2)
  const expectResume = retainCheckpoint && !transientTail
  const replayParts = []
  const collectReplayText = (value) => {
    if (typeof value === "string") replayParts.push(value)
    else if (Array.isArray(value)) for (const item of value) collectReplayText(item)
    else if (value && typeof value === "object") for (const item of Object.values(value)) collectReplayText(item)
  }
  collectReplayText(wire[1].messages)
  const replayText = replayParts.join("\n")
  if (expectResume) for (const call of calls) {
    assert(wire[1].messages.some(message => message.role === "assistant" &&
      message.content?.some?.(block => block.type === "tool_use" && block.id === call.id)))
    assert(wire[1].messages.some(message => message.content?.some?.(block =>
      block.type === "tool_result" && block.tool_use_id === call.id && block.content === "REAL_CLIENT_RESULT")),
      "resumed upstream lacks real client result for " + call.id)
  }
  if (!retainCheckpoint) {
    // A fresh SDK query cannot carry native assistant tool blocks. The replay
    // renders each client result as history text attributed to its call id.
    assert.equal(replayText.split("REAL_CLIENT_RESULT").length - 1, calls.length,
      "fresh replay must contain one real client result per call")
    for (const call of calls) {
      assert(replayText.includes(`"tool_use_id":"${call.id}"`),
        "fresh replay lacks real client result for " + call.id)
    }
    assert(replayText.includes("now read new file"), "fresh replay must include the client history")
    assert(!wire[1].messages.some(message => message.role === "assistant" &&
      message.content?.some?.(block => block.type === "tool_use")),
      "fresh replay must not resume a native assistant tool turn")
  }
  assert(!replayText.includes("No such tool available"),
    expectResume ? "resume must rewind before the rejection" : "fresh replay must not carry the CLI rejection")
  const turns = telemetryStore.getRecent({ limit: 10 })
  assert.equal(turns.some(turn => turn.isResume === true), expectResume,
    retainCheckpoint ? "only an unchanged request prefix can resume" : "multi-call follow-up must be a fresh replay, not a resumed continuation")
  console.log(!retainCheckpoint
    ? "PASS follow-up: fresh replay, not a resumed continuation; real client result for every call; no CLI rejection"
    : transientTail
    ? "PASS diagnostic: transient suffix reproduces fresh replay; no assistant rewriting"
    : "PASS continuation: native assistant and real client result; rejection rewound; exactly two upstream calls")
  const sdkVersion = JSON.parse(readFileSync(new URL("../node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url), "utf8")).version
  console.log(JSON.stringify({ cli: version, sdk: sdkVersion, callCount, thinking, transientTail, upstreamCalls: wire.length, liveModelCalls: 0 }))
} finally {
  await proxy?.closeBackend?.()
  upstream.stop(true)
  rmSync(root, { recursive: true, force: true })
}
