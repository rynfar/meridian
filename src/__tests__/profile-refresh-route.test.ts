/**
 * POST /profiles/:id/refresh: the card's Refresh re-checks a profile's login
 * and re-reads its usage, says per part what happened, and gives each part
 * its own budget.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { FetchOAuthUsageOpts, OAuthUsageSnapshot } from "../proxy/oauthUsage"
import type { ClaudeAuthStatus } from "../proxy/models"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { installModelsMock } from "./modelsMock"

installSdkMock(() => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "profile-refresh-route.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

let authAnswer: ClaudeAuthStatus = { loggedIn: true, email: "a@example.com", subscriptionType: "max" }
let rechecks: Array<string | undefined> = []
installModelsMock(() => ({
  getClaudeAuthStatusAsync: async () => authAnswer,
  recheckClaudeAuthStatus: async (profileId?: string) => { rechecks.push(profileId); return authAnswer },
}))

const { __setFetchOAuthUsageOverride, resetOAuthUsageCache } = await import("../proxy/oauthUsage")
const { createProxyServer } = await import("../proxy/server")
const { rateLimitStore } = await import("../proxy/rateLimitStore")
const { resetActiveProfile } = await import("../proxy/profiles")

let usageCalls: FetchOAuthUsageOpts[] = []

function snapshot(): OAuthUsageSnapshot {
  return { windows: [{ type: "five_hour", utilization: 0.1, resetsAt: null }], extraUsage: null, bankedResets: null, fetchedAt: Date.now() }
}

function app() {
  return createProxyServer({
    port: 0,
    host: "127.0.0.1",
    profiles: [
      { id: "work", claudeConfigDir: "/tmp/meridian-refresh-all-work" },
      { id: "token", type: "oauth-token", oauthToken: "token-x" },
      { id: "keyed", type: "api", apiKey: "sk-test" },
    ],
    defaultProfile: "work",
  }).app
}

type Part = { state: string; note: string; retryAfterMs?: number }
type Body = { profile: string; parts: Partial<Record<"login" | "usage", Part>> }

function post(target: ReturnType<typeof app>, path: string, origin?: string) {
  return target.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: origin ? { origin } : {} }))
}

async function refresh(target: ReturnType<typeof app>, id: string): Promise<Body> {
  const res = await post(target, `/profiles/${id}/refresh`)
  expect(res.status).toBe(200)
  return await res.json() as Body
}

beforeEach(() => {
  authAnswer = { loggedIn: true, email: "a@example.com", subscriptionType: "max" }
  rechecks = []
  usageCalls = []
  rateLimitStore.clear()
  resetActiveProfile()
  resetOAuthUsageCache()
  __setFetchOAuthUsageOverride(async opts => {
    usageCalls.push(opts ?? {})
    return snapshot()
  })
})

afterEach(() => {
  __setFetchOAuthUsageOverride(null)
  resetOAuthUsageCache()
  rateLimitStore.clear()
})

describe("POST /profiles/:id/refresh", () => {
  it("re-checks the login and re-reads usage", async () => {
    const body = await refresh(app(), "work")

    expect(body.profile).toBe("work")
    expect(body.parts.login).toMatchObject({ state: "fresh" })
    expect(body.parts.login!.note).toContain("a@example.com")
    expect(body.parts.usage).toMatchObject({ state: "fresh" })
    expect(Object.keys(body.parts).sort()).toEqual(["login", "usage"])
    expect(rechecks).toEqual(["work"])
    expect(usageCalls).toHaveLength(1)
    expect(usageCalls[0]).toMatchObject({ profileId: "work", claudeConfigDir: "/tmp/meridian-refresh-all-work", force: true })
  })

  it("re-checks a fixed-token profile's login and has no usage to read for it", async () => {
    const body = await refresh(app(), "token")

    expect(body.parts.login?.state).toBe("fresh")
    expect(body.parts.usage?.state).toBe("unavailable")
    expect(rechecks).toEqual(["token"])
    expect(usageCalls).toHaveLength(0)
  })

  it("gives each part its own budget, the usage part sharing its slot with /usage/refresh", async () => {
    const target = app()
    expect((await post(target, "/profiles/work/usage/refresh")).status).toBe(200)

    const first = await refresh(target, "work")
    expect(first.parts.usage?.state).toBe("rate_limited")
    expect(first.parts.usage?.retryAfterMs).toBeGreaterThan(0)
    expect(first.parts.login?.state).toBe("fresh")

    const second = await refresh(target, "work")
    expect(second.parts.login?.state).toBe("rate_limited")
    expect(usageCalls).toHaveLength(1)
    expect(rechecks).toHaveLength(1)
  })

  it("skips usage when the login is gone", async () => {
    authAnswer = { loggedIn: false }

    const body = await refresh(app(), "work")

    expect(body.parts.login?.state).toBe("failed")
    expect(body.parts.usage?.state).toBe("skipped")
    expect(usageCalls).toHaveLength(0)
  })

  it("has no login or usage to re-read for an API-key profile", async () => {
    const body = await refresh(app(), "keyed")

    expect(body.parts.login?.state).toBe("unavailable")
    expect(body.parts.usage?.state).toBe("unavailable")
    expect(rechecks).toHaveLength(0)
    expect(usageCalls).toHaveLength(0)
  })

  it("refuses an unknown profile and another site", async () => {
    const target = app()
    expect((await post(target, "/profiles/nobody/refresh")).status).toBe(404)
    expect((await post(target, "/profiles/work/refresh", "https://evil.example")).status).toBe(403)
    expect(rechecks).toHaveLength(0)
  })
})
