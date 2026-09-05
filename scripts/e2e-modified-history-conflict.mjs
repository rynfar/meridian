#!/usr/bin/env bun
// Real HTTP + SDK validation. Only scheduling is controlled; model replies are real.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spyOn } from "bun:test"
import * as sdk from "@anthropic-ai/claude-agent-sdk"

const stream = process.argv.includes("--stream")
const model = process.env.E2E_MODEL ?? "claude-haiku-4-5-20251001"
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-modified-race-")))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_PASSTHROUGH: "1" })

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
async function bounded(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 90_000)
  })]) } finally { clearTimeout(timer) }
}
let gates
let nextGate = 0
const originalQuery = sdk.query
const querySpy = spyOn(sdk, "query").mockImplementation(input => {
  const actual = originalQuery(input)
  const gate = gates?.[nextGate++]
  if (!gate) return actual
  gate.options = input.options
  gate.started.resolve()
  return new Proxy(actual, { get(target, property) {
    if (property === Symbol.asyncIterator) return async function* () {
      await gate.release.promise
      yield* actual
    }
    const value = Reflect.get(target, property, target)
    return typeof value === "function" ? value.bind(target) : value
  } })
})
const { startProxyServer } = await import("../src/proxy/server.ts")
const { processSessionTurns } = await import("../src/proxy/session/turnCoordinator.ts")
const { lookupSharedSession } = await import("../src/proxy/sessionStore.ts")
const { telemetryStore } = await import("../src/telemetry/index.ts")
const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const address = instance.server.address()
assert(address && typeof address === "object")
const url = `http://127.0.0.1:${address.port}/v1/messages`
async function request(key, messages) {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", "x-meridian-agent": "opencode", "x-opencode-session": key },
    body: JSON.stringify({ model, stream, max_tokens: 400, tools: [], messages,
      ...(messages.length >= 5 ? { output_config: { format: { type: "json_schema", schema: { type: "object", properties: { value: { type: "string" }, decision: { type: "string" } }, required: ["value", "decision"], additionalProperties: false } } } } : {}),
      metadata: { user_id: JSON.stringify({ session_id: key }) } }), signal: AbortSignal.timeout(90_000),
  })
  const raw = await response.text()
  if (response.status !== 200) return { status: response.status, raw }
  if (!stream) return { status: response.status, content: JSON.parse(raw).content }
  const events = raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
  assert(!events.some(event => event.type === "error"), raw)
  assert.equal(events.filter(event => event.type === "message_stop").length, 1, raw)
  const content = []
  for (const event of events) {
    if (event.type === "content_block_start") content[event.index] = { ...event.content_block }
    if (event.delta?.type === "text_delta") content[event.index].text += event.delta.text
  }
  return { status: response.status, content: content.filter(Boolean) }
}
function checkAnswer(response, expected, excluded) {
  assert.equal(response.status, 200, response.raw)
  assert(!response.content.some(block => block.type === "tool_use"), JSON.stringify(response))
  const answer = response.content.filter(block => block.type === "text").map(block => block.text).join("")
  for (const field of expected) assert(answer.includes(field), answer)
  if (excluded) assert(!answer.includes(excluded), answer)
  return answer
}
async function snapshot(key) {
  const mapping = lookupSharedSession(key)
  assert(mapping?.claudeSessionId, "Missing durable session")
  const rows = await sdk.getSessionMessages(mapping.claudeSessionId, { dir: root })
  assert(rows.length, "SDK history must be readable through the supported API")
  return { id: mapping.claudeSessionId, rows }
}
async function unchanged(source) {
  assert.deepEqual(await sdk.getSessionMessages(source.id, { dir: root }), source.rows, "Source history changed")
}
try {
  const key = `modified-${randomUUID()}`
  const old = `old_${randomUUID().slice(0, 8)}`
  const revisedValue = `revised_${randomUUID().slice(0, 8)}`
  const decision = `decision_${randomUUID().slice(0, 8)}`
  const firstHistory = [
    { role: "user", content: "Read the JavaScript fixture. After the tool result reply only ACK. No further tools." },
    { role: "assistant", content: [{ type: "tool_use", id: "fixture_call", name: "read", input: { path: "fixture.txt" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "fixture_call", content: old }] },
  ]
  const revised = [...firstHistory.slice(0, 2),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "fixture_call", content: revisedValue }] },
    { role: "assistant", content: `The decision identifier is ${decision}.` },
    { role: "user", content: "Return only one JSON object with keys value (the latest fixture result value) and decision (the decision identifier). Use raw JSON only, with no markdown fences, preamble or commentary. No tools." },
  ]
  gates = Array.from({ length: 2 }, () => ({ started: deferred(), release: deferred() }))
  nextGate = 0
  const firstP = request(key, firstHistory)
  await bounded(gates[0].started.promise, "first SDK query")
  const queued = deferred()
  const acquire = processSessionTurns.acquire.bind(processSessionTurns)
  const arrivalSpy = spyOn(processSessionTurns, "acquire").mockImplementation((turnKey, signal) => {
    const result = acquire(turnKey, signal)
    if (turnKey === `session:${key}`) queued.resolve()
    return result
  })
  const secondP = request(key, revised)
  try { await bounded(queued.promise, "revised request queue admission") } finally { arrivalSpy.mockRestore() }
  gates[0].release.resolve()
  const first = await firstP
  checkAnswer(first, ["ACK"])
  await bounded(Promise.race([gates[1].started.promise, secondP]), "second SDK query or refusal")
  const source = await snapshot(key)
  gates[1].release.resolve()
  const second = await secondP
  console.log(JSON.stringify({ root, stream, model, status: second.status, error: second.raw, resume: gates[1].options?.resume ?? null }))
  const answer = checkAnswer(second, [revisedValue, decision], old)
  console.log(JSON.stringify({ answer }))
  assert.deepEqual(JSON.parse(answer), { value: revisedValue, decision })
  assert.equal(gates[1].options?.resume, undefined, "Revised history must replay fresh")
  await unchanged(source)
  const current = await snapshot(key)
  const supplied = JSON.stringify(current.rows.filter(row => row.type === "user"))
  assert(supplied.includes(revisedValue) && supplied.includes(decision))
  assert(!supplied.includes(old), "Old branch value leaked into fresh target")
  console.log(JSON.stringify({ beforeFollowup: lookupSharedSession(key) }))
  gates = undefined
  const followup = await request(key, [...revised, { role: "assistant", content: second.content },
    { role: "user", content: "Repeat that exact JSON object only. Use raw JSON without markdown fences or commentary. No tools." }])
  assert.deepEqual(JSON.parse(checkAnswer(followup, [revisedValue, decision], old)), { value: revisedValue, decision })
  console.log(JSON.stringify({ followupMetrics: telemetryStore.getRecent({ limit: 3 }) }))
  assert.equal(telemetryStore.getRecent({ limit: 1 })[0]?.isResume, true)
  await unchanged(source)
  console.log(JSON.stringify({ result: "PASS", stream, answer, followupResume: true, sourceUnchanged: true }))
} finally {
  for (const gate of gates ?? []) gate.release.resolve()
  querySpy.mockRestore()
  await instance.close()
}
