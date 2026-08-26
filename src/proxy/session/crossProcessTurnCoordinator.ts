import { createHash, randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { basename, dirname, join } from "node:path"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import {
  createRecoveryClaimOwner,
  getRecoveryClaimPath,
  getRecoveryClaimTombstonePath,
  parseRecoveryClaimOwnerJson,
  recoveryClaimOwnerIsDead,
  type RecoveryClaimOwner,
} from "./recoveryClaim"
import {
  captureProcessIncarnation,
  parseProcessIncarnation,
  processIncarnationIsDead,
  type ProcessIncarnation,
} from "./processIncarnation"

const OWNER_FILE = "owner.json"
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000
const DEFAULT_STALE_AFTER_MS = 30_000
const DEFAULT_RETRY_DELAY_MS = 25

export interface CrossProcessTurnCoordinatorOptions {
  /** Maximum time an acquire may wait. Acquires always have a finite bound. */
  acquireTimeoutMs?: number
  /** A lock with no fresh heartbeat for this long may be recovered. */
  staleAfterMs?: number
  /** Defaults to one third of `staleAfterMs`. Must be shorter than it. */
  heartbeatIntervalMs?: number
  /** Delay between attempts while another process owns the turn. */
  retryDelayMs?: number
}

export interface CrossProcessTurnLease {
  readonly waitedMs: number
  /** Stop the heartbeat and release the lock if this lease still owns it. */
  release(): Promise<void>
}

interface OwnerRecord {
  token: string
  pid: number
  hostname: string
  createdAt: number
  incarnation: ProcessIncarnation
}

interface LockSnapshot {
  dev: bigint
  ino: bigint
  mtimeMs: number
  owner?: OwnerRecord
  heartbeatMtimeMs?: number
}

export class CrossProcessTurnAcquireTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out acquiring cross-process turn lock after ${timeoutMs}ms`)
    this.name = "CrossProcessTurnAcquireTimeoutError"
  }
}

export class CrossProcessTurnOwnershipError extends Error {
  constructor(message = "Cross-process turn lease no longer owns its lock") {
    super(message)
    this.name = "CrossProcessTurnOwnershipError"
  }
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException(
    typeof reason === "string" && reason ? reason : "The request was cancelled",
    "AbortError",
  )
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`)
  }
  return value
}

function heartbeatName(token: string): string {
  return `heartbeat-${token}`
}

function lockName(key: string): string {
  return `${createHash("sha256").update(key).digest("hex")}.lock`
}

async function readOwner(lockPath: string): Promise<OwnerRecord | undefined> {
  let raw: string
  try {
    raw = await readFile(join(lockPath, OWNER_FILE), "utf8")
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    // A process may die during its owner write. Keep the incomplete directory
    // busy until its mtime becomes stale.
    return undefined
  }
  if (
    typeof value === "object"
    && value !== null
    && "token" in value
    && typeof value.token === "string"
    && value.token.length > 0
    && "pid" in value
    && typeof value.pid === "number"
    && Number.isInteger(value.pid)
    && value.pid > 0
    && "hostname" in value
    && typeof value.hostname === "string"
    && "createdAt" in value
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt)
    && "incarnation" in value
    && parseProcessIncarnation(value.incarnation) !== undefined
  ) {
    return value as OwnerRecord
  }
  return undefined
}

async function snapshotLock(lockPath: string): Promise<LockSnapshot | undefined> {
  let lockStat
  try {
    lockStat = await lstat(lockPath, { bigint: true })
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined
    throw error
  }
  if (!lockStat.isDirectory()) {
    throw new Error(`Cross-process turn lock is not a directory: ${lockPath}`)
  }

  const owner = await readOwner(lockPath)
  let heartbeatMtimeMs: number | undefined
  if (owner) {
    try {
      heartbeatMtimeMs = (await stat(join(lockPath, heartbeatName(owner.token)))).mtimeMs
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error
    }
  }

  return {
    dev: lockStat.dev,
    ino: lockStat.ino,
    mtimeMs: Number(lockStat.mtimeMs),
    owner,
    heartbeatMtimeMs,
  }
}

function sameIdentity(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function ownerIsDead(owner: OwnerRecord | undefined): boolean {
  return owner ? processIncarnationIsDead(owner.incarnation) : false
}

function canRecover(snapshot: LockSnapshot, staleAfterMs: number, now = Date.now()): boolean {
  // Never steal from a process that may still be executing: without a fencing
  // token in sessions.json, a stale-but-live owner could later overwrite its
  // successor. Same-host PID death is authoritative. Ownerless half-created
  // directories are recoverable only after their quarantine age. Cross-host
  // locks fail closed and require operator cleanup after the host is confirmed
  // dead.
  const lastHeartbeat = snapshot.heartbeatMtimeMs ?? snapshot.mtimeMs
  if (now - lastHeartbeat <= staleAfterMs) return false
  if (snapshot.owner) return ownerIsDead(snapshot.owner)
  // A canonical directory without owner.json may be an initializer suspended
  // after mkdir. Its ownership is uncertain, so recovery must fail closed.
  return false
}

interface RecoveryClaimSnapshot {
  dev: bigint
  ino: bigint
  owner?: RecoveryClaimOwner
}

async function snapshotRecoveryClaim(claimPath: string): Promise<RecoveryClaimSnapshot | undefined> {
  let info
  try {
    info = await lstat(claimPath, { bigint: true })
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return { dev: info.dev, ino: info.ino }

  let owner: RecoveryClaimOwner | undefined
  try {
    owner = parseRecoveryClaimOwnerJson(await readFile(join(claimPath, OWNER_FILE), "utf8"))
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error
  }
  return { dev: info.dev, ino: info.ino, owner }
}

/** Atomically publish a fully initialized, non-empty recovery owner directory. */
async function tryPublishRecoveryClaim(
  claimPath: string,
  generation: string,
): Promise<RecoveryClaimOwner | undefined> {
  const owner = createRecoveryClaimOwner(generation)
  const candidate = `${claimPath}.candidate-${process.pid}-${owner.token}`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let published = false
  try {
    await mkdir(candidate, { mode: 0o700 })
    handle = await open(join(candidate, OWNER_FILE), "wx", 0o600)
    await handle.writeFile(JSON.stringify(owner), "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    const candidateDirectoryHandle = await open(candidate, "r")
    try {
      await candidateDirectoryHandle.sync()
    } finally {
      await candidateDirectoryHandle.close()
    }

    // Every protocol-created destination is non-empty, which makes directory
    // rename an atomic no-replace publication. Malformed existing paths block.
    try {
      await lstat(claimPath)
      return undefined
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error
    }
    try {
      await rename(candidate, claimPath)
      published = true
      const parentDirectoryHandle = await open(dirname(claimPath), "r")
      try {
        await parentDirectoryHandle.sync()
      } finally {
        await parentDirectoryHandle.close()
      }
      return owner
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].some((code) => isErrno(error, code))) {
        return undefined
      }
      throw error
    }
  } finally {
    await handle?.close().catch(() => undefined)
    if (!published) await rm(candidate, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Retire only the observed dead claim generation. Its tombstone fences ABA. */
async function retireDeadRecoveryClaim(claimPath: string, generation: string): Promise<boolean> {
  const observed = await snapshotRecoveryClaim(claimPath)
  if (!observed) return true
  if (
    !observed.owner
    || observed.owner.generation !== generation
    || !recoveryClaimOwnerIsDead(observed.owner)
  ) return false

  const tombstone = getRecoveryClaimTombstonePath(claimPath, observed.owner.token)
  try {
    await lstat(tombstone)
    return false
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error
  }

  const current = await snapshotRecoveryClaim(claimPath)
  if (!current) return true
  const currentOwner = current.owner
  if (
    current.dev !== observed.dev
    || current.ino !== observed.ino
    || !currentOwner
    || currentOwner.token !== observed.owner.token
    || currentOwner.generation !== generation
    || !recoveryClaimOwnerIsDead(currentOwner)
  ) return false

  try {
    await rename(claimPath, tombstone)
  } catch (error) {
    if (isErrno(error, "ENOENT")) return true
    if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].some((code) => isErrno(error, code))) {
      return false
    }
    throw error
  }

  const moved = await snapshotRecoveryClaim(tombstone)
  if (
    !moved
    || moved.dev !== observed.dev
    || moved.ino !== observed.ino
    || moved.owner?.token !== observed.owner.token
    || moved.owner?.generation !== generation
  ) throw new CrossProcessTurnOwnershipError("Recovery claim changed during retirement")
  return true
}

async function releaseRecoveryClaim(
  claimPath: string,
  owner: RecoveryClaimOwner,
): Promise<void> {
  const current = await snapshotRecoveryClaim(claimPath).catch(() => undefined)
  if (current?.owner?.token === owner.token && current.owner.generation === owner.generation) {
    await rm(claimPath, { recursive: true }).catch(() => undefined)
  }
}

async function cleanupRecoveryTombstones(claimPath: string): Promise<void> {
  const prefix = `${basename(claimPath)}.orphan-`
  try {
    for (const name of await readdir(dirname(claimPath))) {
      if (!name.startsWith(prefix)) continue
      const path = join(dirname(claimPath), name)
      const info = await lstat(path)
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await rm(path, { recursive: true })
      }
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error
  }
}

async function restoreMovedLock(movedPath: string, lockPath: string): Promise<void> {
  try {
    await rename(movedPath, lockPath)
  } catch (error) {
    throw new CrossProcessTurnOwnershipError(
      `Lock changed during atomic recovery and could not be restored: ${(error as Error).message}`,
    )
  }
}

/**
 * Serializes one logical turn key across processes using atomic filesystem
 * directory operations. Lock errors never cause an unlocked turn to proceed.
 */
export class CrossProcessTurnCoordinator {
  private readonly root: string
  private readonly acquireTimeoutMs: number
  private readonly staleAfterMs: number
  private readonly heartbeatIntervalMs: number
  private readonly retryDelayMs: number

  constructor(root: string, options: CrossProcessTurnCoordinatorOptions = {}) {
    if (!root) throw new TypeError("root must not be empty")
    this.root = root
    this.acquireTimeoutMs = positiveFinite(
      options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
      "acquireTimeoutMs",
    )
    this.staleAfterMs = positiveFinite(
      options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      "staleAfterMs",
    )
    this.heartbeatIntervalMs = positiveFinite(
      options.heartbeatIntervalMs ?? Math.max(1, Math.floor(this.staleAfterMs / 3)),
      "heartbeatIntervalMs",
    )
    this.retryDelayMs = positiveFinite(
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      "retryDelayMs",
    )
    if (this.heartbeatIntervalMs >= this.staleAfterMs) {
      throw new TypeError("heartbeatIntervalMs must be shorter than staleAfterMs")
    }
  }

  async acquire(key: string, signal?: AbortSignal): Promise<CrossProcessTurnLease> {
    if (signal?.aborted) throw abortError(signal.reason)

    const arrivedAt = Date.now()
    const deadline = arrivedAt + this.acquireTimeoutMs
    const lockPath = join(this.root, lockName(key))
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const rootInfo = await lstat(this.root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error(`Cross-process turn root is not a private directory: ${this.root}`)
    }
    await chmod(this.root, 0o700)

    while (true) {
      if (signal?.aborted) throw abortError(signal.reason)
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        throw new CrossProcessTurnAcquireTimeoutError(this.acquireTimeoutMs)
      }

      const lease = await this.tryAcquire(lockPath, arrivedAt)
      if (lease) {
        if (signal?.aborted) {
          await lease.release()
          throw abortError(signal.reason)
        }
        if (Date.now() > deadline) {
          await lease.release()
          throw new CrossProcessTurnAcquireTimeoutError(this.acquireTimeoutMs)
        }
        return lease
      }

      const snapshot = await snapshotLock(lockPath)
      if (snapshot && canRecover(snapshot, this.staleAfterMs)) {
        await this.recover(lockPath, snapshot)
        continue
      }

      await this.wait(Math.min(this.retryDelayMs, remainingMs), signal)
    }
  }

  private async tryAcquire(
    lockPath: string,
    arrivedAt: number,
  ): Promise<CrossProcessTurnLease | undefined> {
    const incarnation = captureProcessIncarnation()
    if (!incarnation) throw new Error("cannot capture turn-lock owner process incarnation")
    const owner: OwnerRecord = {
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      createdAt: Date.now(),
      incarnation,
    }
    const candidate = `${lockPath}.candidate-${process.pid}-${owner.token}`
    let published = false
    try {
      await mkdir(candidate, { mode: 0o700 })
      await writeFile(join(candidate, OWNER_FILE), JSON.stringify(owner), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      })
      await writeFile(join(candidate, heartbeatName(owner.token)), "", {
        flag: "wx",
        mode: 0o600,
      })
      // Renaming a fully initialized, non-empty directory publishes one lock
      // generation atomically. A competing initialized directory cannot be
      // replaced by rename on supported filesystems (EEXIST/ENOTEMPTY).
      try {
        await rename(candidate, lockPath)
        published = true
      } catch (error) {
        if (isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY")) return undefined
        throw error
      }

      return this.createLease(lockPath, owner, Date.now() - arrivedAt)
    } finally {
      if (!published) await rm(candidate, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private createLease(
    lockPath: string,
    owner: OwnerRecord,
    waitedMs: number,
  ): CrossProcessTurnLease {
    const heartbeatPath = join(lockPath, heartbeatName(owner.token))
    let heartbeatError: Error | undefined
    let refreshing = false
    let released = false
    let releasePromise: Promise<void> | undefined

    const timer = setInterval(() => {
      if (refreshing || released) return
      refreshing = true
      const now = new Date()
      void utimes(heartbeatPath, now, now)
        .then(() => {
          heartbeatError = undefined
        })
        .catch((error: unknown) => {
          // Keep retrying. A transient filesystem error must not silently stop
          // all future heartbeats; a persistent one is reported on release.
          heartbeatError = error instanceof Error ? error : new Error(String(error))
        })
        .finally(() => {
          refreshing = false
        })
    }, this.heartbeatIntervalMs)
    timer.unref()

    return {
      waitedMs,
      release: () => {
        if (releasePromise) return releasePromise
        released = true
        clearInterval(timer)
        releasePromise = this.releaseOwned(lockPath, owner.token, heartbeatError)
        return releasePromise
      },
    }
  }

  private async recover(lockPath: string, snapshot: LockSnapshot): Promise<void> {
    const generation = snapshot.owner?.token
    if (!generation) return
    const claimPath = getRecoveryClaimPath(lockPath, generation)
    let claimOwner = await tryPublishRecoveryClaim(claimPath, generation)
    if (!claimOwner) {
      if (!await retireDeadRecoveryClaim(claimPath, generation)) return
      claimOwner = await tryPublishRecoveryClaim(claimPath, generation)
      if (!claimOwner) return
    }

    let generationResolved = false
    try {
      // Only one recoverer may act on this exact generation. Dead claim owners
      // are moved to token-scoped tombstones before a successor claim appears.
      const current = await snapshotLock(lockPath)
      if (!current || !sameIdentity(snapshot, current)) {
        generationResolved = true
        return
      }
      if (!canRecover(current, this.staleAfterMs)) return

      const movedPath = `${lockPath}.stale-${randomUUID()}`
      await rename(lockPath, movedPath)
      generationResolved = true
      const moved = await snapshotLock(movedPath)
      if (!moved || !sameIdentity(current, moved)) {
        throw new CrossProcessTurnOwnershipError("Lock changed during claimed stale recovery")
      }
      await rm(movedPath, { recursive: true })
    } catch (error) {
      if (isErrno(error, "ENOENT")) generationResolved = true
      else throw error
    } finally {
      await releaseRecoveryClaim(claimPath, claimOwner)
      if (generationResolved) {
        await cleanupRecoveryTombstones(claimPath).catch((error) => {
          console.error("[crossProcessTurnCoordinator] recovery tombstone cleanup failed:", (error as Error).message)
        })
      }
    }
  }

  private async releaseOwned(
    lockPath: string,
    token: string,
    heartbeatError?: Error,
  ): Promise<void> {
    const before = await snapshotLock(lockPath)
    if (!before || before.owner?.token !== token) {
      throw new CrossProcessTurnOwnershipError()
    }

    const movedPath = `${lockPath}.released-${token}`
    try {
      await rename(lockPath, movedPath)
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new CrossProcessTurnOwnershipError()
      throw error
    }

    const moved = await snapshotLock(movedPath)
    if (!moved || !sameIdentity(before, moved) || moved.owner?.token !== token) {
      await restoreMovedLock(movedPath, lockPath)
      throw new CrossProcessTurnOwnershipError("Refused to release a lock owned by another token")
    }

    await rm(movedPath, { recursive: true })
    if (heartbeatError) {
      throw new Error(`Cross-process turn heartbeat failed: ${heartbeatError.message}`, {
        cause: heartbeatError,
      })
    }
  }

  private wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (signal) signal.removeEventListener("abort", onAbort)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => finish(), delayMs)
      timer.unref()
      const onAbort = () => {
        clearTimeout(timer)
        finish(abortError(signal?.reason))
      }
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
      }
    })
  }
}
