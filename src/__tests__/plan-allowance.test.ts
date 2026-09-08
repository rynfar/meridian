/**
 * Unit tests for the plan → allotment multiplier derivation.
 *
 * The module is pure, so these are direct assertions with no mocks. The cases
 * that matter are the ones where a wrong answer is worse than no answer: a
 * `max` that could be 5x or 20x, and a tier string Anthropic has not shipped
 * yet.
 */

import { describe, it, expect } from "bun:test"
import { normalizeRateLimitTier, planAllowance } from "../proxy/planAllowance"

describe("normalizeRateLimitTier", () => {
  it("strips the wire prefix and the underscores", () => {
    expect(normalizeRateLimitTier("default_claude_max_20x")).toBe("max 20x")
    expect(normalizeRateLimitTier("default_team_tier_1")).toBe("team tier 1")
  })

  it("accepts the bare spelling of the same tier", () => {
    expect(normalizeRateLimitTier("max_5x")).toBe("max 5x")
    expect(normalizeRateLimitTier("MAX_5X")).toBe("max 5x")
  })

  it("treats absent and blank as unknown rather than as a tier", () => {
    expect(normalizeRateLimitTier(null)).toBeNull()
    expect(normalizeRateLimitTier(undefined)).toBeNull()
    expect(normalizeRateLimitTier("   ")).toBeNull()
  })
})

describe("planAllowance", () => {
  it("derives every published Claude Code allotment", () => {
    expect(planAllowance({ rateLimitTier: "default_claude_max_20x" }))
      .toEqual({ multiplier: "20x", weight: 20, label: "Personal Max", accountType: "Personal", planName: "Max 20x" })
    expect(planAllowance({ rateLimitTier: "default_claude_max_5x" }))
      .toEqual({ multiplier: "5x", weight: 5, label: "Personal Max", accountType: "Personal", planName: "Max 5x" })
    expect(planAllowance({ rateLimitTier: "default_claude_pro" }))
      .toEqual({ multiplier: "1x", weight: 1, label: "Personal Pro", accountType: "Personal", planName: "Pro" })
    expect(planAllowance({ rateLimitTier: "team_tier_1" }))
      .toEqual({ multiplier: "6.25x", weight: 6.25, label: "Team Premium", accountType: "Team", planName: "Premium seat" })
    expect(planAllowance({ rateLimitTier: "team_premium" }))
      .toEqual({ multiplier: "6.25x", weight: 6.25, label: "Team Premium", accountType: "Team", planName: "Premium seat" })
    expect(planAllowance({ rateLimitTier: "team_standard" }))
      .toEqual({ multiplier: "1x", weight: 1, label: "Team Standard", accountType: "Team", planName: "Standard seat" })
  })

  it("sizes a Team seat from seatTier, which rateLimitTier cannot do", () => {
    // Measured across eleven live accounts: every Team seat reports
    // `rate_limit_tier: "default_claude_max_5x"` — byte-identical to a personal
    // Max 5x — while `seat_tier` carries `team_tier_1`. Sizing a Premium seat
    // off the rate-limit tier understates it by 25% and names it Personal.
    expect(planAllowance({
      rateLimitTier: "default_claude_max_5x",
      seatTier: "team_tier_1",
      subscriptionType: "team",
    })).toEqual({
      multiplier: "6.25x", weight: 6.25, label: "Team Premium",
      accountType: "Team", planName: "Premium seat",
    })
  })

  // The falsification test, and it is the whole reason to trust `seatTier`: a
  // real Team STANDARD seat was measured beside the four Premium ones, and it
  // differs in `seat_tier` alone. Its `rate_limit_tier` is `default_raven`, an
  // Anthropic codename naming no published allotment - so the rate-limit tier
  // cannot size EITHER kind of Team seat, one because it lies and one because
  // it says nothing.
  it("sizes a Team Standard seat whose rateLimitTier names no known tier", () => {
    expect(planAllowance({
      rateLimitTier: "default_raven",
      seatTier: "team_standard",
      subscriptionType: "team",
    })).toEqual({
      multiplier: "1x", weight: 1, label: "Team Standard",
      accountType: "Team", planName: "Standard seat",
    })
  })

  // Both spellings reach the same seat, since `seat_tier` is already scoped to
  // a team - a bare `standard` there means what `team_standard` means.
  it("accepts a seat tier spelled with or without its team prefix", () => {
    expect(planAllowance({ seatTier: "standard" }).planName).toBe("Standard seat")
    expect(planAllowance({ seatTier: "team_standard" }).planName).toBe("Standard seat")
    expect(planAllowance({ seatTier: "premium" }).planName).toBe("Premium seat")
  })

  it("ignores a seat tier on an account that has none, rather than guessing", () => {
    expect(planAllowance({ rateLimitTier: "default_claude_max_20x", seatTier: null }))
      .toEqual({
        multiplier: "20x", weight: 20, label: "Personal Max",
        accountType: "Personal", planName: "Max 20x",
      })
  })

  it("reads a bare seat tier as the team tier of that name", () => {
    expect(planAllowance({ seatTier: "standard", subscriptionType: "team" }).planName).toBe("Standard seat")
    expect(planAllowance({ seatTier: "premium", subscriptionType: "team" }).multiplier).toBe("6.25x")
  })

  it("leaves a personal account to its rate limit tier, since its seat tier is null", () => {
    expect(planAllowance({ rateLimitTier: "default_claude_max_20x", seatTier: null, subscriptionType: "max" }))
      .toEqual({ multiplier: "20x", weight: 20, label: "Personal Max", accountType: "Personal", planName: "Max 20x" })
  })

  it("prefers the tier over the subscription type when both are present", () => {
    // `subscriptionType: "max"` alone cannot distinguish 5x from 20x, so the
    // tier has to win — this is the case the whole module exists for.
    expect(planAllowance({ rateLimitTier: "default_claude_max_5x", subscriptionType: "max" }).multiplier)
      .toBe("5x")
  })

  it("never calls a Team seat Personal, however its tier is spelled", () => {
    // Measured on a ten-account host: two Team profiles report
    // `subscriptionType: "team"` with `rateLimitTier: "default_claude_max_5x"`.
    // The size is genuinely 5x; the name "Personal Max" is not, and a reader
    // deciding whose allotment to spend acts on the name.
    expect(planAllowance({ rateLimitTier: "default_claude_max_5x", subscriptionType: "team" }))
      .toEqual({ multiplier: "5x", weight: 5, label: "Team", accountType: "Team", planName: null })
    expect(planAllowance({ rateLimitTier: "default_claude_max_20x", subscriptionType: "team" }))
      .toEqual({ multiplier: "20x", weight: 20, label: "Team", accountType: "Team", planName: null })
    expect(planAllowance({ rateLimitTier: "team_standard", subscriptionType: "max" }))
      .toEqual({ multiplier: "1x", weight: 1, label: "Personal", accountType: "Personal", planName: null })
    expect(planAllowance({ rateLimitTier: "default_claude_max_5x", subscriptionType: "enterprise" }))
      .toEqual({ multiplier: "5x", weight: 5, label: "Enterprise", accountType: "Enterprise", planName: null })
  })

  it("keeps the tier's own label when the two agree", () => {
    expect(planAllowance({ rateLimitTier: "default_claude_max_20x", subscriptionType: "max" }).label)
      .toBe("Personal Max")
    expect(planAllowance({ rateLimitTier: "team_tier_1", subscriptionType: "team" }).label)
      .toBe("Team Premium")
    expect(planAllowance({ rateLimitTier: "default_claude_pro", subscriptionType: "pro" }).label)
      .toBe("Personal Pro")
  })

  it("keeps the tier's label when the subscription type says nothing usable", () => {
    expect(planAllowance({ rateLimitTier: "default_claude_max_5x", subscriptionType: "something_new" }).label)
      .toBe("Personal Max")
    expect(planAllowance({ rateLimitTier: "default_claude_max_5x", subscriptionType: "  " }).label)
      .toBe("Personal Max")
  })

  it("still names the family when the size is unknowable from the subscription type alone", () => {
    expect(planAllowance({ subscriptionType: "max" }))
      .toEqual({ multiplier: null, weight: null, label: null, accountType: "Personal", planName: null })
    expect(planAllowance({ subscriptionType: "team" }))
      .toEqual({ multiplier: null, weight: null, label: null, accountType: "Team", planName: null })
    expect(planAllowance({ subscriptionType: "enterprise" }))
      .toEqual({ multiplier: null, weight: null, label: null, accountType: "Enterprise", planName: null })
  })

  it("falls back to the subscription type for the one tier it pins", () => {
    expect(planAllowance({ subscriptionType: "pro" }))
      .toEqual({ multiplier: "1x", weight: 1, label: "Personal Pro", accountType: "Personal", planName: "Pro" })
  })

  it("returns nothing rather than a default for a tier it does not know", () => {
    expect(planAllowance({ rateLimitTier: "default_claude_max_50x" }))
      .toEqual({ multiplier: null, weight: null, label: null, accountType: null, planName: null })
    expect(planAllowance({})).toEqual({ multiplier: null, weight: null, label: null, accountType: null, planName: null })
    expect(planAllowance(null)).toEqual({ multiplier: null, weight: null, label: null, accountType: null, planName: null })
    expect(planAllowance(undefined)).toEqual({ multiplier: null, weight: null, label: null, accountType: null, planName: null })
  })

  it("hands back a fresh object so a caller cannot corrupt the table", () => {
    const first = planAllowance({ rateLimitTier: "default_claude_max_20x" })
    first.multiplier = "1x"
    expect(planAllowance({ rateLimitTier: "default_claude_max_20x" }).multiplier).toBe("20x")
  })
})
