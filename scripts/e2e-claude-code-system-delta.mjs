#!/usr/bin/env bun
// Real SDK/HTTP gate for Claude Code trailing-system checkpoint delivery.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import * as sdk from "@anthropic-ai/claude-agent-sdk"
import { spyOn } from "bun:test"
const { getSessionMessages } = sdk
const queryOptions = []
const textPrompts = []
const sdkResults = []
const realQuery = sdk.query
const querySpy = spyOn(sdk, "query").mockImplementation(input => {
  queryOptions.push(input.options)
  textPrompts.push(typeof input.prompt === "string" ? input.prompt : null)
  const query = realQuery(input)
  const iterate = query[Symbol.asyncIterator].bind(query)
  query[Symbol.asyncIterator] = async function* () {
    for await (const event of { [Symbol.asyncIterator]: iterate }) {
      if (event.type === "result") sdkResults.push({ subtype: event.subtype, errors: event.errors, is_error: event.is_error })
      yield event
    }
  }
  return query
})

const stream = process.argv.includes("--stream")
const image = process.argv.includes("--image")
const reviseHistory = process.argv.includes("--revise-history")
const insertHistory = process.argv.includes("--insert-history")
const expectResume = !reviseHistory && !insertHistory
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-cc-system-delta-")))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_PASSTHROUGH: "1" })
const { startProxyServer } = await import("../src/proxy/server.ts")
const { lookupSharedSession } = await import("../src/proxy/sessionStore.ts")
const { telemetryStore } = await import("../src/telemetry/index.ts")
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
const key = `cc-system-${randomUUID()}`
const tools = [{ name: "get_fixture", description: "Return a JavaScript fixture value.",
  input_schema: { type: "object", properties: {}, additionalProperties: false } }]
async function request(messages) {
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "user-agent": "claude-cli/2.1.259" },
    body: JSON.stringify({ model: process.env.E2E_MODEL ?? "claude-haiku-4-5-20251001", max_tokens: 200, stream, tools, messages, metadata: { user_id: JSON.stringify({ session_id: key }) } }),
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
  const insertedIdentifier = `inserted_${randomUUID()}`
  const originalContext = `context_${randomUUID()}`
  const revisedContext = reviseHistory ? `context_${randomUUID()}` : originalContext
  const opening = { role: "user", content: `The fixture context identifier is ${originalContext}. Call get_fixture exactly once. When the result arrives, reply with its value, the fixture context identifier, and the identifier in any accompanying system reminder. No more tools.` }
  const first = await request([opening])
  const calls = first.filter(block => block.type === "tool_use")
  assert.equal(calls.length, 1, JSON.stringify(first))
  const source = lookupSharedSession(key)
  assert(source?.claudeSessionId && source.passthroughToolCallAssistantUuid)
  const sourceRows = await getSessionMessages(source.claudeSessionId, { dir: root })
  assert(sourceRows.length)
  const value = `value_${randomUUID()}`
  const marker = `reminder_${randomUUID()}`
  const reminder = `<system-reminder>The reminder identifier is ${marker}. Include it with the fixture value and the fixture context identifier from the opening user message in your response. If the tool result includes an image, also name its predominant color. Include any extra identifier supplied in a user message before the call. No more tools.</system-reminder>`
  const history = [{ ...opening, content: opening.content.replace(originalContext, revisedContext) },
    ...(insertHistory ? [{ role: "user", content: `The extra identifier is ${insertedIdentifier}. Include it in the final answer.` }] : []), { role: "assistant", content: first },
    { role: "user", content: [{ type: "tool_result", tool_use_id: calls[0].id, content: image ? [{ type: "text", text: value }, blueImage()] : value },
      { type: "text", text: "The requested tool has completed. Report its supplied value, the fixture context identifier from the opening message, and the accompanying reminder identifier. Use the recorded result; no further tool calls are needed." }] },
    { role: "system", content: [{ type: "text", text: reminder, cache_control: { type: "ephemeral" } }] }]
  const second = await request(history)
  const answer = second.filter(block => block.type === "text").map(block => block.text).join("")
  const metric = telemetryStore.getRecent({ limit: 1 })[0]
  console.log(JSON.stringify({ root, stream, image, reviseHistory, insertHistory, answer, expected: [value, marker], isResume: metric?.isResume,
    blocks: second.map(block => ({ type: block.type, name: block.name, text: block.text })), sdkResults, freshPrompt: textPrompts[1], resumeAt: queryOptions[1]?.resumeSessionAt ?? null, expectedCheckpoint: source.passthroughToolCallAssistantUuid }))
  assert.equal(second.filter(block => block.type === "tool_use").length, 0, "A completed result must not cause another tool request")
  assert(answer.includes(value) && answer.includes(marker), "Both real result and system-reminder text must reach the answer")
  if (image) assert(answer.toLowerCase().includes("blue"), "Tool-result image must reach the model")
  assert(answer.includes(revisedContext), "Revised opening context must reach the answer")
  if (reviseHistory) assert(!answer.includes(originalContext), "Removed opening context leaked into the answer")
  if (insertHistory) assert(answer.includes(insertedIdentifier), "Inserted user context must reach the answer")
  assert.equal(metric?.isResume, expectResume, "Only unchanged history may resume its checkpoint")
  assert.equal(queryOptions[1]?.resumeSessionAt, expectResume ? source.passthroughToolCallAssistantUuid : undefined)
  assert(!JSON.stringify(queryOptions[1]?.systemPrompt).includes(marker), "Reminder was escalated into the SDK system prompt")
  const current = lookupSharedSession(key)
  assert(current?.claudeSessionId)
  const rows = await getSessionMessages(current.claudeSessionId, { dir: root })
  const users = JSON.stringify(rows.filter(row => row.type === "user"))
  assert(users.includes(value) && users.includes(marker))
  assert(!users.includes("[Assistant: <system-reminder>"), "Reminder was attributed to the assistant during replay")
  if (insertHistory) assert(users.includes(insertedIdentifier))
  if (reviseHistory) {
    assert(users.includes(revisedContext) && !users.includes(originalContext))
    assert(users.includes("</conversation_history>"), "Fresh history must retain its context boundary")
  }
  assert.deepEqual(await getSessionMessages(source.claudeSessionId, { dir: root }), sourceRows)
  console.log(JSON.stringify({ result: "PASS", stream, reminderDelivered: true, sourceUnchanged: true }))
} finally {
  querySpy.mockRestore()
  await instance.close()
}
