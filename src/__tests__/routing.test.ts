/**
 * Unit tests for sticky session-to-profile routing — pure functions, no mocks.
 *
 * Design (#383, proposed by @ShreeMulay): sessions are assigned to profiles
 * via rendezvous (highest-random-weight) hashing — deterministic and
 * stateless, so stickiness survives proxy restarts with no persisted map,
 * and adding/removing a profile only reassigns the sessions that belonged
 * to the removed arm (minimal cache disruption).
 */
import { describe, it, expect } from "bun:test"
import { pickStickyProfile, getRoutingMode, resolvePriorityOrder, choosePriorityProfile, ProfileExhaustion, RENDEZVOUS_STABLE_GUARD } from "../proxy/routing"

const PROFILES = ["personal", "work"]

describe("pickStickyProfile", () => {
  it("is deterministic: same session always maps to the same profile", () => {
    for (const key of ["sess-a", "sess-b", "ses-123", "x"]) {
      const first = pickStickyProfile(key, PROFILES)
      for (let i = 0; i < 5; i++) {
        expect(pickStickyProfile(key, PROFILES)).toBe(first!)
      }
    }
  })

  it("distributes sessions across profiles (not all on one arm)", () => {
    const counts: Record<string, number> = {}
    for (let i = 0; i < 200; i++) {
      const p = pickStickyProfile(`session-${i}`, PROFILES)!
      counts[p] = (counts[p] ?? 0) + 1
    }
    // With 200 sessions over 2 arms, each arm should get a healthy share.
    expect(counts["personal"]!).toBeGreaterThan(50)
    expect(counts["work"]!).toBeGreaterThan(50)
  })

  it("adding a profile only moves sessions to the new arm (rendezvous property)", () => {
    const before = new Map<string, string>()
    for (let i = 0; i < 100; i++) before.set(`s-${i}`, pickStickyProfile(`s-${i}`, PROFILES)!)

    const after = new Map<string, string>()
    for (let i = 0; i < 100; i++) after.set(`s-${i}`, pickStickyProfile(`s-${i}`, [...PROFILES, "third"])!)

    for (const [key, oldProfile] of before) {
      const newProfile = after.get(key)!
      // A session either stays where it was, or moves to the NEW arm —
      // never shuffles between existing arms (that would cold-cache it
      // for no reason).
      if (newProfile !== oldProfile) expect(newProfile).toBe("third")
    }
  })

  it("removing a profile only reassigns that arm's sessions", () => {
    const three = [...PROFILES, "third"]
    const before = new Map<string, string>()
    for (let i = 0; i < 100; i++) before.set(`s-${i}`, pickStickyProfile(`s-${i}`, three)!)

    for (const [key, oldProfile] of before) {
      const newProfile = pickStickyProfile(key, PROFILES)!
      if (oldProfile !== "third") {
        expect(newProfile).toBe(oldProfile) // survivors stay put
      } else {
        expect(PROFILES).toContain(newProfile)
      }
    }
  })

  it("profile order does not matter (set semantics)", () => {
    for (let i = 0; i < 20; i++) {
      expect(pickStickyProfile(`s-${i}`, ["a", "b", "c"])).toBe(pickStickyProfile(`s-${i}`, ["c", "a", "b"])!)
    }
  })

  it("returns undefined for empty inputs", () => {
    expect(pickStickyProfile("sess", [])).toBeUndefined()
    expect(pickStickyProfile("", PROFILES)).toBeUndefined()
  })

  it("single profile always wins", () => {
    expect(pickStickyProfile("anything", ["only"])).toBe("only")
  })

  it("hash outputs are pinned (stickiness must survive upgrades)", () => {
    // If this test breaks, the hash changed — every user's sessions would
    // silently reshuffle onto different accounts (cold caches) on upgrade.
    // Do NOT update these expectations without a migration note.
    expect(RENDEZVOUS_STABLE_GUARD.every(([key, profiles, want]) =>
      pickStickyProfile(key, profiles) === want
    )).toBe(true)
  })
})

describe("getRoutingMode", () => {
  it("defaults to 'active' (current behavior) when unset", () => {
    expect(getRoutingMode(undefined)).toBe("active")
    expect(getRoutingMode("")).toBe("active")
  })

  it("accepts 'sticky'", () => {
    expect(getRoutingMode("sticky")).toBe("sticky")
  })

  it("falls back to 'active' for unknown values (never crashes routing)", () => {
    expect(getRoutingMode("round-robin")).toBe("active")
    expect(getRoutingMode("STICKY")).toBe("sticky") // case-insensitive
  })
})

describe("priority routing (#priority-spec)", () => {
  it("getRoutingMode accepts 'priority'", () => {
    expect(getRoutingMode("priority")).toBe("priority")
    expect(getRoutingMode("PRIORITY")).toBe("priority")
  })

  it("resolvePriorityOrder honors the configured order and appends unlisted profiles", () => {
    const { order, unknown } = resolvePriorityOrder(["personal", "work", "ci"], ["work", "personal"])
    expect(order).toEqual(["work", "personal", "ci"])
    expect(unknown).toEqual([])
  })

  it("resolvePriorityOrder reports unknown ids and ignores them", () => {
    const { order, unknown } = resolvePriorityOrder(["personal", "work"], ["work", "ghost"])
    expect(order).toEqual(["work", "personal"])
    expect(unknown).toEqual(["ghost"])
  })

  it("resolvePriorityOrder without a setting uses config order", () => {
    const { order } = resolvePriorityOrder(["personal", "work"], undefined)
    expect(order).toEqual(["personal", "work"])
  })

  it("choosePriorityProfile picks the first non-exhausted profile", () => {
    const pick = choosePriorityProfile(["work", "personal"], (id) => id === "work")
    expect(pick).toEqual({ id: "personal", allExhausted: false })
  })

  it("choosePriorityProfile returns the preferred profile when all are exhausted", () => {
    const pick = choosePriorityProfile(["work", "personal"], () => true)
    expect(pick).toEqual({ id: "work", allExhausted: true })
  })

  it("choosePriorityProfile handles an empty pool", () => {
    expect(choosePriorityProfile([], () => false)).toBeUndefined()
  })
})

describe("ProfileExhaustion tracker", () => {
  const T0 = 1_800_000_000_000

  it("marks and reports exhaustion until expiry", () => {
    const ex = new ProfileExhaustion(() => T0)
    ex.mark("work", T0 + 60_000, "rate_limit_error")
    expect(ex.isExhausted("work")).toBe(true)
    expect(ex.isExhausted("personal")).toBe(false)
  })

  it("expires marks and self-heals", () => {
    let now = T0
    const ex = new ProfileExhaustion(() => now)
    ex.mark("work", T0 + 60_000, "rate_limit_error")
    now = T0 + 60_001
    expect(ex.isExhausted("work")).toBe(false)
    expect(ex.snapshot()).toEqual([])
  })

  it("snapshot exposes entries for observability", () => {
    const ex = new ProfileExhaustion(() => T0)
    ex.mark("work", T0 + 120_000, "rate_limit_error")
    expect(ex.snapshot()).toEqual([{ id: "work", until: T0 + 120_000, reason: "rate_limit_error" }])
  })

  it("a later mark extends but an earlier one never shortens", () => {
    const ex = new ProfileExhaustion(() => T0)
    ex.mark("work", T0 + 120_000, "rate_limit_error")
    ex.mark("work", T0 + 30_000, "rate_limit_error")
    expect(ex.snapshot()[0]!.until).toBe(T0 + 120_000)
  })
})
