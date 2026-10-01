/**
 * Unit tests for the prompt-cache keepalive schedule.
 *
 * Pure module, no mocks: when a keepalive is due, which session's clock it
 * follows, and how the scheduler starts, serializes, retries and stops them.
 */
import { describe, it, expect } from "bun:test"
import {
  CacheKeepaliveScheduler,
  decideCacheKeepalive,
  parseCacheKeepaliveWindow,
} from "../proxy/cacheKeepalive"

const MIN = 60_000
const TTL = 5 * MIN
const LEAD = MIN

describe("parseCacheKeepaliveWindow", () => {
  it("reads whole seconds and clamps them to the operator maximum", () => {
    expect(parseCacheKeepaliveWindow("1800", 3600)).toBe(1800_000)
    expect(parseCacheKeepaliveWindow(" 7200 ", 3600)).toBe(3600_000)
  })

  it("leaves the session opted out for anything else", () => {
    for (const value of [undefined, "", "0", "-5", "30m", "1.5", "abc"]) {
      expect(parseCacheKeepaliveWindow(value, 3600)).toBeUndefined()
    }
    expect(parseCacheKeepaliveWindow("1800", 0)).toBeUndefined()
  })
})

describe("decideCacheKeepalive", () => {
  const state = { lastRequestAt: 0, windowEndsAt: 30 * MIN }

  it("beats only inside the lead before the prefix would expire", () => {
    expect(decideCacheKeepalive(state, "s1", TTL - LEAD - 1, TTL, LEAD)).toBe("wait")
    expect(decideCacheKeepalive(state, "s1", TTL - LEAD, TTL, LEAD)).toBe("beat")
    expect(decideCacheKeepalive(state, "s1", TTL - 1, TTL, LEAD)).toBe("beat")
  })

  it("does not refresh a prefix that has already expired", () => {
    expect(decideCacheKeepalive(state, "s1", TTL, TTL, LEAD)).toBe("expire")
  })

  it("stops once the window since the latest request has passed", () => {
    const beaten = { ...state, lastBeat: { sessionId: "s1", at: 29 * MIN } }
    expect(decideCacheKeepalive(beaten, "s1", 30 * MIN, TTL, LEAD)).toBe("expire")
  })

  it("waits while the session has no published mapping", () => {
    expect(decideCacheKeepalive(state, undefined, TTL - LEAD, TTL, LEAD)).toBe("wait")
  })

  it("counts a keepalive only for the session it refreshed", () => {
    const beaten = { ...state, lastBeat: { sessionId: "old", at: 4 * MIN } }
    // Still the same mapping: the keepalive moved its clock.
    expect(decideCacheKeepalive(beaten, "old", 5 * MIN, TTL, LEAD)).toBe("wait")
    // A turn that started at 0 published a new session: its prefix was
    // written at 0, so it is due now even though the old one was refreshed.
    expect(decideCacheKeepalive(beaten, "new", 4.5 * MIN, TTL, LEAD)).toBe("beat")
  })

  it("follows the start of the latest request, not its end", () => {
    const later = { lastRequestAt: 3 * MIN, windowEndsAt: 33 * MIN, lastBeat: { sessionId: "s1", at: 0 } }
    expect(decideCacheKeepalive(later, "s1", 6 * MIN, TTL, LEAD)).toBe("wait")
    expect(decideCacheKeepalive(later, "s1", 7 * MIN, TTL, LEAD)).toBe("beat")
  })

  it("waits out the settle period after the mapping moves to a new session", () => {
    const seen = { ...state, sessionSeen: { sessionId: "s1", at: TTL - LEAD } }
    expect(decideCacheKeepalive(seen, "s1", TTL - LEAD + 14_999, TTL, LEAD, 15_000)).toBe("wait")
    expect(decideCacheKeepalive(seen, "s1", TTL - LEAD + 15_000, TTL, LEAD, 15_000)).toBe("beat")
    // The settle belongs to the session that was published, not a later one.
    expect(decideCacheKeepalive(seen, "s2", TTL - LEAD + 1, TTL, LEAD, 15_000)).toBe("beat")
  })

  it("holds off until the retry time after a failed keepalive", () => {
    const failed = { ...state, retryAt: TTL - LEAD + 30_000 }
    expect(decideCacheKeepalive(failed, "s1", TTL - LEAD, TTL, LEAD)).toBe("wait")
    expect(decideCacheKeepalive(failed, "s1", TTL - LEAD + 30_000, TTL, LEAD)).toBe("beat")
  })
})

describe("CacheKeepaliveScheduler", () => {
  function harness(results: Array<boolean | Error> = []) {
    let now = 0
    let current: string | undefined = "s1"
    const beats: Array<{ recipe: string; sessionId: string; signal: AbortSignal }> = []
    const settle: Array<() => void> = []
    const scheduler = new CacheKeepaliveScheduler<string>({
      now: () => now,
      currentSessionId: () => current,
      beat: (recipe, sessionId, signal) => {
        beats.push({ recipe, sessionId, signal })
        const result = results.shift() ?? true
        return new Promise<boolean>((resolve, reject) => {
          settle.push(() => result instanceof Error ? reject(result) : resolve(result))
        })
      },
      retryMs: 30_000,
    })
    return {
      scheduler,
      beats,
      settleAll: async () => {
        for (const fn of settle.splice(0)) fn()
        await Promise.resolve()
        await Promise.resolve()
      },
      at: (ms: number) => { now = ms },
      publish: (sessionId: string | undefined) => { current = sessionId },
    }
  }

  it("beats the current session with the latest recipe", () => {
    const h = harness()
    h.scheduler.noteRequest("k", "first", 30 * MIN, 0)
    h.scheduler.noteRequest("k", "second", 30 * MIN, 0)
    h.at(3 * MIN)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(0)
    h.at(4 * MIN)
    h.scheduler.tick()
    expect(h.beats.map(b => [b.recipe, b.sessionId])).toEqual([["second", "s1"]])
  })

  it("never runs two keepalives for one session at once", async () => {
    const h = harness()
    h.scheduler.noteRequest("k", "r", 30 * MIN, 0)
    h.at(4 * MIN)
    h.scheduler.tick()
    h.scheduler.tick()
    expect(h.beats).toHaveLength(1)
    expect(h.scheduler.inFlight).toBe(1)
    await h.settleAll()
    expect(h.scheduler.inFlight).toBe(0)
  })

  it("keeps an idle session warm until its window ends", async () => {
    const h = harness()
    h.scheduler.noteRequest("k", "r", 30 * MIN, 0)
    const beatTimes: number[] = []
    for (let t = 0; t <= 40 * MIN; t += 10_000) {
      h.at(t)
      const before = h.beats.length
      h.scheduler.tick()
      if (h.beats.length > before) beatTimes.push(t)
      await h.settleAll()
    }
    expect(beatTimes).toEqual([4, 8, 12, 16, 20, 24, 28].map(m => m * MIN))
    expect(h.scheduler.size).toBe(0)
  })

  it("retries a keepalive that never reached upstream, without moving the clock", async () => {
    const h = harness([false, true])
    h.scheduler.noteRequest("k", "r", 30 * MIN, 0)
    h.at(4 * MIN)
    h.scheduler.tick()
    await h.settleAll()
    h.at(4 * MIN + 20_000)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(1)
    h.at(4 * MIN + 30_000)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(2)
  })

  it("treats a thrown keepalive like one that never reached upstream", async () => {
    const h = harness([new Error("spawn failed")])
    h.scheduler.noteRequest("k", "r", 30 * MIN, 0)
    h.at(4 * MIN)
    h.scheduler.tick()
    await h.settleAll()
    h.at(4 * MIN + 30_000)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(2)
  })

  it("follows the mapping to the session a finished turn published", async () => {
    const h = harness()
    h.scheduler.noteRequest("k", "r", 30 * MIN, 0)
    // A long turn starts at 1m and keeps generating.
    h.scheduler.noteRequest("k", "r", 30 * MIN, MIN)
    h.at(5 * MIN)
    h.scheduler.tick()
    expect(h.beats.map(b => b.sessionId)).toEqual(["s1"])
    await h.settleAll()
    // It publishes at 5.5m. Its prefix was written at 1m, so it is due once
    // the client has had the settle period to send its next turn instead.
    h.publish("s2")
    h.at(5.5 * MIN)
    h.scheduler.tick()
    expect(h.beats.map(b => b.sessionId)).toEqual(["s1"])
    h.at(5.5 * MIN + 15_000)
    h.scheduler.tick()
    expect(h.beats.map(b => b.sessionId)).toEqual(["s1", "s2"])
  })

  it("aborts running keepalives on stop and counts them until they settle", async () => {
    const h = harness()
    h.scheduler.noteRequest("k", "r", 30 * MIN, 0)
    h.at(4 * MIN)
    h.scheduler.tick()
    h.scheduler.stop()
    expect(h.beats[0]!.signal.aborted).toBe(true)
    expect(h.scheduler.inFlight).toBe(1)
    await h.settleAll()
    expect(h.scheduler.inFlight).toBe(0)
    h.scheduler.noteRequest("k", "r", 30 * MIN, 4 * MIN)
    h.at(9 * MIN)
    h.scheduler.tick()
    expect(h.beats).toHaveLength(1)
  })
  it("leaves a long first turn's session to the client's immediate next turn", () => {
    // 9/30 trace: a first turn started at 0, ran almost the whole TTL and
    // published inside the lead; the client sent its next turn 2 s later.
    const h = harness()
    h.publish(undefined)
    h.scheduler.noteRequest("k", "r", 30 * MIN, 0)
    for (let t = 0; t < 4 * MIN + 50_000; t += 10_000) { h.at(t); h.scheduler.tick() }
    h.publish("s1")
    h.at(4 * MIN + 58_000)
    h.scheduler.tick()
    h.scheduler.noteRequest("k", "r", 30 * MIN, 4 * MIN + 60_000)
    for (let t = 5 * MIN; t < 8 * MIN; t += 10_000) { h.at(t); h.scheduler.tick() }
    expect(h.beats).toHaveLength(0)
  })

  it("still refreshes a newly published session the client leaves idle", () => {
    const h = harness()
    h.publish(undefined)
    h.scheduler.noteRequest("k", "r", 30 * MIN, 0)
    h.at(3 * MIN + 50_000)
    h.scheduler.tick()
    h.publish("s1")
    for (const t of [4 * MIN, 4 * MIN + 10_000]) { h.at(t); h.scheduler.tick() }
    expect(h.beats).toHaveLength(0)
    h.at(4 * MIN + 20_000)
    h.scheduler.tick()
    expect(h.beats.map(b => b.sessionId)).toEqual(["s1"])
  })
})

