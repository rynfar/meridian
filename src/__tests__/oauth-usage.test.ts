/**
 * Unit tests for oauthUsage — verifies normalization of Anthropic's private
 * OAuth usage endpoint shape into our internal OAuthUsageSnapshot.
 *
 * Both the credential store AND the fetch implementation are dependency-
 * injected so the test never mutates process-level globals (process.env,
 * globalThis.fetch). This keeps the file safe to run in parallel with
 * token-refresh.test.ts and other tests that swap globalThis.fetch.
 */

import { describe, expect, test, beforeEach } from "bun:test"
import { fetchOAuthUsage, fetchOAuthUsageResult, resetOAuthUsageCache } from "../proxy/oauthUsage"
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
      return { claudeAiOauth: { accessToken: token, refreshToken: "rt", expiresAt: Date.now() + 60_000 } } as any
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
        return { claudeAiOauth: { accessToken: token, refreshToken: "rt", expiresAt: Date.now() + 60_000 } } as any
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
