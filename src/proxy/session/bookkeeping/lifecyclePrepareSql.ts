import { randomUUID } from "node:crypto"
import type { SessionLifecycleOptions } from "../../sessionLifecycle"
import { SessionLifecycleError } from "../lifecycleErrors"
import { captureProcessIncarnation } from "../processIncarnation"
import { resourceKey, persistedCanonicalLocator } from "./locator"
import { allocateResource, insertResourceLease, readResource } from "./resources"
import { withBookkeepingWriteAsync } from "./transaction"
import { assertLocator, assertResourceCapacity, directoryFor, exactLocator, normalizeInput, nowMs,
  pendingCount, positiveOption, promoteLive, pruneTombstones } from "./lifecycleRowsSql"
import type { BookkeepingTransaction, TranscriptLocator } from "./types"

function deferRetirementForAdmission(tx: BookkeepingTransaction, options: SessionLifecycleOptions, now: number): void {
  const excess = pendingCount(tx) - positiveOption(options.maxPending, 256, "maxPending") + 1
  if (excess <= 0) return
  const rows = tx.all(`SELECT key FROM resources WHERE state='retired' ORDER BY updated_at DESC,key LIMIT ?`, excess)
  for (const row of rows) promoteLive(tx, readResource(tx, String(row.key))!, now)
}

async function prepare(locator: TranscriptLocator, options: SessionLifecycleOptions, publication = false) {
  const normalized = normalizeInput(locator, options)
  const publicationOwner = publication ? captureProcessIncarnation() : undefined
  if (publication && !publicationOwner) throw new SessionLifecycleError("cannot capture publication owner incarnation")
  const key = resourceKey(normalized)
  const result = await withBookkeepingWriteAsync(directoryFor(options), options, (tx) => {
    const existing = readResource(tx, key)
    if (existing) {
      if (publicationOwner) throw new SessionLifecycleError(`publication target ${key} already exists`)
      assertLocator(existing, normalized, true)
      if (existing.state === "deleted") throw new SessionLifecycleError(`transcript resource ${key} is already deleted`)
      return exactLocator(existing)
    }
    const now = nowMs(options)
    deferRetirementForAdmission(tx, options, now)
    assertResourceCapacity(tx, options, "prepared")
    const { lifecycleGeneration: _generation, ...physical } = normalized
    const resource = allocateResource(tx, persistedCanonicalLocator(physical),
      { state: "prepared", createdAt: now, updatedAt: now, attempts: 0 })
    if (publicationOwner) insertResourceLease(tx, key,
      { token: randomUUID(), owner: publicationOwner, purpose: "publication", createdAt: now })
    pruneTombstones(tx, options)
    return exactLocator(resource)
  })
  Object.assign(locator, result)
  return result
}

export function prepareFork(locator: TranscriptLocator, options: SessionLifecycleOptions = {}): Promise<TranscriptLocator> {
  return prepare(locator, options)
}

export function prepareForkForPublication(locator: TranscriptLocator,
  options: SessionLifecycleOptions = {}): Promise<TranscriptLocator> {
  return prepare(locator, options, true)
}

export const sqliteLifecyclePrepare = { prepareFork, prepareForkForPublication }
