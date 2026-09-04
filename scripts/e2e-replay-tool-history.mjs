#!/usr/bin/env bun
/** Real fresh-replay tool loop for #888/#858. Uses supported SDK history only. */
import assert from "node:assert/strict"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { deflateSync } from "node:zlib"
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk"

const stream = process.argv.includes("--stream")
const withImage = process.argv.includes("--image")
const model = process.env.E2E_MODEL ?? "claude-haiku-4-5-20251001"
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-replay-tools-")))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_PASSTHROUGH: "1" })
const { startProxyServer } = await import("../src/proxy/server.ts")
const { readSessionStoreSnapshot } = await import("../src/proxy/sessionStore.ts")
const { telemetryStore } = await import("../src/telemetry/index.ts")

function blueImage() {
  function chunk(type, data) {
    const bytes = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of bytes) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, bytes, checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(48); header.writeUInt32BE(48, 4); header[8] = 8; header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 48 }, () => [0, 0, 255]).flat())])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: 48 }, () => row)))), chunk("IEND", Buffer.alloc(0))]).toString("base64")
}

async function readResponse(response) {
  const raw = await response.text()
  assert.equal(response.status, 200, raw)
  if (!stream) return JSON.parse(raw).content
  const events = raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
  assert(!events.some(event => event.type === "error"), raw)
  assert.equal(events.filter(event => event.type === "message_stop").length, 1)
  const blocks = []
  for (const event of events) {
    if (event.type === "content_block_start") blocks[event.index] = { ...event.content_block, json: "" }
    if (event.delta?.type === "text_delta") blocks[event.index].text = (blocks[event.index].text ?? "") + event.delta.text
    if (event.delta?.type === "input_json_delta") blocks[event.index].json += event.delta.partial_json
  }
  return blocks.filter(Boolean).map(({ json, ...block }) => block.type === "tool_use"
    ? { ...block, input: json ? JSON.parse(json) : block.input } : block)
}

const tools = [{ name: "get_room_price", description: "Look up the nightly room price. Use for a room price question.",
  input_schema: { type: "object", properties: { room_type: { type: "string" } }, required: ["room_type"] } }]
const marker = `PRICE_${randomUUID()}`
const messages = [{ role: "user", content: [
  { type: "text", text: "What is the nightly price of a Deluxe Clifftop room? Use the tool to check, then answer with its exact price and confirmation code. Do not narrate before calling." +
    (withImage ? " Also name the dominant color of this image." : "") },
  ...(withImage ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: blueImage() } }] : []),
] }]
const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const address = instance.server.address()
assert(address && typeof address === "object")
const delivered = []
const problems = []
let finalText = ""
try {
  for (let round = 0; round < 4; round++) {
    // Distinct identities intentionally exercise full replay, independently of
    // resumable checkpoints. This is the path taken by changed/legacy history.
    const key = `replay-tools-${randomUUID()}`
    const blocks = await readResponse(await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json", "x-opencode-session": key },
      body: JSON.stringify({ model, max_tokens: 512, stream, tools, messages }), signal: AbortSignal.timeout(90_000),
    }))
    const active = readSessionStoreSnapshot()[key]
    assert(active?.claudeSessionId, "missing durable SDK mapping")
    const rows = await getSessionMessages(active.claudeSessionId, { dir: root })
    assert(rows.length > 0, "supported SDK history is empty")
    const firstInput = rows.find(row => row.type === "user")?.message
    const serialized = JSON.stringify(firstInput)
    const inputBlocks = Array.isArray(firstInput?.content) ? firstInput.content : []
    const inputText = typeof firstInput?.content === "string" ? firstInput.content
      : inputBlocks.filter(block => block.type === "text").map(block => block.text).join("\n")
    const missingCalls = delivered.filter(call => ![call.id, call.name, JSON.stringify(call.input)].every(value => inputText.includes(value)))
    const orphanResults = inputBlocks.filter(block => block.type === "tool_result").length
    if (missingCalls.length || orphanResults) problems.push(`round ${round + 1}: missing ${missingCalls.length} call identities, ${orphanResults} unpaired native results`)
    if (round > 0 && !serialized.includes(marker)) problems.push(`round ${round + 1}: result payload disappeared`)
    const calls = blocks.filter(block => block.type === "tool_use")
    finalText = blocks.filter(block => block.type === "text").map(block => block.text).join("")
    console.log(JSON.stringify({ round: round + 1, stream, withImage, calls: calls.length,
      lineage: telemetryStore.getRecent({ limit: 1 })[0]?.lineageType, missingCalls: missingCalls.length,
      orphanResults, answer: finalText }))
    if (calls.length === 0) break
    if (round > 0) problems.push(`round ${round + 1}: repeated an already answered lookup`)
    for (const call of calls) assert.equal(call.name, "get_room_price")
    delivered.push(...calls)
    // Tool-only assistant turns are valid client history and are the lost
    // shape in #888. No model-authored reasoning is fabricated or replayed.
    messages.push({ role: "assistant", content: calls }, { role: "user", content: calls.map(call => ({
      type: "tool_result", tool_use_id: call.id, content: `Deluxe Clifftop: 4,500 THB per night. Confirmation code ${marker}.`,
    })) })
  }
  assert.equal(delivered.length, 1, "the completed lookup must not be repeated")
  assert(finalText.includes(marker) && /4[,.]?500/.test(finalText), "answer did not preserve the real tool output")
  if (withImage) assert(/blue/i.test(finalText), "image did not survive replay")
  assert.deepEqual(problems, [], "fresh replay lost tool history")
  console.log(`PASS: full replay preserves completed tool history (stream=${stream}, image=${withImage})`)
} finally {
  await instance.close()
}
