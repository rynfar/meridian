import { randomUUID } from "node:crypto"
import { sessionDeletionRuntime as runtime, type GcResult, type SessionLifecycleOptions } from "../../sessionLifecycle"
import { captureProcessIncarnation, parseProcessIncarnation, type ProcessIncarnation } from "../processIncarnation"
import { SessionLifecycleError, SessionLifecycleReentrancyError } from "../lifecycleErrors"
import { checkParameters, connectionFor } from "./connection"
import { canonicalizeLocator, resourceKey } from "./locator"
import { PIN_LOOKUP_SQL } from "./mappings"
import { readResource, readRetiredPage } from "./resources"
import { directoryFor, nowMs, positiveOption, pruneTombstones } from "./lifecycleRowsSql"
import { retryDeferredLeaseReleases } from "./lifecycleLeasesSql"
import { withBookkeepingRead, withBookkeepingWriteAsync } from "./transaction"
import type { BookkeepingResource, TranscriptLocator } from "./types"

function outsideScope(options: SessionLifecycleOptions): void {
  if (connectionFor(directoryFor(options)).scope)
    throw new SessionLifecycleReentrancyError("deletion requires outside-transaction observation")
}

function indexPins(pins: readonly TranscriptLocator[], options: SessionLifecycleOptions) {
  outsideScope(options)
  const result = new Map<string, Set<string | undefined>>()
  const paths = new Map<string, string>()
  for (const pin of pins) {
    checkParameters(Object.values(pin).filter((value): value is string => typeof value === "string"))
    const normalized = canonicalizeLocator(pin, paths)
    const key = resourceKey(normalized)
    let generations = result.get(key)
    if (!generations) result.set(key, generations = new Set())
    generations.add(normalized.lifecycleGeneration)
  }
  return result
}

function ephemeralPin(resource: BookkeepingResource, pins: ReturnType<typeof indexPins>): boolean {
  const generations = pins.get(resource.key)
  return generations !== undefined && (generations.has(undefined) || generations.has(resource.generation))
}

/** Claim only already-retired rows. Dead-lease observations/pruning belong to the preceding sweep. */
export async function claimDeletion(pins: readonly TranscriptLocator[], options: SessionLifecycleOptions = {}) {
  outsideScope(options)
  const finalPins = indexPins(options.pinProvider?.() ?? pins, options)
  const owner = captureProcessIncarnation()
  const token = randomUUID()
  return withBookkeepingWriteAsync(directoryFor(options), options, (tx) => {
    const now = nowMs(options)
    let afterTime = Number.MIN_SAFE_INTEGER
    let afterKey = ""
    while (true) {
      const page = readRetiredPage(tx, afterTime, afterKey, 128)
      for (const row of page) {
        const resource = readResource(tx, String(row.key))!
        if ((resource.nextAttemptAt ?? 0) > now || ephemeralPin(resource, finalPins)
          || tx.get(PIN_LOOKUP_SQL, resource.key, resource.generation)
          || tx.get("SELECT token FROM resource_leases WHERE resource_key=? LIMIT 1", resource.key)) continue
        if (!owner) throw new SessionLifecycleError("cannot capture deletion owner process incarnation")
        const changed = tx.run(`UPDATE resources SET state='deleting',updated_at=?,deletion_token=?,
          deletion_owner_json=?,deletion_executor_json=NULL,deletion_process_group_id=NULL,row_version=row_version+1
          WHERE key=? AND generation=? AND row_version=? AND state='retired'`,
        now, token, JSON.stringify(owner), resource.key, resource.generation, resource.rowVersion)
        if (changed !== 1) throw new SessionLifecycleError(`deletion claim for ${resource.key} was lost`)
        return readResource(tx, resource.key)
      }
      if (page.length < 128) return undefined
      afterTime = Number(page.at(-1)!.updated_at)
      afterKey = String(page.at(-1)!.key)
    }
  })
}

export async function attachDeletionExecutor(key: string, token: string, executor: ProcessIncarnation,
  processGroupId: number, options: SessionLifecycleOptions = {}): Promise<void> {
  checkParameters([key, token, ...Object.values(executor)])
  const parsed = parseProcessIncarnation(executor)
  if (!parsed || !Number.isSafeInteger(processGroupId) || processGroupId <= 0)
    throw new TypeError("invalid deletion executor incarnation/process group")
  await withBookkeepingWriteAsync(directoryFor(options), options, (tx) => {
    const resource = readResource(tx, key)
    if (!resource || resource.state !== "deleting" || resource.deletionToken !== token)
      throw new SessionLifecycleError(`deletion lease for ${key} was lost before executor handshake`)
    const changed = tx.run(`UPDATE resources SET deletion_executor_json=?,deletion_process_group_id=?,
      updated_at=?,row_version=row_version+1 WHERE key=? AND generation=? AND row_version=?
      AND state='deleting' AND deletion_token=? AND deletion_owner_json IS ?`,
    JSON.stringify(parsed), processGroupId, nowMs(options), key, resource.generation, resource.rowVersion,
    token, resource.deletionOwner ? JSON.stringify(resource.deletionOwner) : null)
    if (changed !== 1) throw new SessionLifecycleError(`deletion lease for ${key} was lost before executor handshake`)
  })
}

export async function finishDeletion(key: string, token: string, failure: unknown,
  options: SessionLifecycleOptions = {}): Promise<void> {
  checkParameters([key, token])
  await withBookkeepingWriteAsync(directoryFor(options), options, (tx) => {
    const resource = readResource(tx, key)
    if (!resource || resource.state !== "deleting" || resource.deletionToken !== token)
      throw new SessionLifecycleError(`deletion lease for ${key} was lost`)
    const now = nowMs(options)
    const attempts = resource.attempts + (failure ? 1 : 0)
    const delay = failure ? Math.min(positiveOption(options.retryMaxMs, runtime.retryMaxMs, "retryMaxMs"),
      positiveOption(options.retryBaseMs, runtime.retryBaseMs, "retryBaseMs") * 2 ** Math.min(attempts - 1, 20)) : 0
    const error = failure ? (failure instanceof Error ? failure.message : String(failure)).slice(0, 1000) : null
    const changed = tx.run(`UPDATE resources SET state=?,updated_at=?,attempts=?,next_attempt_at=?,last_error=?,
      deletion_token=NULL,deletion_owner_json=NULL,deletion_executor_json=NULL,deletion_process_group_id=NULL,
      row_version=row_version+1 WHERE key=? AND generation=? AND row_version=? AND state='deleting'
      AND deletion_token=? AND deletion_owner_json IS ?`,
    failure ? "retired" : "deleted", now, attempts, failure ? now + delay : null, error,
    key, resource.generation, resource.rowVersion, token,
    resource.deletionOwner ? JSON.stringify(resource.deletionOwner) : null)
    if (changed !== 1) throw new SessionLifecycleError(`deletion lease for ${key} was lost`)
    pruneTombstones(tx, options)
  })
}

/** Internal post-sweep phase; does NOT reconcile. lifecycleGcSql composes the public SQL runGc.
 * Retries deferred releases; callers must already have reconciled resources/dead leases.
 * The run deadline gates the next claim, not the full timeout of an already-claimed deletion. */
export async function runDeletionPhase(pins: readonly TranscriptLocator[],
  options: SessionLifecycleOptions = {}): Promise<GcResult> {
  outsideScope(options)
  await retryDeferredLeaseReleases(options)
  let currentPins = pins
  indexPins(currentPins, options)
  const limit = positiveOption(options.maxDeletesPerRun, runtime.maxDeletes, "maxDeletesPerRun")
  const result: GcResult = { deleted: 0, notFound: 0, failed: 0, deferred: 0 }
  const deadline = Date.now() + positiveOption(options.runTimeoutMs, runtime.timeoutMs, "runTimeoutMs")
  for (let index = 0; index < limit; index++) {
    if (Date.now() >= deadline) break
    currentPins = options.pinProvider?.() ?? currentPins
    const candidate = await claimDeletion(currentPins, options)
    if (!candidate) break
    let failure: unknown
    let notFound = false
    try {
      const timeout = positiveOption(options.deletionTimeoutMs, runtime.timeoutMs, "deletionTimeoutMs")
      if (options.deleter) await runtime.awaitCustomDeleter(options.deleter(candidate.locator), timeout)
      else await runtime.deleteWithSdkChild(candidate.locator, candidate.deletionToken!, timeout,
        (executor, group, signal) => attachDeletionExecutor(candidate.key, candidate.deletionToken!, executor, group,
          { ...options, admissionSignal: signal }), options)
    } catch (error) {
      if (error instanceof runtime.DeletionStillRunningError) {
        result.deferred++
        break
      }
      if (runtime.isNotFoundError(error, candidate.locator.sessionId)) notFound = true
      else failure = error
    }
    await finishDeletion(candidate.key, candidate.deletionToken!, failure, options)
    if (failure) result.failed++
    else if (notFound) result.notFound++
    else result.deleted++
  }
  const finalPins = indexPins(currentPins, options)
  result.deferred += withBookkeepingRead(directoryFor(options), (reader) =>
    reader.all("SELECT key FROM resources WHERE state IN ('retired','deleting')").filter((row) => {
      const resource = readResource(reader, String(row.key))!
      return !ephemeralPin(resource, finalPins) && !reader.get(PIN_LOOKUP_SQL, resource.key, resource.generation)
    }).length)
  return result
}
