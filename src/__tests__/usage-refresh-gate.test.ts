import { describe, expect, it } from "bun:test"
import { USAGE_REFRESH_MIN_INTERVAL_MS, UsageRefreshGate, claudeRefreshNote, openedWindowTypes } from "../proxy/usageRefresh"

describe("UsageRefreshGate", () => {
  it("lets one refresh per key through per interval", () => {
    const gate = new UsageRefreshGate()
    expect(gate.claim("work", 1_000)).toEqual({ ok: true })
    expect(gate.claim("work", 1_000 + USAGE_REFRESH_MIN_INTERVAL_MS - 1)).toEqual({ ok: false, retryAfterMs: 1 })
    expect(gate.claim("work", 1_000 + USAGE_REFRESH_MIN_INTERVAL_MS)).toEqual({ ok: true })
  })

  it("keeps keys apart", () => {
    const gate = new UsageRefreshGate()
    expect(gate.claim("work", 0).ok).toBe(true)
    expect(gate.claim("personal", 0).ok).toBe(true)
  })

  it("forgets a key", () => {
    const gate = new UsageRefreshGate()
    gate.claim("work", 0)
    gate.forget("work")
    expect(gate.claim("work", 1).ok).toBe(true)
  })
})

describe("openedWindowTypes", () => {
  it("lists the windows a fresh reading shows below their limit", () => {
    expect(openedWindowTypes([
      { type: "five_hour", utilization: 0.1 },
      { type: "seven_day", utilization: 1 },
      { type: "seven_day_opus", utilization: null },
      { type: "seven_day_sonnet", utilization: 0.99 },
    ])).toEqual(["five_hour", "seven_day_sonnet"])
  })
})

describe("claudeRefreshNote", () => {
  it("names the 429 cooldown when a stale reading stood in for the read", () => {
    // A rate-limited read inside the stale window answers error null with the
    // old snapshot; only the failure record says why.
    expect(claudeRefreshNote({ fresh: false, error: null, failureReason: "rate_limited", hadReading: true })).toContain("rate limiting")
  })

  it("does not speak of a last reading when there never was one", () => {
    // A profile never read, refreshed during the cooldown: "the last reading
    // stays" would refer to nothing.
    const note = claudeRefreshNote({ fresh: false, error: "rate_limited", failureReason: "rate_limited", hadReading: false })
    expect(note).toContain("rate limiting")
    expect(note).not.toContain("last reading")
    expect(claudeRefreshNote({ fresh: false, error: "upstream_error", failureReason: "upstream_error", hadReading: false })).not.toContain("last reading")
  })

  it("asks for a login only when the token is missing", () => {
    expect(claudeRefreshNote({ fresh: false, error: "no_token", failureReason: "no_token", hadReading: false })).toContain("sign this profile in")
  })

  it("says the figures are new when they are", () => {
    expect(claudeRefreshNote({ fresh: true, error: null, failureReason: null, hadReading: true })).toBe("Usage re-read just now.")
  })

  it("falls back to the last reading for any other failure", () => {
    expect(claudeRefreshNote({ fresh: false, error: null, failureReason: "upstream_error", hadReading: true })).toContain("last reading stays")
  })
})
