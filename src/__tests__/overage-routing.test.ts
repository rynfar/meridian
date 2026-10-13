import { describe, expect, it } from "bun:test"
import { hasIncludedCapacityExhaustion, preferIncludedCapacity, OVERAGE_EVIDENCE_MAX_AGE_MS } from "../proxy/overageRouting"

const now = 1_800_000_000_000
const spent = { type: "five_hour", observedAt: now - 10, resetsAt: now + 60_000, utilization: 1 }

describe("included-capacity evidence", () => {
  it("accepts current global exhaustion and explicit overage", () => {
    expect(hasIncludedCapacityExhaustion([spent], now)).toBe(true)
    expect(hasIncludedCapacityExhaustion([{ ...spent, utilization: 0, isUsingOverage: true }], now)).toBe(true)
    expect(hasIncludedCapacityExhaustion([{ ...spent, utilization: 0, status: "rejected" }], now)).toBe(true)
  })
  it("does not infer exhaustion from absent or partial usage", () => {
    expect(hasIncludedCapacityExhaustion([], now)).toBe(false)
    expect(hasIncludedCapacityExhaustion([{ ...spent, utilization: 0.99 }], now)).toBe(false)
    expect(hasIncludedCapacityExhaustion([{ ...spent, utilization: null }], now)).toBe(false)
  })
  it("expires evidence at either reset or maximum age", () => {
    expect(hasIncludedCapacityExhaustion([{ ...spent, resetsAt: now }], now)).toBe(false)
    expect(hasIncludedCapacityExhaustion([{ ...spent, observedAt: now - OVERAGE_EVIDENCE_MAX_AGE_MS }], now)).toBe(false)
    expect(hasIncludedCapacityExhaustion([{ ...spent, observedAt: now + 1 }], now)).toBe(false)
    expect(hasIncludedCapacityExhaustion([{ ...spent, resetsAt: Number.NaN }], now)).toBe(false)
  })
  it("uses the newest observation per global window without mutating input", () => {
    const healthy = { ...spent, observedAt: now, utilization: 0.2 }
    const signals = [spent, healthy]
    expect(hasIncludedCapacityExhaustion(signals, now)).toBe(false)
    expect(signals).toEqual([spent, healthy])
    expect(hasIncludedCapacityExhaustion([healthy, { ...spent, type: "seven_day" }], now)).toBe(true)
  })
  it("does not apply another model's quota or an unknown window globally", () => {
    for (const type of ["seven_day_opus", "seven_day_sonnet", "seven_day_cowork", "unknown"]) {
      expect(hasIncludedCapacityExhaustion([{ ...spent, type, isUsingOverage: true }], now)).toBe(false)
    }
  })
  it("replaces an older explicit overage observation", () => {
    expect(hasIncludedCapacityExhaustion([
      { type: "default", observedAt: now - 1, isUsingOverage: true },
      { type: "overage", observedAt: now, isUsingOverage: false },
    ], now)).toBe(false)
  })
  it("bounds missing-reset evidence too", () => {
    expect(hasIncludedCapacityExhaustion([{ type: "default", observedAt: now, isUsingOverage: true }], now)).toBe(true)
    expect(hasIncludedCapacityExhaustion([{ type: "default", observedAt: now - OVERAGE_EVIDENCE_MAX_AGE_MS, isUsingOverage: true }], now)).toBe(false)
  })
  it("retains paid fallback and stable order within each group", () => {
    const candidates = ["paid-a", "included-a", "paid-b", "unknown"]
    expect(preferIncludedCapacity(candidates, id => id.startsWith("paid"))).toEqual(["included-a", "unknown", "paid-a", "paid-b"])
    expect(preferIncludedCapacity(candidates, () => true)).toEqual(candidates)
    expect(preferIncludedCapacity(candidates, () => false)).toEqual(candidates)
  })
})
