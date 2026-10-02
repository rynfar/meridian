/** Offline-only import planning: OS observations and realpaths precede the SQL transaction. */
import { canonicalizeLocator, resourceKey } from "./locator"
import { probeProcessIncarnation } from "../processIncarnation"
import type { ProcessIncarnation } from "../processIncarnation"
import { importResource } from "./resourceImport"
import { insertResourceLease } from "./resources"
import { writeMappingRow } from "./mappings"
import { parseLegacySidecar, parseLegacyStoreForMaintenance, emptyStoreDocument } from "./legacyCodec"
import type { SessionGcSidecar, SessionStoreDocument } from "./legacyCodec"
import type { BookkeepingResource, CanonicalStoredSession, BookkeepingTransaction } from "./types"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"
import { preserveLegacyExport } from "./legacyExport"
import { mappingGeneration, legacyUserDenial } from "./mappingMetadata"
import { validateImportTransaction } from "./importValidation"

export interface ImportPlan {
  sidecar: SessionGcSidecar
  store: SessionStoreDocument
  resources: BookkeepingResource[]
  mappings: Array<{ key: string; canonical: CanonicalStoredSession; original: string }>
}

export function assertQuiescent(sidecar: SessionGcSidecar): void {
  const requireDead = (owner: ProcessIncarnation | undefined, address: string) => {
    if (!owner) return
    const verdict = probeProcessIncarnation(owner)
    if (verdict !== "dead") {
      throw new BookkeepingMaintenanceRequiredError(
        `${verdict === "alive" ? "live" : "indeterminate"} process at ${address}; `
        + `pid=${owner.pid} startId=${JSON.stringify(owner.startId)}; stop all writers`,
      )
    }
  }
  for (const [key, resource] of Object.entries(sidecar.resources)) {
    requireDead(resource.deletionOwner, `${key}/deletion-owner`)
    requireDead(resource.deletionExecutor, `${key}/deletion-executor`)
    for (const [token, lease] of Object.entries(resource.activeLeases ?? {})) {
      requireDead(lease.owner, `${key}/lease/${token}/owner`)
      requireDead(lease.executor, `${key}/lease/${token}/executor`)
    }
  }
}

export function prepareImport(sidecarRaw: string | undefined, storeRaw: string | undefined): ImportPlan {
  const sidecar = sidecarRaw === undefined
    ? { version: 2 as const, meta: { fenceSlots: {} }, resources: {} }
    : parseLegacySidecar(sidecarRaw)
  const store = storeRaw === undefined ? emptyStoreDocument() : parseLegacyStoreForMaintenance(storeRaw)
  assertQuiescent(sidecar)
  const paths = new Map<string, string>()
  const resources = Object.values(sidecar.resources).map((resource): BookkeepingResource => {
    const locator = canonicalizeLocator(resource.locator, paths)
    if (resourceKey(locator) !== resource.key) {
      throw new BookkeepingMaintenanceRequiredError(`resource realpath changed before migration: ${resource.key}`)
    }
    return { ...resource, locator, rowVersion: resource.rowVersion ?? 1 }
  })
  const mappings = Object.entries(store.sessions).map(([key, entry]) => ({
    key, original: JSON.stringify(entry), canonical: {
      ...entry,
      ...(entry.currentTranscript ? { currentTranscript: canonicalizeLocator(entry.currentTranscript, paths) } : {}),
      ...(entry.previousTranscript ? { previousTranscript: canonicalizeLocator(entry.previousTranscript, paths) } : {}),
    } as CanonicalStoredSession,
  }))
  const plan = { sidecar, store, resources, mappings }
  try { validateImportTransaction(tx => importPlan(tx, plan, "preflight", "[]")) } catch (cause) {
    throw new BookkeepingMaintenanceRequiredError(
      `legacy import is not SQL-representable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause },
    )
  }
  return plan
}

export function importPlan(tx: BookkeepingTransaction, plan: ImportPlan, id: string, digests: string): void {
  for (const resource of plan.resources) {
    // Lease INSERT triggers fence runtime edits. Hydration is not an edit; start low enough
    // for those triggers, then restore the source version before this transaction commits.
    importResource(tx, { ...resource, rowVersion: 1 })
    for (const lease of Object.values(resource.activeLeases ?? {})) insertResourceLease(tx, resource.key, lease)
    tx.run("UPDATE resources SET row_version=? WHERE key=?", resource.rowVersion, resource.key)
    preserveLegacyExport(tx, "resource", resource.key, plan.sidecar.resources[resource.key]!)
  }
  // importResource populates only a subset; the source maps, including unused and zero store slots, are authoritative.
  tx.run("DELETE FROM fence_slots")
  for (const [namespace, slots] of [
    ["lifecycle", plan.sidecar.meta.fenceSlots], ["store", plan.store.meta.slots],
  ] as const) {
    for (const [slot, counter] of Object.entries(slots)) {
      tx.run("INSERT INTO fence_slots VALUES(?,?,?)", namespace, slot, counter)
    }
  }
  for (const { key, canonical, original } of plan.mappings) {
    try { writeMappingRow(tx, key, canonical) } catch (cause) {
      throw new TypeError(`mapping ${JSON.stringify(key)}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    }
    if (canonical.generationId === undefined) {
      tx.run("UPDATE mapping_history SET history_json=? WHERE mapping_key=?", original, key)
      const entry = plan.store.sessions[key]!
      tx.run("UPDATE mappings SET generation_token=?,legacy_denial=? WHERE key=?",
        mappingGeneration(key, entry), legacyUserDenial(entry), key)
    } else {
      preserveLegacyExport(tx, "mapping", key, plan.store.sessions[key]!)
    }
  }
  const meta = plan.store.meta
  if (meta.version === 3) {
    for (const [key, row] of Object.entries(meta.priorityAssignments)) {
      tx.run("INSERT INTO priority_assignments VALUES(?,?,?,?,?,?,?,?,(SELECT coalesce(max(insertion_order),0)+1 FROM priority_assignments))", key, row.profileId,
        row.lastHumanTurnDigest, row.lastHumanTurnIssuedAt, row.mappingKey, row.mappingGeneration,
        row.generationId, row.updatedAt)
    }
    for (const [key, row] of Object.entries(meta.priorityAttempts)) {
      tx.run("INSERT INTO priority_attempts VALUES(?,?,?,?,?,?,?,?,?)", key, Number(row.blocked),
        row.blockedTurnDigest, row.blockedTurnIssuedAt, row.pendingTurnDigest, row.pendingTurnIssuedAt,
        row.ownerToken, row.generationId, row.updatedAt)
    }
    for (const [key, row] of Object.entries(meta.priorityRollbackMappings)) {
      tx.run("INSERT INTO priority_rollbacks VALUES(?,?,?)", key, row.mappingKey, row.mappingGeneration)
    }
  }
  tx.run("UPDATE schema_meta SET migration_id=?,source_digests_json=?,store_meta_version=?,phase='READY'",
    id, digests, meta.version)
}
