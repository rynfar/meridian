import { randomUUID } from "node:crypto"
import type { ActiveTranscriptLease, SessionLifecycleOptions } from "../../sessionLifecycle"
import { getSessionStoreDir } from "../../sessionStore"
import { SessionLifecycleError, SessionLifecycleCorruptError, SessionLifecycleLockError,
  SessionLifecycleReentrancyError } from "../lifecycleErrors"
import { captureProcessIncarnation, parseProcessIncarnation, processIncarnationIsDead,
  processIncarnationPredatesBoot, type ProcessIncarnation } from "../processIncarnation"
import { canonicalizeLocator, resourceKey } from "./locator"
import { checkParameters, connectionFor } from "./connection"
import { withBookkeepingRead, withBookkeepingWriteAsync } from "./transaction"
import { insertResourceLease, readResource, readResourceLease } from "./resources"
import type { TranscriptLocator, SqlRow } from "./types"

const directoryFor = (options: SessionLifecycleOptions): string => options.storeDir || getSessionStoreDir()
const deferred = new Map<string, Map<string, ActiveTranscriptLease>>()

function nowMs(options: SessionLifecycleOptions): number {
  const value = (options.now ?? Date.now)()
  if (!Number.isFinite(value)) throw new TypeError("now() must return a finite number")
  return value
}

function validateLease(lease: ActiveTranscriptLease): void {
  checkParameters([lease.token, ...lease.resourceKeys])
}

/** Snapshot carries every predicate whose death/age observation will be used after admission. */
function observedDead(directory: string, keys: readonly string[], now: number, ttl: number): SqlRow[] {
  const snapshots = withBookkeepingRead(directory, (reader) => keys.flatMap((key) => reader.all(
    `SELECT l.*,r.row_version,r.generation FROM resource_leases l
      JOIN resources r ON r.key=l.resource_key WHERE l.resource_key=?`, key,
  )))
  // The read transaction has ended before any incarnation probe (including ps/PowerShell).
  return snapshots.filter((row) => {
    if (row.executor_json !== null) {
      const executor = parseProcessIncarnation(JSON.parse(String(row.executor_json)))
      if (!executor) throw new SessionLifecycleCorruptError("invalid active transcript executor incarnation")
      return row.executor_recoverable === 0
        ? processIncarnationPredatesBoot(executor) : processIncarnationIsDead(executor)
    }
    if (now - Number(row.created_at) > ttl) return true
    const owner = parseProcessIncarnation(JSON.parse(String(row.owner_json)))
    if (!owner) throw new SessionLifecycleCorruptError("invalid active transcript owner incarnation")
    return processIncarnationIsDead(owner)
  })
}

export async function acquireActiveTranscriptLease(
  locators: readonly TranscriptLocator[], options: SessionLifecycleOptions = {},
): Promise<ActiveTranscriptLease> {
  const directory = directoryFor(options)
  // No filesystem canonicalization or process observation may run inside an outer SQL scope.
  if (connectionFor(directory).scope) throw new SessionLifecycleReentrancyError("active lease acquisition requires outside-transaction observation")
  for (const locator of locators) checkParameters(Object.values(locator).filter((v): v is string => typeof v === "string"))
  const normalized = [...new Map(locators.map((locator) => canonicalizeLocator(locator))
    .map((locator) => [resourceKey(locator), locator])).entries()]
  if (!normalized.length) throw new TypeError("active transcript lease requires at least one locator")
  const owner = captureProcessIncarnation()
  if (!owner) throw new SessionLifecycleError("cannot capture active transcript owner incarnation")
  const ttl = options.unarmedLeaseTtlMs ?? 11 * 60_000
  if (!Number.isSafeInteger(ttl) || ttl < 0) throw new TypeError("unarmedLeaseTtlMs must be a non-negative integer")
  const token = randomUUID()
  const dead = observedDead(directory, normalized.map(([key]) => key), nowMs(options), ttl)
  await withBookkeepingWriteAsync(directory, options, (tx) => {
    for (const [key, locator] of normalized) {
      const resource = readResource(tx, key)
      if (!resource) throw new SessionLifecycleError(`cannot lease unjournaled transcript ${key}`)
      if (resource.locator.configDir !== locator.configDir || resource.locator.projectDir !== locator.projectDir
        || resource.locator.sessionId !== locator.sessionId)
        throw new SessionLifecycleCorruptError("resource key collision or locator mismatch")
      if (resource.generation !== locator.lifecycleGeneration)
        throw new SessionLifecycleError(`stale or missing lifecycle generation for transcript ${key}`)
      const eligible = dead.filter((row) => row.resource_key === key && row.row_version === resource.rowVersion
        && row.generation === resource.generation)
      for (const row of eligible) {
        // Lease triggers advance row_version; each deletion rechecks the freshly read version while
        // full owner/executor/token predicates prevent applying an observation to a replaced lease.
        const version = readResource(tx, key)!.rowVersion
        tx.run(`DELETE FROM resource_leases WHERE resource_key=? AND token=? AND owner_json=?
          AND executor_json IS ? AND executor_recoverable IS ? AND purpose IS ? AND created_at=?
          AND EXISTS(SELECT 1 FROM resources WHERE key=? AND generation=? AND row_version=?)`,
        key, String(row.token), String(row.owner_json), row.executor_json!, row.executor_recoverable!,
        row.purpose!, row.created_at!, key, resource.generation, version)
      }
      if (tx.get("SELECT token FROM resource_leases WHERE resource_key=? AND purpose IS NOT 'publication' LIMIT 1", key))
        throw new SessionLifecycleError(`transcript ${key} already has an active SDK writer`)
      if (resource.state === "deleting" || resource.state === "deleted")
        throw new SessionLifecycleError(`cannot lease transcript ${key} from state ${resource.state}`)
      insertResourceLease(tx, key, { token, owner, createdAt: nowMs(options) })
    }
  })
  return { token, resourceKeys: normalized.map(([key]) => key) }
}

export async function attachActiveTranscriptExecutor(
  lease: ActiveTranscriptLease, executor: ProcessIncarnation, options: SessionLifecycleOptions = {},
  executorRecoverable = true,
): Promise<void> {
  validateLease(lease)
  const parsed = parseProcessIncarnation(executor)
  if (!parsed) throw new TypeError("invalid active transcript executor incarnation")
  await withBookkeepingWriteAsync(directoryFor(options), options, (tx) => {
    for (const key of lease.resourceKeys) {
      const record = readResourceLease(tx, key, lease.token)
      if (!record) throw new SessionLifecycleError(`active transcript lease ${lease.token} was lost`)
      if (record.purpose === "publication") throw new SessionLifecycleError("cannot arm a publication lease")
      const version = readResource(tx, key)!.rowVersion
      tx.run(`UPDATE resource_leases SET executor_json=?,executor_recoverable=? WHERE resource_key=? AND token=?
        AND EXISTS(SELECT 1 FROM resources WHERE key=? AND row_version=?)`,
      JSON.stringify(parsed), Number(executorRecoverable), key, lease.token, key, version)
    }
  })
}

export async function releaseActiveTranscriptLease(
  lease: ActiveTranscriptLease, options: SessionLifecycleOptions = {},
): Promise<void> {
  validateLease(lease)
  await withBookkeepingWriteAsync(directoryFor(options), options, (tx) => {
    for (const key of lease.resourceKeys) {
      const resource = readResource(tx, key)
      if (!resource) continue
      tx.run(`DELETE FROM resource_leases WHERE resource_key=? AND token=?
        AND EXISTS(SELECT 1 FROM resources WHERE key=? AND row_version=?)`, key, lease.token, key, resource.rowVersion)
    }
  })
}

export async function releaseJoinedTranscriptLease(
  lease: ActiveTranscriptLease, options: SessionLifecycleOptions = {},
): Promise<void> {
  try {
    await releaseActiveTranscriptLease(lease, options)
  } catch (error) {
    if (!(error instanceof SessionLifecycleLockError)) throw error
    const path = connectionFor(directoryFor(options)).path
    let pending = deferred.get(path)
    if (!pending) deferred.set(path, pending = new Map())
    pending.set(lease.token, { token: lease.token, resourceKeys: [...lease.resourceKeys] })
  }
}

/** GC must call this before its sweep, including shutdown; records are removed only after COMMIT. */
export async function retryDeferredLeaseReleases(options: SessionLifecycleOptions = {}): Promise<void> {
  const path = connectionFor(directoryFor(options)).path
  const pending = deferred.get(path)
  if (!pending) return
  for (const lease of pending.values()) {
    await releaseActiveTranscriptLease(lease, options)
    pending.delete(lease.token)
  }
  if (!pending.size) deferred.delete(path)
}

export const sqliteLifecycleLeases = {
  acquireActiveTranscriptLease, attachActiveTranscriptExecutor, releaseActiveTranscriptLease, releaseJoinedTranscriptLease,
}
