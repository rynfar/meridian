/**
 * Unit tests for oauthUsage — verifies normalization of Anthropic's private
 * OAuth usage endpoint shape into our internal OAuthUsageSnapshot.
 *
 * Both the credential store AND the fetch implementation are dependency-
 * injected so the test never mutates process-level globals (process.env,
 * globalThis.fetch). This keeps the file safe to run in parallel with
 * token-refresh.test.ts and other tests that swap globalThis.fetch.
 */

import { describe, expect, test, beforeEach, afterEach, setSystemTime } from "bun:test"
import { clearOAuthUsageForProfile, fetchOAuthUsage, fetchOAuthUsageResult, peekOAuthUsage, resetOAuthUsageCache, toUsageEntry } from "../proxy/oauthUsage"
import type { CredentialStore } from "../proxy/tokenRefresh"

const SAMPLE_RESPONSE = {
  five_hour: { utilization: 36.0, resets_at: "2026-04-26T22:30:00.221857+00:00" },
  seven_day: { utilization: 5.0, resets_at: "2026-05-03T17:00:00.221872+00:00" },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 0.0, resets_at: null },
  seven_day_cowork: null,
  seven_day_omelette: { utilization: 1.0, resets_at: "2026-05-03T17:00:00.221883+00:00" },
  iguana_necktie: null,
  omelette_promotional: null,
  cedar_ember: {
    eligible: true,
    grants: [{ id: "sample-reset", resets_left: 1, ends_at: "2026-11-01T00:00:00Z" }],
  },
  extra_usage: {
    is_enabled: true,
    monthly_limit: 0,
    used_credits: 23630.0,
    utilization: null,
    currency: "USD",
  },
}

function makeStore(token: string | null): CredentialStore {
  return {
    async read() {
      if (!token) return null
      // An hour out, well clear of the refresh-before-expiry margin, so these
      // tests never reach the real token endpoint.
      return { claudeAiOauth: { accessToken: token, refreshToken: "rt", expiresAt: Date.now() + 3_600_000 } } as any
    },
    async write() { return true },
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Build a per-test fetch impl that returns the given Response. */
function fixedFetch(builder: () => Response): FetchLike {
  return async () => builder()
}

/** Build a per-test fetch impl that increments a counter on every call. */
function countingFetch(builder: (calls: number) => Response): { fetchImpl: FetchLike; getCalls: () => number } {
  let calls = 0
  const fetchImpl: FetchLike = async () => {
    calls++
    return builder(calls)
  }
  return { fetchImpl, getCalls: () => calls }
}

describe("oauthUsage", () => {
  beforeEach(() => {
    resetOAuthUsageCache()
  })

  test("returns null when no token is available", async () => {
    const fetchImpl = fixedFetch(() => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
    const result = await fetchOAuthUsage({ force: true, store: makeStore(null), fetchImpl })
    expect(result).toBeNull()
  })

  test("a superseded failed forced read returns the current cached snapshot without another fetch", async () => {
    const oldResponse = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<void>()
    let oldCalls = 0
    const opts = { store: makeStore("fake-token"), profileId: "reconciled" }
    const old = fetchOAuthUsageResult({ ...opts, force: true, fetchImpl: async () => {
      oldCalls++
      started.resolve()
      return oldResponse.promise
    } })
    await started.promise
    clearOAuthUsageForProfile("reconciled")
    const fresh = await fetchOAuthUsageResult({ ...opts, fetchImpl: async () => Response.json({ five_hour: { utilization: 7 } }) })
    oldResponse.reject(new Error("Synthetic superseded read failure"))
    const reconciled = await old
    expect(reconciled.snapshot).toBe(fresh.snapshot)
    expect(reconciled.error).toBeNull()
    expect(reconciled.failure).toBeNull()
    expect(reconciled.lastGood).toBe(fresh.snapshot)
    expect(oldCalls).toBe(1)
  })

  test("parses sample response into normalized shape", async () => {
    const fetchImpl = fixedFetch(() => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
    const result = await fetchOAuthUsage({ force: true, store: makeStore("token"), fetchImpl })
    expect(result).not.toBeNull()
    expect(result!.windows.length).toBeGreaterThanOrEqual(2)

    const fiveHour = result!.windows.find(w => w.type === "five_hour")
    expect(fiveHour).toBeDefined()
    expect(fiveHour!.utilization).toBeCloseTo(0.36, 5)
    expect(fiveHour!.resetsAt).toBe(Date.parse(SAMPLE_RESPONSE.five_hour.resets_at))

    const sevenDay = result!.windows.find(w => w.type === "seven_day")
    expect(sevenDay).toBeDefined()
    expect(sevenDay!.utilization).toBeCloseTo(0.05, 5)
    expect(result?.bankedResets).toEqual({
      eligible: true,
      grants: [{ id: "sample-reset", resetsLeft: 1, expiresAt: Date.parse("2026-11-01T00:00:00Z") }],
    })
  })

  test("keeps every valid grant, including exhausted, paused, future and expired inventory", async () => {
    const fetchImpl = fixedFetch(() => Response.json({
      cedar_ember: {
        eligible: true,
        grants: [
          { id: "expired", resets_left: 0, ends_at: "2020-01-01T00:00:00Z" },
          { id: "paused", resets_left: 2, paused: true, ends_at: "2030-01-01T03:30:00+03:30" },
          { id: "future", resets_left: Number.MAX_SAFE_INTEGER, starts_at: "2090-01-01T00:00:00Z", ends_at: "2091-01-01T00:00:00" },
          { id: 7, resets_left: 1 },
          { resets_left: 3, ends_at: "not-a-date" },
          { resets_left: 4, ends_at: 123 },
          { resets_left: 5, ends_at: "2030-01-01T00:00:00-05:00" },
        ],
      },
    }))
    const result = await fetchOAuthUsage({ force: true, store: makeStore("t"), fetchImpl })
    expect(result?.bankedResets?.grants).toEqual([
      { id: "expired", resetsLeft: 0, expiresAt: Date.UTC(2020, 0, 1) },
      { id: "paused", resetsLeft: 2, expiresAt: Date.UTC(2030, 0, 1) },
      { id: "future", resetsLeft: Number.MAX_SAFE_INTEGER, expiresAt: Date.UTC(2091, 0, 1) },
      { id: null, resetsLeft: 1, expiresAt: null },
      { id: null, resetsLeft: 3, expiresAt: null },
      { id: null, resetsLeft: 4, expiresAt: null },
      { id: null, resetsLeft: 5, expiresAt: Date.UTC(2030, 0, 1, 5) },
    ])
  })

  test("skips malformed grants rather than inventing reset counts", async () => {
    const fetchImpl = fixedFetch(() => Response.json({
      cedar_ember: { eligible: true, grants: [
        null, 1, "grant", [], {}, { resets_left: null }, { resets_left: "1" },
        { resets_left: -1 }, { resets_left: 0.5 }, { resets_left: Number.MAX_SAFE_INTEGER + 1 },
        { resets_left: 0 },
      ] },
    }))
    const result = await fetchOAuthUsage({ force: true, store: makeStore("t"), fetchImpl })
    expect(result?.bankedResets).toEqual({
      eligible: true, grants: [{ id: null, resetsLeft: 0, expiresAt: null }],
    })
  })

  test("distinguishes unavailable blocks from valid ineligible inventory", async () => {
    for (const cedar_ember of [undefined, null, false, [], {}, { eligible: "true", grants: [] },
      { eligible: true }, { eligible: true, grants: {} }]) {
      const result = await fetchOAuthUsage({
        force: true, store: makeStore("t"),
        fetchImpl: fixedFetch(() => Response.json({ cedar_ember })),
      })
      expect(result?.bankedResets).toBeNull()
    }
    const result = await fetchOAuthUsage({
      force: true, store: makeStore("t"),
      fetchImpl: fixedFetch(() => Response.json({ cedar_ember: { eligible: false, grants: [] } })),
    })
    expect(result?.bankedResets).toEqual({ eligible: false, grants: [] })
  })

  test("retains cached and stale reset inventory without leaking it across profiles", async () => {
    const { fetchImpl, getCalls } = countingFetch(calls => calls === 1
      ? Response.json(SAMPLE_RESPONSE) : new Response("boom", { status: 500 }))
    const opts = { store: makeStore("t"), profileId: "banked-work", fetchImpl }
    const fresh = await fetchOAuthUsage(opts)
    const cached = await fetchOAuthUsage(opts)
    expect(getCalls()).toBe(1)
    expect(cached?.bankedResets).toEqual(fresh?.bankedResets)
    const stale = await fetchOAuthUsage({ ...opts, force: true })
    expect(stale?.stale).toBe(true)
    expect(stale?.bankedResets).toEqual(fresh?.bankedResets)
    const other = await fetchOAuthUsage({ ...opts, profileId: "banked-personal", force: true })
    expect(other).toBeNull()
    expect(peekOAuthUsage("banked-personal")).toBeUndefined()
  })

  test("parses model-scoped weekly limits without duplicating aggregate windows", async () => {
    const resetsAt = "2026-07-20T12:00:00Z"
    const fetchImpl = fixedFetch(() => new Response(JSON.stringify({
      five_hour: { utilization: 15, resets_at: "2026-07-15T18:00:00Z" },
      seven_day: { utilization: 56, resets_at: "2026-07-20T12:00:00Z" },
      limits: [
        {
          kind: "session",
          group: "session",
          percent: 15,
          resets_at: "2026-07-15T18:00:00Z",
          scope: { model: null, surface: null },
        },
        {
          kind: "weekly_all",
          group: "weekly",
          percent: 56,
          resets_at: resetsAt,
          scope: { model: null, surface: null },
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 57,
          resets_at: resetsAt,
          scope: { model: { id: null, display_name: "Fable" }, surface: null },
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 20,
          resets_at: resetsAt,
          scope: { model: null, surface: "api" },
        },
      ],
    }), { status: 200 }))

    const result = await fetchOAuthUsage({ force: true, store: makeStore("t"), fetchImpl })

    expect(result!.windows).toHaveLength(3)
    expect(result!.windows.find(w => w.type === "seven_day_fable")).toEqual({
      type: "seven_day_fable",
      utilization: 0.57,
      resetsAt: Date.parse(resetsAt),
    })
  })

  test("normalizes utilization from 0..100 to 0..1", async () => {
    const fetchImpl = fixedFetch(() => new Response(JSON.stringify({
      five_hour: { utilization: 87.5, resets_at: "2026-04-26T22:30:00Z" },
    }), { status: 200 }))
    const result = await fetchOAuthUsage({ force: true, store: makeStore("t"), fetchImpl })
    const w = result!.windows[0]
    expect(w).toBeDefined()
    expect(w!.utilization).toBeCloseTo(0.875, 5)
  })

  test("skips windows with no utilization and no resets_at", async () => {
    const fetchImpl = fixedFetch(() => new Response(JSON.stringify({
      five_hour: { utilization: 36, resets_at: "2026-04-26T22:30:00Z" },
      seven_day: null,
      seven_day_opus: { utilization: null, resets_at: null },
    }), { status: 200 }))
    const result = await fetchOAuthUsage({ force: true, store: makeStore("t"), fetchImpl })
    expect(result!.windows.length).toBe(1)
    const w = result!.windows[0]
    expect(w).toBeDefined()
    expect(w!.type).toBe("five_hour")
  })

  test("captures extra_usage block", async () => {
    const fetchImpl = fixedFetch(() => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
    const result = await fetchOAuthUsage({ force: true, store: makeStore("t"), fetchImpl })
    expect(result!.extraUsage).not.toBeNull()
    expect(result!.extraUsage!.isEnabled).toBe(true)
    expect(result!.extraUsage!.usedCredits).toBe(23630)
    expect(result!.extraUsage!.utilization).toBeNull()
    expect(result!.extraUsage!.currency).toBe("USD")
  })

  test("returns null on upstream error (non-401)", async () => {
    const fetchImpl = fixedFetch(() => new Response("server boom", { status: 500 }))
    const result = await fetchOAuthUsage({ force: true, store: makeStore("t"), fetchImpl })
    expect(result).toBeNull()
  })

  test("backs off repeated 429 responses per profile even when forced", async () => {
    const { fetchImpl, getCalls } = countingFetch(() =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } }))
    const store = makeStore("t")

    const first = await fetchOAuthUsage({ force: true, store, profileId: "limited", fetchImpl })
    const second = await fetchOAuthUsage({ force: true, store, profileId: "limited", fetchImpl })
    const otherProfile = await fetchOAuthUsage({ force: true, store, profileId: "other", fetchImpl })

    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(otherProfile).toBeNull()
    expect(getCalls()).toBe(2)
  })

  test("serves stale usage while 429 backoff suppresses forced retries", async () => {
    const { fetchImpl, getCalls } = countingFetch((calls) =>
      calls === 1
        ? new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
        : new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }))
    const store = makeStore("t")

    const fresh = await fetchOAuthUsage({ force: true, store, profileId: "stale-limited", fetchImpl })
    const limited = await fetchOAuthUsage({ force: true, store, profileId: "stale-limited", fetchImpl })
    const backedOff = await fetchOAuthUsage({ force: true, store, profileId: "stale-limited", fetchImpl })

    expect(fresh?.stale).toBeUndefined()
    expect(limited?.stale).toBe(true)
    expect(backedOff?.stale).toBe(true)
    expect(backedOff?.windows).toEqual(fresh?.windows)
    expect(getCalls()).toBe(2)
  })

  test("retries after the configured 429 backoff expires", async () => {
    const { fetchImpl, getCalls } = countingFetch((calls) =>
      calls === 1
        ? new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } })
        : new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
    const opts = {
      force: true,
      store: makeStore("t"),
      profileId: "retry",
      fetchImpl,
      rateLimitBackoffMs: 0,
    }

    expect(await fetchOAuthUsage(opts)).toBeNull()
    expect(await fetchOAuthUsage(opts)).not.toBeNull()
    expect(getCalls()).toBe(2)
  })

  // A cooldown longer than the stale window is self-defeating: it suppresses
  // every fetch, so the last-good snapshot ages out with nothing able to
  // refresh it and the display blanks until the cooldown lapses. Cap it.
  test("caps a long Retry-After at the stale window so the snapshot can refresh", async () => {
    const { fetchImpl, getCalls } = countingFetch((calls) =>
      calls === 1
        ? new Response("rate limited", { status: 429, headers: { "Retry-After": "3600" } })
        : new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
    const opts = {
      force: true,
      store: makeStore("t"),
      profileId: "capped",
      fetchImpl,
      rateLimitBackoffMs: 0,
      staleMaxMs: 20,
    }

    expect(await fetchOAuthUsage(opts)).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(await fetchOAuthUsage(opts)).not.toBeNull()
    expect(getCalls()).toBe(2)
  })

  // A null return is overloaded — "no credentials" vs "throttled with nothing
  // left to serve". Consumers rendered the first reading unconditionally and
  // told users to run `claude login` when their credentials were fine.
  test("attributes a throttled fetch to the rate limit, not a missing token", async () => {
    const { fetchImpl } = countingFetch(() =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } }))
    const store = makeStore("t")

    const limited = await fetchOAuthUsageResult({ force: true, store, profileId: "attributed", fetchImpl })
    expect(limited.snapshot).toBeNull()
    expect(limited.error).toBe("rate_limited")

    // The cooldown is per-profile, so an untouched profile reports its own
    // (absent) credentials rather than inheriting the throttle.
    const other = await fetchOAuthUsageResult({
      force: true, store: makeStore(null), profileId: "untouched", fetchImpl,
    })
    expect(other.error).toBe("no_token")
  })

  test("keeps reporting rate_limited while the cooldown suppresses the fetch", async () => {
    const { fetchImpl, getCalls } = countingFetch(() =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } }))
    const opts = { force: true, store: makeStore("t"), profileId: "suppressed", fetchImpl }

    expect((await fetchOAuthUsageResult(opts)).error).toBe("rate_limited")
    // Second call never reaches the network — the reason has to survive the
    // early return, not just the branch that set the cooldown.
    expect((await fetchOAuthUsageResult(opts)).error).toBe("rate_limited")
    expect(getCalls()).toBe(1)
  })

  test("stops reporting rate_limited once the cooldown lapses", async () => {
    const { fetchImpl } = countingFetch(calls => calls === 1
      ? new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } })
      : new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
    const opts = {
      force: true,
      store: makeStore("t"),
      profileId: "lapsed",
      fetchImpl,
      rateLimitBackoffMs: 10,
      staleMaxMs: 10,
    }

    expect((await fetchOAuthUsageResult(opts)).error).toBe("rate_limited")
    await new Promise(resolve => setTimeout(resolve, 20))
    const recovered = await fetchOAuthUsageResult(opts)
    expect(recovered.error).toBeNull()
    expect(recovered.snapshot).not.toBeNull()
  })

  test("reports a genuinely missing token as no_token", async () => {
    const { fetchImpl } = countingFetch(() =>
      new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))

    const result = await fetchOAuthUsageResult({
      force: true, store: makeStore(null), profileId: "tokenless", fetchImpl,
    })
    expect(result.snapshot).toBeNull()
    expect(result.error).toBe("no_token")
  })

  // The cap must not disarm the throttle: a staleMaxMs below the backoff floor
  // still gets the full floor, not the (smaller) stale window.
  test("never caps the cooldown below the backoff floor", async () => {
    const { fetchImpl, getCalls } = countingFetch(() =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "1" } }))
    const opts = {
      force: true,
      store: makeStore("t"),
      profileId: "floor",
      fetchImpl,
      rateLimitBackoffMs: 60_000,
      staleMaxMs: 0,
    }

    expect(await fetchOAuthUsage(opts)).toBeNull()
    expect(await fetchOAuthUsage(opts)).toBeNull()
    expect(getCalls()).toBe(1)
  })

  test("caches result within TTL", async () => {
    const { fetchImpl, getCalls } = countingFetch(() => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
    const store = makeStore("t")
    const r1 = await fetchOAuthUsage({ force: true, store, fetchImpl })
    const r2 = await fetchOAuthUsage({ store, fetchImpl })
    expect(r1).not.toBeNull()
    expect(r2).toBe(r1)
    expect(getCalls()).toBe(1)
  })

  test("force=true bypasses cache", async () => {
    const { fetchImpl, getCalls } = countingFetch(() => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
    const store = makeStore("t")
    await fetchOAuthUsage({ force: true, store, fetchImpl })
    await fetchOAuthUsage({ force: true, store, fetchImpl })
    expect(getCalls()).toBe(2)
  })

  test("per-profile cache: distinct profileIds get separate cache entries", async () => {
    const { fetchImpl, getCalls } = countingFetch((calls) => new Response(JSON.stringify({
      five_hour: { utilization: 10 + calls, resets_at: "2026-04-26T22:30:00Z" },
    }), { status: 200 }))
    const a = await fetchOAuthUsage({ force: true, store: makeStore("tA"), profileId: "personal", fetchImpl })
    const b = await fetchOAuthUsage({ force: true, store: makeStore("tB"), profileId: "work", fetchImpl })
    expect(getCalls()).toBe(2)
    expect(a!.windows[0]!.utilization).not.toBe(b!.windows[0]!.utilization)

    // Subsequent reads hit the per-profile cache, not the network.
    const aAgain = await fetchOAuthUsage({ profileId: "personal", fetchImpl })
    const bAgain = await fetchOAuthUsage({ profileId: "work", fetchImpl })
    expect(getCalls()).toBe(2)
    expect(aAgain).toBe(a)
    expect(bAgain).toBe(b)
  })

  test("per-profile cache: same profileId across calls shares cache", async () => {
    const { fetchImpl, getCalls } = countingFetch(() => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
    const r1 = await fetchOAuthUsage({ force: true, store: makeStore("t"), profileId: "personal", fetchImpl })
    const r2 = await fetchOAuthUsage({ profileId: "personal", fetchImpl })
    expect(getCalls()).toBe(1)
    expect(r2).toBe(r1)
  })

  test("profileId null behaves as the default account, distinct from named profiles", async () => {
    const { fetchImpl, getCalls } = countingFetch(() => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
    await fetchOAuthUsage({ force: true, store: makeStore("d"), fetchImpl })  // no profileId → default key
    await fetchOAuthUsage({ force: true, store: makeStore("p"), profileId: "personal", fetchImpl })
    expect(getCalls()).toBe(2)
  })

  test("serves the last-good snapshot (marked stale) when a later fetch fails upstream", async () => {
    const { fetchImpl } = countingFetch((calls) =>
      calls === 1
        ? new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
        : new Response("boom", { status: 500 }))
    const store = makeStore("t")
    const first = await fetchOAuthUsage({ force: true, store, profileId: "flappy", fetchImpl })
    expect(first?.stale).toBeUndefined()
    const second = await fetchOAuthUsage({ force: true, store, profileId: "flappy", fetchImpl })
    expect(second).not.toBeNull()
    expect(second!.stale).toBe(true)
    expect(second!.windows).toEqual(first!.windows)
  })

  test("serves the last-good snapshot when the credential read starts failing", async () => {
    const fetchImpl = fixedFetch(() => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
    let token: string | null = "t"
    const store: CredentialStore = {
      async read() {
        if (!token) return null
        // An hour out, well clear of the refresh-before-expiry margin, so these
      // tests never reach the real token endpoint.
      return { claudeAiOauth: { accessToken: token, refreshToken: "rt", expiresAt: Date.now() + 3_600_000 } } as any
      },
      async write() { return true },
    }
    const first = await fetchOAuthUsage({ force: true, store, profileId: "keyblip", fetchImpl })
    expect(first).not.toBeNull()
    token = null // Keychain read blip
    const second = await fetchOAuthUsage({ force: true, store, profileId: "keyblip", fetchImpl })
    expect(second).not.toBeNull()
    expect(second!.stale).toBe(true)
  })

  test("stale fallback is bounded by staleMaxMs", async () => {
    const { fetchImpl } = countingFetch((calls) =>
      calls === 1
        ? new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
        : new Response("boom", { status: 500 }))
    const store = makeStore("t")
    await fetchOAuthUsage({ force: true, store, profileId: "aged", fetchImpl })
    const second = await fetchOAuthUsage({ force: true, store, profileId: "aged", fetchImpl, staleMaxMs: 0 })
    expect(second).toBeNull()
  })

  test("failure with no prior snapshot still returns null", async () => {
    const fetchImpl = fixedFetch(() => new Response("boom", { status: 500 }))
    const result = await fetchOAuthUsage({ force: true, store: makeStore("t"), profileId: "nofirst", fetchImpl })
    expect(result).toBeNull()
  })

  test("ISO date with timezone parses correctly to UTC ms", async () => {
    const iso = "2026-04-26T22:30:00.221857+00:00"
    const fetchImpl = fixedFetch(() => new Response(JSON.stringify({
      five_hour: { utilization: 36, resets_at: iso },
    }), { status: 200 }))
    const result = await fetchOAuthUsage({ force: true, store: makeStore("t"), fetchImpl })
    const w = result!.windows[0]
    expect(w).toBeDefined()
    expect(w!.resetsAt).toBe(Date.parse(iso))
  })
})

/**
 * The failure REASON, which is what a per-profile status display shows a
 * human. Every failure used to reach callers as a bare null, so the quota
 * routes labelled all of them "no_token" and a rate-limited read rendered as
 * an account that had lost its credentials.
 */
describe("fetchOAuthUsageResult", () => {
  beforeEach(() => {
    resetOAuthUsageCache()
  })

  test("reports no_token only when the store holds no token", async () => {
    const fetchImpl = fixedFetch(() => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
    const { snapshot, error } = await fetchOAuthUsageResult({
      force: true, store: makeStore(null), profileId: "reason-empty", fetchImpl,
    })
    expect(snapshot).toBeNull()
    expect(error).toBe("no_token")
  })

  // Narrowed from the original `upstream_error`: a 429 is the one failure the
  // backoff can keep returning for minutes, so it gets its own value rather
  // than hiding among generic upstream faults. Still never `no_token`, which
  // was the bug.
  test("reports rate_limited for a 429 rather than no_token", async () => {
    const fetchImpl = fixedFetch(() => new Response("rate limited", { status: 429 }))
    const { snapshot, error } = await fetchOAuthUsageResult({
      force: true, store: makeStore("t"), profileId: "reason-429", fetchImpl,
    })
    expect(snapshot).toBeNull()
    expect(error).toBe("rate_limited")
  })

  test("reports upstream_error for a 500", async () => {
    const fetchImpl = fixedFetch(() => new Response("boom", { status: 500 }))
    const { error } = await fetchOAuthUsageResult({
      force: true, store: makeStore("t"), profileId: "reason-500", fetchImpl,
    })
    expect(error).toBe("upstream_error")
  })

  test("reports no error on success", async () => {
    const fetchImpl = fixedFetch(() => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
    const { snapshot, error } = await fetchOAuthUsageResult({
      force: true, store: makeStore("t"), profileId: "reason-ok", fetchImpl,
    })
    expect(snapshot).not.toBeNull()
    expect(error).toBeNull()
  })

  test("a snapshot served stale after a failure is not an error", async () => {
    const { fetchImpl } = countingFetch(calls => calls === 1
      ? new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
      : new Response("rate limited", { status: 429 }))
    const first = await fetchOAuthUsageResult({
      force: true, store: makeStore("t"), profileId: "reason-stale", fetchImpl,
    })
    expect(first.error).toBeNull()

    const second = await fetchOAuthUsageResult({
      force: true, store: makeStore("t"), profileId: "reason-stale", fetchImpl,
    })
    expect(second.snapshot?.stale).toBe(true)
    expect(second.error).toBeNull()
  })
})

describe("failure provenance", () => {
  beforeEach(() => {
    resetOAuthUsageCache()
  })

  test("a first-ever failure has a reason and nothing to fall back on", async () => {
    const { fetchImpl } = countingFetch(() =>
      new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))

    const result = await fetchOAuthUsageResult({
      force: true, store: makeStore(null), profileId: "cold", fetchImpl,
    })

    expect(result.snapshot).toBeNull()
    expect(result.lastGood).toBeNull()
    expect(result.failure?.reason).toBe("no_token")
    expect(result.failure?.consecutiveFailures).toBe(1)
  })

  test("a failure after a success keeps the reading and dates it", async () => {
    const { fetchImpl } = countingFetch(calls => calls === 1
      ? new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
      : new Response("boom", { status: 500 }))
    const opts = { force: true, store: makeStore("t"), profileId: "after-success", fetchImpl }

    const good = await fetchOAuthUsageResult(opts)
    expect(good.failure).toBeNull()

    const failed = await fetchOAuthUsageResult(opts)
    expect(failed.snapshot?.stale).toBe(true)
    expect(failed.snapshot?.fetchedAt).toBe(good.snapshot!.fetchedAt)
    expect(failed.failure?.reason).toBe("upstream_error")
    expect(failed.failure?.consecutiveFailures).toBe(1)
  })

  test("counts the run of consecutive failed checks", async () => {
    const { fetchImpl } = countingFetch(() => new Response("boom", { status: 500 }))
    const opts = { force: true, store: makeStore("t"), profileId: "run", fetchImpl }

    await fetchOAuthUsageResult(opts)
    await fetchOAuthUsageResult(opts)
    const third = await fetchOAuthUsageResult(opts)

    expect(third.failure?.consecutiveFailures).toBe(3)
    expect(third.failure?.reason).toBe("upstream_error")
  })

  test("a success clears the run rather than zeroing it", async () => {
    const { fetchImpl } = countingFetch(calls => calls <= 2
      ? new Response("boom", { status: 500 })
      : new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))
    const opts = { force: true, store: makeStore("t"), profileId: "recovers", fetchImpl }

    await fetchOAuthUsageResult(opts)
    expect((await fetchOAuthUsageResult(opts)).failure?.consecutiveFailures).toBe(2)

    const recovered = await fetchOAuthUsageResult(opts)
    expect(recovered.snapshot?.stale).toBeUndefined()
    expect(recovered.failure).toBeNull()
  })

  // The page polls every 10s against a backoff measured in minutes, so counting
  // polls the cooldown refused would report the poll interval, not the account.
  test("polls the cooldown turns away do not advance the count", async () => {
    const { fetchImpl, getCalls } = countingFetch(() =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } }))
    const opts = { force: true, store: makeStore("t"), profileId: "suppressed-run", fetchImpl }

    expect((await fetchOAuthUsageResult(opts)).failure?.consecutiveFailures).toBe(1)
    await fetchOAuthUsageResult(opts)
    const third = await fetchOAuthUsageResult(opts)

    expect(third.failure?.consecutiveFailures).toBe(1)
    expect(third.failure?.reason).toBe("rate_limited")
    expect(getCalls()).toBe(1)
  })
})

describe("toUsageEntry", () => {
  beforeEach(() => {
    resetOAuthUsageCache()
  })

  test("a profile never read has no figures and is not called stale", async () => {
    const { fetchImpl } = countingFetch(() =>
      new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))

    const entry = toUsageEntry(await fetchOAuthUsageResult({
      force: true, store: makeStore(null), profileId: "entry-cold", fetchImpl,
    }))

    expect(entry.windows).toEqual([])
    expect(entry.bankedResets).toBeNull()
    expect(entry.fetchedAt).toBeNull()
    expect(entry.stale).toBe(false)
    expect(entry.error).toBe("no_token")
    expect(entry.failure?.reason).toBe("no_token")
  })

  test("a reading taken by the check that just ran is not stale", async () => {
    const fetchImpl = fixedFetch(() => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 }))

    const entry = toUsageEntry(await fetchOAuthUsageResult({
      force: true, store: makeStore("t"), profileId: "entry-fresh", fetchImpl,
    }))

    expect(entry.windows.length).toBeGreaterThan(0)
    expect(entry.fetchedAt).not.toBeNull()
    expect(entry.stale).toBe(false)
    expect(entry.error).toBeNull()
    expect(entry.failure).toBeNull()
  })

  // The whole point of the change: figures outlive the window `staleOr` will
  // serve them in, and arrive labelled with when they were taken and why they
  // have stopped moving.
  test("keeps the last good reading past the stale bound, labelled", async () => {
    const { fetchImpl } = countingFetch(calls => calls === 1
      ? new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
      : new Response("boom", { status: 500 }))
    const store = makeStore("t")

    const good = await fetchOAuthUsageResult({ force: true, store, profileId: "entry-aged", fetchImpl })
    const aged = await fetchOAuthUsageResult({
      force: true, store, profileId: "entry-aged", fetchImpl, staleMaxMs: 0,
    })
    expect(aged.snapshot).toBeNull()

    const entry = toUsageEntry(aged)
    expect(entry.windows).toEqual(good.snapshot!.windows)
    expect(entry.bankedResets).toEqual(good.snapshot?.bankedResets ?? null)
    expect(entry.fetchedAt).toBe(good.snapshot!.fetchedAt)
    expect(entry.stale).toBe(true)
    expect(entry.error).toBe("upstream_error")
    expect(entry.failure?.consecutiveFailures).toBe(1)
  })
})

/**
 * A stuck access token: one host kept a token that had expired 39 hours
 * earlier, and the usage endpoint answered every check with 429 — 235 in a
 * row — while other hosts on the same account read fine. The endpoint limits
 * per access token, so only a new token gets out of that bucket.
 */
describe("token refresh outside the 401 path", () => {
  const HOUR = 60 * 60_000

  /** A store whose token each successful refresh rotates (old → new1 → new2),
   *  so a test can see which token every upstream call carried. */
  function rotatingStore(opts: { expiresAt?: number; refreshOk?: boolean } = {}) {
    let creds = { accessToken: "old", refreshToken: "rt", expiresAt: opts.expiresAt ?? Date.now() + 8 * HOUR }
    let refreshes = 0
    const store: CredentialStore = {
      async read() { return { claudeAiOauth: { ...creds } } },
      async write() { return true },
    }
    const refreshImpl = async () => {
      refreshes++
      if (opts.refreshOk === false) return false
      creds = { ...creds, accessToken: `new${refreshes}`, expiresAt: Date.now() + 8 * HOUR }
      return true
    }
    return { store, refreshImpl, getRefreshes: () => refreshes }
  }

  /** Answers by the bearer token, and records which token each call used. */
  function tokenFetch(respond: (token: string) => Response) {
    const seen: string[] = []
    const fetchImpl: FetchLike = async (_url, init) => {
      const token = new Headers(init?.headers).get("authorization")!.replace(/^Bearer /, "")
      seen.push(token)
      return respond(token)
    }
    return { fetchImpl, seen }
  }

  const ok = () => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
  const limited = () => new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } })

  beforeEach(() => {
    resetOAuthUsageCache()
  })

  afterEach(() => {
    setSystemTime()
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
  })

  test("refreshes an expired token before the usage call", async () => {
    const { store, refreshImpl, getRefreshes } = rotatingStore({ expiresAt: Date.now() - 39 * HOUR })
    const { fetchImpl, seen } = tokenFetch(token => token === "old" ? limited() : ok())

    const result = await fetchOAuthUsageResult({ force: true, store, refreshImpl, fetchImpl, profileId: "expired" })

    expect(getRefreshes()).toBe(1)
    expect(seen).toEqual(["new1"])
    expect(result.error).toBeNull()
    expect(result.snapshot).not.toBeNull()
  })

  test("refreshes a token inside the expiry margin", async () => {
    const { store, refreshImpl, getRefreshes } = rotatingStore({ expiresAt: Date.now() + 10_000 })
    const { fetchImpl, seen } = tokenFetch(ok)

    await fetchOAuthUsageResult({ force: true, store, refreshImpl, fetchImpl, profileId: "expiring" })

    expect(getRefreshes()).toBe(1)
    expect(seen).toEqual(["new1"])
  })

  test("does not refresh a token that is not near expiry", async () => {
    const { store, refreshImpl, getRefreshes } = rotatingStore()
    const { fetchImpl, seen } = tokenFetch(ok)

    await fetchOAuthUsageResult({ force: true, store, refreshImpl, fetchImpl, profileId: "fresh" })

    expect(getRefreshes()).toBe(0)
    expect(seen).toEqual(["old"])
  })

  test("a failed expiry refresh still makes the call with the stored token", async () => {
    const { store, refreshImpl, getRefreshes } = rotatingStore({ expiresAt: Date.now() - HOUR, refreshOk: false })
    const { fetchImpl, seen } = tokenFetch(limited)

    const result = await fetchOAuthUsageResult({ force: true, store, refreshImpl, fetchImpl, profileId: "expired-dead" })

    expect(getRefreshes()).toBe(1)
    expect(seen).toEqual(["old"])
    expect(result.error).toBe("rate_limited")
  })

  test("a run of 429s on one token refreshes once and retries with the new token", async () => {
    const { store, refreshImpl, getRefreshes } = rotatingStore()
    const { fetchImpl, seen } = tokenFetch(token => token === "old" ? limited() : ok())
    const opts = { force: true, store, refreshImpl, fetchImpl, profileId: "run-429", rateLimitBackoffMs: 0 }

    expect((await fetchOAuthUsageResult(opts)).error).toBe("rate_limited")
    expect((await fetchOAuthUsageResult(opts)).error).toBe("rate_limited")
    expect(getRefreshes()).toBe(0)

    const third = await fetchOAuthUsageResult(opts)
    expect(getRefreshes()).toBe(1)
    expect(seen).toEqual(["old", "old", "old", "new1"])
    expect(third.error).toBeNull()
    expect(third.snapshot).not.toBeNull()
    expect(third.failure).toBeNull()
  })

  test("a second 429 run inside the window does not refresh again", async () => {
    const { store, refreshImpl, getRefreshes } = rotatingStore()
    const { fetchImpl } = tokenFetch(limited)
    const opts = { force: true, store, refreshImpl, fetchImpl, profileId: "window", rateLimitBackoffMs: 0 }

    for (let i = 0; i < 3; i++) await fetchOAuthUsageResult(opts)
    expect(getRefreshes()).toBe(1)

    // The retry on new1 opened a fresh run; push it well past the threshold.
    for (let i = 0; i < 5; i++) await fetchOAuthUsageResult(opts)
    expect(getRefreshes()).toBe(1)
  })

  test("allows another 429 refresh once the window has passed", async () => {
    const start = Date.now()
    setSystemTime(start)
    const { store, refreshImpl, getRefreshes } = rotatingStore()
    const { fetchImpl } = tokenFetch(limited)
    const opts = { force: true, store, refreshImpl, fetchImpl, profileId: "window-lapsed", rateLimitBackoffMs: 0 }

    for (let i = 0; i < 3; i++) await fetchOAuthUsageResult(opts)
    expect(getRefreshes()).toBe(1)

    setSystemTime(start + HOUR + 1_000)
    for (let i = 0; i < 3; i++) await fetchOAuthUsageResult(opts)
    expect(getRefreshes()).toBe(2)
  })

  test("a success between 429s breaks the run", async () => {
    const { store, refreshImpl, getRefreshes } = rotatingStore()
    let call = 0
    const { fetchImpl } = tokenFetch(() => ++call === 3 ? ok() : limited())
    const opts = { force: true, store, refreshImpl, fetchImpl, profileId: "broken-run", rateLimitBackoffMs: 0 }

    for (let i = 0; i < 4; i++) await fetchOAuthUsageResult(opts)

    expect(getRefreshes()).toBe(0)
  })

  test("a token rotated by someone else starts a new run", async () => {
    const { store, refreshImpl, getRefreshes } = rotatingStore()
    const { fetchImpl } = tokenFetch(limited)
    const opts = { force: true, store, refreshImpl, fetchImpl, profileId: "rotated", rateLimitBackoffMs: 0 }

    await fetchOAuthUsageResult(opts)
    await fetchOAuthUsageResult(opts)
    // Another process (the CLI, the background scheduler) renews the token.
    await refreshImpl()
    await fetchOAuthUsageResult(opts)
    await fetchOAuthUsageResult(opts)

    expect(getRefreshes()).toBe(1)
  })

  test("a failed 429 refresh leaves the cooldown in force", async () => {
    const { store, refreshImpl, getRefreshes } = rotatingStore({ refreshOk: false })
    const { fetchImpl, seen } = tokenFetch(limited)
    const opts = { force: true, store, refreshImpl, fetchImpl, profileId: "refresh-dead", rateLimitBackoffMs: 0 }

    await fetchOAuthUsageResult(opts)
    await fetchOAuthUsageResult(opts)
    const third = await fetchOAuthUsageResult({ ...opts, rateLimitBackoffMs: 60_000 })
    expect(getRefreshes()).toBe(1)
    expect(third.error).toBe("rate_limited")
    expect(third.failure?.consecutiveFailures).toBe(3)

    const suppressed = await fetchOAuthUsageResult({ ...opts, rateLimitBackoffMs: 60_000 })
    expect(suppressed.error).toBe("rate_limited")
    expect(seen).toEqual(["old", "old", "old"])
  })

  test("a read-only instance refreshes neither on expiry nor on a 429 run", async () => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    const { store, refreshImpl, getRefreshes } = rotatingStore({ expiresAt: Date.now() - HOUR })
    const { fetchImpl, seen } = tokenFetch(limited)
    const opts = { force: true, store, refreshImpl, fetchImpl, profileId: "readonly", rateLimitBackoffMs: 0 }

    for (let i = 0; i < 4; i++) await fetchOAuthUsageResult(opts)

    expect(getRefreshes()).toBe(0)
    expect(seen).toEqual(["old", "old", "old", "old"])
  })

  test("a 401 still refreshes and retries with the new token", async () => {
    const { store, refreshImpl, getRefreshes } = rotatingStore()
    const { fetchImpl, seen } = tokenFetch(token =>
      token === "old" ? new Response("unauthorized", { status: 401 }) : ok())

    const result = await fetchOAuthUsageResult({ force: true, store, refreshImpl, fetchImpl, profileId: "unauthorized" })

    expect(getRefreshes()).toBe(1)
    expect(seen).toEqual(["old", "new1"])
    expect(result.error).toBeNull()
  })

  test("a 401 whose refresh fails reports upstream_error", async () => {
    const { store, refreshImpl } = rotatingStore({ refreshOk: false })
    const { fetchImpl, seen } = tokenFetch(() => new Response("unauthorized", { status: 401 }))

    const result = await fetchOAuthUsageResult({ force: true, store, refreshImpl, fetchImpl, profileId: "unauthorized-dead" })

    expect(seen).toEqual(["old"])
    expect(result.error).toBe("upstream_error")
  })

  test("clearOAuthUsageForProfile drops cached snapshot and 429 cooldown for only the target profile", async () => {
    const { store: workStore, refreshImpl: workRefresh } = rotatingStore()
    const { store: personalStore, refreshImpl: personalRefresh } = rotatingStore()

    await fetchOAuthUsageResult({ force: true, store: workStore, refreshImpl: workRefresh, fetchImpl: tokenFetch(ok).fetchImpl, profileId: "work" })
    await fetchOAuthUsageResult({ force: true, store: personalStore, refreshImpl: personalRefresh, fetchImpl: tokenFetch(ok).fetchImpl, profileId: "personal" })
    expect(peekOAuthUsage("work")).toBeDefined()
    expect(peekOAuthUsage("personal")).toBeDefined()

    const throttled = await fetchOAuthUsageResult({
      force: true,
      store: workStore,
      refreshImpl: workRefresh,
      fetchImpl: tokenFetch(limited).fetchImpl,
      profileId: "work",
      rateLimitBackoffMs: 60_000,
    })
    expect(throttled.failure?.reason).toBe("rate_limited")
    expect(throttled.snapshot?.stale).toBe(true)

    clearOAuthUsageForProfile("work")
    expect(peekOAuthUsage("work")).toBeUndefined()
    expect(peekOAuthUsage("personal")).toBeDefined()

    let freshCalls = 0
    const afterClear = await fetchOAuthUsageResult({
      force: true,
      store: workStore,
      refreshImpl: workRefresh,
      fetchImpl: async () => {
        freshCalls++
        return ok()
      },
      profileId: "work",
      rateLimitBackoffMs: 60_000,
    })
    expect(freshCalls).toBe(1)
    expect(afterClear.error).toBeNull()
    expect(afterClear.failure).toBeNull()
  })
})
