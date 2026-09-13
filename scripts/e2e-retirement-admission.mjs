#!/usr/bin/env bun
// Real HTTP/profile-switch/SDK gate. Both aliases use existing authentication.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as sdk from "@anthropic-ai/claude-agent-sdk"

const stream = process.argv.includes("--stream")
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-retirement-e2e-")))
// Preserve an unset config directory: explicitly setting ~/.claude changes
// Claude Code's macOS Keychain lookup key (see query.ts).
const authDir = process.env.CLAUDE_CONFIG_DIR
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_ROUTING: "manual",
  MERIDIAN_SESSION_GC_MAX_PENDING: "2", MERIDIAN_SESSION_GC_GRACE_MS: "3600000",
})
const { createProxyServer } = await import("../src/proxy/server.ts")
const { readSessionStoreSnapshot } = await import("../src/proxy/sessionStore.ts")
const proxy = createProxyServer({
  port: 0, host: "127.0.0.1", defaultProfile: "personal", silent: true,
  profiles: ["personal", "work"].map(id => ({ id, claudeConfigDir: authDir })),
})
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, fetch: proxy.app.fetch })
const base = `http://127.0.0.1:${server.port}`
function mappings() { return Object.values(readSessionStoreSnapshot()) }
function resources() {
  return Object.values(JSON.parse(readFileSync(join(root, "sessions", "session-gc.json"), "utf8")).resources)
}
async function request(key, messages) {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session": key },
    body: JSON.stringify({ model: "haiku", stream, max_tokens: 128, messages }),
    signal: AbortSignal.timeout(90_000),
  })
  const raw = await response.text()
  assert.equal(response.status, 200, raw)
  if (!stream) return JSON.parse(raw).content
  const events = raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
  assert(!events.some(event => event.type === "error"), raw)
  assert.equal(events.filter(event => event.type === "message_stop").length, 1, raw)
  const content = []
  for (const event of events) {
    if (event.type === "content_block_start") content[event.index] = { ...event.content_block }
    if (event.delta?.type === "text_delta") content[event.index].text += event.delta.text
    if (event.delta?.type === "thinking_delta") content[event.index].thinking += event.delta.thinking
    if (event.delta?.type === "signature_delta") content[event.index].signature = (content[event.index].signature ?? "") + event.delta.signature
  }
  return content.filter(Boolean)
}
function answer(content, expected) {
  assert(!content.some(block => block.type === "tool_use"), "Unexpected tool call")
  assert.equal(content.filter(block => block.type === "text").map(block => block.text).join("").trim(), expected)
}
async function history(id) {
  const rows = await sdk.getSessionMessages(id, { dir: root })
  assert(rows.length > 0, `No supported SDK history for ${id}`)
  return rows
}
try {
  console.log(JSON.stringify({ root, stream, profileAliasesShareAuthentication: true }))
  for (const key of ["old-a", "old-b"]) {
    answer(await request(key, [{ role: "user", content: `Reply with exactly ${key}. Do not use tools.` }]), key)
  }
  const oldMappings = mappings()
  assert.equal(oldMappings.length, 2)
  const sources = await Promise.all(oldMappings.map(async row => ({ id: row.claudeSessionId, rows: await history(row.claudeSessionId) })))
  await proxy.sweepSessionGc()
  const switched = await fetch(`${base}/profiles/active`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: "work" }),
  })
  assert.equal(switched.status, 200, await switched.text())
  assert.equal(mappings().length, 0)
  await proxy.sweepSessionGc()
  const retired = resources().filter(row => row.state === "retired").length
  assert(retired > 0, "The post-switch sweep must retire real old transcripts")
  const token = `BUG-${randomUUID().slice(0, 8)}`
  const initial = [{ role: "user", content: `For this software test project, the bug ticket identifier is ${token}. What is the exact bug ticket identifier? Reply with the identifier only; no tools are needed.` }]
  const first = await request("new-work", initial)
  answer(first, token)
  assert.equal(retired, 1, "Passive cleanup must reserve one slot")
  const newMapping = mappings()[0]
  assert.equal(mappings().length, 1)
  assert.deepEqual(Object.keys(readSessionStoreSnapshot()), ["work:new-work"])
  assert(!sources.some(row => row.id === newMapping.claudeSessionId))
  const newHistory = await history(newMapping.claudeSessionId)
  assert(JSON.stringify(newHistory).includes(token))
  const followup = await request("new-work", [...initial, { role: "assistant", content: first },
    { role: "user", content: "What is this project's bug ticket identifier? Reply with the identifier only; no tools are needed." }])
  answer(followup, token)
  assert.equal(mappings().length, 1)
  assert.deepEqual(Object.keys(readSessionStoreSnapshot()), ["work:new-work"])
  assert(JSON.stringify(await history(mappings()[0].claudeSessionId)).includes(token))
  for (const source of sources) assert.deepEqual(await history(source.id), source.rows, "Old profile history changed")
  await proxy.sweepSessionGc()
  assert(resources().filter(row => ["prepared", "retired", "deleting"].includes(row.state)).length <= 2)
  console.log(JSON.stringify({ result: "PASS", stream, oldHistoriesUnchanged: 2, freshAndFollowupCorrect: true }))
} finally {
  proxy.beginDrain()
  await proxy.sweepSessionGc()
  await server.stop(true)
}
