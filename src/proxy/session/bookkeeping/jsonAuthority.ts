import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { acquireInspectionGuard, assertGuardRecoveryQuiescent } from "./guard"
import { CYCLE_TRANSITION_NAME } from "./cycles"
import { protectedBytes, readExportJournal, verifyFile } from "./exportJournal"
import { readJournal, SOURCE_NAMES } from "./maintenanceJournal"
import { BookkeepingMaintenanceRequiredError, errorCode } from "./storagePaths"

/** Recovery history is not authority, but only a fully proved terminal transition permits JSON. */
export function assertJsonBookkeepingAuthority(directory: string): void {
  if (!existsSync(directory)) return
  if (!["session-bookkeeping.sqlite", "session-bookkeeping.sqlite-wal", "session-bookkeeping.sqlite-shm", "session-bookkeeping.sqlite-journal",
    "session-bookkeeping-maintenance.sqlite", "session-bookkeeping-migration.json", "session-bookkeeping-export.json", CYCLE_TRANSITION_NAME]
    .some(name => existsSync(join(directory, name)))
    && !readdirSync(directory).some(name => name.includes(".deletion-intent.releasing-"))) {
    // Plain legacy locks may be directories or temporarily hardlinked during
    // publication. They are not SQLite control files: preserve JSON semantics.
    // Check no local native owner before touching an untrusted inode alias.
    assertGuardRecoveryQuiescent()
    for (const source of SOURCE_NAMES) {
      const path = join(directory, source + ".lock")
      try {
        if (lstatSync(path).isFile() && readFileSync(path, "utf8").includes("meridian-bookkeeping-barrier-v1"))
          throw new BookkeepingMaintenanceRequiredError("SQLite barrier requires explicit maintenance before JSON startup")
      } catch (error) { if (errorCode(error) !== "ENOENT") throw error }
    }
    return
  }
  const guard = acquireInspectionGuard(directory)
  try {
    const refuse = () => { throw new BookkeepingMaintenanceRequiredError("SQLite authority is active/incomplete; resume explicit maintenance before JSON startup") }
    if (["", "-wal", "-shm", "-journal"].some(suffix => existsSync(join(directory, "session-bookkeeping.sqlite" + suffix)))
      || existsSync(join(directory, CYCLE_TRANSITION_NAME))
      || readdirSync(directory).some(name => name.includes(".deletion-intent.releasing-"))) refuse()
    for (const source of SOURCE_NAMES) {
      const path = join(directory, source + ".lock")
      try {
        if (lstatSync(path).isFile() && protectedBytes(path, true, true).toString("utf8").includes("meridian-bookkeeping-barrier-v1")) refuse()
      } catch (error) { if (errorCode(error) !== "ENOENT") throw error }
    }
    const migration = readJournal(directory, true), exported = readExportJournal(directory, true)
    if (!migration && !exported) return
    if (!migration || !guard) refuse()
    const terminal = migration!
    if (exported) {
      if (terminal.phase !== "READY" || exported.phase !== "EXPORTED" || exported.migrationId !== terminal.id
        || !exported.archive?.some(file => file.name === "session-bookkeeping.sqlite")) refuse()
      for (const file of exported.archive!) verifyFile(directory, `${file.name}.exported-${exported.id}`, file)
      for (const file of exported.documents) if (!existsSync(join(directory, file.name))) refuse()
    } else {
      if (terminal.phase !== "ABORTED") refuse()
      for (const source of terminal.finalSources ?? terminal.sources)
        if (source.existed && !existsSync(join(directory, source.path))) refuse()
    }
    for (const source of SOURCE_NAMES) {
      const released = terminal.releases?.[source]
      if (!released || existsSync(join(directory, released.name))) refuse()
    }
  } finally { guard?.close() }
}
