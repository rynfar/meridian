/** Legacy-only codecs. SQLite request operations must not parse full legacy documents. */
import { createHash } from "node:crypto"
import { isUuidV4 } from "./uuid"
export { UUID_PATTERN } from "./uuid"
import { isAbsolute } from "node:path"
import { parseProcessIncarnation } from "../processIncarnation"
import { SessionLifecycleCorruptError } from "../lifecycleErrors"
import { resourceKey as getTranscriptResourceKey } from "./locator"
import type {
  StoredSession,
  TranscriptLocator,
  TranscriptResource,
  TranscriptResourceState,
  ActiveTranscriptLeaseRecord,
} from "./types"

export function parseLegacySidecar(raw: string, source = "session-gc.json"): SessionGcSidecar {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SessionLifecycleCorruptError(`cannot parse ${source}: ${message}`)
  }
  const upgraded = upgradeLegacySidecar(value)
  if (!isValidSidecar(upgraded)) throw new SessionLifecycleCorruptError(`invalid or unsupported ${source}`)
  return upgraded
}

/** Exact legacy wire shape: compact JSON with one trailing newline. */
export function serializeLegacySidecar(sidecar: SessionGcSidecar): string {
  return `${JSON.stringify(sidecar)}\n`
}

/** Exact legacy wire shape: metadata first, compact JSON, no trailing newline. */
export function serializeLegacyStore(document: SessionStoreDocument): string {
  return JSON.stringify({ [STORE_META_KEY]: document.meta, ...document.sessions })
}

/** Maintenance refuses map keys that the historical plain-object decoder cannot faithfully represent. */
export function parseLegacyStoreForMaintenance(raw: string): SessionStoreDocument {
  const document = parseStoreDocument(raw)
  const source = JSON.parse(raw) as Record<string, unknown>
  const equalKeys = (expected: string[], actual: string[], context: string): void => {
    expected.sort()
    actual.sort()
    if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
      throw new Error(
        `legacy ${context} contains a key the legacy decoder cannot represent without data loss`,
      )
    }
  }
  equalKeys(
    Object.keys(source).filter((key) => key !== STORE_META_KEY),
    Object.keys(document.sessions),
    "sessions",
  )
  if (document.meta.version === PRIORITY_STORE_META_VERSION) {
    const meta = source[STORE_META_KEY] as Record<string, object>
    for (const name of ["priorityAssignments", "priorityAttempts", "priorityRollbackMappings"] as const) {
      equalKeys(Object.keys(meta[name]!), Object.keys(document.meta[name]), name)
    }
    for (const [route, rollback] of Object.entries(document.meta.priorityRollbackMappings)) {
      if (!Object.hasOwn(document.meta.priorityAssignments, route)
        || !Object.hasOwn(document.sessions, rollback.mappingKey)) {
        throw new Error(`legacy priority rollback ${JSON.stringify(route)} lacks an own assignment or mapping`)
      }
    }
  }
  return document
}

export type StoredSessionGeneration = string

export const STORE_META_KEY = "\u0000meridian-session-store"

export const STORE_META_VERSION = 1

export const PRIORITY_STORE_META_VERSION = 3

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

export interface SessionStoreMetaV1 {
  version: 1
  /** Fixed hash slots fence absent-key create/delete ABA without unbounded tombstones. */
  slots: Record<string, number>
}

export interface DurablePriorityRollbackMapping {
  mappingKey: string
  /** Exact fallback generation protected until terminal finalization/rollback. */
  mappingGeneration: StoredSessionGeneration
}

export interface SessionStoreMetaV2 {
  version: 3
  /** Shared fixed slots fence both mapping and namespaced route ABA. */
  slots: Record<string, number>
  priorityAssignments: Record<string, DurablePriorityAssignment>
  /** Durable request claims block cross-request replay after committed exposure. */
  priorityAttempts: Record<string, DurablePriorityAttempt>
  /** Previous routed mappings retained only until terminal finalization/rollback. */
  priorityRollbackMappings: Record<string, DurablePriorityRollbackMapping>
}

export type SessionStoreMeta = SessionStoreMetaV1 | SessionStoreMetaV2

export interface SessionStoreDocument {
  sessions: Record<string, StoredSession>
  meta: SessionStoreMeta
}

export function keyDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

/** Exact, key-bound durable generation used for compare-and-swap fencing. */
export function getStoredSessionGeneration(session: StoredSession, key: string): StoredSessionGeneration {
  const generationId =
    session.generationId ?? `legacy-${createHash("sha256").update(JSON.stringify(session)).digest("hex")}`
  return `p:${keyDigest(key)}:${generationId}`
}

export function isTranscriptLocator(value: unknown, expectedSessionId: string): value is TranscriptLocator {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const locator = value as Record<string, unknown>
  return (
    locator.sessionId === expectedSessionId &&
    typeof locator.configDir === "string" &&
    isAbsolute(locator.configDir) &&
    (locator.projectDir === undefined ||
      (typeof locator.projectDir === "string" && isAbsolute(locator.projectDir))) &&
    (locator.lifecycleGeneration === undefined ||
      (typeof locator.lifecycleGeneration === "string" && locator.lifecycleGeneration.length > 0))
  )
}

export function validateStoredSession(key: string, value: unknown): asserts value is StoredSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`session store entry ${JSON.stringify(key)} must be an object`)
  }
  const entry = value as Record<string, unknown>
  if (typeof entry.claudeSessionId !== "string" || entry.claudeSessionId.length === 0) {
    throw new Error(`session store entry ${JSON.stringify(key)} has an invalid Claude session ID`)
  }
  if (
    entry.revision !== undefined &&
    (typeof entry.revision !== "number" || !Number.isInteger(entry.revision) || entry.revision < 1)
  )
    throw new Error(`session store entry ${JSON.stringify(key)} has invalid revision`)
  if (
    entry.generationId !== undefined &&
    (typeof entry.generationId !== "string" || entry.generationId.length === 0)
  )
    throw new Error(`session store entry ${JSON.stringify(key)} has invalid generationId`)
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
  if (
    entry.sdkMessageUuids !== undefined &&
    (!Array.isArray(entry.sdkMessageUuids) ||
      entry.sdkMessageUuids.some((part) => part !== null && typeof part !== "string"))
  )
    throw new Error(`session store entry ${JSON.stringify(key)} has invalid sdkMessageUuids`)
  if (
    entry.passthroughToolCallAssistantUuid !== undefined &&
    typeof entry.passthroughToolCallAssistantUuid !== "string"
  ) {
    throw new Error(`session store entry ${JSON.stringify(key)} has invalid passthrough UUID`)
  }
  if (entry.previousClaudeSessionId !== undefined && typeof entry.previousClaudeSessionId !== "string") {
    throw new Error(`session store entry ${JSON.stringify(key)} has invalid previous Claude session ID`)
  }
  if (
    entry.currentTranscript !== undefined &&
    !isTranscriptLocator(entry.currentTranscript, entry.claudeSessionId)
  ) {
    throw new Error(`session store entry ${JSON.stringify(key)} has invalid current transcript locator`)
  }
  if (entry.previousTranscript !== undefined) {
    if (
      typeof entry.previousClaudeSessionId !== "string" ||
      !isTranscriptLocator(entry.previousTranscript, entry.previousClaudeSessionId)
    ) {
      throw new Error(`session store entry ${JSON.stringify(key)} has invalid previous transcript locator`)
    }
  }
}

export function hasExactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}


export function validatePriorityAssignment(routeKey: string, value: unknown): DurablePriorityAssignment {
  if (!routeKey || routeKey.length > 512 || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} is invalid`)
  }
  const assignment = value as Record<string, unknown>
  if (
    !hasExactObjectKeys(assignment, [
      "profileId",
      "lastHumanTurnDigest",
      "lastHumanTurnIssuedAt",
      "mappingKey",
      "mappingGeneration",
      "generationId",
      "updatedAt",
    ])
  ) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has unknown or missing fields`)
  }
  if (
    typeof assignment.profileId !== "string" ||
    !assignment.profileId ||
    assignment.profileId.length > 128
  ) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid profileId`)
  }
  if (
    typeof assignment.lastHumanTurnDigest !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(assignment.lastHumanTurnDigest)
  ) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid human-turn digest`)
  }
  if (
    typeof assignment.lastHumanTurnIssuedAt !== "number" ||
    !Number.isSafeInteger(assignment.lastHumanTurnIssuedAt) ||
    assignment.lastHumanTurnIssuedAt < 0
  ) {
    throw new Error(
      `session store priority route ${JSON.stringify(routeKey)} has invalid human-turn issue time`,
    )
  }
  if (
    typeof assignment.mappingKey !== "string" ||
    !assignment.mappingKey ||
    assignment.mappingKey.length > 1_024
  ) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid mappingKey`)
  }
  const expectedMappingPrefix =
    typeof assignment.mappingKey === "string" ? `p:${keyDigest(assignment.mappingKey)}:` : ""
  if (
    typeof assignment.mappingGeneration !== "string" ||
    !assignment.mappingGeneration.startsWith(expectedMappingPrefix) ||
    !isUuidV4(assignment.mappingGeneration.slice(expectedMappingPrefix.length))
  ) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid mapping generation`)
  }
  if (typeof assignment.generationId !== "string" || !isUuidV4(assignment.generationId)) {
    throw new Error(`session store priority route ${JSON.stringify(routeKey)} has invalid generationId`)
  }
  if (
    typeof assignment.updatedAt !== "number" ||
    !Number.isSafeInteger(assignment.updatedAt) ||
    assignment.updatedAt < 0
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

export function validatePriorityAttempt(routeKey: string, value: unknown): DurablePriorityAttempt {
  if (!routeKey || routeKey.length > 512 || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`session store priority attempt ${JSON.stringify(routeKey)} is invalid`)
  }
  const attempt = value as Record<string, unknown>
  if (
    !hasExactObjectKeys(attempt, [
      "blocked",
      "blockedTurnDigest",
      "blockedTurnIssuedAt",
      "pendingTurnDigest",
      "pendingTurnIssuedAt",
      "ownerToken",
      "generationId",
      "updatedAt",
    ])
  )
    throw new Error(
      `session store priority attempt ${JSON.stringify(routeKey)} has unknown or missing fields`,
    )
  const validDigest = (digest: unknown): digest is string | null =>
    digest === null || (typeof digest === "string" && /^[A-Za-z0-9_-]{43}$/.test(digest))
  const validIssuedAt = (issuedAt: unknown): issuedAt is number | null =>
    issuedAt === null || (typeof issuedAt === "number" && Number.isSafeInteger(issuedAt) && issuedAt >= 0)
  if (
    typeof attempt.blocked !== "boolean" ||
    !validDigest(attempt.blockedTurnDigest) ||
    !validIssuedAt(attempt.blockedTurnIssuedAt) ||
    !validDigest(attempt.pendingTurnDigest) ||
    !validIssuedAt(attempt.pendingTurnIssuedAt) ||
    (attempt.blockedTurnDigest === null) !== (attempt.blockedTurnIssuedAt === null) ||
    (attempt.pendingTurnDigest === null) !== (attempt.pendingTurnIssuedAt === null) ||
    (attempt.ownerToken !== null &&
      (typeof attempt.ownerToken !== "string" || !isUuidV4(attempt.ownerToken))) ||
    (attempt.ownerToken === null && attempt.pendingTurnDigest !== null) ||
    (!attempt.blocked && attempt.ownerToken === null)
  ) {
    throw new Error(`session store priority attempt ${JSON.stringify(routeKey)} has invalid state`)
  }
  if (typeof attempt.generationId !== "string" || !isUuidV4(attempt.generationId)) {
    throw new Error(`session store priority attempt ${JSON.stringify(routeKey)} has invalid generationId`)
  }
  if (
    typeof attempt.updatedAt !== "number" ||
    !Number.isSafeInteger(attempt.updatedAt) ||
    attempt.updatedAt < 0
  ) {
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

export function emptyStoreDocument(): SessionStoreDocument {
  return { sessions: {}, meta: { version: STORE_META_VERSION, slots: {} } }
}

export function validateStoreMeta(value: unknown): SessionStoreMeta {
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
    (meta.version !== STORE_META_VERSION && meta.version !== PRIORITY_STORE_META_VERSION) ||
    typeof meta.slots !== "object" ||
    meta.slots === null ||
    Array.isArray(meta.slots)
  ) {
    throw new Error("session store metadata has an unsupported format")
  }
  for (const [slot, counter] of Object.entries(meta.slots)) {
    if (
      !/^[0-9a-f]{4}$/.test(slot) ||
      typeof counter !== "number" ||
      !Number.isSafeInteger(counter) ||
      counter < 0
    ) {
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
  if (
    !hasExactObjectKeys(meta, [
      "version",
      "slots",
      "priorityAssignments",
      "priorityAttempts",
      "priorityRollbackMappings",
    ])
  ) {
    throw new Error("session store v3 metadata has unknown or missing fields")
  }
  if (
    typeof meta.priorityAssignments !== "object" ||
    meta.priorityAssignments === null ||
    Array.isArray(meta.priorityAssignments)
  )
    throw new Error("session store v3 metadata has invalid priority assignments")
  if (
    typeof meta.priorityAttempts !== "object" ||
    meta.priorityAttempts === null ||
    Array.isArray(meta.priorityAttempts)
  )
    throw new Error("session store v3 metadata has invalid priority attempts")
  if (
    typeof meta.priorityRollbackMappings !== "object" ||
    meta.priorityRollbackMappings === null ||
    Array.isArray(meta.priorityRollbackMappings)
  )
    throw new Error("session store v3 metadata has invalid priority rollback mappings")
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
    if (!priorityAssignments[routeKey] || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`session store priority rollback ${JSON.stringify(routeKey)} is invalid`)
    }
    const rollback = value as Record<string, unknown>
    if (
      !hasExactObjectKeys(rollback, ["mappingKey", "mappingGeneration"]) ||
      typeof rollback.mappingKey !== "string" ||
      !rollback.mappingKey ||
      rollback.mappingKey.length > 1_024
    ) {
      throw new Error(`session store priority rollback ${JSON.stringify(routeKey)} is invalid`)
    }
    const expectedMappingPrefix = `p:${keyDigest(rollback.mappingKey)}:`
    if (
      typeof rollback.mappingGeneration !== "string" ||
      !rollback.mappingGeneration.startsWith(expectedMappingPrefix) ||
      !isUuidV4(rollback.mappingGeneration.slice(expectedMappingPrefix.length))
    ) {
      throw new Error(
        `session store priority rollback ${JSON.stringify(routeKey)} has invalid mapping generation`,
      )
    }
    priorityRollbackMappings[routeKey] = {
      mappingKey: rollback.mappingKey,
      mappingGeneration: rollback.mappingGeneration,
    }
  }
  return {
    version: PRIORITY_STORE_META_VERSION,
    slots,
    priorityAssignments,
    priorityAttempts,
    priorityRollbackMappings,
  }
}

/** Parse and validate raw store bytes, for both the strict and the cached read. */
export function parseStoreDocument(data: string): SessionStoreDocument {
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
  if (meta.version === PRIORITY_STORE_META_VERSION) {
    for (const [routeKey, rollback] of Object.entries(meta.priorityRollbackMappings)) {
      const assignment = meta.priorityAssignments[routeKey]!
      const mapping = sessions[rollback.mappingKey]
      if (!mapping) {
        throw new Error(`session store priority rollback ${JSON.stringify(routeKey)} has no retained mapping`)
      }
      if (rollback.mappingKey === assignment.mappingKey) {
        throw new Error(
          `session store priority rollback ${JSON.stringify(routeKey)} aliases its current mapping`,
        )
      }
      if (getStoredSessionGeneration(mapping, rollback.mappingKey) !== rollback.mappingGeneration) {
        throw new Error(
          `session store priority rollback ${JSON.stringify(routeKey)} has a stale mapping generation`,
        )
      }
    }
  }
  return { sessions, meta }
}

export const SIDECAR_VERSION = 2

export type LegacyTranscriptResource = Omit<TranscriptResource, "generation">

export interface SessionGcSidecar {
  version: typeof SIDECAR_VERSION
  meta: { fenceSlots: Record<string, number> }
  resources: Record<string, TranscriptResource>
}

export function isValidActiveLeases(value: unknown): value is Record<string, ActiveTranscriptLeaseRecord> {
  if (!isRecord(value)) return false
  return Object.entries(value).every(
    ([token, lease]) =>
      token.length > 0 &&
      isRecord(lease) &&
      lease.token === token &&
      parseProcessIncarnation(lease.owner) !== undefined &&
      (lease.purpose === undefined || lease.purpose === "publication") &&
      (lease.purpose !== "publication" ||
        (lease.executor === undefined && lease.executorRecoverable === undefined)) &&
      (lease.executor === undefined || parseProcessIncarnation(lease.executor) !== undefined) &&
      (lease.executorRecoverable === undefined || typeof lease.executorRecoverable === "boolean") &&
      (lease.executorRecoverable === undefined || lease.executor !== undefined) &&
      isFiniteNumber(lease.createdAt),
  )
}

export function fenceSlotForKey(key: string): string {
  return key.slice(0, 4)
}

export function allocateLifecycleGeneration(sidecar: SessionGcSidecar, key: string): string {
  const slot = fenceSlotForKey(key)
  const current = sidecar.meta.fenceSlots[slot] ?? 0
  if (!Number.isSafeInteger(current) || current < 0 || current === Number.MAX_SAFE_INTEGER) {
    throw new SessionLifecycleCorruptError(`lifecycle fence slot ${slot} is exhausted or corrupt`)
  }
  const next = current + 1
  sidecar.meta.fenceSlots[slot] = next
  return `r:${key}:${next}`
}

export function lifecycleGenerationIsValid(value: unknown, key: string): value is string {
  if (typeof value !== "string") return false
  const prefix = `r:${key}:`
  if (!value.startsWith(prefix)) return false
  const counter = Number(value.slice(prefix.length))
  return Number.isSafeInteger(counter) && counter > 0
}

export function hasValidTranscriptResourceFields(
  value: unknown,
  key: string,
): value is Record<string, unknown> & LegacyTranscriptResource {
  if (!/^[a-f0-9]{64}$/.test(key) || !isRecord(value)) return false
  if (value.key !== key || !isValidLocator(value.locator)) return false
  if (getTranscriptResourceKey(value.locator) !== key || !isState(value.state)) return false
  if (!isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt)) return false
  if (typeof value.attempts !== "number" || !Number.isSafeInteger(value.attempts) || value.attempts < 0)
    return false
  if (value.nextAttemptAt !== undefined && !isFiniteNumber(value.nextAttemptAt)) return false
  if (value.lastError !== undefined && typeof value.lastError !== "string") return false
  if (value.deletionToken !== undefined && typeof value.deletionToken !== "string") return false
  if (value.deletionOwner !== undefined && !parseProcessIncarnation(value.deletionOwner)) return false
  if (value.deletionExecutor !== undefined && !parseProcessIncarnation(value.deletionExecutor)) return false
  if (
    value.deletionProcessGroupId !== undefined &&
    (typeof value.deletionProcessGroupId !== "number" ||
      !Number.isSafeInteger(value.deletionProcessGroupId) ||
      value.deletionProcessGroupId <= 0)
  )
    return false
  // Legacy deleting entries without exact owners/group identity remain permanently fenced.
  if (
    value.state !== "deleting" &&
    (value.deletionToken !== undefined ||
      value.deletionOwner !== undefined ||
      value.deletionExecutor !== undefined ||
      value.deletionProcessGroupId !== undefined)
  )
    return false
  if (value.deletionExecutor !== undefined && value.deletionOwner === undefined) return false
  if (value.deletionProcessGroupId !== undefined && value.deletionExecutor === undefined) return false
  return value.activeLeases === undefined || isValidActiveLeases(value.activeLeases)
}

export function upgradeLegacySidecar(value: unknown): unknown {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.resources)) return value
  const upgraded: SessionGcSidecar = {
    version: SIDECAR_VERSION,
    meta: { fenceSlots: {} },
    resources: {},
  }
  for (const [key, raw] of Object.entries(value.resources)) {
    if (!hasValidTranscriptResourceFields(raw, key)) return value
    const generation = allocateLifecycleGeneration(upgraded, key)
    upgraded.resources[key] = {
      ...raw,
      key,
      generation,
    }
  }
  return upgraded
}

export function isValidSidecar(value: unknown): value is SessionGcSidecar {
  if (
    !isRecord(value) ||
    value.version !== SIDECAR_VERSION ||
    !isRecord(value.meta) ||
    !isRecord(value.meta.fenceSlots) ||
    !isRecord(value.resources)
  )
    return false
  const meta = value.meta as { fenceSlots: Record<string, unknown> }
  if (
    !Object.entries(meta.fenceSlots).every(
      ([slot, counter]) =>
        /^[a-f0-9]{4}$/.test(slot) &&
        typeof counter === "number" &&
        Number.isSafeInteger(counter) &&
        counter > 0,
    )
  )
    return false
  return Object.entries(value.resources).every(([key, resource]) => {
    if (!hasValidTranscriptResourceFields(resource, key)) return false
    if (!lifecycleGenerationIsValid(resource.generation, key)) return false
    return (
      Number(meta.fenceSlots[fenceSlotForKey(key)] ?? 0) >=
      Number(resource.generation.slice(`r:${key}:`.length))
    )
  })
}

export function isValidLocator(value: unknown): value is TranscriptLocator {
  if (!isRecord(value)) return false
  return (
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.configDir === "string" &&
    isAbsolute(value.configDir) &&
    (value.projectDir === undefined ||
      (typeof value.projectDir === "string" && isAbsolute(value.projectDir))) &&
    (value.lifecycleGeneration === undefined ||
      (typeof value.lifecycleGeneration === "string" && value.lifecycleGeneration.length > 0)) &&
    Object.keys(value).every(
      (key) =>
        key === "sessionId" || key === "configDir" || key === "projectDir" || key === "lifecycleGeneration",
    )
  )
}

export function isState(value: unknown): value is TranscriptResourceState {
  return (
    value === "prepared" ||
    value === "live" ||
    value === "retired" ||
    value === "deleting" ||
    value === "deleted"
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}
