/**
 * Unit normalization for SDK reset timestamps (#708).
 *
 * The SDK reports `resetsAt` / `overageResetsAt` in epoch SECONDS; every
 * consumer downstream treats them as epoch milliseconds. Proven live: the same
 * `five_hour` reset arrived as `1785234600292` from OAuth and `1785234600` from
 * the SDK. Left unconverted, `resetsAt > Date.now()` is always false, so tier 1
 * of the priority cooldown chain can never match, and `/v1/usage/quota` hands
 * consumers a 1970-era date.
 *
 * Every pre-existing fixture in the suite used millisecond values, which is why
 * none of them caught this.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import { rateLimitStore, toEpochMs } from "../proxy/rateLimitStore"

/** A plausible "now" in each unit, from the live observation in #708. */
const RESET_SECONDS = 1785234600
const RESET_MS = 1785234600000

describe("toEpochMs", () => {
  it("scales a seconds-valued timestamp to milliseconds", () => {
    expect(toEpochMs(RESET_SECONDS)).toBe(RESET_MS)
  })

  it("leaves an already-millisecond timestamp untouched", () => {
    // The SDK type documents no unit, so the conversion must be idempotent
    // against a future SDK that switches to milliseconds.
    expect(toEpochMs(RESET_MS)).toBe(RESET_MS)
  })

  it("is idempotent — converting twice does not double-scale", () => {
    expect(toEpochMs(toEpochMs(RESET_SECONDS))).toBe(RESET_MS)
  })

  it("returns undefined for absent values", () => {
    expect(toEpochMs(undefined)).toBeUndefined()
  })

  it("returns undefined for values that cannot be a timestamp", () => {
    expect(toEpochMs(0)).toBeUndefined()
    expect(toEpochMs(-1)).toBeUndefined()
    expect(toEpochMs(NaN)).toBeUndefined()
    expect(toEpochMs(Infinity)).toBeUndefined()
  })

  it("keeps the two unit ranges unambiguous at the boundary", () => {
    // Below the threshold is read as seconds, at or above as milliseconds.
    // Both branches must land in a sane calendar range rather than 1970.
    expect(toEpochMs(1e11)).toBe(1e11)
    expect(toEpochMs(1e11 - 1)).toBe(Math.round((1e11 - 1) * 1000))
  })
})

describe("rateLimitStore.record — unit normalization", () => {
  beforeEach(() => {
    rateLimitStore.clear()
  })

  it("stores a seconds-valued resetsAt as milliseconds", () => {
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: RESET_SECONDS,
    } as any)

    expect(rateLimitStore.get("work", "five_hour")?.resetsAt).toBe(RESET_MS)
  })

  it("normalizes overageResetsAt from the same payload", () => {
    // Same source, same units, and exposed by the same endpoint — missing it
    // would leave half the contract broken.
    rateLimitStore.record("work", {
      status: "allowed",
      rateLimitType: "overage",
      overageResetsAt: RESET_SECONDS,
    } as any)

    expect(rateLimitStore.get("work", "overage")?.overageResetsAt).toBe(RESET_MS)
  })

  it("makes a live reset comparable against Date.now()", () => {
    // The actual defect: this comparison gates tier 1 of the cooldown chain.
    const futureSeconds = Math.floor(Date.now() / 1000) + 3600
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: futureSeconds,
    } as any)

    const entry = rateLimitStore.get("work", "five_hour")!
    expect(entry.resetsAt!).toBeGreaterThan(Date.now())
  })

  it("leaves millisecond input unchanged, so existing fixtures stay valid", () => {
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: RESET_MS,
    } as any)

    expect(rateLimitStore.get("work", "five_hour")?.resetsAt).toBe(RESET_MS)
  })

  it("records an absent resetsAt as undefined rather than 0", () => {
    // A 0 would read as a valid past timestamp to `(e.resetsAt ?? 0) > now`
    // consumers and to the quota endpoint's `?? null`.
    rateLimitStore.record("work", {
      status: "allowed",
      rateLimitType: "seven_day",
      utilization: 0.4,
    } as any)

    const entry = rateLimitStore.get("work", "seven_day")!
    expect(entry.resetsAt).toBeUndefined()
    expect(entry.utilization).toBe(0.4)
  })

  it("preserves the other fields it does not own", () => {
    rateLimitStore.record("work", {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      resetsAt: RESET_SECONDS,
      utilization: 0.91,
      isUsingOverage: true,
    } as any)

    const entry = rateLimitStore.get("work", "five_hour")! as any
    expect(entry.status).toBe("allowed_warning")
    expect(entry.utilization).toBe(0.91)
    expect(entry.isUsingOverage).toBe(true)
  })

  it("normalizes per profile without cross-contamination", () => {
    rateLimitStore.record("work", {
      status: "rejected", rateLimitType: "five_hour", resetsAt: RESET_SECONDS,
    } as any)
    rateLimitStore.record("personal", {
      status: "allowed", rateLimitType: "five_hour", resetsAt: RESET_SECONDS + 600,
    } as any)

    expect(rateLimitStore.get("work", "five_hour")?.resetsAt).toBe(RESET_MS)
    expect(rateLimitStore.get("personal", "five_hour")?.resetsAt).toBe(RESET_MS + 600_000)
  })
})
