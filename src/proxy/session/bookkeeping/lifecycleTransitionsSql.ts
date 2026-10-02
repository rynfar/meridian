import type { SessionLifecycleOptions } from "../../sessionLifecycle"
import { SessionLifecycleError } from "../lifecycleErrors"
import { resourceKey } from "./locator"
import { readResource } from "./resources"
import { withBookkeepingWriteAsync } from "./transaction"
import { assertLocator, assertPendingCapacity, directoryFor, normalizeInput, nowMs, promoteLive } from "./lifecycleRowsSql"
import type { BookkeepingTransaction, TranscriptLocator } from "./types"

function preparedResource(tx: BookkeepingTransaction, locator: TranscriptLocator) {
  const key = resourceKey(locator)
  const resource = readResource(tx, key)
  if (!resource) throw new SessionLifecycleError(`fork ${key} was not prepared`)
  assertLocator(resource, locator, true)
  return resource
}

export async function commitFork(locator: TranscriptLocator, options: SessionLifecycleOptions = {}): Promise<void> {
  const normalized = normalizeInput(locator, options)
  await withBookkeepingWriteAsync(directoryFor(options), options, (tx) => {
    const resource = preparedResource(tx, normalized)
    if (resource.state === "live") return
    if (resource.state !== "prepared")
      throw new SessionLifecycleError(`cannot commit fork ${resource.key} from state ${resource.state}`)
    promoteLive(tx, resource, nowMs(options))
  })
}

export async function abandonFork(locator: TranscriptLocator, options: SessionLifecycleOptions = {}): Promise<void> {
  const normalized = normalizeInput(locator, options)
  await withBookkeepingWriteAsync(directoryFor(options), options, (tx) => {
    const resource = preparedResource(tx, normalized)
    if (resource.state === "prepared" || resource.state === "live") {
      if (resource.state === "live") assertPendingCapacity(tx, options)
      const now = nowMs(options)
      const grace = options.retiredGraceMs ?? 11 * 60_000
      if (!Number.isSafeInteger(grace) || grace < 0) throw new TypeError("retiredGraceMs must be a non-negative integer")
      tx.run(`UPDATE resources SET state='retired',updated_at=?,next_attempt_at=?,row_version=row_version+1
        WHERE key=? AND generation=? AND row_version=? AND state=?`,
      now, now + grace, resource.key, resource.generation, resource.rowVersion, resource.state)
    }
    // JSON releases every publication token, even on an already retired/deleting/deleted row.
    // Other leases (including an unjoined SDK child) and deletion ownership remain untouched.
    const publications = tx.all("SELECT token,owner_json FROM resource_leases WHERE resource_key=? AND purpose='publication'", resource.key)
    for (const publication of publications) {
      const current = readResource(tx, resource.key)!
      tx.run(`DELETE FROM resource_leases WHERE resource_key=? AND token=? AND owner_json=? AND purpose='publication'
        AND EXISTS(SELECT 1 FROM resources WHERE key=? AND generation=? AND row_version=?)`,
      resource.key, publication.token!, publication.owner_json!, resource.key, resource.generation, current.rowVersion)
    }
  })
}

export const sqliteLifecycleTransitions = { commitFork, abandonFork }
