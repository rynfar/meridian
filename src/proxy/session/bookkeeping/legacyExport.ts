/** Offline import/export payloads; SQL projections remain the runtime authority. */
import { readMapping } from "./mappings"
import { readResource, readResourceLease } from "./resources"
import type { BookkeepingReader, BookkeepingTransaction, TranscriptResource, StoredSession } from "./types"
import { createHash } from "node:crypto"

function projectionDigest(reader: BookkeepingReader, kind: "resource" | "mapping", key: string,
  projection: TranscriptResource | StoredSession): string {
  const version = kind === "resource" ? reader.get("SELECT row_version FROM resources WHERE key=?", key)?.row_version : null
  return createHash("sha256").update(JSON.stringify([version, projection])).digest("hex")
}

export function resourceProjection(reader: BookkeepingReader, key: string): TranscriptResource {
  const { rowVersion: _rowVersion, ...resource } = readResource(reader, key)!
  const leases = reader.all("SELECT token FROM resource_leases WHERE resource_key=? ORDER BY token", key)
  if (leases.length) resource.activeLeases = Object.fromEntries(leases.map((lease) => [
    String(lease.token), readResourceLease(reader, key, String(lease.token))!,
  ]))
  return resource
}

export function preserveLegacyExport(tx: BookkeepingTransaction, kind: "resource" | "mapping",
  key: string, entry: TranscriptResource | StoredSession): void {
  const projection = kind === "resource" ? resourceProjection(tx, key) : readMapping(tx, key)!
  tx.run("INSERT INTO legacy_exports VALUES(?,?,?,?)", kind, key, projectionDigest(tx, kind, key, projection), JSON.stringify(entry))
}

export function legacyExport<T extends TranscriptResource | StoredSession>(reader: BookkeepingReader,
  kind: "resource" | "mapping", key: string, projection: T): T {
  const original = reader.get("SELECT projection_digest,entry_json FROM legacy_exports WHERE kind=? AND key=?", kind, key)
  // Once the runtime projection changes, never resurrect an imported snapshot over fresh SQL state.
  return original?.projection_digest === projectionDigest(reader, kind, key, projection)
    ? JSON.parse(String(original.entry_json)) as T : projection
}
