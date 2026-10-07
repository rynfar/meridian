import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { fileIdentity, verifyFile } from "./exportJournal"
import { crashPoint, digestBytes, saveJournal } from "./maintenanceJournal"
import type { MigrationJournal } from "./maintenanceJournal"
import { archiveIncompleteDirectory } from "./residueDirectory"
import { candidateVerdict, inspectArtifacts, temporaryVerdict } from "./residueInventory"
import { isLegacyTemporaryName } from "./residueTypes"
import type { ArchivedResidue } from "./residueTypes"
import { BookkeepingMaintenanceRequiredError, ownedFd } from "./storagePaths"
import { retireFile, resumeRetirements } from "./privateRetirement"

function resumeGateRetirements(directory: string): void {
  for (const name of ["deletion-gates", "sdk-process-gates"]) {
    const path = join(directory, name)
    if (!existsSync(path)) continue
    closeSync(ownedFd(path, true))
    resumeRetirements(path)
  }
}

/** Called only under maintenance ownership and explicit operator stop/drain attestation. */
export function planResidueArchive(directory: string): ArchivedResidue[] {
  const inventory = inspectArtifacts(directory)
  return [...inventory.candidates, ...inventory.gates, ...inventory.temporary].map((row) => {
    if (row.verdict === "live") throw new BookkeepingMaintenanceRequiredError(`live residue: ${row.path}`)
    const stat = lstatSync(join(directory, row.path))
    if (row.kind === "incomplete-candidate") {
      closeSync(ownedFd(join(directory, row.path), true, false, true))
      if (readdirSync(join(directory, row.path)).length) throw new Error(`nonempty incomplete candidate: ${row.path}`)
      return { ...row, digest: digestBytes(""), bytes: 0, dev: stat.dev, ino: stat.ino }
    }
    const identity = fileIdentity(directory, row.path, true)
    return { ...row, digest: identity.digest, bytes: identity.bytes, dev: stat.dev, ino: stat.ino }
  })
}

/** Post-READY recovery uses the same durable archive, under explicit stopped-child attestation. */
export function archiveStoppedResidues(directory: string, journal: MigrationJournal): void {
  resumeGateRetirements(directory)
  const planned = planResidueArchive(directory)
  const rows = [...(journal.residues ?? [])]
  for (const row of planned) {
    const prior = rows.find(item => item.path === row.path)
    if (prior && (prior.dev !== row.dev || prior.ino !== row.ino || prior.digest !== row.digest))
      throw new Error(`previously archived residue path reused: ${row.path}`)
    if (!prior) rows.push(row)
  }
  journal.residues = rows
  saveJournal(directory, journal) // archive intent precedes every physical move
  archiveResidues(directory, journal.id, rows)
}

/** Intent is already in PREPARED. Hardlink + fsync + unlink resumes on either side of a crash. */
export function archiveResidues(directory: string, id: string, residues: ArchivedResidue[]): void {
  if (!residues.length) return
  resumeGateRetirements(directory)
  const root = join(directory, "bookkeeping-cycles")
  const cycle = join(root, id)
  const archive = join(cycle, "residue")
  for (const path of [root, cycle, archive]) {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
    closeSync(ownedFd(path, true))
    syncDirectoryDurablySync(dirname(path))
  }
  for (const row of residues) {
    const source = join(directory, row.path)
    const target = join(archive, row.path)
    const parent = dirname(target)
    if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 })
    closeSync(ownedFd(parent, true))
    syncDirectoryDurablySync(dirname(parent))
    if (row.kind === "incomplete-candidate") {
      archiveIncompleteDirectory(directory, source, target, row, id)
      crashPoint(`residue:moved:${row.path}`)
      continue
    }
    const expected = { name: row.path, digest: row.digest, bytes: row.bytes }
    if (existsSync(source)) {
      if (row.path.includes(".candidate-") && candidateVerdict(source) === "live"
        || isLegacyTemporaryName(row.path) && temporaryVerdict(row.path) === "live") {
        throw new BookkeepingMaintenanceRequiredError(`live residue: ${row.path}`)
      }
      verifyFile(directory, row.path, expected)
      const stat = lstatSync(source)
      if (stat.dev !== row.dev || stat.ino !== row.ino) throw new Error(`residue inode changed: ${row.path}`)
    }
    if (!existsSync(target)) {
      if (!existsSync(source)) throw new Error(`residue disappeared: ${row.path}`)
      linkSync(source, target)
      syncDirectoryDurablySync(parent)
      crashPoint(`residue:linked:${row.path}`)
    }
    verifyFile(archive, row.path, expected)
    const archived = lstatSync(target)
    if (archived.dev !== row.dev || archived.ino !== row.ino) throw new Error(`foreign residue archive: ${row.path}`)
    retireFile(source, id, row)
    crashPoint(`residue:moved:${row.path}`)
  }
}
