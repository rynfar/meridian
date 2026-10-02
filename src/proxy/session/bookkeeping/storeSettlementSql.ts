import { randomUUID } from "node:crypto"
import { checkParameters } from "./connection"
import { getMaxStoredSessionsLimit } from "../../sessionStore"
import { readMappingGeneration, writeMappingRow } from "./mappings"
import { persistedCanonicalLocator } from "./locator"
import { readPriorityAssignment } from "./storePrioritySql"
import { writeAssignment } from "./storePublicationSql"
import { advanceStoreSlot, prepareStoreLocator, pruneMappings } from "./storeMutationSupport"
import { withStoreWrite } from "./storeScope"
import type { FinalizeSharedSessionAndPriorityAssignmentOptions, RollbackSharedSessionAndPriorityAssignmentOptions,
  RollbackSharedSessionAndPriorityAssignmentResult } from "./storeTypes"
import type { CanonicalStoredSession } from "./types"
import type { DurablePriorityAssignment } from "./legacyCodec"

export function finalizeSharedSessionAndPriorityAssignment(directory: string,
  options: FinalizeSharedSessionAndPriorityAssignmentOptions): boolean {
  checkParameters([options.key, options.routeKey, options.expectedMappingGeneration,
    options.expectedAssignmentGeneration, options.rollbackMappingKey ?? null, options.attemptOwnerToken ?? null])
  return withStoreWrite(directory, (tx) => {
    if (readMappingGeneration(tx, options.key) !== options.expectedMappingGeneration) return false
    const lookup = readPriorityAssignment(tx, options.routeKey)
    if (lookup.status !== "found" || lookup.generation !== options.expectedAssignmentGeneration) return false
    const rollback = tx.get("SELECT mapping_key FROM priority_rollbacks WHERE route_key=?", options.routeKey)
    if (rollback?.mapping_key !== options.rollbackMappingKey) return false
    if (options.attemptOwnerToken !== undefined
      ? lookup.attempt?.ownerToken !== options.attemptOwnerToken : !!lookup.attempt) return false
    tx.run("DELETE FROM priority_rollbacks WHERE route_key=?", options.routeKey)
    if (options.attemptOwnerToken !== undefined) {
      tx.run("DELETE FROM priority_attempts WHERE route_key=?", options.routeKey)
      advanceStoreSlot(tx, `priority-attempt:${options.routeKey}`)
    }
    writeAssignment(tx, options.routeKey, { ...lookup.assignment, generationId: randomUUID(), updatedAt: Date.now() })
    advanceStoreSlot(tx, `priority:${options.routeKey}`)
    return pruneMappings(tx, getMaxStoredSessionsLimit(), undefined, true)
  })
}

export function rollbackSharedSessionAndPriorityAssignment(directory: string,
  options: RollbackSharedSessionAndPriorityAssignmentOptions): RollbackSharedSessionAndPriorityAssignmentResult | false {
  checkParameters([options.key, options.routeKey, options.expectedMappingGeneration,
    options.expectedAssignmentGeneration, options.attemptOwnerToken ?? null])
  // Preparation occurs outside our own SQL transaction; a joined caller supplies canonical locators.
  const previous = options.previousMapping ? structuredClone(options.previousMapping) : null
  const current = prepareStoreLocator(directory, previous?.currentTranscript)
  const prior = prepareStoreLocator(directory, previous?.previousTranscript)
  return withStoreWrite(directory, (tx) => {
    if (tx.get("SELECT store_meta_version FROM schema_meta")?.store_meta_version !== 3) return false
    if (readMappingGeneration(tx, options.key) !== options.expectedMappingGeneration) return false
    const lookup = readPriorityAssignment(tx, options.routeKey)
    if (lookup.status === "error") throw lookup.error
    if (lookup.generation !== options.expectedAssignmentGeneration) return false
    if (options.attemptOwnerToken !== undefined
      ? lookup.attempt?.ownerToken !== options.attemptOwnerToken : !!lookup.attempt) return false
    const expected = options.previousAssignment && options.previousAssignment.mappingKey !== options.key
      ? options.previousAssignment : undefined
    const actual = tx.get("SELECT * FROM priority_rollbacks WHERE route_key=?", options.routeKey)
    if (actual?.mapping_key !== expected?.mappingKey || actual?.mapping_generation !== expected?.mappingGeneration) return false
    let restoredMapping: CanonicalStoredSession | null = null
    if (previous) {
      restoredMapping = { ...previous, revision: (previous.revision ?? 0) + 1, generationId: randomUUID(),
        currentTranscript: current ? persistedCanonicalLocator(current) : undefined,
        previousTranscript: prior ? persistedCanonicalLocator(prior) : undefined }
      writeMappingRow(tx, options.key, restoredMapping, true)
    } else tx.run("DELETE FROM mappings WHERE key=?", options.key)
    advanceStoreSlot(tx, options.key)
    const mappingGeneration = readMappingGeneration(tx, options.key)
    let restoredAssignment: DurablePriorityAssignment | null = null
    if (options.previousAssignment) {
      restoredAssignment = { ...structuredClone(options.previousAssignment),
        mappingGeneration: options.previousAssignment.mappingKey === options.key
          ? mappingGeneration : options.previousAssignment.mappingGeneration,
        generationId: randomUUID(), updatedAt: Date.now() }
      writeAssignment(tx, options.routeKey, restoredAssignment)
    } else tx.run("DELETE FROM priority_assignments WHERE route_key=?", options.routeKey)
    tx.run("DELETE FROM priority_rollbacks WHERE route_key=?", options.routeKey)
    advanceStoreSlot(tx, `priority:${options.routeKey}`)
    const restored = readPriorityAssignment(tx, options.routeKey)
    if (restored.status === "error") throw restored.error
    return { mappingGeneration, assignmentGeneration: restored.generation, restoredMapping, restoredAssignment }
  })
}
