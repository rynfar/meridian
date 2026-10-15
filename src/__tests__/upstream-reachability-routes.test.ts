/**
 * /readyz, /health and the override route, driven by real requests through
 * the mocked SDK.
 *
 * The incident behind this: a host's resolver died while its network stayed
 * up. Every request failed with "API Error: Can't reach the API server", yet
 * /readyz stayed green, so the load balancer in front kept sending this host
 * its share of the traffic instead of failing over.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { assistantMessage, messageStart, withMockSdkSessionId } from "./helpers"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as realModels from "../proxy/models"

const ownedDir = mkdtempSync(join(tmpdir(), "meridian-reachability-http-"))
chmodSync(ownedDir, 0o700)
const savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
const savedApiKey = process.env.MERIDIAN_API_KEY
process.env.MERIDIAN_CONFIG_DIR = ownedDir
delete process.env.MERIDIAN_API_KEY
let authLookup: () => Promise<realModels.ClaudeAuthStatus | null> = async () => null
let executableAvailable = true
mock.module("../proxy/models", () => ({
  ...realModels,
  getClaudeAuthStatusAsync: () => authLookup(),
  getResolvedClaudeExecutableInfo: () => null,
  resolveClaudeExecutableAsync: async () => {
    if (!executableAvailable) throw new Error("owned missing executable control")
    return "owned-not-executed-cli-fixture"
  },
}))
afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.MERIDIAN_CONFIG_DIR
  else process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
  if (savedApiKey === undefined) delete process.env.MERIDIAN_API_KEY
  else process.env.MERIDIAN_API_KEY = savedApiKey
  rmSync(ownedDir, { recursive: true, force: true })
})


type Behaviour = "dns-dead" | "rate-limited" | "api-error" | "ok"
let behaviourByDir: Record<string, Behaviour> = {}

const CANT_REACH = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"
const API_400 = "API Error: 400 messages.1.content: text content blocks must be non-empty"

installSdkMock(() => ({
  query: (params: { options?: { env?: Record<string, string> } }) => {
    const dir = params.options?.env?.CLAUDE_CONFIG_DIR ?? ""
    const behaviour = Object.entries(behaviourByDir).find(([fragment]) => dir.includes(fragment))?.[1] ?? "ok"
    return (async function* () {
      if (behaviour === "dns-dead") {
        yield withMockSdkSessionId({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: "unknown" }, params.options)
        const terminal = assistantMessage([{ type: "text", text: CANT_REACH }])
        yield withMockSdkSessionId({ ...terminal, error: "unknown", message: { ...terminal.message, model: "<synthetic>" } }, params.options)
        throw new Error(`Claude Code returned an error result: ${CANT_REACH}`)
      }
      if (behaviour === "rate-limited") {
        yield withMockSdkSessionId({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 2, retry_delay_ms: 1, error_status: 429, error: "rate_limit" }, params.options)
        const refusal = assistantMessage([{ type: "text", text: "You've hit your limit · resets 3pm" }])
        yield withMockSdkSessionId({ ...refusal, error: "rate_limit", message: { ...refusal.message, model: "<synthetic>" } }, params.options)
        throw new Error("Claude Code returned an error result: You've hit your limit · resets 3pm")
      }
      if (behaviour === "api-error") {
        yield withMockSdkSessionId({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 2, retry_delay_ms: 1, error_status: 400, error: "invalid_request" }, params.options)
        const refusal = assistantMessage([{ type: "text", text: API_400 }])
        yield withMockSdkSessionId({ ...refusal, error: "invalid_request", message: { ...refusal.message, model: "<synthetic>" } }, params.options)
        throw new Error(`Claude Code returned an error result: ${API_400}`)
      }
      const answer = assistantMessage([{ type: "text", text: "ok" }])
      yield withMockSdkSessionId(messageStart(answer.message.id), params.options)
      yield withMockSdkSessionId(answer, params.options)
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetProcessSdkSemaphoreForTests } = await import("../proxy/concurrency")
const { resetActiveProfile } = await import("../proxy/profiles")

const PROFILES = [
  { id: "down", claudeConfigDir: join(ownedDir, "meridian-reach-down") },
  { id: "up", claudeConfigDir: join(ownedDir, "meridian-reach-up") },
]
const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } }
const T0 = Date.parse("2026-10-01T21:00:00.000Z")
const SECOND = 1000
const MINUTE = 60 * SECOND

let now = T0
let clock: { mockRestore(): void } | undefined

function server() {
  return createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles: PROFILES, defaultProfile: "down" }).app
}

type App = ReturnType<typeof server>

async function send(app: App, profile: string): Promise<number> {
  const res = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-meridian-profile": profile },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 64, stream: false, messages: [{ role: "user", content: `hello ${now}` }] }),
  }))
  await res.text()
  return res.status
}

async function readyz(app: App): Promise<{ status: number; body: string }> {
  const res = await app.fetch(new Request("http://localhost/readyz"))
  return { status: res.status, body: await res.text() }
}

async function upstream(app: App): Promise<Record<string, unknown>> {
  const res = await app.fetch(new Request("http://localhost/health"))
  const body = await res.json() as { upstream: { claude: Record<string, unknown> } }
  return body.upstream.claude
}

function override(app: App, body: unknown, env: unknown = LOOPBACK, headers: Record<string, string> = {}) {
  return app.fetch(new Request("http://localhost/upstream-reachability", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), env as never)
}

describe("upstream reachability through real requests", () => {
  beforeEach(async () => {
    resetProcessSdkSemaphoreForTests()
    await clearSessionCache()
    resetActiveProfile()
    now = T0
    behaviourByDir = { "meridian-reach-down": "dns-dead" }
    clock = spyOn(Date, "now").mockImplementation(() => now)
    authLookup = async () => null
    executableAvailable = true
  })

  afterEach(() => {
    resetProcessSdkSemaphoreForTests()
    clock?.mockRestore()
    clock = undefined
  })

  it("keeps native evidence and forced state local to each embedded instance", async () => {
    const first = server(), second = server()
    await override(first, { state: "unreachable" })
    expect((await readyz(first)).status).toBe(503)
    expect((await readyz(second)).status).toBe(200)
    expect((await upstream(second)).override).toBeNull()
    await override(first, { state: null })
    for (let i = 0; i < 3; i++) {
      await send(first, "down")
      now += MINUTE
    }
    expect((await readyz(first)).status).toBe(503)
    expect(await send(second, "up")).toBe(200)
    expect((await readyz(first)).status).toBe(503)
    expect(await upstream(second)).toMatchObject({ state: "ok", consecutiveFailures: 0 })
    expect((await upstream(first)).lastReachedAt).toBeNull()
  })

  it("rereads owned persisted settings and environment aliases in the same embedded instance", async () => {
    const names = ["AFTER_MS", "HOLD_MS", "MIN_FAILURES"].flatMap(suffix => ["MERIDIAN_UPSTREAM_UNREACHABLE_" + suffix, "CLAUDE_PROXY_UPSTREAM_UNREACHABLE_" + suffix])
    const saved = new Map(names.map(name => [name, process.env[name]]))
    const settingsPath = join(ownedDir, "settings.json")
    try {
      for (const name of names) delete process.env[name]
      writeFileSync(settingsPath, JSON.stringify({ upstreamUnreachableAfterMs: 0, upstreamUnreachableHoldMs: 600_000, upstreamUnreachableMinFailures: 1 }), { mode: 0o600 })
      const app = server()
      await send(app, "down")
      expect((await readyz(app)).status).toBe(503)
      expect(await upstream(app)).toMatchObject({ state: "unreachable", consecutiveFailures: 1 })
      writeFileSync(settingsPath, JSON.stringify({ upstreamUnreachableHoldMs: 0 }), { mode: 0o600 })
      expect((await readyz(app)).status).toBe(200)
      expect((await upstream(app)).state).toBe("probing")
      process.env.CLAUDE_PROXY_UPSTREAM_UNREACHABLE_HOLD_MS = "600000"
      expect((await readyz(app)).status).toBe(503)
      process.env.MERIDIAN_UPSTREAM_UNREACHABLE_HOLD_MS = "0"
      expect((await readyz(app)).status).toBe(200)
      delete process.env.MERIDIAN_UPSTREAM_UNREACHABLE_HOLD_MS
      expect((await readyz(app)).status).toBe(503)
    } finally {
      rmSync(settingsPath, { force: true })
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it("assembles health observations after asynchronous auth settles", async () => {
    const app = server()
    let release: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => { release = resolve })
    let entered: (() => void) | undefined
    const started = new Promise<void>((resolve) => { entered = resolve })
    authLookup = async () => { entered?.(); await barrier; return null }
    const response = app.fetch(new Request("http://localhost/health"))
    await started
    await override(app, { state: "unreachable", ttlMs: MINUTE })
    now += SECOND
    release?.()
    const health = await (await response).json() as { upstream: { claude: Record<string, unknown> } }
    expect(health.upstream.claude.state).toBe("unreachable")
    expect(health.upstream.claude.since).toBe(new Date(T0).toISOString())
  })

  it("fails readiness once only connection failures span the window, probes after the hold, and fails again at once", async () => {
    const app = server()

    expect(await send(app, "down")).toBeGreaterThanOrEqual(500)
    expect((await readyz(app)).status).toBe(200)
    now += MINUTE
    await send(app, "down")
    expect((await readyz(app)).status).toBe(200)
    now += MINUTE + SECOND
    await send(app, "down")

    const failed = await readyz(app)
    expect(failed.status).toBe(503)
    expect(failed.body).toBe(
      "[-]upstream-claude failed: This instance's configured Claude egress failed since 2026-10-01T21:00:00.000Z (last error: dns, 3 connection failures, last answered never)\nreadyz check failed\n",
    )
    expect(await upstream(app)).toEqual({
      state: "unreachable",
      since: "2026-10-01T21:02:01.000Z",
      failingSince: "2026-10-01T21:00:00.000Z",
      consecutiveFailures: 3,
      lastReachedAt: null,
      lastFailureAt: "2026-10-01T21:02:01.000Z",
      lastErrorKind: "dns",
      holdUntil: "2026-10-01T21:07:01.000Z",
      override: null,
    })
    // Liveness never depends on the upstream.
    expect((await app.fetch(new Request("http://localhost/livez"))).status).toBe(200)

    now += 5 * MINUTE
    expect((await readyz(app)).status).toBe(200)
    expect((await upstream(app)).state).toBe("probing")

    // A request let in by the probe fails the same way: straight back to 503.
    await send(app, "down")
    expect((await readyz(app)).status).toBe(503)

    // A captured native configured-egress answer permits traffic here again.
    expect(await send(app, "up")).toBe(200)
    expect((await readyz(app)).status).toBe(200)
    expect(await upstream(app)).toMatchObject({ state: "ok", consecutiveFailures: 0, failingSince: null, lastReachedAt: new Date(now).toISOString() })
  })

  it("stays ready while any account still gets answers, however often another fails to connect", async () => {
    const app = server()
    for (let minute = 0; minute < 5; minute++) {
      await send(app, "down")
      now += 20 * SECOND
      await send(app, "down")
      expect((await readyz(app)).status).toBe(200)
      now += 20 * SECOND
      expect(await send(app, "up")).toBe(200)
      expect((await readyz(app)).status).toBe(200)
      now += 20 * SECOND
    }
    expect((await upstream(app)).state).toBe("ok")
  })

  it("stays ready while not only connection failures come back, even when every answer is an API error", async () => {
    behaviourByDir = { "meridian-reach-down": "dns-dead", "meridian-reach-up": "api-error" }
    const app = server()
    for (let minute = 0; minute < 5; minute++) {
      await send(app, "down")
      now += 20 * SECOND
      await send(app, "down")
      now += 20 * SECOND
      expect(await send(app, "up")).toBeGreaterThanOrEqual(400)
      expect((await readyz(app)).status).toBe(200)
      now += 20 * SECOND
    }
    expect(await upstream(app)).toMatchObject({ state: "ok", lastErrorKind: "dns" })
  })

  it("does not read rate limits as unreachability: a native refusal observes configured egress", async () => {
    behaviourByDir = { "meridian-reach-down": "rate-limited" }
    const app = server()
    for (let i = 0; i < 5; i++) {
      expect(await send(app, "down")).toBe(429)
      now += MINUTE
    }
    expect((await readyz(app)).status).toBe(200)
    expect(await upstream(app)).toMatchObject({ state: "ok", consecutiveFailures: 0, lastReachedAt: new Date(now - MINUTE).toISOString() })
  })
})

describe("PUT /upstream-reachability", () => {
  beforeEach(() => {
    resetProcessSdkSemaphoreForTests()
    now = T0
    clock = spyOn(Date, "now").mockImplementation(() => now)
    authLookup = async () => null
    executableAvailable = true
  })

  afterEach(() => {
    clock?.mockRestore()
    clock = undefined
    delete process.env.MERIDIAN_API_KEY
  })

  it("forces readiness to fail for its TTL, and clears on request", async () => {
    const app = server()
    const forced = await override(app, { state: "unreachable", ttlMs: MINUTE })
    expect(forced.status).toBe(200)
    expect(await forced.json()).toMatchObject({
      upstream: { claude: { state: "unreachable", override: { state: "unreachable", until: "2026-10-01T21:01:00.000Z" } } },
    })
    const failed = await readyz(app)
    expect(failed.status).toBe(503)
    expect(failed.body).toContain("[-]upstream-claude failed: This instance's configured Claude egress forced unreachable by override until 2026-10-01T21:01:00.000Z")

    now += MINUTE
    expect((await readyz(app)).status).toBe(200)

    await override(app, { state: "unreachable" })
    expect((await readyz(app)).status).toBe(503)
    const cleared = await (await override(app, { state: null })).json() as { upstream: { claude: { override: unknown } } }
    expect(cleared.upstream.claude.override).toBeNull()
    expect((await readyz(app)).status).toBe(200)
  })

  it("defaults the TTL to ten minutes", async () => {
    const app = server()
    const body = await (await override(app, { state: "unreachable" })).json() as { upstream: { claude: { override: { until: string } } } }
    expect(body.upstream.claude.override.until).toBe(new Date(T0 + 10 * MINUTE).toISOString())
  })

  it("answers only a loopback peer that did not come through a proxy", async () => {
    const app = server()
    expect((await override(app, { state: "unreachable" }, {})).status).toBe(403)
    expect((await override(app, { state: "unreachable" }, { incoming: { socket: { remoteAddress: "192.168.1.20" } } })).status).toBe(403)
    expect((await override(app, { state: "unreachable" }, LOOPBACK, { "x-forwarded-for": "203.0.113.9" })).status).toBe(403)
    expect((await readyz(app)).status).toBe(200)
  })

  it("requires the API key when one is set", async () => {
    process.env.MERIDIAN_API_KEY = "reachability-test-key"
    const app = server()
    const unauthorized = await override(app, { state: "unreachable" })
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get("cache-control")).toBe("no-store")
    expect((await override(app, { state: "unreachable" }, LOOPBACK, { "x-api-key": "reachability-test-key" })).status).toBe(200)
    // The probe a load balancer polls stays unauthenticated.
    expect((await readyz(app)).status).toBe(503)
  })

  it("applies the existing bounded browser Origin policy without trusting forwarding", async () => {
    const app = server()
    for (const origin of ["https://foreign.invalid", "null", "not a URL", "http://localhost:81", "http://localhost/", "https://localhost:444"]) {
      const response = await override(app, { state: "unreachable" }, LOOPBACK, { origin })
      expect(response.status).toBe(403)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect((await upstream(app)).override).toBeNull()
    }
    expect((await override(app, { state: "unreachable" }, LOOPBACK, { origin: "http://localhost" })).status).toBe(200)
    await override(app, { state: null })
    const bridged = await app.fetch(new Request("http://localhost:443/upstream-reachability", {
      method: "PUT", headers: { "Content-Type": "application/json", origin: "https://localhost" },
      body: JSON.stringify({ state: "unreachable" }),
    }), LOOPBACK)
    expect(bridged.status).toBe(200)
    await override(app, { state: null })
    expect((await override(app, { state: "unreachable" }, LOOPBACK, { origin: "http://localhost", forwarded: "host=localhost;proto=https" })).status).toBe(403)
  })

  it("retains missing-executable and shutdown health authority under forced ok", async () => {
    executableAvailable = false
    const instance = createProxyServer({ port: 0, silent: true, profiles: PROFILES, defaultProfile: "down" })
    await override(instance.app, { state: "ok" })
    const notReady = await readyz(instance.app)
    expect(notReady.status).toBe(503)
    expect(notReady.body).toContain("claude-executable failed")
    expect(notReady.body).not.toContain("upstream-claude failed")
    instance.beginDrain?.()
    const health = await instance.app.fetch(new Request("http://localhost/health"))
    expect(health.status).toBe(503)
    expect(await health.json()).toMatchObject({ status: "draining", upstream: { claude: { state: "ok" } } })
  })

  it("accepts one millisecond and one day TTLs without changing the natural history", async () => {
    const app = server()
    for (const ttlMs of [1, 86_400_000]) {
      const response = await override(app, { state: "unreachable", ttlMs })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ upstream: { claude: {
        since: new Date(now).toISOString(), consecutiveFailures: 0, lastFailureAt: null,
        override: { state: "unreachable", until: new Date(now + ttlMs).toISOString() },
      } } })
      now += ttlMs
      expect((await upstream(app)).override).toBeNull()
    }
  })

  it("rejects what it does not understand, and changes nothing", async () => {
    const app = server()
    for (const body of [
      { state: "down" },
      { state: "probing" },
      {},
      { state: "unreachable", ttlMs: 0 },
      { state: "unreachable", ttlMs: null },
      { state: "unreachable", ttlMs: false },
      { state: "unreachable", ttlMs: 1.5 },
      { state: "unreachable", ttlMs: Number.MAX_SAFE_INTEGER + 1 },
      { state: "unreachable", ttlMs: 86_400_001 },
      { state: "unreachable", ttlMs: "60000" },
      { state: "unreachable", upstream: "antigravity" },
      [],
    ]) {
      expect((await override(app, body)).status).toBe(400)
    }
    expect((await readyz(app)).status).toBe(200)
  })
})
