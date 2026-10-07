import type { SessionLifecycleOptions } from "../../sessionLifecycle"
import { SessionLifecycleError } from "../lifecycleErrors"
import { resourceKey } from "./locator"
import { allocateResource, readResource } from "./resources"
import { withBookkeepingRead, withBookkeepingWriteAsync } from "./transaction"
import { assertLocator, assertResourceCapacity, directoryFor, exactLocator, normalizeInput, nowMs,
  promoteLive, pruneTombstones } from "./lifecycleRowsSql"
import type { BookkeepingResource, TranscriptLocator } from "./types"

function inspect(resource: BookkeepingResource | undefined, locator: TranscriptLocator, register: boolean) {
  if (!resource) {
    if (locator.lifecycleGeneration !== undefined)
      throw new SessionLifecycleError(`stale lifecycle generation for missing transcript ${resourceKey(locator)}`)
    return undefined
  }
  assertLocator(resource, locator, locator.lifecycleGeneration !== undefined)
  if (resource.state === "deleting" || resource.state === "deleted")
    throw new SessionLifecycleError(`cannot ${register ? "register" : "journal"} transcript ${resource.key} from state ${resource.state}`)
  return !register || resource.state === "live" ? exactLocator(resource) : undefined
}

async function journal(locator: TranscriptLocator, options: SessionLifecycleOptions, register: boolean) {
  const normalized = normalizeInput(locator, options)
  const key = resourceKey(normalized)
  const directory = directoryFor(options)
  // The read is the linearization point for an already matching row: no BEGIN IMMEDIATE or DML.
  const unchanged = withBookkeepingRead(directory, (reader) => inspect(readResource(reader, key), normalized, register))
  const result = unchanged ?? await withBookkeepingWriteAsync(directory, options, (tx) => {
    const resource = readResource(tx, key)
    const unchanged = inspect(resource, normalized, register)
    if (unchanged) return unchanged
    if (resource) {
      promoteLive(tx, resource, nowMs(options))
      return exactLocator(resource)
    }
    assertResourceCapacity(tx, options, "live")
    const now = nowMs(options)
    const created = allocateResource(tx, normalized, { state: "live", createdAt: now, updatedAt: now, attempts: 0 })
    pruneTombstones(tx, options)
    return exactLocator(created)
  })
  Object.assign(locator, result)
  return result
}

export function ensureTranscriptJournaled(locator: TranscriptLocator,
  options: SessionLifecycleOptions = {}): Promise<TranscriptLocator> {
  return journal(locator, options, false)
}

export function registerLiveTranscript(locator: TranscriptLocator,
  options: SessionLifecycleOptions = {}): Promise<TranscriptLocator> {
  return journal(locator, options, true)
}

export const sqliteLifecycleRegister = { ensureTranscriptJournaled, registerLiveTranscript }
