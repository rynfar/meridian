/**
 * /health reports build provenance.
 *
 * The version string alone cannot distinguish a published release from a
 * feature branch built off the same commit, so `build` is what a monitor, the
 * site header, and a downstream plugin actually read to answer "is this
 * instance running what I think it is, and is it current?".
 *
 * Isolated in its own `bun test` invocation (see the `test` script): this file
 * stubs auth as logged-in, and `mock.module` is process-global in bun, so
 * leaking that into files asserting unauthenticated behaviour would be a
 * cross-file failure with no obvious cause.
 */
import { describe, expect, it, mock, afterEach } from "bun:test"

// Spread the real module and override only the auth lookup — replacing
// ../proxy/models wholesale would drop the dozen other exports server.ts
// imports from it, and each missing one is an undefined-is-not-a-function
// crash somewhere unrelated.
import * as realModels from "../proxy/models"

let resolveExecutable = () => Promise.resolve("claude")

const authCalls: Array<{ profileId?: string; envOverrides?: Record<string, string> }> = []

mock.module("../proxy/models", () => ({
  ...realModels,
  getClaudeAuthStatusAsync: async (profileId?: string, envOverrides?: Record<string, string>) => {
    authCalls.push({ profileId, envOverrides })
    return {
      loggedIn: true,
      email: "test@example.com",
      subscriptionType: profileId === "pro" ? "pro" : "max",
    }
  },
  resolveClaudeExecutableAsync: () => resolveExecutable(),
}))

const { createProxyServer } = await import("../proxy/server")
const { startUpdateCheck, stopUpdateCheck } = await import("../proxy/updateCheck")
const { setSetting } = await import("../settings")

interface HealthBuild {
  source?: string
  version?: string
  sha?: string
  branch?: string
  dirty?: boolean
  latest?: string
  updateAvailable?: boolean
}

async function health(): Promise<{ status: number; body: Record<string, unknown> }> {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", version: "1.62.7" })
  const response = await app.fetch(new Request("http://localhost/health"))
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const STAMPS = [
  "MERIDIAN_BUILD_SOURCE",
  "MERIDIAN_BUILD_SHA",
  "MERIDIAN_BUILD_BRANCH",
  "MERIDIAN_BUILD_DIRTY",
] as const

afterEach(() => {
  for (const key of STAMPS) delete process.env[key]
  authCalls.length = 0
  resolveExecutable = () => Promise.resolve("claude")
  stopUpdateCheck()
  setSetting("checkForUpdates", undefined)
})

describe("cold executable readiness", () => {
  it("leaves liveness responsive while asynchronous executable resolution is pending", async () => {
    realModels.resetCachedClaudePath()
    let release: (value: string) => void = () => { throw new Error("Resolution gate not installed") }
    const pending = new Promise<string>(resolve => { release = resolve })
    let entered = false
    resolveExecutable = () => { entered = true; return pending }
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1",
      profiles: [{ id: "ready-fixture", type: "api", apiKey: "owned-dummy-key" }], defaultProfile: "ready-fixture" })
    let settled = false
    const ready = Promise.resolve(app.fetch(new Request("http://localhost/readyz"))).then(response => {
      settled = true
      return response
    })
    try {
      const live = await app.fetch(new Request("http://localhost/livez"))
      expect(live.status).toBe(200)
      expect(await live.text()).toBe("ok\n")
      expect(entered).toBe(true)
      expect(settled).toBe(false)
    } finally {
      release("owned-claude")
      await ready
    }
    expect((await ready).status).toBe(200)
  })

  it("retains the unready response when cold executable resolution fails", async () => {
    realModels.resetCachedClaudePath()
    resolveExecutable = () => Promise.reject(new Error("No usable local executable"))
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1",
      profiles: [{ id: "ready-fixture", type: "api", apiKey: "owned-dummy-key" }], defaultProfile: "ready-fixture" })
    const response = await app.fetch(new Request("http://localhost/readyz?verbose"))
    expect(response.status).toBe(503)
    expect(await response.text()).toContain("[-]claude-executable failed")
  })
})

describe("/v1/models profile auth context", () => {
  it("uses the legacy auth context when no profiles are configured", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })

    const response = await app.fetch(new Request("http://localhost/v1/models"))

    expect(response.status).toBe(200)
    expect(authCalls).toEqual([{ profileId: undefined, envOverrides: undefined }])
  })

  it("advertises 1M Opus and Fable context from the configured Max profile", async () => {
    const { app } = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      profiles: [{ id: "work", type: "claude-max", claudeConfigDir: "/profiles/work" }],
      defaultProfile: "work",
    })

    const response = await app.fetch(new Request("http://localhost/v1/models"))
    const body = await response.json() as { data: Array<{ id: string; context_window: number }> }
    const models = new Map(body.data.map((model) => [model.id, model]))

    expect(response.status).toBe(200)
    expect(authCalls).toEqual([{
      profileId: "work",
      envOverrides: { CLAUDE_CONFIG_DIR: "/profiles/work" },
    }])
    expect(models.get("claude-opus-4-6")?.context_window).toBe(1_000_000)
    expect(models.get("claude-fable-5-1")?.context_window).toBe(1_000_000)
    expect(models.get("claude-fable-5")?.context_window).toBe(1_000_000)
    expect(models.get("claude-sonnet-5-5")?.context_window).toBe(1_000_000)
    expect(models.get("claude-sonnet-4-6")?.context_window).toBe(200_000)
  })

  it("keeps the 200k catalog for a non-Max profile, except native-1M Sonnet", async () => {
    const { app } = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      profiles: [{ id: "pro", type: "claude-max", claudeConfigDir: "/profiles/pro" }],
      defaultProfile: "pro",
    })

    const response = await app.fetch(new Request("http://localhost/v1/models"))
    const body = await response.json() as { data: Array<{ id: string; context_window: number }> }

    expect(response.status).toBe(200)
    expect(authCalls).toEqual([{
      profileId: "pro",
      envOverrides: { CLAUDE_CONFIG_DIR: "/profiles/pro" },
    }])
    // Sonnet 5+ has a native 1M window on every plan (#1212); the rest stay 200k.
    const native1m = new Set(["claude-sonnet-5-5", "claude-sonnet-5"])
    for (const model of body.data) {
      expect(model.context_window).toBe(native1m.has(model.id) ? 1_000_000 : 200_000)
    }
  })
})

describe("/health build provenance", () => {
  it("refreshes local status behind the existing optional API-key gate", async () => {
    const previous = process.env.MERIDIAN_API_KEY
    process.env.MERIDIAN_API_KEY = "test-local-build-key"
    try {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
      expect((await app.fetch(new Request("http://tailnet-proxy/build-status"))).status).toBe(401)
      const response = await app.fetch(new Request("http://tailnet-proxy/build-status", { headers: { "x-api-key": "test-local-build-key" } }))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ runtime: { kind: "source" }, state: "unknown" })
    } finally {
      if (previous === undefined) delete process.env.MERIDIAN_API_KEY
      else process.env.MERIDIAN_API_KEY = previous
    }
  })

  it("reports source and version on a healthy response", async () => {
    const { status, body } = await health()
    expect(status).toBe(200)
    expect(body.status).toBe("healthy")

    const build = body.build as HealthBuild
    expect(build).toBeDefined()
    expect(build.version).toBe("1.62.7")
    // Running from the checkout under test, so not an npm install.
    expect(build.source).toBe("local")
  })

  it("makes no update claim before the registry check has resolved", async () => {
    const build = (await health()).body.build as HealthBuild
    expect(build.latest).toBeUndefined()
    expect(build.updateAvailable).toBeUndefined()
  })

  it("keeps the loaded provenance immutable after launcher environment changes", async () => {
    const before = (await health()).body.build as HealthBuild
    process.env.MERIDIAN_BUILD_SOURCE = "dev"
    process.env.MERIDIAN_BUILD_SHA = "abc1234def"
    process.env.MERIDIAN_BUILD_BRANCH = "feat/experiment"
    process.env.MERIDIAN_BUILD_DIRTY = "1"

    const build = (await health()).body.build as HealthBuild
    expect(build.source).toBe(before.source)
    expect(build.sha).toBe(before.sha)
    expect(build.branch).toBe(before.branch)
    expect(build.dirty).toBe(before.dirty)
    // The headline version is unchanged — that is exactly the trap `build` exists
    // to expose, so it must still be reported alongside, not corrected.
    expect(build.version).toBe("1.62.7")
  })

  it("reports an available update once the check resolves", async () => {
    setSetting("checkForUpdates", true)
    await startUpdateCheck({
      cachePath: `/tmp/meridian-health-build-${process.pid}.json`,
      fetchLatest: async () => "1.99.0",
    })

    const build = (await health()).body.build as HealthBuild
    expect(build.latest).toBe("1.99.0")
    expect(build.updateAvailable).toBe(true)
  })

  it("attaches build to the not-logged-in response too", async () => {
    // Provenance is most useful when something is already wrong; a broken
    // install is exactly when someone asks "what am I even running?".
    mock.module("../proxy/models", () => ({
      ...realModels,
      getClaudeAuthStatusAsync: async () => ({ loggedIn: false }),
      resolveClaudeExecutableAsync: () => resolveExecutable(),
    }))
    const { createProxyServer: create } = await import("../proxy/server")
    const { app } = create({ port: 0, host: "127.0.0.1", version: "1.62.7" })
    const response = await app.fetch(new Request("http://localhost/health"))
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(503)
    expect(body.status).toBe("unhealthy")
    expect((body.build as HealthBuild)?.version).toBe("1.62.7")
  })
})
