import { closeSync, constants, existsSync, fstatSync, lstatSync, linkSync, openSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { acquireGuardRetirementRecovery, assertGuardRecoveryQuiescent } from "./guard"
import { MAINTENANCE_GUARD_FILENAME } from "./guardIdentity"
import { inspectionDirectory } from "./inspect"
import { privateName, unlinkPrivate } from "./privateNames"
import { sameInode } from "./privateRetirement"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"
import { isUuidV4 } from "./uuid"

/** Cancel historical guard retirements only by restoring/locking their original inode. */
export function recoverGuardRetirements(input: string, options: { writersStopped: boolean }): void {
  if (!options.writersStopped) throw new BookkeepingMaintenanceRequiredError("guard recovery requires --writers-stopped, including every old maintainer")
  assertGuardRecoveryQuiescent()
  const directory = inspectionDirectory(input)
  const source = join(directory, MAINTENANCE_GUARD_FILENAME)
  const names = readdirSync(directory).filter(name => name.startsWith(`${MAINTENANCE_GUARD_FILENAME}.deletion-intent.releasing-`))
  if (!names.length) throw new BookkeepingMaintenanceRequiredError("no recoverable guard intent; do not recreate the guard; restore an operator-approved coherent backup")
  const intents = names.map(name => {
    const path = join(directory, name)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let row: Record<string, unknown>
    try {
      if (!fstatSync(fd).isFile()) throw new Error("invalid guard retirement intent")
      row = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown>
    } finally { closeSync(fd) }
    if (row.source !== source || !isUuidV4(row.id) || typeof row.private !== "string"
      || ![row.dev, row.ino].every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0))
      throw new Error("invalid guard retirement intent")
    return { dev: Number(row.dev), ino: Number(row.ino),
      capture: privateName(source, row.id, row.private),
      journal: privateName(source + ".deletion-intent", row.id, path) }
  })
  const identity = intents[0]!
  if (intents.some(intent => !sameInode(intent, identity))) throw new Error("conflicting guard retirement identities; refuse recovery")
  for (const intent of intents) {
    if (existsSync(intent.capture)) {
      const captured = lstatSync(intent.capture)
      if (!captured.isFile() || !sameInode(captured, identity)) throw new Error("guard capture identity mismatch")
    }
  }
  if (!existsSync(source)) {
    const captured = intents.find(intent => existsSync(intent.capture))
    if (!captured) throw new Error("original guard inode is gone; restore an operator-approved coherent backup")
    // No-clobber link restores the ORIGINAL lock-bearing inode. A crash here
    // retains intents, so ordinary commands still refuse and this command can resume.
    linkSync(captured.capture, source)
    syncDirectoryDurablySync(directory)
  }
  if (!sameInode(lstatSync(source), identity)) throw new Error("guard recovery identity changed; nothing retired")
  // Keep the restored public inode, removing only its validated private aliases.
  // Do this before native open: nlink>1 is deliberately refused by ownedFd.
  for (const intent of intents) if (existsSync(intent.capture)) unlinkPrivate(intent.capture)
  syncDirectoryDurablySync(directory)
  const guard = acquireGuardRetirementRecovery(directory, identity)
  try {
    if (!sameInode(lstatSync(source), identity)) throw new Error("guard identity changed during recovery")
    for (const intent of intents) {
      unlinkPrivate(intent.journal)
      syncDirectoryDurablySync(directory)
    }
  } finally { guard.close() }
}
