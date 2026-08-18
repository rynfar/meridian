/**
 * Unit tests for the shared "how spent is this account?" classifier —
 * pure functions, no mocks.
 */
import { describe, expect, it } from "bun:test"
import {
  FADE_FROM,
  SPENT_AT,
  computeProfileSpend,
  generalUtilization,
  isUnusable,
} from "../telemetry/profileSpent"

const win = (type: string, utilization: number | null) => ({ type, utilization })

describe("generalUtilization", () => {
  it("takes the worse of the five-hour and general weekly windows", () => {
    expect(generalUtilization([win("five_hour", 0.2), win("seven_day", 0.8)])).toBe(0.8)
    expect(generalUtilization([win("five_hour", 0.9), win("seven_day", 0.1)])).toBe(0.9)
  })

  it("ignores per-model caps, seven_day_fable above all", () => {
    // The observed case: 94% Fable, general windows barely touched. Folding
    // Fable in would call a usable account spent.
    expect(
      generalUtilization([win("five_hour", 0.05), win("seven_day", 0.1), win("seven_day_fable", 0.94)]),
    ).toBe(0.1)
    expect(
      generalUtilization([win("seven_day", 0.2), win("seven_day_opus", 1), win("seven_day_sonnet", 1)]),
    ).toBe(0.2)
  })

  it("returns null when no general window carries a number", () => {
    expect(generalUtilization([])).toBeNull()
    expect(generalUtilization(null)).toBeNull()
    expect(generalUtilization(undefined)).toBeNull()
    expect(generalUtilization([win("five_hour", null)])).toBeNull()
    expect(generalUtilization([win("seven_day_fable", 0.9)])).toBeNull()
    expect(generalUtilization([win("five_hour", Number.NaN)])).toBeNull()
  })

  it("clamps out-of-range utilization", () => {
    expect(generalUtilization([win("seven_day", 1.4)])).toBe(1)
    expect(generalUtilization([win("seven_day", -0.2)])).toBe(0)
  })
})

describe("isUnusable", () => {
  it("is true for a profile with no token or a failed login", () => {
    expect(isUnusable({ error: "no_token" })).toBe(true)
    expect(isUnusable({ loggedIn: false })).toBe(true)
  })

  it("is false for an API-key profile, which has no OAuth quota but works", () => {
    expect(isUnusable({ error: "not_oauth", loggedIn: true })).toBe(false)
  })

  it("is false for a healthy profile", () => {
    expect(isUnusable({ error: null, loggedIn: true, windows: [win("seven_day", 0.3)] })).toBe(false)
    expect(isUnusable({})).toBe(false)
  })
})

describe("computeProfileSpend", () => {
  it("reports a profile that needs a human as fully spent, with its own reason", () => {
    const s = computeProfileSpend({ error: "no_token", windows: [] })
    expect(s.fraction).toBe(1)
    expect(s.state).toBe("spent")
    expect(s.reason).toBe("unusable")
  })

  it("does not fade a profile that needs a human, however spent it is", () => {
    // Fading says "come back later"; a missing login says "do something".
    expect(computeProfileSpend({ error: "no_token", windows: [] }).fade).toBe(0)
    expect(computeProfileSpend({ loggedIn: false, windows: [win("seven_day", 0.99)] }).fade).toBe(0)
  })

  it("does not confuse an unusable profile with a pristine one", () => {
    // No windows at all is what a broken profile reports — it must not read
    // as 0% used.
    const broken = computeProfileSpend({ error: "no_token", windows: [] })
    const fresh = computeProfileSpend({ windows: [win("five_hour", 0), win("seven_day", 0)] })
    expect(broken.fraction).toBe(1)
    expect(fresh.fraction).toBe(0)
    expect(fresh.state).toBe("available")
  })

  it("is 'unknown' with no quota data, which is not the same as unused", () => {
    const s = computeProfileSpend({ windows: [], loggedIn: true })
    expect(s.fraction).toBeNull()
    expect(s.state).toBe("unknown")
    expect(s.fade).toBe(0)
    expect(s.reason).toBeNull()
  })

  it("leaves a comfortable profile alone", () => {
    const s = computeProfileSpend({ windows: [win("five_hour", 0.4), win("seven_day", 0.6)] })
    expect(s.state).toBe("available")
    expect(s.fade).toBe(0)
  })

  it("ramps the fade across the 85–95% band", () => {
    expect(computeProfileSpend({ windows: [win("seven_day", FADE_FROM)] }).fade).toBe(0)
    expect(computeProfileSpend({ windows: [win("seven_day", 0.9)] }).fade).toBeCloseTo(0.5, 5)
    expect(computeProfileSpend({ windows: [win("seven_day", 0.94)] }).fade).toBeCloseTo(0.9, 5)
    expect(computeProfileSpend({ windows: [win("seven_day", 0.9)] }).state).toBe("fading")
  })

  it("is fully spent at the threshold and beyond", () => {
    for (const u of [SPENT_AT, 0.99, 1]) {
      const s = computeProfileSpend({ windows: [win("seven_day", u)] })
      expect(s.state).toBe("spent")
      expect(s.fade).toBe(1)
      expect(s.reason).toBe("usage")
    }
  })

  it("spends on the worse window, so a hot 5h counts even with a cold week", () => {
    const s = computeProfileSpend({ windows: [win("five_hour", 0.97), win("seven_day", 0.05)] })
    expect(s.state).toBe("spent")
    expect(s.fraction).toBe(0.97)
  })
})
