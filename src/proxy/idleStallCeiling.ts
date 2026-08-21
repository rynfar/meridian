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
 * The proxy does not retry; the client does. So the only lever here is the
 * status code, and past the ceiling this swaps the retryable 504 for a terminal
 * error carrying the two things that actually resolve it — raise the idle limit
 * above the model's real thinking pause, or shorten the turn.
 *
 * Counting is per session and resets on any completed turn: the ceiling is
 * about a session that cannot make progress, not a session that has ever
 * stalled.
 */

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
  private readonly counts: Map<string, number> = new Map()

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

  /** Record a stall and rule on it.
   *
   *  An empty session key means the turn carries no session identity to
   *  correlate against (a first turn that stalled before the SDK reported its
   *  session id). Those are counted as one-offs rather than pooled under a
   *  shared "" key, which would let unrelated sessions trip each other's
   *  ceiling. */
  record(sessionKey: string, idleMs: number, sinceLastMs: number): IdleStallVerdict {
    const consecutive = sessionKey ? (this.counts.get(sessionKey) ?? 0) + 1 : 1
    if (sessionKey) {
      // Re-insert to refresh recency, then evict from the front (insertion
      // order) so the map cannot outgrow capacity.
      this.counts.delete(sessionKey)
      this.counts.set(sessionKey, consecutive)
      while (this.counts.size > this.capacity) {
        const oldest = this.counts.keys().next()
        if (oldest.done) break
        this.counts.delete(oldest.value)
      }
    }

    if (this.ceiling <= 0 || consecutive < this.ceiling) {
      return {
        status: 504,
        type: "upstream_timeout",
        message: `Upstream stalled: no data for ${sinceLastMs}ms`,
        consecutive,
        terminal: false,
      }
    }

    return {
      status: 400,
      type: "invalid_request_error",
      message: `Upstream stalled with no data for ${sinceLastMs}ms — the ${consecutive}${ordinalSuffix(consecutive)} consecutive stall on this session (limit ${idleMs}ms). Retrying has not cleared it, so this turn is failing deterministically rather than transiently. Raise MERIDIAN_UPSTREAM_IDLE_MS above the model's real thinking pause, or shorten the turn — fewer deferred tools, or compact the conversation.`,
      consecutive,
      terminal: true,
    }
  }

  /** Test/telemetry accessor. */
  streak(sessionKey: string): number {
    return this.counts.get(sessionKey) ?? 0
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
