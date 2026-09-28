#!/usr/bin/env bun
/** Fresh structured replay of a client `system` tool-change message (#1178).
 *  omp sends `tool_addition`/`tool_removal` blocks when it activates a deferred
 *  tool. The API accepts those block types only inside a mid-conversation system
 *  message, and structured replay recasts every non-assistant message as a user
 *  turn, so an unrendered block makes the whole request fail with a 400. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk"

const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-replay-tool-change-")))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"),
  MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root,
  MERIDIAN_TELEMETRY_PERSIST: "0",
})
const { startProxyServer } = await import("../src/proxy/server.ts")
const { readSessionStoreSnapshot } = await import("../src/proxy/sessionStore.ts")
const { telemetryStore } = await import("../src/telemetry/index.ts")

// A real 1x1 PNG. Media is what forces the structured replay path; the text path
// drops unknown blocks and never reproduced this failure.
function pixel() {
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
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2
  const row = Buffer.from([0, 0, 0, 255])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(row)), chunk("IEND", Buffer.alloc(0))]).toString("base64")
}

const stream = process.argv.includes("--stream")
const model = process.env.E2E_MODEL ?? "haiku"
// An unused session key: an unknown session is what takes the fresh replay path.
const key = `omp-tool-change-${randomUUID()}`
const messages = [
  { role: "user", content: [{ type: "text", text: "Here is the screenshot from earlier." },
    { type: "image", source: { type: "base64", media_type: "image/png", data: pixel() } }] },
  // The exact client shape: a mid-conversation system message carrying only
  // tool-change blocks, in both the `name` and nested `tool.name` spellings.
  { role: "system", content: [{ type: "tool_addition", name: "grep" }, { type: "tool_removal", tool: { name: "bash" } }] },
  { role: "assistant", content: [{ type: "text", text: "Understood, I will use grep from now on." }] },
  { role: "user", content: [{ type: "text", text: "Reply with exactly: PONG" }] },
]
const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const address = instance.server.address()
assert(address && typeof address === "object")
try {
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-meridian-agent": "pi", "x-session-affinity": key },
    body: JSON.stringify({ model, max_tokens: 128, stream, messages }),
    signal: AbortSignal.timeout(90_000),
  })
  const raw = await response.text()
  // Before the fix this is a 500 carrying the upstream
  // "Input tag 'tool_addition' ... does not match any of the expected tags" 400.
  assert.equal(response.status, 200, raw)
  let blocks
  if (!stream) {
    blocks = JSON.parse(raw).content
  } else {
    const events = raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
    assert(!events.some(event => event.type === "error"), raw)
    blocks = []
    for (const event of events) {
      if (event.type === "content_block_start") blocks[event.index] = { ...event.content_block }
      if (event.delta?.type === "text_delta") blocks[event.index].text += event.delta.text
    }
    blocks = blocks.filter(Boolean)
  }
  const answer = blocks.filter(block => block.type === "text").map(block => block.text).join("").trim()
  assert.equal(answer, "PONG", `Unexpected answer: ${answer}`)

  // The blocks must be rendered into history, not dropped: the model should keep
  // the tool-change record, and a system message holding only tool changes must
  // never become an empty user turn.
  const session = readSessionStoreSnapshot()[key]
  assert(session?.claudeSessionId, "No durable mapping for the replayed session")
  const rows = await getSessionMessages(session.claudeSessionId, { dir: root })
  const sdkText = JSON.stringify(rows)
  assert(sdkText.includes("[Client added tool: grep]"), "tool_addition was not rendered into history")
  assert(sdkText.includes("[Client removed tool: bash]"), "tool_removal was not rendered into history")
  assert(!sdkText.includes('"tool_addition"'), "a raw tool_addition block reached the SDK")
  assert(!sdkText.includes('"tool_removal"'), "a raw tool_removal block reached the SDK")
  const telemetry = telemetryStore.getRecent({ limit: 1 })[0]
  assert.equal(telemetry?.lineageType, "new", "The gate must exercise a fresh replay")
  console.log(JSON.stringify({ result: "PASS", stream, model, answer, lineage: telemetry.lineageType }))
} finally {
  await instance.close()
}
