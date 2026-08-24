/**
 * What we know, right now, about accounts that have just been refused.
 *
 * Two stores, both in-memory and both deliberately not persisted - this is
 * observability and routing hygiene, not durable truth. After a restart the
 * next refusal re-establishes everything.
 *
 * `SpentStore` holds the latest refusal per profile, so a UI can say "this
 * account is refusing" alongside the cached percentages instead of replacing
 * them. Measured on the live fleet: an account rendered `5h 67% / 7d 7%` while
 * every request through it was being refused, because those percentages are a
 * snapshot of the last successful read and a refusal never touched them.
 *
 * `FailoverEventLog` is a bounded, monotonically numbered event ring so an
 * external supervisor (vibeterm's account switcher) can poll for refusals and
 * failovers. It exists because `claudeLog("profile.failover", …)` went to the
 * log and nowhere else, and because `/telemetry/requests` - the obvious place
 * to look - is a 500-row ring with no cursor, so a poller cannot tell "nothing
 * happened" from "it scrolled past between polls". The `since` cursor here is
 * the fix for exactly that.
 *
 * Leaf module: no I/O, no imports from server.ts. Clocks are injectable so the
 * tests do not depend on wall time.
 */

import type { LimitDiagnosis } from "./limitDetection"

export interface SpentRecord {
  profileId: string
  /** When the refusal was observed (epoch ms). */
  at: number
  diagnosis: LimitDiagnosis
  /** When this account is expected to serve again, when known. */
  until: number | null
  /** Truncated raw SDK message - the operator's evidence for the verdict. */
  message: string
}

/**
 * How long a refusal stands when nothing told us when the window reopens.
 * Matches the priority router's own conservative default, so an account is
 * never shown as spent for longer than routing would avoid it.
 */
const SPENT_DEFAULT_TTL_MS = 10 * 60_000
/** Longest a single refusal is allowed to keep an account marked spent. */
const SPENT_MAX_TTL_MS = 6 * 60 * 60_000

/**
 * Latest refusal per profile, dropped on read once it expires (the same
 * read-time expiry `ProfileExhaustion` uses, so the two never disagree about
 * whether an account is currently in trouble).
 */
export class SpentStore {
  private readonly records = new Map<string, SpentRecord>()

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Record a refusal. A later record always replaces an earlier one: unlike an
   * exhaustion mark (where a longer cooldown must win), the newest refusal is
   * by definition the best description of the account's current state.
   */
  record(profileId: string, diagnosis: LimitDiagnosis, message: string): SpentRecord {
    const at = this.now()
    const resets = diagnosis.resetsAt
    const until = resets && resets > at
      ? Math.min(resets, at + SPENT_MAX_TTL_MS)
      : at + SPENT_DEFAULT_TTL_MS
    const record: SpentRecord = {
      profileId,
      at,
      diagnosis,
      until,
      message: message.length > 300 ? `${message.slice(0, 300)}…` : message,
    }
    this.records.set(profileId, record)
    return record
  }

  get(profileId: string): SpentRecord | undefined {
    const record = this.records.get(profileId)
    if (!record) return undefined
    if (record.until !== null && record.until <= this.now()) {
      this.records.delete(profileId)
      return undefined
    }
    return record
  }

  /** Live records only - expired ones are dropped on read. */
  snapshot(): SpentRecord[] {
    const out: SpentRecord[] = []
    for (const id of [...this.records.keys()]) {
      const record = this.get(id)
      if (record) out.push(record)
    }
    return out
  }

  clear(): void {
    this.records.clear()
  }
}

/**
 * `refused`        - an account said no. Emitted in every routing mode, so an
 *                    exhausted account is visible even when nothing failed over.
 * `failover`       - a request was re-issued on another account and succeeded,
 *                    so the client never saw the refusal.
 * `pool_exhausted` - every candidate refused; the client got the error.
 */
export type FailoverEventKind = "refused" | "failover" | "pool_exhausted"

export interface FailoverEvent {
  /** Monotonic, starts at 1, never reused. The `since` cursor. */
  seq: number
  at: number
  kind: FailoverEventKind
  /** The account that refused. */
  profile: string
  /** The account that served the request instead, for `failover`. */
  servedBy: string | null
  reason: string
  /** Routing mode in effect when this happened. */
  routing: string
  sessionKey: string | null
  /**
   * True when this refusal happened on an internal re-proxy hop, meaning the
   * client did not see it. A `refused` event with `internalHop: false` is one
   * the connected agent actually received.
   */
  internalHop: boolean
  until: number | null
  limit: LimitDiagnosis | null
}

export interface FailoverEventPage {
  events: FailoverEvent[]
  /**
   * Cursor for the next poll. The seq of the LAST RETURNED event, or the
   * requested `since` when nothing was returned - never the ring's newest seq,
   * because a page truncated by `limit` would then skip the remainder.
   */
  nextSince: number
  oldestSeq: number
  latestSeq: number
  /**
   * True when events between the requested `since` and the oldest retained one
   * were evicted, so the caller knows it missed some rather than believing it
   * has seen everything.
   */
  dropped: boolean
  capacity: number
}

const DEFAULT_EVENT_CAPACITY = 500
const DEFAULT_PAGE_LIMIT = 100

/**
 * Bounded ring of refusal/failover events, oldest-first on read.
 *
 * Capacity is generous relative to the event rate (one per refusal, not one per
 * request), so a consumer polling every few seconds cannot outrun it; `dropped`
 * exists for the case where a consumer was away long enough that it did.
 */
export class FailoverEventLog {
  private readonly events: FailoverEvent[] = []
  private seq = 0

  constructor(
    private readonly capacity: number = DEFAULT_EVENT_CAPACITY,
    private readonly now: () => number = Date.now,
  ) {}

  append(event: Omit<FailoverEvent, "seq" | "at"> & { at?: number }): FailoverEvent {
    const stored: FailoverEvent = { ...event, seq: ++this.seq, at: event.at ?? this.now() }
    this.events.push(stored)
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity)
    return stored
  }

  /**
   * Events strictly after `since`, oldest-first. `since = 0` returns everything
   * retained, which is what a consumer starting cold wants.
   */
  since(since: number, limit: number = DEFAULT_PAGE_LIMIT): FailoverEventPage {
    const from = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_PAGE_LIMIT
    const oldestSeq = this.events[0]?.seq ?? 0
    const matched = this.events.filter(e => e.seq > from)
    const events = matched.slice(0, cap)
    return {
      events,
      nextSince: events.length > 0 ? events[events.length - 1]!.seq : from,
      oldestSeq,
      latestSeq: this.seq,
      // Nothing is dropped for a cold start (from === 0); and a caller that is
      // exactly caught up (from === oldestSeq - 1) has missed nothing either.
      dropped: from > 0 && oldestSeq > 0 && from < oldestSeq - 1,
      capacity: this.capacity,
    }
  }

  clear(): void {
    this.events.length = 0
    this.seq = 0
  }
}
