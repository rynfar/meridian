/**
 * Admission hold for a restart drain (`POST /drain`).
 *
 * A supervisor that restarts Meridian only when `GET /inflight` reads 0 never
 * gets its chance under steady traffic: a new turn always starts before the
 * last one ends. While a drain is active, NEW client requests wait here
 * before they are admitted, and the requests already running finish
 * untouched, so the count can reach 0.
 *
 * It only ever delays, never refuses and never cuts anything off:
 * - a held request is admitted when the drain ends (`DELETE /drain`, its own
 *   timeout, or shutdown) or once it has waited `holdMs`, whichever is first;
 * - a drain nobody ends ends itself after `timeoutMs`, reopening admission.
 *
 * A held request has not been admitted, so it is not in `/inflight`'s total.
 * No HTTP here; timers only.
 */

export interface DrainOptions {
  /** Longest a single new request waits before it is admitted anyway. */
  readonly holdMs: number
  /** The drain ends by itself this long after it started. */
  readonly timeoutMs: number
}

export type DrainEndReason = "cancelled" | "timeout" | "shutdown"

export interface DrainSnapshot {
  readonly active: boolean
  readonly startedAt: string | null
  readonly endsAt: string | null
  readonly holdMs: number | null
  /** New requests waiting to be admitted right now. */
  readonly held: number
  /** Requests admitted because they waited the full `holdMs` during this drain. */
  readonly admittedAtCap: number
  readonly lastEnded: { readonly at: string; readonly reason: DrainEndReason } | null
}

export const DEFAULT_DRAIN_OPTIONS: DrainOptions = { holdMs: 60_000, timeoutMs: 10 * 60_000 }

/** Bounds for options a caller passes; a hold past ~4 min would trip clients' own response-header timeouts. */
export const DRAIN_LIMITS = {
  holdMs: { min: 1_000, max: 240_000 },
  timeoutMs: { min: 10_000, max: 60 * 60_000 },
} as const

interface ActiveDrain {
  readonly startedAt: number
  readonly options: DrainOptions
  readonly timer: ReturnType<typeof setTimeout>
  readonly waiters: Set<() => void>
  admittedAtCap: number
}

export class AdmissionHold {
  private drain: ActiveDrain | undefined
  private lastEnded: DrainSnapshot["lastEnded"] = null

  constructor(private readonly onEnd?: (reason: DrainEndReason, snapshot: DrainSnapshot) => void) {}

  get active(): boolean {
    return this.drain !== undefined
  }

  /** Start a drain. While one is already active this changes nothing and reports it. */
  start(options: DrainOptions = DEFAULT_DRAIN_OPTIONS, now: number = Date.now()): DrainSnapshot {
    if (!this.drain) {
      const timer = setTimeout(() => this.end("timeout"), options.timeoutMs)
      timer.unref?.()
      this.drain = { startedAt: now, options, timer, waiters: new Set(), admittedAtCap: 0 }
    }
    return this.snapshot()
  }

  /** End the active drain, admitting every held request at once. Returns whether one was active. */
  end(reason: DrainEndReason, now: number = Date.now()): boolean {
    const drain = this.drain
    if (!drain) return false
    const final = this.snapshot()
    this.drain = undefined
    clearTimeout(drain.timer)
    this.lastEnded = { at: new Date(now).toISOString(), reason }
    for (const release of [...drain.waiters]) release()
    this.onEnd?.(reason, final)
    return true
  }

  /**
   * Resolves when a new request may proceed: at once without a drain,
   * otherwise when the drain ends, the request has waited `holdMs`, or the
   * client went away.
   */
  admit(signal?: AbortSignal): Promise<void> {
    const drain = this.drain
    if (!drain || signal?.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const release = (atCap = false) => {
        if (settled) return
        settled = true
        clearTimeout(cap)
        signal?.removeEventListener("abort", onAbort)
        drain.waiters.delete(waiter)
        if (atCap) drain.admittedAtCap++
        resolve()
      }
      const waiter = () => release()
      const onAbort = () => release()
      const cap = setTimeout(() => release(true), drain.options.holdMs)
      cap.unref?.()
      drain.waiters.add(waiter)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  snapshot(): DrainSnapshot {
    const drain = this.drain
    if (!drain) {
      return { active: false, startedAt: null, endsAt: null, holdMs: null, held: 0, admittedAtCap: 0, lastEnded: this.lastEnded }
    }
    return {
      active: true,
      startedAt: new Date(drain.startedAt).toISOString(),
      endsAt: new Date(drain.startedAt + drain.options.timeoutMs).toISOString(),
      holdMs: drain.options.holdMs,
      held: drain.waiters.size,
      admittedAtCap: drain.admittedAtCap,
      lastEnded: this.lastEnded,
    }
  }
}

/**
 * Options from a `POST /drain` body: absent fields take the defaults,
 * present ones must be integers inside `DRAIN_LIMITS`. Returns an error
 * message for anything else.
 */
export function parseDrainOptions(body: unknown): DrainOptions | string {
  if (body === undefined || body === null) return DEFAULT_DRAIN_OPTIONS
  if (typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object"
  const record = body as Record<string, unknown>
  const read = (key: keyof DrainOptions): number | string => {
    const value = record[key]
    if (value === undefined) return DEFAULT_DRAIN_OPTIONS[key]
    const { min, max } = DRAIN_LIMITS[key]
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      return `${key} must be an integer from ${min} to ${max}`
    }
    return value
  }
  const holdMs = read("holdMs")
  if (typeof holdMs === "string") return holdMs
  const timeoutMs = read("timeoutMs")
  if (typeof timeoutMs === "string") return timeoutMs
  return { holdMs, timeoutMs }
}
