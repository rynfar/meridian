/**
 * Weekly reserve — pure functions in routing.ts. A profile with a reserve
 * leaves the priority pool once its last observed weekly usage reaches
 * 100% minus the reserve, and returns when the window resets.
 */
import { describe, it, expect } from "bun:test"
import {
  parseWeeklyReserves,
  weeklyReserveHold,
  weeklyReserveHolds,
  WeeklyReserveTracker,
  WEEKLY_RESERVE_UNKNOWN_RESET_MAX_AGE_MS,
  type WeeklyUsageReading,
} from "../proxy/routing"

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60_000

function reading(utilization: number | null | undefined, resetsAt: number | null | undefined, observedAt = NOW - 1000): WeeklyUsageReading {
  return { utilization, resetsAt, observedAt }
}

describe("parseWeeklyReserves", () => {
  it("reads the env list", () => {
    const { reserves, invalid } = parseWeeklyReserves("personal=20, work=12.5", undefined)
    expect([...reserves]).toEqual([["personal", 20], ["work", 12.5]])
    expect(invalid).toEqual([])
  })

  it("prefers the env var over the setting", () => {
    const { reserves } = parseWeeklyReserves("work=10", { personal: 20 })
    expect([...reserves]).toEqual([["work", 10]])
  })

  it("falls back to the setting when the env var is blank", () => {
    const { reserves } = parseWeeklyReserves("  ", { personal: 20 })
    expect([...reserves]).toEqual([["personal", 20]])
  })

  it("rejects out-of-range and malformed values instead of guessing", () => {
    const { reserves, invalid } = parseWeeklyReserves("a=0,b=100,c=-5,d=abc,e,=20,f=", undefined)
    expect(reserves.size).toBe(0)
    expect(invalid).toEqual(["a=0", "b=100", "c=-5", "d=abc", "e", "=20", "f="])
  })

  it("rejects non-numeric setting values", () => {
    const { reserves, invalid } = parseWeeklyReserves(undefined, { personal: "lots", work: 15 })
    expect([...reserves]).toEqual([["work", 15]])
    expect(invalid).toEqual(["personal=lots"])
  })
})

describe("weeklyReserveHold", () => {
  it("holds at exactly 100% minus the reserve", () => {
    expect(weeklyReserveHold(20, [reading(0.8, NOW + DAY)], NOW)).toEqual({ utilization: 0.8, until: NOW + DAY })
  })

  it("does not hold below the line", () => {
    expect(weeklyReserveHold(20, [reading(0.79, NOW + DAY)], NOW)).toBeUndefined()
  })

  it("uses the newest reading across sources", () => {
    const older = reading(0.9, NOW + DAY, NOW - 60_000)
    const newer = reading(0.5, NOW + DAY, NOW - 1_000)
    expect(weeklyReserveHold(20, [older, newer], NOW)).toBeUndefined()
    expect(weeklyReserveHold(20, [newer, { ...older, observedAt: NOW }], NOW)?.utilization).toBe(0.9)
  })

  it("ignores a reading whose window has already reset", () => {
    expect(weeklyReserveHold(20, [reading(0.95, NOW - 1)], NOW)).toBeUndefined()
  })

  it("skips readings without utilization rather than presuming full", () => {
    expect(weeklyReserveHold(20, [reading(undefined, NOW + DAY), reading(null, NOW + DAY)], NOW)).toBeUndefined()
    expect(weeklyReserveHold(20, [], NOW)).toBeUndefined()
  })

  it("holds with an unknown reset when the window reports no reset time", () => {
    expect(weeklyReserveHold(20, [reading(0.85, undefined)], NOW)).toEqual({ utilization: 0.85, until: undefined })
  })

  it("stops trusting a reading with no reset time once it is old", () => {
    const old = reading(0.85, null, NOW - WEEKLY_RESERVE_UNKNOWN_RESET_MAX_AGE_MS - 1)
    expect(weeklyReserveHold(20, [old], NOW)).toBeUndefined()
    const recent = reading(0.85, null, NOW - WEEKLY_RESERVE_UNKNOWN_RESET_MAX_AGE_MS + 1)
    expect(weeklyReserveHold(20, [recent], NOW)?.utilization).toBe(0.85)
  })

  it("keeps a reading with a future reset however old it is", () => {
    expect(weeklyReserveHold(20, [reading(0.85, NOW + DAY, NOW - 3 * DAY)], NOW)?.utilization).toBe(0.85)
  })
})

describe("weeklyReserveHolds", () => {
  const readings: Record<string, WeeklyUsageReading[]> = {
    centeva: [reading(0.99, NOW + DAY)],
    personal: [reading(0.82, NOW + 2 * DAY)],
    work: [reading(0.4, NOW + 3 * DAY)],
  }
  const readingsFor = (id: string) => readings[id] ?? []

  it("only holds profiles that have a reserve", () => {
    const holds = weeklyReserveHolds(["centeva", "personal", "work"], new Map([["personal", 20], ["work", 20]]), readingsFor, NOW)
    expect([...holds.keys()]).toEqual(["personal"])
  })

  it("holds nothing when no reserve is configured", () => {
    expect(weeklyReserveHolds(["centeva", "personal"], new Map(), readingsFor, NOW).size).toBe(0)
  })
})

describe("WeeklyReserveTracker", () => {
  const ids = ["centeva", "personal"]
  let usage = 0.9
  const readingsFor = (id: string) => id === "personal" ? [reading(usage, NOW + DAY)] : []
  const parsed = { reserves: new Map([["personal", 20]]), invalid: [] as string[] }

  it("reports a hold once and its release once", () => {
    const tracker = new WeeklyReserveTracker()
    usage = 0.9
    const first = tracker.evaluate({ ids, knownIds: ids, parsed, readingsFor, now: NOW })
    expect([...first.holds.keys()]).toEqual(["personal"])
    expect(first.events.map(e => e.event)).toEqual(["priority.weekly_reserve_held"])
    expect(tracker.evaluate({ ids, knownIds: ids, parsed, readingsFor, now: NOW }).events).toEqual([])
    usage = 0.5
    const released = tracker.evaluate({ ids, knownIds: ids, parsed, readingsFor, now: NOW })
    expect(released.holds.size).toBe(0)
    expect(released.events).toEqual([{ event: "priority.weekly_reserve_released", data: { profile: "personal" } }])
  })

  it("reports invalid entries and reserves naming no profile, once each", () => {
    const tracker = new WeeklyReserveTracker()
    const bad = { reserves: new Map([["persnal", 20]]), invalid: ["work=abc"] }
    const first = tracker.evaluate({ ids, knownIds: ids, parsed: bad, readingsFor, now: NOW })
    expect(first.events).toEqual([
      { event: "priority.weekly_reserve_invalid", data: { invalid: ["work=abc"] } },
      { event: "priority.weekly_reserve_unknown_ids", data: { unknown: ["persnal"] } },
    ])
    expect(tracker.evaluate({ ids, knownIds: ids, parsed: bad, readingsFor, now: NOW }).events).toEqual([])
  })
})
