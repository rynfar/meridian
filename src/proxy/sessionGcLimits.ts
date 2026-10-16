/**
 * Session GC limits: their defaults, which follow from the session turn's
 * hold, and how the settings resolve against them.
 *
 * Leaf module: pure, no I/O, no imports from server.ts or session/.
 */

/**
 * How many transcripts one session GC sweep may delete
 * (`MERIDIAN_SESSION_GC_MAX_DELETES`).
 *
 * Sweeps are single-flight and run on the interval and after every managed
 * fork publication or abandonment, so under load they run back to back and
 * this cap does not bound the deletion rate; the backlog does (see
 * {@link defaultSessionGcMaxPending}). The cap decides how fast a backlog
 * drains when only the interval sweeps, after a burst or on an idle proxy: a
 * full default backlog of 2,112 drains in about 33 minutes at 64 a sweep,
 * against more than two hours at 16. Each sweep holds the lifecycle lock for
 * longer in exchange.
 */
export const DEFAULT_SESSION_GC_MAX_DELETES = 64

/**
 * The most the final sweep of a draining proxy may delete, whatever
 * `MERIDIAN_SESSION_GC_MAX_DELETES` says: the 16 every sweep deleted before
 * the default rose, so stopping the proxy costs no more than it did. What it
 * leaves, the next process deletes.
 */
export const SHUTDOWN_SESSION_GC_MAX_DELETES = 16

/** The deletion backlog's bound before it followed the grace. */
const SESSION_GC_MAX_PENDING_FLOOR = 256

/** Graces of deletions the backlog holds; the rest of one is room for a burst. */
const SESSION_GC_BACKLOG_GRACES = 3

/** Sweep interval when none is configured (`MERIDIAN_SESSION_GC_INTERVAL_MS`). */
const DEFAULT_SESSION_GC_INTERVAL_MS = 60_000

/** Margin past the session turn's hold before an unpinned transcript may go. */
const SESSION_GC_GRACE_MARGIN_MS = 60_000

/**
 * Default bound on transcripts retired and waiting to be deleted
 * (`MERIDIAN_SESSION_GC_MAX_PENDING`).
 *
 * A retired transcript waits out the grace (`MERIDIAN_SESSION_GC_GRACE_MS`, by
 * default the session turn's hold and a minute) before it can be deleted, so
 * this bound over the grace caps how many the GC can retire a minute, however
 * often sweeps run. A fixed 256 over the default 11-minute grace let about 23
 * a minute through, about 1,400 an hour: under load that, not the deletions a
 * sweep may make, is what let orphaned transcripts pile up. Sized to hold
 * three graces of deletions at the interval's full rate, so the deletion rate
 * decides whatever the hold, and never under the 256 it was. An interval of 0
 * (no periodic sweep) counts as one a minute.
 */
export function defaultSessionGcMaxPending(retiredGraceMs: number, maxDeletesPerRun: number, intervalMs: number): number {
  const runsPerGrace = retiredGraceMs / (intervalMs > 0 ? intervalMs : DEFAULT_SESSION_GC_INTERVAL_MS)
  return Math.max(SESSION_GC_MAX_PENDING_FLOOR, Math.ceil(maxDeletesPerRun * runsPerGrace) * SESSION_GC_BACKLOG_GRACES)
}

/** Reads one integer setting by its name without the `MERIDIAN_` prefix. */
export type SessionGcSetting = (name: string, fallback: number) => number

export interface SessionGcLimits {
  /** Deletions one sweep may make. */
  maxDeletesPerRun: number
  /** Deletions the sweeps of a draining proxy may make. */
  shutdownMaxDeletesPerRun: number
  /** How long a retired transcript waits before it may be deleted. */
  retiredGraceMs: number
  /** Transcripts retired or prepared and not yet deleted, at most. */
  maxPending: number
  /** Periodic sweep interval; 0 for none. */
  intervalMs: number
}

/**
 * Resolve the session GC settings against their defaults. An explicit
 * `SESSION_GC_MAX_PENDING` wins; otherwise the backlog follows the resolved
 * grace, deletion cap and interval.
 */
export function resolveSessionGcLimits(setting: SessionGcSetting, turnMaxHoldMs: number): SessionGcLimits {
  const maxDeletesPerRun = Math.max(1, setting("SESSION_GC_MAX_DELETES", DEFAULT_SESSION_GC_MAX_DELETES))
  const retiredGraceMs = Math.max(0, setting("SESSION_GC_GRACE_MS", turnMaxHoldMs + SESSION_GC_GRACE_MARGIN_MS))
  const intervalMs = Math.max(0, setting("SESSION_GC_INTERVAL_MS", DEFAULT_SESSION_GC_INTERVAL_MS))
  return {
    maxDeletesPerRun,
    shutdownMaxDeletesPerRun: Math.min(maxDeletesPerRun, SHUTDOWN_SESSION_GC_MAX_DELETES),
    retiredGraceMs,
    maxPending: Math.max(1, setting(
      "SESSION_GC_MAX_PENDING",
      defaultSessionGcMaxPending(retiredGraceMs, maxDeletesPerRun, intervalMs),
    )),
    intervalMs,
  }
}
