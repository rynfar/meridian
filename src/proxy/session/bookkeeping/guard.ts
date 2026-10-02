import Database from "libsql"
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statfsSync,
} from "node:fs"
import { assertDeadBootstrapAliases, cleanupBootstrapOrphans, createBootstrapPath, finishBootstrap } from "./bootstrapOwner"
import { basename, join, resolve } from "node:path"
import { crashPoint } from "./maintenanceJournal"
import { pathToFileURL } from "node:url"
import { SessionLifecycleCorruptError } from "../lifecycleErrors"
import { pragmaValue } from "./schema"
import {
  assertSupportedFilesystem, BookkeepingBusyError, BookkeepingMaintenanceRequiredError, errorCode, ownedFd,
} from "./storagePaths"

import { MAINTENANCE_GUARD_FILENAME, assertNoGuardRetirement } from "./guardIdentity"
export { MAINTENANCE_GUARD_FILENAME } from "./guardIdentity"
const GUARD_APPLICATION_ID = 0x4d534247
const GUARD_SCHEMA = `CREATE TABLE maintenance_guard (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  format TEXT NOT NULL CHECK(format='meridian-bookkeeping-guard'),
  version INTEGER NOT NULL CHECK(version=1),
  epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND 9007199254740991)
) STRICT`

export class BookkeepingGuardBusyError extends BookkeepingBusyError {}

export interface GuardLease {
  readonly path: string
  readonly mode: "shared" | "exclusive"
  close(): void
}
export interface MaintenanceGuardLease extends GuardLease {
  /** Present only when this call exclusively published the guard inode. */
  readonly createdIdentity?: { dev: number; ino: number }
  /** The state recheck runs only after a NEW shared lock was obtained. */
  toShared(verifyBackend: () => void, afterExclusiveCommitForTest?: () => void): GuardLease
}
interface State {
  db?: Database.Database
  mode: "shared" | "exclusive"
  path: string
  epoch: number
  borrowers: number
  refs: number
}
const leases = new WeakMap<GuardLease, State>()
const connections = new Map<string, State>()
const terminal = new Set<string>()
let inspections = 0

function busyError(error: unknown): boolean {
  return (
    error instanceof BookkeepingBusyError || /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(errorCode(error) ?? "")
  )
}
function closeDatabase(db: Database.Database): void {
  try {
    if (db.inTransaction) db.exec("ROLLBACK")
  } finally {
    db.close()
  }
}
function checkFiles(path: string): void {
  closeSync(ownedFd(path))
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      closeSync(ownedFd(path + suffix))
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
  }
}
function pragmas(db: Database.Database): void {
  db.pragma("busy_timeout=0")
  db.pragma("synchronous=FULL")
  if (pragmaValue(db, "busy_timeout") !== 0 || pragmaValue(db, "synchronous") !== 2) {
    throw new SessionLifecycleCorruptError("maintenance guard pragmas refused")
  }
  if (pragmaValue(db, "journal_mode") !== "delete") {
    throw new SessionLifecycleCorruptError("maintenance guard must use DELETE journal, never WAL")
  }
}
function validate(db: Database.Database): number {
  const schema = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string; sql: string }>
  const rows = db.prepare("SELECT singleton,format,version,epoch FROM maintenance_guard").all() as Array<{
    singleton: number
    format: string
    version: number
    epoch: number
  }>
  const row = rows[0]
  if (
    pragmaValue(db, "application_id") !== GUARD_APPLICATION_ID ||
    pragmaValue(db, "user_version") !== 1 ||
    schema.length !== 1 ||
    schema[0]?.name !== "maintenance_guard" ||
    schema[0]?.sql !== GUARD_SCHEMA ||
    rows.length !== 1 ||
    row?.singleton !== 1 ||
    row.format !== "meridian-bookkeeping-guard" ||
    row.version !== 1 ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch < 0
  ) {
    throw new SessionLifecycleCorruptError("maintenance guard format/version mismatch")
  }
  return row.epoch
}

function bootstrap(path: string): { dev: number; ino: number } | undefined {
  cleanupBootstrapOrphans(path)
  if (existsSync(path)) return
  const temporary = createBootstrapPath(path)
  closeSync(openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600))
  let db: Database.Database | undefined
  const close = () => {
    const owned = db
    db = undefined
    try {
      if (owned) closeDatabase(owned)
    } catch (cause) {
      terminal.add(path)
      throw new BookkeepingMaintenanceRequiredError("guard bootstrap close failed; restart process", { cause })
    }
  }
  try {
    db = new Database(temporary)
    db.pragma("journal_mode=DELETE")
    pragmas(db)
    db.exec("BEGIN EXCLUSIVE")
    db.exec(GUARD_SCHEMA)
    db.pragma(`application_id=${GUARD_APPLICATION_ID}`)
    db.pragma("user_version=1")
    db.exec("INSERT INTO maintenance_guard VALUES(1,'meridian-bookkeeping-guard',1,0)")
    db.exec("COMMIT")
    close()
    const fd = ownedFd(temporary)
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(temporary, path)
      crashPoint(`bootstrap:linked:${basename(path)}`)
      const published = lstatSync(temporary)
      return { dev: published.dev, ino: published.ino }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
  } finally {
    close()
    if (!terminal.has(path)) finishBootstrap(temporary)
  }
}

function stateFor(lease: GuardLease): State {
  const state = leases.get(lease)
  if (!state?.db) throw new Error("maintenance guard lease is closed or foreign")
  if (terminal.has(state.path)) throw new BookkeepingMaintenanceRequiredError("guard close failed; restart process")
  return state
}
export function retainGuardLease(lease: GuardLease, mode: State["mode"]): () => void {
  const state = stateFor(lease)
  if (state.mode !== mode || !state.db!.inTransaction)
    throw new Error("guard does not hold the required lock")
  state.borrowers++
  let released = false
  return () => {
    if (!released) {
      released = true
      state.borrowers--
    }
  }
}
export function assertGuardHeld(lease: GuardLease, mode: State["mode"]): void {
  const state = stateFor(lease)
  if (state.mode !== mode || !state.db!.inTransaction)
    throw new Error("guard does not hold the required lock")
}
export function assertGuardLease(lease: GuardLease, directory: string, mode: State["mode"]): void {
  const state = stateFor(lease)
  if (
    state.mode !== mode ||
    state.path !== join(realpathSync.native(resolve(directory)), MAINTENANCE_GUARD_FILENAME)
  ) {
    throw new Error("maintenance guard lease mode/directory mismatch")
  }
}

function openGuard(directory: string, mode: State["mode"], recoveringIdentity?: { dev: number; ino: number }): MaintenanceGuardLease {
  if (inspections) throw new BookkeepingGuardBusyError("same-process inspection guard is held")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const canonical = realpathSync.native(resolve(directory))
  if (!recoveringIdentity) assertNoGuardRetirement(canonical)
  else {
    const identity = lstatSync(join(canonical, MAINTENANCE_GUARD_FILENAME))
    if (!identity.isFile() || identity.dev !== recoveringIdentity.dev || identity.ino !== recoveringIdentity.ino)
      throw new BookkeepingMaintenanceRequiredError("guard recovery identity changed; nothing retired")
  }
  closeSync(ownedFd(canonical, true))
  assertSupportedFilesystem(Number(statfsSync(canonical).type))
  const path = join(canonical, MAINTENANCE_GUARD_FILENAME)
  if (!existsSync(path) && ["session-bookkeeping.sqlite", "session-bookkeeping-migration.json",
    "session-bookkeeping-export.json", "session-bookkeeping-cycle.json"].some(name => existsSync(join(canonical, name))))
    throw new BookkeepingMaintenanceRequiredError("published maintenance guard missing for existing authority; refuse replacement; recover original identity")
  if (terminal.has(path)) throw new BookkeepingMaintenanceRequiredError("guard close failed; restart process")
  const existing = connections.get(path)
  if (existing && (mode !== "shared" || existing.mode !== "shared")) {
    throw new BookkeepingGuardBusyError("maintenance guard is held; stop all proxies before maintenance")
  }
  let createdIdentity: { dev: number; ino: number } | undefined
  let recoverAlias = false
  if (!existing) {
    if (existsSync(path) && lstatSync(path).nlink === 2) {
      if (mode !== "exclusive") throw new BookkeepingGuardBusyError("bootstrap alias requires explicit exclusive recovery")
      assertDeadBootstrapAliases(path)
      recoverAlias = true
    } else {
      createdIdentity = bootstrap(path)
      checkFiles(path)
    }
  }
  let db: Database.Database | undefined
  try {
    let state = existing
    if (!state) {
      db = new Database(path)
      pragmas(db)
      db.exec(mode === "shared" ? "BEGIN" : "BEGIN EXCLUSIVE")
      let epoch = validate(db) // SELECT obtains an actual shared read lock, not merely a deferred BEGIN.
      if (mode === "exclusive") {
        db.exec("UPDATE maintenance_guard SET epoch=epoch+1 WHERE singleton=1")
        epoch = validate(db)
      }
      state = { db, path, mode, epoch, borrowers: 0, refs: 0 }
      connections.set(path, state)
    }
    state.refs++
    const shared = state
    const lease: MaintenanceGuardLease = {
      path,
      ...(createdIdentity ? { createdIdentity } : {}),
      get mode() {
        return shared.mode
      },
      close() {
        if (!leases.has(lease)) return
        if (shared.borrowers) throw new Error("close guarded main handles before releasing the guard")
        if (terminal.has(path)) throw new BookkeepingMaintenanceRequiredError("guard close failed; restart process")
        if (--shared.refs === 0) {
          try {
            if (shared.db) closeDatabase(shared.db)
          } catch (cause) {
            terminal.add(path)
            throw new BookkeepingMaintenanceRequiredError("guard close failed; restart process", { cause })
          }
          shared.db = undefined
          connections.delete(path)
        }
        leases.delete(lease)
      },
      toShared(verifyBackend, afterExclusiveCommitForTest) {
        const current = stateFor(lease)
        if (current.mode !== "exclusive") throw new Error("only an exclusive guard can become shared")
        if (current.borrowers) throw new Error("close guarded main handles before the shared handoff")
        try {
          current.db!.exec("COMMIT")
          afterExclusiveCommitForTest?.()
          current.db!.exec("BEGIN")
          const observed = validate(current.db!)
          if (observed !== current.epoch)
            throw new BookkeepingGuardBusyError(
              "another maintenance operation won the handoff; recheck backend before opening runtime",
            )
          current.mode = "shared"
          const result: unknown = verifyBackend()
          if (result !== null && typeof result === "object" && "then" in result) {
            if (result instanceof Promise) void result.catch(() => undefined)
            throw new TypeError("guard backend recheck must be synchronous")
          }
          return lease
        } catch (error) {
          lease.close()
          if (busyError(error))
            throw new BookkeepingGuardBusyError(
              "guard handoff lost; stop all proxies and retry maintenance",
              { cause: error },
            )
          throw error
        }
      },
    }
    leases.set(lease, state)
    if (recoverAlias) {
      try { cleanupBootstrapOrphans(path) } catch (error) {
        lease.close()
        db = undefined
        throw error
      }
      if (lstatSync(path).nlink !== 1) { lease.close(); db = undefined; throw new Error("guard bootstrap alias recovery incomplete") }
    }
    return lease
  } catch (error) {
    if (db && !connections.has(path)) {
      try {
        closeDatabase(db)
      } catch (cause) {
        terminal.add(path)
        throw new BookkeepingMaintenanceRequiredError("guard close failed; restart process", { cause })
      }
    }
    if (busyError(error))
      throw new BookkeepingGuardBusyError("maintenance guard is held; stop all proxies before maintenance", {
        cause: error,
      })
    if (error instanceof SessionLifecycleCorruptError || error instanceof BookkeepingMaintenanceRequiredError)
      throw error
    throw new SessionLifecycleCorruptError(`maintenance guard startup failed: ${String(error)}`, {
      cause: error,
    })
  }
}

export function acquireRuntimeGuard(directory: string): GuardLease {
  return openGuard(directory, "shared")
}
export function acquireMaintenanceGuard(directory: string): MaintenanceGuardLease {
  return openGuard(directory, "exclusive")
}

/** Recovery may lock only the independently validated ORIGINAL inode, never bootstrap a replacement. */
export function acquireGuardRetirementRecovery(directory: string, identity: { dev: number; ino: number }): MaintenanceGuardLease {
  return openGuard(directory, "exclusive", identity)
}
export function assertGuardRecoveryQuiescent(): void {
  if (connections.size || inspections || terminal.size)
    throw new BookkeepingGuardBusyError("stop local SQLite owners before guard recovery")
}
export function assertInspectionQuiescent(): void {
  if (connections.size || inspections || terminal.size)
    throw new BookkeepingGuardBusyError("same-process inspection forbidden while SQLite handles are open; use a separate CLI process")
}

/** Inspection never bootstraps, repairs permissions, increments epochs or creates a journal. */
export function acquireInspectionGuard(directory: string): GuardLease | undefined {
  // POSIX locks are process-owned: even a readonly auxiliary fd close can revoke
  // SQLite's locks. Reject process-wide, so main/guard hardlink aliases are covered.
  assertInspectionQuiescent()
  const canonical = realpathSync.native(resolve(directory))
  assertNoGuardRetirement(canonical)
  closeSync(ownedFd(canonical, true, false, true))
  const path = join(canonical, MAINTENANCE_GUARD_FILENAME)
  if (!existsSync(path)) return undefined
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    if (existsSync(path + suffix)) closeSync(ownedFd(path + suffix, false, false, true))
  }
  // libsql 0.5 ignores the JS readonly option; the SQLite URI flag is the actual boundary.
  const db = new Database(`${pathToFileURL(path).href}?mode=ro`)
  try {
    db.pragma("busy_timeout=0")
    db.exec("BEGIN")
    validate(db)
    inspections++
    let closed = false
    return { path, mode: "shared", close() {
      if (closed) return
      closeDatabase(db)
      closed = true
      inspections--
    } }
  } catch (error) {
    closeDatabase(db)
    if (busyError(error)) throw new BookkeepingGuardBusyError("maintenance guard is held", { cause: error })
    throw error
  }
}
