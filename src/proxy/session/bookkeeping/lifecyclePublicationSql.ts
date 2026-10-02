import type { SessionLifecycleOptions } from "../../sessionLifecycle"
import { SessionLifecycleError } from "../lifecycleErrors"
import { persistedCanonicalLocator, resourceKey } from "./locator"
import { allocateResource, readResource } from "./resources"
import { withBookkeepingWriteAsync } from "./transaction"
import { withPublicationLocators } from "./publicationLocators"
import { assertLocator, assertResourceCapacity, directoryFor, normalizeInput, nowMs,
  promoteLive, pruneTombstones } from "./lifecycleRowsSql"
import type { TranscriptLocator } from "./types"

export function publishPinnedTranscript<T extends boolean | string>(
  locator: TranscriptLocator, publish: () => T, options: SessionLifecycleOptions = {},
): Promise<T> {
  return updatePinnedTranscript(locator, publish, options, false)
}

export function attachPinnedTranscript<T extends boolean | string>(
  locator: TranscriptLocator, publish: () => T, options: SessionLifecycleOptions = {},
): Promise<T> {
  return updatePinnedTranscript(locator, publish, options, true)
}

async function updatePinnedTranscript<T extends boolean | string>(
  locator: TranscriptLocator, publish: () => T, options: SessionLifecycleOptions, allowMissing: boolean,
): Promise<T> {
  const normalized = normalizeInput(locator, options)
  const originalLocator = { ...locator }
  const key = resourceKey(normalized)
  const originalGeneration = locator.lifecycleGeneration
  const restore = () => {
    if (originalGeneration === undefined) delete locator.lifecycleGeneration
    else locator.lifecycleGeneration = originalGeneration
  }
  try {
    const result = await withBookkeepingWriteAsync(directoryFor(options), { ...options, scope: "publication" }, (tx) => {
      let resource = readResource(tx, key)
      let changed = false
      const now = nowMs(options)
      if (!resource) {
        if (!allowMissing) throw new SessionLifecycleError(`cannot publish unjournaled transcript ${key}`)
        assertResourceCapacity(tx, options, "live")
        const { lifecycleGeneration: _generation, ...physical } = normalized
        resource = allocateResource(tx, persistedCanonicalLocator(physical),
          { state: "live", createdAt: now, updatedAt: now, attempts: 0 })
        changed = true
      } else {
        assertLocator(resource, normalized, !allowMissing || normalized.lifecycleGeneration !== undefined)
        if (resource.state === "deleting" || resource.state === "deleted")
          throw new SessionLifecycleError(`cannot publish transcript ${key} from state ${resource.state}`)
        if (resource.state !== "live") {
          promoteLive(tx, resource, now)
          changed = true
        }
      }
      // JSON releases all publication owners, not only this process. Never release SDK writers.
      const leases = tx.all("SELECT token,owner_json FROM resource_leases WHERE resource_key=? AND purpose='publication'", key)
      for (const lease of leases) {
        const current = readResource(tx, key)!
        tx.run(`DELETE FROM resource_leases WHERE resource_key=? AND token=? AND owner_json=? AND purpose='publication'
          AND EXISTS(SELECT 1 FROM resources WHERE key=? AND generation=? AND row_version=?)`,
        key, lease.token!, lease.owner_json!, key, resource.generation, current.rowVersion)
        changed = true
      }
      if (changed) pruneTombstones(tx, options)
      locator.lifecycleGeneration = resource.generation
      // Mapping writes join this scope, including their durable pins and afterCommit hooks.
      // False rolls back the whole transaction; the engine also rejects thenable callbacks.
      return withPublicationLocators(directoryFor(options), originalLocator, normalized, publish)
    })
    if (result === false) restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
}

export const sqliteLifecyclePublication = { publishPinnedTranscript, attachPinnedTranscript }
