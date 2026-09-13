/**
 * Consecutive upstream-idle ceiling.
 *
 * guardUpstreamIdle turns a stalled model stream into a 504, which is the right
 * answer for a one-off stall: a retry usually clears it. What a 504 cannot say
 * is that the SAME session has now stalled the same way several turns running.
 * "Transient, try again" is what every client retry policy reads in a 5xx, so a
 * session that stalls deterministically gets replayed forever at full upstream
 * cost — on 2026-08-16 that ran twenty turns into a half-hour loop, each killed
 * at exactly the idle limit, each retried, none ever completing.
 *
 * The proxy does not retry; the client does. Past the ceiling it emits a
 * terminal error and briefly rejects identical retries before opening another
 * stream. A changed request can try immediately.
 *
 * Counts are scoped to the session and exact request. Changed requests and
 * completed turns clear the streak. A terminal verdict is checked before the
 * next HTTP response opens because some clients retry terminal SSE errors.
 * The pause expires after one idle window (at least 60 seconds), so a transient
 * outage cannot permanently lock the request out. All times are caller-supplied.
 */

import { createHash } from "node:crypto"

/** Exact request identity: changes must never inherit another turn's retry block. */
export function idleStallRequestKey(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body) ?? "undefined").digest("hex")
}

export function idleStallPauseMs(idleMs: number): number {
  // Leave time for clients that back off before retrying a terminal SSE event.
  return Math.max(60_000, idleMs)
}

export interface IdleStallRequestContext {
  key: string
  now: number
}

interface IdleStallEntry {
  consecutive: number
  request?: IdleStallRequestContext
  verdict: IdleStallVerdict
}

export interface IdleStallVerdict {
  status: number
  type: string
  message: string
  /** Consecutive stalls on this session, including the one being judged. */
  consecutive: number
  /** True when the ceiling fired and the client is being told to stop. */
  terminal: boolean
}

/** Carries a classified idle-stall response through the non-stream error path. */
export class IdleStallCeilingError extends Error {
  constructor(readonly verdict: IdleStallVerdict) {
    super(verdict.message)
    this.name = "IdleStallCeilingError"
  }
}

/** Tracks consecutive idle stalls per session and rules on each one.
 *
 *  Bounded by construction. The session maps in server.ts that predate this are
 *  plain unbounded Maps; a tracker keyed by session id would leak the same way,
 *  so capacity is required rather than optional. */
export class IdleStallTracker {
  private readonly counts: Map<string, IdleStallEntry> = new Map()

  /** @param ceiling Consecutive stalls tolerated before the verdict turns
   *                 terminal. 0 disables the ceiling — every stall stays a 504,
   *                 which is the pre-ceiling behaviour.
   *  @param capacity Maximum sessions tracked; the oldest entry is evicted
   *                  first. */
  constructor(
    private readonly ceiling: number,
    private readonly capacity: number,
  ) {}

  /** Clear a session's streak. Call on any completed turn — a turn that
   *  finished is proof the session can still make progress. */
  clear(sessionKey: string): void {
    this.counts.delete(sessionKey)
  }

  /** Check before opening HTTP/SSE. Time is supplied by the caller, not read here. */
  preflight(sessionKey: string, requestKey: string, idleMs: number, now: number): IdleStallVerdict | undefined {
    const entry = this.counts.get(sessionKey)
    if (!entry?.request) return undefined
    if (this.ceiling <= 0 || idleMs <= 0 || entry.request.key !== requestKey
      || now - entry.request.now >= idleStallPauseMs(idleMs)) {
      this.clear(sessionKey)
      return undefined
    }
    return entry.verdict.terminal ? entry.verdict : undefined
  }

  /** Record a stall and rule on it.
   *
   *  An empty session key means the turn carries no session identity to
   *  correlate against (a first turn that stalled before the SDK reported its
   *  session id). Those are counted as one-offs rather than pooled under a
   *  shared "" key, which would let unrelated sessions trip each other's
   *  ceiling. */
  record(sessionKey: string, idleMs: number, sinceLastMs: number, request?: IdleStallRequestContext): IdleStallVerdict {
    const previous = this.counts.get(sessionKey)
    const sameRequest = !request || previous?.request?.key === request.key
    const consecutive = sessionKey ? (sameRequest ? previous?.consecutive ?? 0 : 0) + 1 : 1
    const remember = (verdict: IdleStallVerdict): IdleStallVerdict => {
      if (sessionKey) {
        this.counts.delete(sessionKey)
        this.counts.set(sessionKey, { consecutive, request, verdict })
        while (this.counts.size > this.capacity) {
          const oldest = this.counts.keys().next()
          if (oldest.done) break
          this.counts.delete(oldest.value)
        }
      }
      return verdict
    }

    if (this.ceiling <= 0 || consecutive < this.ceiling) {
      return remember({
        status: 504,
        type: "upstream_timeout",
        message: `Upstream stalled: no data for ${sinceLastMs}ms`,
        consecutive,
        terminal: false,
      })
    }

    return remember({
      status: 400,
      type: "invalid_request_error",
      message: `Upstream stalled with no data for ${sinceLastMs}ms — the ${consecutive}${ordinalSuffix(consecutive)} consecutive stall on this session (limit ${idleMs}ms). The retry limit has been reached. Modify or shorten the turn, raise MERIDIAN_UPSTREAM_IDLE_MS, or wait ${Math.ceil(idleStallPauseMs(idleMs) / 1000)} seconds after the last stall before retrying it unchanged.`,
      consecutive,
      terminal: true,
    })
  }

  /** Test/telemetry accessor. */
  streak(sessionKey: string): number {
    return this.counts.get(sessionKey)?.consecutive ?? 0
  }
}

function ordinalSuffix(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return "th"
  switch (n % 10) {
    case 1:
      return "st"
    case 2:
      return "nd"
    case 3:
      return "rd"
    default:
      return "th"
  }
}
