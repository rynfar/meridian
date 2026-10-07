import { closeSync, existsSync, linkSync, lstatSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { retireFile } from "./privateRetirement"
import { BookkeepingFormatError, ownedFd } from "./storagePaths"
import { isUuidV4 } from "./uuid"
import { writeDurably, crashPoint, SOURCE_NAMES } from "./maintenanceJournal"
import { syncDirectoryDurablySync } from "../durableFileSystem"

export const EXPORT_JOURNAL_NAME = "session-bookkeeping-export.json"
export const EXPORT_PHASES = ["PREPARED", "STAGED", "INSTALLED", "CHECKPOINTED", "ARCHIVED", "EXPORTED"] as const
export type ExportPhase = typeof EXPORT_PHASES[number]
export interface ExportFile { name: string; digest: string; bytes: number }
export interface ExportJournal {
  format: "meridian-bookkeeping-export"
  version: 1
  id: string
  migrationId: string
  phase: ExportPhase
  resources: number
  mappings: number
  documents: ExportFile[]
  archive?: ExportFile[]
}
export function protectedBytes(path: string, linked = false, readOnly = false): Buffer {
  const fd = ownedFd(path, false, linked, readOnly)
  try { return readFileSync(fd) } finally { closeSync(fd) }
}
export function fileIdentity(directory: string, name: string, linked = false): ExportFile {
  const bytes = protectedBytes(join(directory, name), linked)
  return { name, bytes: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") }
}
export function verifyFile(directory: string, name: string, expected: ExportFile): void {
  const actual = fileIdentity(directory, name, true)
  if (actual.digest !== expected.digest || actual.bytes !== expected.bytes) {
    throw new Error(`export file digest/size mismatch: ${name}`)
  }
}
export function readExportJournal(directory: string, readOnly = false): ExportJournal | undefined {
  const path = join(directory, EXPORT_JOURNAL_NAME)
  if (!existsSync(path)) return undefined
  const value: unknown = JSON.parse(protectedBytes(path, true, readOnly).toString("utf8"))
  if (!value || typeof value !== "object") throw new BookkeepingFormatError("invalid export journal")
  const row = value as Record<string, unknown>
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
  const files = (v: unknown, names: readonly string[], exact: boolean): boolean => Array.isArray(v)
    && (exact ? v.length === names.length : v.length >= 1 && v.length <= names.length)
    && new Set(v.map((item) => item?.name)).size === v.length
    && v.every((item: unknown, index) => {
      if (!item || typeof item !== "object") return false
      const file = item as Record<string, unknown>
      return typeof file.name === "string" && (exact ? file.name === names[index] : names.includes(file.name))
        && typeof file.digest === "string" && /^[a-f0-9]{64}$/.test(file.digest) && count(file.bytes)
    })
  if (row.format !== "meridian-bookkeeping-export" || row.version !== 1 || !isUuidV4(row.id)
    || !isUuidV4(row.migrationId) || !EXPORT_PHASES.includes(row.phase as ExportPhase)
    || !count(row.resources) || !count(row.mappings) || !files(row.documents, SOURCE_NAMES, true)
    || (row.archive !== undefined && !files(row.archive,
      ["session-bookkeeping.sqlite", "session-bookkeeping.sqlite-wal", "session-bookkeeping.sqlite-shm"], false))
    || (Array.isArray(row.archive) && !row.archive.some((file) => file?.name === "session-bookkeeping.sqlite"))
    || (["CHECKPOINTED", "ARCHIVED", "EXPORTED"].includes(String(row.phase)) && !row.archive)) {
    throw new BookkeepingFormatError("invalid export journal")
  }
  return row as unknown as ExportJournal
}
export function saveExportJournal(directory: string, journal: ExportJournal, phase: ExportPhase): void {
  journal.phase = phase
  writeDurably(join(directory, EXPORT_JOURNAL_NAME), JSON.stringify(journal) + "\n")
  crashPoint(`export:${phase}`)
}

/** Exclusive destination publication, recoverable on either side of unlink; never overwrite a foreign name. */
export function moveExportFile(directory: string, source: string, target: string, expected: ExportFile, id: string): void {
  if (existsSync(join(directory, target))) verifyFile(directory, target, expected)
  else {
    verifyFile(directory, source, expected)
    linkSync(join(directory, source), join(directory, target))
    syncDirectoryDurablySync(directory)
    crashPoint(`export:linked:${expected.name}`)
  }
  if (existsSync(join(directory, source))) {
    const from = lstatSync(join(directory, source))
    const to = lstatSync(join(directory, target))
    if (!from.isFile() || from.dev !== to.dev || from.ino !== to.ino) {
      throw new Error(`foreign export destination inode: ${target}`)
    }
  }
  retireFile(join(directory, source), id, lstatSync(join(directory, target)))
  crashPoint(`export:moved:${expected.name}`)
}
