#!/usr/bin/env bun
// Exercises the real Oh My Pi session/title/tool-loop APIs against the real SDK.
// E2E_OMP_PACKAGE points to an isolated installed @oh-my-pi/pi-coding-agent directory.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { spyOn } from "bun:test"
import * as sdk from "@anthropic-ai/claude-agent-sdk"

const packageDir = process.env.E2E_OMP_PACKAGE
assert(packageDir, "Set E2E_OMP_PACKAGE to the installed Oh My Pi package directory")
const firstKind = process.argv.includes("--main-first") ? "main" : "title"
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-omp-client-")))
const agentDir = join(root, "omp")
console.log(JSON.stringify({ root, firstKind }))
mkdirSync(agentDir)
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_") || key.startsWith("PI_")) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "meridian"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_PASSTHROUGH: "1", PI_CODING_AGENT_DIR: agentDir })
process.chdir(root)
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const started = deferred()
const queued = deferred()
let firstQuery = true
let queryCount = 0
const originalQuery = sdk.query
const querySpy = spyOn(sdk, "query").mockImplementation(input => {
  writeFileSync(join(root, `sdk-query-${++queryCount}.json`), JSON.stringify({
    resume: input.options.resume, systemPrompt: input.options.systemPrompt,
    allowedTools: input.options.allowedTools, mcpServers: Object.keys(input.options.mcpServers ?? {}),
    ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
  }, null, 2))
  const actual = originalQuery(input)
  if (!firstQuery) return actual
  firstQuery = false
  started.resolve()
  return new Proxy(actual, { get(target, property) {
    if (property === Symbol.asyncIterator) return async function* () { await queued.promise; yield* actual }
    const value = Reflect.get(target, property, target)
    return typeof value === "function" ? value.bind(target) : value
  } })
})
const { startProxyServer } = await import("../src/proxy/server.ts")
const { processSessionTurns } = await import("../src/proxy/session/turnCoordinator.ts")
const { telemetryStore } = await import("../src/telemetry/index.ts")
const proxy = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const address = proxy.server.address()
assert(address && typeof address === "object")
let arrivals = 0
const acquire = processSessionTurns.acquire.bind(processSessionTurns)
const arrivalSpy = spyOn(processSessionTurns, "acquire").mockImplementation((key, signal) => {
  const pending = acquire(key, signal)
  if (++arrivals === 2) queued.resolve()
  return pending
})
const requests = []
const firstPair = []
let session
const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, async fetch(request) {
  const path = new URL(request.url).pathname
  if (request.method !== "POST" || path !== "/v1/messages") {
    return fetch(`http://127.0.0.1:${address.port}${path}`, { method: request.method, headers: request.headers })
  }
  const raw = await request.text()
  const body = JSON.parse(raw)
  const kind = JSON.stringify(body.system).includes("<title>") ? "title" : "main"
  const row = { kind, model: body.model, stream: body.stream, session: body.metadata?.user_id,
    messages: body.messages.length, tools: body.tools?.map(tool => tool.name) ?? [] }
  requests.push(row)
  writeFileSync(join(root, `client-request-${requests.length}-${kind}.json`), JSON.stringify(body, null, 2))
  console.log(JSON.stringify({ request: row }))
  const forward = async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST", headers: request.headers, body: raw, signal: AbortSignal.timeout(120_000),
    })
    const output = await response.text()
    if (kind === "title") console.log(JSON.stringify({ titleWireResponse: output }))
    row.status = response.status
    row.hasStreamError = /"type"\s*:\s*"error"/.test(output)
    console.log(JSON.stringify({ response: row, ...(response.status !== 200 ? { error: output } : {}) }))
    return new Response(output, { status: response.status, headers: response.headers })
  }
  if (firstPair.length >= 2) return forward()
  const done = deferred()
  firstPair.push({ kind, forward, done })
  if (firstPair.length === 2) {
    assert.deepEqual(firstPair.map(item => item.kind).sort(), ["main", "title"])
    assert.equal(requests[0].session, requests[1].session, "Actual client must use the same session identity")
    const first = firstPair.find(item => item.kind === firstKind)
    const second = firstPair.find(item => item.kind !== firstKind)
    void first.forward().then(first.done.resolve)
    await started.promise
    void second.forward().then(second.done.resolve)
  }
  return done.promise
} })
const modelId = "claude-haiku-4-5-20251001"
writeFileSync(join(agentDir, "models.yml"), `providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:${relay.port}\n    apiKey: x\n    headers:\n      x-meridian-agent: pi\n`)
const marker = `record_${randomUUID()}`
writeFileSync(join(root, "fixture.json"), JSON.stringify({ record: marker }))
const timeout = setTimeout(() => { console.error(JSON.stringify({ timeout: true, root, requests })); process.exit(1) }, 180_000)
try {
  const { createAgentSession } = await import(pathToFileURL(join(packageDir, "src/sdk.ts")).href)
  const { Settings } = await import(pathToFileURL(join(packageDir, "src/config/settings.ts")).href)
  const settings = await Settings.init({ cwd: root, agentDir, overrides: {
    "providers.tinyModel": "online", modelRoles: { default: `anthropic/${modelId}`, smol: `anthropic/${modelId}`, tiny: `anthropic/${modelId}` },
  } })
  const created = await createAgentSession({ cwd: root, agentDir, settings, modelPattern: `anthropic/${modelId}`,
    systemPrompt: "You copy JavaScript test fixtures accurately. Follow the user's read and write instructions.",
    disableExtensionDiscovery: true, skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
    enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
    toolNames: ["read", "write"], restrictToolNames: true,
  })
  session = created.session
  const prompt = "Read fixture.json, then write copied.json with the same record field and value. Do not invent the value. Finally say FIXTURE_COPIED."
  const [title] = await Promise.all([session.generateTitle(prompt), session.prompt(prompt)])
  assert(firstPair.length === 2, "Main and title must both reach Meridian")
  assert(requests.every(row => row.status === 200 && !row.hasStreamError), JSON.stringify(requests))
  assert(title && title.length > 0, "Oh My Pi must parse the title response")
  assert.deepEqual(JSON.parse(readFileSync(join(root, "copied.json"), "utf8")), { record: marker })
  assert(requests.filter(row => row.kind === "main").length >= 3, "Must complete the actual read/write tool loop")
  assert.equal(telemetryStore.getRecent().filter(row => row.error === "session_turn_conflict").length, 0)
  console.log(JSON.stringify({ valid: true, firstKind, root, title, requests: requests.length,
    ompVersion: JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version }))
} finally {
  clearTimeout(timeout)
  queued.resolve()
  if (session) await session.dispose()
  relay.stop(true)
  arrivalSpy.mockRestore()
  querySpy.mockRestore()
  await proxy.close()
}
