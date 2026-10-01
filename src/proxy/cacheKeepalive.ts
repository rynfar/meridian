/**
 * Prompt-cache keepalive: keeps an idle session's cached prefix warm.
 *
 * Anthropic's prompt cache lives for five minutes, and the clock starts when a
 * request that reads or writes the prefix is RECEIVED, not when its response
 * ends. A user who reads a reply for six minutes, or a client tool that runs
 * that long, therefore pays to write the whole conversation again on the next
 * turn. A client can opt a session in with `x-meridian-cache-keepalive:
 * <seconds>`; until that window has passed since the session's latest request
 * started, Meridian sends a tiny request shortly before the cache would expire.
 *
 * Which prefix a keepalive refreshes follows the published mapping, not the
 * request in flight. A turn that is still generating has not produced the
 * prefix the next turn will reuse, so until it publishes, keepalives keep the
 * previous mapping warm. Its start time still counts for both: it read the old
 * prefix and wrote the new one when it began.
 *
 * A newly published session is left alone briefly. A turn that ran for most of
 * the TTL publishes inside the lead, and a client in a tool loop sends its next
 * turn seconds later; a keepalive in between only duplicates that turn's cache
 * write. The client's request moves the anchor first, so no keepalive is due.
 *
 * Pure scheduling: no SDK, HTTP or I/O. The caller resolves the current
 * mapping and runs each keepalive.
 */

export const CACHE_KEEPALIVE_HEADER = "x-meridian-cache-keepalive"

/** Anthropic's default prompt-cache lifetime; each read restarts it. */
export const PROMPT_CACHE_TTL_MS = 5 * 60_000

/** Refresh this long before the prefix would expire. */
export const CACHE_KEEPALIVE_LEAD_MS = 60_000

/** Quiet period after a newly published session before it may be refreshed. */
export const CACHE_KEEPALIVE_SETTLE_MS = 15_000

/** Back-off after a keepalive that never reached upstream. */
export const CACHE_KEEPALIVE_RETRY_MS = 30_000

/** Bounds one keepalive, including its wait for an SDK permit. */
export const CACHE_KEEPALIVE_TIMEOUT_MS = 45_000

/** Appended after the cached prefix; the response is never read. */
export const CACHE_KEEPALIVE_PROMPT = "Reply with OK."

/** Beyond this many pending tool calls a keepalive would miss the cache. */
export const CACHE_KEEPALIVE_MAX_PENDING_TOOL_CALLS = 8

/** `requestSource` on keepalive telemetry rows. */
export const CACHE_KEEPALIVE_SOURCE = "cache-keepalive"

/**
 * Parse the header's keepalive window. Whole seconds only, clamped to the
 * operator's maximum; anything else leaves the session opted out.
 */
export function parseCacheKeepaliveWindow(value: string | undefined, maxSeconds: number): number | undefined {
  if (value === undefined || maxSeconds <= 0) return undefined
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const seconds = Math.min(Number(trimmed), maxSeconds)
  return seconds > 0 ? seconds * 1000 : undefined
}

export interface CacheKeepaliveState {
  /** Start of the session's latest upstream request. */
  lastRequestAt: number
  /** No keepalive starts at or after this time. */
  windowEndsAt: number
  /** Start of the latest keepalive, and the SDK session it refreshed. */
  lastBeat?: { sessionId: string; at: number }
  /** Earliest retry after a keepalive that never reached upstream. */
  retryAt?: number
  /** When a tick first saw the mapping move to this SDK session. */
  sessionSeen?: { sessionId: string; at: number }
}

export type CacheKeepaliveDecision = "wait" | "beat" | "expire"

/**
 * Decide what to do for one session at `now`, given the SDK session its
 * mapping currently resumes.
 *
 * A keepalive only refreshes the session it ran against, so its time stops
 * counting once the mapping moves to a newer session. An expired prefix is
 * not refreshed: that would rewrite the whole conversation for a turn that
 * may never come.
 */
export function decideCacheKeepalive(
  state: CacheKeepaliveState,
  currentSessionId: string | undefined,
  now: number,
  ttlMs: number = PROMPT_CACHE_TTL_MS,
  leadMs: number = CACHE_KEEPALIVE_LEAD_MS,
  settleMs: number = CACHE_KEEPALIVE_SETTLE_MS,
): CacheKeepaliveDecision {
  if (now >= state.windowEndsAt) return "expire"
  if (!currentSessionId) return "wait"
  const anchor = state.lastBeat?.sessionId === currentSessionId
    ? Math.max(state.lastBeat.at, state.lastRequestAt)
    : state.lastRequestAt
  if (now >= anchor + ttlMs) return "expire"
  if (now < anchor + ttlMs - leadMs) return "wait"
  if (state.retryAt !== undefined && now < state.retryAt) return "wait"
  if (state.sessionSeen?.sessionId === currentSessionId && now < state.sessionSeen.at + settleMs) return "wait"
  return "beat"
}

export interface CacheKeepaliveSchedulerOptions<R> {
  /** The SDK session the recipe's mapping currently resumes, if any. */
  currentSessionId(recipe: R): string | undefined
  /** Run one keepalive; resolves true once the request reached upstream. */
  beat(recipe: R, sessionId: string, signal: AbortSignal): Promise<boolean>
  now?: () => number
  ttlMs?: number
  leadMs?: number
  settleMs?: number
  retryMs?: number
}

interface Entry<R> {
  recipe: R
  state: CacheKeepaliveState
  running?: AbortController
  /** The session the previous tick saw, so a newly published one is noticed. */
  observed?: { sessionId: string | undefined }
}

/** Tracks opted-in sessions and starts their keepalives when `tick` finds one due. */
export class CacheKeepaliveScheduler<R> {
  private readonly entries = new Map<string, Entry<R>>()
  /** Separate from entries: a stopped keepalive counts until its SDK child is joined. */
  private readonly running = new Set<AbortController>()
  private readonly now: () => number
  private stopped = false

  constructor(private readonly options: CacheKeepaliveSchedulerOptions<R>) {
    this.now = options.now ?? Date.now
  }

  /** Record an upstream request for `key`, starting or extending its window. */
  noteRequest(key: string, recipe: R, windowMs: number, startedAt: number): void {
    if (this.stopped) return
    const entry = this.entries.get(key)
    if (entry) {
      entry.recipe = recipe
      entry.state.lastRequestAt = Math.max(entry.state.lastRequestAt, startedAt)
      entry.state.windowEndsAt = entry.state.lastRequestAt + windowMs
      entry.state.retryAt = undefined
      return
    }
    this.entries.set(key, {
      recipe,
      state: { lastRequestAt: startedAt, windowEndsAt: startedAt + windowMs },
    })
  }

  /** Stop tracking `key`. A running keepalive finishes on its own. */
  forget(key: string): void {
    this.entries.delete(key)
  }

  /** Start every keepalive that is due. Never waits for one to finish. */
  tick(): void {
    if (this.stopped) return
    const ttlMs = this.options.ttlMs ?? PROMPT_CACHE_TTL_MS
    const leadMs = this.options.leadMs ?? CACHE_KEEPALIVE_LEAD_MS
    const settleMs = this.options.settleMs ?? CACHE_KEEPALIVE_SETTLE_MS
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
      const decision = decideCacheKeepalive(entry.state, sessionId, now, ttlMs, leadMs, settleMs)
      if (decision === "expire") {
        this.entries.delete(key)
      } else if (decision === "beat" && sessionId) {
        this.start(entry, sessionId, now)
      }
    }
  }

  private start(entry: Entry<R>, sessionId: string, now: number): void {
    const previousBeat = entry.state.lastBeat
    // The prefix is refreshed when the request is received, so the new anchor
    // is this start time. It is rolled back if the request never got there.
    entry.state.lastBeat = { sessionId, at: now }
    const running = new AbortController()
    entry.running = running
    this.running.add(running)
    const failed = (): void => {
      if (entry.state.lastBeat?.at === now) entry.state.lastBeat = previousBeat
      entry.state.retryAt = now + (this.options.retryMs ?? CACHE_KEEPALIVE_RETRY_MS)
    }
    this.options.beat(entry.recipe, sessionId, running.signal)
      .then((reached) => { if (!reached) failed() }, failed)
      .finally(() => {
        this.running.delete(running)
        if (entry.running === running) entry.running = undefined
      })
  }

  /** Sessions currently tracked. */
  get size(): number {
    return this.entries.size
  }

  /** Keepalives that have not settled yet, including aborted ones. */
  get inFlight(): number {
    return this.running.size
  }

  /** Abort running keepalives and stop tracking. Used on drain. */
  stop(): void {
    this.stopped = true
    for (const running of this.running) running.abort(new Error("Cache keepalive stopped"))
    this.entries.clear()
  }
}
