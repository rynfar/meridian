import { captureProcessIncarnation, type ProcessIncarnation } from "./processIncarnation"

/**
 * Owner tokens of the locks and recovery claims an operation in this process
 * is taking or holding: cross-process turn locks, the session-lifecycle lock,
 * the session-store lock and their recovery claims. A lock or claim stamped
 * with this process's exact incarnation whose token is not here was left
 * behind by a release that failed, so it is abandoned, not live. Kept on
 * `globalThis` so a second copy of this module in the same process shares it
 * instead of reading the other copy's live locks as abandoned.
 *
 * Hold a token before its lock or claim can be published, and drop it once
 * the release attempt is over, whatever its outcome.
 */
const LIVE_LOCK_TOKENS: unique symbol = Symbol.for("meridian.session.liveLockTokens")
const lockTokenRegistry = globalThis as typeof globalThis & { [LIVE_LOCK_TOKENS]?: Set<string> }
const liveLockTokens = lockTokenRegistry[LIVE_LOCK_TOKENS] ??= new Set<string>()

/** The last delay repeats until the abandoned lock is gone. */
export const DEFAULT_RELEASE_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000, 60_000]

export function holdLockToken(token: string): void {
  liveLockTokens.add(token)
}

export function dropLockToken(token: string): void {
  liveLockTokens.delete(token)
}

export function lockTokenIsHeld(token: string): boolean {
  return liveLockTokens.has(token)
}

export function sameProcessIncarnation(left: ProcessIncarnation, right: ProcessIncarnation): boolean {
  return left.pid === right.pid
    && left.hostId === right.hostId
    && left.bootId === right.bootId
    && left.startId === right.startId
    && left.startIdKind === right.startIdKind
}

/** A lock or claim this exact process published and no operation here holds. */
export function abandonedBySelf(owner: { token: string, incarnation: ProcessIncarnation }): boolean {
  if (liveLockTokens.has(owner.token)) return false
  const current = captureProcessIncarnation()
  return current !== undefined && sameProcessIncarnation(owner.incarnation, current)
}

/**
 * Keep clearing a lock whose release failed, so a process waiting on it is
 * unblocked once the error clears; this process's own acquisitions reclaim it
 * directly. `clear` returns once the lock is gone or carries another token and
 * throws while it is still present. It must go through the lock's recovery
 * claim and identity recheck, never a second bare release, so it cannot remove
 * a successor's lock.
 */
export function retryAbandonedLockRelease(
  label: string,
  clear: () => Promise<void>,
  delays: readonly number[] = DEFAULT_RELEASE_RETRY_DELAYS_MS,
  attempt = 0,
): void {
  if (delays.length === 0) return
  const delayMs = delays[Math.min(attempt, delays.length - 1)]!
  const timer = setTimeout(() => {
    void clear().catch((error: unknown) => {
      if (attempt + 1 === delays.length) {
        console.error(
          `[${label}] abandoned lock release still failing; retrying:`,
          error instanceof Error ? error.message : String(error),
        )
      }
      retryAbandonedLockRelease(label, clear, delays, attempt + 1)
    })
  }, delayMs)
  timer.unref()
}
