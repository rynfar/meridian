import { randomUUID } from "node:crypto"
import { existsSync, statfsSync } from "node:fs"
import { dirname, join } from "node:path"
import { acquireMaintenanceGuard } from "./guard"
import { openForMaintenance } from "./maintenance"
import { BOOKKEEPING_FILENAME } from "./connection"
import { withBookkeepingRead } from "./transaction"
import { truncateOffline } from "./offlineCheckpoint"
import { snapshotForExport, verifyExportSnapshot } from "./exportSnapshot"
import {
  crashPoint, digestBytes, readJournal, requireBarriers, SOURCE_NAMES, writeDurably,
} from "./maintenanceJournal"
import {
  fileIdentity, moveExportFile, protectedBytes, readExportJournal, saveExportJournal, verifyFile,
} from "./exportJournal"
import type { ExportJournal } from "./exportJournal"
import { releaseOwnBarrier } from "./barrier"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"
import { assertQuiescent } from "./migrationImport"
import { parseLegacySidecar } from "./legacyCodec"
import { resumeRetirements } from "./privateRetirement"
import { archiveStoppedResidues } from "./residueArchive"
import { inspectArtifacts } from "./residueInventory"

const stageName = (journal: ExportJournal, name: string) => `${name}.export-${journal.id}`

export function exportBookkeepingJson(input: string, options: { writersStopped?: boolean } = {}): ExportJournal {
  const guard = acquireMaintenanceGuard(input)
  const directory = dirname(guard.path)
  try {
    resumeRetirements(directory)
    const migration = readJournal(directory)
    if (migration?.phase !== "READY") {
      throw new BookkeepingMaintenanceRequiredError("export requires a READY migration journal")
    }
    let journal = readExportJournal(directory)
    const inventory = inspectArtifacts(directory)
    const unsafe = [...inventory.candidates, ...inventory.gates, ...inventory.temporary]
      .find(row => row.verdict === "live" || row.verdict === "unknown" && !options.writersStopped)
    if (unsafe) throw new BookkeepingMaintenanceRequiredError(`${unsafe.verdict} residue ${unsafe.path}; stop all children and use export-json --writers-stopped`)
    if (journal && journal.migrationId !== migration.id) throw new Error("export migration identity mismatch")
    if (journal?.phase !== "EXPORTED") requireBarriers(directory, migration.id)
    if (!journal || ["PREPARED", "STAGED", "INSTALLED"].includes(journal.phase)) {
      const handle = openForMaintenance(directory, { expectPhase: "READY", guard, skipRealpathAudit: true })
      try {
        const meta = handle.reader.get("SELECT migration_id,source_digests_json FROM schema_meta")
        if (meta?.migration_id !== migration.id
          || meta.source_digests_json !== JSON.stringify(migration.finalSources)) {
          throw new Error("export database migration identity mismatch")
        }
        // Incarnation probes run after COMMIT, never while a SQL snapshot transaction is held.
        const snapshot = withBookkeepingRead(directory, snapshotForExport)
        assertQuiescent(parseLegacySidecar(snapshot.sidecar))
        if (options.writersStopped) archiveStoppedResidues(directory, migration)
        const documents = SOURCE_NAMES.map((name, index) => {
          const bytes = index === 0 ? snapshot.sidecar : snapshot.store
          return { name, digest: digestBytes(bytes), bytes: Buffer.byteLength(bytes) }
        })
        if (!journal) {
          for (const name of SOURCE_NAMES) {
            if (existsSync(join(directory, name))) throw new Error(`foreign export destination: ${name}`)
          }
          const fs = statfsSync(directory)
          const required = documents.reduce((n, doc) => n + doc.bytes, 0) * 2 + 16 * 1024 * 1024
          if (fs.bavail * fs.bsize < required) throw Object.assign(new Error("insufficient export space"),
            { code: "ENOSPC" })
          journal = { format: "meridian-bookkeeping-export", version: 1, id: randomUUID(),
            migrationId: migration.id, phase: "PREPARED", documents,
            resources: snapshot.resources, mappings: snapshot.mappings }
          saveExportJournal(directory, journal, "PREPARED")
        } else if (JSON.stringify(documents) !== JSON.stringify(journal.documents)
          || journal.resources !== snapshot.resources || journal.mappings !== snapshot.mappings) {
          throw new Error("database changed during export")
        }
        if (journal.phase === "PREPARED") {
          for (const [index, file] of journal.documents.entries()) {
            writeDurably(join(directory, stageName(journal, file.name)), index === 0 ? snapshot.sidecar : snapshot.store)
            crashPoint(`export:staged:${file.name}`)
          }
          for (const file of journal.documents) verifyFile(directory, stageName(journal, file.name), file)
          verifyExportSnapshot({ resources: journal.resources, mappings: journal.mappings,
            sidecar: protectedBytes(join(directory, stageName(journal, SOURCE_NAMES[0]))).toString("utf8"),
            store: protectedBytes(join(directory, stageName(journal, SOURCE_NAMES[1]))).toString("utf8") })
          saveExportJournal(directory, journal, "STAGED")
        }
        if (journal.phase === "STAGED") {
          for (const file of journal.documents) {
            moveExportFile(directory, stageName(journal, file.name), file.name, file, journal.migrationId)
          }
          verifyInstalled(directory, journal)
          saveExportJournal(directory, journal, "INSTALLED")
        }
        verifyInstalled(directory, journal)
        truncateOffline(directory, "export")
        crashPoint("export:checkpoint")
      } finally { handle.close() }
      crashPoint("export:closed")
      if (!journal) throw new Error("export journal missing")
      journal.archive = ["", "-wal", "-shm"].flatMap((suffix) => {
        const name = BOOKKEEPING_FILENAME + suffix
        return existsSync(join(directory, name)) ? [fileIdentity(directory, name)] : []
      })
      saveExportJournal(directory, journal, "CHECKPOINTED")
    }
    if (!journal) throw new Error("export journal missing")
    if (options.writersStopped && ["CHECKPOINTED", "ARCHIVED", "EXPORTED"].includes(journal.phase)) {
      assertQuiescent(parseLegacySidecar(protectedBytes(join(directory, SOURCE_NAMES[0])).toString("utf8")))
      archiveStoppedResidues(directory, migration)
    }
    if (journal.phase === "CHECKPOINTED") {
      verifyInstalled(directory, journal)
      for (const file of journal.archive!) {
        moveExportFile(directory, file.name, `${file.name}.exported-${journal.id}`, file, journal.migrationId)
      }
      saveExportJournal(directory, journal, "ARCHIVED")
    }
    if (journal.phase === "ARCHIVED") {
      verifyInstalled(directory, journal)
      for (const file of journal.archive!) verifyFile(directory, `${file.name}.exported-${journal.id}`, file)
      saveExportJournal(directory, journal, "EXPORTED")
    }
    // After this transition a legacy writer may legitimately change JSON; never revalidate its old digest.
    for (const source of SOURCE_NAMES) {
      releaseOwnBarrier(directory, source, migration.id)
      crashPoint(`export:released:${source}`)
    }
    return journal
  } finally { guard.close() }
}

function verifyInstalled(directory: string, journal: ExportJournal): void {
  for (const file of journal.documents) verifyFile(directory, file.name, file)
  verifyExportSnapshot({ resources: journal.resources, mappings: journal.mappings,
    sidecar: protectedBytes(join(directory, SOURCE_NAMES[0])).toString("utf8"),
    store: protectedBytes(join(directory, SOURCE_NAMES[1])).toString("utf8") })
}
