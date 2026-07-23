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
 * This is a leaf module — pure functions, no I/O.
 */

import { createHash } from "node:crypto"

export type RoutingMode = "active" | "sticky" | "priority"

/**
 * Parse a routing mode string (from settings or MERIDIAN_ROUTING).
 * Unknown values fall back to "active" — a typo must never change
 * routing behavior into something surprising.
 */
export function getRoutingMode(raw: string | undefined): RoutingMode {
  const lower = raw?.toLowerCase()
  if (lower === "sticky") return "sticky"
  if (lower === "priority") return "priority"
  return "active"
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
