/**
 * POST /profiles/:id/usage/refresh: "Refresh usage" on a profile card re-reads
 * the profile's usage now, forced past the cache, answers the new figures,
 * clears refusals the reading shows are over, and lets one read per profile
 * through per interval.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { FetchOAuthUsageOpts, OAuthUsageSnapshot } from "../proxy/oauthUsage"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"

installSdkMock(() => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "profile-usage-refresh-route.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { __setFetchOAuthUsageOverride, resetOAuthUsageCache } = await import("../proxy/oauthUsage")
const { createProxyServer } = await import("../proxy/server")
const { rateLimitStore } = await import("../proxy/rateLimitStore")
const { resetActiveProfile } = await import("../proxy/profiles")

let calls: FetchOAuthUsageOpts[] = []

function snapshot(fiveHour: number): OAuthUsageSnapshot {
  return {
    windows: [{ type: "five_hour", utilization: fiveHour, resetsAt: null }, { type: "seven_day", utilization: 1, resetsAt: null }],
    extraUsage: null,
    bankedResets: null,
    fetchedAt: Date.now(),
  }
}

function app() {
  return createProxyServer({
    port: 0,
    host: "127.0.0.1",
    profiles: [
      { id: "work", claudeConfigDir: "/tmp/meridian-refresh-work" },
      { id: "keyed", type: "api", apiKey: "sk-test" },
    ],
    defaultProfile: "work",
  }).app
}

function refresh(target: ReturnType<typeof app>, id: string, origin?: string) {
  return target.fetch(new Request(`http://localhost/profiles/${id}/usage/refresh`, {
    method: "POST",
    headers: origin ? { origin } : {},
  }))
}

beforeEach(() => {
  calls = []
  rateLimitStore.clear()
  resetActiveProfile()
  resetOAuthUsageCache()
  __setFetchOAuthUsageOverride(async opts => {
    calls.push(opts ?? {})
    return snapshot(0.1)
  })
})

afterEach(() => {
  __setFetchOAuthUsageOverride(null)
  resetOAuthUsageCache()
  rateLimitStore.clear()
})

describe("POST /profiles/:id/usage/refresh", () => {
  it("reads past the cache and answers the new figures", async () => {
    const res = await refresh(app(), "work")
    expect(res.status).toBe(200)
    const body = await res.json() as { profile: string; refreshed: boolean; note: string; usage: { windows: Array<{ type: string; utilization: number }> } }
    expect(body).toMatchObject({ profile: "work", refreshed: true })
    expect(body.usage.windows.find(w => w.type === "five_hour")?.utilization).toBe(0.1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ profileId: "work", claudeConfigDir: "/tmp/meridian-refresh-work", force: true })
  })

  it("clears a refusal remembered for a window the reading shows open again, and keeps the others", async () => {
    rateLimitStore.record("work", { status: "rejected", rateLimitType: "five_hour", utilization: 1 })
    rateLimitStore.record("work", { status: "rejected", rateLimitType: "seven_day", utilization: 1 })
    expect((await refresh(app(), "work")).status).toBe(200)
    expect(rateLimitStore.getAll("work").map(e => e.rateLimitType)).toEqual(["seven_day"])
  })

  it("lets one read per profile through per interval", async () => {
    const target = app()
    expect((await refresh(target, "work")).status).toBe(200)
    const again = await refresh(target, "work")
    expect(again.status).toBe(429)
    expect(again.headers.get("retry-after")).not.toBeNull()
    expect(await again.json()).toMatchObject({ code: "refresh_too_soon" })
    expect(calls).toHaveLength(1)
  })

  it("refuses an unknown profile, an API-key profile and another site", async () => {
    const target = app()
    expect((await refresh(target, "nobody")).status).toBe(404)
    expect((await refresh(target, "keyed")).status).toBe(400)
    expect((await refresh(target, "work", "https://evil.example")).status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it("says the reading did not land when the provider gave none", async () => {
    __setFetchOAuthUsageOverride(async () => null)
    const body = await (await refresh(app(), "work")).json() as { refreshed: boolean; note: string }
    expect(body.refreshed).toBe(false)
    expect(body.note.length).toBeGreaterThan(0)
  })
})
