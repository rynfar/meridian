/**
 * Which allowance did Anthropic refuse? Pure unit tests over the evidence
 * ladder in src/proxy/limitDetection.ts.
 *
 * The wordings used here are real: "You've hit your session limit · resets
 * 12:30am (America/Chicago)" was captured from the live proxy's error log, and
 * the weekly/short variants are the ones errors.ts already carries fixtures for.
 */
import { describe, it, expect } from "bun:test"
import { parseLimitWording, resolveResetClock, diagnoseLimit, limitModelScope, spentAllowanceResetAt, type LimitDiagnosis } from "../proxy/limitDetection"

const LIVE_SESSION_LIMIT = "Claude Code returned an error result: You've hit your session limit \u00b7 resets 12:30am (America/Chicago)"
const WEEKLY_LIMIT = "Claude Code returned an error result: You've hit your weekly limit \u00b7 resets 2pm (Asia/Jerusalem)"
const BARE_LIMIT = "Claude Code returned an error result: You've hit your limit \u00b7 resets 6:40pm (UTC)"
const NAMELESS = "429 rate limit reached for this account"
// Verbatim from the live proxy, 2026-10-05: a Fable request on a Claude Max
// profile whose 7d Fable window was spent, as server.ts hands it over with the
// subprocess's stderr appended.
const LIVE_FABLE_LIMIT = "Claude Code returned an error result: You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.\nSubprocess stderr: Warning: Custom betas are only available for API key users. Ignoring provided betas."

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

  it("reads the model's own weekly window out of the credits-era 'reached your Fable limit'", () => {
    const parsed = parseLimitWording(LIVE_FABLE_LIMIT)
    expect(parsed.bucket).toBe("seven_day_fable")
    expect(parsed.qualifier).toBe("fable")
  })

  it("reads a versioned, Claude-prefixed tier the same way", () => {
    expect(parseLimitWording("You've reached your Claude Opus 4.6 limit").bucket).toBe("seven_day_opus")
    expect(parseLimitWording("API Error: 400 You've reached your Sonnet 4.6 limit.").bucket).toBe("seven_day_sonnet")
  })

  it("reads no window out of a 'reached your' limit that names no model", () => {
    expect(parseLimitWording("You've reached your specified limit").bucket).toBeNull()
    expect(parseLimitWording("You've reached your Fable configured tool limit").bucket).toBeNull()
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

  it("says when the SDK evidence it went by was observed", () => {
    const d = diagnoseLimit({
      message: NAMELESS,
      now,
      sdkEntries: [{ rateLimitType: "seven_day_overage_included", status: "rejected", resetsAt: now + 3_600_000, observedAt: now - 1000 }],
    })
    expect(d.source).toBe("sdk_event")
    expect(d.observedAt).toBe(now - 1000)
    expect(diagnoseLimit({ message: LIVE_FABLE_LIMIT, now }).observedAt).toBeUndefined()
  })

  it("does not take an allowance the request was served past, on usage credits, for a refusal", () => {
    // CLI 2.1.284 reports an allowance that is spent while credits carry the
    // request as `rejected` with `isUsingOverage`: the request was served.
    const d = diagnoseLimit({
      message: NAMELESS,
      now,
      sdkEntries: [{ rateLimitType: "seven_day_overage_included", status: "rejected", isUsingOverage: true, resetsAt: now + 5 * 86_400_000, observedAt: now - 60_000 }],
    })
    expect(d.source).not.toBe("sdk_event")
    expect(d.bucket).toBeNull()
  })

  it("names the usage credits when the CLI says the account is out of them", () => {
    const d = diagnoseLimit({
      message: "Claude Code returned an error result: You're out of usage credits. Switch to another model to continue.",
      now,
      windows: [{ type: "seven_day_fable", utilization: 1, resetsAt: now + 86_400_000 }],
    })
    expect(d.bucket).toBe("usage_credits")
    expect(d.reported).toBe(true)
    expect(d.source).toBe("error_message")
    // Credits come back when someone buys them, not at a window's reset.
    expect(d.resetsAt).toBeNull()
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

  it("names the Fable window from the credits-era wording, with the reset the usage snapshot gives it", () => {
    const d = diagnoseLimit({
      message: LIVE_FABLE_LIMIT,
      now,
      windows: [
        { type: "five_hour", utilization: 0.08, resetsAt: now + 600_000 },
        { type: "seven_day_fable", utilization: 1, resetsAt: now + 5 * 86_400_000 },
      ],
    })
    expect(d.bucket).toBe("seven_day_fable")
    expect(d.source).toBe("error_message")
    expect(d.reported).toBe(true)
    expect(d.resetsAt).toBe(now + 5 * 86_400_000)
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

describe("limitModelScope", () => {
  const diagnosis = (bucket: string | null, reported = true): LimitDiagnosis => ({
    bucket,
    reported,
    source: reported ? "sdk_event" : "cached_usage",
    resetsAt: null,
    rationale: "",
  })

  it("confines a refusal of the Fable window to Fable requests", () => {
    expect(limitModelScope(diagnosis("seven_day_fable"), "claude-fable-5-1")).toBe("fable")
    expect(limitModelScope(diagnosis("seven_day_opus"), "opus[1m]")).toBe("opus")
  })

  it("reads the SDK's own name for the Fable allowance the same way", () => {
    // What the refused request's rate_limit_event carried on 2026-10-05:
    // `seven_day_overage_included`, rejected, with the 7d Fable window's reset.
    expect(limitModelScope(diagnosis("seven_day_overage_included"), "fable[1m]")).toBe("fable")
  })

  it("confines that refusal of a Mythos request to Mythos", () => {
    // Mythos goes upstream as the model it is, and whether it shares Fable's
    // allowance has not been seen: each model learns from its own refusal.
    expect(limitModelScope(diagnosis("seven_day_overage_included"), "claude-mythos-5")).toBe("mythos")
    expect(limitModelScope(diagnosis("seven_day_fable"), "claude-mythos-5-1")).toBeUndefined()
  })

  it("confines an account out of usage credits to the models billed to them", () => {
    // The CLI builds that banner only for a model it sells credits for; the
    // models the plan includes are served as before.
    expect(limitModelScope(diagnosis("usage_credits"), "claude-fable-5-1")).toBe("fable")
    expect(limitModelScope(diagnosis("usage_credits"), "claude-opus-5-5")).toBeUndefined()
  })

  it("leaves a refusal of an account-wide window to the whole account", () => {
    expect(limitModelScope(diagnosis("five_hour"), "claude-fable-5-1")).toBeUndefined()
    expect(limitModelScope(diagnosis("seven_day"), "claude-fable-5-1")).toBeUndefined()
  })

  it("does not confine a refusal to a model whose window was not the one named", () => {
    // SDK evidence can be fifteen minutes old: an Opus request refused for the
    // five-hour window may be diagnosed from a Fable rejection before it.
    expect(limitModelScope(diagnosis("seven_day_fable"), "claude-opus-5-5")).toBeUndefined()
    expect(limitModelScope(diagnosis("seven_day_overage_included"), "claude-opus-5-5")).toBeUndefined()
  })

  it("does not act on a guessed window", () => {
    expect(limitModelScope(diagnosis("seven_day_fable", false), "claude-fable-5-1")).toBeUndefined()
  })

  it("has nothing to say without a diagnosis, a window or a model it knows", () => {
    expect(limitModelScope(null, "claude-fable-5-1")).toBeUndefined()
    expect(limitModelScope(diagnosis(null), "claude-fable-5-1")).toBeUndefined()
    expect(limitModelScope(diagnosis("seven_day_fable"), "some-other-model")).toBeUndefined()
    expect(limitModelScope(diagnosis("seven_day_fable"), undefined)).toBeUndefined()
  })

  it("does not act on an SDK event from before the request it is asked about", () => {
    // The event is read for fifteen minutes, so a Fable request that is only
    // throttled can be diagnosed from a Fable rejection five minutes earlier.
    const requestStartedAt = 1_000_000
    const earlier = { ...diagnosis("seven_day_overage_included"), observedAt: requestStartedAt - 5 * 60_000 }
    const own = { ...diagnosis("seven_day_overage_included"), observedAt: requestStartedAt + 40 }
    expect(limitModelScope(earlier, "claude-fable-5-1", requestStartedAt)).toBeUndefined()
    expect(limitModelScope(own, "claude-fable-5-1", requestStartedAt)).toBe("fable")
    expect(limitModelScope({ ...own, observedAt: requestStartedAt }, "claude-fable-5-1", requestStartedAt)).toBe("fable")
  })

  it("acts on the refusal's own wording whenever it is asked", () => {
    const worded: LimitDiagnosis = { bucket: "seven_day_fable", reported: true, source: "error_message", resetsAt: null, rationale: "" }
    expect(limitModelScope(worded, "claude-fable-5-1", 1_000_000)).toBe("fable")
  })
})

describe("spentAllowanceResetAt", () => {
  const now = Date.UTC(2026, 9, 5, 23, 0, 0)
  const reset = now + 5 * 24 * 60 * 60_000
  const worded = (bucket: string): LimitDiagnosis => ({ bucket, reported: true, source: "error_message", resetsAt: reset, rationale: "" })
  const snapshot = (fable: number | null) => [
    { type: "five_hour", utilization: 1, resetsAt: now + 60 * 60_000 },
    { type: "seven_day_fable", utilization: fable, resetsAt: reset },
  ]

  it("is the reset of the model's own window when the usage snapshot shows that window spent", () => {
    expect(spentAllowanceResetAt(worded("seven_day_fable"), "fable", snapshot(1))).toBe(reset)
    // The SDK's name for the same allowance.
    expect(spentAllowanceResetAt(worded("seven_day_overage_included"), "fable", snapshot(1))).toBe(reset)
  })

  it("is unknown when the snapshot shows the window with room left", () => {
    // A window's reset is when it turns over, whatever was used of it. It says
    // when a refusal ends only for a refusal that window caused.
    expect(spentAllowanceResetAt(worded("seven_day_fable"), "fable", snapshot(0.2))).toBeNull()
    expect(spentAllowanceResetAt(worded("seven_day_fable"), "fable", snapshot(null))).toBeNull()
  })

  it("is unknown for an account out of usage credits, which come back when they are bought", () => {
    expect(spentAllowanceResetAt(worded("usage_credits"), "fable", snapshot(1))).toBeNull()
  })

  it("is unknown without a snapshot, and for a model with no window of its own", () => {
    expect(spentAllowanceResetAt(worded("seven_day_fable"), "fable", undefined)).toBeNull()
    expect(spentAllowanceResetAt(worded("seven_day_overage_included"), "mythos", snapshot(1))).toBeNull()
  })
})
