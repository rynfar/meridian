#!/usr/bin/env bun
// Tests revised client history after a real passthrough tool checkpoint.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk"

const stream = process.argv.includes("--stream")
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-settlement-proof-")))
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
const key = `settlement-${randomUUID()}`
const tools = [{ name: "get_fixture", description: "Return a JavaScript fixture value.",
  input_schema: { type: "object", properties: {}, additionalProperties: false } }]
async function request(messages) {
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-meridian-agent": "opencode", "x-opencode-session": key },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 200, stream, tools, messages }),
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
  const opening = { role: "user", content: "Call get_fixture exactly once. When the result arrives, reply only ACK; do not call again." }
  const first = await request([opening])
  const calls = first.filter(block => block.type === "tool_use")
  assert.equal(calls.length, 1, JSON.stringify(first))
  assert.equal(calls[0].name, "get_fixture")
  const result = value => ({ role: "user", content: [{ type: "tool_result", tool_use_id: calls[0].id, content: JSON.stringify({ value }) }] })
  const history = [opening, { role: "assistant", content: first }, result("original")]
  const second = await request(history)
  assert(!second.some(block => block.type === "tool_use"), JSON.stringify(second))
  const source = lookupSharedSession(key)
  assert(source?.claudeSessionId)
  const sourceRows = await getSessionMessages(source.claudeSessionId, { dir: root })
  assert(sourceRows.length)
  const marker = `decision_${randomUUID()}`
  const revised = [history[0], history[1], result("revised"),
    { role: "assistant", content: `The fixture decision identifier is ${marker}.` },
    { role: "user", content: "Reply only with the exact fixture decision identifier in the immediately preceding assistant message. No tools." }]
  const response = await request(revised)
  const answer = response.filter(block => block.type === "text").map(block => block.text).join("")
  const current = lookupSharedSession(key)
  assert(current?.claudeSessionId)
  const rows = await getSessionMessages(current.claudeSessionId, { dir: root })
  const delivered = JSON.stringify(rows.filter(row => row.type === "user")).includes(marker)
  const lineage = telemetryStore.getRecent({ limit: 1 })[0]?.lineageType
  console.log(JSON.stringify({ root, stream, priorCheckpoint: source.passthroughToolCallAssistantUuid ?? null,
    lineage, answer, delivered, expected: marker, valid: delivered && answer.includes(marker) }))
  assert(delivered && answer.includes(marker), "The revised supplied assistant history must reach the SDK and answer")
  assert.deepEqual(await getSessionMessages(source.claudeSessionId, { dir: root }), sourceRows, "Current main must preserve its source")
  const followup = await request([...revised, { role: "assistant", content: response },
    { role: "user", content: "Repeat that fixture decision identifier only. No tools." }])
  const followupAnswer = followup.filter(block => block.type === "text").map(block => block.text).join("")
  const metric = telemetryStore.getRecent({ limit: 1 })[0]
  console.log(JSON.stringify({ followup: true, stream, isResume: metric?.isResume, answer: followupAnswer }))
  assert(followupAnswer.includes(marker), "Ordinary follow-up must retain the decision")
  assert.equal(metric?.isResume, true, "A completed tool checkpoint must not force ordinary follow-ups to replay")
} finally {
  await instance.close()
}
