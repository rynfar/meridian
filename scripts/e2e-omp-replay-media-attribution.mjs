#!/usr/bin/env bun
/** Real Oh My Pi client check for agent-owned historical media on a fresh replay. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { deflateSync } from "node:zlib"

const packageDir = process.env.E2E_OMP_PACKAGE
assert(packageDir, "Set E2E_OMP_PACKAGE to an isolated installed Oh My Pi package directory")
const meridianRoot = process.env.E2E_MERIDIAN_ROOT ?? fileURLToPath(new URL("..", import.meta.url))
const modelId = process.env.E2E_MODEL ?? "claude-haiku-4-5-20251001"
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-omp-replay-media-")))
const agentDir = join(root, "omp")
mkdirSync(agentDir)
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_") || key.startsWith("PI_")) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "meridian"),
  MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root,
  MERIDIAN_TELEMETRY_PERSIST: "0",
  PI_CODING_AGENT_DIR: agentDir,
})
process.chdir(root)

function imageData() {
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

const sourceModule = join(meridianRoot, "src/proxy/server.ts")
const serverModule = existsSync(sourceModule) ? sourceModule : join(meridianRoot, "dist/server.js")
assert(existsSync(serverModule), `Missing Meridian server module: ${serverModule}`)
const { startProxyServer } = await import(pathToFileURL(serverModule).href)
const proxy = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const address = proxy.server.address()
assert(address && typeof address === "object")
const requests = []
const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, async fetch(request) {
  const path = new URL(request.url).pathname
  if (request.method !== "POST" || path !== "/v1/messages") {
    return fetch(`http://127.0.0.1:${address.port}${path}`, { method: request.method, headers: request.headers })
  }
  const raw = await request.text()
  const body = JSON.parse(raw)
  const summary = body.messages.map(message => ({ role: message.role,
    media: Array.isArray(message.content) ? message.content.filter(block => block.type === "image").length : 0 }))
  requests.push(summary)
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST", headers: request.headers, body: raw, signal: AbortSignal.timeout(120_000),
  })
  const output = await response.text()
  assert.equal(response.status, 200, output)
  return new Response(output, { status: response.status, headers: response.headers })
} })

writeFileSync(join(agentDir, "models.yml"), `providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:${relay.port}\n    apiKey: x\n    headers:\n      x-meridian-agent: pi\n`)
let session
try {
  const { createAgentSession } = await import(pathToFileURL(join(packageDir, "src/sdk.ts")).href)
  const { Settings } = await import(pathToFileURL(join(packageDir, "src/config/settings.ts")).href)
  const { SessionManager } = await import(pathToFileURL(join(packageDir, "src/session/session-manager.ts")).href)
  const sessionManager = SessionManager.inMemory(root)
  sessionManager.appendCustomMessageEntry("historical-screenshot", [
    { type: "text", text: "Earlier in this conversation I, the assistant, captured this screenshot. It was blue." },
    { type: "image", mimeType: "image/png", data: imageData() },
  ], false, undefined, "agent")
  const settings = await Settings.init({ cwd: root, agentDir, overrides: {
    "providers.tinyModel": "online", modelRoles: { default: `anthropic/${modelId}`, smol: `anthropic/${modelId}`, tiny: `anthropic/${modelId}` },
  } })
  const created = await createAgentSession({ cwd: root, agentDir, settings, sessionManager, modelPattern: `anthropic/${modelId}`,
    systemPrompt: "Answer the current user's question, using prior conversation only as context.",
    disableExtensionDiscovery: true, skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
    enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
    toolNames: [], restrictToolNames: true,
  })
  session = created.session
  await session.prompt(`Did I attach an image to this current turn? Answer briefly. ${randomUUID()}`)
  assert(requests.length > 0, "actual Oh My Pi client sent no request")
  const main = requests.at(-1)
  assert(main.length >= 2, JSON.stringify(main))
  assert(main.slice(0, -1).some(message => message.media > 0), JSON.stringify(main))
  assert.equal(main.at(-1)?.media, 0, "the current Oh My Pi turn must be text only")
  const telemetryResponse = await fetch(`http://127.0.0.1:${address.port}/telemetry/requests?limit=1&hops=1`)
  assert.equal(telemetryResponse.status, 200)
  const telemetry = (await telemetryResponse.json())[0]
  assert.equal(telemetry?.adapter, "pi")
  assert.equal(telemetry?.lineageType, "new")
  console.log(JSON.stringify({ ompVersion: JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version,
    meridianRoot, serverModule, modelId, requestCount: requests.length, messageSummary: main, lineage: telemetry.lineageType,
    answer: session.getLastAssistantText(), root }))
} finally {
  if (session) await session.dispose()
  relay.stop(true)
  await proxy.close()
}
