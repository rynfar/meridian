#!/usr/bin/env bun
/** Real SDK/HTTP requests with a competing process sweeping the publication gap. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { spyOn } from "bun:test"
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk"

const stream = process.argv.includes("--stream")
const model = process.env.E2E_MODEL ?? "claude-haiku-4-5-20251001"
// An older checkout can supply the collector to verify rolling-upgrade safety.
const collectorModule = process.env.E2E_COLLECTOR_MODULE
  ? pathToFileURL(process.env.E2E_COLLECTOR_MODULE).href
  : new URL("../src/proxy/sessionLifecycle.ts", import.meta.url).href
const root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-publication-e2e-")))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_PASSTHROUGH: "1",
})
const lifecycle = await import("../src/proxy/sessionLifecycle.ts")
const { readSessionStoreSnapshot } = await import("../src/proxy/sessionStore.ts")
const options = { storeDir: process.env.MERIDIAN_SESSION_DIR, preparedGraceMs: 0, retiredGraceMs: 0 }
const release = lifecycle.releaseActiveTranscriptLease
const sweeps = []
const releaseSpy = spyOn(lifecycle, "releaseActiveTranscriptLease").mockImplementation(async (lease, settings) => {
  await release(lease, settings)
  const sidecar = JSON.parse(readFileSync(join(options.storeDir, "session-gc.json"), "utf8"))
  const activePins = lease.resourceKeys.map(key => {
    const resource = sidecar.resources[key]
    assert(resource, "active request resource disappeared")
    return { ...resource.locator, lifecycleGeneration: resource.generation }
  })
  // Match a sweep by the owning proxy, then a collector which only sees
  // durable session mappings. Keep the HTTP request paused across both.
  await lifecycle.reconcile(activePins, options)
  const storeModule = new URL("../src/proxy/sessionStore.ts", import.meta.url).href
  const child = Bun.spawn([process.execPath, "--eval", `
    const { runGc } = await import(${JSON.stringify(collectorModule)});
    const { readSessionStoreSnapshot } = await import(${JSON.stringify(storeModule)});
    const pins = () => Object.values(readSessionStoreSnapshot()).flatMap(session => [
      session.currentTranscript?.sessionId === session.claudeSessionId ? session.currentTranscript : undefined,
      session.previousTranscript?.sessionId === session.previousClaudeSessionId ? session.previousTranscript : undefined,
    ].filter(Boolean));
    console.log(JSON.stringify(await runGc([], { ...${JSON.stringify(options)}, pinProvider: pins })));
  `], { stdout: "pipe", stderr: "pipe", env: { ...process.env } })
  const [output, errors, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  assert.equal(status, 0, errors)
  const result = JSON.parse(output)
  sweeps.push(result)
  console.log(JSON.stringify({ competingCollector: result, stream }))
})
const { startProxyServer } = await import("../src/proxy/server.ts")
const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
const address = instance.server.address()
assert(address && typeof address === "object")

async function request(key, messages) {
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session": key },
    body: JSON.stringify({ model, max_tokens: 128, stream, messages }), signal: AbortSignal.timeout(90_000),
  })
  const raw = await response.text()
  assert.equal(response.status, 200, raw)
  if (!stream) return JSON.parse(raw).content.filter(block => block.type === "text").map(block => block.text).join("")
  const events = raw.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
  assert(!events.some(event => event.type === "error"), raw)
  assert.equal(events.filter(event => event.type === "message_stop").length, 1, raw)
  return events.filter(event => event.delta?.type === "text_delta").map(event => event.delta.text).join("")
}

try {
  await Promise.all([0, 1].map(async index => {
    const key = `publication-${randomUUID()}`
    const marker = `fixture_${randomUUID()}`
    const messages = [{ role: "user", content: `In a JavaScript example, define const fixtureId with the string value "${marker}". Respond with one code line; no file changes are needed.` }]
    const first = await request(key, messages)
    assert(first.includes(marker), first)
    const source = readSessionStoreSnapshot()[key]
    assert(source?.claudeSessionId, "fresh request failed to publish its mapping")
    const sourceRows = await getSessionMessages(source.claudeSessionId, { dir: root })
    assert(JSON.stringify(sourceRows).includes(marker), "fresh SDK transcript lost the token")
    const second = await request(key, [...messages, { role: "assistant", content: first },
      { role: "user", content: "Write a JavaScript expect(fixtureId).toBe(...) assertion using the exact fixture identifier from my first message. Respond with one code line." }])
    assert(second.includes(marker), second)
    const current = readSessionStoreSnapshot()[key]
    assert(current?.claudeSessionId, "follow-up failed to publish its mapping")
    assert(JSON.stringify(await getSessionMessages(current.claudeSessionId, { dir: root })).includes(marker))
    assert.deepEqual(await getSessionMessages(source.claudeSessionId, { dir: root }), sourceRows,
      "the previously published source must remain unchanged")
    console.log(JSON.stringify({ conversation: index, stream, markerPreserved: true, sourceUnchanged: true }))
  }))
  assert.equal(sweeps.length, 4, "must exercise the publication gap on every request")
  assert(sweeps.every(result => result.deleted === 0 && result.notFound === 0 && result.failed === 0), JSON.stringify(sweeps))
  console.log(`PASS: concurrent fresh and resumed requests survive cross-process publication sweeps (stream=${stream})`)
} finally {
  releaseSpy.mockRestore()
  await instance.close()
}
