#!/usr/bin/env bun
/** Observe the real SDK input for historical media in a fresh Pi replay. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk"

const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-replay-media-")))
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

function solidImage(red, green, blue) {
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 48 }, () => [red, green, blue]).flat())])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: 48 }, () => row)))), chunk("IEND", Buffer.alloc(0))]).toString("base64")
}

const marker = `CURRENT_${randomUUID()}`
const key = `pi-replay-media-${randomUUID()}`
const model = process.env.E2E_MODEL ?? "claude-sonnet-5"
const currentImage = process.argv.includes("--current-image")
const historicalImageData = solidImage(0, 0, 255)
const currentImageData = solidImage(255, 0, 0)
const messages = [
  { role: "user", content: [{ type: "text", text: "Please inspect the screenshot you captured earlier." },
    { type: "image", source: { type: "base64", media_type: "image/png", data: historicalImageData } }] },
  { role: "assistant", content: [{ type: "text", text: "I captured that screenshot and saw blue." }] },
  { role: "user", content: [{ type: "text", text: `For this turn, did I attach an image? Explain briefly. ${marker}` },
    ...(currentImage ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: currentImageData } }] : [])] },
]
const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const address = instance.server.address()
assert(address && typeof address === "object")
try {
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-meridian-agent": "pi", "x-session-affinity": key },
    body: JSON.stringify({ model, max_tokens: 256, stream: false, messages }),
    signal: AbortSignal.timeout(90_000),
  })
  const raw = await response.text()
  assert.equal(response.status, 200, raw)
  const body = JSON.parse(raw)
  const session = readSessionStoreSnapshot()[key]
  assert(session?.claudeSessionId)
  const rows = await getSessionMessages(session.claudeSessionId, { dir: root })
  const firstInput = rows.find(row => row.type === "user")?.message
  const blocks = firstInput?.content
  assert(Array.isArray(blocks), "SDK input must preserve structured blocks")
  const imageIndex = blocks.findIndex(block => block.type === "image")
  const closeIndex = blocks.findIndex(block => block.type === "text" && block.text?.includes("</conversation_history>"))
  const currentIndex = blocks.findIndex(block => block.type === "text" && block.text?.includes(marker))
  const currentImageIndex = blocks.findIndex(block => block.type === "image" && block.source?.data === currentImageData)
  const provenance = blocks.find(block => block.type === "text" && block.text?.includes("[Meridian attachment provenance:"))?.text
  const adapter = telemetryStore.getRecent({ limit: 1 })[0]
  assert(imageIndex >= 0 && imageIndex < closeIndex && closeIndex < currentIndex,
    `historical image crossed the replay boundary: ${imageIndex}, ${closeIndex}, ${currentIndex}`)
  assert.equal(currentImageIndex > currentIndex, currentImage)
  assert(provenance?.includes(`current client turn contains exactly ${Number(currentImage)} ${currentImage ? "image" : "images"}`))
  assert(provenance?.includes("Earlier replayed turns contain 1 image, 0 documents, and 0 files"))
  assert.equal(adapter?.adapter, "pi")
  assert.equal(adapter?.lineageType, "new")
  console.log(JSON.stringify({ model, imageIndex, closeIndex, currentIndex, currentImageIndex,
    adapter: adapter.adapter, lineage: adapter.lineageType,
    answer: body.content?.filter(block => block.type === "text").map(block => block.text).join("") }))
} finally {
  await instance.close()
}
