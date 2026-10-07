import { randomUUID } from "node:crypto"
import { connectionFor, checkParameters } from "./connection"
import { canonicalizeLocator, persistedCanonicalLocator, validateLocator } from "./locator"
import { mappingDigest, MAPPING_OBJECT_ORDER } from "./mappingMetadata"
import { observedPublicationLocator } from "./publicationLocators"
import type { BookkeepingReader, BookkeepingTransaction, CanonicalStoredSession, StoredSession,
  CanonicalTranscriptLocator, TranscriptLocator } from "./types"

export function advanceStoreSlot(tx: BookkeepingTransaction, key: string): void {
  tx.run(`INSERT INTO fence_slots VALUES('store',?,1)
    ON CONFLICT(namespace,slot) DO UPDATE SET counter=counter+1`, mappingDigest(key).slice(0, 4))
}

export function rollbackProtected(reader: BookkeepingReader, key: string): boolean {
  return !!reader.get("SELECT route_key FROM priority_rollbacks WHERE mapping_key=? LIMIT 1", key)
}

/** A publication scope has already prepared its locators; never realpath while holding its SQL lock. */
export function prepareStoreLocator(directory: string, locator: TranscriptLocator | undefined,
  sessionId?: string, label = "currentTranscript"): CanonicalTranscriptLocator | undefined {
  if (!locator) return undefined
  for (const value of Object.values(locator)) {
    if (typeof value === "string") checkParameters([value])
  }
  try { validateLocator(locator) } catch (error) {
    if (error instanceof TypeError) throw new TypeError(`${label}.${error.message}`, { cause: error })
    throw error
  }
  if (sessionId !== undefined && locator.sessionId !== sessionId)
    throw new Error("currentTranscript.sessionId must match claudeSessionId")
  const observed = observedPublicationLocator(directory, locator)
  return connectionFor(directory).scope
    ? persistedCanonicalLocator(observed) : canonicalizeLocator(locator)
}

/** Read canonical projection columns even for imported entries whose raw history preserves an alias. */
export function canonicalMapping(reader: BookkeepingReader, key: string, entry: StoredSession): CanonicalStoredSession {
  const row = reader.get("SELECT current_locator_json,previous_locator_json FROM mappings WHERE key=?", key)
  const result: CanonicalStoredSession = { ...entry, currentTranscript: undefined, previousTranscript: undefined }
  for (const [property, column] of [["currentTranscript", "current_locator_json"],
    ["previousTranscript", "previous_locator_json"]] as const) {
    if (row?.[column] != null)
      result[property] = persistedCanonicalLocator(JSON.parse(String(row[column])) as TranscriptLocator)
  }
  return result
}

export function refreshMappingRoutes(tx: BookkeepingTransaction, key: string, generation: string): void {
  for (const row of tx.all("SELECT route_key FROM priority_assignments WHERE mapping_key=?", key)) {
    tx.run(`UPDATE priority_assignments SET mapping_generation=?,generation_id=?,updated_at=? WHERE route_key=?`,
      generation, randomUUID(), Date.now(), row.route_key!)
    advanceStoreSlot(tx, `priority:${row.route_key}`)
  }
}

/** Ordinary writes reject an over-cap protected set; publication may retain its rollback backlog. */
export function pruneMappings(tx: BookkeepingTransaction, limit: number, protectedKey?: string,
  retainProtected = false): boolean {
  const protectedKeys = new Set(tx.all(`SELECT mapping_key FROM priority_assignments
    UNION SELECT mapping_key FROM priority_rollbacks`).map((row) => String(row.mapping_key)))
  if (protectedKey !== undefined) protectedKeys.add(protectedKey)
  const keys = tx.all(`SELECT key FROM mappings ORDER BY last_used_at,${MAPPING_OBJECT_ORDER}`)
    .map((row) => String(row.key))
  const retained = retainProtected ? Math.max(limit, keys.filter((key) => protectedKeys.has(key)).length) : limit
  const removeCount = Math.max(0, keys.length - retained)
  const removable = keys.filter((key) => !protectedKeys.has(key))
  if (removable.length < removeCount) return false
  for (const key of removable.slice(0, removeCount)) {
    tx.run("DELETE FROM mappings WHERE key=?", key)
    advanceStoreSlot(tx, key)
  }
  return true
}
