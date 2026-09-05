/**
 * Unit tests for IdleStallTracker — pure, no server or clock needed.
 */
import { describe, it, expect } from "bun:test"
import { IdleStallCeilingError, IdleStallTracker, idleStallRequestKey, idleStallPauseMs } from "../proxy/idleStallCeiling"

const IDLE = 150_000
const SINCE = 150_012

describe("IdleStallTracker", () => {
  it("keeps a first stall retryable", () => {
    const t = new IdleStallTracker(3, 10)
    const v = t.record("sess-a", IDLE, SINCE)
    expect(v.status).toBe(504)
    expect(v.terminal).toBe(false)
    expect(v.consecutive).toBe(1)
  })

  it("counts consecutive stalls on the same session", () => {
    const t = new IdleStallTracker(3, 10)
    expect(t.record("sess-a", IDLE, SINCE).consecutive).toBe(1)
    expect(t.record("sess-a", IDLE, SINCE).consecutive).toBe(2)
    expect(t.record("sess-a", IDLE, SINCE).consecutive).toBe(3)
  })

  // The whole point: a 5xx reads as "transient, try again", so a session that
  // stalls deterministically must stop being told to retry.
  it("turns terminal and non-retryable at the ceiling", () => {
    const t = new IdleStallTracker(3, 10)
    t.record("sess-a", IDLE, SINCE)
    t.record("sess-a", IDLE, SINCE)
    const v = t.record("sess-a", IDLE, SINCE)
    expect(v.terminal).toBe(true)
    expect(v.status).toBe(400)
    expect(v.status).toBeLessThan(500)
    expect(v.type).toBe("invalid_request_error")
  })

  it("preserves its classified verdict through the non-stream error boundary", () => {
    const verdict = new IdleStallTracker(1, 10).record("sess-a", IDLE, SINCE)
    const error = new IdleStallCeilingError(verdict)
    expect(error.verdict).toBe(verdict)
    expect(error.message).toBe(verdict.message)
  })

  it("stays terminal past the ceiling", () => {
    const t = new IdleStallTracker(2, 10)
    t.record("s", IDLE, SINCE)
    expect(t.record("s", IDLE, SINCE).terminal).toBe(true)
    expect(t.record("s", IDLE, SINCE).terminal).toBe(true)
  })

  // A stall that a retry cleared is not evidence of a stuck session.
  it("resets the streak on a completed turn", () => {
    const t = new IdleStallTracker(2, 10)
    t.record("sess-a", IDLE, SINCE)
    t.clear("sess-a")
    const v = t.record("sess-a", IDLE, SINCE)
    expect(v.consecutive).toBe(1)
    expect(v.terminal).toBe(false)
  })

  it("tracks sessions independently", () => {
    const t = new IdleStallTracker(2, 10)
    t.record("sess-a", IDLE, SINCE)
    expect(t.record("sess-b", IDLE, SINCE).consecutive).toBe(1)
    expect(t.record("sess-a", IDLE, SINCE).terminal).toBe(true)
    expect(t.record("sess-b", IDLE, SINCE).terminal).toBe(true)
  })

  // Pooling identity-less turns under a shared "" key would let unrelated
  // sessions trip each other's ceiling.
  it("never accumulates across turns with no session identity", () => {
    const t = new IdleStallTracker(2, 10)
    expect(t.record("", IDLE, SINCE).consecutive).toBe(1)
    expect(t.record("", IDLE, SINCE).consecutive).toBe(1)
    expect(t.record("", IDLE, SINCE).terminal).toBe(false)
  })

  it("disables the ceiling at 0, preserving the pre-ceiling 504", () => {
    const t = new IdleStallTracker(0, 10)
    for (let i = 0; i < 25; i++) {
      const v = t.record("sess-a", IDLE, SINCE)
      expect(v.status).toBe(504)
      expect(v.terminal).toBe(false)
    }
  })

  it("bounds its own memory", () => {
    const t = new IdleStallTracker(3, 4)
    for (let i = 0; i < 100; i++) t.record(`sess-${i}`, IDLE, SINCE)
    expect(t.streak("sess-99")).toBe(1)
    expect(t.streak("sess-0")).toBe(0)
  })

  // Evicting a live session must not carry a stale streak back in.
  it("restarts an evicted session's streak from one", () => {
    const t = new IdleStallTracker(3, 2)
    t.record("sess-a", IDLE, SINCE)
    t.record("sess-b", IDLE, SINCE)
    t.record("sess-c", IDLE, SINCE)
    expect(t.record("sess-a", IDLE, SINCE).consecutive).toBe(1)
  })

  it("reports the stall duration and remediation in the terminal message", () => {
    const t = new IdleStallTracker(1, 10)
    const v = t.record("sess-a", IDLE, SINCE)
    expect(v.message).toContain(String(SINCE))
    expect(v.message).toContain("MERIDIAN_UPSTREAM_IDLE_MS")
  })

  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [4, "4th"],
    [11, "11th"],
    [21, "21st"],
  ])("ordinalises %i as %s", (n, expected) => {
    const t = new IdleStallTracker(1, 50)
    let v = t.record("s", IDLE, SINCE)
    for (let i = 1; i < n; i++) v = t.record("s", IDLE, SINCE)
    expect(v.message).toContain(`the ${expected} consecutive stall`)
  })
})


describe("idle retry preflight", () => {
  it("stops identical terminal retries before another query and does not extend the pause", () => {
    const tracker = new IdleStallTracker(2, 10)
    const key = idleStallRequestKey({ messages: [{ role: "user", content: "hello" }] })
    tracker.record("client", 90_000, 90_001, { key, now: 100 })
    expect(tracker.preflight("client", key, 90_000, 200)).toBeUndefined()
    tracker.record("client", 90_000, 90_001, { key, now: 300 })
    expect(tracker.preflight("client", key, 90_000, 400)?.status).toBe(400)
    expect(tracker.preflight("client", key, 90_000, 90_299)?.terminal).toBe(true)
    expect(tracker.preflight("client", key, 90_000, 90_300)).toBeUndefined()
    expect(tracker.streak("client")).toBe(0)
  })

  it("allows a changed turn immediately and starts its own streak", () => {
    const tracker = new IdleStallTracker(1, 10)
    tracker.record("client", IDLE, SINCE, { key: "old", now: 0 })
    expect(tracker.preflight("client", "new", IDLE, 1)).toBeUndefined()
    expect(tracker.streak("client")).toBe(0)
    expect(tracker.record("client", IDLE, SINCE, { key: "new", now: 2 }).consecutive).toBe(1)
  })

  it("does not accumulate changed request records when preflight is bypassed", () => {
    const tracker = new IdleStallTracker(2, 10)
    tracker.record("client", IDLE, SINCE, { key: "old", now: 0 })
    expect(tracker.record("client", IDLE, SINCE, { key: "new", now: 1 }).terminal).toBe(false)
  })

  it("allows recovery after a completed turn", () => {
    const tracker = new IdleStallTracker(1, 10)
    tracker.record("client", IDLE, SINCE, { key: "same", now: 0 })
    tracker.clear("client")
    expect(tracker.preflight("client", "same", IDLE, 1)).toBeUndefined()
  })

  it("never blocks another profile/session or an unidentified request", () => {
    const tracker = new IdleStallTracker(1, 10)
    tracker.record("profile-a:client", IDLE, SINCE, { key: "same", now: 0 })
    expect(tracker.preflight("profile-b:client", "same", IDLE, 1)).toBeUndefined()
    tracker.record("", IDLE, SINCE, { key: "same", now: 0 })
    expect(tracker.preflight("", "same", IDLE, 1)).toBeUndefined()
  })

  it("keeps disabled ceilings retryable", () => {
    const tracker = new IdleStallTracker(0, 10)
    tracker.record("client", IDLE, SINCE, { key: "same", now: 0 })
    expect(tracker.preflight("client", "same", IDLE, 1)).toBeUndefined()
  })

  it("leaves a backoff interval even with a short idle guard", () => {
    expect(idleStallPauseMs(50)).toBe(60_000)
    expect(idleStallPauseMs(IDLE)).toBe(IDLE)
  })

  it("includes model, tools, prompt and message changes in request identity", () => {
    const body = { model: "haiku", system: "context", tools: [], messages: [{ role: "user", content: "hello" }] }
    const key = idleStallRequestKey(body)
    expect(idleStallRequestKey(structuredClone(body))).toBe(key)
    expect(idleStallRequestKey({ ...body, model: "sonnet" })).not.toBe(key)
    expect(idleStallRequestKey({ ...body, system: "changed" })).not.toBe(key)
    expect(idleStallRequestKey({ ...body, tools: [{ name: "read" }] })).not.toBe(key)
    expect(idleStallRequestKey({ ...body, messages: [{ role: "user", content: "revised" }] })).not.toBe(key)
  })
})
