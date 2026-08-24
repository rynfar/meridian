/**
 * Which allowance did Anthropic refuse? Pure unit tests over the evidence
 * ladder in src/proxy/limitDetection.ts.
 *
 * The wordings used here are real: "You've hit your session limit · resets
 * 12:30am (America/Chicago)" was captured from the live proxy's error log, and
 * the weekly/short variants are the ones errors.ts already carries fixtures for.
 */
import { describe, it, expect } from "bun:test"
import { parseLimitWording, resolveResetClock, diagnoseLimit } from "../proxy/limitDetection"

const LIVE_SESSION_LIMIT = "Claude Code returned an error result: You've hit your session limit \u00b7 resets 12:30am (America/Chicago)"
const WEEKLY_LIMIT = "Claude Code returned an error result: You've hit your weekly limit \u00b7 resets 2pm (Asia/Jerusalem)"
const BARE_LIMIT = "Claude Code returned an error result: You've hit your limit \u00b7 resets 6:40pm (UTC)"
const NAMELESS = "429 rate limit reached for this account"

describe("parseLimitWording", () => {
  it("reads the five-hour window out of the CLI's 'session limit' wording", () => {
    const parsed = parseLimitWording(LIVE_SESSION_LIMIT)
    expect(parsed.bucket).toBe("five_hour")
    expect(parsed.clock).toBe("12:30am")
    expect(parsed.zone).toBe("America/Chicago")
  })

  it("reads the weekly window and its zone", () => {
    const parsed = parseLimitWording(WEEKLY_LIMIT)
    expect(parsed.bucket).toBe("seven_day")
    expect(parsed.clock).toBe("2pm")
    expect(parsed.zone).toBe("Asia/Jerusalem")
  })

  it("names no bucket for the unqualified wording, but still finds the clock", () => {
    const parsed = parseLimitWording(BARE_LIMIT)
    expect(parsed.bucket).toBeNull()
    expect(parsed.clock).toBe("6:40pm")
    expect(parsed.zone).toBe("UTC")
  })

  it("prefers a model-qualified weekly bucket when the CLI names one", () => {
    expect(parseLimitWording("You've hit your weekly opus limit").bucket).toBe("seven_day_opus")
    expect(parseLimitWording("You've hit your weekly fable limit").bucket).toBe("seven_day_fable")
  })

  it("returns nulls rather than throwing on prose it has never seen", () => {
    const parsed = parseLimitWording("something else entirely went wrong")
    expect(parsed.bucket).toBeNull()
    expect(parsed.clock).toBeNull()
  })

  it("keeps an unrecognized qualifier so it can be reported verbatim", () => {
    expect(parseLimitWording("You've hit your monthly limit").qualifier).toBe("monthly")
  })
})

describe("resolveResetClock", () => {
  const wallClockIn = (ts: number, zone: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hour12: false, hour: "2-digit", minute: "2-digit" })
      .format(new Date(ts))

  it("resolves a clock time to the next instant it occurs in that zone", () => {
    const now = Date.UTC(2026, 7, 16, 12, 0, 0)
    const resolved = resolveResetClock("12:30am", "America/Chicago", now)
    expect(resolved).not.toBeNull()
    expect(resolved!).toBeGreaterThan(now)
    expect(wallClockIn(resolved!, "America/Chicago")).toBe("00:30")
  })

  it("never resolves more than a day out, because the CLI prints no date", () => {
    const now = Date.UTC(2026, 7, 16, 12, 0, 0)
    const resolved = resolveResetClock("2pm", "Asia/Jerusalem", now)
    expect(resolved).not.toBeNull()
    expect(resolved! - now).toBeLessThanOrEqual(26 * 60 * 60_000)
    expect(wallClockIn(resolved!, "Asia/Jerusalem")).toBe("14:00")
  })

  it("handles the bare-hour, midnight and noon forms", () => {
    const now = Date.UTC(2026, 7, 16, 12, 0, 0)
    expect(wallClockIn(resolveResetClock("6:40pm", "UTC", now)!, "UTC")).toBe("18:40")
    expect(wallClockIn(resolveResetClock("midnight", "UTC", now)!, "UTC")).toBe("00:00")
    expect(wallClockIn(resolveResetClock("noon", "UTC", now)!, "UTC")).toBe("12:00")
  })

  it("defaults to UTC when the CLI prints no zone", () => {
    const now = Date.UTC(2026, 7, 16, 12, 0, 0)
    expect(wallClockIn(resolveResetClock("3pm", null, now)!, "UTC")).toBe("15:00")
  })

  it("returns null for an unknown zone or unreadable clock instead of guessing", () => {
    const now = Date.UTC(2026, 7, 16, 12, 0, 0)
    expect(resolveResetClock("2pm", "Mars/Olympus_Mons", now)).toBeNull()
    expect(resolveResetClock("half past two", "UTC", now)).toBeNull()
    expect(resolveResetClock("25:00", "UTC", now)).toBeNull()
  })
})

describe("diagnoseLimit", () => {
  const now = Date.UTC(2026, 7, 16, 12, 0, 0)

  it("trusts a fresh rejected SDK event above everything else", () => {
    const d = diagnoseLimit({
      message: WEEKLY_LIMIT,
      now,
      sdkEntries: [{ rateLimitType: "seven_day_opus", status: "rejected", resetsAt: now + 3_600_000, observedAt: now - 1000 }],
      windows: [{ type: "five_hour", utilization: 0.99, resetsAt: now + 600_000 }],
    })
    expect(d.bucket).toBe("seven_day_opus")
    expect(d.source).toBe("sdk_event")
    expect(d.reported).toBe(true)
    expect(d.resetsAt).toBe(now + 3_600_000)
  })

  it("ignores a rejected SDK event too old to describe this refusal", () => {
    const d = diagnoseLimit({
      message: NAMELESS,
      now,
      sdkEntries: [{ rateLimitType: "seven_day", status: "rejected", resetsAt: now + 3_600_000, observedAt: now - 60 * 60_000 }],
    })
    expect(d.source).not.toBe("sdk_event")
  })

  it("does not treat a healthy SDK entry as evidence of anything", () => {
    const d = diagnoseLimit({
      message: NAMELESS,
      now,
      sdkEntries: [{ rateLimitType: "five_hour", status: "allowed", utilization: 0.4, resetsAt: now + 3_600_000, observedAt: now - 1000 }],
    })
    expect(d.source).toBe("unknown")
    expect(d.bucket).toBeNull()
  })

  it("falls to the error wording when no SDK event says rejected, and resolves its reset", () => {
    const d = diagnoseLimit({ message: LIVE_SESSION_LIMIT, now })
    expect(d.bucket).toBe("five_hour")
    expect(d.source).toBe("error_message")
    expect(d.reported).toBe(true)
    expect(d.resetsAt).not.toBeNull()
    expect(d.resetsAt!).toBeGreaterThan(now)
  })

  it("guesses the hottest cached window when nothing named one, and marks it a guess", () => {
    const d = diagnoseLimit({
      message: BARE_LIMIT,
      now,
      windows: [
        { type: "five_hour", utilization: 0.3, resetsAt: now + 600_000 },
        { type: "seven_day", utilization: 0.97, resetsAt: now + 86_400_000 },
      ],
    })
    expect(d.bucket).toBe("seven_day")
    expect(d.source).toBe("cached_usage")
    expect(d.reported).toBe(false)
  })

  it("deduces the 5-hour window when no weekly window is anywhere near its limit", () => {
    // The owner's own reasoning, and the corp4 case exactly: 5h 67% / 7d 7%,
    // refusing. Nothing is above the hot threshold, but a weekly window at 7%
    // cannot be what ran out.
    const d = diagnoseLimit({
      message: NAMELESS,
      now,
      windows: [
        { type: "five_hour", utilization: 0.67, resetsAt: now + 600_000 },
        { type: "seven_day", utilization: 0.07, resetsAt: now + 86_400_000 },
      ],
    })
    expect(d.bucket).toBe("five_hour")
    expect(d.source).toBe("cached_usage")
    expect(d.reported).toBe(false)
    expect(d.resetsAt).toBe(now + 600_000)
  })

  it("does not deduce a bucket when a weekly window is also plausible", () => {
    const d = diagnoseLimit({
      message: NAMELESS,
      now,
      windows: [
        { type: "five_hour", utilization: 0.5, resetsAt: now + 600_000 },
        { type: "seven_day", utilization: 0.85, resetsAt: now + 86_400_000 },
      ],
    })
    expect(d.bucket).toBeNull()
    expect(d.source).toBe("unknown")
  })

  it("reports an unknown verdict rather than inventing one when there is no evidence at all", () => {
    const d = diagnoseLimit({ message: NAMELESS, now })
    expect(d.bucket).toBeNull()
    expect(d.reported).toBe(false)
    expect(d.source).toBe("unknown")
    expect(d.rationale).toContain("without naming a window")
  })
})
