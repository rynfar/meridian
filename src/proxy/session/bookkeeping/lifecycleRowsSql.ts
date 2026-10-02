import type { SessionLifecycleOptions } from "../../sessionLifecycle"
import { getMaxStoredSessionsLimit, getSessionStoreDir } from "../../sessionStore"
import { SessionLifecycleBacklogError, SessionLifecycleCorruptError, SessionLifecycleError,
  SessionLifecycleReentrancyError } from "../lifecycleErrors"
import { checkParameters, connectionFor } from "./connection"
import { canonicalizeLocator } from "./locator"
import type { BookkeepingReader, BookkeepingResource, BookkeepingTransaction, TranscriptLocator } from "./types"

export const directoryFor = (options: SessionLifecycleOptions): string => options.storeDir || getSessionStoreDir()

export function normalizeInput(locator: TranscriptLocator, options: SessionLifecycleOptions) {
  if (connectionFor(directoryFor(options)).scope)
    throw new SessionLifecycleReentrancyError("lifecycle input requires outside-transaction observation")
  checkParameters(Object.values(locator).filter((value): value is string => typeof value === "string"))
  return canonicalizeLocator(locator)
}

export function nowMs(options: SessionLifecycleOptions): number {
  const value = (options.now ?? Date.now)()
  if (!Number.isFinite(value)) throw new TypeError("now() must return a finite number")
  return value
}

export function positiveOption(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive integer`)
  return result
}

export function assertLocator(resource: BookkeepingResource, locator: TranscriptLocator, exact: boolean): void {
  if (resource.locator.configDir !== locator.configDir || resource.locator.projectDir !== locator.projectDir
    || resource.locator.sessionId !== locator.sessionId)
    throw new SessionLifecycleCorruptError("resource key collision or locator mismatch")
  if (exact && resource.generation !== locator.lifecycleGeneration)
    throw new SessionLifecycleError(`stale or missing lifecycle generation for transcript ${resource.key}`)
}

export function exactLocator(resource: BookkeepingResource): TranscriptLocator {
  return { ...resource.locator, lifecycleGeneration: resource.generation }
}

export function pendingCount(reader: BookkeepingReader): number {
  return Number(reader.get(`SELECT sum(value) AS n FROM bookkeeping_counts
    WHERE kind IN ('resources:prepared','resources:retired','resources:deleting')`)!.n)
}

export function assertPendingCapacity(reader: BookkeepingReader, options: SessionLifecycleOptions): void {
  if (pendingCount(reader) >= positiveOption(options.maxPending, 256, "maxPending"))
    throw new SessionLifecycleBacklogError("session transcript ownership backlog is full")
}

export function assertResourceCapacity(reader: BookkeepingReader, options: SessionLifecycleOptions,
  state: "prepared" | "live"): void {
  const pending = positiveOption(options.maxPending, 256, "maxPending")
  const maximum = positiveOption(options.maxOwned,
    Math.min(Number.MAX_SAFE_INTEGER, getMaxStoredSessionsLimit() * 2 + pending), "maxOwned")
  const owned = Number(reader.get(`SELECT sum(value) AS n FROM bookkeeping_counts
    WHERE kind IN ('resources:prepared','resources:live','resources:retired','resources:deleting')`)!.n)
  if (owned >= maximum) throw new SessionLifecycleBacklogError("session transcript ownership capacity is full")
  if (state === "prepared") assertPendingCapacity(reader, options)
}

export function promoteLive(tx: BookkeepingTransaction, resource: BookkeepingResource, now: number): void {
  tx.run(`UPDATE resources SET state='live',updated_at=?,next_attempt_at=NULL,last_error=NULL,
    row_version=row_version+1 WHERE key=? AND generation=? AND row_version=? AND state=?`,
  now, resource.key, resource.generation, resource.rowVersion, resource.state)
}

export function pruneTombstones(tx: BookkeepingTransaction, options: SessionLifecycleOptions): void {
  const maximum = positiveOption(options.maxTombstones, 256, "maxTombstones")
  // Keys are lowercase hexadecimal: BINARY ordering equals the legacy localeCompare tie-break.
  tx.run(`DELETE FROM resources WHERE key IN (SELECT key FROM resources WHERE state='deleted'
    ORDER BY updated_at DESC,key LIMIT -1 OFFSET ?)`, maximum)
}
