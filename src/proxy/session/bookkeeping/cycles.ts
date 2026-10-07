import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { releaseOwnBarrier } from "./barrier"
import { EXPORT_JOURNAL_NAME, fileIdentity, readExportJournal, verifyFile } from "./exportJournal"
import type { ExportFile } from "./exportJournal"
import { crashPoint, JOURNAL_NAME, readJournal, SOURCE_NAMES, writeDurably } from "./maintenanceJournal"
import { BookkeepingFormatError, ownedFd } from "./storagePaths"
import { isUuidV4 } from "./uuid"
import { retireFile } from "./privateRetirement"

export const CYCLES_DIRECTORY = "bookkeeping-cycles"
export const CYCLE_TRANSITION_NAME = "session-bookkeeping-cycle.json"
interface CycleTransition { version: 1; id: string; files: ExportFile[] }

function isExportedDatabaseName(name: string): boolean {
  const prefix = /^session-bookkeeping\.sqlite(-wal|-shm)?\.exported-/.exec(name)?.[0]
  return prefix !== undefined && isUuidV4(name.slice(prefix.length))
}

export function readTransition(directory: string, readOnly = false): CycleTransition | undefined {
  const path = join(directory, CYCLE_TRANSITION_NAME)
  if (!existsSync(path)) return undefined
  const fd = ownedFd(path, false, false, readOnly)
  let value: unknown
  try { value = JSON.parse(readFileSync(fd, "utf8")) } finally { closeSync(fd) }
  if (!value || typeof value !== "object") throw new BookkeepingFormatError("invalid cycle transition")
  const row = value as Record<string, unknown>
  if (row.version !== 1 || !isUuidV4(row.id)
    || !Array.isArray(row.files) || row.files.length === 0
    || row.files.at(-1)?.name !== JOURNAL_NAME
    || new Set(row.files.map((file) => file?.name)).size !== row.files.length
    || !row.files.every((file: unknown) => {
      if (!file || typeof file !== "object") return false
      const item = file as Record<string, unknown>
      return typeof item.name === "string" && (item.name === JOURNAL_NAME || item.name === EXPORT_JOURNAL_NAME
        || /^(session-gc|sessions)\.migrated\.json$/.test(item.name)
        || isExportedDatabaseName(item.name))
        && typeof item.digest === "string" && /^[a-f0-9]{64}$/.test(item.digest)
        && typeof item.bytes === "number" && Number.isSafeInteger(item.bytes) && item.bytes >= 0
    })) throw new BookkeepingFormatError("invalid cycle transition")
  return row as unknown as CycleTransition
}

/** Resume the durable move intent before interpreting a partially moved set of journals. */
export function archivePreviousCycle(directory: string): void {
  let transition = readTransition(directory)
  if (!transition) {
    const migration = readJournal(directory)
    const exported = readExportJournal(directory)
    if (migration?.phase !== "ABORTED" && exported?.phase !== "EXPORTED") return
    if (!migration || (exported && exported.migrationId !== migration.id)) {
      throw new Error("cycle migration identity mismatch")
    }
    if (["", "-wal", "-shm"].some((suffix) =>
      existsSync(join(directory, "session-bookkeeping.sqlite" + suffix)))) {
      throw new Error("terminal cycle still has a database; refuse implicit adoption")
    }
    for (const source of migration.sources) {
      if ((source.existed || exported) && !existsSync(join(directory, source.path))) {
        throw new Error(`legacy source missing before new cycle: ${source.path}`)
      }
    }
    for (const source of SOURCE_NAMES) releaseOwnBarrier(directory, source, migration.id)
    const names = [
      ...SOURCE_NAMES.map((source) => source.slice(0, -5) + ".migrated.json")
        .filter((name) => existsSync(join(directory, name))),
      ...(exported?.archive ?? []).map((file) => `${file.name}.exported-${exported!.id}`),
      ...(exported ? [EXPORT_JOURNAL_NAME] : []), JOURNAL_NAME,
    ]
    transition = { version: 1, id: migration.id, files: names.map((name) => fileIdentity(directory, name)) }
    writeDurably(join(directory, CYCLE_TRANSITION_NAME), JSON.stringify(transition) + "\n")
    crashPoint("cycle:PREPARED")
  }
  const root = join(directory, CYCLES_DIRECTORY)
  const archive = join(root, transition.id)
  for (const path of [root, archive]) {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
    closeSync(ownedFd(path, true))
  }
  syncDirectoryDurablySync(root)
  syncDirectoryDurablySync(directory)
  for (const file of transition.files) {
    const source = join(directory, file.name)
    const target = join(archive, file.name)
    if (!existsSync(target)) {
      verifyFile(directory, file.name, file)
      linkSync(source, target)
      syncDirectoryDurablySync(archive)
      crashPoint(`cycle:linked:${file.name}`)
    } else verifyFile(archive, file.name, file)
    if (existsSync(source)) {
      const before = lstatSync(source)
      const after = lstatSync(target)
      if (!before.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
        throw new Error(`cycle archive inode mismatch: ${file.name}`)
      }
    }
    retireFile(source, transition.id, lstatSync(target))
    crashPoint(`cycle:moved:${file.name}`)
  }
  retireFile(join(directory, CYCLE_TRANSITION_NAME), transition.id)
  syncDirectoryDurablySync(directory)
  crashPoint("cycle:ARCHIVED")
}
