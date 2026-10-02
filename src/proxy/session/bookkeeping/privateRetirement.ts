import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { privateIntentName, privateName, shortPrivatePrefix, unlinkPrivate } from "./privateNames"
import type { PrivatePath } from "./privateNames"
import { errorCode } from "./storagePaths"
import { crashPoint, writeDurably } from "./maintenanceJournal"
import { randomUUID } from "node:crypto"
import { isUuidV4 } from "./uuid"
import { assertGuardNotRetired, assertNoGuardRetirement } from "./guardIdentity"

export class PrivateIdentityError extends Error { readonly exitCode = 5 }
export interface FileIdentity { dev: number; ino: number }
export interface RetirementIntent extends FileIdentity { source: string; private: string; id: string; nativeAlias?: true }
type Intent = RetirementIntent
export interface RetirementHooks {
  beforeRename?: (path: string) => void
  afterRename?: (path: string) => void
}
export function sameInode(a: FileIdentity, b: FileIdentity): boolean { return a.dev === b.dev && a.ino === b.ino }

/** Recovery of a captured file never overwrites a newly occupied public name. */
export function restoreCapturedFile(privatePath: PrivatePath, publicPath: string): never {
  try {
    linkSync(privatePath, publicPath)
    syncDirectoryDurablySync(dirname(publicPath))
    unlinkPrivate(privatePath)
    syncDirectoryDurablySync(dirname(privatePath))
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error
    throw new PrivateIdentityError(`identity changed; nothing deleted; captured file retained at ${privatePath}`)
  }
  throw new PrivateIdentityError(`identity changed; captured file restored at ${publicPath}; nothing deleted`)
}

function complete(intent: Intent, journal: PrivatePath, hooks: RetirementHooks, resumed = false): void {
  let captured = privateName(intent.source, intent.id, intent.private)
  if (!existsSync(captured) && existsSync(intent.source)) {
    if (resumed) {
      captured = privateName(intent.source, intent.id)
      intent.private = captured
      writeDurably(journal, JSON.stringify(intent) + "\n")
    }
    const fd = intent.nativeAlias ? undefined
      : openSync(intent.source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fd === undefined ? lstatSync(intent.source) : fstatSync(fd)
      if (!stat.isFile() || !sameInode(stat, intent)) throw new PrivateIdentityError(`source changed: ${intent.source}`)
      hooks.beforeRename?.(captured)
      if (existsSync(captured)) throw new PrivateIdentityError(`occupied private name: ${captured}`)
      renameSync(intent.source, captured)
      syncDirectoryDurablySync(dirname(captured))
      hooks.afterRename?.(captured)
      crashPoint(`retire:captured:${basename(intent.source)}`)
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  if (existsSync(captured)) {
    if (!sameInode(lstatSync(captured), intent)) restoreCapturedFile(captured, intent.source)
    if (existsSync(intent.source)) {
      throw new PrivateIdentityError(`public name occupied; retained ${captured}; nothing deleted`)
    }
    unlinkPrivate(captured)
    syncDirectoryDurablySync(dirname(captured))
    crashPoint(`retire:deleted:${basename(intent.source)}`)
  }
  unlinkPrivate(journal)
  syncDirectoryDurablySync(dirname(journal))
}

/** Every public-name retirement has its own durable, private intent; intents retire themselves privately. */
function retire(source: string, id: string, expected: FileIdentity | undefined,
  hooks: RetirementHooks, nativeAlias = false, resumeOnly = false): void {
  assertGuardNotRetired(source)
  const directory = dirname(source)
  const prefix = `${basename(source)}.deletion-intent.releasing-`
  const short = basename(shortPrivatePrefix(source + ".deletion-intent", "i"))
  const pending = readdirSync(directory).filter((name) => name.startsWith(prefix) || name.startsWith(short))
  for (const name of pending) {
    const path = join(directory, name)
    const row = readRetirementIntent(path)
    if (row.source !== source) throw new PrivateIdentityError(`invalid deletion intent: ${path}`)
    const intent = { ...row, ...(nativeAlias ? { nativeAlias: true as const } : {}) }
    if (expected && !sameInode(expected, intent)) throw new PrivateIdentityError(`foreign deletion intent: ${path}`)
    complete(intent, privateIntentName(source, intent.id, path), hooks, true)
  }
  if (pending.length || resumeOnly) return
  if (!existsSync(source)) return
  const fd = nativeAlias ? undefined : openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fd === undefined ? lstatSync(source) : fstatSync(fd)
    if (!stat.isFile() || (expected && !sameInode(stat, expected))) {
      throw new PrivateIdentityError(`source identity changed: ${source}`)
    }
    const identity = { dev: stat.dev, ino: stat.ino }
    const captured = privateName(source, id)
    const journal = privateIntentName(source, id)
    const intent: Intent = { ...identity, id, source, private: captured,
      ...(nativeAlias ? { nativeAlias: true as const } : {}) }
    const journalFd = openSync(journal, "wx", 0o600)
    try { writeFileSync(journalFd, JSON.stringify(intent) + "\n"); fsyncSync(journalFd) }
    finally { closeSync(journalFd) }
    syncDirectoryDurablySync(directory)
    crashPoint(`retire:intent:${basename(source)}`)
    complete(intent, journal, hooks)
  } finally { if (fd !== undefined) closeSync(fd) }
}

export function retireFile(source: string, id: string, expected?: FileIdentity, hooks: RetirementHooks = {}): void {
  retire(source, id, expected, hooks)
}

/** Opening/closing a SQLite alias drops this process's POSIX locks. Capture its observed inode without an auxiliary fd. */
export function retireBootstrapAlias(source: string, id: string, expected: FileIdentity): void {
  retire(source, id, expected, {}, true)
}

export function resumeFileRetirement(source: string): void {
  retire(source, randomUUID(), undefined, {}, false, true)
}

/** Explicit maintenance only; resume private captures before interpreting possibly retired control journals. */
export function resumeRetirements(directory: string): void {
  assertNoGuardRetirement(directory)
  const marker = ".deletion-intent.releasing-"
  const sources = new Set(readdirSync(directory).filter((name) => name.includes(marker))
    .map((name) => name.slice(0, name.indexOf(marker))))
  for (const name of sources) resumeFileRetirement(join(directory, name))
  for (const name of readdirSync(directory).filter(name => name.startsWith(".bk-i-"))) {
    const path = join(directory, name)
    const row = readRetirementIntent(path)
    if (dirname(row.source) !== directory) throw new PrivateIdentityError("short retirement source escaped its directory")
    privateIntentName(row.source, row.id, path)
    resumeFileRetirement(row.source)
  }
}

/** Read only intent metadata, never the lock-bearing source/capture inode. */
export function readRetirementIntent(path: string): RetirementIntent {
  const before = lstatSync(path)
  if (!before.isFile() || before.nlink !== 1 || (process.getuid && before.uid !== process.getuid()))
    throw new PrivateIdentityError(`invalid retirement intent: ${path}`)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let row: unknown
  try {
    if (!sameInode(fstatSync(fd), before)) throw new PrivateIdentityError("retirement intent changed")
    row = JSON.parse(readFileSync(fd, "utf8"))
  } finally { closeSync(fd) }
  if (!row || typeof row !== "object") throw new PrivateIdentityError("invalid retirement intent")
  const value = row as Record<string, unknown>
  if (typeof value.source !== "string" || typeof value.private !== "string" || !isUuidV4(value.id)
    || ![value.dev, value.ino].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
    || (value.nativeAlias !== undefined && value.nativeAlias !== true)) throw new PrivateIdentityError("invalid retirement intent")
  privateName(value.source, value.id, value.private)
  return value as unknown as RetirementIntent
}
