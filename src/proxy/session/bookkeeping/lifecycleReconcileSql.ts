import { setImmediate as yieldPage } from "node:timers/promises"
import { sessionDeletionRuntime, type ReconcileResult, type SessionLifecycleOptions } from "../../sessionLifecycle"
import { SessionLifecycleCorruptError, SessionLifecycleError, SessionLifecycleReentrancyError } from "../lifecycleErrors"
import { parseProcessIncarnation, processIncarnationIsDead, processIncarnationPredatesBoot } from "../processIncarnation"
import { connectionFor } from "./connection"
import { resourceKey } from "./locator"
import { PIN_LOOKUP_SQL } from "./mappings"
import { directoryFor, normalizeInput, nowMs, pendingCount, positiveOption } from "./lifecycleRowsSql"
import { readResource } from "./resources"
import { withBookkeepingRead, withBookkeepingWriteAsync } from "./transaction"
import type { BookkeepingResource, BookkeepingTransaction, SqlRow, TranscriptLocator } from "./types"

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError(`${name} must be a non-negative integer`)
  return result
}

function deadLease(row: SqlRow, now: number, ttl: number): boolean {
  const incarnation = (column: string) => {
    const parsed = parseProcessIncarnation(JSON.parse(String(row[column])))
    if (!parsed) throw new SessionLifecycleCorruptError("invalid active transcript incarnation")
    return parsed
  }
  if (row.executor_json !== null) return row.executor_recoverable === 0
    ? processIncarnationPredatesBoot(incarnation("executor_json"))
    : processIncarnationIsDead(incarnation("executor_json"))
  return now - Number(row.created_at) > ttl || processIncarnationIsDead(incarnation("owner_json"))
}

function recoverable(resource: BookkeepingResource): boolean {
  if (resource.state !== "deleting") return false
  if (resource.deletionExecutor && resource.deletionProcessGroupId !== undefined)
    return processIncarnationIsDead(resource.deletionExecutor)
      && (process.platform === "win32" || sessionDeletionRuntime.processGroupIsEmpty(resource.deletionProcessGroupId))
  return !resource.deletionExecutor && resource.deletionOwner !== undefined
    && processIncarnationIsDead(resource.deletionOwner)
}

function indexPins(pins: readonly TranscriptLocator[], options: SessionLifecycleOptions) {
  const index = new Map<string, Set<string | undefined>>()
  for (const locator of pins) {
    const normalized = normalizeInput(locator, options), key = resourceKey(normalized)
    let generations = index.get(key)
    if (!generations) index.set(key, generations = new Set())
    generations.add(normalized.lifecycleGeneration)
  }
  return index
}

function pinned(tx: BookkeepingTransaction, resource: BookkeepingResource, pins: ReturnType<typeof indexPins>): boolean {
  const generations = pins.get(resource.key)
  return !!(generations?.has(undefined) || generations?.has(resource.generation)
    || tx.get(PIN_LOOKUP_SQL, resource.key, resource.generation))
}

const emptyResult = (): ReconcileResult => ({ preparedRetired: 0, liveRetired: 0, resourcesPinned: 0, deletingRecovered: 0 })

/** Two bounded passes: reclaim/rescue ALL pages before admitting passive retirement.
 * Observations never cross into a transaction without a generation/version CAS.
 * Durable pins are re-read under the write lock, including on the retirement pass. */
export async function reconcile(pins: readonly TranscriptLocator[], options: SessionLifecycleOptions = {}): Promise<ReconcileResult> {
  const directory = directoryFor(options)
  if (connectionFor(directory).scope) throw new SessionLifecycleReentrancyError("reconcile requires outside-transaction observation")
  indexPins(pins, options)
  const now = nowMs(options)
  const cutoff = now - nonNegative(options.preparedGraceMs, 5 * 60_000, "preparedGraceMs")
  const ttl = nonNegative(options.unarmedLeaseTtlMs, 11 * 60_000, "unarmedLeaseTtlMs")
  const grace = nonNegative(options.retiredGraceMs, 11 * 60_000, "retiredGraceMs")
  const maximum = positiveOption(options.maxPending, 256, "maxPending")
  const limit = maximum > 1 ? maximum - 1 : maximum
  const upper = withBookkeepingRead(directory, (reader) => reader.get("SELECT max(key) AS key FROM resources")?.key)
  const result = emptyResult()
  if (typeof upper !== "string") return result
  for (const phase of ["rescue", "retire"] as const) {
    let after = ""
    while (true) {
      const page = withBookkeepingRead(directory, (reader) => reader.all(
        "SELECT key FROM resources WHERE key>? AND key<=? ORDER BY key LIMIT 128", after, upper,
      ).map((row) => ({ resource: readResource(reader, String(row.key))!,
        leases: phase === "rescue" ? reader.all("SELECT * FROM resource_leases WHERE resource_key=?", String(row.key)) : [] })))
      if (!page.length) break
      const observations = page.map(({ resource, leases }) => ({ resource,
        dead: leases.filter((lease) => deadLease(lease, now, ttl)), recover: phase === "rescue" && recoverable(resource) }))
      const finalPins = indexPins(options.pinProvider?.() ?? pins, options)
      const applied = await withBookkeepingWriteAsync(directory, options, (tx) => {
        const counts = emptyResult()
        let pending = pendingCount(tx)
        for (const observation of observations) {
          const { resource: snapshot } = observation
          let current = readResource(tx, snapshot.key)
          if (!current || current.generation !== snapshot.generation || current.rowVersion !== snapshot.rowVersion) continue
          if (phase === "rescue") {
            for (const lease of observation.dead) {
              tx.run(`DELETE FROM resource_leases WHERE resource_key=? AND token=? AND owner_json=?
                AND executor_json IS ? AND executor_recoverable IS ? AND purpose IS ? AND created_at=?
                AND EXISTS(SELECT 1 FROM resources WHERE key=? AND generation=? AND row_version=?)`,
              current.key, lease.token!, lease.owner_json!, lease.executor_json!, lease.executor_recoverable!,
              lease.purpose!, lease.created_at!, current.key, current.generation, current.rowVersion)
              current = readResource(tx, current.key)!
            }
            if (observation.recover) {
              counts.deletingRecovered += tx.run(`UPDATE resources SET state='retired',updated_at=?,next_attempt_at=?,
                deletion_token=NULL,deletion_owner_json=NULL,deletion_executor_json=NULL,deletion_process_group_id=NULL,
                row_version=row_version+1 WHERE key=? AND generation=? AND row_version=? AND state='deleting'
                AND deletion_token IS ? AND deletion_owner_json IS ? AND deletion_executor_json IS ? AND deletion_process_group_id IS ?`,
              now, now, current.key, current.generation, current.rowVersion, snapshot.deletionToken ?? null,
              snapshot.deletionOwner ? JSON.stringify(snapshot.deletionOwner) : null,
              snapshot.deletionExecutor ? JSON.stringify(snapshot.deletionExecutor) : null, snapshot.deletionProcessGroupId ?? null)
              current = readResource(tx, current.key)!
            }
          }
          if (pinned(tx, current, finalPins)) {
            if (current.state === "deleted") throw new SessionLifecycleError(`pinned transcript ${current.key} was already deleted`)
            // JSON counts pinned observations, not only promotions. Count on the final pass once.
            if (phase === "retire") counts.resourcesPinned++
            if (current.state === "prepared" || current.state === "retired") pending -= tx.run(`UPDATE resources
              SET state='live',updated_at=?,next_attempt_at=NULL,last_error=NULL,row_version=row_version+1
              WHERE key=? AND generation=? AND row_version=? AND state=?`,
            now, current.key, current.generation, current.rowVersion, current.state)
            continue
          }
          if (phase !== "retire" || tx.get("SELECT token FROM resource_leases WHERE resource_key=? LIMIT 1", current.key)) continue
          if (current.state === "prepared" && current.updatedAt <= cutoff || current.state === "live" && pending < limit) {
            const changed = tx.run(`UPDATE resources SET state='retired',updated_at=?,next_attempt_at=?,row_version=row_version+1
              WHERE key=? AND generation=? AND row_version=? AND state=?`,
            now, now + grace, current.key, current.generation, current.rowVersion, current.state)
            if (current.state === "prepared") counts.preparedRetired += changed
            else { counts.liveRetired += changed; pending += changed }
          }
        }
        return counts
      })
      for (const key of Object.keys(result) as Array<keyof ReconcileResult>) result[key] += applied[key]
      after = page.at(-1)!.resource.key
      if (page.length < 128) break
      await yieldPage()
    }
    await yieldPage()
  }
  return result
}
