/**
 * Extra Usage as a last resort: pure functions in routing.ts. Pool routing
 * sends work to an account that pays with Extra Usage only once no account
 * has plan allowance left (`reserve`), never (`never`), or in normal order
 * (`immediately`).
 */
import { describe, it, expect } from "bun:test"
import {
  drawsExtraUsage,
  getClaudeExtraUsagePolicy,
  orderForExtraUsage,
  WEEKLY_RESERVE_UNKNOWN_RESET_MAX_AGE_MS,
  type ExtraUsageEvidence,
} from "../proxy/routing"

const NOW = 1_800_000_000_000
const HOUR = 60 * 60_000

function oauth(utilization: number, fetchedAt = NOW - 1000, type = "five_hour"): ExtraUsageEvidence["oauth"] {
  return { fetchedAt, windows: [{ type, utilization, resetsAt: NOW + HOUR }] }
}

describe("getClaudeExtraUsagePolicy", () => {
  it("reads the three policies and defaults to reserve", () => {
    expect(getClaudeExtraUsagePolicy("never")).toBe("never")
    expect(getClaudeExtraUsagePolicy(" Immediately ")).toBe("immediately")
    expect(getClaudeExtraUsagePolicy("reserve")).toBe("reserve")
    expect(getClaudeExtraUsagePolicy(undefined)).toBe("reserve")
    expect(getClaudeExtraUsagePolicy("always")).toBe("reserve")
  })
})

describe("drawsExtraUsage", () => {
  it("takes the SDK's isUsingOverage while its window is live", () => {
    expect(drawsExtraUsage({ sdk: [{ isUsingOverage: true, resetsAt: NOW + HOUR, observedAt: NOW - 1000 }] }, NOW)).toBe(true)
    expect(drawsExtraUsage({ sdk: [{ isUsingOverage: true, resetsAt: NOW - 1, observedAt: NOW - HOUR }] }, NOW)).toBe(false)
  })

  it("counts an SDK reading with no reset for an hour only", () => {
    expect(drawsExtraUsage({ sdk: [{ isUsingOverage: true, observedAt: NOW - 1000 }] }, NOW)).toBe(true)
    expect(drawsExtraUsage({ sdk: [{ isUsingOverage: true, observedAt: NOW - WEEKLY_RESERVE_UNKNOWN_RESET_MAX_AGE_MS - 1 }] }, NOW)).toBe(false)
  })

  it("infers it from a spent account-wide plan window, whatever the snapshot says about Extra Usage", () => {
    expect(drawsExtraUsage({ sdk: [], oauth: oauth(1) }, NOW)).toBe(true)
    expect(drawsExtraUsage({ sdk: [], oauth: oauth(1, NOW - 1000, "seven_day") }, NOW)).toBe(true)
  })

  it("does not infer it below the limit or from a per-model bucket", () => {
    expect(drawsExtraUsage({ sdk: [], oauth: oauth(0.97) }, NOW)).toBe(false)
    expect(drawsExtraUsage({ sdk: [], oauth: oauth(1, NOW - 1000, "seven_day_opus") }, NOW)).toBe(false)
  })

  it("takes the SDK's isUsingOverage only from an account-wide bucket", () => {
    const live = { isUsingOverage: true, resetsAt: NOW + HOUR, observedAt: NOW - 1000 }
    for (const rateLimitType of ["five_hour", "seven_day", "default", "overage"]) {
      expect(drawsExtraUsage({ sdk: [{ ...live, rateLimitType }] }, NOW)).toBe(true)
    }
    expect(drawsExtraUsage({ sdk: [{ ...live, rateLimitType: "seven_day_opus" }] }, NOW)).toBe(false)
    expect(drawsExtraUsage({ sdk: [{ ...live, rateLimitType: "seven_day_sonnet" }] }, NOW)).toBe(false)
  })

  it("lets the newest observation win", () => {
    const stillOnPlan = { isUsingOverage: false, resetsAt: NOW + HOUR, observedAt: NOW - 10 }
    expect(drawsExtraUsage({ sdk: [stillOnPlan], oauth: oauth(1, NOW - 1000) }, NOW)).toBe(false)
    expect(drawsExtraUsage({ sdk: [{ ...stillOnPlan, observedAt: NOW - 5000 }], oauth: oauth(1, NOW - 1000) }, NOW)).toBe(true)
  })

  it("is false with nothing observed", () => {
    expect(drawsExtraUsage({ sdk: [] }, NOW)).toBe(false)
  })
})

describe("orderForExtraUsage", () => {
  const order = ["a", "b", "c"]
  const drawing = (ids: string[]) => (id: string) => ids.includes(id)
  const all = () => true

  it("moves accounts on Extra Usage behind those with plan allowance under reserve", () => {
    const result = orderForExtraUsage(order, "reserve", drawing(["a"]), all)
    expect(result.order).toEqual(["b", "c", "a"])
    expect([...result.lastResort]).toEqual(["a"])
    expect(result.refused).toBe(false)
  })

  it("keeps the order when no account with plan allowance can take work", () => {
    const result = orderForExtraUsage(order, "reserve", drawing(["a"]), id => id === "a")
    expect(result.order).toEqual(order)
    expect(result.lastResort.size).toBe(0)
    expect(orderForExtraUsage(order, "reserve", drawing(order), all).order).toEqual(order)
  })

  it("drops accounts on Extra Usage under never, refusing when none is left", () => {
    expect(orderForExtraUsage(order, "never", drawing(["b"]), all)).toEqual({ order: ["a", "c"], lastResort: new Set(), refused: false })
    expect(orderForExtraUsage(order, "never", drawing(order), all)).toEqual({ order, lastResort: new Set(), refused: true })
  })

  it("changes nothing under immediately", () => {
    expect(orderForExtraUsage(order, "immediately", drawing(["a"]), all)).toEqual({ order, lastResort: new Set(), refused: false })
  })
})
