import { existsSync, statfsSync } from "node:fs"
import { join } from "node:path"
import { protectedBytes } from "./exportJournal"
import { parseLegacySidecar } from "./legacyCodec"
import { assertQuiescent, prepareImport } from "./migrationImport"
import { JOURNAL_NAME, SOURCE_NAMES } from "./maintenanceJournal"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"

/** Refuse foreign SQLite authority before bootstrapping any maintenance files. */
export function refuseUnjournaledDatabase(directory: string): void {
  if (existsSync(join(directory, "session-bookkeeping.sqlite")) && !existsSync(join(directory, JOURNAL_NAME))) {
    throw new BookkeepingMaintenanceRequiredError("database without migration journal; refuse implicit adoption")
  }
}

/** CLI refusal before guard bootstrap. The migrator repeats checks under exclusive ownership. */
export function preflightLegacyMigration(directory: string): void {
  let bytes = 0
  const documents: Array<string | undefined> = []
  for (const name of SOURCE_NAMES) {
    const path = join(directory, name)
    if (!existsSync(path)) { documents.push(undefined); continue }
    const document = protectedBytes(path, false, true)
    bytes += document.length
    documents.push(document.toString("utf8"))
    if (name === "session-gc.json") assertQuiescent(parseLegacySidecar(document.toString("utf8")))
  }
  prepareImport(documents[0], documents[1])
  const fs = statfsSync(directory)
  if (fs.bavail * fs.bsize < bytes * 4 + 16 * 1024 * 1024) {
    throw new BookkeepingMaintenanceRequiredError("insufficient space for migration")
  }
}
