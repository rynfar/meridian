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

export type RoutingMode = "active" | "sticky"

/**
 * Parse a routing mode string (from settings or MERIDIAN_ROUTING).
 * Unknown values fall back to "active" — a typo must never change
 * routing behavior into something surprising.
 */
export function getRoutingMode(raw: string | undefined): RoutingMode {
  return raw?.toLowerCase() === "sticky" ? "sticky" : "active"
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
