import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { clearOAuthUsageForProfile, fetchOAuthUsage, fetchOAuthUsageResult, oauthUserAgent, peekOAuthUsage, redeemOAuthQuotaReset, redeemOAuthQuotaResetOnce, resetOAuthUsageCache } from "../proxy/oauthUsage"
import type { CredentialStore } from "../proxy/tokenRefresh"

const input = { profile: "work", grantId: "grant_1", requestId: "Request-1" }
const org = "11111111-1111-4111-8111-111111111111"
const store: CredentialStore = {
  async read() { return { claudeAiOauth: { accessToken: "fake-selected-token", refreshToken: "fake-refresh", expiresAt: Date.now() + 3_600_000 } } },
  async write() { throw new Error("Unexpected credential write") },
}
const options = { store, profileId: "work", refreshImpl: async () => { throw new Error("Unexpected refresh") } }
afterEach(() => {
  resetOAuthUsageCache()
  setSystemTime()
})

describe("explicit OAuth quota redemption", () => {
  test("normalizes a confirmed reset outcome", async () => {
    const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) =>
      Response.json(init?.method !== "POST" ? { organization: { uuid: org } } : {
        result: "reset", reason: null, resets_left: 0, cleared: ["five_hour"], weekly_resets_at: "2026-11-01T00:00:00Z",
      }),
    })
    expect(result).toEqual({ ok: true, outcome: { result: "reset", reason: null, resetsLeft: 0, cleared: ["five_hour"], weeklyResetsAt: Date.parse("2026-11-01T00:00:00Z"), cooldownUntil: null } })
  })

  test("missing token prevents all network calls", async () => {
    let calls = 0
    const result = await redeemOAuthQuotaReset(input, { ...options, store: { async read() { return null }, async write() { return false } }, fetchImpl: async () => { calls++; return Response.json({}) } })
    expect(result).toMatchObject({ ok: false, status: 503, code: "no_token", indeterminate: false })
    expect(calls).toBe(0)
  })

  test("failed or malformed identity prevents every POST", async () => {
    for (const identity of [() => new Response(null, { status: 401 }), () => new Response(null, { status: 429 }), () => Response.json({ organization: {} }), () => Response.json(null), () => { throw new Error("fake network failure") }]) {
      let calls = 0
      const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) => {
        calls++
        expect(init?.method).not.toBe("POST")
        return identity()
      } })
      expect(result.ok).toBe(false)
      expect(calls).toBe(1)
    }
  })

  test("mutation errors never retry or expose upstream bodies", async () => {
    for (const [status, code, indeterminate] of [[401, "upstream_auth", false], [429, "rate_limited", false], [500, "reset_indeterminate", true]] as const) {
      let posts = 0
      const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) => {
        if (init?.method !== "POST") return Response.json({ organization: { uuid: org } })
        posts++
        return new Response("private upstream body", { status })
      } })
      expect(posts).toBe(1)
      expect(result).toMatchObject({ ok: false, code, indeterminate })
      expect(JSON.stringify(result)).not.toContain("private upstream body")
    }
    let posts = 0
    const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) => {
      if (init?.method !== "POST") return Response.json({ organization: { uuid: org } })
      posts++
      throw new DOMException("fake timeout", "TimeoutError")
    } })
    expect(posts).toBe(1)
    expect(result).toMatchObject({ ok: false, code: "reset_indeterminate", indeterminate: true })
  })

  test("unknown or missing primary results and invalid JSON remain indeterminate", async () => {
    for (const response of [() => Response.json({ result: "future" }), () => Response.json({}), () => Response.json(null), () => new Response("not json")]) {
      const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) =>
        init?.method === "POST" ? response() : Response.json({ organization: { uuid: org } }),
      })
      expect(result).toMatchObject({ ok: false, code: "invalid_response", indeterminate: true })
    }
  })

  test("malformed informational metadata cannot obscure a confirmed reset", async () => {
    const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) =>
      Response.json(init?.method === "POST" ? {
        result: "reset", reason: 42, resets_left: -1, cleared: null,
        weekly_resets_at: "2030-01-01T00:00:00", cooldown_until: "bad",
      } : { organization: { uuid: org } }),
    })
    expect(result).toEqual({ ok: true, outcome: {
      result: "reset", reason: null, resetsLeft: null, cleared: [],
      weeklyResetsAt: Date.UTC(2030, 0, 1), cooldownUntil: null,
    } })
  })

  test("metadata normalization preserves only valid counts, strings and dates", async () => {
    for (const resets_left of [undefined, null, "2", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) =>
        Response.json(init?.method === "POST" ? {
          result: "cooldown", reason: "wait", resets_left, cleared: [42, "five_hour", null, "seven_day"],
          weekly_resets_at: {}, cooldown_until: "2030-01-01T02:00:00+02:00",
        } : { organization: { uuid: org } }),
      })
      expect(result).toEqual({ ok: true, outcome: {
        result: "cooldown", reason: "wait", resetsLeft: null, cleared: ["five_hour", "seven_day"],
        weeklyResetsAt: null, cooldownUntil: Date.UTC(2030, 0, 1),
      } })
    }
  })

  test("nonreset outcomes without inventory changes preserve cached usage", async () => {
    await fetchOAuthUsage({ ...options, fetchImpl: async () => Response.json({ five_hour: { utilization: 100 } }) })
    const cached = peekOAuthUsage("work")
    for (const outcome of ["not_limited", "cooldown", "ineligible", "unavailable"]) {
      const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) => Response.json(init?.method === "POST" ? { result: outcome } : { organization: { uuid: org } }) })
      expect(result).toMatchObject({ ok: true, outcome: { result: outcome } })
      expect(peekOAuthUsage("work")).toBe(cached)
    }
    const cooldown = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (_url, init) =>
      Response.json(init?.method === "POST" ? { result: "cooldown", cooldown_until: "2026-11-01T00:00:00Z" } : { organization: { uuid: org } }),
    })
    expect(cooldown).toMatchObject({ ok: true, outcome: { result: "cooldown", cooldownUntil: Date.parse("2026-11-01T00:00:00Z") } })
    expect(peekOAuthUsage("work")).toBe(cached)
  })

  test("already-used grants invalidate selected and default-alias inventory but not other profiles", async () => {
    for (const profileId of ["work", undefined]) {
      const usage = { cedar_ember: { eligible: true, grants: [{ id: "grant_1", resets_left: 1 }] } }
      await fetchOAuthUsage({ ...options, profileId, fetchImpl: async () => Response.json(usage) })
      if (profileId === undefined) await fetchOAuthUsage({ ...options, profileId: "default", fetchImpl: async () => Response.json(usage) })
      await fetchOAuthUsage({ ...options, profileId: "other", fetchImpl: async () => Response.json(usage) })
      const other = peekOAuthUsage("other")
      const result = await redeemOAuthQuotaReset({ ...input, profile: profileId ?? "default" }, {
        ...options, profileId, fetchImpl: async (_url, init) =>
          Response.json(init?.method === "POST" ? { result: "already_used" } : { organization: { uuid: org } }),
      })
      expect(result).toMatchObject({ ok: true, outcome: { result: "already_used" } })
      expect(peekOAuthUsage(profileId)).toBeUndefined()
      if (profileId === undefined) expect(peekOAuthUsage("default")).toBeUndefined()
      expect(peekOAuthUsage("other")).toBe(other)
      let reads = 0
      const refreshed = await fetchOAuthUsage({ ...options, profileId, fetchImpl: async () => {
        reads++
        return Response.json({ cedar_ember: { eligible: true, grants: [] } })
      } })
      expect(reads).toBe(1)
      expect(refreshed?.bankedResets?.grants).toEqual([])
    }
  })

  test("confirmed and uncertain mutations invalidate only the selected account, including unscoped default", async () => {
    for (const profileId of ["work", undefined]) {
      await fetchOAuthUsage({ ...options, profileId, fetchImpl: async () => Response.json({}) })
      if (profileId === undefined) await fetchOAuthUsage({ ...options, profileId: "default", fetchImpl: async () => Response.json({}) })
      await fetchOAuthUsage({ ...options, profileId: "other", fetchImpl: async () => Response.json({}) })
      const other = peekOAuthUsage("other")
      await redeemOAuthQuotaReset({ ...input, profile: profileId ?? "default" }, { ...options, profileId, fetchImpl: async (_url, init) => Response.json(init?.method === "POST" ? { result: "reset" } : { organization: { uuid: org } }) })
      expect(peekOAuthUsage(profileId)).toBeUndefined()
      if (profileId === undefined) expect(peekOAuthUsage("default")).toBeUndefined()
      expect(peekOAuthUsage("other")).toBe(other)
      await fetchOAuthUsage({ ...options, profileId, fetchImpl: async () => Response.json({}) })
      if (profileId === undefined) await fetchOAuthUsage({ ...options, profileId: "default", fetchImpl: async () => Response.json({}) })
      const uncertain = await redeemOAuthQuotaReset({ ...input, profile: profileId ?? "default" }, {
        ...options, profileId, fetchImpl: async (_url, init) => {
          if (init?.method === "POST") throw new Error("Synthetic connection loss")
          return Response.json({ organization: { uuid: org } })
        },
      })
      expect(uncertain).toMatchObject({ ok: false, code: "reset_indeterminate", indeterminate: true })
      expect(peekOAuthUsage(profileId)).toBeUndefined()
      if (profileId === undefined) expect(peekOAuthUsage("default")).toBeUndefined()
      expect(peekOAuthUsage("other")).toBe(other)
    }
  })

  test("a configured profile named default does not invalidate unscoped account usage", async () => {
    await fetchOAuthUsage({ ...options, profileId: undefined, fetchImpl: async () => Response.json({}) })
    await fetchOAuthUsage({ ...options, profileId: "default", fetchImpl: async () => Response.json({}) })
    const unscoped = peekOAuthUsage()
    await redeemOAuthQuotaReset({ ...input, profile: "default" }, {
      ...options, profileId: "default", fetchImpl: async (_url, init) =>
        Response.json(init?.method === "POST" ? { result: "reset" } : { organization: { uuid: org } }),
    })
    expect(peekOAuthUsage("default")).toBeUndefined()
    expect(peekOAuthUsage()).toBe(unscoped)
  })

  test("late pre-invalidation callers join the replacement read without phantom failures", async () => {
    const oldResponse = Promise.withResolvers<Response>()
    const newResponse = Promise.withResolvers<Response>()
    const oldStarted = Promise.withResolvers<void>()
    const newStarted = Promise.withResolvers<void>()
    const old = fetchOAuthUsageResult({ ...options, fetchImpl: async () => {
      oldStarted.resolve()
      return oldResponse.promise
    } })
    await oldStarted.promise
    clearOAuthUsageForProfile("work")
    let newCalls = 0
    const fetchImpl = async () => {
      newCalls++
      newStarted.resolve()
      return newResponse.promise
    }
    const fresh = fetchOAuthUsageResult({ ...options, fetchImpl })
    await newStarted.promise
    oldResponse.resolve(Response.json({ five_hour: { utilization: 100 } }))
    expect(peekOAuthUsage("work")).toBeUndefined()
    const shared = fetchOAuthUsageResult({ ...options, fetchImpl })
    expect(newCalls).toBe(1)
    newResponse.resolve(Response.json({ five_hour: { utilization: 0 } }))
    const results = await Promise.all([old, fresh, shared])
    for (const result of results) {
      expect(result.snapshot?.windows[0]?.utilization).toBe(0)
      expect(result.error).toBeNull()
      expect(result.failure).toBeNull()
      expect(result.lastGood).toBe(result.snapshot)
    }
    expect(newCalls).toBe(1)
    expect(peekOAuthUsage("work")?.windows[0]?.utilization).toBe(0)
  })

  test("a superseded caller starts one current read when no replacement exists", async () => {
    const oldResponse = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<void>()
    let calls = 0
    const old = fetchOAuthUsageResult({ ...options, fetchImpl: async () => {
      calls++
      if (calls === 1) {
        started.resolve()
        return oldResponse.promise
      }
      return Response.json({ five_hour: { utilization: 12 } })
    } })
    await started.promise
    clearOAuthUsageForProfile("work")
    oldResponse.resolve(Response.json({ five_hour: { utilization: 100 } }))
    const result = await old
    expect(calls).toBe(2)
    expect(result.snapshot?.windows[0]?.utilization).toBe(0.12)
    expect(result.error).toBeNull()
    expect(result.failure).toBeNull()
    expect(result.lastGood).toBe(result.snapshot)
    expect(result.snapshot).not.toBeNull()
    expect(peekOAuthUsage("work")).toBe(result.snapshot ?? undefined)
  })
})

describe("the exact redemption request", () => {
  test("posts the explicit grant and request IDs to the token's organization, once", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body: unknown }> = []
    const result = await redeemOAuthQuotaReset(input, { ...options, fetchImpl: async (url, init) => {
      requests.push({
        url, method: init?.method ?? "GET", headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null,
      })
      return Response.json(init?.method === "POST" ? { result: "reset", cleared: ["five_hour"] } : { organization: { uuid: org } })
    } })
    expect(result.ok).toBe(true)
    expect(requests.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      { url: "https://api.anthropic.com/api/oauth/profile", method: "GET", body: null },
      {
        url: `https://api.anthropic.com/api/organizations/${org}/reset_rate_limits`,
        method: "POST",
        body: { program: "cedar_ember", grant_id: "grant_1", request_id: "Request-1" },
      },
    ])
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer fake-selected-token")
      expect(request.headers.get("user-agent")).toBe(oauthUserAgent())
      expect(request.url).not.toContain("cedar_ember=1")
    }
    expect(requests[1]?.headers.get("content-type")).toBe("application/json")
  })
})

describe("single-flight and request-ID replay", () => {
  function countingUpstream(outcome: () => Response | Promise<Response>) {
    const counts = { identity: 0, posts: 0 }
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") {
        counts.identity++
        return Response.json({ organization: { uuid: org } })
      }
      counts.posts++
      return outcome()
    }
    return { counts, fetchImpl }
  }

  test("a second redemption for the same profile while one is in flight sends nothing", async () => {
    const release = Promise.withResolvers<Response>()
    const posted = Promise.withResolvers<void>()
    const { counts, fetchImpl } = countingUpstream(() => {
      posted.resolve()
      return release.promise
    })
    const first = redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })
    await posted.promise
    for (const other of [{ ...input, requestId: "Request-2" }, { ...input, grantId: "grant_2", requestId: "Request-2" }, input]) {
      expect(await redeemOAuthQuotaResetOnce(other, { ...options, fetchImpl })).toEqual({ kind: "in_progress" })
    }
    expect(await redeemOAuthQuotaResetOnce({ ...input, grantId: "grant_2" }, { ...options, fetchImpl })).toEqual({ kind: "request_id_conflict" })
    release.resolve(Response.json({ result: "reset", cleared: ["five_hour"] }))
    expect(await first).toMatchObject({ kind: "settled", replayed: false, result: { ok: true } })
    expect(counts).toEqual({ identity: 1, posts: 1 })
  })

  test("other profiles are not blocked by an in-flight redemption", async () => {
    const release = Promise.withResolvers<Response>()
    const posted = Promise.withResolvers<void>()
    let posts = 0
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ organization: { uuid: org } })
      posts++
      if (posts === 1) {
        posted.resolve()
        return release.promise
      }
      return Response.json({ result: "not_limited" })
    }
    const first = redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })
    await posted.promise
    const other = await redeemOAuthQuotaResetOnce({ ...input, profile: "personal" }, { ...options, profileId: "personal", fetchImpl })
    expect(other).toMatchObject({ kind: "settled", replayed: false, result: { ok: true, outcome: { result: "not_limited" } } })
    release.resolve(Response.json({ result: "reset" }))
    await first
    expect(posts).toBe(2)
  })

  test("a repeated request ID with the same grant replays the settled outcome without an upstream call", async () => {
    const { counts, fetchImpl } = countingUpstream(() => Response.json({ result: "reset", resets_left: 0, cleared: ["five_hour"] }))
    const first = await redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })
    if (first.kind !== "settled") throw new Error("Expected a settled first redemption")
    expect(first.replayed).toBe(false)
    const again = await redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })
    expect(again).toEqual({ kind: "settled", replayed: true, result: first.result })
    expect(counts).toEqual({ identity: 1, posts: 1 })
  })

  test("a repeated request ID with a different grant is a conflict and sends nothing", async () => {
    const { counts, fetchImpl } = countingUpstream(() => Response.json({ result: "not_limited" }))
    await redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })
    expect(await redeemOAuthQuotaResetOnce({ ...input, grantId: "grant_2" }, { ...options, fetchImpl })).toEqual({ kind: "request_id_conflict" })
    expect(counts).toEqual({ identity: 1, posts: 1 })
  })

  test("request IDs are remembered per profile", async () => {
    const { counts, fetchImpl } = countingUpstream(() => Response.json({ result: "not_limited" }))
    await redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })
    const other = await redeemOAuthQuotaResetOnce({ ...input, profile: "personal", grantId: "grant_2" }, { ...options, profileId: "personal", fetchImpl })
    expect(other).toMatchObject({ kind: "settled", replayed: false })
    expect(counts.posts).toBe(2)
  })

  test("indeterminate outcomes are remembered so a blind retry does not re-send", async () => {
    for (const outcome of [
      () => { throw new Error("Synthetic connection loss") },
      () => new Response("unavailable", { status: 503 }),
      () => new Response("not json"),
      () => Response.json({ result: "future" }),
    ]) {
      resetOAuthUsageCache()
      const { counts, fetchImpl } = countingUpstream(outcome)
      const first = await redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })
      expect(first).toMatchObject({ kind: "settled", replayed: false, result: { ok: false, indeterminate: true, dispatched: true } })
      const retry = await redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })
      expect(retry).toMatchObject({ kind: "settled", replayed: true, result: { ok: false, indeterminate: true } })
      expect(retry.kind === "settled" && first.kind === "settled" && retry.result === first.result).toBe(true)
      expect(counts.posts).toBe(1)
    }
  })

  test("definite post-dispatch rejections are replayed too", async () => {
    const { counts, fetchImpl } = countingUpstream(() => new Response(null, { status: 429 }))
    expect(await redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })).toMatchObject({ replayed: false, result: { code: "rate_limited", indeterminate: false } })
    expect(await redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })).toMatchObject({ replayed: true, result: { code: "rate_limited" } })
    expect(counts.posts).toBe(1)
  })

  test("failures before the mutation is sent are not remembered", async () => {
    let identityOk = false
    let posts = 0
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return identityOk ? Response.json({ organization: { uuid: org } }) : new Response(null, { status: 503 })
      posts++
      return Response.json({ result: "reset" })
    }
    expect(await redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })).toMatchObject({ replayed: false, result: { ok: false, code: "upstream_error", dispatched: false } })
    identityOk = true
    expect(await redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })).toMatchObject({ replayed: false, result: { ok: true } })
    expect(posts).toBe(1)
  })

  test("the in-flight claim is released after a thrown credential read", async () => {
    const throwing: CredentialStore = { async read() { throw new Error("Synthetic keychain failure") }, async write() { return false } }
    expect(await redeemOAuthQuotaResetOnce(input, { ...options, store: throwing, fetchImpl: async () => Response.json({}) }))
      .toMatchObject({ kind: "settled", result: { code: "no_token" } })
    const { counts, fetchImpl } = countingUpstream(() => Response.json({ result: "not_limited" }))
    expect(await redeemOAuthQuotaResetOnce({ ...input, requestId: "Request-2" }, { ...options, fetchImpl })).toMatchObject({ kind: "settled", replayed: false })
    expect(counts.posts).toBe(1)
  })

  test("remembered outcomes expire after fifteen minutes", async () => {
    const start = Date.now()
    setSystemTime(new Date(start))
    const { counts, fetchImpl } = countingUpstream(() => Response.json({ result: "not_limited" }))
    await redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })
    setSystemTime(new Date(start + 15 * 60_000 - 1))
    expect(await redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })).toMatchObject({ replayed: true })
    setSystemTime(new Date(start + 15 * 60_000))
    expect(await redeemOAuthQuotaResetOnce(input, { ...options, fetchImpl })).toMatchObject({ replayed: false })
    expect(counts.posts).toBe(2)
  })

  test("the ledger keeps at most 256 outcomes, evicting the oldest", async () => {
    const { counts, fetchImpl } = countingUpstream(() => Response.json({ result: "not_limited" }))
    for (let i = 0; i <= 256; i++) {
      await redeemOAuthQuotaResetOnce({ ...input, requestId: `Request-${i}` }, { ...options, fetchImpl })
    }
    expect(counts.posts).toBe(257)
    expect(await redeemOAuthQuotaResetOnce({ ...input, requestId: "Request-256" }, { ...options, fetchImpl })).toMatchObject({ replayed: true })
    expect(await redeemOAuthQuotaResetOnce({ ...input, requestId: "Request-1" }, { ...options, fetchImpl })).toMatchObject({ replayed: true })
    expect(await redeemOAuthQuotaResetOnce({ ...input, requestId: "Request-0" }, { ...options, fetchImpl })).toMatchObject({ replayed: false })
    expect(counts.posts).toBe(258)
  })
})
