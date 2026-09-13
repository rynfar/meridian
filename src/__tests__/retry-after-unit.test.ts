/**
 * Unit tests for the Retry-After computation (#901) — pure functions, no mocks.
 */
import { describe, it, expect } from "bun:test"
import {
  parseRetryAfterMs,
  extractRetryAfterSeconds,
  retryAfterSeconds,
  retryAfterHeaders,
  retryAfterBodyFields,
  OVERLOADED_RETRY_AFTER_SECONDS,
  RATE_LIMIT_DEFAULT_RETRY_AFTER_SECONDS,
  RETRY_AFTER_MIN_SECONDS,
  RETRY_AFTER_MAX_SECONDS,
} from "../proxy/retryAfter"

const NOW = 1_800_000_000_000

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("120", NOW)).toBe(120_000)
  })

  it("parses an HTTP-date relative to now", () => {
    const at = new Date(NOW + 90_000).toUTCString()
    // toUTCString truncates to whole seconds, so allow the sub-second slack.
    expect(parseRetryAfterMs(at, NOW)).toBeLessThanOrEqual(90_000)
    expect(parseRetryAfterMs(at, NOW)).toBeGreaterThan(89_000)
  })

  it("never returns a negative wait for a date already past", () => {
    const at = new Date(NOW - 60_000).toUTCString()
    expect(parseRetryAfterMs(at, NOW)).toBe(0)
  })

  it("returns null for absent or unparseable values", () => {
    expect(parseRetryAfterMs(null, NOW)).toBeNull()
    expect(parseRetryAfterMs(undefined, NOW)).toBeNull()
    expect(parseRetryAfterMs("", NOW)).toBeNull()
    expect(parseRetryAfterMs("soon", NOW)).toBeNull()
  })
})

describe("extractRetryAfterSeconds", () => {
  it("reads the JSON spelling the CLI echoes", () => {
    expect(extractRetryAfterSeconds('API Error: 429 {"error":{"type":"rate_limit_error"},"retry-after":30}')).toBe(30)
  })

  it("reads the header spelling", () => {
    expect(extractRetryAfterSeconds("429 Too Many Requests (Retry-After: 45)")).toBe(45)
  })

  it("reads the snake_case spelling", () => {
    expect(extractRetryAfterSeconds("rate limited, retry_after=15")).toBe(15)
  })

  it("does not invent a hint from unrelated digits", () => {
    expect(extractRetryAfterSeconds("Claude Max rate limit reached at handler.js:402:15")).toBeNull()
    expect(extractRetryAfterSeconds("429 rate limit exceeded")).toBeNull()
    expect(extractRetryAfterSeconds(undefined)).toBeNull()
  })
})

describe("retryAfterSeconds", () => {
  it("returns null for statuses that do not take a Retry-After", () => {
    for (const status of [200, 400, 401, 402, 404, 500, 502, 504]) {
      expect(retryAfterSeconds({ status, now: NOW })).toBeNull()
    }
  })

  it("covers every throttle-shaped status Meridian returns", () => {
    for (const status of [429, 503, 529]) {
      expect(retryAfterSeconds({ status, now: NOW })).not.toBeNull()
    }
  })

  it("prefers the upstream header over everything else", () => {
    expect(retryAfterSeconds({
      status: 429,
      upstreamRetryAfter: "42",
      errorMessage: "retry-after: 999",
      resetAtMs: NOW + 600_000,
      now: NOW,
    })).toBe(42)
  })

  it("falls back to a hint embedded in the upstream error text", () => {
    expect(retryAfterSeconds({
      status: 429,
      errorMessage: 'API Error: 429 {"retry-after":30}',
      resetAtMs: NOW + 600_000,
      now: NOW,
    })).toBe(30)
  })

  it("derives from a known window reset when upstream said nothing", () => {
    expect(retryAfterSeconds({
      status: 429,
      errorMessage: "Claude Max rate limit reached",
      resetAtMs: NOW + 300_000,
      now: NOW,
    })).toBe(300)
  })

  it("ignores a reset that has already passed", () => {
    expect(retryAfterSeconds({ status: 429, resetAtMs: NOW - 1, now: NOW }))
      .toBe(RATE_LIMIT_DEFAULT_RETRY_AFTER_SECONDS)
  })

  it("uses the conservative default for a rate limit with no known reset", () => {
    expect(retryAfterSeconds({ status: 429, now: NOW })).toBe(RATE_LIMIT_DEFAULT_RETRY_AFTER_SECONDS)
  })

  it("uses the short constant for overload, which is transient", () => {
    expect(retryAfterSeconds({ status: 503, now: NOW })).toBe(OVERLOADED_RETRY_AFTER_SECONDS)
    expect(retryAfterSeconds({ status: 529, now: NOW })).toBe(OVERLOADED_RETRY_AFTER_SECONDS)
  })

  it("never emits 0 — that is the bare-429 hammering this replaces", () => {
    expect(retryAfterSeconds({ status: 429, upstreamRetryAfter: "0", now: NOW }))
      .toBe(RETRY_AFTER_MIN_SECONDS)
    expect(retryAfterSeconds({ status: 429, resetAtMs: NOW + 1, now: NOW }))
      .toBe(RETRY_AFTER_MIN_SECONDS)
  })

  it("caps a week-long reset so clients do not read it as 'never'", () => {
    expect(retryAfterSeconds({ status: 429, resetAtMs: NOW + 7 * 24 * 3600_000, now: NOW }))
      .toBe(RETRY_AFTER_MAX_SECONDS)
    expect(retryAfterSeconds({ status: 429, upstreamRetryAfter: "999999", now: NOW }))
      .toBe(RETRY_AFTER_MAX_SECONDS)
  })
})

describe("header and body helpers", () => {
  it("emit nothing when there is nothing to say", () => {
    expect(retryAfterHeaders(null)).toEqual({})
    expect(retryAfterBodyFields(null)).toEqual({})
  })

  it("emit the same number on both channels", () => {
    expect(retryAfterHeaders(30)).toEqual({ "Retry-After": "30" })
    expect(retryAfterBodyFields(30)).toEqual({ retry_after: 30 })
  })
})
