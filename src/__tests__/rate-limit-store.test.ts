/**
 * Unit tests for the rate-limit store.
 *
 * The store is a process-wide singleton; each test instantiates a fresh
 * private copy via `_RateLimitStoreForTests` to avoid cross-test bleed.
 */

import { describe, expect, it } from "bun:test"
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"
import { _RateLimitStoreForTests } from "../proxy/rateLimitStore"

const FIVE_HOUR: SDKRateLimitInfo = {
  status: "allowed",
  rateLimitType: "five_hour",
  utilization: 0.42,
  resetsAt: 1_730_000_000_000,
}

const SEVEN_DAY: SDKRateLimitInfo = {
  status: "allowed_warning",
  rateLimitType: "seven_day",
  utilization: 0.91,
  resetsAt: 1_730_500_000_000,
  surpassedThreshold: 0.9,
}

const WORK = "work"
const PERSONAL = "personal"

describe("rateLimitStore", () => {
  it("starts empty", () => {
    const store = new _RateLimitStoreForTests()
    expect(store.size()).toBe(0)
    expect(store.getAll(WORK)).toEqual([])
  })

  it("records distinct buckets keyed by rateLimitType", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, FIVE_HOUR)
    store.record(WORK, SEVEN_DAY)
    expect(store.size(WORK)).toBe(2)
    const types = store.getAll(WORK).map(e => e.rateLimitType).sort()
    expect(types).toEqual(["five_hour", "seven_day"])
  })

  it("overwrites on second record for same bucket (last-write-wins)", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, { ...FIVE_HOUR, utilization: 0.42 })
    store.record(WORK, { ...FIVE_HOUR, utilization: 0.55 })
    expect(store.size(WORK)).toBe(1)
    expect(store.get(WORK, "five_hour")?.utilization).toBe(0.55)
  })

  it("buckets entries without rateLimitType under 'default'", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, { status: "allowed", utilization: 0.1 })
    expect(store.size(WORK)).toBe(1)
    expect(store.get(WORK, "default")?.utilization).toBe(0.1)
  })

  it("ignores nullish or non-object input without throwing", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, undefined)
    store.record(WORK, null as unknown as SDKRateLimitInfo)
    store.record(WORK, "nope" as unknown as SDKRateLimitInfo)
    expect(store.size()).toBe(0)
  })

  it("stamps observedAt on each record", () => {
    const store = new _RateLimitStoreForTests()
    const before = Date.now()
    store.record(WORK, FIVE_HOUR)
    const after = Date.now()
    const entry = store.get(WORK, "five_hour")
    expect(entry?.observedAt).toBeGreaterThanOrEqual(before)
    expect(entry?.observedAt).toBeLessThanOrEqual(after)
  })

  it("getAll returns entries newest-first by observedAt", async () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, FIVE_HOUR)
    // Force monotonic observedAt — Bun's `Date.now()` resolution is fine here.
    await Bun.sleep(2)
    store.record(WORK, SEVEN_DAY)
    // Compare the mapped sequence rather than indexing into the array directly
    // so the test stays under TypeScript's `noUncheckedIndexedAccess` strict
    // mode (which CI's `tsc --noEmit` enforces but Bun's lenient default tsc
    // does not).
    const orderedTypes = store.getAll(WORK).map(e => e.rateLimitType)
    expect(orderedTypes).toEqual(["seven_day", "five_hour"])
  })

  it("preserves all SDKRateLimitInfo fields verbatim", () => {
    const store = new _RateLimitStoreForTests()
    const full: SDKRateLimitInfo = {
      status: "allowed_warning",
      rateLimitType: "overage",
      utilization: 0.78,
      resetsAt: 1_730_000_000_000,
      overageStatus: "allowed",
      overageResetsAt: 1_730_100_000_000,
      isUsingOverage: true,
      surpassedThreshold: 0.75,
      overageDisabledReason: "no_limits_configured",
    }
    store.record(WORK, full)
    const got = store.get(WORK, "overage")
    expect(got).toMatchObject(full)
  })

  // --- Profile isolation (the bug this scoping fixes) ---

  it("keeps the same bucket type separate per profile", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, { ...FIVE_HOUR, resetsAt: 1_000 })
    store.record(PERSONAL, { ...FIVE_HOUR, resetsAt: 9_999 })
    expect(store.get(WORK, "five_hour")?.resetsAt).toBe(1_000)
    expect(store.get(PERSONAL, "five_hour")?.resetsAt).toBe(9_999)
    expect(store.size(WORK)).toBe(1)
    expect(store.size(PERSONAL)).toBe(1)
    expect(store.size()).toBe(2)
  })

  it("getAll returns only the requested profile's entries", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, FIVE_HOUR)
    store.record(PERSONAL, SEVEN_DAY)
    expect(store.getAll(WORK).map(e => e.rateLimitType)).toEqual(["five_hour"])
    expect(store.getAll(PERSONAL).map(e => e.rateLimitType)).toEqual(["seven_day"])
  })

  it("getAll for an unseen profile returns an empty array", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, FIVE_HOUR)
    expect(store.getAll("never-seen")).toEqual([])
    expect(store.get("never-seen", "five_hour")).toBeUndefined()
  })

  it("clear(profileId) drops one profile and leaves others intact", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, FIVE_HOUR)
    store.record(PERSONAL, FIVE_HOUR)
    store.clear(WORK)
    expect(store.getAll(WORK)).toEqual([])
    expect(store.getAll(PERSONAL).map(e => e.rateLimitType)).toEqual(["five_hour"])
  })

  it("clear() with no argument drops every profile", () => {
    const store = new _RateLimitStoreForTests()
    store.record(WORK, FIVE_HOUR)
    store.record(PERSONAL, SEVEN_DAY)
    store.clear()
    expect(store.size()).toBe(0)
    expect(store.getAll(WORK)).toEqual([])
    expect(store.getAll(PERSONAL)).toEqual([])
  })

  it("treats 'default' as an ordinary profile key (single-profile setups)", () => {
    const store = new _RateLimitStoreForTests()
    store.record("default", FIVE_HOUR)
    expect(store.getAll("default").map(e => e.rateLimitType)).toEqual(["five_hour"])
    expect(store.get("default", "five_hour")?.utilization).toBe(0.42)
  })
})
