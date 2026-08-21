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

mock.module("../proxy/models", () => ({
  ...realModels,
  getClaudeAuthStatusAsync: async () => ({
    loggedIn: true,
    email: "test@example.com",
    subscriptionType: "max",
  }),
  resolveClaudeExecutableAsync: async () => "claude",
}))

const { createProxyServer } = await import("../proxy/server")
const { startUpdateCheck, stopUpdateCheck } = await import("../proxy/updateCheck")

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
  stopUpdateCheck()
})

describe("/health build provenance", () => {
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

  it("surfaces launcher stamps so a dev build is visible, not disguised", async () => {
    process.env.MERIDIAN_BUILD_SOURCE = "dev"
    process.env.MERIDIAN_BUILD_SHA = "abc1234def"
    process.env.MERIDIAN_BUILD_BRANCH = "feat/experiment"
    process.env.MERIDIAN_BUILD_DIRTY = "1"

    const build = (await health()).body.build as HealthBuild
    expect(build.source).toBe("dev")
    expect(build.sha).toBe("abc1234def")
    expect(build.branch).toBe("feat/experiment")
    expect(build.dirty).toBe(true)
    // The headline version is unchanged — that is exactly the trap `build` exists
    // to expose, so it must still be reported alongside, not corrected.
    expect(build.version).toBe("1.62.7")
  })

  it("reports an available update once the check resolves", async () => {
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
      resolveClaudeExecutableAsync: async () => "claude",
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
