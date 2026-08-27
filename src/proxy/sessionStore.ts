/**
 * File-based session store for cross-proxy session resume.
 *
 * When running per-terminal proxies (each on a different port),
 * sessions need to be shared so you can resume a conversation
 * started in one terminal from another. This stores session
 * mappings in a JSON file that all proxy instances read/write.
 *
 * Format: { [key]: { claudeSessionId, createdAt, lastUsedAt } }
 * Keys are either OpenCode session IDs or conversation fingerprints.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { homedir, hostname } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
import {
  directoryRenameWasBlockedSync,
  syncDirectoryDurablySync,
} from "./session/durableFileSystem"
import type { TokenUsage } from "./session/lineage"
import {
  createRecoveryClaimOwner,
  getRecoveryClaimPath,
  getRecoveryClaimTombstonePath,
  parseRecoveryClaimOwnerJson,
  recoveryClaimOwnerIsDead,
  type RecoveryClaimOwner,
} from "./session/recoveryClaim"
import {
  captureProcessIncarnation,
  parseProcessIncarnation,
  processIncarnationIsDead,
  type ProcessIncarnation,
} from "./session/processIncarnation"

export interface TranscriptLocator {
  sessionId: string
  configDir: string
  projectDir?: string
  /** Opaque lifecycle ownership fence; absent only on legacy mappings. */
  lifecycleGeneration?: string
}

export interface StoredSession {
  claudeSessionId: string
  /** Monotonic per-entry revision retained for diagnostics and upgrades. */
  revision?: number
  /** Unique publication token. Replaced on every durable mapping mutation. */
  generationId?: string
  createdAt: number
  lastUsedAt: number
  messageCount: number
  /** Hash of messages[0..messageCount-1] for conversation lineage verification */
  lineageHash?: string
  /** Per-message content hashes for precise diff-based compaction detection */
  messageHashes?: string[]
  /** Per-message hashes of individual content blocks for append-only tool results */
  messageBlockHashes?: string[][]
  /** Per-message SDK assistant UUIDs for undo rollback (null for user messages) */
  sdkMessageUuids?: Array<string | null>
  /** SDK assistant UUID immediately before synthetic passthrough denials.
   *  Continuations resume the same session here, preserving the stable prefix. */
  passthroughToolCallAssistantUuid?: string
  /** Forwarded tool IDs pending at the stored assistant checkpoint. */
  passthroughToolCallIds?: string[]
  /** Last observed token usage for this Claude session */
  contextUsage?: TokenUsage
  /** Previous Claude session ID preserved when the session mapping is replaced.
   *  Enables recovery when a lineage bug (e.g. false compaction) causes the
   *  original session to be abandoned and a new one started. */
  previousClaudeSessionId?: string
  /** Exact transcript location for the current Claude session. */
  currentTranscript?: TranscriptLocator
  /** Transcript location retained when the session mapping is replaced. */
  previousTranscript?: TranscriptLocator
}

export type StoredSessionGeneration = string

const STORE_META_KEY = "\u0000meridian-session-store"
const STORE_META_VERSION = 1
const PRIORITY_STORE_META_VERSION = 2

export interface DurablePriorityAssignment {
  profileId: string
  lastHumanTurnDigest: string
  mappingKey: string
  /** Exact mapping generation published atomically with this route. */
  mappingGeneration: StoredSessionGeneration
  /** Unique route publication token. Replaced on every route mutation. */
  generationId: string
  updatedAt: number
}

export type PriorityAssignmentGeneration = string

interface SessionStoreMetaV1 {
  version: 1
  /** Fixed hash slots fence absent-key create/delete ABA without unbounded tombstones. */
  slots: Record<string, number>
}

interface SessionStoreMetaV2 {
  version: 2
  /** Shared fixed slots fence both mapping and namespaced route ABA. */
  slots: Record<string, number>
  priorityAssignments: Record<string, DurablePriorityAssignment>
}

type SessionStoreMeta = SessionStoreMetaV1 | SessionStoreMetaV2

interface SessionStoreDocument {
  sessions: Record<string, StoredSession>
  meta: SessionStoreMeta
}

function keyDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

function keySlot(key: string): string {
  // At most 65,536 counters are persisted. A collision can reject safe work,
  // but can never admit stale work because the full key digest is in the token.
  return keyDigest(key).slice(0, 4)
}

function absenceGeneration(key: string, meta: SessionStoreMeta): StoredSessionGeneration {
  return `a:${keyDigest(key)}:${meta.slots[keySlot(key)] ?? 0}`
}

/** Exact, key-bound durable generation used for compare-and-swap fencing. */
export function getStoredSessionGeneration(
  session: StoredSession,
  key: string,
): StoredSessionGeneration {
  const generationId = session.generationId
    ?? `legacy-${createHash("sha256").update(JSON.stringify(session)).digest("hex")}`
  return `p:${keyDigest(key)}:${generationId}`
}

function keyGeneration(
  key: string,
  session: StoredSession | undefined,
  meta: SessionStoreMeta,
): StoredSessionGeneration {
  return session ? getStoredSessionGeneration(session, key) : absenceGeneration(key, meta)
}

function priorityGenerationKey(routeKey: string): string {
  return `priority:${routeKey}`
}

function priorityAbsenceGeneration(
  routeKey: string,
  meta: SessionStoreMeta,
): PriorityAssignmentGeneration {
  return absenceGeneration(priorityGenerationKey(routeKey), meta)
}

export function getPriorityAssignmentGeneration(
  assignment: DurablePriorityAssignment,
  routeKey: string,
): PriorityAssignmentGeneration {
  return `r:${keyDigest(priorityGenerationKey(routeKey))}:${assignment.generationId}`
}

function priorityAssignmentGeneration(
  routeKey: string,
  assignment: DurablePriorityAssignment | undefined,
  meta: SessionStoreMeta,
): PriorityAssignmentGeneration {
  return assignment
    ? getPriorityAssignmentGeneration(assignment, routeKey)
    : priorityAbsenceGeneration(routeKey, meta)
}

function advanceKeySlot(key: string, meta: SessionStoreMeta): void {
  const slot = keySlot(key)
  const current = meta.slots[slot] ?? 0
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`session store generation slot ${slot} is exhausted`)
  }
  meta.slots[slot] = current + 1
}

// No time-based session expiry. SDK sessions persist on Anthropic's side
// for weeks — discarding our mapping just forces a destructive flat-text
// replay on the next request. Storage is bounded by MAX_STORED_SESSIONS.
const DEFAULT_MAX_STORED_SESSIONS = 10_000
const DEFAULT_MAX_PRIORITY_ASSIGNMENTS = 5_000
const STALE_LOCK_THRESHOLD_MS = 30_000
const DEFAULT_LOCK_WAIT_MS = 10_000
const LOCK_RETRY_MS = 10
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4))

export function getMaxStoredSessionsLimit(): number {
  const raw = process.env.MERIDIAN_MAX_STORED_SESSIONS ?? process.env.CLAUDE_PROXY_MAX_STORED_SESSIONS
  if (!raw) return DEFAULT_MAX_STORED_SESSIONS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_STORED_SESSIONS
  return parsed
}

export function getMaxPriorityAssignmentsLimit(): number {
  const raw = process.env.MERIDIAN_MAX_PRIORITY_ASSIGNMENTS
  if (!raw) return DEFAULT_MAX_PRIORITY_ASSIGNMENTS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_PRIORITY_ASSIGNMENTS
  return parsed
}

function getLockWaitMs(): number {
  const raw = process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS
    ?? process.env.CLAUDE_PROXY_SESSION_LOCK_TIMEOUT_MS
  if (!raw) return DEFAULT_LOCK_WAIT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LOCK_WAIT_MS
  return parsed
}

interface StoreLock {
  path: string
  token: string
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(lockWaitBuffer, 0, 0, milliseconds)
}

/** Publish fully initialized lock metadata with an atomic no-replace hard link. */
function publishInitializedLockFile(path: string, contents: string): boolean {
  const staging = `${path}.candidate-${process.pid}-${randomUUID()}`
  let fd: number | undefined
  try {
    fd = openSync(staging, "wx", 0o600)
    fchmodSync(fd, 0o600)
    writeFileSync(fd, contents, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    try {
      linkSync(staging, path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
      throw error
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch (error) {
        console.error("[sessionStore] lock staging close failed:", (error as Error).message)
      }
    }
    try { unlinkSync(staging) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[sessionStore] lock staging cleanup failed:", (error as Error).message)
      }
    }
  }
}

interface CanonicalStoreLockOwner {
  pid: number
  hostname: string
  token: string
  incarnation: ProcessIncarnation
}

function parseCanonicalStoreLockOwner(contents: string): CanonicalStoreLockOwner | undefined {
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
    return {
      pid: owner.pid,
      hostname: owner.hostname,
      token: owner.token,
      incarnation,
    }
  } catch {
    return undefined
  }
}

function canonicalStoreLockOwnerIsDead(contents: string): boolean {
  const owner = parseCanonicalStoreLockOwner(contents)
  return owner ? processIncarnationIsDead(owner.incarnation) : false
}

interface StoreRecoveryClaimSnapshot {
  dev: number
  ino: number
  owner?: RecoveryClaimOwner
}

function snapshotStoreRecoveryClaim(claimPath: string): StoreRecoveryClaimSnapshot | undefined {
  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(claimPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return { dev: info.dev, ino: info.ino }

  let owner: RecoveryClaimOwner | undefined
  try {
    owner = parseRecoveryClaimOwnerJson(readFileSync(join(claimPath, "owner.json"), "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return { dev: info.dev, ino: info.ino, owner }
}

/** Atomically publish a fully initialized, non-empty recovery owner directory. */
function publishStoreRecoveryClaim(claimPath: string, owner: RecoveryClaimOwner): boolean {
  const candidate = `${claimPath}.candidate-${process.pid}-${owner.token}`
  let fd: number | undefined
  let published = false
  try {
    mkdirSync(candidate, { mode: 0o700 })
    fd = openSync(join(candidate, "owner.json"), "wx", 0o600)
    writeFileSync(fd, JSON.stringify(owner), "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    syncDirectoryDurablySync(candidate)

    // Protocol-created destinations are non-empty directories, so rename is
    // atomic and no-replace. Refuse malformed pre-existing paths as well.
    try {
      lstatSync(claimPath)
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    try {
      renameSync(candidate, claimPath)
      published = true
      syncDirectoryDurablySync(dirname(claimPath))
      return true
    } catch (error) {
      if (directoryRenameWasBlockedSync(error, claimPath)) return false
      throw error
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch (error) {
        console.error("[sessionStore] recovery claim owner close failed:", (error as Error).message)
      }
    }
    if (!published) {
      try { rmSync(candidate, { recursive: true, force: true }) } catch (error) {
        console.error("[sessionStore] recovery claim candidate cleanup failed:", (error as Error).message)
      }
    }
  }
}

/** Retire only the observed dead claim generation. Its tombstone fences ABA. */
function retireDeadStoreRecoveryClaim(claimPath: string, generation: string): boolean {
  const observed = snapshotStoreRecoveryClaim(claimPath)
  if (!observed) return true
  if (
    !observed.owner
    || observed.owner.generation !== generation
    || !recoveryClaimOwnerIsDead(observed.owner)
  ) return false

  const tombstone = getRecoveryClaimTombstonePath(claimPath, observed.owner.token)
  try {
    lstatSync(tombstone)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const current = snapshotStoreRecoveryClaim(claimPath)
  if (
    !current
    || current.dev !== observed.dev
    || current.ino !== observed.ino
    || current.owner?.token !== observed.owner.token
    || current.owner.generation !== generation
    || !recoveryClaimOwnerIsDead(current.owner)
  ) return !current

  try {
    renameSync(claimPath, tombstone)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return true
    if (directoryRenameWasBlockedSync(error, tombstone)) return false
    throw error
  }

  const moved = snapshotStoreRecoveryClaim(tombstone)
  if (
    !moved
    || moved.dev !== observed.dev
    || moved.ino !== observed.ino
    || moved.owner?.token !== observed.owner.token
    || moved.owner.generation !== generation
  ) throw new Error("recovery claim identity changed during retirement")
  return true
}

function releaseStoreRecoveryClaim(claimPath: string, owner: RecoveryClaimOwner): void {
  try {
    const current = snapshotStoreRecoveryClaim(claimPath)
    if (current?.owner?.token === owner.token && current.owner.generation === owner.generation) {
      rmSync(claimPath, { recursive: true })
    }
  } catch (error) {
    console.error("[sessionStore] stale recovery claim cleanup failed:", (error as Error).message)
  }
}

function cleanupStoreRecoveryTombstones(claimPath: string): void {
  const prefix = `${basename(claimPath)}.orphan-`
  try {
    for (const name of readdirSync(dirname(claimPath))) {
      if (!name.startsWith(prefix)) continue
      const path = join(dirname(claimPath), name)
      const info = lstatSync(path)
      if (info.isDirectory() && !info.isSymbolicLink()) {
        rmSync(path, { recursive: true })
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[sessionStore] stale recovery tombstone cleanup failed:", (error as Error).message)
    }
  }
}

function retireStaleLock(lockPath: string): boolean {
  let token: string
  let info: ReturnType<typeof statSync>
  try {
    token = readFileSync(lockPath, "utf8")
    info = statSync(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw new Error(`[sessionStore] stale lock inspection failed: ${(error as Error).message}`, { cause: error })
  }
  if (
    Date.now() - info.mtimeMs <= STALE_LOCK_THRESHOLD_MS
    || !canonicalStoreLockOwnerIsDead(token)
  ) return false

  const generation = token
  const claimPath = getRecoveryClaimPath(lockPath, generation)
  const claimOwner = createRecoveryClaimOwner(generation)
  try {
    if (!publishStoreRecoveryClaim(claimPath, claimOwner)) {
      if (!retireDeadStoreRecoveryClaim(claimPath, generation)) return false
      if (!publishStoreRecoveryClaim(claimPath, claimOwner)) return false
    }
  } catch (error) {
    throw new Error(`[sessionStore] stale recovery claim failed: ${(error as Error).message}`, { cause: error })
  }

  let generationResolved = false
  try {
    let currentToken: string
    let currentInfo: ReturnType<typeof statSync>
    try {
      currentToken = readFileSync(lockPath, "utf8")
      currentInfo = statSync(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        generationResolved = true
        return true
      }
      throw error
    }
    if (
      currentToken !== token
      || currentInfo.dev !== info.dev
      || currentInfo.ino !== info.ino
    ) {
      generationResolved = true
      return true
    }
    if (
      Date.now() - currentInfo.mtimeMs <= STALE_LOCK_THRESHOLD_MS
      || !canonicalStoreLockOwnerIsDead(currentToken)
    ) return false

    const retiredPath = `${lockPath}.stale-${process.pid}-${randomUUID()}`
    renameSync(lockPath, retiredPath)
    generationResolved = true
    try {
      const movedToken = readFileSync(retiredPath, "utf8")
      if (movedToken !== currentToken) {
        throw new Error("claimed lock identity changed during stale recovery")
      }
      unlinkSync(retiredPath)
    } catch (error) {
      console.error("[sessionStore] stale lock cleanup failed:", (error as Error).message)
    }
    return true
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === "ENOENT") {
      generationResolved = true
      return true
    }
    throw new Error(`[sessionStore] stale lock recovery failed: ${err.message}`, { cause: err })
  } finally {
    releaseStoreRecoveryClaim(claimPath, claimOwner)
    if (generationResolved) cleanupStoreRecoveryTombstones(claimPath)
  }
}

function acquireLock(lockPath: string): StoreLock {
  const incarnation = captureProcessIncarnation()
  if (!incarnation) throw new Error("[sessionStore] cannot capture lock owner process incarnation")
  const token = JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
    incarnation,
  })
  const deadline = performance.now() + getLockWaitMs()

  while (true) {
    try {
      if (publishInitializedLockFile(lockPath, token)) return { path: lockPath, token }
    } catch (error) {
      throw new Error(`[sessionStore] lock acquire failed: ${(error as Error).message}`, { cause: error })
    }

    if (deadline - performance.now() <= 0) {
      throw new Error(`[sessionStore] timed out waiting for lock ${lockPath}`)
    }
    if (retireStaleLock(lockPath)) continue
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      throw new Error(`[sessionStore] timed out waiting for lock ${lockPath}`)
    }
    sleepSync(Math.min(LOCK_RETRY_MS, remaining))
  }
}

function releaseLock(lock: StoreLock): void {
  try {
    if (readFileSync(lock.path, "utf8") !== lock.token) {
      console.error("[sessionStore] lock ownership changed before release")
      return
    }
    unlinkSync(lock.path)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== "ENOENT") {
      console.error("[sessionStore] lock release failed:", err.message)
    }
  }
}

/** Override for testing — avoids env var race when test files run in parallel */
let sessionDirOverride: string | null = null

/** Set an explicit session store directory. Takes priority over env var.
 *  Pass null to clear. For testing only. The legacy options parameter remains
 *  accepted for compatibility, but transactions are always locked. */
export function setSessionStoreDir(dir: string | null, _opts?: { skipLocking?: boolean }): void {
  sessionDirOverride = dir
}

/** Return the directory containing the cross-process session store. */
export function getSessionStoreDir(): string {
  return sessionDirOverride
    || process.env.MERIDIAN_SESSION_DIR
    || process.env.CLAUDE_PROXY_SESSION_DIR
    || getDefaultCacheDir()
}

function getStorePath(): string {
  const dir = getSessionStoreDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  chmodSync(dir, 0o700)
  return join(dir, "sessions.json")
}

/**
 * Resolve the default cache directory, auto-migrating from the old name.
 * If ~/.cache/opencode-claude-max-proxy exists but ~/.cache/meridian does not,
 * creates a symlink so sessions are preserved without user action.
 */
function getDefaultCacheDir(): string {
  const newDir = join(homedir(), ".cache", "meridian")
  const oldDir = join(homedir(), ".cache", "opencode-claude-max-proxy")

  // Already using the new directory
  if (existsSync(newDir)) return newDir

  // Old directory exists — create symlink for seamless migration
  if (existsSync(oldDir)) {
    try {
      const { symlinkSync } = require("fs")
      symlinkSync(oldDir, newDir)
    } catch {
      // Symlink failed (permissions, already exists race, etc.) — fall back to old dir
      return oldDir
    }
    return newDir
  }

  // Neither exists — use new name
  return newDir
}

function isTranscriptLocator(value: unknown, expectedSessionId: string): value is TranscriptLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const locator = value as Record<string, unknown>
  return locator.sessionId === expectedSessionId
    && typeof locator.configDir === "string"
    && isAbsolute(locator.configDir)
    && (locator.projectDir === undefined
      || (typeof locator.projectDir === "string" && isAbsolute(locator.projectDir)))
    && (locator.lifecycleGeneration === undefined
      || (typeof locator.lifecycleGeneration === "string" && locator.lifecycleGeneration.length > 0))
}

function validateStoredSession(key: string, value: unknown): asserts value is StoredSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`session store entry ${JSON.stringify(key)} must be an object`)
  }
  const entry = value as Record<string, unknown>
  if (typeof entry.claudeSessionId !== "string" || entry.claudeSessionId.length === 0) {
    throw new Error(`session store entry ${JSON.stringify(key)} has an invalid Claude session ID`)
  }
  if (entry.revision !== undefined && (
    typeof entry.revision !== "number" || !Number.isInteger(entry.revision) || entry.revision < 1
  )) throw new Error(`session store entry ${JSON.stringify(key)} has invalid revision`)
  if (entry.generationId !== undefined && (
    typeof entry.generationId !== "string" || entry.generationId.length === 0
  )) throw new Error(`session store entry ${JSON.stringify(key)} has invalid generationId`)
  for (const field of ["createdAt", "lastUsedAt", "messageCount"] as const) {
    if (typeof entry[field] !== "number" || !Number.isFinite(entry[field]) || entry[field] < 0) {
      throw new Error(`session store entry ${JSON.stringify(key)} has invalid ${field}`)
    }
  }
  if (entry.lineageHash !== undefined && typeof entry.lineageHash !== "string") {
    throw new Error(`session store entry ${JSON.stringify(key)} has invalid lineageHash`)
  }
  const stringArrays = ["messageHashes", "passthroughToolCallIds"] as const
  for (const field of stringArrays) {
    const item = entry[field]
    if (item !== undefined && (!Array.isArray(item) || item.some((part) => typeof part !== "string"))) {
      throw new Error(`session store entry ${JSON.stringify(key)} has invalid ${field}`)
    }
  }
  if (entry.sdkMessageUuids !== undefined && (
    !Array.isArray(entry.sdkMessageUuids)
    || entry.sdkMessageUuids.some((part) => part !== null && typeof part !== "string")
  )) throw new Error(`session store entry ${JSON.stringify(key)} has invalid sdkMessageUuids`)
  if (entry.passthroughToolCallAssistantUuid !== undefined
    && typeof entry.passthroughToolCallAssistantUuid !== "string") {
    throw new Error(`session store entry ${JSON.stringify(key)} has invalid passthrough UUID`)
  }
  if (entry.previousClaudeSessionId !== undefined && typeof entry.previousClaudeSessionId !== "string") {
    throw new Error(`session store entry ${JSON.stringify(key)} has invalid previous Claude session ID`)
  }
  if (entry.currentTranscript !== undefined
    && !isTranscriptLocator(entry.currentTranscript, entry.claudeSessionId)) {
    throw new Error(`session store entry ${JSON.stringify(key)} has invalid current transcript locator`)
  }
  if (entry.previousTranscript !== undefined) {
    if (typeof entry.previousClaudeSessionId !== "string"
      || !isTranscriptLocator(entry.previousTranscript, entry.previousClaudeSessionId)) {
      throw new Error(`session store entry ${JSON.stringify(key)} has invalid previous transcript locator`)
    }
  }
}

function validatePriorityAssignment(routeKey: string, value: unknown): DurablePriorityAssignment {
  if (!routeKey || routeKey.length > 512 || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} is invalid`)
  }
  const assignment = value as Record<string, unknown>
  if (typeof assignment.profileId !== "string" || !assignment.profileId || assignment.profileId.length > 128) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid profileId`)
  }
  if (typeof assignment.lastHumanTurnDigest !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(assignment.lastHumanTurnDigest)) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid human-turn digest`)
  }
  if (typeof assignment.mappingKey !== "string" || !assignment.mappingKey || assignment.mappingKey.length > 1_024) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid mappingKey`)
  }
  if (typeof assignment.mappingGeneration !== "string" || !assignment.mappingGeneration || assignment.mappingGeneration.length > 256) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid mapping generation`)
  }
  if (typeof assignment.generationId !== "string" || !assignment.generationId || assignment.generationId.length > 128) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid generationId`)
  }
  if (typeof assignment.updatedAt !== "number" || !Number.isFinite(assignment.updatedAt) || assignment.updatedAt < 0) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid updatedAt`)
  }
  return {
    profileId: assignment.profileId,
    lastHumanTurnDigest: assignment.lastHumanTurnDigest,
    mappingKey: assignment.mappingKey,
    mappingGeneration: assignment.mappingGeneration,
    generationId: assignment.generationId,
    updatedAt: assignment.updatedAt,
  }
}

function emptyStoreDocument(): SessionStoreDocument {
  return { sessions: {}, meta: { version: STORE_META_VERSION, slots: {} } }
}

function validateStoreMeta(value: unknown): SessionStoreMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("session store metadata must be an object")
  }
  const meta = value as { version?: unknown; slots?: unknown; priorityAssignments?: unknown }
  if (
    (meta.version !== STORE_META_VERSION && meta.version !== PRIORITY_STORE_META_VERSION)
    || typeof meta.slots !== "object"
    || meta.slots === null
    || Array.isArray(meta.slots)
  ) {
    throw new Error("session store metadata has an unsupported format")
  }
  for (const [slot, counter] of Object.entries(meta.slots)) {
    if (!/^[0-9a-f]{4}$/.test(slot) || typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 0) {
      throw new Error(`session store metadata has invalid generation slot ${JSON.stringify(slot)}`)
    }
  }
  const slots = { ...(meta.slots as Record<string, number>) }
  if (meta.version === STORE_META_VERSION) {
    if (meta.priorityAssignments !== undefined) {
      throw new Error("session store v1 metadata cannot contain priority assignments")
    }
    return { version: STORE_META_VERSION, slots }
  }
  if (
    typeof meta.priorityAssignments !== "object"
    || meta.priorityAssignments === null
    || Array.isArray(meta.priorityAssignments)
  ) throw new Error("session store v2 metadata has invalid priority assignments")
  const priorityAssignments: Record<string, DurablePriorityAssignment> = {}
  for (const [routeKey, assignment] of Object.entries(meta.priorityAssignments)) {
    priorityAssignments[routeKey] = validatePriorityAssignment(routeKey, assignment)
  }
  return { version: PRIORITY_STORE_META_VERSION, slots, priorityAssignments }
}

function readStoreDocumentStrict(path: string): SessionStoreDocument {
  let data: string
  try {
    data = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStoreDocument()
    throw error
  }

  const parsed: unknown = JSON.parse(data)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("session store must contain a JSON object")
  }
  const sessions: Record<string, StoredSession> = {}
  let meta: SessionStoreMeta = { version: STORE_META_VERSION, slots: {} }
  for (const [key, value] of Object.entries(parsed)) {
    if (key === STORE_META_KEY) {
      meta = validateStoreMeta(value)
      continue
    }
    validateStoredSession(key, value)
    sessions[key] = value as StoredSession
  }
  return { sessions, meta }
}

function readStoreStrict(path: string): Record<string, StoredSession> {
  return readStoreDocumentStrict(path).sessions
}

/** Read a strict, coherent snapshot for maintenance tasks such as session GC.
 *  Unlike lookup helpers, malformed JSON and I/O errors are propagated. */
export function readSessionStoreSnapshot(): Record<string, StoredSession> {
  return readStoreStrict(getStorePath())
}

/** Capture exact durable generations for one adapter session across profile keys. */
export function readSessionStoreGenerationSnapshot(
  adapterSessionId: string,
  profileIds: readonly string[] = [],
): Record<string, StoredSessionGeneration> {
  const document = readStoreDocumentStrict(getStorePath())
  const keys = new Set(Object.keys(document.sessions).filter((key) =>
    key === adapterSessionId || key.endsWith(`:${adapterSessionId}`)))
  keys.add(adapterSessionId)
  // Profile selection happens after the cross-process turn lease is acquired.
  // Snapshot every configured profile's absent generation now so a mapping
  // created while this request waits can be distinguished from durable absence.
  for (const profileId of profileIds) {
    if (profileId && profileId !== "default") keys.add(`${profileId}:${adapterSessionId}`)
  }
  return Object.fromEntries([...keys].map((key) => [
    key,
    keyGeneration(key, document.sessions[key], document.meta),
  ]))
}


function readStore(): Record<string, StoredSession> {
  try {
    return readSessionStoreSnapshot()
  } catch (error) {
    console.error("[sessionStore] read failed:", (error as Error).message)
    return {}
  }
}

function fsyncParentDirectory(path: string): void {
  try {
    syncDirectoryDurablySync(dirname(path))
  } catch (error) {
    // Preserve the store's legacy best-effort parent flush on supported filesystems.
    void error
  }
}

function writeStore(path: string, document: SessionStoreDocument): void {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  let fd: number | undefined
  try {
    fd = openSync(tmp, "wx", 0o600)
    fchmodSync(fd, 0o600)
    const serialized = { [STORE_META_KEY]: document.meta, ...document.sessions }
    writeFileSync(fd, JSON.stringify(serialized, null, 2), "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, path)
    fsyncParentDirectory(path)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch (closeError) {
        console.error("[sessionStore] temp close failed:", (closeError as Error).message)
      }
    }
    try {
      unlinkSync(tmp)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[sessionStore] temp cleanup failed:", (cleanupError as Error).message)
      }
    }
    throw new Error(`[sessionStore] write failed: ${(error as Error).message}`, { cause: error })
  }
}

function mutateStore(mutator: (document: SessionStoreDocument) => boolean): void {
  const path = getStorePath()
  const lock = acquireLock(`${path}.lock`)
  try {
    const document = readStoreDocumentStrict(path)
    if (mutator(document)) writeStore(path, document)
  } finally {
    releaseLock(lock)
  }
}

function hasLegacyUserDenialBoundary(session: StoredSession): boolean {
  const legacy = (session as StoredSession & { passthroughResumeUuid?: unknown }).passthroughResumeUuid
  return typeof legacy === "string" && legacy.length > 0 && !session.passthroughToolCallAssistantUuid
}

export type SharedSessionLookupResult =
  | { status: "found"; session: StoredSession; generation?: StoredSessionGeneration }
  | { status: "missing"; existing?: StoredSession; generation?: StoredSessionGeneration }
  | { status: "error"; error: Error }

/** Distinguish an authoritative absence from a transient/corrupt read. */
export function lookupSharedSessionResult(key: string): SharedSessionLookupResult {
  try {
    const document = readStoreDocumentStrict(getStorePath())
    const session = document.sessions[key]
    const generation = keyGeneration(key, session, document.meta)
    if (!session) return { status: "missing", generation }
    // Versions 1.61.0–1.62.3 stored a user/tool_result UUID even though the SDK's
    // resumeSessionAt accepts assistant UUIDs only. Replaying once is safer than
    // resuming that invalid tail and re-triggering full-history cache churn.
    if (hasLegacyUserDenialBoundary(session)) return { status: "missing", existing: session, generation }
    return { status: "found", session, generation }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    console.error("[sessionStore] read failed:", normalized.message)
    return { status: "error", error: normalized }
  }
}

export function lookupSharedSession(key: string): StoredSession | undefined {
  const result = lookupSharedSessionResult(key)
  return result.status === "found" ? result.session : undefined
}

export type PriorityAssignmentLookupResult =
  | { status: "found"; assignment: DurablePriorityAssignment; generation: PriorityAssignmentGeneration }
  | { status: "missing"; generation: PriorityAssignmentGeneration }
  | { status: "error"; error: Error }

/** Read one exact durable route. V1 documents authoritatively contain none. */
export function lookupPriorityAssignmentResult(routeKey: string): PriorityAssignmentLookupResult {
  try {
    const document = readStoreDocumentStrict(getStorePath())
    const assignment = document.meta.version === PRIORITY_STORE_META_VERSION
      ? document.meta.priorityAssignments[routeKey]
      : undefined
    const generation = priorityAssignmentGeneration(routeKey, assignment, document.meta)
    return assignment
      ? { status: "found", assignment, generation }
      : { status: "missing", generation }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    console.error("[sessionStore] priority route read failed:", normalized.message)
    return { status: "error", error: normalized }
  }
}

export function lookupSharedSessionByClaudeIdResult(claudeSessionId: string): SharedSessionLookupResult {
  try {
    const document = readStoreDocumentStrict(getStorePath())
    let newest: StoredSession | undefined
    let newestKey: string | undefined
    for (const [key, session] of Object.entries(document.sessions)) {
      if (session.claudeSessionId !== claudeSessionId || hasLegacyUserDenialBoundary(session)) continue
      if (!newest || session.lastUsedAt > newest.lastUsedAt) {
        newest = session
        newestKey = key
      }
    }
    return newest && newestKey
      ? { status: "found", session: newest, generation: getStoredSessionGeneration(newest, newestKey) }
      : { status: "missing" }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    console.error("[sessionStore] read failed:", normalized.message)
    return { status: "error", error: normalized }
  }
}

export function lookupSharedSessionByClaudeId(claudeSessionId: string): StoredSession | undefined {
  const result = lookupSharedSessionByClaudeIdResult(claudeSessionId)
  return result.status === "found" ? result.session : undefined
}

function validateTranscriptLocator(locator: TranscriptLocator, claudeSessionId: string): void {
  if (locator.sessionId !== claudeSessionId) {
    throw new Error("currentTranscript.sessionId must match claudeSessionId")
  }
  if (!isAbsolute(locator.configDir)) {
    throw new Error("currentTranscript.configDir must be an absolute path")
  }
  if (locator.projectDir !== undefined && !isAbsolute(locator.projectDir)) {
    throw new Error("currentTranscript.projectDir must be an absolute path")
  }
  if (locator.lifecycleGeneration !== undefined
    && (typeof locator.lifecycleGeneration !== "string" || locator.lifecycleGeneration.length === 0)) {
    throw new Error("currentTranscript.lifecycleGeneration must be non-empty")
  }
}

export function storeSharedSession(
  key: string,
  claudeSessionId: string,
  messageCount?: number,
  lineageHash?: string,
  messageHashes?: string[],
  sdkMessageUuids?: Array<string | null>,
  contextUsage?: TokenUsage,
  messageBlockHashes?: string[][],
  passthroughToolCallAssistantUuid?: string | null,
  passthroughToolCallIds?: string[] | null,
  currentTranscript?: TranscriptLocator,
  sourceTranscript?: TranscriptLocator,
  expectedGeneration?: StoredSessionGeneration | null,
): StoredSessionGeneration | false {
  if (currentTranscript !== undefined) {
    validateTranscriptLocator(currentTranscript, claudeSessionId)
  }
  if (sourceTranscript !== undefined) {
    if (!isAbsolute(sourceTranscript.configDir)) {
      throw new Error("sourceTranscript.configDir must be an absolute path")
    }
    if (sourceTranscript.projectDir !== undefined && !isAbsolute(sourceTranscript.projectDir)) {
      throw new Error("sourceTranscript.projectDir must be an absolute path")
    }
  }

  let storedGeneration: StoredSessionGeneration | false = false
  mutateStore(({ sessions: store, meta }) => {
    const existing = store[key]
    if (expectedGeneration !== undefined) {
      const actual = keyGeneration(key, existing, meta)
      const expected = expectedGeneration === null
        ? `a:${keyDigest(key)}:0`
        : expectedGeneration
      if (actual !== expected) return false
    }
    // Preserve the previous Claude session ID when the mapping changes.
    // This enables recovery when a lineage bug causes the original session
    // to be abandoned — the old ID still identifies the full conversation
    // through the supported Agent SDK session APIs.
    const sessionIdChanged = existing !== undefined && existing.claudeSessionId !== claudeSessionId
    if (sourceTranscript !== undefined) {
      if (!sessionIdChanged || sourceTranscript.sessionId !== existing?.claudeSessionId) {
        throw new Error("sourceTranscript.sessionId must match the replaced claudeSessionId")
      }
    }
    const previousClaudeSessionId = sessionIdChanged
      ? existing.claudeSessionId
      : existing?.previousClaudeSessionId
    const resolvedCurrentTranscript = sessionIdChanged
      ? currentTranscript
      : existing?.currentTranscript ?? currentTranscript
    const previousTranscript = sessionIdChanged
      ? existing?.currentTranscript ?? sourceTranscript
      : existing?.previousTranscript
    store[key] = {
      claudeSessionId,
      revision: (existing?.revision ?? 0) + 1,
      generationId: randomUUID(),
      createdAt: existing?.createdAt || Date.now(),
      lastUsedAt: Date.now(),
      messageCount: messageCount ?? existing?.messageCount ?? 0,
      lineageHash: lineageHash ?? existing?.lineageHash,
      messageHashes: messageHashes ?? existing?.messageHashes,
      messageBlockHashes: messageBlockHashes ?? existing?.messageBlockHashes,
      sdkMessageUuids: sdkMessageUuids ?? existing?.sdkMessageUuids,
      passthroughToolCallAssistantUuid: passthroughToolCallAssistantUuid === undefined
        ? existing?.passthroughToolCallAssistantUuid
        : passthroughToolCallAssistantUuid ?? undefined,
      passthroughToolCallIds: passthroughToolCallIds === undefined
        ? existing?.passthroughToolCallIds
        : passthroughToolCallIds ?? undefined,
      contextUsage: contextUsage ?? existing?.contextUsage,
      ...(resolvedCurrentTranscript ? { currentTranscript: resolvedCurrentTranscript } : {}),
      ...(previousTranscript ? { previousTranscript } : {}),
      ...(previousClaudeSessionId ? { previousClaudeSessionId } : {}),
    }

    // Prune oldest entries if over capacity (count-based, not time-based).
    // This runs inside the same transaction as the insertion.
    const maxEntries = getMaxStoredSessionsLimit()
    const keys = Object.keys(store)
    if (keys.length > maxEntries) {
      const sorted = keys
        .filter((candidate) => candidate !== key)
        .sort((a, b) => (store[a]!.lastUsedAt || 0) - (store[b]!.lastUsedAt || 0))
      const toRemove = sorted.slice(0, keys.length - maxEntries)
      for (const candidate of toRemove) delete store[candidate]
    }
    advanceKeySlot(key, meta)
    storedGeneration = getStoredSessionGeneration(store[key]!, key)
    return true
  })
  return storedGeneration
}

export interface SharedSessionPriorityPublication {
  routeKey: string
  profileId: string
  lastHumanTurnDigest: string
  expectedAssignmentGeneration: PriorityAssignmentGeneration
}

export interface SharedSessionAndPriorityAssignmentOptions {
  key: string
  claudeSessionId: string
  messageCount: number
  lineageHash: string
  messageHashes: string[]
  sdkMessageUuids?: Array<string | null>
  contextUsage?: TokenUsage
  messageBlockHashes: string[][]
  passthroughToolCallAssistantUuid?: string | null
  passthroughToolCallIds?: string[] | null
  currentTranscript?: TranscriptLocator
  sourceTranscript?: TranscriptLocator
  expectedMappingGeneration: StoredSessionGeneration
  priority: SharedSessionPriorityPublication
}

export interface SharedSessionAndPriorityAssignmentResult {
  mappingGeneration: StoredSessionGeneration
  assignmentGeneration: PriorityAssignmentGeneration
  previousMapping: StoredSession | null
  previousAssignment: DurablePriorityAssignment | null
}

function validatePriorityPublicationInput(options: SharedSessionAndPriorityAssignmentOptions): void {
  if (!options.key || options.key.length > 1_024) throw new Error("priority publication requires a bounded mapping key")
  if (!options.priority.routeKey || options.priority.routeKey.length > 512) {
    throw new Error("priority publication requires a bounded route key")
  }
  if (!options.priority.profileId || options.priority.profileId.length > 128) {
    throw new Error("priority publication requires a bounded profile ID")
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(options.priority.lastHumanTurnDigest)) {
    throw new Error("priority publication requires a valid human-turn digest")
  }
  if (options.currentTranscript !== undefined) validateTranscriptLocator(options.currentTranscript, options.claudeSessionId)
  if (options.sourceTranscript !== undefined) {
    if (!isAbsolute(options.sourceTranscript.configDir)) {
      throw new Error("sourceTranscript.configDir must be an absolute path")
    }
    if (options.sourceTranscript.projectDir !== undefined && !isAbsolute(options.sourceTranscript.projectDir)) {
      throw new Error("sourceTranscript.projectDir must be an absolute path")
    }
  }
}

/**
 * Publish one session mapping and its selected priority route as one locked,
 * durable compare-and-swap. A v1 document upgrades only when this transaction
 * wins; all ordinary mapping writes preserve either input version.
 */
export function storeSharedSessionAndPriorityAssignment(
  options: SharedSessionAndPriorityAssignmentOptions,
): SharedSessionAndPriorityAssignmentResult | false {
  validatePriorityPublicationInput(options)
  let result: SharedSessionAndPriorityAssignmentResult | false = false
  mutateStore((document) => {
    const existing = document.sessions[options.key]
    const actualMappingGeneration = keyGeneration(options.key, existing, document.meta)
    if (actualMappingGeneration !== options.expectedMappingGeneration) return false

    const existingAssignments = document.meta.version === PRIORITY_STORE_META_VERSION
      ? document.meta.priorityAssignments
      : {}
    const existingAssignment = existingAssignments[options.priority.routeKey]
    const actualAssignmentGeneration = priorityAssignmentGeneration(
      options.priority.routeKey,
      existingAssignment,
      document.meta,
    )
    if (actualAssignmentGeneration !== options.priority.expectedAssignmentGeneration) return false

    const sessionIdChanged = existing !== undefined && existing.claudeSessionId !== options.claudeSessionId
    if (options.sourceTranscript !== undefined) {
      if (!sessionIdChanged || options.sourceTranscript.sessionId !== existing?.claudeSessionId) {
        throw new Error("sourceTranscript.sessionId must match the replaced claudeSessionId")
      }
    }
    const previousClaudeSessionId = sessionIdChanged
      ? existing.claudeSessionId
      : existing?.previousClaudeSessionId
    const resolvedCurrentTranscript = sessionIdChanged
      ? options.currentTranscript
      : existing?.currentTranscript ?? options.currentTranscript
    const previousTranscript = sessionIdChanged
      ? existing?.currentTranscript ?? options.sourceTranscript
      : existing?.previousTranscript
    const stored: StoredSession = {
      claudeSessionId: options.claudeSessionId,
      revision: (existing?.revision ?? 0) + 1,
      generationId: randomUUID(),
      createdAt: existing?.createdAt || Date.now(),
      lastUsedAt: Date.now(),
      messageCount: options.messageCount,
      lineageHash: options.lineageHash,
      messageHashes: options.messageHashes,
      messageBlockHashes: options.messageBlockHashes,
      sdkMessageUuids: options.sdkMessageUuids,
      passthroughToolCallAssistantUuid: options.passthroughToolCallAssistantUuid ?? undefined,
      passthroughToolCallIds: options.passthroughToolCallIds ?? undefined,
      contextUsage: options.contextUsage,
      ...(resolvedCurrentTranscript ? { currentTranscript: resolvedCurrentTranscript } : {}),
      ...(previousTranscript ? { previousTranscript } : {}),
      ...(previousClaudeSessionId ? { previousClaudeSessionId } : {}),
    }
    document.sessions[options.key] = stored
    advanceKeySlot(options.key, document.meta)
    const mappingGeneration = getStoredSessionGeneration(stored, options.key)

    if (document.meta.version === STORE_META_VERSION) {
      document.meta = {
        version: PRIORITY_STORE_META_VERSION,
        slots: document.meta.slots,
        priorityAssignments: {},
      }
    }
    const assignment: DurablePriorityAssignment = {
      profileId: options.priority.profileId,
      lastHumanTurnDigest: options.priority.lastHumanTurnDigest,
      mappingKey: options.key,
      mappingGeneration,
      generationId: randomUUID(),
      updatedAt: Date.now(),
    }
    document.meta.priorityAssignments[options.priority.routeKey] = assignment
    advanceKeySlot(priorityGenerationKey(options.priority.routeKey), document.meta)

    const maxSessions = getMaxStoredSessionsLimit()
    const sessionKeys = Object.keys(document.sessions)
    if (sessionKeys.length > maxSessions) {
      const sorted = sessionKeys
        .filter((candidate) => candidate !== options.key)
        .sort((left, right) => document.sessions[left]!.lastUsedAt - document.sessions[right]!.lastUsedAt)
      for (const candidate of sorted.slice(0, sessionKeys.length - maxSessions)) {
        delete document.sessions[candidate]
        advanceKeySlot(candidate, document.meta)
      }
    }

    const maxAssignments = getMaxPriorityAssignmentsLimit()
    const routeKeys = Object.keys(document.meta.priorityAssignments)
    if (routeKeys.length > maxAssignments) {
      const sorted = routeKeys
        .filter((candidate) => candidate !== options.priority.routeKey)
        .sort((left, right) => (
          document.meta.version === PRIORITY_STORE_META_VERSION
            ? document.meta.priorityAssignments[left]!.updatedAt - document.meta.priorityAssignments[right]!.updatedAt
            : 0
        ))
      for (const candidate of sorted.slice(0, routeKeys.length - maxAssignments)) {
        delete document.meta.priorityAssignments[candidate]
        advanceKeySlot(priorityGenerationKey(candidate), document.meta)
      }
    }

    result = {
      mappingGeneration,
      assignmentGeneration: getPriorityAssignmentGeneration(assignment, options.priority.routeKey),
      previousMapping: existing ? structuredClone(existing) : null,
      previousAssignment: existingAssignment ? structuredClone(existingAssignment) : null,
    }
    return true
  })
  return result
}

export interface RollbackSharedSessionAndPriorityAssignmentOptions {
  key: string
  routeKey: string
  expectedMappingGeneration: StoredSessionGeneration
  expectedAssignmentGeneration: PriorityAssignmentGeneration
  previousMapping: StoredSession | null
  previousAssignment: DurablePriorityAssignment | null
}

export interface RollbackSharedSessionAndPriorityAssignmentResult {
  mappingGeneration: StoredSessionGeneration
  assignmentGeneration: PriorityAssignmentGeneration
  restoredMapping: StoredSession | null
  restoredAssignment: DurablePriorityAssignment | null
}

/** Restore the exact pre-request authorities after a canceled late publication. */
export function rollbackSharedSessionAndPriorityAssignment(
  options: RollbackSharedSessionAndPriorityAssignmentOptions,
): RollbackSharedSessionAndPriorityAssignmentResult | false {
  let result: RollbackSharedSessionAndPriorityAssignmentResult | false = false
  mutateStore((document) => {
    if (document.meta.version !== PRIORITY_STORE_META_VERSION) return false
    const currentMapping = document.sessions[options.key]
    if (keyGeneration(options.key, currentMapping, document.meta) !== options.expectedMappingGeneration) return false
    const currentAssignment = document.meta.priorityAssignments[options.routeKey]
    if (
      priorityAssignmentGeneration(options.routeKey, currentAssignment, document.meta)
      !== options.expectedAssignmentGeneration
    ) return false

    let restoredMapping: StoredSession | null = null
    if (options.previousMapping) {
      restoredMapping = {
        ...structuredClone(options.previousMapping),
        revision: (options.previousMapping.revision ?? 0) + 1,
        generationId: randomUUID(),
      }
      document.sessions[options.key] = restoredMapping
    } else {
      delete document.sessions[options.key]
    }
    advanceKeySlot(options.key, document.meta)
    const mappingGeneration = keyGeneration(options.key, restoredMapping ?? undefined, document.meta)

    let restoredAssignment: DurablePriorityAssignment | null = null
    if (options.previousAssignment) {
      restoredAssignment = {
        ...structuredClone(options.previousAssignment),
        mappingGeneration: options.previousAssignment.mappingKey === options.key
          ? mappingGeneration
          : options.previousAssignment.mappingGeneration,
        generationId: randomUUID(),
        updatedAt: Date.now(),
      }
      document.meta.priorityAssignments[options.routeKey] = restoredAssignment
    } else {
      delete document.meta.priorityAssignments[options.routeKey]
    }
    advanceKeySlot(priorityGenerationKey(options.routeKey), document.meta)
    const assignmentGeneration = priorityAssignmentGeneration(
      options.routeKey,
      restoredAssignment ?? undefined,
      document.meta,
    )
    result = {
      mappingGeneration,
      assignmentGeneration,
      restoredMapping,
      restoredAssignment,
    }
    return true
  })
  return result
}

function sameTranscriptLocator(left: TranscriptLocator | undefined, right: TranscriptLocator): boolean {
  return left?.sessionId === right.sessionId
    && left.configDir === right.configDir
    && left.projectDir === right.projectDir
    && left.lifecycleGeneration === right.lifecycleGeneration
}

/** Attach an exact transcript locator without changing lineage or SDK identity.
 * The durable revision advances so concurrent readers cannot miss the mutation. */
export function attachSharedTranscriptLocator(
  key: string,
  expectedClaudeSessionId: string,
  locator: TranscriptLocator,
  expectedGeneration?: StoredSessionGeneration,
): StoredSessionGeneration | false {
  validateTranscriptLocator(locator, expectedClaudeSessionId)
  let attachedGeneration: StoredSessionGeneration | false = false
  mutateStore(({ sessions: store, meta }) => {
    const existing = store[key]
    if (!existing || existing.claudeSessionId !== expectedClaudeSessionId) return false
    if (expectedGeneration !== undefined && getStoredSessionGeneration(existing, key) !== expectedGeneration) return false
    if (!sameTranscriptLocator(existing.currentTranscript, locator)) {
      existing.currentTranscript = locator
      existing.revision = (existing.revision ?? 0) + 1
      existing.generationId = randomUUID()
      advanceKeySlot(key, meta)
    }
    attachedGeneration = getStoredSessionGeneration(existing, key)
    return true
  })
  return attachedGeneration
}

/** Ensure a single session is absent from the shared file store.
 *  Used when a session is detected as stale (e.g. expired upstream).
 *  Absence is an idempotent success; false is reserved for a present mapping
 *  whose exact expected generation no longer matches. */
export function evictSharedSession(
  key: string,
  expectedGeneration?: StoredSessionGeneration,
): boolean {
  let evicted = false
  mutateStore(({ sessions: store, meta }) => {
    const existing = store[key]
    if (!existing) {
      evicted = true
      return false
    }
    if (expectedGeneration !== undefined && getStoredSessionGeneration(existing, key) !== expectedGeneration) return false
    delete store[key]
    advanceKeySlot(key, meta)
    evicted = true
    return true
  })
  return evicted
}

/** Look up recovery information for a session key.
 *  Returns the current and previous Claude session IDs, plus derived
 *  file paths and CLI commands for conversation recovery. */
export function lookupSessionRecovery(key: string): {
  claudeSessionId: string
  previousClaudeSessionId?: string
  createdAt: number
  lastUsedAt: number
  messageCount: number
} | undefined {
  const store = readStore()
  const session = store[key]
  if (!session) return undefined
  return {
    claudeSessionId: session.claudeSessionId,
    previousClaudeSessionId: session.previousClaudeSessionId,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    messageCount: session.messageCount,
  }
}

/** List all stored session keys and their Claude session IDs.
 *  Used by the recovery endpoint to find sessions by partial match. */
export function listStoredSessions(): Array<{
  key: string
  claudeSessionId: string
  previousClaudeSessionId?: string
  createdAt: number
  lastUsedAt: number
  messageCount: number
}> {
  const store = readStore()
  return Object.entries(store).map(([key, session]) => ({
    key,
    claudeSessionId: session.claudeSessionId,
    previousClaudeSessionId: session.previousClaudeSessionId,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    messageCount: session.messageCount,
  }))
}

export function clearSharedSessions(): void {
  mutateStore(({ sessions: store, meta }) => {
    for (const key of Object.keys(store)) {
      delete store[key]
      advanceKeySlot(key, meta)
    }
    if (meta.version === PRIORITY_STORE_META_VERSION) {
      for (const routeKey of Object.keys(meta.priorityAssignments)) {
        delete meta.priorityAssignments[routeKey]
        advanceKeySlot(priorityGenerationKey(routeKey), meta)
      }
    }
    return true
  })
}
