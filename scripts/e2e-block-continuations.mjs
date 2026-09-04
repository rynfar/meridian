#!/usr/bin/env bun
/** Real SDK tool/text/media appends, transient hooks and meaningful removals. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk"

const stream = process.argv.includes("--stream")
const withImage = process.argv.includes("--image")
const selected = process.argv.find(arg => arg.startsWith("--case="))?.slice(7)
const model = process.env.E2E_MODEL ?? "claude-haiku-4-5-20251001"
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-block-continuations-")))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_PASSTHROUGH: "1" })
const { startProxyServer } = await import("../src/proxy/server.ts")
const { lookupSharedSession } = await import("../src/proxy/sessionStore.ts")
const { telemetryStore } = await import("../src/telemetry/index.ts")
const text = value => ({ type: "text", text: value })
const hook = text('<user-prompt-submit-hook>{"continue":true}</user-prompt-submit-hook>')
const answerText = blocks => blocks.filter(block => block.type === "text").map(block => block.text).join("")
const failures = []

function blueImage() {
  function chunk(type, data) {
    let crc = 0xffffffff
    for (const byte of Buffer.concat([Buffer.from(type), data])) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, Buffer.from(type), data, checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(48); header.writeUInt32BE(48, 4); header[8] = 8; header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 48 }, () => [0, 0, 255]).flat())])
  const data = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: 48 }, () => row)))), chunk("IEND", Buffer.alloc(0))]).toString("base64")
  return { type: "image", source: { type: "base64", media_type: "image/png", data } }
}

const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const address = instance.server.address()
assert(address && typeof address === "object")
async function request(key, messages, tools = []) {
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session": key, "x-meridian-agent": "opencode" },
    body: JSON.stringify({ model, max_tokens: 256, stream, tools, messages }), signal: AbortSignal.timeout(90_000),
  })
  const raw = await response.text()
  assert.equal(response.status, 200, raw)
  if (!stream) return JSON.parse(raw).content
  const events = raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
  assert(!events.some(event => event.type === "error"), raw)
  assert.equal(events.filter(event => event.type === "message_stop").length, 1, raw)
  const blocks = []
  for (const event of events) {
    if (event.type === "content_block_start") blocks[event.index] = { ...event.content_block, json: "" }
    if (event.delta?.type === "text_delta") blocks[event.index].text = (blocks[event.index].text ?? "") + event.delta.text
    if (event.delta?.type === "input_json_delta") blocks[event.index].json += event.delta.partial_json
  }
  return blocks.filter(Boolean).map(({ json, ...block }) => block.type === "tool_use"
    ? { ...block, input: json ? JSON.parse(json) : block.input } : block)
}
async function snapshot(key) {
  const mapping = lookupSharedSession(key)
  assert(mapping?.claudeSessionId, "durable mapping missing")
  const rows = await getSessionMessages(mapping.claudeSessionId, { dir: root })
  assert(rows.length > 0, "supported SDK history is empty")
  return { id: mapping.claudeSessionId, rows }
}
async function unchanged(source) {
  assert.deepEqual(await getSessionMessages(source.id, { dir: root }), source.rows, "source was mutated")
}
function record(mode, valid, detail) {
  console.log(JSON.stringify({ mode, stream, withImage, model, valid, ...detail }))
  if (!valid) failures.push(mode)
}

try {
  if (!selected || selected === "append") {
    const key = `append-${randomUUID()}`
    const marker = `record_${randomUUID()}`
    const suffix = `suffix_${randomUUID()}`
    const fixture = join(root, "fixture.json")
    writeFileSync(fixture, JSON.stringify({ record: marker }))
    const tools = [{ name: "get_fixture", description: "Read the JavaScript test fixture record.",
      input_schema: { type: "object", properties: {}, additionalProperties: false } }]
    const firstMessage = { role: "user", content: "Call get_fixture once, then answer with its record identifier. Do not call again after receiving the result." }
    const first = await request(key, [firstMessage], tools)
    const calls = first.filter(block => block.type === "tool_use")
    assert.equal(calls.length, 1, JSON.stringify(first)); assert.equal(calls[0].name, "get_fixture")
    const result = { type: "tool_result", tool_use_id: calls[0].id, content: readFileSync(fixture, "utf8") }
    const history = [firstMessage, { role: "assistant", content: first }, { role: "user", content: [result] }]
    const initial = await request(key, history, tools)
    assert(answerText(initial).includes(marker) && !initial.some(block => block.type === "tool_use"), JSON.stringify(initial))
    const source = await snapshot(key)
    const appended = text(`Additional requirement: answer with the same record identifier followed by ${suffix}. Use the supplied result; do not call any tool.` +
      (withImage ? " Also name the dominant color of the attached image." : ""))
    const response = await request(key, [history[0], history[1], { role: "user", content: [result, hook, appended, ...(withImage ? [blueImage()] : [])] }], tools)
    const lineage = telemetryStore.getRecent({ limit: 1 })[0]?.lineageType
    const current = await snapshot(key)
    const lastInput = JSON.stringify(current.rows.filter(row => row.type === "user").at(-1)?.message)
    const answer = answerText(response)
    const valid = lineage === "continuation" && lastInput.includes(suffix) && !lastInput.includes(marker)
      && !lastInput.includes("user-prompt-submit-hook") && answer.includes(marker) && answer.includes(suffix)
      && (!withImage || /blue/i.test(answer)) && !response.some(block => block.type === "tool_use")
    record("append", valid, { lineage, answer, deltaOnly: !lastInput.includes(marker) })
    await unchanged(source)
  }

  if (!selected || selected === "hook") {
    const key = `hook-${randomUUID()}`
    const marker = `fixture_${randomUUID()}`
    const durable = text(`In a JavaScript example, assign the string "${marker}" to const fixtureId. Return only that code line; no tools are needed.`)
    const first = await request(key, [{ role: "user", content: [hook, durable] }])
    assert(answerText(first).includes(marker), answerText(first))
    const source = await snapshot(key)
    const response = await request(key, [{ role: "user", content: [durable] }, { role: "assistant", content: first },
      { role: "user", content: "Write expect(fixtureId).toBe(...) using the exact value from my first message. No tools are needed." }])
    const lineage = telemetryStore.getRecent({ limit: 1 })[0]?.lineageType
    record("hook", lineage === "continuation" && answerText(response).includes(marker), { lineage, answer: answerText(response) })
    await unchanged(source)
  }

  if (!selected || selected === "drop") {
    const key = `drop-${randomUUID()}`
    const retained = `retained_${randomUUID().slice(0, 8)}`
    const removed = `removed_${randomUUID().slice(0, 8)}`
    const durable = text(`My JavaScript fixture declares field ${retained}. Remember the field names; for now reply only ACK.`)
    const extra = text(`It also declares field ${removed}. For now reply only ACK.`)
    const first = await request(key, [{ role: "user", content: [durable, extra] }])
    assert(!answerText(first).includes(removed), "fixture reply must not carry the subsequently removed content")
    const source = await snapshot(key)
    const response = await request(key, [{ role: "user", content: [durable] }, { role: "assistant", content: first },
      { role: "user", content: "List only the fixture field names explicitly declared in my first message." }])
    const lineage = telemetryStore.getRecent({ limit: 1 })[0]?.lineageType
    const current = await snapshot(key)
    const input = JSON.stringify(current.rows.filter(row => row.type === "user"))
    const answer = answerText(response)
    record("drop", lineage === "new" && input.includes(retained) && !input.includes(removed)
      && answer.includes(retained) && !answer.includes(removed), { lineage, answer, removedAbsent: !input.includes(removed) })
    await unchanged(source)
  }
  assert.deepEqual(failures, [], "block continuation validation failed")
  console.log(`PASS: block continuations (${selected ?? "all"}, stream=${stream}, image=${withImage})`)
} finally { await instance.close() }
