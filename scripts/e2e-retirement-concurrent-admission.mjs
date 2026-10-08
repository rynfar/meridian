#!/usr/bin/env bun
// Real HTTP/SDK gate for concurrent admission against a saturated retirement
// backlog (#1174). The sequential gates cannot reach this state: the refusal
// needs later turns to arrive while an earlier one still holds its prepared
// publication slot, which is exactly the reported multi-session workload.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as sdk from "@anthropic-ai/claude-agent-sdk"

const stream = process.argv.includes("--stream")
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-retirement-concurrent-e2e-")))
// Preserve an unset config directory: explicitly setting ~/.claude changes
// Claude Code's macOS Keychain lookup key (see query.ts).
const authDir = process.env.CLAUDE_CONFIG_DIR
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
// A three-slot budget with a long quarantine is the smallest configuration that
// reproduces the report: passive cleanup parks two retired transcripts and the
// single remaining slot has to serve every concurrent turn.
const MAX_PENDING = 3
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_ROUTING: "manual",
  MERIDIAN_SESSION_GC_MAX_PENDING: String(MAX_PENDING), MERIDIAN_SESSION_GC_GRACE_MS: "3600000",
})
const { createProxyServer, clearSessionCache } = await import("../src/proxy/server.ts")
const { readSessionStoreSnapshot } = await import("../src/proxy/sessionStore.ts")
const proxy = createProxyServer({
  port: 0, host: "127.0.0.1", defaultProfile: "personal", silent: true,
  profiles: [{ id: "personal", claudeConfigDir: authDir }],
})
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, fetch: proxy.app.fetch })
const base = `http://127.0.0.1:${server.port}`
function mappings() { return Object.values(readSessionStoreSnapshot()) }
function resources() {
  return Object.values(JSON.parse(readFileSync(join(root, "sessions", "session-gc.json"), "utf8")).resources)
}
function pending() {
  return resources().filter(row => ["prepared", "retired", "deleting"].includes(row.state)).length
}
// Returns the raw outcome so a refusal is recorded as evidence instead of throwing.
async function attempt(key, messages) {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session": key },
    body: JSON.stringify({ model: "haiku", stream, max_tokens: 128, messages }),
    signal: AbortSignal.timeout(90_000),
  })
  return { status: response.status, raw: await response.text() }
}
function content({ status, raw }) {
  assert.equal(status, 200, raw)
  if (!stream) return JSON.parse(raw).content
  const events = raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
  assert(!events.some(event => event.type === "error"), raw)
  assert.equal(events.filter(event => event.type === "message_stop").length, 1, raw)
  const blocks = []
  for (const event of events) {
    if (event.type === "content_block_start") blocks[event.index] = { ...event.content_block }
    if (event.delta?.type === "text_delta") blocks[event.index].text += event.delta.text
  }
  return blocks.filter(Boolean)
}
function answer(blocks, expected) {
  assert(!blocks.some(block => block.type === "tool_use"), "Unexpected tool call")
  assert.equal(blocks.filter(block => block.type === "text").map(block => block.text).join("").trim(), expected)
}
function ask(token) {
  return [{ role: "user", content: `For this software test project, the bug ticket identifier is ${token}. What is the exact bug ticket identifier? Reply with the identifier only; no tools are needed.` }]
}
async function history(id) {
  const rows = await sdk.getSessionMessages(id, { dir: root })
  assert(rows.length > 0, `No supported SDK history for ${id}`)
  return rows
}
try {
  console.log(JSON.stringify({ root, stream, maxPending: MAX_PENDING }))
  // Seed real transcripts, then drop their mappings so the sweep has genuine
  // unpinned transcripts to retire. Cache eviction under session pressure and a
  // proxy restart both reach this state in production; the transcripts and the
  // SDK deletions behind them are real either way.
  const seeded = ["old-a", "old-b", "old-c"]
  for (const key of seeded) {
    answer(content(await attempt(key, [{ role: "user", content: `Reply with exactly ${key}. Do not use tools.` }])), key)
  }
  assert.equal(mappings().length, seeded.length)
  const sources = await Promise.all(mappings().map(async row =>
    ({ id: row.claudeSessionId, rows: await history(row.claudeSessionId) })))
  await proxy.sweepSessionGc()
  await clearSessionCache()
  await proxy.sweepSessionGc()
  // Passive retirement deliberately stops one slot short of the budget, so the
  // backlog parks MAX_PENDING - 1 transcripts awaiting a real SDK deletion.
  const parked = resources().filter(row => row.state === "retired").map(row => row.key)
  assert.equal(parked.length, MAX_PENDING - 1,
    `Passive cleanup must park ${MAX_PENDING - 1} retired transcripts, got ${JSON.stringify(resources().map(r => r.state))}`)
  assert.equal(pending(), MAX_PENDING - 1, "The backlog must sit at its passive bound before the concurrent turns")

  // The actual report: several sessions working at once. Every turn holds a
  // prepared slot across its real SDK call, so with one free slot the losers
  // used to receive a 503 that never reached the model.
  const tokens = parked.map(() => `BUG-${randomUUID().slice(0, 8)}`).concat(`BUG-${randomUUID().slice(0, 8)}`)
  const keys = tokens.map((_, index) => `busy-${index}`)
  const outcomes = await Promise.all(keys.map((key, index) => attempt(key, ask(tokens[index]))))
  const refused = outcomes.map((outcome, index) => ({ key: keys[index], ...outcome }))
    .filter(outcome => outcome.status !== 200)
  assert.equal(refused.length, 0,
    `Concurrent turns were refused instead of deferring cleanup: ${JSON.stringify(refused)}`)
  outcomes.forEach((outcome, index) => answer(content(outcome), tokens[index]))

  // Each concurrent turn must own a durable mapping with its own transcript,
  // and the budget must never be overbooked while they were in flight.
  const snapshot = readSessionStoreSnapshot()
  assert.deepEqual(Object.keys(snapshot).sort(), keys.map(key => `personal:${key}`).sort())
  const fresh = keys.map(key => snapshot[`personal:${key}`].claudeSessionId)
  assert.equal(new Set(fresh).size, keys.length, "Concurrent turns shared a transcript")
  for (const id of fresh) {
    assert(!sources.some(source => source.id === id), "A concurrent turn reused a retired transcript")
  }
  // Admitting the turns is worthless if their histories were crossed while they
  // raced for the same slot.
  for (const [index, id] of fresh.entries()) {
    const rows = JSON.stringify(await history(id))
    assert(rows.includes(tokens[index]), `Transcript for ${keys[index]} lost its own token`)
    for (const [other, token] of tokens.entries()) {
      if (other !== index) assert(!rows.includes(token), `Transcript for ${keys[index]} absorbed another turn's token`)
    }
  }

  // Deferred cleanup must postpone retirement, never lose the transcript: every
  // parked transcript stays tracked until its real SDK deletion succeeds.
  await proxy.sweepSessionGc()
  assert(pending() <= MAX_PENDING, `Overbooked pending budget: ${pending()}`)
  const tracked = resources()
  for (const key of parked) {
    const row = tracked.find(candidate => candidate.key === key)
    assert(row, `Parked transcript ${key} disappeared from the sidecar`)
  }

  // A follow-up on each concurrent session must still resume correctly.
  for (const [index, key] of keys.entries()) {
    const followup = await attempt(key, [...ask(tokens[index]),
      { role: "assistant", content: [{ type: "text", text: tokens[index] }] },
      { role: "user", content: "Repeat the bug ticket identifier from earlier in this conversation, exactly as it was given. Reply with the identifier and nothing else; no tools are needed." }])
    answer(content(followup), tokens[index])
  }
  for (const source of sources) {
    assert.deepEqual(await history(source.id), source.rows, "Seeded transcript history changed")
  }
  console.log(JSON.stringify({
    result: "PASS", stream, maxPending: MAX_PENDING, parkedBeforeTurns: parked.length,
    concurrentTurnsAdmitted: keys.length, refusals: 0,
    seededHistoriesUnchanged: sources.length, pendingAfterSweep: pending(),
  }))
} finally {
  proxy.beginDrain()
  await proxy.sweepSessionGc()
  await server.stop(true)
}
