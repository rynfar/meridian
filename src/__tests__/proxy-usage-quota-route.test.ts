/**
 * Integration tests for `GET /v1/usage/quota`.
 *
 * Verifies the route exists, returns the expected shape on cold start
 * (no SDK events observed), reflects the rate-limit store after events
 * have been recorded, and filters out the internal "default" bucket.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"

import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
installSdkMock(() => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-usage-quota-route.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

// Use the module-level override (`__setFetchOAuthUsageOverride`) instead of
// `mock.module()`. Bun's mock.module is process-global and would replace the
// real `fetchOAuthUsage` for every parallel test file (including
// oauth-usage.test.ts, where 10 tests would flake with `result === null`).
// The override is bypassed when the caller passes `store` or `fetchImpl`,
// keeping oauth-usage unit tests isolated.
const { __setFetchOAuthUsageOverride, fetchOAuthUsage, resetOAuthUsageCache } = await import("../proxy/oauthUsage")
const { createProxyServer } = await import("../proxy/server")
const { rateLimitStore } = await import("../proxy/rateLimitStore")
const { resetActiveProfile } = await import("../proxy/profiles")

interface QuotaResponseBucket {
  type: string
  status: string
  utilization: number | null
  resetsAt: number | null
  isUsingOverage: boolean
  overageStatus: string | null
  overageResetsAt: number | null
  overageDisabledReason: string | null
  surpassedThreshold: number | null
  observedAt: number
}

interface QuotaResponse {
  buckets: QuotaResponseBucket[]
  asOf: number
}

describe("GET /v1/usage/quota", () => {
  beforeEach(() => {
    rateLimitStore.clear()
    // The quota route resolves its target profile from global active-profile state,
    // which is set by other test files (e.g., profile-switch-integration.test.ts).
    // Resetting here ensures a leftover active profile id does not make these
    // fixtures unreadable.
    resetActiveProfile()
    // Default: no OAuth data merged in. Individual tests override.
    __setFetchOAuthUsageOverride(async () => null)
  })

  afterEach(() => {
    // Clear so the override doesn't leak into other test files in the same
    // bun process (e.g. tests that exercise the real /v1/usage/quota path).
    __setFetchOAuthUsageOverride(null)
  })

  it("returns 200 with empty buckets and a freshness timestamp on cold start", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })

    const before = Date.now()
    const res = await app.fetch(new Request("http://localhost/v1/usage/quota"))
    const after = Date.now()

    expect(res.status).toBe(200)
    const body = await res.json() as QuotaResponse
    expect(body.buckets).toEqual([])
    expect(typeof body.asOf).toBe("number")
    expect(body.asOf).toBeGreaterThanOrEqual(before)
    expect(body.asOf).toBeLessThanOrEqual(after)
  })

  it("reflects entries written to the rate-limit store, newest first", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })

    // Explicit, distinct observedAt values make newest-first ordering
    // deterministic without racing the real wall clock (a short sleep does
    // not guarantee a fresh millisecond timestamp under CI load).
    rateLimitStore.record("default", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.42,
      resetsAt: 1_730_000_000_000,
    }, 1_000)
    rateLimitStore.record("default", {
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.91,
      resetsAt: 1_730_500_000_000,
      surpassedThreshold: 0.9,
    }, 2_000)

    const res = await app.fetch(new Request("http://localhost/v1/usage/quota"))
    expect(res.status).toBe(200)
    const body = await res.json() as QuotaResponse
    expect(body.buckets).toHaveLength(2)

    const types = body.buckets.map(b => b.type)
    expect(types).toEqual(["seven_day", "five_hour"])

    const sevenDay = body.buckets[0]!
    expect(sevenDay.status).toBe("allowed_warning")
    expect(sevenDay.utilization).toBe(0.91)
    expect(sevenDay.surpassedThreshold).toBe(0.9)

    const fiveHour = body.buckets[1]!
    expect(fiveHour.status).toBe("allowed")
    expect(fiveHour.utilization).toBe(0.42)
    expect(fiveHour.surpassedThreshold).toBeNull()
    expect(fiveHour.isUsingOverage).toBe(false)
  })

  it("hides the internal 'default' fallback bucket from the endpoint", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })

    // SDK event without rateLimitType — store buckets it under "default"
    rateLimitStore.record("default", { status: "allowed", utilization: 0.1 })
    rateLimitStore.record("default", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.5,
    })

    const res = await app.fetch(new Request("http://localhost/v1/usage/quota"))
    const body = await res.json() as QuotaResponse
    const types = body.buckets.map(b => b.type)
    expect(types).not.toContain("default")
    expect(types).toContain("five_hour")
    expect(body.buckets).toHaveLength(1)
  })

  it("nulls out unset optional fields (utilization, resetsAt, overage*)", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    rateLimitStore.record("default", { status: "rejected", rateLimitType: "five_hour" })
    const res = await app.fetch(new Request("http://localhost/v1/usage/quota"))
    const body = await res.json() as QuotaResponse
    const bucket = body.buckets[0]!
    expect(bucket.type).toBe("five_hour")
    expect(bucket.status).toBe("rejected")
    expect(bucket.utilization).toBeNull()
    expect(bucket.resetsAt).toBeNull()
    expect(bucket.overageStatus).toBeNull()
    expect(bucket.overageResetsAt).toBeNull()
    expect(bucket.overageDisabledReason).toBeNull()
    expect(bucket.surpassedThreshold).toBeNull()
    // isUsingOverage defaults to false (not null) so consumers can use the
    // boolean directly without nullish handling.
    expect(bucket.isUsingOverage).toBe(false)
  })

  it("exposes SDK reset times in epoch milliseconds, per the documented contract (#708)", async () => {
    // The SDK reports these in epoch SECONDS. Consumers of this endpoint (the
    // telemetry "resets in ..." badge, Pylon's quota display) treat the field as
    // milliseconds, so an unconverted value renders a 1970 date. This only
    // surfaced in production where OAuth usage is unavailable for a profile,
    // because otherwise the OAuth value wins the merge and masks it.
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const resetSeconds = 1_785_234_600
    rateLimitStore.record("default", {
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: resetSeconds,
      overageResetsAt: resetSeconds + 600,
    } as any)

    const res = await app.fetch(new Request("http://localhost/v1/usage/quota"))
    const body = await res.json() as QuotaResponse
    const bucket = body.buckets[0]!
    expect(bucket.resetsAt).toBe(resetSeconds * 1000)
    expect(bucket.overageResetsAt).toBe((resetSeconds + 600) * 1000)
    // Sanity: a millisecond timestamp is 13 digits and lands in this century.
    expect(new Date(bucket.resetsAt!).getUTCFullYear()).toBeGreaterThan(2020)
  })

  it("merges OAuth-sourced buckets onto SDK buckets, OAuth wins for utilization/resetsAt", async () => {
    // Override only for this test — afterEach clears it.
    __setFetchOAuthUsageOverride(async () => ({
      windows: [
        { type: "five_hour", utilization: 0.36, resetsAt: 1_730_111_111_111 },
        { type: "seven_day", utilization: 0.05, resetsAt: 1_730_222_222_222 },
        { type: "seven_day_omelette", utilization: 0.01, resetsAt: 1_730_333_333_333 },
      ],
      extraUsage: { isEnabled: true, monthlyLimit: 0, usedCredits: 23630, utilization: null, currency: "USD" },
      fetchedAt: 1_730_000_000_000,
    }))
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })

    // SDK has its own bucket for five_hour with overage info we want preserved.
    rateLimitStore.record("default", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.10,         // OAuth (0.36) should win
      resetsAt: 999_999_999_999,  // OAuth (1_730_111_111_111) should win
      isUsingOverage: false,
      overageStatus: "rejected",  // SDK should win — OAuth doesn't expose this
      overageDisabledReason: "org_level_disabled_until",
    })

    const res = await app.fetch(new Request("http://localhost/v1/usage/quota"))
    expect(res.status).toBe(200)
    const body = await res.json() as QuotaResponse & { extraUsage?: any; sources?: any }

    const fiveHour = body.buckets.find(b => b.type === "five_hour")!
    expect(fiveHour.utilization).toBeCloseTo(0.36, 5)
    expect(fiveHour.resetsAt).toBe(1_730_111_111_111)
    // SDK overage details preserved through the merge
    expect(fiveHour.overageStatus).toBe("rejected")
    expect(fiveHour.overageDisabledReason).toBe("org_level_disabled_until")

    // OAuth-only buckets are appended
    expect(body.buckets.find(b => b.type === "seven_day")).toBeDefined()
    expect(body.buckets.find(b => b.type === "seven_day_omelette")).toBeDefined()

    // extra_usage block exposed at top level
    expect(body.extraUsage).toBeDefined()
    expect(body.extraUsage!.usedCredits).toBe(23630)

    // afterEach handles cleanup.
  })

  it("preserves overage fields when present", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    rateLimitStore.record("default", {
      status: "allowed_warning",
      rateLimitType: "overage",
      utilization: 0.78,
      resetsAt: 1_730_000_000_000,
      overageStatus: "allowed",
      overageResetsAt: 1_730_100_000_000,
      isUsingOverage: true,
      surpassedThreshold: 0.75,
      overageDisabledReason: "no_limits_configured",
    })

    const res = await app.fetch(new Request("http://localhost/v1/usage/quota"))
    const body = await res.json() as QuotaResponse
    const bucket = body.buckets[0]!
    expect(bucket.type).toBe("overage")
    expect(bucket.isUsingOverage).toBe(true)
    expect(bucket.overageStatus).toBe("allowed")
    expect(bucket.overageResetsAt).toBe(1_730_100_000_000)
    expect(bucket.overageDisabledReason).toBe("no_limits_configured")
    expect(bucket.surpassedThreshold).toBe(0.75)
  })

  it("reports the requested profile's SDK buckets, not another profile's", async () => {
    // Both accounts have recorded a five_hour bucket. Asking for `personal`
    // must never surface `work`'s numbers.
    rateLimitStore.record("work", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.99,
      resetsAt: 1_111_111_111_111,
    })
    rateLimitStore.record("personal", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.10,
      resetsAt: 2_222_222_222_222,
    })
    __setFetchOAuthUsageOverride(async () => null)

    const { app } = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      profiles: [
        { id: "work", claudeConfigDir: "/tmp/meridian-quota-work" },
        { id: "personal", claudeConfigDir: "/tmp/meridian-quota-personal" },
      ],
      defaultProfile: "work",
    })

    const res = await app.fetch(new Request("http://localhost/v1/usage/quota?profile=personal"))
    expect(res.status).toBe(200)
    const body = await res.json() as QuotaResponse
    const fiveHour = body.buckets.filter(b => b.type === "five_hour")
    expect(fiveHour.map(b => b.resetsAt)).toEqual([2_222_222_222_222])
    expect(fiveHour.map(b => b.utilization)).toEqual([0.10])
  })
})

// #781 follow-up: a null usage snapshot meant `error: "no_token"` regardless of
// cause, so an upstream 429 told users their credentials were missing. The 429
// backoff made that stick for the whole cooldown instead of one poll interval.
describe("GET /v1/usage/quota/all — null attribution", () => {
  beforeEach(() => {
    rateLimitStore.clear()
    resetActiveProfile()
    resetOAuthUsageCache()
    __setFetchOAuthUsageOverride(async () => null)
  })

  afterEach(() => {
    __setFetchOAuthUsageOverride(null)
    resetOAuthUsageCache()
  })

  async function fetchAll(profiles?: Array<{ id: string; claudeConfigDir: string }>) {
    const { app } = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      ...(profiles ? { profiles, defaultProfile: profiles[0]!.id } : {}),
    })
    const res = await app.fetch(new Request("http://localhost/v1/usage/quota/all"))
    expect(res.status).toBe(200)
    return await res.json() as { profiles: Array<{ id: string; error: string | null }> }
  }

  it("reports no_token when there is no cooldown", async () => {
    const body = await fetchAll()
    expect(body.profiles.map(p => p.error)).toEqual(["no_token"])
  })

  it("reports rate_limited once a 429 cooldown is active", async () => {
    // Passing store+fetchImpl bypasses the override and runs the real impl, so
    // the 429 registers a genuine cooldown for the default key.
    await primeRateLimit(undefined)

    const body = await fetchAll()
    expect(body.profiles.map(p => p.error)).toEqual(["rate_limited"])
  })

  it("attributes the cooldown per profile", async () => {
    await primeRateLimit("work")

    const body = await fetchAll([
      { id: "work", claudeConfigDir: "/tmp/meridian-quota-work" },
      { id: "personal", claudeConfigDir: "/tmp/meridian-quota-personal" },
    ])
    expect(body.profiles.find(p => p.id === "work")?.error).toBe("rate_limited")
    expect(body.profiles.find(p => p.id === "personal")?.error).toBe("no_token")
  })
})

async function primeRateLimit(profileId: string | undefined): Promise<void> {
  const store = {
    async read() {
      return { claudeAiOauth: { accessToken: "t", refreshToken: "rt", expiresAt: Date.now() + 60_000 } } as any
    },
    async write() { return true },
  }
  const result = await fetchOAuthUsage({
    force: true,
    profileId,
    store: store as any,
    fetchImpl: async () => new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } }),
  })
  expect(result).toBeNull()
}
