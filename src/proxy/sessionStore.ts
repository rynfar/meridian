/**
 * Shared session store for cross-proxy session resume.
 *
 * When running per-terminal proxies (each on a different port),
 * sessions need to be shared so you can resume a conversation
 * started in one terminal from another. Every proxy instance reads
 * and writes one SQLite database in the store directory, one row per
 * mapping (see session/storeDatabase.ts).
 *
 * Keys are either OpenCode session IDs or conversation fingerprints.
 * Earlier versions kept the whole store in sessions.json; the first
 * open of a directory imports that file once and renames it aside.
 */

import { existsSync, readFileSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import type { TokenUsage } from "./session/lineage"
import {
  fileDigest,
  getStoreLockWaitMs,
  openStoreDatabase,
  peekStoreDatabase,
  retireImportedFile,
  type StoreDatabase,
  type WriteOp,
} from "./session/storeDatabase"

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
const PRIORITY_STORE_META_VERSION = 3

export interface DurablePriorityAssignment {
  profileId: string
  lastHumanTurnDigest: string
  /** Monotonic signed issue-time high-water mark for replay suppression. */
  lastHumanTurnIssuedAt: number
  mappingKey: string
  /** Exact mapping generation published atomically with this route. */
  mappingGeneration: StoredSessionGeneration
  /** Unique route publication token. Replaced on every route mutation. */
  generationId: string
  updatedAt: number
}

export type PriorityAssignmentGeneration = string

export interface DurablePriorityAttempt {
  /** A prior exposed or crashed attempt blocks untrusted/same-turn replay. */
  blocked: boolean
  blockedTurnDigest: string | null
  blockedTurnIssuedAt: number | null
  /** One exact in-flight request owns publication/release for this route. */
  pendingTurnDigest: string | null
  pendingTurnIssuedAt: number | null
  ownerToken: string | null
  generationId: string
  updatedAt: number
}

interface SessionStoreMetaV1 {
  version: 1
  /** Fixed hash slots fence absent-key create/delete ABA without unbounded tombstones. */
  slots: Record<string, number>
}

interface DurablePriorityRollbackMapping {
  mappingKey: string
  /** Exact fallback generation protected until terminal finalization/rollback. */
  mappingGeneration: StoredSessionGeneration
}

interface SessionStoreMetaV2 {
  version: 3
  /** Shared fixed slots fence both mapping and namespaced route ABA. */
  slots: Record<string, number>
  priorityAssignments: Record<string, DurablePriorityAssignment>
  /** Durable request claims block cross-request replay after committed exposure. */
  priorityAttempts: Record<string, DurablePriorityAttempt>
  /** Previous routed mappings retained only until terminal finalization/rollback. */
  priorityRollbackMappings: Record<string, DurablePriorityRollbackMapping>
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
const DEFAULT_MAX_PRIORITY_ATTEMPTS = 5_000

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

export function getMaxPriorityAttemptsLimit(): number {
  const raw = process.env.MERIDIAN_MAX_PRIORITY_ATTEMPTS
  if (!raw) return DEFAULT_MAX_PRIORITY_ATTEMPTS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_PRIORITY_ATTEMPTS
  return parsed
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

function hasExactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function validatePriorityAssignment(routeKey: string, value: unknown): DurablePriorityAssignment {
  if (!routeKey || routeKey.length > 512 || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} is invalid`)
  }
  const assignment = value as Record<string, unknown>
  if (!hasExactObjectKeys(assignment, [
    "profileId",
    "lastHumanTurnDigest",
    "lastHumanTurnIssuedAt",
    "mappingKey",
    "mappingGeneration",
    "generationId",
    "updatedAt",
  ])) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has unknown or missing fields`)
  }
  if (typeof assignment.profileId !== "string" || !assignment.profileId || assignment.profileId.length > 128) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid profileId`)
  }
  if (typeof assignment.lastHumanTurnDigest !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(assignment.lastHumanTurnDigest)) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid human-turn digest`)
  }
  if (
    typeof assignment.lastHumanTurnIssuedAt !== "number"
    || !Number.isSafeInteger(assignment.lastHumanTurnIssuedAt)
    || assignment.lastHumanTurnIssuedAt < 0
  ) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid human-turn issue time`)
  }
  if (typeof assignment.mappingKey !== "string" || !assignment.mappingKey || assignment.mappingKey.length > 1_024) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid mappingKey`)
  }
  const expectedMappingPrefix = typeof assignment.mappingKey === "string"
    ? `p:${keyDigest(assignment.mappingKey)}:`
    : ""
  if (
    typeof assignment.mappingGeneration !== "string"
    || !assignment.mappingGeneration.startsWith(expectedMappingPrefix)
    || !UUID_PATTERN.test(assignment.mappingGeneration.slice(expectedMappingPrefix.length))
  ) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid mapping generation`)
  }
  if (typeof assignment.generationId !== "string" || !UUID_PATTERN.test(assignment.generationId)) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid generationId`)
  }
  if (
    typeof assignment.updatedAt !== "number"
    || !Number.isSafeInteger(assignment.updatedAt)
    || assignment.updatedAt < 0
  ) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid updatedAt`)
  }
  return {
    profileId: assignment.profileId,
    lastHumanTurnDigest: assignment.lastHumanTurnDigest,
    lastHumanTurnIssuedAt: assignment.lastHumanTurnIssuedAt,
    mappingKey: assignment.mappingKey,
    mappingGeneration: assignment.mappingGeneration,
    generationId: assignment.generationId,
    updatedAt: assignment.updatedAt,
  }
}

function validatePriorityAttempt(routeKey: string, value: unknown): DurablePriorityAttempt {
  if (!routeKey || routeKey.length > 512 || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`session store priority attempt ${JSON.stringify(routeKey)} is invalid`)
  }
  const attempt = value as Record<string, unknown>
  if (!hasExactObjectKeys(attempt, [
    "blocked",
    "blockedTurnDigest",
    "blockedTurnIssuedAt",
    "pendingTurnDigest",
    "pendingTurnIssuedAt",
    "ownerToken",
    "generationId",
    "updatedAt",
  ])) throw new Error(`session store priority attempt ${JSON.stringify(routeKey)} has unknown or missing fields`)
  const validDigest = (digest: unknown): digest is string | null => (
    digest === null || (typeof digest === "string" && /^[A-Za-z0-9_-]{43}$/.test(digest))
  )
  const validIssuedAt = (issuedAt: unknown): issuedAt is number | null => (
    issuedAt === null || (typeof issuedAt === "number" && Number.isSafeInteger(issuedAt) && issuedAt >= 0)
  )
  if (typeof attempt.blocked !== "boolean"
    || !validDigest(attempt.blockedTurnDigest)
    || !validIssuedAt(attempt.blockedTurnIssuedAt)
    || !validDigest(attempt.pendingTurnDigest)
    || !validIssuedAt(attempt.pendingTurnIssuedAt)
    || (attempt.blockedTurnDigest === null) !== (attempt.blockedTurnIssuedAt === null)
    || (attempt.pendingTurnDigest === null) !== (attempt.pendingTurnIssuedAt === null)
    || (attempt.ownerToken !== null && (typeof attempt.ownerToken !== "string" || !UUID_PATTERN.test(attempt.ownerToken)))
    || (attempt.ownerToken === null && attempt.pendingTurnDigest !== null)
    || (!attempt.blocked && attempt.ownerToken === null)) {
    throw new Error(`session store priority attempt ${JSON.stringify(routeKey)} has invalid state`)
  }
  if (typeof attempt.generationId !== "string" || !UUID_PATTERN.test(attempt.generationId)) {
    throw new Error(`session store priority attempt ${JSON.stringify(routeKey)} has invalid generationId`)
  }
  if (typeof attempt.updatedAt !== "number" || !Number.isSafeInteger(attempt.updatedAt) || attempt.updatedAt < 0) {
    throw new Error(`session store priority attempt ${JSON.stringify(routeKey)} has invalid updatedAt`)
  }
  return {
    blocked: attempt.blocked,
    blockedTurnDigest: attempt.blockedTurnDigest,
    blockedTurnIssuedAt: attempt.blockedTurnIssuedAt,
    pendingTurnDigest: attempt.pendingTurnDigest,
    pendingTurnIssuedAt: attempt.pendingTurnIssuedAt,
    ownerToken: attempt.ownerToken,
    generationId: attempt.generationId,
    updatedAt: attempt.updatedAt,
  }
}

function emptyStoreDocument(): SessionStoreDocument {
  return { sessions: {}, meta: { version: STORE_META_VERSION, slots: {} } }
}

function validateStoreMeta(value: unknown): SessionStoreMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("session store metadata must be an object")
  }
  const meta = value as Record<string, unknown> & {
    version?: unknown
    slots?: unknown
    priorityAssignments?: unknown
    priorityAttempts?: unknown
    priorityRollbackMappings?: unknown
  }
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
    if (!hasExactObjectKeys(meta, ["version", "slots"])) {
      throw new Error("session store v1 metadata has unknown or missing fields")
    }
    return { version: STORE_META_VERSION, slots }
  }
  if (!hasExactObjectKeys(meta, ["version", "slots", "priorityAssignments", "priorityAttempts", "priorityRollbackMappings"])) {
    throw new Error("session store v3 metadata has unknown or missing fields")
  }
  if (
    typeof meta.priorityAssignments !== "object"
    || meta.priorityAssignments === null
    || Array.isArray(meta.priorityAssignments)
  ) throw new Error("session store v3 metadata has invalid priority assignments")
  if (
    typeof meta.priorityAttempts !== "object"
    || meta.priorityAttempts === null
    || Array.isArray(meta.priorityAttempts)
  ) throw new Error("session store v3 metadata has invalid priority attempts")
  if (
    typeof meta.priorityRollbackMappings !== "object"
    || meta.priorityRollbackMappings === null
    || Array.isArray(meta.priorityRollbackMappings)
  ) throw new Error("session store v3 metadata has invalid priority rollback mappings")
  const priorityAssignments: Record<string, DurablePriorityAssignment> = {}
  for (const [routeKey, assignment] of Object.entries(meta.priorityAssignments)) {
    priorityAssignments[routeKey] = validatePriorityAssignment(routeKey, assignment)
  }
  const priorityAttempts: Record<string, DurablePriorityAttempt> = {}
  for (const [routeKey, attempt] of Object.entries(meta.priorityAttempts)) {
    priorityAttempts[routeKey] = validatePriorityAttempt(routeKey, attempt)
  }
  const priorityRollbackMappings: Record<string, DurablePriorityRollbackMapping> = {}
  for (const [routeKey, value] of Object.entries(meta.priorityRollbackMappings)) {
    priorityRollbackMappings[routeKey] = validatePriorityRollback(routeKey, value, priorityAssignments)
  }
  return {
    version: PRIORITY_STORE_META_VERSION,
    slots,
    priorityAssignments,
    priorityAttempts,
    priorityRollbackMappings,
  }
}

function validatePriorityRollback(
  routeKey: string,
  value: unknown,
  priorityAssignments: Record<string, DurablePriorityAssignment>,
): DurablePriorityRollbackMapping {
  if (!priorityAssignments[routeKey] || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`session store priority rollback ${JSON.stringify(routeKey)} is invalid`)
  }
  const rollback = value as Record<string, unknown>
  if (
    !hasExactObjectKeys(rollback, ["mappingKey", "mappingGeneration"])
    || typeof rollback.mappingKey !== "string"
    || !rollback.mappingKey
    || rollback.mappingKey.length > 1_024
  ) {
    throw new Error(`session store priority rollback ${JSON.stringify(routeKey)} is invalid`)
  }
  const expectedMappingPrefix = `p:${keyDigest(rollback.mappingKey)}:`
  if (
    typeof rollback.mappingGeneration !== "string"
    || !rollback.mappingGeneration.startsWith(expectedMappingPrefix)
    || !UUID_PATTERN.test(rollback.mappingGeneration.slice(expectedMappingPrefix.length))
  ) {
    throw new Error(`session store priority rollback ${JSON.stringify(routeKey)} has invalid mapping generation`)
  }
  return {
    mappingKey: rollback.mappingKey,
    mappingGeneration: rollback.mappingGeneration,
  }
}

/** Every rollback must retain the exact, distinct mapping it would restore. */
function validateRollbackReferences(sessions: Record<string, StoredSession>, meta: SessionStoreMeta): void {
  if (meta.version !== PRIORITY_STORE_META_VERSION) return
  for (const [routeKey, rollback] of Object.entries(meta.priorityRollbackMappings)) {
    const assignment = meta.priorityAssignments[routeKey]!
    const mapping = sessions[rollback.mappingKey]
    if (!mapping) {
      throw new Error(`session store priority rollback ${JSON.stringify(routeKey)} has no retained mapping`)
    }
    if (rollback.mappingKey === assignment.mappingKey) {
      throw new Error(`session store priority rollback ${JSON.stringify(routeKey)} aliases its current mapping`)
    }
    if (getStoredSessionGeneration(mapping, rollback.mappingKey) !== rollback.mappingGeneration) {
      throw new Error(`session store priority rollback ${JSON.stringify(routeKey)} has a stale mapping generation`)
    }
  }
}

/** Parse and validate a legacy sessions.json document. */
function parseStoreDocument(data: string): SessionStoreDocument {
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
  validateRollbackReferences(sessions, meta)
  return { sessions, meta }
}

const LEGACY_STORE_NAME = "sessions.json"

interface StoreInfoRow {
  seq: number
  meta_version: number
  commit_token: string | null
  imported_json_sha256: string | null
}

interface StoreCache {
  /** The commit sequence the document reflects. Every commit advances it. */
  seq: number
  document: SessionStoreDocument
}

// The store as of the latest commit this process has read. While nothing
// changed, a read costs one lookup of the commit sequence; a commit by another
// process is read incrementally by that sequence. Cached entries are frozen and
// shared with drafts: a mutation replaces the entries it changes, so the diff
// against the cache is exactly what it writes.
const storeCaches = new WeakMap<StoreDatabase, StoreCache>()
// Databases whose directory has been checked for a legacy sessions.json.
const legacyChecked = new WeakSet<StoreDatabase>()
// The last store task queued on each database, settled. The transcript
// lifecycle journal shares the database and its write queue; a request waits
// only for the session store's own writes.
const storeWriteTails = new WeakMap<StoreDatabase, Promise<void>>()

function enqueueStoreTask<T>(database: StoreDatabase, task: () => Promise<T>): Promise<T> {
  const run = database.enqueue(task)
  storeWriteTails.set(database, run.then(() => undefined, () => undefined))
  return run
}

interface PendingImport {
  legacyPath: string
  digest: string
  legacy: SessionStoreDocument
  /** The store as the import will leave it, served to readers until it lands. */
  view: SessionStoreDocument
}

// A sessions.json that has been read but not yet committed to the database.
// Until the import lands the file stays authoritative: readers see its
// contents, and no mutation commits before it.
const pendingImports = new WeakMap<StoreDatabase, PendingImport>()

const UPSERT_SESSION = "INSERT INTO sessions (key, seq, entry) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET seq = excluded.seq, entry = excluded.entry"
const DELETE_SESSION = "DELETE FROM sessions WHERE key = ?"
const UPSERT_SLOT = "INSERT INTO generation_slots (slot, counter) VALUES (?, ?) ON CONFLICT(slot) DO UPDATE SET counter = excluded.counter"
const UPDATE_STORE_INFO = "UPDATE store_info SET seq = ?, meta_version = ?, commit_token = ? WHERE id = 1"
const RECORD_IMPORT = "UPDATE store_info SET imported_json_sha256 = ?, imported_json_at = ? WHERE id = 1"

const PRIORITY_TABLES = {
  priorityAssignments: "priority_assignments",
  priorityAttempts: "priority_attempts",
  priorityRollbackMappings: "priority_rollbacks",
} as const
type PriorityRecordField = keyof typeof PRIORITY_TABLES
const PRIORITY_RECORD_FIELDS = Object.keys(PRIORITY_TABLES) as PriorityRecordField[]

function upsertPriorityRecord(field: PriorityRecordField): string {
  return `INSERT INTO ${PRIORITY_TABLES[field]} (route_key, record) VALUES (?, ?) ON CONFLICT(route_key) DO UPDATE SET record = excluded.record`
}

function deletePriorityRecord(field: PriorityRecordField): string {
  return `DELETE FROM ${PRIORITY_TABLES[field]} WHERE route_key = ?`
}

/** The database of the current store directory, with any legacy file taken in. */
function storeDatabase(): StoreDatabase {
  const database = openStoreDatabase(getSessionStoreDir(), getStoreLockWaitMs())
  if (!legacyChecked.has(database)) {
    checkLegacyStore(database)
    legacyChecked.add(database)
  }
  return database
}

function readStoreInfo(database: StoreDatabase): StoreInfoRow {
  const info = database.get<StoreInfoRow>(
    "SELECT seq, meta_version, commit_token, imported_json_sha256 FROM store_info WHERE id = 1",
  )
  if (!info || !Number.isSafeInteger(info.seq) || info.seq < 0) {
    throw new Error(`session store ${database.path} has no valid store_info row`)
  }
  return info
}

function parseSessionRow(key: string, entry: string): StoredSession {
  const value: unknown = JSON.parse(entry)
  validateStoredSession(key, value)
  return Object.freeze(value)
}

function freezeStoreValue(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return
  // History has hundreds of thousands of small block-hash arrays. Iterate
  // arrays directly instead of allocating another array for every row.
  if (Array.isArray(value)) {
    for (const child of value) freezeStoreValue(child)
  } else {
    for (const child of Object.values(value)) freezeStoreValue(child)
  }
  Object.freeze(value)
}

function freezeSessionForRead(session: StoredSession): StoredSession {
  // Parsed arrays are privately owned until a lookup exposes the entry. Freeze
  // them at that boundary, avoiding a full-store walk for a single cold lookup.
  for (const child of Object.values(session)) freezeStoreValue(child)
  return Object.freeze(session)
}

function loadSlots(database: StoreDatabase): Record<string, number> {
  const slots: Record<string, number> = {}
  for (const row of database.all<{ slot: string; counter: number }>("SELECT slot, counter FROM generation_slots")) {
    if (!/^[0-9a-f]{4}$/.test(row.slot) || !Number.isSafeInteger(row.counter) || row.counter < 0) {
      throw new Error(`session store metadata has invalid generation slot ${JSON.stringify(row.slot)}`)
    }
    slots[row.slot] = row.counter
  }
  return slots
}

function priorityRows(database: StoreDatabase, field: PriorityRecordField): Array<{ route_key: string; record: string }> {
  return database.all<{ route_key: string; record: string }>(`SELECT route_key, record FROM ${PRIORITY_TABLES[field]}`)
}

function loadMeta(database: StoreDatabase, version: number, slots: Record<string, number>): SessionStoreMeta {
  if (version === STORE_META_VERSION) {
    for (const field of PRIORITY_RECORD_FIELDS) {
      if (priorityRows(database, field).length > 0) {
        throw new Error("session store v1 metadata has priority records")
      }
    }
    return { version: STORE_META_VERSION, slots }
  }
  if (version !== PRIORITY_STORE_META_VERSION) {
    throw new Error("session store metadata has an unsupported format")
  }
  const priorityAssignments: Record<string, DurablePriorityAssignment> = {}
  for (const row of priorityRows(database, "priorityAssignments")) {
    priorityAssignments[row.route_key] = validatePriorityAssignment(row.route_key, JSON.parse(row.record))
  }
  const priorityAttempts: Record<string, DurablePriorityAttempt> = {}
  for (const row of priorityRows(database, "priorityAttempts")) {
    priorityAttempts[row.route_key] = validatePriorityAttempt(row.route_key, JSON.parse(row.record))
  }
  const priorityRollbackMappings: Record<string, DurablePriorityRollbackMapping> = {}
  for (const row of priorityRows(database, "priorityRollbackMappings")) {
    priorityRollbackMappings[row.route_key] = validatePriorityRollback(
      row.route_key,
      JSON.parse(row.record),
      priorityAssignments,
    )
  }
  return {
    version: PRIORITY_STORE_META_VERSION,
    slots,
    priorityAssignments,
    priorityAttempts,
    priorityRollbackMappings,
  }
}

function loadStore(database: StoreDatabase, info: StoreInfoRow): StoreCache {
  const sessions: Record<string, StoredSession> = {}
  for (const row of database.all<{ key: string; entry: string }>("SELECT key, entry FROM sessions")) {
    sessions[row.key] = parseSessionRow(row.key, row.entry)
  }
  const meta = loadMeta(database, info.meta_version, loadSlots(database))
  validateRollbackReferences(sessions, meta)
  return { seq: info.seq, document: { sessions, meta } }
}

/** Apply the commits since `cached` without re-reading unchanged entries.
 *  Rows carry the sequence of the commit that last wrote them. */
function catchUpStore(database: StoreDatabase, cached: StoreCache, info: StoreInfoRow): StoreCache {
  const sessions = { ...cached.document.sessions }
  const present = new Set(database.all<{ key: string }>("SELECT key FROM sessions").map((row) => row.key))
  for (const key of Object.keys(sessions)) {
    if (!present.has(key)) delete sessions[key]
  }
  for (const row of database.all<{ key: string; entry: string }>(
    "SELECT key, entry FROM sessions WHERE seq > ?",
    cached.seq,
  )) {
    sessions[row.key] = parseSessionRow(row.key, row.entry)
  }
  const meta = loadMeta(database, info.meta_version, loadSlots(database))
  validateRollbackReferences(sessions, meta)
  return { seq: info.seq, document: { sessions, meta } }
}

/** The cache, brought up to the database's latest commit. */
function freshStoreCache(database: StoreDatabase): StoreCache {
  const cached = storeCaches.get(database)
  if (cached && readStoreInfo(database).seq === cached.seq) return cached
  const fresh = database.snapshot(() => {
    const info = readStoreInfo(database)
    if (cached?.seq === info.seq) return cached
    return cached && cached.seq < info.seq
      ? catchUpStore(database, cached, info)
      : loadStore(database, info)
  })
  storeCaches.set(database, fresh)
  return fresh
}

/** The current store. Callers must treat it as immutable. */
function currentDocument(): SessionStoreDocument {
  const database = storeDatabase()
  return pendingImports.get(database)?.view ?? freshStoreCache(database).document
}

/** Read a strict, coherent snapshot for maintenance tasks such as session GC.
 *  Unlike lookup helpers, a corrupt store and I/O errors are propagated. */
export function readSessionStoreSnapshot(): Record<string, StoredSession> {
  const sessions = currentDocument().sessions
  for (const session of Object.values(sessions)) freezeSessionForRead(session)
  return Object.freeze(sessions)
}

/** Capture exact durable generations for one adapter session across profile keys. */
export function readSessionStoreGenerationSnapshot(
  adapterSessionId: string,
  profileIds: readonly string[] = [],
): Record<string, StoredSessionGeneration> {
  const document = currentDocument()
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

/** A copy of the whole store in the shape sessions.json had: the mappings plus
 *  the metadata under its reserved key. For diagnostics and tests. */
export function readSessionStoreDocument(): Record<string, unknown> {
  const { sessions, meta } = currentDocument()
  const slots: Record<string, number> = {}
  // Draft counters inherit the ones they did not advance.
  for (const slot in meta.slots) slots[slot] = meta.slots[slot]!
  return structuredClone({ [STORE_META_KEY]: { ...meta, slots }, ...sessions })
}

/** Settles, never rejecting, once every store write this process has already
 *  started has landed. Writes started later are not waited for. */
export function sessionStoreWritesSettled(): Promise<void> {
  const database = peekStoreDatabase(getSessionStoreDir())
  return (database && storeWriteTails.get(database)) ?? Promise.resolve()
}

function copyRecords<T extends object>(records: Record<string, T>): Record<string, T> {
  const copy: Record<string, T> = {}
  for (const [key, record] of Object.entries(records)) copy[key] = { ...record }
  return copy
}

/**
 * The document a mutator edits. Entries are shared with the cache, frozen, and
 * replaced by the mutators that change them. Slot counters overlay the cache's
 * through the prototype chain, so the draft's own properties are exactly the
 * counters advanced. Priority records are edited in place, so they are copies.
 */
function draftStoreDocument(base: SessionStoreDocument): SessionStoreDocument {
  const slots = Object.create(base.meta.slots) as Record<string, number>
  const sessions = { ...base.sessions }
  if (base.meta.version === STORE_META_VERSION) {
    return { sessions, meta: { version: STORE_META_VERSION, slots } }
  }
  return {
    sessions,
    meta: {
      version: PRIORITY_STORE_META_VERSION,
      slots,
      priorityAssignments: copyRecords(base.meta.priorityAssignments),
      priorityAttempts: copyRecords(base.meta.priorityAttempts),
      priorityRollbackMappings: copyRecords(base.meta.priorityRollbackMappings),
    },
  }
}

function sameFlatRecord(left: object, right: object): boolean {
  const leftEntries = Object.entries(left)
  if (leftEntries.length !== Object.keys(right).length) return false
  return leftEntries.every(([key, value]) => (right as Record<string, unknown>)[key] === value)
}

function priorityRecords(meta: SessionStoreMeta, field: PriorityRecordField): Record<string, object> {
  return meta.version === PRIORITY_STORE_META_VERSION ? meta[field] : {}
}

/** The statements that turn `base` into `draft`, or none when they are equal. */
function storeChangeOps(
  base: SessionStoreDocument,
  draft: SessionStoreDocument,
  seq: number,
  commitToken: string,
): WriteOp[] {
  const ops: WriteOp[] = []
  for (const [key, entry] of Object.entries(draft.sessions)) {
    if (base.sessions[key] !== entry) ops.push([UPSERT_SESSION, [key, seq, JSON.stringify(entry)]])
  }
  for (const key of Object.keys(base.sessions)) {
    if (!Object.hasOwn(draft.sessions, key)) ops.push([DELETE_SESSION, [key]])
  }
  const slots = draft.meta.slots
  const advanced = Object.getPrototypeOf(slots) === base.meta.slots
    ? Object.keys(slots)
    // A mutator replaced the counters outright: compare every one.
    : Object.keys(slots).filter((slot) => slots[slot] !== base.meta.slots[slot])
  for (const slot of advanced) ops.push([UPSERT_SLOT, [slot, slots[slot]!]])
  for (const field of PRIORITY_RECORD_FIELDS) {
    const before = priorityRecords(base.meta, field)
    const after = priorityRecords(draft.meta, field)
    for (const [routeKey, record] of Object.entries(after)) {
      const previous = before[routeKey]
      if (!previous || !sameFlatRecord(previous, record)) {
        ops.push([upsertPriorityRecord(field), [routeKey, JSON.stringify(record)]])
      }
    }
    for (const routeKey of Object.keys(before)) {
      if (!Object.hasOwn(after, routeKey)) ops.push([deletePriorityRecord(field), [routeKey]])
    }
  }
  if (ops.length === 0 && draft.meta.version === base.meta.version) return ops
  ops.push([UPDATE_STORE_INFO, [seq, draft.meta.version, commitToken]])
  return ops
}

/** The cached document after `draft` committed over `base`. */
function committedDocument(base: SessionStoreDocument, draft: SessionStoreDocument): SessionStoreDocument {
  // The counters only advance. Updating the cached object in place is safe
  // because mutations run one at a time and readers use it synchronously.
  const slots = base.meta.slots
  for (const slot of Object.keys(draft.meta.slots)) slots[slot] = draft.meta.slots[slot]!
  const meta: SessionStoreMeta = draft.meta.version === PRIORITY_STORE_META_VERSION
    ? { ...draft.meta, slots }
    : { version: STORE_META_VERSION, slots }
  return { sessions: draft.sessions, meta }
}

interface StoreCommit {
  base: StoreCache
  draft: SessionStoreDocument
  seq: number
}

async function mutateStore(mutator: (document: SessionStoreDocument) => boolean): Promise<void> {
  const database = storeDatabase()
  const commitToken = randomUUID()
  await enqueueStoreTask(database, async () => {
    const pending = pendingImports.get(database)
    if (pending) await importLegacyStore(database, pending)
    const { committed, result: commit } = await database.transactNow<StoreCommit | undefined>({
      lockWaitMs: getStoreLockWaitMs(),
      build: () => {
        // This process holds the write lock, so the store cannot change while
        // the mutator decides: catch the cache up and draft on top of it.
        const base = freshStoreCache(database)
        const draft = draftStoreDocument(base.document)
        if (!mutator(draft)) return { ops: [], result: undefined }
        // A new entry may still reference caller-owned arrays or usage objects.
        // Own and freeze those values before serializing; otherwise later
        // caller/lookup edits make the cache disagree with the database.
        for (const [key, entry] of Object.entries(draft.sessions)) {
          if (base.document.sessions[key] !== entry && !Object.isFrozen(entry)) {
            const owned = structuredClone(entry)
            freezeStoreValue(owned)
            draft.sessions[key] = owned
          }
        }
        const seq = base.seq + 1
        return { ops: storeChangeOps(base.document, draft, seq, commitToken), result: { base, draft, seq } }
      },
      landedDespiteError: () => readStoreInfo(database).commit_token === commitToken,
    })
    if (!committed || !commit) return
    if (storeCaches.get(database) === commit.base) {
      storeCaches.set(database, { seq: commit.seq, document: committedDocument(commit.base.document, commit.draft) })
    } else if ((storeCaches.get(database)?.seq ?? -1) < commit.seq) {
      // A read replaced the cache before this commit landed; the next read
      // loads what the database holds.
      storeCaches.delete(database)
    }
  })
}

function storeIsEmpty(document: SessionStoreDocument): boolean {
  if (Object.keys(document.sessions).length > 0 || Object.keys(document.meta.slots).length > 0) return false
  return PRIORITY_RECORD_FIELDS.every((field) => Object.keys(priorityRecords(document.meta, field)).length === 0)
}

function protectedMappingKeys(meta: SessionStoreMeta): Set<string> {
  if (meta.version !== PRIORITY_STORE_META_VERSION) return new Set()
  return new Set([
    ...Object.values(meta.priorityAssignments).map((assignment) => assignment.mappingKey),
    ...Object.values(meta.priorityRollbackMappings).map((rollback) => rollback.mappingKey),
  ])
}

interface LegacyImport {
  draft: SessionStoreDocument
  /** Mappings taken from the file. */
  imported: number
  /** Mappings of the file the database already had in a newer or protected copy. */
  kept: number
  /** Priority records of the file left out of a merge. */
  skippedRoutes: number
  merged: boolean
}

/**
 * The store after taking a legacy sessions.json into `base`.
 *
 * An empty database takes the file whole. A database that already holds a
 * store, because a process still on an older version rewrote the file after
 * the first import, only merges it: an entry of the file replaces the
 * database's copy only when it was used more recently, nothing is deleted, and
 * the file's priority records are left out, so the database's routes and the
 * mappings they protect stay exactly as they are.
 */
function legacyImportDraft(base: SessionStoreDocument, legacy: SessionStoreDocument): LegacyImport {
  const draft = draftStoreDocument(base)
  if (storeIsEmpty(base)) {
    Object.assign(draft.sessions, legacy.sessions)
    for (const [slot, counter] of Object.entries(legacy.meta.slots)) draft.meta.slots[slot] = counter
    if (legacy.meta.version === PRIORITY_STORE_META_VERSION) {
      draft.meta = {
        version: PRIORITY_STORE_META_VERSION,
        slots: draft.meta.slots,
        priorityAssignments: copyRecords(legacy.meta.priorityAssignments),
        priorityAttempts: copyRecords(legacy.meta.priorityAttempts),
        priorityRollbackMappings: copyRecords(legacy.meta.priorityRollbackMappings),
      }
    }
    return { draft, imported: Object.keys(legacy.sessions).length, kept: 0, skippedRoutes: 0, merged: false }
  }
  for (const [slot, counter] of Object.entries(legacy.meta.slots)) {
    if (counter > (draft.meta.slots[slot] ?? 0)) draft.meta.slots[slot] = counter
  }
  const protectedKeys = protectedMappingKeys(base.meta)
  let imported = 0
  let kept = 0
  for (const [key, entry] of Object.entries(legacy.sessions)) {
    const current = base.sessions[key]
    if (protectedKeys.has(key) || (current && current.lastUsedAt >= entry.lastUsedAt)) {
      kept++
      continue
    }
    draft.sessions[key] = entry
    advanceKeySlot(key, draft.meta)
    imported++
  }
  const skippedRoutes = PRIORITY_RECORD_FIELDS
    .reduce((count, field) => count + Object.keys(priorityRecords(legacy.meta, field)).length, 0)
  return { draft, imported, kept, skippedRoutes, merged: true }
}

/**
 * Find a sessions.json left by an earlier version and queue its import.
 *
 * The file stays authoritative until the import commits: readers see what it
 * holds, no mutation commits before it, and a failed import is retried by the
 * next mutation, which fails with it. The database records the digest of the
 * file it imported, so a file found again after a crash between the commit and
 * the rename is only renamed. A file that does not parse fails every store
 * operation and is left untouched, as it was before the database existed.
 */
function checkLegacyStore(database: StoreDatabase): void {
  const legacyPath = join(database.dir, LEGACY_STORE_NAME)
  let raw: Buffer
  try {
    raw = readFileSync(legacyPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  const digest = fileDigest(raw)
  if (readStoreInfo(database).imported_json_sha256 === digest) {
    void enqueueStoreTask(database, () => retireLegacyStore(legacyPath, digest))
    return
  }
  const legacy = parseStoreDocument(raw.toString("utf8"))
  for (const entry of Object.values(legacy.sessions)) Object.freeze(entry)
  const pending: PendingImport = {
    legacyPath,
    digest,
    legacy,
    view: legacyImportDraft(freshStoreCache(database).document, legacy).draft,
  }
  pendingImports.set(database, pending)
  void enqueueStoreTask(database, () => importLegacyStore(database, pending)).catch((error: unknown) => {
    console.error(
      `[sessionStore] importing ${LEGACY_STORE_NAME} failed; it stays the store until the next write retries:`,
      (error as Error).message,
    )
  })
}

/** Commit a pending import. Only from inside an enqueued task. */
async function importLegacyStore(database: StoreDatabase, pending: PendingImport): Promise<void> {
  if (pendingImports.get(database) !== pending) return
  const { committed, result: taken } = await database.transactNow<LegacyImport | undefined>({
    lockWaitMs: getStoreLockWaitMs(),
    build: () => {
      // Another process may have imported the same file while this one waited.
      if (readStoreInfo(database).imported_json_sha256 === pending.digest) return { ops: [], result: undefined }
      const base = freshStoreCache(database)
      const taken = legacyImportDraft(base.document, pending.legacy)
      return {
        ops: [
          ...storeChangeOps(base.document, taken.draft, base.seq + 1, randomUUID()),
          [RECORD_IMPORT, [pending.digest, Date.now()]],
        ],
        result: taken,
      }
    },
    landedDespiteError: () => readStoreInfo(database).imported_json_sha256 === pending.digest,
  })
  pendingImports.delete(database)
  storeCaches.delete(database)
  if (committed && taken) {
    const into = basename(database.path)
    console.error(taken.merged
      ? `[sessionStore] merged ${taken.imported} sessions from ${LEGACY_STORE_NAME} into ${into}; kept the database's copy of ${taken.kept}`
        + (taken.skippedRoutes > 0 ? ` and left out ${taken.skippedRoutes} priority records` : "")
      : `[sessionStore] imported ${taken.imported} sessions from ${LEGACY_STORE_NAME} into ${into}`)
  }
  await retireLegacyStore(pending.legacyPath, pending.digest)
}

/** Rename an imported sessions.json aside, never deleting it. The import it
 *  was taken in by is a synced commit, so the file is no longer needed. A file
 *  rewritten since, by a process still on an older version, stays for the next
 *  start to take in. */
async function retireLegacyStore(legacyPath: string, digest: string): Promise<void> {
  try {
    const retiredPath = await retireImportedFile(legacyPath, digest)
    if (retiredPath) {
      console.error(`[sessionStore] ${LEGACY_STORE_NAME} is in the database now; the file is kept as ${basename(retiredPath)}`)
    }
  } catch (error) {
    console.error(`[sessionStore] renaming the imported ${LEGACY_STORE_NAME} aside failed; it is retried on the next start:`, (error as Error).message)
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
    const document = currentDocument()
    const session = document.sessions[key]
    const generation = keyGeneration(key, session, document.meta)
    if (!session) return { status: "missing", generation }
    freezeSessionForRead(session)
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
  | {
      status: "found"
      assignment: DurablePriorityAssignment
      generation: PriorityAssignmentGeneration
      attempt?: DurablePriorityAttempt
    }
  | { status: "missing"; generation: PriorityAssignmentGeneration; attempt?: DurablePriorityAttempt }
  | { status: "error"; error: Error }

/** Read one exact durable route. V1 documents authoritatively contain none. */
export function lookupPriorityAssignmentResult(routeKey: string): PriorityAssignmentLookupResult {
  try {
    const document = currentDocument()
    const assignment = document.meta.version === PRIORITY_STORE_META_VERSION
      ? document.meta.priorityAssignments[routeKey]
      : undefined
    const generation = priorityAssignmentGeneration(routeKey, assignment, document.meta)
    const attempt = document.meta.version === PRIORITY_STORE_META_VERSION
      ? document.meta.priorityAttempts[routeKey]
      : undefined
    return assignment
      ? { status: "found", assignment, generation, attempt }
      : { status: "missing", generation, attempt }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    console.error("[sessionStore] priority route read failed:", normalized.message)
    return { status: "error", error: normalized }
  }
}

export function lookupSharedSessionByClaudeIdResult(claudeSessionId: string): SharedSessionLookupResult {
  try {
    const document = currentDocument()
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
      ? { status: "found", session: freezeSessionForRead(newest), generation: getStoredSessionGeneration(newest, newestKey) }
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

function isPriorityRollbackMapping(meta: SessionStoreMeta, key: string): boolean {
  return meta.version === PRIORITY_STORE_META_VERSION
    && Object.values(meta.priorityRollbackMappings).some((rollback) => rollback.mappingKey === key)
}

export async function storeSharedSession(
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
): Promise<StoredSessionGeneration | false> {
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
  await mutateStore(({ sessions: store, meta }) => {
    if (isPriorityRollbackMapping(meta, key)) return false
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
      // Copy, never alias: the document is republished as the read cache, so a
      // later mutation of the caller's locator would diverge it from the file.
      ...(resolvedCurrentTranscript ? { currentTranscript: { ...resolvedCurrentTranscript } } : {}),
      ...(previousTranscript ? { previousTranscript: { ...previousTranscript } } : {}),
      ...(previousClaudeSessionId ? { previousClaudeSessionId } : {}),
    }

    // Prune only mappings that are not exact route authorities. If the
    // configured bound cannot admit this protected write, reject the whole CAS
    // rather than leave a dangling route or silently exceed the limit.
    const maxEntries = getMaxStoredSessionsLimit()
    const keys = Object.keys(store)
    const protectedMappings = meta.version === PRIORITY_STORE_META_VERSION
      ? new Set([
          ...Object.values(meta.priorityAssignments).map((assignment) => assignment.mappingKey),
          ...Object.values(meta.priorityRollbackMappings).map((rollback) => rollback.mappingKey),
        ])
      : new Set<string>()
    protectedMappings.add(key)
    const removeCount = Math.max(0, keys.length - maxEntries)
    const removable = keys
      .filter((candidate) => !protectedMappings.has(candidate))
      .sort((a, b) => (store[a]!.lastUsedAt || 0) - (store[b]!.lastUsedAt || 0))
    if (removable.length < removeCount) return false
    for (const candidate of removable.slice(0, removeCount)) {
      delete store[candidate]
      advanceKeySlot(candidate, meta)
    }
    advanceKeySlot(key, meta)
    storedGeneration = getStoredSessionGeneration(store[key]!, key)
    if (meta.version === PRIORITY_STORE_META_VERSION) {
      for (const [routeKey, assignment] of Object.entries(meta.priorityAssignments)) {
        if (assignment.mappingKey !== key) continue
        assignment.mappingGeneration = storedGeneration
        assignment.generationId = randomUUID()
        assignment.updatedAt = Date.now()
        advanceKeySlot(priorityGenerationKey(routeKey), meta)
      }
    }
    return true
  })
  return storedGeneration
}

export interface PriorityAttemptTurn {
  turnId: string
  issuedAt: number
}

export interface PriorityAttemptClaim {
  ownerToken: string
}

function validatePriorityAttemptTurn(turn: PriorityAttemptTurn | undefined): void {
  if (!turn) return
  if (!/^[A-Za-z0-9_-]{43}$/.test(turn.turnId)
    || !Number.isSafeInteger(turn.issuedAt)
    || turn.issuedAt < 0) {
    throw new Error("priority attempt requires a valid trusted turn")
  }
}

/**
 * Reserve one durable route attempt before any SDK work can become exposed.
 * A blocked/crashed attempt can be superseded only by a strictly newer trusted
 * human turn. The prior blocker remains until the newer turn publishes.
 */
export async function claimPriorityAttempt(options: {
  routeKey: string
  expectedAssignmentGeneration: PriorityAssignmentGeneration
  turn?: PriorityAttemptTurn
}): Promise<PriorityAttemptClaim | false> {
  if (!options.routeKey || options.routeKey.length > 512) {
    throw new Error("priority attempt requires a bounded route key")
  }
  validatePriorityAttemptTurn(options.turn)
  const ownerToken = randomUUID()
  let claimed = false
  await mutateStore((document) => {
    const assignment = document.meta.version === PRIORITY_STORE_META_VERSION
      ? document.meta.priorityAssignments[options.routeKey]
      : undefined
    if (priorityAssignmentGeneration(options.routeKey, assignment, document.meta)
      !== options.expectedAssignmentGeneration) return false

    const existing = document.meta.version === PRIORITY_STORE_META_VERSION
      ? document.meta.priorityAttempts[options.routeKey]
      : undefined
    if (existing) {
      const floor = Math.max(
        assignment?.lastHumanTurnIssuedAt ?? -1,
        existing.blockedTurnIssuedAt ?? -1,
        existing.pendingTurnIssuedAt ?? -1,
      )
      if (!options.turn || options.turn.issuedAt <= floor) return false
    } else if (document.meta.version === PRIORITY_STORE_META_VERSION
      && Object.keys(document.meta.priorityAttempts).length >= getMaxPriorityAttemptsLimit()) {
      return false
    }

    if (document.meta.version === STORE_META_VERSION) {
      document.meta = {
        version: PRIORITY_STORE_META_VERSION,
        slots: document.meta.slots,
        priorityAssignments: {},
        priorityAttempts: {},
        priorityRollbackMappings: {},
      }
    }
    const previous = document.meta.priorityAttempts[options.routeKey]
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
    document.meta.priorityAttempts[options.routeKey] = {
      blocked,
      blockedTurnDigest,
      blockedTurnIssuedAt,
      pendingTurnDigest: options.turn?.turnId ?? null,
      pendingTurnIssuedAt: options.turn?.issuedAt ?? null,
      ownerToken,
      generationId: randomUUID(),
      updatedAt: Date.now(),
    }
    advanceKeySlot(`priority-attempt:${options.routeKey}`, document.meta)
    claimed = true
    return true
  })
  return claimed ? { ownerToken } : false
}

async function settlePriorityAttempt(
  routeKey: string,
  ownerToken: string,
  disposition: "release" | "block",
): Promise<boolean> {
  if (!routeKey || routeKey.length > 512 || !UUID_PATTERN.test(ownerToken)) return false
  let settled = false
  await mutateStore((document) => {
    if (document.meta.version !== PRIORITY_STORE_META_VERSION) return false
    const attempt = document.meta.priorityAttempts[routeKey]
    if (!attempt || attempt.ownerToken !== ownerToken) return false
    if (disposition === "block") {
      attempt.blocked = true
      if (attempt.pendingTurnIssuedAt !== null
        && (attempt.blockedTurnIssuedAt === null || attempt.pendingTurnIssuedAt > attempt.blockedTurnIssuedAt)) {
        attempt.blockedTurnDigest = attempt.pendingTurnDigest
        attempt.blockedTurnIssuedAt = attempt.pendingTurnIssuedAt
      }
      attempt.pendingTurnDigest = null
      attempt.pendingTurnIssuedAt = null
      attempt.ownerToken = null
      attempt.generationId = randomUUID()
      attempt.updatedAt = Date.now()
    } else if (attempt.blocked) {
      attempt.pendingTurnDigest = null
      attempt.pendingTurnIssuedAt = null
      attempt.ownerToken = null
      attempt.generationId = randomUUID()
      attempt.updatedAt = Date.now()
    } else {
      delete document.meta.priorityAttempts[routeKey]
    }
    advanceKeySlot(`priority-attempt:${routeKey}`, document.meta)
    settled = true
    return true
  })
  return settled
}

/** Release an unexposed attempt; an older blocker remains intact. */
export function releasePriorityAttempt(routeKey: string, ownerToken: string): Promise<boolean> {
  return settlePriorityAttempt(routeKey, ownerToken, "release")
}

/** Persist exposure before returning an account-shaped error or cancellation. */
export function blockPriorityAttempt(routeKey: string, ownerToken: string): Promise<boolean> {
  return settlePriorityAttempt(routeKey, ownerToken, "block")
}

export interface SharedSessionPriorityPublication {
  routeKey: string
  profileId: string
  lastHumanTurnDigest: string
  lastHumanTurnIssuedAt: number
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
  /** Original routed mapping retained across chained publications for rollback. */
  rollbackMappingKey?: string
  /** Exact pre-SDK durable claim cleared only by this winning publication. */
  attemptOwnerToken?: string
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
  if (!Number.isSafeInteger(options.priority.lastHumanTurnIssuedAt) || options.priority.lastHumanTurnIssuedAt < 0) {
    throw new Error("priority publication requires a valid human-turn issue time")
  }
  if (options.attemptOwnerToken !== undefined && !UUID_PATTERN.test(options.attemptOwnerToken)) {
    throw new Error("priority publication requires a valid attempt owner token")
  }
  if (options.currentTranscript !== undefined) validateTranscriptLocator(options.currentTranscript, options.claudeSessionId)
  if (options.rollbackMappingKey !== undefined && (
    !options.rollbackMappingKey || options.rollbackMappingKey.length > 1_024
  )) {
    throw new Error("priority publication requires a bounded rollback mapping key")
  }
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
export async function storeSharedSessionAndPriorityAssignment(
  options: SharedSessionAndPriorityAssignmentOptions,
): Promise<SharedSessionAndPriorityAssignmentResult | false> {
  validatePriorityPublicationInput(options)
  let result: SharedSessionAndPriorityAssignmentResult | false = false
  await mutateStore((document) => {
    const existing = document.sessions[options.key]
    const actualMappingGeneration = keyGeneration(options.key, existing, document.meta)
    if (actualMappingGeneration !== options.expectedMappingGeneration) return false
    if (document.meta.version === PRIORITY_STORE_META_VERSION) {
      const markerOwners = Object.entries(document.meta.priorityRollbackMappings)
        .filter(([, rollback]) => rollback.mappingKey === options.key)
      if (markerOwners.some(([routeKey]) => routeKey !== options.priority.routeKey)) return false
      const ownMarker = document.meta.priorityRollbackMappings[options.priority.routeKey]
      if (ownMarker?.mappingKey === options.key && ownMarker.mappingGeneration !== actualMappingGeneration) return false
    }

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
    const existingAttempt = document.meta.version === PRIORITY_STORE_META_VERSION
      ? document.meta.priorityAttempts[options.priority.routeKey]
      : undefined
    if (options.attemptOwnerToken !== undefined) {
      if (existingAttempt?.ownerToken !== options.attemptOwnerToken) return false
    } else if (existingAttempt) {
      // A direct/older writer cannot bypass an in-flight or exposed claim.
      return false
    }

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
      // Copy, never alias — same reason as in storeSharedSession.
      ...(resolvedCurrentTranscript ? { currentTranscript: { ...resolvedCurrentTranscript } } : {}),
      ...(previousTranscript ? { previousTranscript: { ...previousTranscript } } : {}),
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
        priorityAttempts: {},
        priorityRollbackMappings: {},
      }
    }
    const assignment: DurablePriorityAssignment = {
      profileId: options.priority.profileId,
      lastHumanTurnDigest: options.priority.lastHumanTurnDigest,
      lastHumanTurnIssuedAt: options.priority.lastHumanTurnIssuedAt,
      mappingKey: options.key,
      mappingGeneration,
      generationId: randomUUID(),
      updatedAt: Date.now(),
    }
    const priorityAssignments = document.meta.priorityAssignments
    const priorityRollbackMappings = document.meta.priorityRollbackMappings
    priorityAssignments[options.priority.routeKey] = assignment
    const existingRollback = priorityRollbackMappings[options.priority.routeKey]
    const rollbackMappingKey = options.rollbackMappingKey ?? existingAssignment?.mappingKey
    if (rollbackMappingKey && rollbackMappingKey !== options.key) {
      const rollbackMapping = document.sessions[rollbackMappingKey]
      if (!rollbackMapping) {
        throw new Error("priority rollback mapping disappeared before publication")
      }
      const rollbackMappingGeneration = getStoredSessionGeneration(rollbackMapping, rollbackMappingKey)
      if (
        existingAssignment?.mappingKey === rollbackMappingKey
        && existingAssignment.mappingGeneration !== rollbackMappingGeneration
      ) return false
      priorityRollbackMappings[options.priority.routeKey] = existingRollback?.mappingKey === rollbackMappingKey
        ? existingRollback
        : { mappingKey: rollbackMappingKey, mappingGeneration: rollbackMappingGeneration }
    } else {
      delete priorityRollbackMappings[options.priority.routeKey]
    }
    advanceKeySlot(priorityGenerationKey(options.priority.routeKey), document.meta)

    const maxSessions = getMaxStoredSessionsLimit()
    const maxAssignments = getMaxPriorityAssignmentsLimit()
    const referencedMappingKeys = (): Set<string> => new Set(
      Object.values(priorityAssignments).map((candidate) => candidate.mappingKey),
    )

    // Route retention cannot exceed the number of exact mapping proofs the
    // session bound can retain. Evict unrelated routes first, then their now-
    // unreferenced mappings. The route being published is never a victim.
    const sortedRoutes = Object.keys(priorityAssignments)
      .filter((candidate) => (
        candidate !== options.priority.routeKey
        && priorityRollbackMappings[candidate] === undefined
      ))
      .sort((left, right) => (
        priorityAssignments[left]!.updatedAt - priorityAssignments[right]!.updatedAt
      ))
    while (
      Object.keys(priorityAssignments).length > maxAssignments
      || referencedMappingKeys().size > maxSessions
    ) {
      const candidate = sortedRoutes.shift()
      if (!candidate) return false
      delete priorityAssignments[candidate]
      delete priorityRollbackMappings[candidate]
      advanceKeySlot(priorityGenerationKey(candidate), document.meta)
    }

    const protectedMappings = referencedMappingKeys()
    protectedMappings.add(options.key)
    // A late cancel must be able to restore every in-flight pre-publication
    // route. Those different fallback mappings form a separately bounded
    // rollback backlog: at most one retained mapping per durable route.
    for (const rollback of Object.values(priorityRollbackMappings)) {
      protectedMappings.add(rollback.mappingKey)
    }
    const protectedExistingCount = [...protectedMappings]
      .filter((candidate) => document.sessions[candidate] !== undefined)
      .length
    const retainedSessionLimit = Math.max(maxSessions, protectedExistingCount)
    const sortedSessions = Object.keys(document.sessions)
      .filter((candidate) => !protectedMappings.has(candidate))
      .sort((left, right) => document.sessions[left]!.lastUsedAt - document.sessions[right]!.lastUsedAt)
    while (Object.keys(document.sessions).length > retainedSessionLimit) {
      const candidate = sortedSessions.shift()
      if (!candidate) break
      delete document.sessions[candidate]
      advanceKeySlot(candidate, document.meta)
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

export interface FinalizeSharedSessionAndPriorityAssignmentOptions {
  key: string
  routeKey: string
  expectedMappingGeneration: StoredSessionGeneration
  expectedAssignmentGeneration: PriorityAssignmentGeneration
  rollbackMappingKey?: string
  attemptOwnerToken?: string
}

/**
 * Make a successful publication irrevocable and prune its rollback backlog.
 * Exact route+mapping CAS prevents a late finalizer from touching newer work.
 */
export async function finalizeSharedSessionAndPriorityAssignment(
  options: FinalizeSharedSessionAndPriorityAssignmentOptions,
): Promise<boolean> {
  let finalized = false
  await mutateStore((document) => {
    if (document.meta.version !== PRIORITY_STORE_META_VERSION) return false
    const mapping = document.sessions[options.key]
    if (keyGeneration(options.key, mapping, document.meta) !== options.expectedMappingGeneration) return false
    const assignment = document.meta.priorityAssignments[options.routeKey]
    if (
      !assignment
      || priorityAssignmentGeneration(options.routeKey, assignment, document.meta)
        !== options.expectedAssignmentGeneration
    ) return false
    const rollback = document.meta.priorityRollbackMappings[options.routeKey]
    if (rollback?.mappingKey !== options.rollbackMappingKey) return false
    const attempt = document.meta.priorityAttempts[options.routeKey]
    if (options.attemptOwnerToken !== undefined) {
      if (attempt?.ownerToken !== options.attemptOwnerToken) return false
    } else if (attempt) return false

    delete document.meta.priorityRollbackMappings[options.routeKey]
    if (options.attemptOwnerToken !== undefined) {
      delete document.meta.priorityAttempts[options.routeKey]
      advanceKeySlot(`priority-attempt:${options.routeKey}`, document.meta)
    }
    assignment.generationId = randomUUID()
    assignment.updatedAt = Date.now()
    advanceKeySlot(priorityGenerationKey(options.routeKey), document.meta)
    const protectedMappings = new Set([
      ...Object.values(document.meta.priorityAssignments).map((candidate) => candidate.mappingKey),
      ...Object.values(document.meta.priorityRollbackMappings).map((rollback) => rollback.mappingKey),
    ])
    const maxSessions = getMaxStoredSessionsLimit()
    const protectedExistingCount = [...protectedMappings]
      .filter((candidate) => document.sessions[candidate] !== undefined)
      .length
    const retainedLimit = Math.max(maxSessions, protectedExistingCount)
    const removable = Object.keys(document.sessions)
      .filter((candidate) => !protectedMappings.has(candidate))
      .sort((left, right) => document.sessions[left]!.lastUsedAt - document.sessions[right]!.lastUsedAt)
    while (Object.keys(document.sessions).length > retainedLimit) {
      const candidate = removable.shift()
      if (!candidate) break
      delete document.sessions[candidate]
      advanceKeySlot(candidate, document.meta)
    }
    finalized = true
    return true
  })
  return finalized
}

export interface RollbackSharedSessionAndPriorityAssignmentOptions {
  key: string
  routeKey: string
  expectedMappingGeneration: StoredSessionGeneration
  expectedAssignmentGeneration: PriorityAssignmentGeneration
  previousMapping: StoredSession | null
  previousAssignment: DurablePriorityAssignment | null
  attemptOwnerToken?: string
}

export interface RollbackSharedSessionAndPriorityAssignmentResult {
  mappingGeneration: StoredSessionGeneration
  assignmentGeneration: PriorityAssignmentGeneration
  restoredMapping: StoredSession | null
  restoredAssignment: DurablePriorityAssignment | null
}

/** Restore the exact pre-request authorities after a canceled late publication. */
export async function rollbackSharedSessionAndPriorityAssignment(
  options: RollbackSharedSessionAndPriorityAssignmentOptions,
): Promise<RollbackSharedSessionAndPriorityAssignmentResult | false> {
  let result: RollbackSharedSessionAndPriorityAssignmentResult | false = false
  await mutateStore((document) => {
    if (document.meta.version !== PRIORITY_STORE_META_VERSION) return false
    const currentMapping = document.sessions[options.key]
    if (keyGeneration(options.key, currentMapping, document.meta) !== options.expectedMappingGeneration) return false
    const currentAssignment = document.meta.priorityAssignments[options.routeKey]
    if (
      priorityAssignmentGeneration(options.routeKey, currentAssignment, document.meta)
      !== options.expectedAssignmentGeneration
    ) return false
    const attempt = document.meta.priorityAttempts[options.routeKey]
    if (options.attemptOwnerToken !== undefined) {
      if (attempt?.ownerToken !== options.attemptOwnerToken) return false
    } else if (attempt) return false
    const expectedRollback = options.previousAssignment
      && options.previousAssignment.mappingKey !== options.key
      ? {
          mappingKey: options.previousAssignment.mappingKey,
          mappingGeneration: options.previousAssignment.mappingGeneration,
        }
      : undefined
    const actualRollback = document.meta.priorityRollbackMappings[options.routeKey]
    if (
      actualRollback?.mappingKey !== expectedRollback?.mappingKey
      || actualRollback?.mappingGeneration !== expectedRollback?.mappingGeneration
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
    delete document.meta.priorityRollbackMappings[options.routeKey]
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
export async function attachSharedTranscriptLocator(
  key: string,
  expectedClaudeSessionId: string,
  locator: TranscriptLocator,
  expectedGeneration?: StoredSessionGeneration,
): Promise<StoredSessionGeneration | false> {
  validateTranscriptLocator(locator, expectedClaudeSessionId)
  let attachedGeneration: StoredSessionGeneration | false = false
  await mutateStore(({ sessions: store, meta }) => {
    if (isPriorityRollbackMapping(meta, key)) return false
    const existing = store[key]
    if (!existing || existing.claudeSessionId !== expectedClaudeSessionId) return false
    if (expectedGeneration !== undefined && getStoredSessionGeneration(existing, key) !== expectedGeneration) return false
    if (!sameTranscriptLocator(existing.currentTranscript, locator)) {
      // Copy, never alias — same reason as in storeSharedSession. The entry is
      // replaced rather than edited: cached entries are shared and frozen.
      const attached: StoredSession = {
        ...existing,
        currentTranscript: { ...locator },
        revision: (existing.revision ?? 0) + 1,
        generationId: randomUUID(),
      }
      store[key] = attached
      advanceKeySlot(key, meta)
      attachedGeneration = getStoredSessionGeneration(attached, key)
      if (meta.version === PRIORITY_STORE_META_VERSION) {
        for (const [routeKey, assignment] of Object.entries(meta.priorityAssignments)) {
          if (assignment.mappingKey !== key) continue
          assignment.mappingGeneration = attachedGeneration
          assignment.generationId = randomUUID()
          assignment.updatedAt = Date.now()
          advanceKeySlot(priorityGenerationKey(routeKey), meta)
        }
      }
    } else {
      attachedGeneration = getStoredSessionGeneration(existing, key)
    }
    return true
  })
  return attachedGeneration
}

/** Ensure a single session is absent from the shared file store.
 *  Used when a session is detected as stale (e.g. expired upstream).
 *  Absence is an idempotent success; false is reserved for a present mapping
 *  whose exact expected generation no longer matches. */
export async function evictSharedSession(
  key: string,
  expectedGeneration?: StoredSessionGeneration,
): Promise<boolean> {
  let evicted = false
  await mutateStore(({ sessions: store, meta }) => {
    const existing = store[key]
    if (!existing) {
      evicted = true
      return false
    }
    if (expectedGeneration !== undefined && getStoredSessionGeneration(existing, key) !== expectedGeneration) return false
    if (isPriorityRollbackMapping(meta, key)) return false
    delete store[key]
    advanceKeySlot(key, meta)
    evicted = true
    return true
  })
  return evicted
}

/**
 * How long a superseded copy stays resumable. A conversation that moves to
 * another account and comes back - typically once the first account's 5-hour
 * usage window has reset - resumes that account's own SDK session while its
 * copy exists, and is replayed as flattened, window-trimmed history after.
 */
export const DEFAULT_PROFILE_COPY_GRACE_MS = 24 * 60 * 60_000

export interface ProfileCopyPruneOptions {
  /** Configured non-default profile IDs; only their `${id}:` prefixes are recognized. */
  profileIds: Iterable<string>
  /** Copies used within this window are kept alongside the newest one. */
  graceMs: number
  /** Most transcripts the removed mappings may stop pinning in this call. */
  maxUnpinnedTranscripts: number
  /** A conversation with a request arrived or running keeps every copy. */
  isConversationActive: (conversationId: string) => boolean
}

function pinnedTranscriptCount(session: StoredSession): number {
  let count = 0
  if (session.currentTranscript?.sessionId === session.claudeSessionId) count++
  if (session.previousTranscript && session.previousTranscript.sessionId === session.previousClaudeSessionId) count++
  return count
}

function selectSupersededProfileCopies(
  document: SessionStoreDocument,
  options: ProfileCopyPruneOptions,
  now: number,
): string[] {
  const profileIds = new Set(options.profileIds)
  profileIds.delete("default")
  const protectedKeys = new Set(document.meta.version === PRIORITY_STORE_META_VERSION
    ? [
        ...Object.values(document.meta.priorityAssignments).map((assignment) => assignment.mappingKey),
        ...Object.values(document.meta.priorityRollbackMappings).map((rollback) => rollback.mappingKey),
      ]
    : [])
  const copiesByConversation = new Map<string, string[]>()
  for (const key of Object.keys(document.sessions)) {
    const separator = key.indexOf(":")
    const conversationId = separator > 0 && profileIds.has(key.slice(0, separator))
      ? key.slice(separator + 1)
      : key
    const copies = copiesByConversation.get(conversationId)
    if (copies) copies.push(key)
    else copiesByConversation.set(conversationId, [key])
  }

  const lastUsed = (key: string): number => document.sessions[key]!.lastUsedAt || 0
  const candidates: string[] = []
  for (const [conversationId, copies] of copiesByConversation) {
    if (copies.length < 2) continue
    const newest = copies.reduce((best, key) => (lastUsed(key) > lastUsed(best) ? key : best))
    const superseded = copies.filter((key) => (
      key !== newest && !protectedKeys.has(key) && now - lastUsed(key) > options.graceMs
    ))
    if (superseded.length > 0 && !options.isConversationActive(conversationId)) candidates.push(...superseded)
  }
  candidates.sort((left, right) => lastUsed(left) - lastUsed(right))

  const victims: string[] = []
  let remaining = options.maxUnpinnedTranscripts
  for (const key of candidates) {
    const cost = pinnedTranscriptCount(document.sessions[key]!)
    if (cost > remaining) continue
    remaining -= cost
    victims.push(key)
  }
  return victims
}

/** Candidate conversations only; callers must fence turns before deleting their mappings. */
export function listSupersededProfileConversations(options: ProfileCopyPruneOptions): string[] {
  const profileIds = new Set(options.profileIds)
  const candidates = selectSupersededProfileCopies(currentDocument(),
    { ...options, profileIds }, Date.now())
  return [...new Set(candidates.map(key => {
    const separator = key.indexOf(":")
    return separator > 0 && key.slice(0, separator) !== "default" && profileIds.has(key.slice(0, separator))
      ? key.slice(separator + 1) : key
  }))]
}

/**
 * Remove mappings superseded by a newer copy of the same conversation under
 * another profile, oldest first. Past the grace window a copy is rarely
 * returned to, yet it keeps its per-message hashes in every store write and
 * its transcript pinned. Removal unpins those transcripts; lifecycle
 * reconciliation retires them through the normal bounded backlog.
 * Returns the number of mappings removed.
 */
export async function pruneSupersededProfileCopies(options: ProfileCopyPruneOptions): Promise<number> {
  // Select from the cached document first so the common no-op sweep takes no
  // lock and writes nothing.
  if (selectSupersededProfileCopies(currentDocument(), options, Date.now()).length === 0) {
    return 0
  }
  let pruned = 0
  await mutateStore(({ sessions, meta }) => {
    const victims = selectSupersededProfileCopies({ sessions, meta }, options, Date.now())
    for (const key of victims) {
      delete sessions[key]
      advanceKeySlot(key, meta)
    }
    pruned = victims.length
    return pruned > 0
  })
  return pruned
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

export async function clearSharedSessions(): Promise<void> {
  await mutateStore(({ sessions: store, meta }) => {
    for (const key of Object.keys(store)) {
      delete store[key]
      advanceKeySlot(key, meta)
    }
    if (meta.version === PRIORITY_STORE_META_VERSION) {
      for (const routeKey of Object.keys(meta.priorityAssignments)) {
        delete meta.priorityAssignments[routeKey]
        delete meta.priorityRollbackMappings[routeKey]
        advanceKeySlot(priorityGenerationKey(routeKey), meta)
      }
      for (const routeKey of Object.keys(meta.priorityAttempts)) {
        delete meta.priorityAttempts[routeKey]
        advanceKeySlot(`priority-attempt:${routeKey}`, meta)
      }
    }
    return true
  })
}
