#!/usr/bin/env bun
// Real Meridian HTTP handler → real SDK/CLI → loopback-only canned Anthropic SSE.
// No provider credentials, live model calls, or existing Meridian state are used.
// bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/absolute/path/to/claude
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

const executable = process.argv.find(arg => arg.startsWith("--claude="))?.slice(9)
assert(executable, "pass --claude=/absolute/path/to/claude")
const cli = resolve(executable)
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
    const block = first
      ? { type: "tool_use", id: "toolu_offline", name: "read", input: {} }
      : { type: "text", text: "" }
    const events = [
      ["message_start", { type: "message_start", message: {
        id: "msg_offline_" + wire.length, type: "message", role: "assistant", model: body.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
      } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: block }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: first
        ? { type: "input_json_delta", partial_json: '{"file_path":"new"}' }
        : { type: "text_delta", text: "read complete" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
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
  const first = await post(history)
  const firstBody = await first.text()
  assert.equal(first.status, 200)
  assert(!firstBody.includes("event: error"), firstBody)
  assert(firstBody.includes('"stop_reason":"tool_use"'), firstBody)
  const mapping = lookupSharedSession("offline:" + session)
  assert(mapping, "fresh canonical rejection lost its mapping")
  assert.deepEqual(mapping.passthroughToolCallIds, ["toolu_offline"])
  assert(mapping.passthroughToolCallAssistantUuid)
  const file = readdirSync(root, { recursive: true }).find(path =>
    String(path).endsWith(mapping.claudeSessionId + ".jsonl"))
  assert(file, "mapped CLI transcript must exist before terminal delivery")
  const rows = readFileSync(join(root, String(file)), "utf8").trim().split("\n").map(line => JSON.parse(line))
  assert(rows.some(row => row.type === "assistant" && row.uuid === mapping.passthroughToolCallAssistantUuid))
  assert(rows.some(row => row.message?.content?.some?.(block => block.type === "tool_result" &&
    block.content === "<tool_use_error>Error: No such tool available: read</tool_use_error>")))
  console.log("PASS fresh: CLI rejected bare read before PreToolUse; canonical transcript and checkpoint exist")
  const next = await post([...history,
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_offline", name: "read", input: { file_path: "new" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_offline", content: "REAL_CLIENT_RESULT" }] },
  ])
  const nextBody = await next.text()
  assert.equal(next.status, 200)
  assert(!nextBody.includes("event: error"), nextBody)
  assert(nextBody.includes("read complete"), nextBody)
  assert.equal(wire.length, 2)
  assert(wire[1].messages.some(message => message.role === "assistant" &&
    message.content?.some?.(block => block.type === "tool_use" && block.id === "toolu_offline")))
  assert(wire[1].messages.some(message => message.content?.some?.(block =>
    block.type === "tool_result" && block.tool_use_id === "toolu_offline" && block.content === "REAL_CLIENT_RESULT")))
  assert(!JSON.stringify(wire[1].messages).includes("No such tool available"), "resume must rewind before the rejection")
  const turns = telemetryStore.getRecent({ limit: 10 })
  assert(turns.some(turn => turn.isResume === true), "next request must be a continuation")
  console.log("PASS continuation: native assistant and real client result; rejection rewound; exactly two upstream calls")
  const sdkVersion = JSON.parse(readFileSync(new URL("../node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url), "utf8")).version
  console.log(JSON.stringify({ cli: version, sdk: sdkVersion, upstreamCalls: wire.length, liveModelCalls: 0 }))
} finally {
  await proxy?.closeBackend?.()
  upstream.stop(true)
  rmSync(root, { recursive: true, force: true })
}
