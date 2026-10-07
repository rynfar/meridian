import { randomUUID } from "node:crypto"
import { readMapping, readMappingGeneration, writeMappingRow } from "./mappings"
import { advanceStoreSlot, canonicalMapping, prepareStoreLocator, refreshMappingRoutes,
  rollbackProtected } from "./storeMutationSupport"
import { withStoreWrite } from "./storeScope"
import type { TranscriptLocator } from "./types"

export function attachSharedTranscriptLocator(directory: string, key: string, id: string,
  locator: TranscriptLocator, expectedGeneration?: string): string | false {
  const prepared = prepareStoreLocator(directory, locator, id)!
  return withStoreWrite(directory, (tx) => {
    if (rollbackProtected(tx, key)) return false
    const raw = readMapping(tx, key)
    if (!raw || raw.claudeSessionId !== id) return false
    const generation = readMappingGeneration(tx, key)
    if (expectedGeneration !== undefined && generation !== expectedGeneration) return false
    const existing = canonicalMapping(tx, key, raw)
    const current = existing.currentTranscript
    if (current?.sessionId === prepared.sessionId && current.configDir === prepared.configDir
      && current.projectDir === prepared.projectDir && current.lifecycleGeneration === prepared.lifecycleGeneration)
      return generation
    existing.currentTranscript = { ...prepared }
    existing.revision = (existing.revision ?? 0) + 1
    existing.generationId = randomUUID()
    writeMappingRow(tx, key, existing, true)
    advanceStoreSlot(tx, key)
    const attached = readMappingGeneration(tx, key)
    refreshMappingRoutes(tx, key, attached)
    return attached
  })
}

/** Match JSON: deleting a mapping does not revoke its route authority or pending attempt. */
export function evictSharedSession(directory: string, key: string, expectedGeneration?: string): boolean {
  return withStoreWrite(directory, (tx) => {
    if (!tx.get("SELECT key FROM mappings WHERE key=?", key)) return true
    if (expectedGeneration !== undefined && readMappingGeneration(tx, key) !== expectedGeneration) return false
    if (rollbackProtected(tx, key)) return false
    tx.run("DELETE FROM mappings WHERE key=?", key)
    advanceStoreSlot(tx, key)
    return true
  })
}

export function clearSharedSessions(directory: string): void {
  withStoreWrite(directory, (tx) => {
    for (const row of tx.all("SELECT key FROM mappings")) advanceStoreSlot(tx, String(row.key))
    tx.run("DELETE FROM mappings")
    for (const row of tx.all("SELECT route_key FROM priority_assignments"))
      advanceStoreSlot(tx, `priority:${row.route_key}`)
    tx.run("DELETE FROM priority_assignments")
    for (const row of tx.all("SELECT route_key FROM priority_attempts"))
      advanceStoreSlot(tx, `priority-attempt:${row.route_key}`)
    tx.run("DELETE FROM priority_attempts")
  })
}
