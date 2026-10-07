import { randomUUID } from "node:crypto"
import {
  closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync,
  existsSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import {
  captureProcessIncarnation, parseProcessIncarnationJson, probeProcessIncarnation,
} from "../processIncarnation"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { BookkeepingBusyError, errorCode } from "./storagePaths"
import { readRetirementIntent, resumeFileRetirement, retireBootstrapAlias, retireFile, sameInode } from "./privateRetirement"
import { shortPrivatePrefix } from "./privateNames"
import type { Residue } from "./residueTypes"
import { isUuidV4 } from "./uuid"

/** Identity is durable before the temporary SQLite inode can exist. */
export function createBootstrapPath(path: string): string {
  const owner = captureProcessIncarnation()
  if (!owner) throw new Error("cannot capture bootstrap process incarnation")
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const fd = openSync(`${temporary}.owner.json`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    writeFileSync(fd, JSON.stringify(owner))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectoryDurablySync(dirname(path))
  return temporary
}

function unlinkIfPresent(path: string): void {
  try {
    retireFile(path, randomUUID())
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }
}

function readOwner(path: string) {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error(`invalid bootstrap owner file: ${path}`)
    }
    return parseProcessIncarnationJson(readFileSync(path, "utf8"))
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
    return undefined
  }
}

/** Read-only classification; no descriptors are opened on SQLite sources or aliases. */
export function bootstrapResidues(path: string): Residue[] {
  const directory = dirname(path), prefix = `${basename(path)}.tmp-`, names = readdirSync(directory)
  const stems = new Set(names.filter(name => name.startsWith(prefix)).map(name => {
    const match = /^(\d+-[0-9a-f-]{36})/.exec(name.slice(prefix.length))?.[1]
    return match && /^\d+$/.test(match.slice(0, match.indexOf("-"))) && isUuidV4(match.slice(match.indexOf("-") + 1)) ? match : undefined
  }).filter((value): value is string => value !== undefined))
  const residues: Residue[] = []
  let linked = false
  const publicStat = existsSync(path) ? lstatSync(path) : undefined
  for (const stem of stems) {
    const temporary = join(directory, prefix + stem), owner = readOwner(temporary + ".owner.json")
    const legacy = `${basename(temporary)}.deletion-intent.releasing-`
    const short = basename(shortPrivatePrefix(temporary + ".deletion-intent", "i"))
    const pending = names.filter(name => name.startsWith(legacy) || name.startsWith(short))
    if (!existsSync(temporary) && !pending.length
      && !["-journal", "-wal", "-shm"].some(suffix => existsSync(temporary + suffix))) continue
    const pid = Number(stem.slice(0, stem.indexOf("-")))
    const verdict = owner && owner.pid === pid ? probeProcessIncarnation(owner) : "indeterminate"
    if (existsSync(temporary)) {
      const stat = lstatSync(temporary)
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) throw new Error("foreign bootstrap inode")
      if (stat.nlink !== 1) {
        if (stat.nlink !== 2 || !publicStat || !sameInode(stat, publicStat)) throw new Error("foreign bootstrap hardlink")
        linked = true
      }
    }
    for (const name of pending) {
      const intent = readRetirementIntent(join(directory, name))
      if (intent.source !== temporary) throw new Error("foreign bootstrap retirement source")
      if (existsSync(intent.private)) {
        const stat = lstatSync(intent.private)
        if (!stat.isFile() || !sameInode(stat, intent)) throw new Error("foreign bootstrap capture")
        if (stat.nlink === 2) {
          if (!publicStat || !sameInode(stat, publicStat)) throw new Error("foreign bootstrap hardlink")
          linked = true
        } else if (stat.nlink !== 1) throw new Error("foreign bootstrap capture link count")
      }
    }
    residues.push({ path: prefix + stem, kind: "bootstrap-alias", verdict: verdict === "dead" ? "dead-incarnation" : verdict === "alive" ? "live" : "unknown" })
  }
  if (publicStat?.nlink === 2 && !linked) {
    // A concurrent bootstrap links its alias and then removes it; a scan that
    // straddles the removal sees the second link without the alias.
    if (lstatSync(path, { throwIfNoEntry: false })?.nlink !== 2)
      throw new BookkeepingBusyError("bootstrap publication changed during inspection; retry")
    throw new Error("bootstrap hardlink has no matching owner provenance")
  }
  if (publicStat && (!publicStat.isFile() || ![1, 2].includes(publicStat.nlink)
    || (process.getuid && publicStat.uid !== process.getuid()) || (publicStat.mode & 0o777) !== 0o600))
    throw new Error("not an owned regular bootstrap publication")
  return residues
}

export function assertDeadBootstrapAliases(path: string): void {
  const residues = bootstrapResidues(path)
  if (residues.some(row => row.verdict !== "dead-incarnation")) throw new BookkeepingBusyError("live or ambiguous bootstrap ownership; stop/recheck original owner, never infer death")
  if (!residues.length) {
    // Callers come here after seeing a second link; a bootstrap that finished
    // since then has already removed its alias.
    if (lstatSync(path, { throwIfNoEntry: false })?.nlink === 1)
      throw new BookkeepingBusyError("bootstrap publication finished during inspection; retry")
    throw new Error("bootstrap alias has no owned provenance")
  }
}

/** No opens of SQLite inodes: closing even an alias would drop this process's POSIX locks. */
export function cleanupBootstrapOrphans(path: string): void {
  const prefix = `${basename(path)}.tmp-`
  for (const name of readdirSync(dirname(path))) {
    if (!name.startsWith(prefix) || !name.endsWith(".owner.json")) continue
    const stem = name.slice(prefix.length, -".owner.json".length)
    const separator = stem.indexOf("-")
    if (!/^\d+$/.test(stem.slice(0, separator)) || !isUuidV4(stem.slice(separator + 1))) continue
    const ownerPath = join(dirname(path), name)
    const owner = readOwner(ownerPath)
    if (!owner || owner.pid !== Number(stem.slice(0, separator)) || probeProcessIncarnation(owner) !== "dead") continue
    const temporary = ownerPath.slice(0, -".owner.json".length)
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const candidate = temporary + suffix
      try {
        const stat = lstatSync(candidate)
        if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) {
          throw new Error(`invalid bootstrap inode: ${candidate}`)
        }
        if (stat.nlink !== 1) {
          const target = lstatSync(path)
          if (suffix || stat.nlink !== 2 || stat.ino !== target.ino || stat.dev !== target.dev) {
            throw new Error(`foreign bootstrap hardlink: ${candidate}`)
          }
        }
        if (stat.nlink === 2) retireBootstrapAlias(candidate, randomUUID(), stat)
        else retireFile(candidate, randomUUID(), stat)
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error
        resumeFileRetirement(candidate)
      }
    }
    unlinkIfPresent(ownerPath)
    syncDirectoryDurablySync(dirname(path))
  }
}

export function finishBootstrap(temporary: string): void {
  unlinkIfPresent(temporary)
  unlinkIfPresent(`${temporary}.owner.json`)
  syncDirectoryDurablySync(dirname(temporary))
}
