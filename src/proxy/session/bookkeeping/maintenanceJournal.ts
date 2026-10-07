import { randomUUID, createHash } from "node:crypto"
import {
  closeSync, constants, existsSync, fsyncSync, fstatSync, openSync, readFileSync, renameSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { BookkeepingFormatError, errorCode, ownedFd } from "./storagePaths"
import { isUuidV4 } from "./uuid"
import { validResidues } from "./residueTypes"
import type { ArchivedResidue } from "./residueTypes"
import { privateName, unlinkPrivate } from "./privateNames"

export const JOURNAL_NAME = "session-bookkeeping-migration.json"
export const SOURCE_NAMES = ["session-gc.json", "sessions.json"] as const
export type SourceName = typeof SOURCE_NAMES[number]
export type MigrationPhase = "PREPARED" | "BARRIERS" | "IMPORTED" | "READY" | "ABORTING" | "ABORTED"
export interface SourceIdentity {
  path: SourceName
  existed: boolean
  dev: number | null
  ino: number | null
  digest: string | null
  bytes: number
}
export interface MigrationJournal {
  format: "meridian-bookkeeping-migration"
  version: 1
  targetVersion: 1
  id: string
  phase: MigrationPhase
  sources: SourceIdentity[]
  finalSources?: SourceIdentity[]
  residues?: ArchivedResidue[]
  releases?: Partial<Record<SourceName, { name: string; dev: number; ino: number }>>
  abortDatabase?: Array<{ name: string; dev: number; ino: number }>
}
export const digestBytes = (value: string) => createHash("sha256").update(value).digest("hex")

/** Atomic file publication; callers hold the exclusive maintenance guard. */
export function writeDurably(path: string, value: string): void {
  // Never derive a write temporary from the destination (which may itself be
  // a long legacy intent name). Fixed basename bounds every UTF-8 component.
  const temporary = privateName(join(dirname(path), ".bk-write"), randomUUID())
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    writeFileSync(fd, value)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temporary, path)
    syncDirectoryDurablySync(dirname(path))
  } finally {
    try { unlinkPrivate(temporary) } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
  }
}

export function observeSource(directory: string, path: SourceName): { identity: SourceIdentity; raw?: string } {
  const file = join(directory, path)
  try {
    const fd = ownedFd(file)
    try {
      const stat = fstatSync(fd)
      const raw = readFileSync(fd, "utf8")
      return { raw, identity: { path, existed: true, dev: stat.dev, ino: stat.ino,
        digest: digestBytes(raw), bytes: Buffer.byteLength(raw) } }
    } finally { closeSync(fd) }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
    return { identity: { path, existed: false, dev: null, ino: null, digest: null, bytes: 0 } }
  }
}

function validSources(value: unknown): value is SourceIdentity[] {
  if (!Array.isArray(value) || value.length !== 2) return false
  return value.every((entry: unknown, index) => {
    if (!entry || typeof entry !== "object") return false
    const row = entry as Record<string, unknown>
    return row.path === SOURCE_NAMES[index] && typeof row.existed === "boolean"
      && typeof row.bytes === "number" && Number.isSafeInteger(row.bytes) && row.bytes >= 0
      && (row.existed ? typeof row.dev === "number" && Number.isSafeInteger(row.dev)
        && typeof row.ino === "number" && Number.isSafeInteger(row.ino)
        && typeof row.digest === "string" && /^[a-f0-9]{64}$/.test(row.digest)
        : row.dev === null && row.ino === null && row.digest === null && row.bytes === 0)
  })
}

export function readJournal(directory: string, readOnly = false): MigrationJournal | undefined {
  const path = join(directory, JOURNAL_NAME)
  if (!existsSync(path)) return undefined
  const fd = ownedFd(path, false, true, readOnly)
  let value: unknown
  try { value = JSON.parse(readFileSync(fd, "utf8")) } finally { closeSync(fd) }
  if (!value || typeof value !== "object") throw new BookkeepingFormatError("invalid migration journal")
  const row = value as Record<string, unknown>
  if (row.format !== "meridian-bookkeeping-migration" || row.version !== 1 || row.targetVersion !== 1
    || !isUuidV4(row.id)
    || !["PREPARED", "BARRIERS", "IMPORTED", "READY", "ABORTING", "ABORTED"].includes(String(row.phase))
    || !validSources(row.sources) || (row.finalSources !== undefined && !validSources(row.finalSources))
    || (row.residues !== undefined && !validResidues(row.residues))
    || (row.releases !== undefined && !validReleases(row.releases, String(row.id)))
    || (row.abortDatabase !== undefined && (!Array.isArray(row.abortDatabase)
      || !row.abortDatabase.every((file: unknown) => {
        if (!file || typeof file !== "object") return false
        const entry = file as Record<string, unknown>
        return ["session-bookkeeping.sqlite", "session-bookkeeping.sqlite-wal", "session-bookkeeping.sqlite-shm", "session-bookkeeping.sqlite-journal"].includes(String(entry.name))
          && [entry.dev, entry.ino].every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      })))
    || (row.phase !== "PREPARED" && !row.finalSources)) throw new BookkeepingFormatError("invalid migration journal")
  return row as unknown as MigrationJournal
}

function validReleases(value: unknown, id: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.entries(value).every(([source, item]) => {
    if (!SOURCE_NAMES.includes(source as SourceName) || !item || typeof item !== "object") return false
    const row = item as Record<string, unknown>
    const prefix = `${source}.lock.releasing-${id}-`
    return typeof row.name === "string" && row.name.startsWith(prefix)
      && isUuidV4(row.name.slice(prefix.length))
      && [row.dev, row.ino].every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
  })
}

export function saveJournal(directory: string, journal: MigrationJournal): void {
  writeDurably(join(directory, JOURNAL_NAME), JSON.stringify(journal) + "\n")
}
export function barrierBytes(id: string): string {
  return JSON.stringify({ backend: "sqlite", migration_id: id, format: "meridian-bookkeeping-barrier-v1",
    instruction: "Stop all writers; use meridian-bookkeeping export-json. Never delete this barrier manually." }) + "\n"
}
export function isOwnBarrier(directory: string, source: SourceName, id: string): boolean {
  const path = join(directory, source + ".lock")
  try {
    const fd = ownedFd(path, false, false, true)
    try { return readFileSync(fd, "utf8") === barrierBytes(id) } finally { closeSync(fd) }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
    return false
  }
}
export function requireBarriers(directory: string, id: string): void {
  for (const source of SOURCE_NAMES) {
    if (!isOwnBarrier(directory, source, id)) throw new Error(`missing or foreign barrier: ${source}.lock`)
  }
}

let phaseObserver: ((phase: string) => void) | undefined
export function observeMaintenancePhases(observer: (phase: string) => void): () => void {
  if (phaseObserver) throw new Error("maintenance timing observer already installed")
  phaseObserver = observer
  return () => { phaseObserver = undefined }
}
/** Durable phase timing, with an explicit test-only SIGKILL seam (no JS cleanup). */
export function crashPoint(point: string): void {
  phaseObserver?.(point)
  if (process.env.MERIDIAN_BOOKKEEPING_TEST_CRASH === point) process.kill(process.pid, "SIGKILL")
}
