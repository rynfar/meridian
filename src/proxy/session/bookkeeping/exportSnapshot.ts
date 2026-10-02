/** Full-document hydration belongs only to explicit offline maintenance. */
import { readMapping } from "./mappings"
import { legacyExport, resourceProjection } from "./legacyExport"
import {
  parseLegacySidecar, parseLegacyStoreForMaintenance, serializeLegacySidecar, serializeLegacyStore,
} from "./legacyCodec"
import type { SessionGcSidecar, SessionStoreDocument, SessionStoreMeta } from "./legacyCodec"
import type { BookkeepingReader } from "./types"
import { digestBytes } from "./maintenanceJournal"
import { MAPPING_OBJECT_ORDER } from "./mappingMetadata"

export interface ExportSnapshot {
  sidecar: string
  store: string
  resources: number
  mappings: number
}

export function snapshotForExport(reader: BookkeepingReader): ExportSnapshot {
  const slots = (namespace: string) => Object.fromEntries(reader.all(
    "SELECT slot,counter FROM fence_slots WHERE namespace=? ORDER BY slot", namespace,
  ).map((row) => [String(row.slot), Number(row.counter)]))
  const resources = Object.fromEntries(reader.all("SELECT key FROM resources ORDER BY key").map((row) => {
    const key = String(row.key)
    return [key, legacyExport(reader, "resource", key, resourceProjection(reader, key))]
  }))
  const sidecar: SessionGcSidecar = { version: 2, meta: { fenceSlots: slots("lifecycle") }, resources }
  const version = reader.get("SELECT store_meta_version FROM schema_meta")?.store_meta_version
  let meta: SessionStoreMeta
  if (version === 1) {
    for (const table of ["priority_assignments", "priority_attempts", "priority_rollbacks"]) {
      if (reader.get(`SELECT count(*) AS n FROM ${table}`)?.n !== 0) {
        throw new Error("store v1 metadata would discard priority rows")
      }
    }
    meta = { version: 1, slots: slots("store") }
  }
  else if (version === 3) {
    meta = { version: 3, slots: slots("store"),
      priorityAssignments: Object.fromEntries(reader.all("SELECT * FROM priority_assignments ORDER BY insertion_order")
        .map((row) => [String(row.route_key), { profileId: String(row.profile_id),
          lastHumanTurnDigest: String(row.last_human_turn_digest),
          lastHumanTurnIssuedAt: Number(row.last_human_turn_issued_at), mappingKey: String(row.mapping_key),
          mappingGeneration: String(row.mapping_generation), generationId: String(row.generation_id),
          updatedAt: Number(row.updated_at) }])),
      priorityAttempts: Object.fromEntries(reader.all("SELECT * FROM priority_attempts ORDER BY route_key")
        .map((row) => [String(row.route_key), { blocked: row.blocked === 1,
          blockedTurnDigest: row.blocked_turn_digest === null ? null : String(row.blocked_turn_digest),
          blockedTurnIssuedAt: row.blocked_turn_issued_at === null ? null : Number(row.blocked_turn_issued_at),
          pendingTurnDigest: row.pending_turn_digest === null ? null : String(row.pending_turn_digest),
          pendingTurnIssuedAt: row.pending_turn_issued_at === null ? null : Number(row.pending_turn_issued_at),
          ownerToken: row.owner_token === null ? null : String(row.owner_token),
          generationId: String(row.generation_id), updatedAt: Number(row.updated_at) }])),
      priorityRollbackMappings: Object.fromEntries(reader.all("SELECT * FROM priority_rollbacks ORDER BY route_key")
        .map((row) => [String(row.route_key), { mappingKey: String(row.mapping_key),
          mappingGeneration: String(row.mapping_generation) }])),
    }
  } else throw new Error("unsupported store metadata version")
  const store: SessionStoreDocument = { meta,
    sessions: Object.fromEntries(reader.all(`SELECT key FROM mappings ORDER BY ${MAPPING_OBJECT_ORDER}`)
      .map((row) => [String(row.key), legacyExport(reader, "mapping", String(row.key), readMapping(reader, String(row.key))!)])),
  }
  const result = { sidecar: serializeLegacySidecar(sidecar), store: serializeLegacyStore(store),
    resources: Object.keys(resources).length, mappings: Object.keys(store.sessions).length }
  verifyExportSnapshot(result)
  return result
}

/** Strict reparse, counts and byte digests; raw legacy-entry property order is never rebuilt. */
export function verifyExportSnapshot(snapshot: ExportSnapshot): void {
  const sidecar = parseLegacySidecar(snapshot.sidecar)
  const store = parseLegacyStoreForMaintenance(snapshot.store)
  if (Object.keys(sidecar.resources).length !== snapshot.resources
    || Object.keys(store.sessions).length !== snapshot.mappings
    || digestBytes(serializeLegacySidecar(sidecar)) !== digestBytes(snapshot.sidecar)
    || digestBytes(serializeLegacyStore(store)) !== digestBytes(snapshot.store)) {
    throw new Error("export strict round-trip counts/digests mismatch")
  }
}
