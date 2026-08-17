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
import {
  pickStickyProfile,
  getRoutingMode,
  getPriorityFailbackPolicy,
  shouldPromotePriorityAssignment,
  resolvePriorityOrder,
  choosePriorityProfile,
  ProfileExhaustion,
  RENDEZVOUS_STABLE_GUARD,
  AssignmentStore,
  resolveCooldownUntil,
  cooldownCapMs,
  type PriorityAssignment,
  type PriorityPromotionInput,
} from "../proxy/routing"

const PROFILES = ["personal", "work"]
const WORK_ASSIGNMENT: PriorityAssignment = { profileId: "work", requestId: "request-1" }
const PERSONAL_ASSIGNMENT: PriorityAssignment = { profileId: "personal", requestId: "request-1" }

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

describe("priority failback policy", () => {
  it("resolves unset and invalid values to new-conversation and accepts next-user-turn", () => {
    // Given
    const values = [undefined, "eventually", "next-user-turn"]

    // When
    const actual = values.map(getPriorityFailbackPolicy)

    // Then
    expect(actual).toEqual(["new-conversation", "new-conversation", "next-user-turn"])
  })

  it("promotes only for a changed human request under next-user-turn", () => {
    // Given
    const assignment = { profileId: "personal", requestId: "request-1" }
    const cases: readonly PriorityPromotionInput[] = [
      { policy: "new-conversation", requestId: "request-2", requestKind: "human", assignment },
      { policy: "next-user-turn", requestId: "request-1", requestKind: "human", assignment },
      { policy: "next-user-turn", requestId: "request-2", requestKind: "human", assignment },
      { policy: "next-user-turn", requestId: "request-2", requestKind: "synthetic", assignment },
      { policy: "next-user-turn", requestId: "request-2", requestKind: "unknown", assignment },
      { policy: "next-user-turn", requestId: "request-2", requestKind: undefined, assignment },
    ]

    // When
    const actual = cases.map(shouldPromotePriorityAssignment)

    // Then
    expect(actual).toEqual([false, false, true, false, false, false])
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

describe("AssignmentStore", () => {
  it("stores and returns assignments", () => {
    const store = new AssignmentStore(10)
    store.set("a", WORK_ASSIGNMENT)
    expect(store.get("a")).toEqual(WORK_ASSIGNMENT)
    expect(store.get("missing")).toBeUndefined()
    expect(store.size).toBe(1)
  })

  it("overwrites an existing key without growing", () => {
    const store = new AssignmentStore(10)
    store.set("a", WORK_ASSIGNMENT)
    store.set("a", PERSONAL_ASSIGNMENT)
    expect(store.get("a")).toEqual(PERSONAL_ASSIGNMENT)
    expect(store.size).toBe(1)
  })

  it("rejects a stale compare-and-set after a newer assignment wins", () => {
    const store = new AssignmentStore(10)
    store.set("a", PERSONAL_ASSIGNMENT)
    const stale = store.get("a")
    expect(stale).toEqual(PERSONAL_ASSIGNMENT)
    if (stale === undefined) return
    const preferred = { profileId: "work", requestId: "request-2" }

    expect(store.compareAndSet("a", stale, preferred)).toBe(true)
    expect(store.compareAndSet("a", stale, PERSONAL_ASSIGNMENT)).toBe(false)
    expect(store.get("a")).toEqual(preferred)
  })

  it("evicts the oldest entry once over capacity", () => {
    const store = new AssignmentStore(2)
    store.set("a", WORK_ASSIGNMENT)
    store.set("b", WORK_ASSIGNMENT)
    store.set("c", WORK_ASSIGNMENT)
    expect(store.size).toBe(2)
    expect(store.get("a")).toBeUndefined()
    expect(store.get("b")).toEqual(WORK_ASSIGNMENT)
    expect(store.get("c")).toEqual(WORK_ASSIGNMENT)
  })

  it("refreshes recency on WRITE so a re-assigned key is not evicted first", () => {
    // The FIFO bug: a bare Map.set() on an existing key does not reorder it,
    // so "a" would still be evicted despite being the most recently written.
    const store = new AssignmentStore(2)
    store.set("a", WORK_ASSIGNMENT)
    store.set("b", WORK_ASSIGNMENT)
    store.set("a", PERSONAL_ASSIGNMENT)
    store.set("c", WORK_ASSIGNMENT)
    expect(store.get("a")).toEqual(PERSONAL_ASSIGNMENT)
    expect(store.get("b")).toBeUndefined()
  })

  it("refreshes recency on READ so an actively used key is not evicted first", () => {
    const store = new AssignmentStore(2)
    store.set("a", WORK_ASSIGNMENT)
    store.set("b", WORK_ASSIGNMENT)
    expect(store.get("a")).toEqual(WORK_ASSIGNMENT) // "a" is in active use
    store.set("c", WORK_ASSIGNMENT)
    expect(store.get("a")).toEqual(WORK_ASSIGNMENT)
    expect(store.get("b")).toBeUndefined()
  })

  it("does not refresh recency for a missing key", () => {
    const store = new AssignmentStore(2)
    store.set("a", WORK_ASSIGNMENT)
    store.set("b", WORK_ASSIGNMENT)
    expect(store.get("nope")).toBeUndefined()
    store.set("c", WORK_ASSIGNMENT)
    expect(store.get("a")).toBeUndefined()
    expect(store.get("b")).toEqual(WORK_ASSIGNMENT)
  })

  it("with max 0, an entry is evicted immediately after being written", () => {
    const store = new AssignmentStore(0)
    store.set("a", WORK_ASSIGNMENT)
    expect(store.size).toBe(0)
    expect(store.get("a")).toBeUndefined()
  })

  it("with max 1, only the newest entry survives", () => {
    const store = new AssignmentStore(1)
    store.set("a", WORK_ASSIGNMENT)
    store.set("b", PERSONAL_ASSIGNMENT)
    expect(store.size).toBe(1)
    expect(store.get("a")).toBeUndefined()
    expect(store.get("b")).toEqual(PERSONAL_ASSIGNMENT)
  })
})

// #790: a weekly-capped profile matched no `five_hour` entry, fell through to
// the 10-minute default, and was re-probed every 10 minutes — with a real
// failing upstream request on the request path — for the rest of the weekly
// window. These pin the reset actually chosen and, just as importantly, the
// per-window cap: a single 6-hour bound silently flattens a weekly reset and
// recreates the same loop at a slower interval.
describe("resolveCooldownUntil (#790)", () => {
  const NOW = 1_700_000_000_000
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  const DEFAULT_MS = 10 * MIN

  it("benches to the weekly reset when the weekly window is exhausted", () => {
    const until = resolveCooldownUntil(
      [{ type: "seven_day", resetsAt: NOW + 3 * DAY, exhausted: true }],
      NOW, DEFAULT_MS,
    )
    expect(until).toBe(NOW + 3 * DAY)
  })

  it("does not flatten a weekly reset to the five-hour cap", () => {
    // The trap: with one 6-hour cap this returns NOW + 6h and the profile is
    // re-probed every six hours for days instead of every ten minutes.
    const until = resolveCooldownUntil(
      [{ type: "seven_day", resetsAt: NOW + 5 * DAY, exhausted: true }],
      NOW, DEFAULT_MS,
    )
    expect(until).toBeGreaterThan(NOW + 6 * HOUR)
    expect(until).toBe(NOW + 5 * DAY)
  })

  it("prefers the weekly reset when both windows are exhausted", () => {
    // Inside a weekly cap the account stays unusable after the five-hour
    // window rolls over, so benching to the shorter reset resumes probing a
    // still-capped account.
    const until = resolveCooldownUntil([
      { type: "five_hour", resetsAt: NOW + 2 * HOUR, exhausted: true },
      { type: "seven_day", resetsAt: NOW + 4 * DAY, exhausted: true },
    ], NOW, DEFAULT_MS)
    expect(until).toBe(NOW + 4 * DAY)
  })

  it("keeps five-hour behaviour unchanged", () => {
    const until = resolveCooldownUntil(
      [{ type: "five_hour", resetsAt: NOW + 2 * HOUR, exhausted: true }],
      NOW, DEFAULT_MS,
    )
    expect(until).toBe(NOW + 2 * HOUR)
  })

  it("still bounds an absurd reset, per window", () => {
    expect(resolveCooldownUntil(
      [{ type: "five_hour", resetsAt: NOW + 400 * DAY, exhausted: true }], NOW, DEFAULT_MS,
    )).toBe(NOW + cooldownCapMs("five_hour"))
    expect(resolveCooldownUntil(
      [{ type: "seven_day", resetsAt: NOW + 400 * DAY, exhausted: true }], NOW, DEFAULT_MS,
    )).toBe(NOW + cooldownCapMs("seven_day"))
  })

  it("treats a present-but-healthy window as no evidence", () => {
    // A healthy account always carries both windows with future resets, so
    // presence alone must never bench a profile.
    const until = resolveCooldownUntil([
      { type: "five_hour", resetsAt: NOW + 2 * HOUR, exhausted: false },
      { type: "seven_day", resetsAt: NOW + 3 * DAY, exhausted: false },
    ], NOW, DEFAULT_MS)
    expect(until).toBe(NOW + DEFAULT_MS)
  })

  it("ignores a past or missing reset", () => {
    expect(resolveCooldownUntil(
      [{ type: "seven_day", resetsAt: NOW - HOUR, exhausted: true }], NOW, DEFAULT_MS,
    )).toBe(NOW + DEFAULT_MS)
    expect(resolveCooldownUntil(
      [{ type: "seven_day", resetsAt: null, exhausted: true }], NOW, DEFAULT_MS,
    )).toBe(NOW + DEFAULT_MS)
  })

  it("does not bench a whole profile for a per-model weekly cap", () => {
    // Deliberate: sidelining an account for days because one model's budget ran
    // out would be worse than the bug. Documented as a known remainder.
    const until = resolveCooldownUntil([
      { type: "seven_day_opus", resetsAt: NOW + 3 * DAY, exhausted: true },
      { type: "seven_day_fable", resetsAt: NOW + 3 * DAY, exhausted: true },
    ], NOW, DEFAULT_MS)
    expect(until).toBe(NOW + DEFAULT_MS)
  })
})
