import { resourceKey, persistedCanonicalLocator, canonicalizeLocator } from "./locator"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"
import type { CanonicalTranscriptLocator } from "./locator"
import { writeResourceRow } from "./resourceRow"
import { parseProcessIncarnation } from "../processIncarnation"
import type { ActiveTranscriptLeaseRecord, BookkeepingReader, BookkeepingTransaction } from "./types"
import type { SqlRow, BookkeepingResource, TranscriptResourceState } from "./types"

function incarnationJson(value: ActiveTranscriptLeaseRecord["owner"] | undefined): string | null {
  if (value === undefined) return null
  if (!parseProcessIncarnation(value)) throw new TypeError("invalid process incarnation")
  return JSON.stringify(value)
}

export function validateResource(resource: BookkeepingResource): number {
  const key = resourceKey(resource.locator)
  const prefix = `r:${key}:`
  const counter = Number(resource.generation.slice(prefix.length))
  if (
    key !== resource.key ||
    !resource.generation.startsWith(prefix) ||
    !Number.isSafeInteger(counter) ||
    counter <= 0
  )
    throw new TypeError("invalid resource key/generation")
  if (
    resource.locator.lifecycleGeneration !== undefined &&
    resource.locator.lifecycleGeneration !== resource.generation
  )
    throw new TypeError("locator generation mismatch")
  incarnationJson(resource.deletionOwner)
  incarnationJson(resource.deletionExecutor)
  return counter
}

export function allocateResource(
  tx: BookkeepingTransaction,
  locator: CanonicalTranscriptLocator,
  fields: Pick<BookkeepingResource, "state" | "createdAt" | "updatedAt" | "attempts">,
): BookkeepingResource {
  if ("generation" in fields || "rowVersion" in fields || locator.lifecycleGeneration !== undefined) {
    throw new TypeError("runtime allocation cannot accept a generation or rowVersion")
  }
  const key = resourceKey(locator)
  const slot = key.slice(0, 4)
  tx.run(
    `INSERT INTO fence_slots VALUES('lifecycle',?,1) ON CONFLICT(namespace,slot)
    DO UPDATE SET counter=counter+1`,
    slot,
  )
  const counter = tx.get(
    "SELECT counter FROM fence_slots WHERE namespace='lifecycle' AND slot=?",
    slot,
  )!.counter
  const resource = { ...fields, locator, key, generation: `r:${key}:${counter}`, rowVersion: 1 }
  writeResourceRow(tx, resource)
  return resource
}

export function readResource(reader: BookkeepingReader, key: string): BookkeepingResource | undefined {
  const row = reader.get("SELECT * FROM resources WHERE key=?", key)
  if (!row) return undefined
  const optional = (column: string, field: string, parse = false) =>
    row[column] === null ? {} : { [field]: parse ? JSON.parse(String(row[column])) : row[column] }
  return {
    key: String(row.key),
    generation: String(row.generation),
    locator: persistedCanonicalLocator({
      configDir: String(row.config_dir),
      sessionId: String(row.session_id),
      ...optional("project_dir", "projectDir"),
    }),
    state: row.state as TranscriptResourceState,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    attempts: Number(row.attempts),
    rowVersion: Number(row.row_version),
    ...optional("next_attempt_at", "nextAttemptAt"),
    ...optional("last_error", "lastError"),
    ...optional("deletion_token", "deletionToken"),
    ...optional("deletion_owner_json", "deletionOwner", true),
    ...optional("deletion_executor_json", "deletionExecutor", true),
    ...optional("deletion_process_group_id", "deletionProcessGroupId"),
  }
}

/** Addressed non-deleting state CAS; ownership/claim semantics are implemented separately. */
export function compareAndSwapResourceState(
  tx: BookkeepingTransaction,
  key: string,
  generation: string,
  rowVersion: number,
  state: Exclude<TranscriptResourceState, "deleting">,
  now: number,
): boolean {
  return (
    tx.run(
      `UPDATE resources SET state=?,updated_at=?,row_version=row_version+1
    WHERE key=? AND generation=? AND row_version=? AND state!='deleting'`,
      state,
      now,
      key,
      generation,
      rowVersion,
    ) === 1
  )
}

export function insertResourceLease(
  tx: BookkeepingTransaction,
  key: string,
  lease: ActiveTranscriptLeaseRecord,
): void {
  tx.run(
    "INSERT INTO resource_leases VALUES(?,?,?,?,?,?,?)",
    key,
    lease.token,
    lease.purpose ?? null,
    incarnationJson(lease.owner),
    incarnationJson(lease.executor),
    lease.executorRecoverable === undefined ? null : Number(lease.executorRecoverable),
    lease.createdAt,
  )
}

export function readResourceLease(
  reader: BookkeepingReader,
  key: string,
  token: string,
): ActiveTranscriptLeaseRecord | undefined {
  const row = reader.get("SELECT * FROM resource_leases WHERE resource_key=? AND token=?", key, token)
  if (!row) return undefined
  return {
    token: String(row.token),
    owner: JSON.parse(String(row.owner_json)),
    createdAt: Number(row.created_at),
    ...(row.purpose === null ? {} : { purpose: "publication" as const }),
    ...(row.executor_json === null ? {} : { executor: JSON.parse(String(row.executor_json)) }),
    ...(row.executor_recoverable === null ? {} : { executorRecoverable: row.executor_recoverable === 1 }),
  }
}

/** Keyset page preserves oldest-update/key order, including not-yet-due candidates. */
export const RETIRED_PAGE_SQL = `SELECT key,updated_at,next_attempt_at FROM resources INDEXED BY retired_order
  WHERE state='retired' AND (updated_at,key)>(?,?) ORDER BY updated_at,key LIMIT ?`
export function readRetiredPage(
  reader: BookkeepingReader,
  afterUpdatedAt: number,
  afterKey: string,
  limit: number,
): SqlRow[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
    throw new RangeError("retired page must be bounded to 128")
  return reader.all(RETIRED_PAGE_SQL, afterUpdatedAt, afterKey, limit)
}

/** Startup/offline audit of the semantic constraints SQL cannot express as FKs. */
export function validateResourceRows(reader: BookkeepingReader): () => void {
  const locators: CanonicalTranscriptLocator[] = []
  for (const row of reader.all("SELECT key FROM resources")) {
    const resource = readResource(reader, String(row.key))!
    locators.push(resource.locator)
    const counter = validateResource(resource)
    const fence = reader.get(
      "SELECT counter FROM fence_slots WHERE namespace='lifecycle' AND slot=?",
      resource.key.slice(0, 4),
    )
    if (typeof fence?.counter !== "number" || fence.counter < counter)
      throw new Error("resource generation exceeds lifecycle fence")
  }
  for (const row of reader.all("SELECT owner_json,executor_json FROM resource_leases")) {
    incarnationJson(JSON.parse(String(row.owner_json)))
    if (row.executor_json !== null) incarnationJson(JSON.parse(String(row.executor_json)))
  }
  return () => {
    const paths = new Map<string, string>()
    for (const locator of locators) {
      const canonical = canonicalizeLocator(locator, paths)
      if (canonical.configDir !== locator.configDir || canonical.projectDir !== locator.projectDir) {
        throw new BookkeepingMaintenanceRequiredError("resource realpath changed; run offline recanonicalize")
      }
    }
  }
}
