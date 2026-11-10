/**
 * Unit tests for the prompt-cache keepalive schedule.
 *
 * Pure module, no mocks: which sessions are eligible, when a beat is due,
 * which session's clock it follows, which accounts may be beaten, and how the
 * scheduler starts, caps, retries and stops beats.
 */
import { describe, it, expect } from "bun:test"
import {
  CACHE_KEEPALIVE_SOURCE,
  CacheKeepaliveScheduler,
  cacheKeepaliveAccountBlock,
  classifyCacheTier,
  decideCacheKeepalive,
  resolveCacheKeepaliveEnabled,
  resolveCacheKeepaliveMaxInFlight,
  resolveCacheKeepaliveMode,
  type CacheKeepaliveAccountFacts,
  type CacheKeepaliveBeatOutcome,
  type CacheTier,
} from "../proxy/cacheKeepalive"
import { CACHE_KEEPALIVE_REQUEST_SOURCE } from "../telemetry/percentiles"

const MIN = 60_000
const HOUR = 60 * MIN
const INTERVAL = 55 * MIN
const timing = { intervalMs: INTERVAL, ttlMs: HOUR, maxBeats: 3, settleMs: 15_000 }

describe("resolveCacheKeepaliveEnabled", () => {
  it("is off by default", () => {
    expect(resolveCacheKeepaliveEnabled(undefined, () => undefined)).toBe(false)
    expect(resolveCacheKeepaliveEnabled("", () => undefined)).toBe(false)
  })

  it("follows the setting when the environment does not decide", () => {
    expect(resolveCacheKeepaliveEnabled(undefined, () => true)).toBe(true)
    expect(resolveCacheKeepaliveEnabled("maybe", () => true)).toBe(true)
    expect(resolveCacheKeepaliveEnabled(undefined, () => "true")).toBe(false)
  })

  it("lets the environment force either way", () => {
    for (const on of ["1", "true", "YES", "on"]) expect(resolveCacheKeepaliveEnabled(on, () => false)).toBe(true)
    for (const off of ["0", "false", "no", "OFF"]) expect(resolveCacheKeepaliveEnabled(off, () => true)).toBe(false)
  })
})

describe("resolveCacheKeepaliveMode", () => {
  it("reads client mode from the environment or the setting", () => {
    expect(resolveCacheKeepaliveMode("client", () => false)).toBe("client")
    expect(resolveCacheKeepaliveMode(undefined, () => "client")).toBe("client")
    expect(resolveCacheKeepaliveMode("1", () => "client")).toBe("auto")
    expect(resolveCacheKeepaliveMode("0", () => "client")).toBe("off")
    expect(resolveCacheKeepaliveEnabled("client", () => false)).toBe(true)
  })
})

describe("resolveCacheKeepaliveMaxInFlight", () => {
  it("defaults to one and never exceeds two", () => {
    expect(resolveCacheKeepaliveMaxInFlight(undefined)).toBe(1)
    expect(resolveCacheKeepaliveMaxInFlight(0)).toBe(1)
    expect(resolveCacheKeepaliveMaxInFlight(2)).toBe(2)
    expect(resolveCacheKeepaliveMaxInFlight(50)).toBe(2)
  })
})

describe("classifyCacheTier", () => {
  it("reads the tier from the usage's cache_creation breakdown", () => {
    // Measured 2026-10-26 on a Max account through the Agent SDK.
    expect(classifyCacheTier({
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 42_663, ephemeral_5m_input_tokens: 0 },
    })).toBe("1h")
    expect(classifyCacheTier({
      cache_read_input_tokens: 42_663,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 110 },
    })).toBe("5m")
  })

  it("treats any five-minute write as the five-minute tier", () => {
    expect(classifyCacheTier({
      cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 10 },
    })).toBe("5m")
  })

  it("separates a pure cache read from a turn with no cache information", () => {
    expect(classifyCacheTier({
      cache_read_input_tokens: 9_000,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    })).toBe("read")
    expect(classifyCacheTier({ cache_read_input_tokens: 9_000 })).toBe("none")
    expect(classifyCacheTier(undefined)).toBe("none")
  })
})

describe("cacheKeepaliveAccountBlock", () => {
  const now = 1_000_000
  const healthy: CacheKeepaliveAccountFacts = {
    profileType: "claude-max",
    rateLimits: [{ status: "allowed", utilization: 0.4, resetsAt: now + HOUR }],
    coolingDown: false,
    spent: false,
    benched: false,
    now,
  }

  it("allows a healthy subscription account", () => {
    expect(cacheKeepaliveAccountBlock(healthy)).toBeUndefined()
  })

  it("never beats an API-key or token profile", () => {
    expect(cacheKeepaliveAccountBlock({ ...healthy, profileType: "api" })).toBe("not-subscription")
    expect(cacheKeepaliveAccountBlock({ ...healthy, profileType: "oauth-token" })).toBe("not-subscription")
  })

  it("never beats an account on Extra Usage", () => {
    expect(cacheKeepaliveAccountBlock({
      ...healthy,
      rateLimits: [{ status: "allowed", isUsingOverage: true, resetsAt: now + HOUR }],
    })).toBe("overage")
  })

  it("never beats a rate-limited, cooling-down, spent or benched account", () => {
    expect(cacheKeepaliveAccountBlock({
      ...healthy,
      rateLimits: [{ status: "rejected", resetsAt: now + HOUR }],
    })).toBe("rate-limited")
    expect(cacheKeepaliveAccountBlock({
      ...healthy,
      rateLimits: [{ status: "allowed_warning", utilization: 1, resetsAt: now + HOUR }],
    })).toBe("rate-limited")
    expect(cacheKeepaliveAccountBlock({ ...healthy, coolingDown: true })).toBe("cooldown")
    expect(cacheKeepaliveAccountBlock({ ...healthy, spent: true })).toBe("spent")
    expect(cacheKeepaliveAccountBlock({ ...healthy, benched: true })).toBe("benched")
  })

  it("never beats an account holding its weekly reserve", () => {
    expect(cacheKeepaliveAccountBlock({ ...healthy, reserveHeld: true })).toBe("reserve")
    expect(cacheKeepaliveAccountBlock({ ...healthy, reserveHeld: false })).toBeUndefined()
  })

  it("ignores windows that have already reset", () => {
    expect(cacheKeepaliveAccountBlock({
      ...healthy,
      rateLimits: [{ status: "rejected", isUsingOverage: true, resetsAt: now - 1 }],
    })).toBeUndefined()
  })
})

describe("decideCacheKeepalive", () => {
  const state = { lastTurnAt: 0, beats: 0 }

  it("beats only between 55 minutes and the hour since the turn", () => {
    expect(decideCacheKeepalive(state, "s1", INTERVAL - 1, timing)).toBe("wait")
    expect(decideCacheKeepalive(state, "s1", INTERVAL, timing)).toBe("beat")
    expect(decideCacheKeepalive(state, "s1", HOUR - 1, timing)).toBe("beat")
  })

  it("does not refresh a prefix that has already expired", () => {
    expect(decideCacheKeepalive(state, "s1", HOUR, timing)).toBe("expire")
  })

  it("stops after the idle period's last beat", () => {
    const spent = { lastTurnAt: 0, beats: 3, lastBeat: { sessionId: "s1", at: 3 * INTERVAL } }
    expect(decideCacheKeepalive(spent, "s1", 4 * INTERVAL, timing)).toBe("expire")
  })

  it("waits while the session has no published mapping", () => {
    expect(decideCacheKeepalive(state, undefined, INTERVAL, timing)).toBe("wait")
  })

  it("counts a beat only for the session it refreshed", () => {
    const beaten = { ...state, beats: 1, lastBeat: { sessionId: "old", at: INTERVAL } }
    // Still the same mapping: the beat moved its clock.
    expect(decideCacheKeepalive(beaten, "old", HOUR, timing)).toBe("wait")
    expect(decideCacheKeepalive(beaten, "old", 2 * INTERVAL, timing)).toBe("beat")
    // A different session's prefix was written by the turn at 0.
    expect(decideCacheKeepalive(beaten, "new", HOUR, timing)).toBe("expire")
  })

  it("waits out the settle period after the mapping moves to a new session", () => {
    const seen = { ...state, sessionSeen: { sessionId: "s1", at: INTERVAL } }
    expect(decideCacheKeepalive(seen, "s1", INTERVAL + 14_999, timing)).toBe("wait")
    expect(decideCacheKeepalive(seen, "s1", INTERVAL + 15_000, timing)).toBe("beat")
    // The settle belongs to the session that was published, not a later one.
    expect(decideCacheKeepalive(seen, "s2", INTERVAL + 1, timing)).toBe("beat")
  })

  it("holds off until the retry time after a beat that did not run", () => {
    const failed = { ...state, retryAt: INTERVAL + 30_000 }
    expect(decideCacheKeepalive(failed, "s1", INTERVAL, timing)).toBe("wait")
    expect(decideCacheKeepalive(failed, "s1", INTERVAL + 30_000, timing)).toBe("beat")
  })
})

describe("CacheKeepaliveScheduler", () => {
  function harness(results: Array<CacheKeepaliveBeatOutcome | Error> = [], options: { maxInFlight?: number; enabled?: () => boolean; autoBeats?: () => boolean } = {}) {
    let now = 0
    let current: string | undefined = "s1"
    const beats: Array<{ recipe: string; sessionId: string; signal: AbortSignal; at: number }> = []
    const settle: Array<() => void> = []
    const scheduler = new CacheKeepaliveScheduler<string>({
      now: () => now,
      currentSessionId: () => current,
      beat: (recipe, sessionId, signal) => {
        beats.push({ recipe, sessionId, signal, at: now })
        const result = results.shift() ?? "reached"
        return new Promise<CacheKeepaliveBeatOutcome>((resolve, reject) => {
          settle.push(() => result instanceof Error ? reject(result) : resolve(result))
        })
      },
      retryMs: 30_000,
      ...options,
    })
    const turn = (key: string, recipe: string, startedAt: number, tier: CacheTier) => {
      scheduler.noteTurnStart(key, startedAt)
      scheduler.noteTurnEnd(key, { recipe, startedAt, tier })
    }
    return {
      scheduler,
      beats,
      turn,
      settleAll: async () => {
        for (const fn of settle.splice(0)) fn()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      },
      at: (ms: number) => { now = ms },
      publish: (sessionId: string | undefined) => { current = sessionId },
    }
  }

  async function runIdle(h: ReturnType<typeof harness>, until: number): Promise<number[]> {
    const times: number[] = []
    for (let t = 0; t <= until; t += 10_000) {
      h.at(t)
      const before = h.beats.length
      h.scheduler.tick()
      if (h.beats.length > before) times.push(t)
      await h.settleAll()
    }
    return times
  }

  it("tracks a session only when its turn wrote the one-hour tier", () => {
    const h = harness()
    h.turn("five", "r", 0, "5m")
    h.turn("none", "r", 0, "none")
    h.turn("read", "r", 0, "read")
    expect(h.scheduler.size).toBe(0)
    h.turn("hour", "r", 0, "1h")
    expect(h.scheduler.size).toBe(1)
  })

  it("stops tracking when a later turn falls to the five-minute tier or fails", () => {
    const h = harness()
    h.turn("k", "r", 0, "1h")
    h.turn("k", "r", MIN, "read")
    expect(h.scheduler.size).toBe(1)
    h.turn("k", "r", 2 * MIN, "5m")
    expect(h.scheduler.size).toBe(0)
    h.turn("k", "r", 3 * MIN, "1h")
    h.turn("k", "r", 4 * MIN, "none")
    expect(h.scheduler.size).toBe(0)
  })

  it("beats every 55 minutes while idle, at most three times, then lets the cache expire", async () => {
    const h = harness()
    h.turn("k", "r", 0, "1h")
    const times = await runIdle(h, 5 * HOUR)
    expect(times).toEqual([INTERVAL, 2 * INTERVAL, 3 * INTERVAL])
    expect(h.scheduler.size).toBe(0)
  })

  it("beats the current session with the latest turn's recipe", () => {
    const h = harness()
    h.turn("k", "first", 0, "1h")
    h.turn("k", "second", 0, "read")
    h.at(INTERVAL - 10_000)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(0)
    h.at(INTERVAL)
    h.scheduler.tick()
    expect(h.beats.map(b => [b.recipe, b.sessionId])).toEqual([["second", "s1"]])
  })

  it("starts a new idle period from a real turn", async () => {
    const h = harness()
    h.turn("k", "r", 0, "1h")
    h.at(INTERVAL)
    h.scheduler.tick()
    await h.settleAll()
    expect(h.beats).toHaveLength(1)
    // The user comes back 30 minutes later.
    h.turn("k", "r", INTERVAL + 30 * MIN, "1h")
    const times: number[] = []
    for (let t = INTERVAL + 30 * MIN; t <= INTERVAL + 30 * MIN + 4 * HOUR; t += 10_000) {
      h.at(t)
      const before = h.beats.length
      h.scheduler.tick()
      if (h.beats.length > before) times.push(t - (INTERVAL + 30 * MIN))
      await h.settleAll()
    }
    expect(times).toEqual([INTERVAL, 2 * INTERVAL, 3 * INTERVAL])
  })

  it("never beats while a real turn on the session is running", () => {
    const h = harness()
    h.turn("k", "r", 0, "1h")
    h.scheduler.noteTurnStart("k", INTERVAL - MIN)
    h.at(INTERVAL + 2 * MIN)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(0)
    h.scheduler.noteTurnEnd("k", { recipe: "r", startedAt: INTERVAL - MIN, tier: "1h" })
    h.scheduler.tick()
    expect(h.beats).toHaveLength(0)
    h.at(2 * INTERVAL - MIN)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(1)
  })

  it("does not count a beat that a real turn overtook", async () => {
    const h = harness()
    h.turn("k", "r", 0, "1h")
    h.at(INTERVAL)
    h.scheduler.tick()
    h.turn("k", "r", INTERVAL + 1_000, "1h")
    await h.settleAll()
    // Due 55 minutes after the turn, not after the beat it overtook.
    h.at(INTERVAL + 1_000 + INTERVAL - 10_000)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(1)
    h.at(INTERVAL + 1_000 + INTERVAL)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(2)
  })

  it("runs at most one beat at a time across every session by default", async () => {
    const h = harness()
    h.turn("a", "ra", 0, "1h")
    h.turn("b", "rb", 0, "1h")
    h.at(INTERVAL)
    h.scheduler.tick()
    h.scheduler.tick()
    expect(h.beats.map(b => b.recipe)).toEqual(["ra"])
    expect(h.scheduler.inFlight).toBe(1)
    await h.settleAll()
    h.scheduler.tick()
    expect(h.beats.map(b => b.recipe)).toEqual(["ra", "rb"])
  })

  it("honors a larger in-flight cap", () => {
    const h = harness([], { maxInFlight: 2 })
    h.turn("a", "ra", 0, "1h")
    h.turn("b", "rb", 0, "1h")
    h.turn("c", "rc", 0, "1h")
    h.at(INTERVAL)
    h.scheduler.tick()
    expect(h.beats.map(b => b.recipe)).toEqual(["ra", "rb"])
  })

  it("retries a beat that did not run, without moving the clock or counting it", async () => {
    const h = harness(["retry", "reached"])
    h.turn("k", "r", 0, "1h")
    h.at(INTERVAL)
    h.scheduler.tick()
    await h.settleAll()
    h.at(INTERVAL + 20_000)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(1)
    h.at(INTERVAL + 30_000)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(2)
    await h.settleAll()
    // The reached beat anchors the next one.
    h.at(INTERVAL + 30_000 + INTERVAL - 10_000)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(2)
  })

  it("treats a thrown beat like one that did not run", async () => {
    const h = harness([new Error("spawn failed")])
    h.turn("k", "r", 0, "1h")
    h.at(INTERVAL)
    h.scheduler.tick()
    await h.settleAll()
    h.at(INTERVAL + 30_000)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(2)
  })

  it("stops tracking when a beat says the session is not worth keeping warm", async () => {
    const h = harness(["stop"])
    h.turn("k", "r", 0, "1h")
    h.at(INTERVAL)
    h.scheduler.tick()
    await h.settleAll()
    expect(h.scheduler.size).toBe(0)
  })

  it("leaves a newly published session to the client's next turn first", () => {
    const h = harness()
    h.publish(undefined)
    h.turn("k", "r", 0, "1h")
    for (let t = 0; t < INTERVAL + 50_000; t += 10_000) { h.at(t); h.scheduler.tick() }
    h.publish("s1")
    h.at(INTERVAL + 58_000)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(0)
    h.at(INTERVAL + 73_000)
    h.scheduler.tick()
    expect(h.beats.map(b => b.sessionId)).toEqual(["s1"])
  })

  it("drops everything and beats nothing once the operator switches it off", () => {
    let on = true
    const h = harness([], { enabled: () => on })
    h.turn("k", "r", 0, "1h")
    on = false
    h.at(INTERVAL)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(0)
    expect(h.scheduler.size).toBe(0)
  })

  it("aborts running beats on stop and counts them until they settle", async () => {
    const h = harness()
    h.turn("k", "r", 0, "1h")
    h.at(INTERVAL)
    h.scheduler.tick()
    h.scheduler.stop()
    expect(h.beats[0]!.signal.aborted).toBe(true)
    expect(h.scheduler.inFlight).toBe(1)
    await h.settleAll()
    expect(h.scheduler.inFlight).toBe(0)
    h.turn("k", "r", INTERVAL, "1h")
    h.at(2 * INTERVAL)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(1)
  })

  describe("client mode", () => {
    const client = () => harness([], { autoBeats: () => false })

    it("never beats on its own, and forgets a session once its cache has expired", async () => {
      const h = client()
      h.turn("codex:k", "r", 0, "1h")
      const times = await runIdle(h, HOUR - 10_000)
      expect(times).toEqual([])
      expect(h.scheduler.size).toBe(1)
      h.at(HOUR)
      h.scheduler.tick()
      expect(h.scheduler.size).toBe(0)
    })

    it("beats on request past the automatic cap, each beat extending the cache", async () => {
      const h = client()
      h.turn("codex:k", "r", 0, "1h")
      const outcomes: string[] = []
      for (let beat = 1; beat <= 5; beat++) {
        h.at(beat * 50 * MIN)
        const pending = h.scheduler.beatNow("codex:k")
        await h.settleAll()
        outcomes.push(await pending)
      }
      expect(outcomes).toEqual(["reached", "reached", "reached", "reached", "reached"])
      h.at(5 * 50 * MIN + HOUR - 10_000)
      h.scheduler.tick()
      expect(h.scheduler.size).toBe(1)
    })

    it("refuses to beat an expired cache, an untracked key or a session mid-turn", async () => {
      const h = client()
      expect(await h.scheduler.beatNow("codex:none")).toBe("untracked")
      h.turn("codex:k", "r", 0, "1h")
      h.scheduler.noteTurnStart("codex:k", MIN)
      expect(await h.scheduler.beatNow("codex:k")).toBe("busy")
      h.scheduler.noteTurnEnd("codex:k", { recipe: "r", startedAt: MIN, tier: "read" })
      h.at(MIN + HOUR)
      expect(await h.scheduler.beatNow("codex:k")).toBe("expired")
      expect(h.beats).toHaveLength(0)
    })

    it("finds tracked keys by the client's session id", () => {
      const h = client()
      h.turn("codex:abc", "r", 0, "1h")
      h.turn("opencode:other", "r", 0, "1h")
      expect(h.scheduler.keysForSession("abc")).toEqual(["codex:abc"])
    })
  })

  it("labels beats with the source telemetry excludes", () => {
    expect(CACHE_KEEPALIVE_SOURCE).toBe(CACHE_KEEPALIVE_REQUEST_SOURCE)
  })
})
