/**
 * Prompt-cache keepalive: keeps an idle session's cached prefix warm.
 *
 * Off unless the operator turns it on. Only sessions whose latest real turn
 * wrote the one-hour cache tier are tracked; while one stays idle, Meridian
 * sends one small cache-read beat shortly before that hour runs out, at most
 * a few times, then lets the cache expire. Rationale and measurements live in
 * src/proxy/SPEC.md (Decisions → prompt-cache keepalive).
 *
 * Which prefix a beat refreshes follows the published mapping, not the
 * request in flight. A newly published session is left alone briefly so a
 * client's next turn, not a beat, refreshes it.
 *
 * Pure scheduling: no SDK, HTTP or I/O. The caller resolves the current
 * mapping and runs each beat.
 */

/** Lifetime of the one-hour cache tier; each read restarts it. */
export const PROMPT_CACHE_TTL_MS = 60 * 60_000

/** A beat is due this long after the latest real turn or beat started. */
export const CACHE_KEEPALIVE_INTERVAL_MS = 55 * 60_000

/** Beats per idle period; a real turn starts a new period. */
export const CACHE_KEEPALIVE_MAX_BEATS = 3

/** Beats running at once, across every session. */
export const CACHE_KEEPALIVE_DEFAULT_MAX_IN_FLIGHT = 1
export const CACHE_KEEPALIVE_MAX_IN_FLIGHT_LIMIT = 2

/** Quiet period after a newly published session before it may be refreshed. */
export const CACHE_KEEPALIVE_SETTLE_MS = 15_000

/** Back-off after a beat that never reached upstream or was skipped. */
export const CACHE_KEEPALIVE_RETRY_MS = 30_000

/** Bounds one beat, including SDK start-up. */
export const CACHE_KEEPALIVE_TIMEOUT_MS = 45_000

/** Appended after the cached prefix; the response is never read. */
export const CACHE_KEEPALIVE_PROMPT = "Reply with OK."

/** Beyond this many pending tool calls a beat would miss the cache. */
export const CACHE_KEEPALIVE_MAX_PENDING_TOOL_CALLS = 8

/** `requestSource` on beat telemetry rows. */
export const CACHE_KEEPALIVE_SOURCE = "cache-keepalive"

/**
 * Whether the operator switched keepalive on. The environment wins over the
 * setting so a deployment can force it either way; unset or unrecognized
 * values fall through to the setting, and the default is off.
 */
export function resolveCacheKeepaliveEnabled(envValue: string | undefined, setting: () => unknown): boolean {
  const value = envValue?.trim().toLowerCase()
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true
  if (value === "0" || value === "false" || value === "no" || value === "off") return false
  return setting() === true
}

/** Concurrent beats allowed; clamped to a small number. */
export function resolveCacheKeepaliveMaxInFlight(envValue: number | undefined): number {
  if (envValue === undefined || !Number.isFinite(envValue)) return CACHE_KEEPALIVE_DEFAULT_MAX_IN_FLIGHT
  return Math.min(CACHE_KEEPALIVE_MAX_IN_FLIGHT_LIMIT, Math.max(1, Math.trunc(envValue)))
}

/** Usage fields that say which cache tier a request wrote. */
export interface CacheTierUsage {
  cache_read_input_tokens?: number | null
  cache_creation?: {
    ephemeral_1h_input_tokens?: number | null
    ephemeral_5m_input_tokens?: number | null
  } | null
}

/**
 * Which tier a turn's usage shows.
 *
 * - `1h`: it wrote only to the one-hour tier.
 * - `5m`: it wrote anything to the five-minute tier. Part of the prefix then
 *   expires within minutes and a beat an hour later would rewrite it.
 * - `read`: it wrote nothing and read from the cache, so its tier is whatever
 *   the session already had.
 * - `none`: no cache information at all.
 */
export type CacheTier = "1h" | "5m" | "read" | "none"

export function classifyCacheTier(usage: CacheTierUsage | undefined): CacheTier {
  if (!usage) return "none"
  const creation = usage.cache_creation
  const fiveMinute = creation?.ephemeral_5m_input_tokens ?? 0
  const oneHour = creation?.ephemeral_1h_input_tokens ?? 0
  if (fiveMinute > 0) return "5m"
  if (oneHour > 0) return "1h"
  if (creation && (usage.cache_read_input_tokens ?? 0) > 0) return "read"
  return "none"
}

/** What the account looks like when a beat is about to start. */
export interface CacheKeepaliveAccountFacts {
  profileType: string
  /** Latest usage windows observed for the account. */
  rateLimits: ReadonlyArray<{
    status?: string
    utilization?: number
    resetsAt?: number
    isUsingOverage?: boolean
  }>
  /** Priority routing has the account in cooldown. */
  coolingDown: boolean
  /** A recent refusal marked the account spent. */
  spent: boolean
  /** The account is holding its weekly reserve. */
  reserveHeld?: boolean
  /** The session's [1m] model is benched, so the next turn uses another model. */
  benched: boolean
  now: number
}

/**
 * Why a beat must not run on this account now, or undefined when it may.
 *
 * A beat is billed like any other request, so it never runs where that bill
 * is real money (API keys, Extra Usage) or where it would spend a window that
 * is already exhausted.
 */
export function cacheKeepaliveAccountBlock(facts: CacheKeepaliveAccountFacts): string | undefined {
  if (facts.profileType !== "claude-max") return "not-subscription"
  const live = facts.rateLimits.filter(entry => entry.resetsAt === undefined || entry.resetsAt > facts.now)
  if (live.some(entry => entry.isUsingOverage === true)) return "overage"
  if (live.some(entry => entry.status === "rejected" || (entry.utilization ?? 0) >= 1)) return "rate-limited"
  if (facts.coolingDown) return "cooldown"
  if (facts.spent) return "spent"
  if (facts.benched) return "benched"
  if (facts.reserveHeld) return "reserve"
  return undefined
}

export interface CacheKeepaliveState {
  /** Start of the session's latest real turn. */
  lastTurnAt: number
  /** Beats that reached upstream since that turn. */
  beats: number
  /** Start of the latest beat that reached upstream, and the session it refreshed. */
  lastBeat?: { sessionId: string; at: number }
  /** Earliest retry after a beat that never reached upstream. */
  retryAt?: number
  /** When a tick first saw the mapping move to this SDK session. */
  sessionSeen?: { sessionId: string; at: number }
}

export type CacheKeepaliveDecision = "wait" | "beat" | "expire"

export interface CacheKeepaliveTiming {
  intervalMs: number
  ttlMs: number
  maxBeats: number
  settleMs: number
}

const DEFAULT_TIMING: CacheKeepaliveTiming = {
  intervalMs: CACHE_KEEPALIVE_INTERVAL_MS,
  ttlMs: PROMPT_CACHE_TTL_MS,
  maxBeats: CACHE_KEEPALIVE_MAX_BEATS,
  settleMs: CACHE_KEEPALIVE_SETTLE_MS,
}

/**
 * Decide what to do for one session at `now`, given the SDK session its
 * mapping currently resumes.
 *
 * A beat only refreshes the session it ran against, so its time stops
 * counting once the mapping moves to a newer session. An expired prefix is
 * not refreshed: that would rewrite the whole conversation for a turn that
 * may never come.
 */
export function decideCacheKeepalive(
  state: CacheKeepaliveState,
  currentSessionId: string | undefined,
  now: number,
  timing: CacheKeepaliveTiming = DEFAULT_TIMING,
): CacheKeepaliveDecision {
  if (state.beats >= timing.maxBeats) return "expire"
  const anchor = currentSessionId && state.lastBeat?.sessionId === currentSessionId
    ? Math.max(state.lastBeat.at, state.lastTurnAt)
    : state.lastTurnAt
  if (now >= anchor + timing.ttlMs) return "expire"
  if (!currentSessionId) return "wait"
  if (now < anchor + timing.intervalMs) return "wait"
  if (state.retryAt !== undefined && now < state.retryAt) return "wait"
  if (state.sessionSeen?.sessionId === currentSessionId && now < state.sessionSeen.at + timing.settleMs) return "wait"
  return "beat"
}

/**
 * How one beat ended:
 * - `reached`: upstream read the prefix; it counts toward the idle period.
 * - `retry`: it did not run or never reached upstream; try again shortly.
 * - `stop`: keeping this session warm is pointless (cache already gone,
 *   five-minute tier, mapping gone); stop tracking it.
 */
export type CacheKeepaliveBeatOutcome = "reached" | "retry" | "stop"

export interface CacheKeepaliveSchedulerOptions<R> {
  /** The SDK session the recipe's mapping currently resumes, if any. */
  currentSessionId(recipe: R): string | undefined
  /** Run one beat. */
  beat(recipe: R, sessionId: string, signal: AbortSignal): Promise<CacheKeepaliveBeatOutcome>
  /** Whether the operator has keepalive switched on; re-read on every tick. */
  enabled?: () => boolean
  now?: () => number
  intervalMs?: number
  ttlMs?: number
  maxBeats?: number
  settleMs?: number
  retryMs?: number
  /** Beats running at once across every session. */
  maxInFlight?: number
}

interface Entry<R> {
  recipe: R
  state: CacheKeepaliveState
  running?: AbortController
  /** The session the previous tick saw, so a newly published one is noticed. */
  observed?: { sessionId: string | undefined }
}

/** What a finished real turn tells the scheduler. */
export interface CacheKeepaliveTurn<R> {
  recipe: R
  /** When the turn's SDK query started; the cache was read then. */
  startedAt: number
  /** Tier the turn's usage showed; `none` also covers a failed turn. */
  tier: CacheTier
}

/** Tracks eligible idle sessions and starts their beats when `tick` finds one due. */
export class CacheKeepaliveScheduler<R> {
  private readonly entries = new Map<string, Entry<R>>()
  /** Real turns running per key; a session with one is not idle. */
  private readonly turns = new Map<string, number>()
  /** Separate from entries: a stopped beat counts until its SDK child is joined. */
  private readonly running = new Set<AbortController>()
  private readonly now: () => number
  private readonly timing: CacheKeepaliveTiming
  private readonly maxInFlight: number
  private stopped = false

  constructor(private readonly options: CacheKeepaliveSchedulerOptions<R>) {
    this.now = options.now ?? Date.now
    this.timing = {
      intervalMs: options.intervalMs ?? CACHE_KEEPALIVE_INTERVAL_MS,
      ttlMs: options.ttlMs ?? PROMPT_CACHE_TTL_MS,
      maxBeats: options.maxBeats ?? CACHE_KEEPALIVE_MAX_BEATS,
      settleMs: options.settleMs ?? CACHE_KEEPALIVE_SETTLE_MS,
    }
    this.maxInFlight = Math.max(1, options.maxInFlight ?? CACHE_KEEPALIVE_DEFAULT_MAX_IN_FLIGHT)
  }

  /** A real turn on `key` started: the session is no longer idle. */
  noteTurnStart(key: string, startedAt: number): void {
    if (this.stopped) return
    this.turns.set(key, (this.turns.get(key) ?? 0) + 1)
    const entry = this.entries.get(key)
    if (!entry) return
    entry.state.lastTurnAt = Math.max(entry.state.lastTurnAt, startedAt)
    entry.state.beats = 0
    entry.state.retryAt = undefined
  }

  /**
   * A real turn on `key` ended. One that wrote the one-hour tier starts a new
   * idle period; one that only read keeps the session's existing period
   * going from its start; anything else stops tracking the session.
   */
  noteTurnEnd(key: string, turn: CacheKeepaliveTurn<R>): void {
    const running = (this.turns.get(key) ?? 1) - 1
    if (running > 0) this.turns.set(key, running)
    else this.turns.delete(key)
    if (this.stopped) return
    const entry = this.entries.get(key)
    if (turn.tier === "1h" || (turn.tier === "read" && entry)) {
      if (entry) {
        entry.recipe = turn.recipe
        entry.state.lastTurnAt = Math.max(entry.state.lastTurnAt, turn.startedAt)
        entry.state.beats = 0
        entry.state.retryAt = undefined
        return
      }
      this.entries.set(key, { recipe: turn.recipe, state: { lastTurnAt: turn.startedAt, beats: 0 } })
      return
    }
    this.entries.delete(key)
  }

  /** Stop tracking `key`. A running beat finishes on its own. */
  forget(key: string): void {
    this.entries.delete(key)
  }

  /** Start every beat that is due, up to the in-flight cap. Never waits for one. */
  tick(): void {
    if (this.stopped || this.entries.size === 0) return
    if (this.options.enabled && !this.options.enabled()) {
      this.entries.clear()
      return
    }
    for (const [key, entry] of this.entries) {
      if (entry.running) continue
      const now = this.now()
      let sessionId: string | undefined
      try {
        sessionId = this.options.currentSessionId(entry.recipe)
      } catch {
        // An unreadable mapping is retried on the next tick.
        continue
      }
      if (sessionId && entry.observed && entry.observed.sessionId !== sessionId) {
        entry.state.sessionSeen = { sessionId, at: now }
      }
      entry.observed = { sessionId }
      if ((this.turns.get(key) ?? 0) > 0) continue
      const decision = decideCacheKeepalive(entry.state, sessionId, now, this.timing)
      if (decision === "expire") {
        this.entries.delete(key)
      } else if (decision === "beat" && sessionId && this.running.size < this.maxInFlight) {
        this.start(key, entry, sessionId, now)
      }
    }
  }

  private start(key: string, entry: Entry<R>, sessionId: string, now: number): void {
    const running = new AbortController()
    entry.running = running
    this.running.add(running)
    const settle = (outcome: CacheKeepaliveBeatOutcome): void => {
      if (this.entries.get(key) !== entry) return
      if (outcome === "stop") {
        this.entries.delete(key)
      } else if (outcome === "retry") {
        entry.state.retryAt = now + (this.options.retryMs ?? CACHE_KEEPALIVE_RETRY_MS)
      } else if (entry.state.lastTurnAt <= now) {
        // The prefix is refreshed when the request is received, so the new
        // anchor is this start time. A turn that started meanwhile already
        // began a new idle period and owns the count.
        entry.state.lastBeat = { sessionId, at: now }
        entry.state.beats++
      }
    }
    this.options.beat(entry.recipe, sessionId, running.signal)
      .then(settle, () => settle("retry"))
      .finally(() => {
        this.running.delete(running)
        if (entry.running === running) entry.running = undefined
      })
  }

  /** Sessions currently tracked. */
  get size(): number {
    return this.entries.size
  }

  /** Beats that have not settled yet, including aborted ones. */
  get inFlight(): number {
    return this.running.size
  }

  /** Abort running beats and stop tracking. Used on drain. */
  stop(): void {
    this.stopped = true
    for (const running of this.running) running.abort(new Error("Cache keepalive stopped"))
    this.entries.clear()
    this.turns.clear()
  }
}
