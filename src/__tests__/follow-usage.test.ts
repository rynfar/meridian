/**
 * followUsage — a follower reports the usage figures the followed instance
 * has already paid for, instead of competing with it for the same per-account
 * rate-limit budget.
 *
 * The parser is pure and gets direct tests. The lookup is gated on
 * MERIDIAN_FOLLOW_ACTIVE, which this file sets and restores per test; the
 * preload clears it, so nothing here leaks into the profile/routing suites.
 */

import { describe, expect, test, afterEach } from "bun:test"
import {
  FOLLOW_USAGE_MAX_AGE_MS,
  followedUsageSnapshot,
  pollFollowedUsage,
  readFollowedUsage,
  resetFollowedUsage,
  setFollowedUsageForTesting,
} from "../proxy/followUsage"
import { fetchOAuthUsageResult, resetOAuthUsageCache, type OAuthUsageSnapshot } from "../proxy/oauthUsage"
import type { CredentialStore } from "../proxy/tokenRefresh"

const FLAG = "MERIDIAN_FOLLOW_ACTIVE"

function quotaBody(profiles: unknown[]): unknown {
  return { profiles, activeProfile: "personal", asOf: Date.now() }
}

function snapshot(utilization: number): OAuthUsageSnapshot {
  return {
    windows: [{ type: "five_hour", utilization, resetsAt: null }],
    extraUsage: null,
    bankedResets: null,
    fetchedAt: Date.now(),
  }
}

const originalFetch = globalThis.fetch

/** A credential store and usage endpoint that count every touch. */
function localPath() {
  let reads = 0
  let calls = 0
  const store: CredentialStore = {
    async read() { reads++; return null },
    async write() { return true },
  }
  const fetchImpl = async () => { calls++; return new Response("{}", { status: 500 }) }
  return { store, fetchImpl, reads: () => reads, calls: () => calls }
}

afterEach(() => {
  delete process.env[FLAG]
  delete process.env.CLAUDE_PROXY_FOLLOW_ACTIVE
  resetFollowedUsage()
  resetOAuthUsageCache()
  globalThis.fetch = originalFetch
})

describe("readFollowedUsage", () => {
  test("keeps profiles that carry windows", () => {
    const parsed = readFollowedUsage(quotaBody([
      {
        id: "personal",
        windows: [
          { type: "five_hour", utilization: 0.4, resetsAt: 1234 },
          { type: "seven_day", utilization: 0.1, resetsAt: null },
        ],
        extraUsage: null,
        fetchedAt: 999,
        error: null,
      },
    ]))

    expect(parsed.size).toBe(1)
    const personal = parsed.get("personal")!
    expect(personal.windows).toEqual([
      { type: "five_hour", utilization: 0.4, resetsAt: 1234 },
      { type: "seven_day", utilization: 0.1, resetsAt: null },
    ])
    expect(personal.fetchedAt).toBe(999)
  })

  test("drops a profile the followed instance itself could not read", () => {
    const parsed = readFollowedUsage(quotaBody([
      { id: "dead", windows: [], extraUsage: null, fetchedAt: null, error: "no_token" },
      { id: "limited", windows: [], extraUsage: null, fetchedAt: null, error: "upstream_error" },
    ]))
    expect(parsed.size).toBe(0)
  })

  test("drops an entry with no windows even when it reports no error", () => {
    const parsed = readFollowedUsage(quotaBody([
      { id: "cold", windows: [], extraUsage: null, fetchedAt: null, error: null },
    ]))
    expect(parsed.size).toBe(0)
  })

  test("survives a garbage body without throwing", () => {
    expect(readFollowedUsage(undefined).size).toBe(0)
    expect(readFollowedUsage(null).size).toBe(0)
    expect(readFollowedUsage("nope").size).toBe(0)
    expect(readFollowedUsage({ profiles: "nope" }).size).toBe(0)
    expect(readFollowedUsage({ profiles: [null, 7, { noId: true }] }).size).toBe(0)
  })

  test("keeps the followed instance's stale mark, banked resets and extra usage", () => {
    const bankedResets = { eligible: true, nextGrantId: "g1", ineligibleReason: null, grants: [] }
    const extraUsage = { isEnabled: true, monthlyLimit: 50, usedCredits: 5, utilization: 0.1, currency: "USD" }
    const parsed = readFollowedUsage(quotaBody([
      { id: "personal", windows: [{ type: "five_hour", utilization: 0.4, resetsAt: null }],
        extraUsage, bankedResets, fetchedAt: 999, stale: true, error: null },
    ]))
    expect(parsed.get("personal")).toEqual({
      windows: [{ type: "five_hour", utilization: 0.4, resetsAt: null }],
      extraUsage, bankedResets, fetchedAt: 999, stale: true,
    })
  })

  test("drops malformed extra usage and banked resets instead of importing them", () => {
    const parsed = readFollowedUsage(quotaBody([
      { id: "personal", windows: [{ type: "five_hour", utilization: 0.4, resetsAt: null }],
        extraUsage: "lots", bankedResets: { eligible: "yes" }, error: null },
    ]))
    expect(parsed.get("personal")!.extraUsage).toBeNull()
    expect(parsed.get("personal")!.bankedResets).toBeNull()
  })

  test("skips malformed windows but keeps the usable ones", () => {
    const parsed = readFollowedUsage(quotaBody([
      {
        id: "mixed",
        windows: [
          { utilization: 0.5 },
          { type: "five_hour", utilization: "high", resetsAt: "soon" },
          { type: "seven_day", utilization: 0.2, resetsAt: 42 },
        ],
        error: null,
      },
    ]))
    expect(parsed.get("mixed")!.windows).toEqual([
      { type: "five_hour", utilization: null, resetsAt: null },
      { type: "seven_day", utilization: 0.2, resetsAt: 42 },
    ])
  })
})

describe("followedUsageSnapshot", () => {
  test("returns nothing when this instance follows no one", () => {
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    expect(followedUsageSnapshot("personal")).toBeUndefined()
  })

  test("returns the followed figures when following", () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    expect(followedUsageSnapshot("personal")!.windows[0]!.utilization).toBe(0.4)
  })

  test("returns nothing for a profile the followed instance did not report", () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    expect(followedUsageSnapshot("someone-else")).toBeUndefined()
  })

  test("stops serving figures older than the max age", () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(
      new Map([["personal", snapshot(0.4)]]),
      Date.now() - FOLLOW_USAGE_MAX_AGE_MS - 1,
    )
    expect(followedUsageSnapshot("personal")).toBeUndefined()
  })
})

describe("usage reads on a follower", () => {
  test("serve the followed figures without reading credentials or calling Anthropic", async () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    const local = localPath()

    const result = await fetchOAuthUsageResult({ profileId: "personal", force: true, store: local.store, fetchImpl: local.fetchImpl })

    expect(result.snapshot!.windows[0]!.utilization).toBe(0.4)
    expect(result.error).toBeNull()
    expect(result.failure).toBeNull()
    expect(local.reads()).toBe(0)
    expect(local.calls()).toBe(0)
  })

  test("serve the followed default account to the unscoped read", async () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["default", snapshot(0.7)]]))
    const local = localPath()

    const result = await fetchOAuthUsageResult({ store: local.store, fetchImpl: local.fetchImpl })

    expect(result.snapshot!.windows[0]!.utilization).toBe(0.7)
    expect(local.reads()).toBe(0)
  })

  test("fall back to this instance's own credentials for a profile the followed instance did not report", async () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    const local = localPath()

    const result = await fetchOAuthUsageResult({ profileId: "work", force: true, store: local.store, fetchImpl: local.fetchImpl })

    expect(result.snapshot).toBeNull()
    expect(local.reads()).toBeGreaterThan(0)
  })
})

describe("pollFollowedUsage", () => {
  test("reads every profile's figures from the followed instance in one request", async () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    const urls: string[] = []
    globalThis.fetch = Object.assign(async (url: string | URL | Request) => {
      urls.push(String(url))
      return Response.json(quotaBody([
        { id: "personal", windows: [{ type: "five_hour", utilization: 0.4, resetsAt: null }], error: null },
        { id: "work", windows: [{ type: "five_hour", utilization: 0.9, resetsAt: null }], error: null },
      ]))
    }, { preconnect: originalFetch.preconnect })

    await pollFollowedUsage()

    expect(urls).toEqual(["http://127.0.0.1:3456/v1/usage/quota/all"])
    expect(followedUsageSnapshot("personal")!.windows[0]!.utilization).toBe(0.4)
    expect(followedUsageSnapshot("work")!.windows[0]!.utilization).toBe(0.9)
  })

  test("keeps the last figures when the followed instance cannot be reached", async () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    globalThis.fetch = Object.assign(async () => { throw new Error("ECONNREFUSED") }, { preconnect: originalFetch.preconnect })

    await pollFollowedUsage()

    expect(followedUsageSnapshot("personal")!.windows[0]!.utilization).toBe(0.4)
  })
})
