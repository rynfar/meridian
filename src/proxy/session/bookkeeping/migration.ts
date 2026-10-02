/** Explicit offline format transition; never called by request-path initialization. */
import { randomUUID } from "node:crypto"
import { existsSync, linkSync, lstatSync, readFileSync, statfsSync } from "node:fs"
import { dirname, join } from "node:path"
import { withLegacyLifecycleMaintenanceLock } from "../../sessionLifecycle"
import { withLegacyStoreMaintenanceLock } from "../../sessionStore"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { acquireMaintenanceGuard } from "./guard"
import type { MaintenanceGuardLease } from "./guard"
import { BOOKKEEPING_FILENAME, createMaintenanceDatabase } from "./connection"
import { openForMaintenance } from "./maintenance"
import { withBookkeepingWrite } from "./transaction"
import { truncateOffline } from "./offlineCheckpoint"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"
import { prepareImport, importPlan, assertQuiescent } from "./migrationImport"
import { parseLegacySidecar } from "./legacyCodec"
import {
  barrierBytes, crashPoint, digestBytes, isOwnBarrier, observeSource, readJournal, requireBarriers,
  saveJournal, SOURCE_NAMES, writeDurably,
} from "./maintenanceJournal"
import type { MigrationJournal, SourceName } from "./maintenanceJournal"
import { EXPORT_JOURNAL_NAME } from "./exportJournal"
import { archivePreviousCycle } from "./cycles"
import { archiveResidues, planResidueArchive } from "./residueArchive"
import type { ArchivedResidue } from "./residueTypes"
import { refuseUnjournaledDatabase } from "./maintenancePreflight"
import { resumeRetirements, retireFile } from "./privateRetirement"

export interface MigrationOptions {
  /** Operator attestation, not something inferred from a quiet lease table. */
  writersStopped: boolean
  /** Test seam for the storage boundary, not an override for the required space. */
  availableBytes?: (directory: string) => number
  afterPreflightForTest?: () => void
}
export interface MigrationResult {
  id: string; phase: "READY"; resources: number; mappings: number; residues: ArchivedResidue[]
}

function ensureSpace(directory: string, bytes: number, options: MigrationOptions): void {
  const fs = statfsSync(directory)
  const available = options.availableBytes?.(directory) ?? fs.bavail * fs.bsize
  const required = bytes * 4 + 16 * 1024 * 1024
  if (!Number.isFinite(available) || available < required) {
    throw Object.assign(new Error(`insufficient space for migration: need ${required}, available ${available}`),
      { code: "ENOSPC" })
  }
}

function sources(directory: string, journal?: MigrationJournal) {
  const observations = SOURCE_NAMES.map((name) => observeSource(directory, name))
  for (const [index, observed] of observations.entries()) {
    if (journal?.sources[index]?.existed && !observed.identity.existed) {
      throw new Error(`source disappeared after PREPARED: ${observed.identity.path}`)
    }
  }
  return observations
}

function archiveSource(directory: string, name: SourceName, expected: string | null, id: string): void {
  const source = join(directory, name)
  const backup = join(directory, name.slice(0, -5) + ".migrated.json")
  if (expected === null) {
    if (existsSync(source)) throw new Error(`unexpected source after import: ${name}`)
    return
  }
  if (existsSync(backup)) {
    if (digestBytes(readFileSync(backup, "utf8")) !== expected) throw new Error(`foreign backup: ${backup}`)
  } else {
    if (!existsSync(source) || digestBytes(readFileSync(source, "utf8")) !== expected) {
      throw new Error(`source digest mismatch: ${name}`)
    }
    // Exclusive destination creation, followed by unlink, is a recoverable rename across a process crash.
    linkSync(source, backup)
    syncDirectoryDurablySync(directory)
    crashPoint(`backup-linked:${name}`)
  }
  if (existsSync(source)) {
    if (digestBytes(readFileSync(source, "utf8")) !== expected) throw new Error(`source digest mismatch: ${name}`)
  }
  retireFile(source, id, lstatSync(backup))
  crashPoint(`backup:${name}`)
}

function importOrResume(directory: string, journal: MigrationJournal, guard: MaintenanceGuardLease,
  options: MigrationOptions): MigrationResult {
  requireBarriers(directory, journal.id)
  const path = join(directory, BOOKKEEPING_FILENAME)
  if (!existsSync(path)) {
    if (journal.phase !== "BARRIERS") throw new Error("committed migration database is missing")
    const final = sources(directory, journal)
    if (JSON.stringify(final.map((entry) => entry.identity)) !== JSON.stringify(journal.finalSources)) {
      throw new Error("protected source identity/digest changed after BARRIERS")
    }
    // A malformed source must remain abortable without ever publishing an empty database.
    prepareImport(final[0]?.raw, final[1]?.raw)
    createMaintenanceDatabase(directory, guard)
    crashPoint("database-prepared")
  }
  let handle: ReturnType<typeof openForMaintenance>
  let unfinished = false
  try {
    handle = openForMaintenance(directory, { expectPhase: "PREPARED", guard })
    unfinished = true
  } catch (error) {
    if (!(error instanceof BookkeepingMaintenanceRequiredError)) throw error
    handle = openForMaintenance(directory, { expectPhase: "READY", guard })
  }
  try {
    const encoded = JSON.stringify(journal.finalSources)
    if (unfinished) {
      if (journal.phase !== "BARRIERS") throw new Error("journal claims import but database is unfinished")
      const final = sources(directory, journal)
      if (JSON.stringify(final.map((entry) => entry.identity)) !== encoded) {
        throw new Error("protected source identity/digest changed after BARRIERS")
      }
      ensureSpace(directory, final.reduce((n, entry) => n + entry.identity.bytes, 0), options)
      const plan = prepareImport(final[0]?.raw, final[1]?.raw)
      withBookkeepingWrite(directory, {}, (tx) => {
        if (Number(tx.get("SELECT sum(value) AS n FROM bookkeeping_counts")?.n) !== 0
          || Number(tx.get("SELECT count(*) AS n FROM fence_slots")?.n) !== 0) {
          throw new Error("unfinished database is not empty")
        }
        importPlan(tx, plan, journal.id, encoded)
        crashPoint("before-import-commit")
      })
      crashPoint("after-import-commit")
    }
    const meta = handle.reader.get("SELECT migration_id,source_digests_json FROM schema_meta")
    if (meta?.migration_id !== journal.id || meta.source_digests_json !== encoded) {
      throw new Error("database migration identity/digests disagree with journal")
    }
    const result: MigrationResult = { id: journal.id, phase: "READY", residues: journal.residues ?? [],
      resources: Number(handle.reader.get("SELECT count(*) AS n FROM resources")?.n),
      mappings: Number(handle.reader.get("SELECT count(*) AS n FROM mappings")?.n) }
    if (journal.phase !== "READY") {
      journal.phase = "IMPORTED"
      saveJournal(directory, journal)
      crashPoint("IMPORTED")
      for (const source of journal.finalSources!) archiveSource(directory, source.path, source.digest, journal.id)
      truncateOffline(directory, "migration")
      crashPoint("migration:checkpoint")
      handle.close()
      crashPoint("migration:closed")
      journal.phase = "READY"
      saveJournal(directory, journal)
      crashPoint("READY")
    }
    return result
  } finally { handle.close() }
}

export async function migrateBookkeeping(input: string, options: MigrationOptions): Promise<MigrationResult> {
  if (options.writersStopped !== true) {
    throw new BookkeepingMaintenanceRequiredError(
      "--writers-stopped is required; idle legacy proxies are not observable",
    )
  }
  refuseUnjournaledDatabase(input)
  options.afterPreflightForTest?.()
  const guard = acquireMaintenanceGuard(input)
  const directory = dirname(guard.path)
  try {
    resumeRetirements(directory)
    archivePreviousCycle(directory)
    if (existsSync(join(directory, EXPORT_JOURNAL_NAME))) {
      throw new BookkeepingMaintenanceRequiredError("export journal exists; resume export-json")
    }
    let journal = readJournal(directory)
    if (journal?.phase === "ABORTING" || journal?.phase === "ABORTED") {
      throw new BookkeepingMaintenanceRequiredError("migration aborted; finish abort-migration before any new transition")
    }
    if (!journal && existsSync(join(directory, BOOKKEEPING_FILENAME))) {
      throw new BookkeepingMaintenanceRequiredError("database without migration journal; refuse implicit adoption")
    }
    const residues = journal ? journal.residues ?? [] : planResidueArchive(directory)
    if (journal) archiveResidues(directory, journal.id, residues)
    const barriers = () => {
      if (journal && journal.phase !== "PREPARED") return
      const before = sources(directory, journal)
      prepareImport(before[0]?.raw, before[1]?.raw)
      if (before[0]?.raw !== undefined) assertQuiescent(parseLegacySidecar(before[0].raw))
      ensureSpace(directory, before.reduce((n, entry) => n + entry.identity.bytes, 0), options)
      if (!journal) {
        journal = { format: "meridian-bookkeeping-migration", version: 1, targetVersion: 1,
          id: randomUUID(), phase: "PREPARED", sources: before.map((entry) => entry.identity), residues }
        saveJournal(directory, journal)
        crashPoint("PREPARED")
      }
      archiveResidues(directory, journal.id, residues)
      for (const name of SOURCE_NAMES) {
        if (!isOwnBarrier(directory, name, journal.id)) {
          writeDurably(join(directory, name + ".lock"), barrierBytes(journal.id))
        }
        crashPoint(`barrier:${name}`)
      }
      journal.finalSources = sources(directory, journal).map((entry) => entry.identity)
      journal.phase = "BARRIERS"
      saveJournal(directory, journal)
      crashPoint("BARRIERS")
    }
    if (!journal || journal.phase === "PREPARED") {
      const storeStep = () => journal && isOwnBarrier(directory, "sessions.json", journal.id)
        ? barriers() : withLegacyStoreMaintenanceLock(directory, barriers)
      if (journal && isOwnBarrier(directory, "session-gc.json", journal.id)) storeStep()
      else await withLegacyLifecycleMaintenanceLock(directory, async () => storeStep())
    }
    if (!journal) throw new Error("migration journal was not prepared")
    const result = importOrResume(directory, journal, guard, options)
    guard.toShared(() => {
      if (readJournal(directory)?.phase !== "READY") throw new Error("migration handoff lost READY")
      requireBarriers(directory, result.id)
    })
    return result
  } finally { guard.close() }
}
