import { randomUUID } from "node:crypto"
import { checkParameters } from "./connection"
import { getMaxPriorityAttemptsLimit } from "../../sessionStore"
import { readPriorityAssignment } from "./storePrioritySql"
import { advanceStoreSlot } from "./storeMutationSupport"
import { withStoreWrite } from "./storeScope"
import type { DurablePriorityAttempt } from "./legacyCodec"
import { UUID_PATTERN } from "./legacyCodec"
import type { BookkeepingTransaction } from "./types"
import type { PriorityAttemptClaim, PriorityAttemptTurn } from "./storeTypes"

function writeAttempt(tx: BookkeepingTransaction, route: string, attempt: DurablePriorityAttempt): void {
  tx.run(`INSERT INTO priority_attempts VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(route_key) DO UPDATE SET
    blocked=excluded.blocked,blocked_turn_digest=excluded.blocked_turn_digest,
    blocked_turn_issued_at=excluded.blocked_turn_issued_at,pending_turn_digest=excluded.pending_turn_digest,
    pending_turn_issued_at=excluded.pending_turn_issued_at,owner_token=excluded.owner_token,
    generation_id=excluded.generation_id,updated_at=excluded.updated_at`, route, Number(attempt.blocked),
    attempt.blockedTurnDigest, attempt.blockedTurnIssuedAt, attempt.pendingTurnDigest,
    attempt.pendingTurnIssuedAt, attempt.ownerToken, attempt.generationId, attempt.updatedAt)
}

export function claimPriorityAttempt(directory: string, options: {
  routeKey: string; expectedAssignmentGeneration: string; turn?: PriorityAttemptTurn
}): PriorityAttemptClaim | false {
  checkParameters([options.routeKey, options.expectedAssignmentGeneration, options.turn?.turnId ?? null])
  if (!options.routeKey || options.routeKey.length > 512)
    throw new Error("priority attempt requires a bounded route key")
  const turn = options.turn
  if (turn && (!/^[A-Za-z0-9_-]{43}$/.test(turn.turnId) || !Number.isSafeInteger(turn.issuedAt) || turn.issuedAt < 0))
    throw new Error("priority attempt requires a valid trusted turn")
  const ownerToken = randomUUID()
  return withStoreWrite(directory, (tx) => {
    const lookup = readPriorityAssignment(tx, options.routeKey)
    if (lookup.status === "error") throw lookup.error
    if (lookup.generation !== options.expectedAssignmentGeneration) return false
    const previous = lookup.attempt
    if (previous) {
      const floor = Math.max(lookup.status === "found" ? lookup.assignment.lastHumanTurnIssuedAt : -1,
        previous.blockedTurnIssuedAt ?? -1, previous.pendingTurnIssuedAt ?? -1)
      if (!turn || turn.issuedAt <= floor) return false
    } else if (Number(tx.get("SELECT value FROM bookkeeping_counts WHERE kind='priority_attempts'")?.value)
      >= getMaxPriorityAttemptsLimit()) return false
    let blocked = previous?.blocked ?? false
    let blockedTurnDigest = previous?.blockedTurnDigest ?? null
    let blockedTurnIssuedAt = previous?.blockedTurnIssuedAt ?? null
    if (previous?.ownerToken) {
      blocked = true
      if (previous.pendingTurnIssuedAt !== null
        && (blockedTurnIssuedAt === null || previous.pendingTurnIssuedAt > blockedTurnIssuedAt)) {
        blockedTurnDigest = previous.pendingTurnDigest
        blockedTurnIssuedAt = previous.pendingTurnIssuedAt
      }
    }
    tx.run("UPDATE schema_meta SET store_meta_version=3")
    writeAttempt(tx, options.routeKey, { blocked, blockedTurnDigest, blockedTurnIssuedAt,
      pendingTurnDigest: turn?.turnId ?? null, pendingTurnIssuedAt: turn?.issuedAt ?? null,
      ownerToken, generationId: randomUUID(), updatedAt: Date.now() })
    advanceStoreSlot(tx, `priority-attempt:${options.routeKey}`)
    return { ownerToken }
  })
}

function settle(directory: string, route: string, token: string, block: boolean): boolean {
  checkParameters([route, token])
  if (!route || route.length > 512 || !UUID_PATTERN.test(token)) return false
  return withStoreWrite(directory, (tx) => {
    const lookup = readPriorityAssignment(tx, route)
    if (lookup.status === "error") throw lookup.error
    const attempt = lookup.attempt
    if (!attempt || attempt.ownerToken !== token) return false
    if (block) {
      attempt.blocked = true
      if (attempt.pendingTurnIssuedAt !== null
        && (attempt.blockedTurnIssuedAt === null || attempt.pendingTurnIssuedAt > attempt.blockedTurnIssuedAt)) {
        attempt.blockedTurnDigest = attempt.pendingTurnDigest
        attempt.blockedTurnIssuedAt = attempt.pendingTurnIssuedAt
      }
    }
    if (attempt.blocked) {
      attempt.pendingTurnDigest = null
      attempt.pendingTurnIssuedAt = null
      attempt.ownerToken = null
      attempt.generationId = randomUUID()
      attempt.updatedAt = Date.now()
      writeAttempt(tx, route, attempt)
    } else tx.run("DELETE FROM priority_attempts WHERE route_key=?", route)
    advanceStoreSlot(tx, `priority-attempt:${route}`)
    return true
  })
}

export function releasePriorityAttempt(directory: string, route: string, token: string): boolean {
  return settle(directory, route, token, false)
}
export function blockPriorityAttempt(directory: string, route: string, token: string): boolean {
  return settle(directory, route, token, true)
}
