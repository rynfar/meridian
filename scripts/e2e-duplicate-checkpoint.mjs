#!/usr/bin/env bun
// Tests revised client history after a real passthrough tool checkpoint.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk"

const stream = process.argv.includes("--stream")
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-duplicate-proof-")))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_PASSTHROUGH: "1" })
const { startProxyServer } = await import("../src/proxy/server.ts")
const { lookupSharedSession } = await import("../src/proxy/sessionStore.ts")
const { telemetryStore } = await import("../src/telemetry/index.ts")
const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const address = instance.server.address()
assert(address && typeof address === "object")
const key = `duplicate-${randomUUID()}`
const tools = [{ name: "get_fixture", description: "Return a JavaScript fixture value.",
  input_schema: { type: "object", properties: {}, additionalProperties: false } }]
async function request(messages) {
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-meridian-agent": "opencode", "x-opencode-session": key },
    body: JSON.stringify({ model: process.env.E2E_MODEL ?? "claude-sonnet-4-6", max_tokens: 500, stream, tools, messages }),
    signal: AbortSignal.timeout(90_000),
  })
  const raw = await response.text()
  assert.equal(response.status, 200, raw)
  if (!stream) return JSON.parse(raw).content
  const events = raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
  assert(!events.some(event => event.type === "error"), raw)
  assert.equal(events.filter(event => event.type === "message_stop").length, 1)
  const blocks = []
  for (const event of events) {
    if (event.type === "content_block_start") blocks[event.index] = { ...event.content_block, json: "" }
    if (event.delta?.type === "text_delta") blocks[event.index].text += event.delta.text
    if (event.delta?.type === "input_json_delta") blocks[event.index].json += event.delta.partial_json
  }
  return blocks.filter(Boolean).map(({ json, ...block }) => block.type === "tool_use"
    ? { ...block, input: json ? JSON.parse(json) : block.input } : block)
}
try {
  const opening = { role: "user", content: "Test this tool transport: call get_fixture exactly TWICE with identical empty arguments in the SAME assistant response, before waiting for results. This duplication is intentional for this test; do not combine the two calls. When the result arrives, repeat its fixture value only, with no tools or commentary." }
  const first = await request([opening])
  const calls = first.filter(block => block.type === "tool_use")
  const source = lookupSharedSession(key)
  assert(source?.claudeSessionId)
  const rows = await getSessionMessages(source.claudeSessionId, { dir: root })
  const actualCalls = new Map()
  function walk(value) {
    if (!value || typeof value !== "object") return
    if (value.type === "tool_use" && value.name?.endsWith("get_fixture")) actualCalls.set(value.id, value)
    for (const child of Object.values(value)) if (typeof child === "object") walk(child)
  }
  walk(rows)
  console.log(JSON.stringify({ root, stream, sdkCalls: [...actualCalls.values()], clientCalls: calls, checkpointIds: source.passthroughToolCallIds }))
  assert.equal(actualCalls.size, 2, "Fixture precondition: real model must emit two duplicate calls")
  assert.equal(calls.length, stream ? 2 : 1, "Preserve the existing visible call set in each mode")
  assert.deepEqual(source.passthroughToolCallIds, calls.map(call => call.id), "Checkpoint must match every visible call")
  const value = `fixture_${randomUUID()}`
  const history = [opening, { role: "assistant", content: first },
    { role: "user", content: calls.map(call => ({ type: "tool_result", tool_use_id: call.id, content: value })) }]
  const second = await request(history)
  const answer = second.filter(block => block.type === "text").map(block => block.text).join("")
  assert(!second.some(block => block.type === "tool_use"), JSON.stringify(second))
  assert(answer.includes(value), answer)
  const metric = telemetryStore.getRecent({ limit: 1 })[0]
  assert.equal(metric?.isResume, true, "Visible results must resume the real duplicate checkpoint")
  assert.deepEqual(await getSessionMessages(source.claudeSessionId, { dir: root }), rows, "Source history changed")
  console.log(JSON.stringify({ result: "PASS", stream, answer, resumed: metric.isResume, sourceUnchanged: true }))
} finally {
  await instance.close()
}
