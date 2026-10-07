/** IMPORT ONLY: offline migrator/fixtures; never exported by the runtime facade. */
import { validateResource } from "./resources"
import { writeResourceRow } from "./resourceRow"
import { createHash } from "node:crypto"
import { writeMappingRow } from "./mappings"
import type { BookkeepingResource, BookkeepingTransaction, CanonicalStoredSession } from "./types"

/** Fixture insertion, NOT fence-preserving legacy import. */
export function insertMapping(tx: BookkeepingTransaction, key: string, entry: CanonicalStoredSession): void {
  writeMappingRow(tx, key, entry)
  tx.run(
    `INSERT INTO fence_slots VALUES('store',?,1) ON CONFLICT(namespace,slot) DO UPDATE SET counter=counter+1`,
    createHash("sha256").update(key).digest("hex").slice(0, 4),
  )
}

export function importResource(tx: BookkeepingTransaction, resource: BookkeepingResource): void {
  const counter = validateResource(resource)
  writeResourceRow(tx, resource)
  tx.run(
    `INSERT INTO fence_slots VALUES('lifecycle',?,?) ON CONFLICT(namespace,slot)
    DO UPDATE SET counter=max(counter,excluded.counter)`,
    resource.key.slice(0, 4),
    counter,
  )
}
