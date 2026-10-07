import { randomUUID } from "node:crypto"
import { existsSync, linkSync } from "node:fs"
import { join } from "node:path"
import { assertGuardLease } from "./guard"
import type { MaintenanceGuardLease } from "./guard"
import { barrierBytes, crashPoint, observeSource, readJournal, saveJournal, SOURCE_NAMES, writeDurably } from "./maintenanceJournal"
import type { MigrationJournal } from "./maintenanceJournal"
import { privateName, unlinkPrivate } from "./privateNames"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"

/** Fresh runtime creation is the empty-input variant of the durable maintenance protocol. */
export function prepareFreshBootstrap(directory: string, guard: MaintenanceGuardLease): MigrationJournal {
  assertGuardLease(guard, directory, "exclusive")
  if (readJournal(directory) || ["session-bookkeeping.sqlite", "session-bookkeeping-export.json", "session-bookkeeping-cycle.json",
    ...SOURCE_NAMES, ...SOURCE_NAMES.map(name => name + ".lock")].some(name => existsSync(join(directory, name))))
    throw new BookkeepingMaintenanceRequiredError("legacy bookkeeping requires offline migration; refuse fresh adoption")
  const sources = SOURCE_NAMES.map(name => observeSource(directory, name).identity)
  const journal: MigrationJournal = { format: "meridian-bookkeeping-migration", version: 1,
    targetVersion: 1, id: randomUUID(), phase: "PREPARED", sources }
  saveJournal(directory, journal)
  crashPoint("fresh:PREPARED")
  for (const name of SOURCE_NAMES) {
    const path = join(directory, name + ".lock")
    const temporary = privateName(path + ".fresh", journal.id)
    writeDurably(temporary, barrierBytes(journal.id))
    try {
      // An old writer can race fresh creation. Never overwrite its lock inode:
      // either this complete barrier wins, or runtime refuses before publishing SQL.
      linkSync(temporary, path)
      syncDirectoryDurablySync(directory)
    } finally { unlinkPrivate(temporary) }
    crashPoint(`fresh:barrier:${name}`)
  }
  if (SOURCE_NAMES.some(name => existsSync(join(directory, name))))
    throw new BookkeepingMaintenanceRequiredError("legacy data appeared during fresh bootstrap; resume explicit migration")
  journal.finalSources = sources
  journal.phase = "BARRIERS"
  saveJournal(directory, journal)
  crashPoint("fresh:BARRIERS")
  return journal
}
