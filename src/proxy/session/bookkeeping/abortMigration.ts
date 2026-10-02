import { existsSync, lstatSync } from "node:fs"
import { dirname, join } from "node:path"
import { acquireMaintenanceGuard } from "./guard"
import { BOOKKEEPING_FILENAME } from "./connection"
import { EXPORT_JOURNAL_NAME } from "./exportJournal"
import {
  crashPoint, readJournal, requireBarriers, saveJournal, SOURCE_NAMES,
} from "./maintenanceJournal"
import { releaseOwnBarrier } from "./barrier"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"
import { resumeRetirements, retireFile } from "./privateRetirement"
import { openForMaintenance } from "./maintenance"
import { truncateOffline } from "./offlineCheckpoint"

/** No committed authority may be aborted; an exactly empty PREPARED import is reversible. */
export function abortBookkeepingMigration(input: string): void {
  const guard = acquireMaintenanceGuard(input)
  const directory = dirname(guard.path)
  try {
    resumeRetirements(directory)
    const journal = readJournal(directory)
    if (!journal || !["BARRIERS", "ABORTING", "ABORTED"].includes(journal.phase)) {
      throw new BookkeepingMaintenanceRequiredError("abort requires a BARRIERS migration journal")
    }
    if (existsSync(join(directory, EXPORT_JOURNAL_NAME)))
      throw new BookkeepingMaintenanceRequiredError("abort forbidden during export")
    if (journal.phase === "BARRIERS") {
      requireBarriers(directory, journal.id)
      if (existsSync(join(directory, BOOKKEEPING_FILENAME))) {
        const handle = openForMaintenance(directory, { expectPhase: "PREPARED", guard })
        try {
          const meta = handle.reader.get("SELECT migration_id,source_digests_json FROM schema_meta")
          const tables = ["resources", "resource_leases", "mappings", "mapping_history", "mapping_pins", "priority_assignments",
            "priority_attempts", "priority_rollbacks", "fence_slots", "legacy_exports"]
          if (meta?.migration_id !== null || meta.source_digests_json !== null
            || tables.some(table => Number(handle.reader.get(`SELECT count(*) AS n FROM ${table}`)?.n) !== 0)
            || Number(handle.reader.get("SELECT sum(value) AS n FROM bookkeeping_counts")?.n) !== 0)
            throw new BookkeepingMaintenanceRequiredError("abort requires a provably empty PREPARED database; use export-json for authority")
          truncateOffline(directory, "abort")
        } finally { handle.close() }
        journal.abortDatabase = ["", "-wal", "-shm", "-journal"].flatMap(suffix => {
          const name = BOOKKEEPING_FILENAME + suffix, path = join(directory, name)
          if (!existsSync(path)) return []
          const { dev, ino } = lstatSync(path)
          return [{ name, dev, ino }]
        })
      } else if (["-wal", "-shm", "-journal"].some(suffix => existsSync(join(directory, BOOKKEEPING_FILENAME + suffix))))
        throw new BookkeepingMaintenanceRequiredError("orphan database sidecar; refuse abort")
      journal.phase = "ABORTING"
      saveJournal(directory, journal)
      crashPoint("abort:ABORTING")
    }
    for (const file of journal.abortDatabase ?? []) retireFile(join(directory, file.name), journal.id, file)
    if (["", "-wal", "-shm", "-journal"].some(suffix => existsSync(join(directory, BOOKKEEPING_FILENAME + suffix))))
      throw new BookkeepingMaintenanceRequiredError("abort database retirement incomplete; refuse barrier release")
    for (const source of SOURCE_NAMES) {
      releaseOwnBarrier(directory, source, journal.id)
      crashPoint(`abort:released:${source}`)
    }
    Object.assign(journal, readJournal(directory))
    journal.phase = "ABORTED"
    saveJournal(directory, journal)
    crashPoint("abort:ABORTED")
  } finally { guard.close() }
}
