import { randomUUID } from "node:crypto"
import { checkParameters } from "./connection"
import { getMaxPriorityAssignmentsLimit, getMaxStoredSessionsLimit } from "../../sessionStore"
import { UUID_PATTERN } from "./legacyCodec"
import type { DurablePriorityAssignment } from "./legacyCodec"
import { readMapping, readMappingGeneration, writeMappingRow } from "./mappings"
import { readPriorityAssignment } from "./storePrioritySql"
import { advanceStoreSlot, canonicalMapping, prepareStoreLocator, pruneMappings } from "./storeMutationSupport"
import { withStoreWrite } from "./storeScope"
import type { BookkeepingTransaction, CanonicalStoredSession } from "./types"
import type { SharedSessionAndPriorityAssignmentOptions, SharedSessionAndPriorityAssignmentResult } from "./storeTypes"

export function writeAssignment(tx: BookkeepingTransaction, route: string, row: DurablePriorityAssignment): void {
  tx.run(`INSERT INTO priority_assignments VALUES(?,?,?,?,?,?,?,?,
    (SELECT coalesce(max(insertion_order),0)+1 FROM priority_assignments)) ON CONFLICT(route_key) DO UPDATE SET
    profile_id=excluded.profile_id,last_human_turn_digest=excluded.last_human_turn_digest,
    last_human_turn_issued_at=excluded.last_human_turn_issued_at,mapping_key=excluded.mapping_key,
    mapping_generation=excluded.mapping_generation,generation_id=excluded.generation_id,updated_at=excluded.updated_at`,
    route, row.profileId, row.lastHumanTurnDigest, row.lastHumanTurnIssuedAt, row.mappingKey,
    row.mappingGeneration, row.generationId, row.updatedAt)
}

function validate(options: SharedSessionAndPriorityAssignmentOptions): void {
  if (!options.key || options.key.length > 1024) throw new Error("priority publication requires a bounded mapping key")
  if (!options.priority.routeKey || options.priority.routeKey.length > 512)
    throw new Error("priority publication requires a bounded route key")
  if (!options.priority.profileId || options.priority.profileId.length > 128)
    throw new Error("priority publication requires a bounded profile ID")
  if (!/^[A-Za-z0-9_-]{43}$/.test(options.priority.lastHumanTurnDigest))
    throw new Error("priority publication requires a valid human-turn digest")
  if (!Number.isSafeInteger(options.priority.lastHumanTurnIssuedAt) || options.priority.lastHumanTurnIssuedAt < 0)
    throw new Error("priority publication requires a valid human-turn issue time")
  if (options.attemptOwnerToken !== undefined && !UUID_PATTERN.test(options.attemptOwnerToken))
    throw new Error("priority publication requires a valid attempt owner token")
  if (options.rollbackMappingKey !== undefined && (!options.rollbackMappingKey || options.rollbackMappingKey.length > 1024))
    throw new Error("priority publication requires a bounded rollback mapping key")
}

function pruneRoutes(tx: BookkeepingTransaction, route: string): boolean {
  const maxAssignments = getMaxPriorityAssignmentsLimit()
  const maxSessions = getMaxStoredSessionsLimit()
  const candidates = tx.all(`SELECT route_key FROM priority_assignments WHERE route_key<>?
    AND route_key NOT IN (SELECT route_key FROM priority_rollbacks)
    ORDER BY updated_at,CASE WHEN CAST(CAST(route_key AS INTEGER) AS TEXT)=route_key
      AND CAST(route_key AS INTEGER) BETWEEN 0 AND 4294967294 THEN CAST(route_key AS INTEGER) ELSE 4294967295 END,insertion_order`, route)
  let index = 0
  while (Number(tx.get("SELECT value FROM bookkeeping_counts WHERE kind='priority_assignments'")?.value) > maxAssignments
    || Number(tx.get("SELECT count(DISTINCT mapping_key) AS n FROM priority_assignments")?.n) > maxSessions) {
    const candidate = candidates[index++]
    if (!candidate) return false
    tx.run("DELETE FROM priority_assignments WHERE route_key=?", candidate.route_key!)
    advanceStoreSlot(tx, `priority:${candidate.route_key}`)
  }
  return true
}

export function storeSharedSessionAndPriorityAssignment(directory: string,
  options: SharedSessionAndPriorityAssignmentOptions): SharedSessionAndPriorityAssignmentResult | false {
  checkParameters([options.key, options.claudeSessionId, options.lineageHash, options.expectedMappingGeneration,
    options.rollbackMappingKey ?? null, options.attemptOwnerToken ?? null, options.priority.routeKey,
    options.priority.profileId, options.priority.lastHumanTurnDigest, options.priority.expectedAssignmentGeneration])
  validate(options)
  const current = prepareStoreLocator(directory, options.currentTranscript, options.claudeSessionId)
  const source = prepareStoreLocator(directory, options.sourceTranscript, undefined, "sourceTranscript")
  return withStoreWrite(directory, (tx) => {
    const key = options.key, route = options.priority.routeKey
    const actual = readMappingGeneration(tx, key)
    if (actual !== options.expectedMappingGeneration) return false
    const markers = tx.all("SELECT * FROM priority_rollbacks WHERE mapping_key=?", key)
    if (markers.some((row) => row.route_key !== route || row.mapping_generation !== actual)) return false
    const lookup = readPriorityAssignment(tx, route)
    if (lookup.status === "error") throw lookup.error
    if (lookup.generation !== options.priority.expectedAssignmentGeneration) return false
    if (options.attemptOwnerToken !== undefined
      ? lookup.attempt?.ownerToken !== options.attemptOwnerToken : !!lookup.attempt) return false
    const existingAssignment = lookup.status === "found" ? lookup.assignment : undefined
    const raw = readMapping(tx, key)
    const existing = raw ? canonicalMapping(tx, key, raw) : undefined
    const changed = existing !== undefined && existing.claudeSessionId !== options.claudeSessionId
    if (source && (!changed || source.sessionId !== existing?.claudeSessionId))
      throw new Error("sourceTranscript.sessionId must match the replaced claudeSessionId")
    const stored: CanonicalStoredSession = {
      claudeSessionId: options.claudeSessionId, revision: (existing?.revision ?? 0) + 1,
      generationId: randomUUID(), createdAt: existing?.createdAt || Date.now(), lastUsedAt: Date.now(),
      messageCount: options.messageCount, lineageHash: options.lineageHash, messageHashes: options.messageHashes,
      messageBlockHashes: options.messageBlockHashes, sdkMessageUuids: options.sdkMessageUuids,
      passthroughToolCallAssistantUuid: options.passthroughToolCallAssistantUuid ?? undefined,
      passthroughToolCallIds: options.passthroughToolCallIds ?? undefined, contextUsage: options.contextUsage,
      currentTranscript: changed ? current : existing?.currentTranscript ?? current,
      previousTranscript: changed ? existing?.currentTranscript ?? source : existing?.previousTranscript,
      previousClaudeSessionId: changed ? existing.claudeSessionId : existing?.previousClaudeSessionId,
    }
    writeMappingRow(tx, key, stored, true)
    advanceStoreSlot(tx, key)
    const mappingGeneration = readMappingGeneration(tx, key)
    tx.run("UPDATE schema_meta SET store_meta_version=3")
    const assignment: DurablePriorityAssignment = { profileId: options.priority.profileId,
      lastHumanTurnDigest: options.priority.lastHumanTurnDigest, lastHumanTurnIssuedAt: options.priority.lastHumanTurnIssuedAt,
      mappingKey: key, mappingGeneration, generationId: randomUUID(), updatedAt: Date.now() }
    writeAssignment(tx, route, assignment)
    const existingRollback = tx.get("SELECT * FROM priority_rollbacks WHERE route_key=?", route)
    const rollbackKey = options.rollbackMappingKey ?? existingAssignment?.mappingKey
    if (rollbackKey && rollbackKey !== key) {
      if (!tx.get("SELECT key FROM mappings WHERE key=?", rollbackKey))
        throw new Error("priority rollback mapping disappeared before publication")
      const rollbackGeneration = readMappingGeneration(tx, rollbackKey)
      if (existingAssignment?.mappingKey === rollbackKey && existingAssignment.mappingGeneration !== rollbackGeneration)
        return false
      if (existingRollback?.mapping_key !== rollbackKey)
        tx.run(`INSERT INTO priority_rollbacks VALUES(?,?,?) ON CONFLICT(route_key) DO UPDATE SET
          mapping_key=excluded.mapping_key,mapping_generation=excluded.mapping_generation`, route, rollbackKey, rollbackGeneration)
    } else tx.run("DELETE FROM priority_rollbacks WHERE route_key=?", route)
    advanceStoreSlot(tx, `priority:${route}`)
    if (!pruneRoutes(tx, route) || !pruneMappings(tx, getMaxStoredSessionsLimit(), key, true)) return false
    const published = readPriorityAssignment(tx, route)
    if (published.status === "error") throw published.error
    return { mappingGeneration, assignmentGeneration: published.generation,
      // Rollback joins the outer SQL admission and cannot resolve aliases there.
      // Snapshot both persisted canonical locators without rewriting imported raw history/CAS bytes.
      previousMapping: existing ? structuredClone(existing) : null,
      previousAssignment: existingAssignment ? structuredClone(existingAssignment) : null }
  })
}
