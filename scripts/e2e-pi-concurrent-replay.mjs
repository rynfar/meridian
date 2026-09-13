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
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-pi-race-")))
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
    method: "POST", headers: { "content-type": "application/json", "x-meridian-agent": "pi" },
    body: JSON.stringify({ model, stream, max_tokens: 160, tools: [], messages,
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
const failures = []
try {
  for (const firstName of ["main", "side"]) {
    gates = undefined
    const key = `pi-${randomUUID()}`
    const base = `base_${randomUUID().slice(0, 8)}`
    const main = `main_${randomUUID().slice(0, 8)}`
    const side = `side_${randomUUID().slice(0, 8)}`
    const opening = [{ role: "user", content: `A JavaScript fixture has field ${base}. For now reply only ACK. No tools.` }]
    const initial = await request(key, opening)
    assert.equal(initial.status, 200, initial.raw)
    const source = await snapshot(key)
    const prefix = [...opening, { role: "assistant", content: initial.content }]
    const histories = Object.fromEntries([["main", main], ["side", side]].map(([name, field]) => [name,
      [...prefix, { role: "user", content: `Also declare field ${field}. List only the fixture field names declared in this conversation, as one JSON array. No tools.` }]]))
    const secondName = firstName === "main" ? "side" : "main"
    gates = Array.from({ length: 2 }, () => ({ started: deferred(), release: deferred() }))
    nextGate = 0
    const firstP = request(key, histories[firstName])
    await bounded(gates[0].started.promise, "first SDK query")
    const queued = deferred()
    const acquire = processSessionTurns.acquire.bind(processSessionTurns)
    const arrivalSpy = spyOn(processSessionTurns, "acquire").mockImplementation((turnKey, signal) => {
      const result = acquire(turnKey, signal)
      if (turnKey === `session:${key}`) queued.resolve()
      return result
    })
    const secondP = request(key, histories[secondName])
    try { await bounded(queued.promise, "second request queue admission") } finally { arrivalSpy.mockRestore() }
    gates[0].release.resolve()
    const first = await firstP
    checkAnswer(first, [base, firstName === "main" ? main : side], firstName === "main" ? side : main)
    await bounded(Promise.race([gates[1].started.promise, secondP]), "second SDK query or refusal")
    const winner = await snapshot(key)
    gates[1].release.resolve()
    const second = await secondP
    console.log(JSON.stringify({ firstName, stream, model, secondStatus: second.status, secondError: second.raw,
      secondResume: gates[1].options?.resume ?? null, secondRollback: gates[1].options?.resumeSessionAt ?? null }))
    if (second.status !== 200) { failures.push(`${firstName}-first refused`); await unchanged(source); continue }
    assert.equal(gates[1].options?.resume, undefined, "Unmarked race loser must replay its own body")
    assert.equal(gates[1].options?.resumeSessionAt, undefined)
    checkAnswer(second, [base, secondName === "main" ? main : side], secondName === "main" ? side : main)
    const loser = await snapshot(key)
    await unchanged(winner)
    await unchanged(source)
    gates = undefined
    const mainAnswer = firstName === "main" ? first : second
    const followup = await request(key, [...histories.main, { role: "assistant", content: mainAnswer.content },
      { role: "user", content: "List those same fixture field names again as one JSON array. No tools." }])
    const answer = checkAnswer(followup, [base, main], side)
    await unchanged(winner)
    await unchanged(loser)
    await unchanged(source)
    console.log(JSON.stringify({ firstName, stream, model, valid: true, answer,
      followupLineage: telemetryStore.getRecent({ limit: 1 })[0]?.lineageType }))
  }
  assert.deepEqual(failures, [], "Pi concurrency replay failed")
} finally {
  for (const gate of gates ?? []) gate.release.resolve()
  querySpy.mockRestore()
  await instance.close()
}
