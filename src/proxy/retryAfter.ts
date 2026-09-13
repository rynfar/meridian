/**
 * `Retry-After` computation for the throttle-shaped responses Meridian returns.
 *
 * Pure leaf module — no I/O, no state, no imports from `server.ts` or
 * `session/`. Everything here is a function of its arguments.
 *
 * Why it exists: a harness that runs N concurrent children against one account
 * has nothing to coordinate against when every 429 arrives bare. Each child
 * backs off on its own schedule, they all wake together, and the account is
 * re-hammered at the exact moment the window is still spent. A single number on
 * the response is what turns N independent retry loops into one.
 */

/** Statuses that carry a `Retry-After`. 529 is Anthropic's overloaded code,
 *  which Meridian mirrors on the cross-process turn timeout. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 503, 529])

/**
 * Overload is a transient upstream condition measured in seconds, not a spent
 * quota window. A long hint here would idle a client through a blip that has
 * already cleared.
 */
export const OVERLOADED_RETRY_AFTER_SECONDS = 5

/**
 * Fallback for a rate limit whose reset we cannot name. Deliberately
 * conservative: too short re-hammers a spent window, and the cost of being a
 * little long is one idle minute on a request that was already refused.
 */
export const RATE_LIMIT_DEFAULT_RETRY_AFTER_SECONDS = 60

/** Never emit less than a second — `Retry-After: 0` is the bare-429 behavior
 *  this module exists to replace. */
export const RETRY_AFTER_MIN_SECONDS = 1

/** A weekly cap can reset days out. Clients treat a huge `Retry-After` as
 *  "never", so bound it and let them re-probe; the account state is in
 *  `/v1/usage/quota` for anything that needs the real boundary. */
export const RETRY_AFTER_MAX_SECONDS = 24 * 60 * 60

/**
 * Parse an upstream `Retry-After` header value into milliseconds.
 *
 * Accepts both RFC 9110 forms: delta-seconds and an HTTP-date. Returns null
 * when the value is absent or unparseable, so callers can fall through to a
 * computed hint rather than inventing one from `NaN`.
 */
export function parseRetryAfterMs(raw: string | null | undefined, now: number = Date.now()): number | null {
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const retryAt = Date.parse(raw)
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : null
}

/**
 * Pull a retry hint out of raw upstream error text.
 *
 * The `/v1/messages` path talks to the Claude CLI subprocess, which surfaces
 * the API's error as a string rather than a response object — so when upstream
 * *did* say how long to wait, the only place that number survives is inside the
 * message. Matches the JSON-ish and header-ish spellings the CLI has been
 * observed to echo (`"retry-after": 30`, `retry_after=30`, `Retry-After: 30`).
 *
 * Deliberately narrow: only a bare integer count of seconds directly attached
 * to a retry-after key. Anything looser starts matching line numbers and
 * unrelated digits, which is how a wrong hint would reach every client.
 */
export function extractRetryAfterSeconds(errMsg: string | null | undefined): number | null {
  if (!errMsg) return null
  const match = errMsg.match(/retry[-_ ]?after"?\s*[:=]\s*"?(\d+)/i)
  if (!match?.[1]) return null
  const seconds = Number(match[1])
  return Number.isFinite(seconds) ? seconds : null
}

export interface RetryAfterInput {
  /** HTTP status Meridian is about to return. */
  status: number
  /** Verbatim upstream `Retry-After` header value, when one was observed. */
  upstreamRetryAfter?: string | null
  /** Raw upstream error text, scanned for an embedded retry hint. */
  errorMessage?: string | null
  /** Epoch ms at which the exhausted window is known to reset. Null when
   *  nothing proves a window is actually spent — a healthy account always has
   *  a future five-hour boundary, and that boundary is not a wait instruction. */
  resetAtMs?: number | null
  now?: number
}

/**
 * Seconds to put in `Retry-After`, or null when the status does not take one.
 *
 * Precedence is "most authoritative first": what upstream said, then what
 * upstream's error text said, then the account's own observed reset, then a
 * per-status constant. Every branch is clamped, so no source can produce a 0
 * (retry immediately, the bug) or a multi-day value (retry never).
 */
export function retryAfterSeconds(input: RetryAfterInput): number | null {
  if (!RETRYABLE_STATUSES.has(input.status)) return null
  const now = input.now ?? Date.now()

  const upstreamMs = parseRetryAfterMs(input.upstreamRetryAfter, now)
  if (upstreamMs !== null) return clamp(Math.ceil(upstreamMs / 1000))

  const embedded = extractRetryAfterSeconds(input.errorMessage)
  if (embedded !== null) return clamp(embedded)

  if (input.resetAtMs != null && input.resetAtMs > now) {
    return clamp(Math.ceil((input.resetAtMs - now) / 1000))
  }

  return input.status === 429
    ? RATE_LIMIT_DEFAULT_RETRY_AFTER_SECONDS
    : OVERLOADED_RETRY_AFTER_SECONDS
}

/**
 * Header bag to spread into a `Response`. Empty when there is nothing to say,
 * so call sites stay a single spread rather than a conditional.
 */
export function retryAfterHeaders(seconds: number | null): Record<string, string> {
  return seconds === null ? {} : { "Retry-After": String(seconds) }
}

/**
 * The same hint as a body field, for SSE.
 *
 * A streaming turn's headers are on the wire long before the rate limit that
 * kills it is known, so the header cannot carry this and the error frame is the
 * only channel left. Emitted on the JSON path too so one field name means one
 * thing on both.
 */
export function retryAfterBodyFields(seconds: number | null): Record<string, number> {
  return seconds === null ? {} : { retry_after: seconds }
}

function clamp(seconds: number): number {
  if (!Number.isFinite(seconds)) return RATE_LIMIT_DEFAULT_RETRY_AFTER_SECONDS
  return Math.min(RETRY_AFTER_MAX_SECONDS, Math.max(RETRY_AFTER_MIN_SECONDS, Math.round(seconds)))
}
