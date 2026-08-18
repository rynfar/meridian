/**
 * Unit tests for the home page's view-only account ordering — pure
 * functions, no mocks.
 */
import { describe, expect, it } from "bun:test"
import {
  DEFAULT_PROFILE_SORT,
  PROFILE_SORT_MODES,
  parseProfileSortMode,
  sortProfilesForView,
} from "../telemetry/profileSort"
import { computeProfileSpend } from "../telemetry/profileSpent"

interface Prof {
  id: string
  spent: number | null
}
const spentOf = (p: Prof) => p.spent
const ids = (list: Prof[]) => list.map((p) => p.id).join(",")

const fleet: Prof[] = [
  { id: "a", spent: 0.4 },
  { id: "b", spent: 0.95 },
  { id: "c", spent: 0.1 },
]

describe("parseProfileSortMode", () => {
  it("accepts every mode the control offers", () => {
    for (const mode of PROFILE_SORT_MODES) {
      expect(parseProfileSortMode(mode.id)).toBe(mode.id)
    }
  })

  it("falls back to the configured order for anything else", () => {
    expect(parseProfileSortMode("nonsense")).toBe(DEFAULT_PROFILE_SORT)
    expect(parseProfileSortMode(null)).toBe(DEFAULT_PROFILE_SORT)
    expect(parseProfileSortMode(undefined)).toBe(DEFAULT_PROFILE_SORT)
    expect(DEFAULT_PROFILE_SORT).toBe("configured")
  })
})

describe("sortProfilesForView", () => {
  it("leaves the configured order alone", () => {
    expect(ids(sortProfilesForView(fleet, "configured", spentOf))).toBe("a,b,c")
  })

  it("does not mutate the input", () => {
    sortProfilesForView(fleet, "spent-desc", spentOf)
    expect(ids(fleet)).toBe("a,b,c")
  })

  it("puts the account closest to running out first when sorting desc", () => {
    expect(ids(sortProfilesForView(fleet, "spent-desc", spentOf))).toBe("b,a,c")
  })

  it("puts the account with the most capacity first when sorting asc", () => {
    expect(ids(sortProfilesForView(fleet, "spent-asc", spentOf))).toBe("c,a,b")
  })

  it("sorts profiles with no reading last in both directions", () => {
    // Null is absence of evidence, not a low number: at the front of
    // "least spent" it would recommend the one account we know nothing about.
    const withUnknown: Prof[] = [{ id: "unknown", spent: null }, ...fleet]
    expect(ids(sortProfilesForView(withUnknown, "spent-asc", spentOf))).toBe("c,a,b,unknown")
    expect(ids(sortProfilesForView(withUnknown, "spent-desc", spentOf))).toBe("b,a,c,unknown")
  })

  it("keeps configured order among equally spent profiles", () => {
    const tied: Prof[] = [
      { id: "x", spent: 0.5 },
      { id: "y", spent: 0.5 },
      { id: "z", spent: 0.5 },
    ]
    expect(ids(sortProfilesForView(tied, "spent-desc", spentOf))).toBe("x,y,z")
    expect(ids(sortProfilesForView(tied, "spent-asc", spentOf))).toBe("x,y,z")
  })

  it("keeps configured order among several unknowns", () => {
    const unknowns: Prof[] = [
      { id: "p", spent: null },
      { id: "q", spent: null },
    ]
    expect(ids(sortProfilesForView(unknowns, "spent-asc", spentOf))).toBe("p,q")
  })

  it("handles empty and single-item lists", () => {
    expect(sortProfilesForView([], "spent-desc", spentOf)).toEqual([])
    expect(ids(sortProfilesForView([fleet[0]!], "spent-desc", spentOf))).toBe("a")
  })
})

describe("sorting on the shared spend classifier", () => {
  // The contract Nowaker asked for: a spent weekly window ranks a profile as
  // hard as a spent five-hour one, and a profile needing a login ranks with
  // them rather than with the fresh accounts.
  const quotaOf = (windows: Array<{ type: string; utilization: number }>, error?: string) => ({
    id: "",
    spent: computeProfileSpend({ windows, error: error ?? null, loggedIn: error ? false : true }).fraction,
  })

  it("ranks a spent week alongside a spent five-hour window", () => {
    const weekGone = quotaOf([
      { type: "five_hour", utilization: 0 },
      { type: "seven_day", utilization: 1 },
    ])
    const hourGone = quotaOf([
      { type: "five_hour", utilization: 1 },
      { type: "seven_day", utilization: 0.1 },
    ])
    expect(weekGone.spent).toBe(1)
    expect(hourGone.spent).toBe(1)
  })

  it("ranks a profile that needs a login with the spent ones, not the fresh ones", () => {
    const list: Prof[] = [
      { ...quotaOf([{ type: "seven_day", utilization: 0.2 }]), id: "healthy" },
      { ...quotaOf([], "no_token"), id: "broken" },
    ]
    expect(ids(sortProfilesForView(list, "spent-desc", spentOf))).toBe("broken,healthy")
    expect(ids(sortProfilesForView(list, "spent-asc", spentOf))).toBe("healthy,broken")
  })

  it("ignores per-model caps, so a Fable-capped profile is not ranked as spent", () => {
    const fableCapped = quotaOf([
      { type: "five_hour", utilization: 0.05 },
      { type: "seven_day", utilization: 0.1 },
      { type: "seven_day_fable", utilization: 0.94 },
    ])
    expect(fableCapped.spent).toBe(0.1)
  })
})
