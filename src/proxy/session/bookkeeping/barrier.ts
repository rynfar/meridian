import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, renameSync } from "node:fs"
import { basename, join } from "node:path"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { barrierBytes, crashPoint, readJournal, saveJournal } from "./maintenanceJournal"
import type { SourceName } from "./maintenanceJournal"
import { privateName, unlinkPrivate } from "./privateNames"
import { PrivateIdentityError, restoreCapturedFile, sameInode } from "./privateRetirement"

export { PrivateIdentityError as BookkeepingBarrierReplacedError } from "./privateRetirement"
export interface BarrierReleaseHooks {
  beforeRename?: (privatePath: string) => void
  afterRename?: (privatePath: string) => void
}

/** Public names are captured, never unlinked. Only the durable private capability may be deleted. */
export function releaseOwnBarrier(directory: string, source: SourceName, id: string,
  hooks: BarrierReleaseHooks = {}): void {
  const path = join(directory, source + ".lock")
  const replaced = () => new PrivateIdentityError(`barrier replaced or foreign barrier: ${source}; nothing deleted`)
  const journal = readJournal(directory)
  if (!journal || journal.id !== id) throw replaced()
  const previous = journal.releases?.[source]
  if (previous) {
    const captured = privateName(path, id, join(directory, previous.name))
    if (existsSync(captured)) {
      if (!sameInode(lstatSync(captured), previous)) restoreCapturedFile(captured, path)
      if (existsSync(path)) throw replaced()
      const fd = openSync(captured, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        if (!sameInode(fstatSync(fd), previous) || readFileSync(fd, "utf8") !== barrierBytes(id)) throw replaced()
      } finally { closeSync(fd) }
      unlinkPrivate(captured)
      syncDirectoryDurablySync(directory)
      return
    }
    if (existsSync(path) && !sameInode(lstatSync(path), previous)) throw replaced()
  }
  if (!existsSync(path)) return
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const expected = fstatSync(fd)
    if (!expected.isFile() || readFileSync(fd, "utf8") !== barrierBytes(id)) throw replaced()
    const captured = privateName(path, id)
    journal.releases = { ...journal.releases,
      [source]: { name: basename(captured), dev: expected.dev, ino: expected.ino } }
    saveJournal(directory, journal)
    crashPoint(`barrier:intent:${source}`)
    hooks.beforeRename?.(captured)
    if (existsSync(captured)) throw replaced()
    renameSync(path, captured)
    syncDirectoryDurablySync(directory)
    hooks.afterRename?.(captured)
    if (!sameInode(lstatSync(captured), expected)) restoreCapturedFile(captured, path)
    crashPoint(`barrier:captured:${source}`)
    crashPoint(`barrier:releasing:${source}`)
    unlinkPrivate(captured)
    syncDirectoryDurablySync(directory)
  } finally { closeSync(fd) }
}
