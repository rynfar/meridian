/**
 * Sticky session-to-profile routing (#383, design by @ShreeMulay).
 *
 * With multiple profiles configured, `routing = "sticky"` distributes
 * sessions across profiles while preserving session affinity — Anthropic's
 * prompt caching is per-account, so a session that flip-flops between
 * accounts pays a cold cache (full context re-creation) on every flip.
 *
 * Assignment uses rendezvous (highest-random-weight) hashing:
 *   - deterministic and stateless — stickiness survives proxy restarts with
 *     no persisted session→profile map to lose or corrupt
 *   - minimal disruption — adding an arm only moves the sessions that hash
 *     to the new arm; removing an arm only reassigns that arm's sessions
 *
 * Resolution priority (see resolveProfile): explicit x-meridian-profile
 * header > sticky assignment > active profile > config default > first.
 * Default mode is "active" (the pre-#383 chain) — existing setups are
 * byte-identical unless routing is explicitly enabled.
 *
 * This is a leaf module — no I/O. Most functions here are pure; the
 * exhaustion/assignment trackers below hold mutable in-memory state (by
 * design — see their own doc comments) but still perform no I/O.
 */

import { createHash } from "node:crypto"
import type { RouteKind } from "../telemetry/types"

export type RoutingMode = "active" | "sticky" | "priority" | "active+priority"

export const ACTIVE_PRIORITY = "active+priority" as const

/**
 * Every selectable mode, in the order the settings UI offers them. Single
 * source of truth: the mode list was previously written out again inside the
 * settings route's validator and a third time in the page's `<select>`, so a
 * new mode parsed correctly and still could not be selected.
 */
export const ROUTING_MODES: readonly RoutingMode[] = ["active", "sticky", "priority", ACTIVE_PRIORITY]

export type PriorityFailbackPolicy = "new-conversation" | "next-user-turn" | "fresh-replay"

/** Every accepted failback policy; the first is the default for unset or unknown values. */
export const PRIORITY_FAILBACK_POLICIES: readonly PriorityFailbackPolicy[] = ["new-conversation", "next-user-turn", "fresh-replay"]

export type PriorityAssignment = {
  readonly profileId: string
  readonly requestId: string | undefined
}

export type PriorityPromotionInput = {
  readonly policy: PriorityFailbackPolicy
  readonly assignment: PriorityAssignment
  readonly requestId: string | undefined
  readonly requestKind: string | undefined
}

/**
 * Parse a routing mode string (from settings or MERIDIAN_ROUTING).
 * Unknown values fall back to "active" — a typo must never change
 * routing behavior into something surprising.
 *
 * The three original branches stay exact-match, so every value that falls back
 * to "active" today still does. Only the new mode accepts separator variants
 * ("active-priority", "active_priority", "active priority"): its canonical
 * spelling carries a `+`, which a query string decodes to a space, and being
 * strict there would turn one plausible transport detail into silently routing
 * all traffic to the active profile with no failover.
 */
export function getRoutingMode(raw: string | undefined): RoutingMode {
  const lower = raw?.toLowerCase()
  if (lower === "sticky") return "sticky"
  if (lower === "priority") return "priority"
  if (lower && lower.replace(/[\s+_-]/g, "") === "activepriority") return ACTIVE_PRIORITY
  return "active"
}

export function isPoolRouting(mode: RoutingMode): boolean {
  return mode === "priority" || mode === ACTIVE_PRIORITY
}

export function getPriorityFailbackPolicy(raw: string | undefined): PriorityFailbackPolicy {
  const lower = raw?.toLowerCase()
  return PRIORITY_FAILBACK_POLICIES.find(policy => policy === lower) ?? "new-conversation"
}

export function shouldPromotePriorityAssignment(input: PriorityPromotionInput): boolean {
  // Request ID equality, not kind alone, keeps same-turn tool continuations on fallback.
  return input.policy === "next-user-turn"
    && input.requestKind === "human"
    && input.requestId !== undefined
    && input.requestId !== input.assignment.requestId
}

/**
 * How long a fresh replay of one exact history stays worth retrying on the
 * account that served it. A byte-identical replay reads its whole prefix from
 * that account's prompt cache, so a retry inside this window keeps its account.
 */
export const PRIORITY_FRESH_REPLAY_RETRY_WINDOW_MS = 60 * 60_000

/** The last fresh replay served for one process-local assignment key. */
export type PriorityFreshReplay = {
  readonly profileId: string
  readonly historyDigest: string
  readonly at: number
}

/** The final lineage a priority attempt is about to serve, as the release decision reads it. */
export type PriorityServedLineage = {
  readonly type: string
  readonly reason?: string
}

/**
 * Whether serving this lineage writes the conversation's history from scratch
 * and replaces the conversation's session on the serving account. That covers
 * a side call sharing the conversation's key (Pi's title generation, a lost
 * concurrent race): it replaces the session wherever it is served, so the
 * conversation's next turn fresh-replays on that account either way.
 * Independent requests never publish over the conversation, and a
 * priority-failback replay belongs to the durable route, which this policy
 * does not touch.
 */
export function isPriorityFreshReplay(lineage: PriorityServedLineage): boolean {
  return lineage.type === "diverged"
    && lineage.reason !== "independent-request"
    && lineage.reason !== "priority-failback"
}

/**
 * How a priority dispatch takes part in `priorityFailback: fresh-replay`.
 * Undefined when it does not: another policy, a durable route (its own
 * attested failback owns that conversation), or a request that is not the
 * conversation its assignment key names (a subagent sharing its root's key
 * must neither move its root nor overwrite the root's fresh-replay record).
 * Otherwise its fresh replays are recorded, and `releaseTo` is set when the
 * first candidate is the healthy assigned account while a new conversation
 * would be placed elsewhere: then that first attempt may release.
 */
export function planFreshReplayRelease(input: {
  readonly policy: PriorityFailbackPolicy
  readonly durableRoute: boolean
  readonly ownsAssignment: boolean
  /** The assigned account, when it is healthy and in the pool. */
  readonly assignedProfileId: string | undefined
  readonly candidates: readonly string[]
  /** The candidates the same request would get as a new conversation, computed only when needed. */
  readonly placement: () => readonly string[]
}): { readonly releaseTo?: readonly string[] } | undefined {
  if (input.policy !== "fresh-replay" || input.durableRoute || !input.ownsAssignment) return undefined
  const assigned = input.assignedProfileId
  if (assigned === undefined || input.candidates[0] !== assigned) return {}
  const placement = input.placement()
  const placedAt = placement[0]
  return placedAt !== undefined && placedAt !== assigned ? { releaseTo: placement } : {}
}

/**
 * Whether the assigned account's attempt releases the conversation instead of
 * serving it: the lineage Meridian is about to serve there is a fresh replay,
 * so the prompt cache past the shared system prefix is lost on every account.
 * The exception is a replay of the same history this account already served
 * fresh inside the retry window: that one reads its prefix from cache here.
 */
export function shouldReleaseOnFreshReplay(input: {
  readonly assignedProfileId: string
  readonly lineage: PriorityServedLineage
  readonly historyDigest: string
  readonly lastFreshReplay: PriorityFreshReplay | undefined
  readonly now: number
}): boolean {
  if (!isPriorityFreshReplay(input.lineage)) return false
  const last = input.lastFreshReplay
  const retriesOwnReplay = last !== undefined
    && last.profileId === input.assignedProfileId
    && last.historyDigest === input.historyDigest
    && input.now - last.at < PRIORITY_FRESH_REPLAY_RETRY_WINDOW_MS
  return !retriesOwnReplay
}

/**
 * Classify how the serving profile was chosen, from values the caller already
 * holds. Runs per request, so it may never do I/O or read settings of its own.
 *
 * Undefined when the routing mode isn't known (the outer catch records before
 * routing resolves): the pin and the hop flag still prove
 * `pinned`/`priority-hop`, but "active" would be a guess, and a guess on an
 * attribution dashboard is worse than a blank.
 */
export function classifyRouteKind(input: {
  pinnedProfileHeader?: string | undefined
  /**
   * One internal hop of a pool dispatch. A flag rather than a header because
   * the failover re-enters the handler directly, so there is no second HTTP
   * request for a header to travel on.
   */
  priorityHop?: boolean | undefined
  routingMode?: RoutingMode | undefined
}): RouteKind | undefined {
  // Checked before the pin, even though every hop carries one: a hop IS pinned,
  // so testing the header first would report the mechanism instead of the
  // reason and make every failover attempt read as a deliberate pin.
  if (input.priorityHop) return input.routingMode === ACTIVE_PRIORITY ? "active+priority-hop" : "priority-hop"
  if (input.pinnedProfileHeader) return "pinned"
  if (input.routingMode === "sticky") return "sticky"
  if (input.routingMode === "priority") return "priority"
  if (input.routingMode === ACTIVE_PRIORITY) return ACTIVE_PRIORITY
  if (input.routingMode === "active") return "active"
  return undefined
}

/**
 * Rendezvous score for a (session, profile) pair: first 8 bytes of
 * sha256("<session>\0<profile>") as an unsigned bigint. sha256 is stable
 * across platforms and Node versions, so assignments never reshuffle on
 * upgrade (see the pinned-hash test).
 */
function rendezvousScore(sessionKey: string, profileId: string): bigint {
  const digest = createHash("sha256").update(`${sessionKey}\0${profileId}`).digest()
  return digest.readBigUInt64BE(0)
}

/**
 * Pick the sticky profile for a session: the profile with the highest
 * rendezvous score. Returns undefined when there is nothing to pick
 * (no session identity or no profiles) — callers fall through to the
 * normal resolution chain.
 */
export function pickStickyProfile(sessionKey: string, profileIds: readonly string[]): string | undefined {
  if (!sessionKey || profileIds.length === 0) return undefined
  let best: string | undefined
  let bestScore = -1n
  for (const id of profileIds) {
    const score = rendezvousScore(sessionKey, id)
    if (score > bestScore) {
      bestScore = score
      best = id
    }
  }
  return best
}

/**
 * Pinned (sessionKey, profiles, expected) triples guarding hash stability.
 * If an implementation change breaks these, every user's sessions would
 * silently reshuffle onto different accounts (cold caches) on upgrade —
 * treat that as a breaking change requiring a migration note, not a test
 * to update casually.
 */
export const RENDEZVOUS_STABLE_GUARD: ReadonlyArray<readonly [string, readonly string[], string]> = [
  // Hard-pinned literals computed once from sha256 — NOT derived from
  // pickStickyProfile, so the guard actually detects hash drift.
  ["sess-a", ["personal", "work"], "work"],
  ["sess-b", ["personal", "work"], "personal"],
  ["opencode-3f2a", ["a", "b", "c"], "b"],
]

// ---------------------------------------------------------------------------
// Priority routing (opt-in, routing="priority") — ordered pool with failover.
// Pure helpers + an injectable-clock exhaustion tracker; still no I/O.
// ---------------------------------------------------------------------------

/**
 * Resolve the effective pool order: the configured order (settings
 * "profileOrder" / MERIDIAN_PROFILE_ORDER) filtered to profiles that exist,
 * with unlisted profiles appended in config order. Unknown ids are returned
 * for a startup warning — a typo must never silently drop an account.
 */
export function resolvePriorityOrder(
  configuredIds: readonly string[],
  orderSetting: readonly string[] | undefined,
): { order: string[]; unknown: string[] } {
  const existing = new Set(configuredIds)
  const order: string[] = []
  const unknown: string[] = []
  for (const id of orderSetting ?? []) {
    if (!existing.has(id)) { unknown.push(id); continue }
    if (!order.includes(id)) order.push(id)
  }
  for (const id of configuredIds) if (!order.includes(id)) order.push(id)
  return { order, unknown }
}

/**
 * Pick the highest-priority profile that isn't exhausted. When every pool
 * member is exhausted, return the preferred (first) profile with the flag
 * set — callers still attempt it (marks may be stale), and per the design
 * decision the LAST tried profile's error is what ultimately surfaces.
 */
export function choosePriorityProfile(
  order: readonly string[],
  isExhausted: (id: string) => boolean,
): { id: string; allExhausted: boolean } | undefined {
  const preferred = order[0]
  if (preferred === undefined) return undefined
  for (const id of order) {
    if (!isExhausted(id)) return { id, allExhausted: false }
  }
  return { id: preferred, allExhausted: true }
}

/**
 * Candidate order for `active+priority`: the active profile first, then the
 * priority order behind it as fallbacks.
 *
 * The active profile OUTRANKS an existing session assignment, which is the one
 * place this mode deliberately disagrees with `priority`. In `priority` the
 * pool head moves on its own (a cooldown expires) and affinity protects a
 * conversation from being dragged along - worth protecting, since a live
 * request here showed a 441k-token cache read at a 99.8% hit rate, all of which
 * is thrown away by a move. In `active+priority` the head only ever moves
 * because a human or a supervisor moved it, and moving running conversations is
 * precisely what they moved it FOR. Honouring the old assignment would mean
 * switching the active profile changed nothing for any conversation already
 * under way, which is every conversation that matters and leaves the mode
 * indistinguishable from plain `priority`.
 *
 * Affinity still applies BELOW the active profile: while the active profile is
 * refusing, a session returns to the same fallback it used last time rather
 * than being re-picked each turn, so an outage costs one cold cache instead of
 * one per turn.
 */
export function chooseActivePriorityCandidates(
  activeId: string,
  order: readonly string[],
  isExhausted: (id: string) => boolean,
  assigned?: string,
): string[] {
  // Deduped because a repeated id would make the dispatcher attempt the same
  // account twice, breaking its "each profile at most once per request" rule.
  const pool = [...new Set(order.includes(activeId) ? order : [activeId, ...order])]
  let first: string
  if (!isExhausted(activeId)) {
    first = activeId
  } else if (assigned && assigned !== activeId && pool.includes(assigned) && !isExhausted(assigned)) {
    first = assigned
  } else {
    first = pool.find(id => !isExhausted(id)) ?? activeId
  }
  return [first, ...pool.filter(id => id !== first && !isExhausted(id))]
}

export interface ExhaustionEntry {
  id: string
  until: number
  reason: string
}

/**
 * In-memory per-profile exhaustion marks with expiry. Deliberately not
 * persisted: this is routing hygiene, not durable truth — after a restart
 * the first failing request re-marks. A later mark may extend an entry but
 * an earlier one never shortens it (two concurrent failures shouldn't
 * un-learn the longer reset).
 */
export class ProfileExhaustion {
  private readonly marks = new Map<string, { until: number; reason: string }>()
  constructor(private readonly now: () => number = Date.now) {}

  mark(id: string, until: number, reason: string): void {
    const existing = this.marks.get(id)
    if (existing && existing.until >= until) return
    this.marks.set(id, { until, reason })
  }

  isExhausted(id: string): boolean {
    const entry = this.marks.get(id)
    if (!entry) return false
    if (entry.until <= this.now()) {
      this.marks.delete(id)
      return false
    }
    return true
  }

  forget(id: string): void {
    this.marks.delete(id)
  }

  /** Live entries only — expired marks are dropped on read. */
  snapshot(): ExhaustionEntry[] {
    const out: ExhaustionEntry[] = []
    for (const [id, entry] of this.marks) {
      if (entry.until <= this.now()) { this.marks.delete(id); continue }
      out.push({ id, until: entry.until, reason: entry.reason })
    }
    return out
  }
}

/**
 * Session-to-profile assignments with LRU eviction.
 *
 * A JS Map preserves insertion order and a bare `set()` on an EXISTING key
 * does not reorder it — so a plain map evicts first-inserted, which drops a
 * long-lived active conversation ahead of a newer idle one. Both read and
 * write therefore delete-then-set to refresh recency.
 *
 * Deliberately not persisted: this is routing hygiene, not durable truth.
 * After a restart the next request re-establishes the assignment. The same
 * bounded LRU keeps each assignment key's last fresh replay.
 */
export class AssignmentStore<T = PriorityAssignment> {
  private readonly entries = new Map<string, T>()

  constructor(private readonly max: number) {}

  /** Read an entry, marking it most-recently-used. */
  get(key: string): T | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  /** Write an entry, marking it most-recently-used and evicting if over capacity. */
  set(key: string, value: T): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  compareAndSet(
    key: string,
    expected: T | undefined,
    value: T,
  ): boolean {
    if (this.entries.get(key) !== expected) return false
    this.set(key, value)
    return true
  }

  get size(): number {
    return this.entries.size
  }
}

/**
 * How long a profile stays benched when a usage window is exhausted (#790).
 *
 * Meridian benches a failing profile until its quota window resets. Reading
 * that reset only from the `five_hour` window meant a weekly-capped profile
 * matched nothing and fell through to the 10-minute default — so it was
 * re-probed every 10 minutes, with a real failing upstream request on the
 * request path, for however many days the weekly window had left.
 *
 * Only the ACCOUNT-WIDE windows bench a profile. Anthropic also reports
 * per-model weekly budgets (`seven_day_opus`, `seven_day_fable`, …), and an
 * exhausted one of those does not mean the account is unusable — sidelining a
 * profile for days because a single model's budget ran out would be worse than
 * the bug this fixes. Those cases keep the old default and are called out as a
 * known remainder rather than silently mishandled.
 */
export type CooldownWindowType = "five_hour" | "seven_day"

/** Account-wide windows, longest first — the order preference relies on it. */
const COOLDOWN_WINDOWS: readonly CooldownWindowType[] = ["seven_day", "five_hour"]

/**
 * Upper bound on a reset for each window, guarding against a garbage value
 * from upstream.
 *
 * This is per-window rather than one constant precisely because a single
 * constant is how the fix fails silently: a 6-hour cap applied to a weekly
 * reset flattens "resets in three days" to "resets in six hours" and quietly
 * recreates the re-probe loop at a slower interval. A `five_hour` window
 * cannot legitimately reset more than ~5h out; a `seven_day` one can reset up
 * to 7 days out, so 8 days covers it with room for clock skew.
 */
const COOLDOWN_CAP_MS: Record<CooldownWindowType, number> = {
  five_hour: 6 * 60 * 60_000,
  seven_day: 8 * 24 * 60 * 60_000,
}

export function cooldownCapMs(type: CooldownWindowType): number {
  return COOLDOWN_CAP_MS[type]
}

/** A usage window, normalized from either the rate-limit store or the OAuth snapshot. */
export interface CooldownWindow {
  type: string
  resetsAt: number | null | undefined
  /**
   * Whether this window is actually spent. Presence proves nothing — a healthy
   * account always carries both windows with future resets — so only genuine
   * exhaustion may set this.
   */
  exhausted: boolean
}

/**
 * The timestamp to bench a profile until, given its usage windows.
 *
 * Prefers the LONGEST exhausted account-wide window: a profile inside its
 * weekly cap stays unusable even once the five-hour window rolls over, so
 * benching only to the five-hour reset would resume probing a still-capped
 * account. Falls back to `now + defaultMs` when nothing is exhausted, which
 * keeps the conservative self-healing default for a mis-mark.
 *
 * Pure. Never returns a time in the past.
 */
export function resolveCooldownUntil(
  windows: readonly CooldownWindow[],
  now: number,
  defaultMs: number,
): number {
  return findCooldownReset(windows, now) ?? now + defaultMs
}

/**
 * The capped reset of the longest genuinely exhausted window, or null when
 * nothing here proves a window is spent.
 *
 * Split out of `resolveCooldownUntil` so a caller can tell "the account told us
 * when it frees up" from "we invented a conservative default" — a distinction
 * `resolveCooldownUntil` erases by design. `Retry-After` needs it (#901): a
 * real reset is worth sending, a fabricated one dressed as an observation is
 * not.
 */
export function findCooldownReset(
  windows: readonly CooldownWindow[],
  now: number,
): number | null {
  for (const type of COOLDOWN_WINDOWS) {
    const match = windows.find(w => w.type === type && w.exhausted && (w.resetsAt ?? 0) > now)
    if (match?.resetsAt) {
      return Math.min(match.resetsAt, now + cooldownCapMs(type))
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Weekly reserve (opt-in, pool routing). See profiles-routing.spec.md.
// ---------------------------------------------------------------------------

/** The account-wide weekly window the reserve is measured against. */
export const WEEKLY_RESERVE_WINDOW = "seven_day"

/** How long a reading with no reset time may keep a profile held. */
export const WEEKLY_RESERVE_UNKNOWN_RESET_MAX_AGE_MS = 60 * 60_000

/** One observation of a profile's weekly window, from any source. */
export interface WeeklyUsageReading {
  /** 0..1, or absent when the source did not report it. */
  utilization: number | null | undefined
  /** Epoch ms of the window's reset, or absent when unknown. */
  resetsAt: number | null | undefined
  /** Epoch ms the reading was taken. */
  observedAt: number
}

export interface WeeklyReserveHold {
  utilization: number
  /** When the hold lifts on its own (the window's reset), if known. */
  until: number | undefined
}

/**
 * Parse reserve percentages from `MERIDIAN_WEEKLY_RESERVE`
 * (`personal=20,work=10`), which takes precedence, or the `weeklyReserve`
 * setting. Values must be in (0, 100); anything else is returned as invalid.
 */
export function parseWeeklyReserves(
  env: string | undefined,
  setting: Readonly<Record<string, unknown>> | undefined,
): { reserves: Map<string, number>; invalid: string[] } {
  const reserves = new Map<string, number>()
  const invalid: string[] = []
  const accept = (id: string, value: unknown, label: string) => {
    const pct = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN
    if (id && Number.isFinite(pct) && pct > 0 && pct < 100) reserves.set(id, pct)
    else invalid.push(label)
  }
  if (env && env.trim()) {
    for (const part of env.split(",")) {
      const entry = part.trim()
      if (!entry) continue
      const eq = entry.indexOf("=")
      if (eq <= 0) { invalid.push(entry); continue }
      accept(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim(), entry)
    }
    return { reserves, invalid }
  }
  if (setting && typeof setting === "object") {
    for (const [id, value] of Object.entries(setting)) accept(id.trim(), value, `${id}=${String(value)}`)
  }
  return { reserves, invalid }
}

/**
 * Whether a profile is holding its weekly reserve, from the newest reading
 * that still describes the current window: a reading past its reset, or one
 * with no reset older than WEEKLY_RESERVE_UNKNOWN_RESET_MAX_AGE_MS, is
 * ignored. No usable reading means no hold.
 */
export function weeklyReserveHold(
  reservePercent: number,
  readings: readonly WeeklyUsageReading[],
  now: number,
): WeeklyReserveHold | undefined {
  let newest: WeeklyUsageReading | undefined
  for (const reading of readings) {
    if (typeof reading.utilization !== "number" || !Number.isFinite(reading.utilization)) continue
    if (typeof reading.resetsAt === "number") {
      if (reading.resetsAt <= now) continue
    } else if (now - reading.observedAt > WEEKLY_RESERVE_UNKNOWN_RESET_MAX_AGE_MS) {
      continue
    }
    if (!newest || reading.observedAt > newest.observedAt) newest = reading
  }
  if (!newest || typeof newest.utilization !== "number") return undefined
  const limit = 1 - reservePercent / 100
  if (newest.utilization < limit) return undefined
  return {
    utilization: newest.utilization,
    until: typeof newest.resetsAt === "number" ? newest.resetsAt : undefined,
  }
}

/** Holds for every profile in `ids` that has a reserve and has reached it. */
export function weeklyReserveHolds(
  ids: readonly string[],
  reserves: ReadonlyMap<string, number>,
  readingsFor: (id: string) => readonly WeeklyUsageReading[],
  now: number,
): Map<string, WeeklyReserveHold> {
  const holds = new Map<string, WeeklyReserveHold>()
  if (reserves.size === 0) return holds
  for (const id of ids) {
    const pct = reserves.get(id)
    if (pct === undefined) continue
    const hold = weeklyReserveHold(pct, readingsFor(id), now)
    if (hold) holds.set(id, hold)
  }
  return holds
}

export type WeeklyReserveEvent =
  | { event: "priority.weekly_reserve_held"; data: { profile: string; utilization: number; until: number | undefined } }
  | { event: "priority.weekly_reserve_released"; data: { profile: string } }
  | { event: "priority.weekly_reserve_invalid"; data: { invalid: string[] } }
  | { event: "priority.weekly_reserve_unknown_ids"; data: { unknown: string[] } }

/**
 * Per-instance reserve state: which profiles are held, plus log events for
 * transitions and for configuration problems (each distinct problem once).
 */
export class WeeklyReserveTracker {
  private readonly held = new Set<string>()
  private lastInvalid = ""
  private lastUnknown = ""

  evaluate(input: {
    ids: readonly string[]
    /** Every Claude profile id, for reporting reserves naming no profile. */
    knownIds: readonly string[]
    parsed: { reserves: ReadonlyMap<string, number>; invalid: readonly string[] }
    readingsFor: (id: string) => readonly WeeklyUsageReading[]
    now: number
  }): { holds: Map<string, WeeklyReserveHold>; events: WeeklyReserveEvent[] } {
    const events: WeeklyReserveEvent[] = []
    const invalidKey = input.parsed.invalid.join(",")
    if (invalidKey && invalidKey !== this.lastInvalid) {
      events.push({ event: "priority.weekly_reserve_invalid", data: { invalid: [...input.parsed.invalid] } })
    }
    this.lastInvalid = invalidKey
    const known = new Set(input.knownIds)
    const unknown = [...input.parsed.reserves.keys()].filter(id => !known.has(id))
    const unknownKey = unknown.join(",")
    if (unknownKey && unknownKey !== this.lastUnknown) {
      events.push({ event: "priority.weekly_reserve_unknown_ids", data: { unknown } })
    }
    this.lastUnknown = unknownKey

    const holds = weeklyReserveHolds(input.ids, input.parsed.reserves, input.readingsFor, input.now)
    for (const [id, hold] of holds) {
      if (this.held.has(id)) continue
      this.held.add(id)
      events.push({ event: "priority.weekly_reserve_held", data: { profile: id, utilization: hold.utilization, until: hold.until } })
    }
    for (const id of input.ids) {
      if (holds.has(id) || !this.held.has(id)) continue
      this.held.delete(id)
      events.push({ event: "priority.weekly_reserve_released", data: { profile: id } })
    }
    return { holds, events }
  }
}
