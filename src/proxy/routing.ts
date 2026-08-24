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
  if (order.length === 0) return undefined
  for (const id of order) {
    if (!isExhausted(id)) return { id, allExhausted: false }
  }
  return { id: order[0]!, allExhausted: true }
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
 * After a restart the next request re-establishes the assignment.
 */
export class AssignmentStore {
  private readonly entries = new Map<string, string>()

  constructor(private readonly max: number) {}

  /** Read an assignment, marking it most-recently-used. */
  get(key: string): string | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  /** Write an assignment, marking it most-recently-used and evicting if over capacity. */
  set(key: string, value: string): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
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
  for (const type of COOLDOWN_WINDOWS) {
    const match = windows.find(w => w.type === type && w.exhausted && (w.resetsAt ?? 0) > now)
    if (match?.resetsAt) {
      return Math.min(match.resetsAt, now + cooldownCapMs(type))
    }
  }
  return now + defaultMs
}
