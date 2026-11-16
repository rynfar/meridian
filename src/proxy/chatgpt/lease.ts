/**
 * The ChatGPT writer lease.
 *
 * Exactly one process may hold refresh authority for a ChatGPT account, at any
 * instant, forever. Refresh tokens are single-use: two processes exchanging one
 * do not produce a retry, they produce an account no amount of retrying
 * recovers. Everything below is shaped by that.
 *
 * The mechanism is Meridian's own, not a new dependency. `sessionStore.ts`
 * already publishes a lock as a fsynced staging file linked into place with
 * `linkSync` - atomic and no-replace, so two processes cannot both believe they
 * created it - and already decides abandonment with an OS-backed process
 * incarnation rather than a clock.
 *
 * THAT SECOND PART IS THE WHOLE SAFETY ARGUMENT. A time-based lease treats a
 * paused, swapping or descheduled holder as gone, and on a loaded machine that
 * is a routine occurrence rather than an exotic one. Here a lock is displaced
 * solely when the OS says its owner is gone (`processIncarnationIsDead`, which
 * answers `dead` only on a missing process or a different boot of this host,
 * and fails closed on everything else). Staleness only paces the probe: a
 * stale lock is probed on every attempt, a fresh one at most once a second,
 * because on darwin and win32 a probe is a synchronous child process. A
 * restart's successor therefore takes over from a predecessor that exited
 * without releasing as soon as it is gone, not a stale window later.
 *
 * A lock nobody can parse is therefore never reclaimed. That is deliberate:
 * refusing to start is recoverable by deleting a file, and spending another
 * process's single-use token is not.
 */

import { randomUUID } from "node:crypto"
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { hostname } from "node:os"
import { dirname } from "node:path"
import { withWriterRecoveryClaim } from "./recovery"
import {
  captureProcessIncarnation,
  parseProcessIncarnation,
  processIncarnationIsDead,
  type ProcessIncarnation,
} from "../session/processIncarnation"

const DEFAULT_STALE_MS = 60_000
const DEFAULT_HEARTBEAT_MS = 5_000
const DEFAULT_WAIT_MS = 10_000
const RETRY_MS = 50
const FRESH_PROBE_INTERVAL_MS = 1_000

export class WriterLeaseUnavailableError extends Error {
  readonly lockPath: string

  constructor(lockPath: string, detail: string) {
    super(`Could not take the ChatGPT writer lease at ${lockPath}: ${detail}.`)
    this.name = "WriterLeaseUnavailableError"
    this.lockPath = lockPath
  }
}

export class WriterLeaseLostError extends Error {
  readonly lockPath: string

  constructor(lockPath: string, detail: string) {
    super(`This process no longer holds the ChatGPT writer lease at ${lockPath}: ${detail}.`)
    this.name = "WriterLeaseLostError"
    this.lockPath = lockPath
  }
}

export interface WriterLease {
  readonly lockPath: string
  /**
   * Call this immediately before spending a single-use token, not merely at
   * acquisition. A holder can be legitimately displaced after a crash-recovery
   * window, and the only safe moment to discover that is before the exchange.
   */
  assertValid(): void
  release(): void
}

export interface AcquireWriterLeaseOptions {
  lockPath: string
  /** How long an un-heartbeaten lock may sit before its owner is PROBED. Not by itself permission to displace it. */
  staleMs?: number
  heartbeatMs?: number
  /** How long to wait for a live holder to finish. 0 refuses immediately. */
  waitMs?: number
}

interface WriterLeaseOwner {
  pid: number
  hostname: string
  token: string
  incarnation: ProcessIncarnation
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function parseOwner(contents: string): WriterLeaseOwner | undefined {
  try {
    const owner = JSON.parse(contents) as Record<string, unknown>
    const incarnation = parseProcessIncarnation(owner.incarnation)
    if (
      typeof owner.pid !== "number"
      || !Number.isInteger(owner.pid)
      || owner.pid <= 0
      || typeof owner.hostname !== "string"
      || owner.hostname.length === 0
      || typeof owner.token !== "string"
      || owner.token.length === 0
      || !incarnation
    ) return undefined
    return { pid: owner.pid, hostname: owner.hostname, token: owner.token, incarnation }
  } catch {
    return undefined
  }
}

/** Publish a fully written lock with an atomic no-replace link. False means someone else already holds it. */
function publishLockFile(lockPath: string, contents: string): boolean {
  const staging = `${lockPath}.candidate-${process.pid}-${randomUUID()}`
  let fd: number | undefined
  try {
    fd = openSync(staging, "wx", 0o600)
    fchmodSync(fd, 0o600)
    writeFileSync(fd, contents, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    try {
      linkSync(staging, lockPath)
      return true
    } catch (error) {
      if (errnoCode(error) === "EEXIST") return false
      throw error
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch (error) {
        console.error("[chatgpt] lease staging close failed:", (error as Error).message)
      }
    }
    try { unlinkSync(staging) } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        console.error("[chatgpt] lease staging cleanup failed:", (error as Error).message)
      }
    }
  }
}

function ownsLock(lockPath: string, contents: string): boolean {
  try {
    return readFileSync(lockPath, "utf8") === contents
  } catch {
    return false
  }
}

/** True means the path is now free to attempt. False means a holder is alive, or unprovably dead. */
function retireDeadLock(lockPath: string, staleMs: number, probeFresh: boolean): boolean {
  let contents: string
  let info: ReturnType<typeof statSync>
  try {
    contents = readFileSync(lockPath, "utf8")
    info = statSync(lockPath)
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return true
    throw new Error(`[chatgpt] lease inspection failed: ${(error as Error).message}`, { cause: error })
  }

  if (!probeFresh && Date.now() - info.mtimeMs <= staleMs) return false
  const owner = parseOwner(contents)
  if (!owner || !processIncarnationIsDead(owner.incarnation)) return false

  return withWriterRecoveryClaim(lockPath, contents, () => {
    // The generation claim excludes other reclaimers across this check/rename
    // interval. Path assertions alone cannot fence an already-dispatched grant.
    try {
      const current = readFileSync(lockPath, "utf8")
      const currentInfo = statSync(lockPath)
      if (current !== contents || currentInfo.dev !== info.dev || currentInfo.ino !== info.ino) {
        return true
      }
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return true
      throw new Error(`[chatgpt] lease recovery failed: ${(error as Error).message}`, { cause: error })
    }

    const retired = `${lockPath}.stale-${process.pid}-${randomUUID()}`
    try {
      renameSync(lockPath, retired)
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return true
      throw new Error(`[chatgpt] lease recovery failed: ${(error as Error).message}`, { cause: error })
    }
    try { unlinkSync(retired) } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        console.error("[chatgpt] retired lease cleanup failed:", (error as Error).message)
      }
    }
    return true
  })
}

function describeHolder(lockPath: string): string {
  try {
    const owner = parseOwner(readFileSync(lockPath, "utf8"))
    return owner ? `held by pid ${owner.pid} on ${owner.hostname}` : "held by an unreadable owner record"
  } catch {
    return "held by another process"
  }
}

function startLease(lockPath: string, contents: string, heartbeatMs: number): WriterLease {
  let released = false
  let lost = false

  const heartbeat = setInterval(() => {
    if (released || lost) return
    if (!ownsLock(lockPath, contents)) {
      lost = true
      clearInterval(heartbeat)
      return
    }
    const now = new Date()
    try {
      utimesSync(lockPath, now, now)
    } catch {
      if (!ownsLock(lockPath, contents)) {
        lost = true
        clearInterval(heartbeat)
      }
    }
  }, heartbeatMs)
  heartbeat.unref?.()

  return {
    lockPath,
    assertValid() {
      if (released) throw new WriterLeaseLostError(lockPath, "it was released")
      if (lost || !ownsLock(lockPath, contents)) {
        lost = true
        throw new WriterLeaseLostError(lockPath, "another owner holds the lock")
      }
    },
    release() {
      if (released) return
      released = true
      clearInterval(heartbeat)
      if (!ownsLock(lockPath, contents)) return
      try {
        unlinkSync(lockPath)
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") {
          console.error("[chatgpt] lease release failed:", (error as Error).message)
        }
      }
    },
  }
}

export async function acquireWriterLease(options: AcquireWriterLeaseOptions): Promise<WriterLease> {
  const { lockPath } = options
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS

  const incarnation = captureProcessIncarnation()
  if (!incarnation) {
    throw new WriterLeaseUnavailableError(lockPath, "this process's OS identity could not be captured")
  }
  const contents = JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
    incarnation,
  })

  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })

  const deadline = Date.now() + waitMs
  let freshProbedAt = -Infinity
  for (;;) {
    if (publishLockFile(lockPath, contents)) return startLease(lockPath, contents, heartbeatMs)
    const probeFresh = Date.now() - freshProbedAt >= FRESH_PROBE_INTERVAL_MS
    if (probeFresh) freshProbedAt = Date.now()
    if (retireDeadLock(lockPath, staleMs, probeFresh)) continue
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new WriterLeaseUnavailableError(lockPath, describeHolder(lockPath))
    await new Promise(resolve => setTimeout(resolve, Math.min(RETRY_MS, remaining)))
  }
}
