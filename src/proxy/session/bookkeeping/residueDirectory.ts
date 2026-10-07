import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  readdirSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { crashPoint, readJournal, saveJournal } from "./maintenanceJournal"
import type { ArchivedResidue } from "./residueTypes"
import { ownedFd } from "./storagePaths"
import { privateName } from "./privateNames"
import { PrivateIdentityError, sameInode } from "./privateRetirement"

export interface DirectoryArchiveHooks {
  beforeRename?: (privatePath: string) => void
  afterRename?: (privatePath: string) => void
}

/** Directory recovery never renames onto a public name: mismatch retains the captured directory for the operator. */
export function archiveIncompleteDirectory(directory: string, source: string, target: string,
  row: ArchivedResidue, id: string, hooks: DirectoryArchiveHooks = {}): void {
  let captured = row.archiveName
    ? privateName(target + ".residue", id, join(dirname(target), row.archiveName)) : undefined
  if (!captured || !existsSync(captured)) {
    const fd = ownedFd(source, true, false, true)
    try {
      const stat = fstatSync(fd)
      if (!sameInode(stat, row) || readdirSync(source).length) {
        throw new PrivateIdentityError(`incomplete candidate changed/nonempty: ${source}; nothing moved`)
      }
      captured = privateName(target + ".residue", id)
      row.archiveName = basename(captured)
      const journal = readJournal(directory)
      const recorded = journal?.residues?.find((item) => item.path === row.path)
      if (!journal || journal.id !== id || !recorded) throw new PrivateIdentityError("residue intent missing")
      recorded.archiveName = row.archiveName
      saveJournal(directory, journal)
      crashPoint(`residue:intent:${row.path}`)
      hooks.beforeRename?.(captured)
      if (existsSync(captured)) throw new PrivateIdentityError(`occupied private directory: ${captured}`)
      renameSync(source, captured)
      syncDirectoryDurablySync(dirname(source))
      syncDirectoryDurablySync(dirname(captured))
      hooks.afterRename?.(captured)
      crashPoint(`residue:captured:${row.path}`)
    } finally { closeSync(fd) }
  }
  const after = lstatSync(captured)
  const mismatch = !after.isDirectory() || !sameInode(after, row)
  const reason = mismatch ? "identity mismatch after move"
    : readdirSync(captured).length ? "directory became nonempty after move" : null
  const manifest = captured + ".manifest.json"
  if (!existsSync(manifest)) {
    const fd = openSync(manifest, "wx", 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ source, private: captured, before: { dev: row.dev, ino: row.ino },
        after: { dev: after.dev, ino: after.ino }, reason, time: new Date().toISOString() }) + "\n")
      fsyncSync(fd)
    } finally { closeSync(fd) }
    syncDirectoryDurablySync(dirname(manifest))
  } else {
    const evidence: unknown = JSON.parse(readFileSync(manifest, "utf8"))
    if (!evidence || typeof evidence !== "object" || (evidence as Record<string, unknown>).private !== captured) {
      throw new PrivateIdentityError(`foreign residue manifest: ${manifest}; nothing deleted`)
    }
  }
  if (reason) throw new PrivateIdentityError(`${reason}; directory retained at ${captured}; nothing deleted; `
    + `operator must inspect ${manifest} before recovery`)
}
