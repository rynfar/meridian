/** Offline projection repair. Raw legacy entries and their CAS digests are never rewritten. */
import { dirname, join } from "node:path"
import { existsSync } from "node:fs"
import { acquireMaintenanceGuard } from "./guard"
import { openForMaintenance } from "./maintenance"
import { readJournal, requireBarriers } from "./maintenanceJournal"
import { EXPORT_JOURNAL_NAME } from "./exportJournal"
import { canonicalizeLocator, resourceKey } from "./locator"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"
import { withBookkeepingWrite } from "./transaction"
import { validateMappingPins } from "./mappings"
import type { TranscriptLocator, StoredSession } from "./types"

const remigrate = () => new BookkeepingMaintenanceRequiredError(
  "resource path changed; export-json, correct paths, then migrate again; resource generations cannot be rekeyed",
)

export function recanonicalizeBookkeeping(input: string): { mappings: number } {
  const guard = acquireMaintenanceGuard(input)
  const directory = dirname(guard.path)
  try {
    const journal = readJournal(directory)
    if (journal?.phase !== "READY" || existsSync(join(directory, EXPORT_JOURNAL_NAME))) {
      throw new BookkeepingMaintenanceRequiredError("recanonicalize requires READY and no export journal")
    }
    requireBarriers(directory, journal.id)
    const handle = openForMaintenance(directory, { expectPhase: "READY", guard, skipRealpathAudit: true })
    try {
      const meta = handle.reader.get("SELECT migration_id,source_digests_json FROM schema_meta")
      if (meta?.migration_id !== journal.id || meta.source_digests_json !== JSON.stringify(journal.finalSources)) {
        throw new Error("recanonicalize database migration identity mismatch")
      }
      const paths = new Map<string, string>()
      for (const row of handle.reader.all("SELECT key,config_dir,project_dir,session_id FROM resources")) {
        const stored: TranscriptLocator = { configDir: String(row.config_dir), sessionId: String(row.session_id),
          ...(row.project_dir === null ? {} : { projectDir: String(row.project_dir) }) }
        const canonical = canonicalizeLocator(stored, paths)
        if (resourceKey(canonical) !== row.key || canonical.projectDir !== stored.projectDir) throw remigrate()
      }
      const changes: Array<{ key: string; column: string; slot: string; locator: TranscriptLocator }> = []
      let after: string | undefined
      while (true) {
        const rows = handle.reader.all(`SELECT m.key,m.current_locator_json,m.previous_locator_json,
          CASE WHEN h.encoding='legacy-entry' THEN h.history_json ELSE NULL END AS legacy
          FROM mappings m JOIN mapping_history h ON h.mapping_key=m.key
          ${after === undefined ? "" : "WHERE m.key>?"} ORDER BY m.key LIMIT 128`,
        ...(after === undefined ? [] : [after]))
        if (!rows.length) break
        for (const row of rows) {
          const raw = row.legacy === null ? undefined : JSON.parse(String(row.legacy)) as StoredSession
          for (const [slot, column, field] of [
            ["current", "current_locator_json", "currentTranscript"],
            ["previous", "previous_locator_json", "previousTranscript"],
          ] as const) {
            if (row[column] === null) continue
            const stored = JSON.parse(String(row[column])) as TranscriptLocator
            const locator = canonicalizeLocator(raw?.[field] ?? stored, paths)
            if (resourceKey(locator) !== resourceKey(stored)) throw remigrate()
            if (JSON.stringify(locator) !== row[column]) {
              changes.push({ key: String(row.key), column, slot, locator })
            }
          }
        }
        after = String(rows.at(-1)!.key)
      }
      // Every filesystem observation is complete before the single all-or-nothing transaction.
      withBookkeepingWrite(directory, {}, (tx) => {
        for (const { key, column, slot, locator } of changes) {
          tx.run(`UPDATE mappings SET ${column}=? WHERE key=?`, JSON.stringify(locator), key)
          tx.run("UPDATE mapping_pins SET resource_key=?,generation=? WHERE mapping_key=? AND slot=?",
            resourceKey(locator), locator.lifecycleGeneration ?? null, key, slot)
        }
      })
      validateMappingPins(handle.reader)
      return { mappings: new Set(changes.map((change) => change.key)).size }
    } finally { handle.close() }
  } finally { guard.close() }
}
