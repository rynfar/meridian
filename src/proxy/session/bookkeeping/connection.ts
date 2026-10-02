import Database from "libsql"
import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statfsSync,
} from "node:fs"
import { cleanupBootstrapOrphans, createBootstrapPath, finishBootstrap } from "./bootstrapOwner"
import { setTimeout as delay } from "node:timers/promises"
import { basename, join, resolve } from "node:path"
import { SessionLifecycleCorruptError } from "../lifecycleErrors"
import {
  BookkeepingBusyError, BookkeepingMaintenanceRequiredError, errorCode, ownedFd, assertSupportedFilesystem,
} from "./storagePaths"
export { BookkeepingBusyError, errorCode, assertSupportedFilesystem } from "./storagePaths"
export { BookkeepingMaintenanceRequiredError } from "./storagePaths"
import { initializeBookkeepingSchema, validateBookkeepingSchema, pragmaValue } from "./schema"
import { captureMappingPinsValidation } from "./mappings"
import { validateResourceRows } from "./resources"
import {
  acquireMaintenanceGuard,
  acquireRuntimeGuard,
  assertGuardLease,
  assertGuardHeld,
  retainGuardLease,
} from "./guard"
import type { GuardLease, MaintenanceGuardLease } from "./guard"
import type { BookkeepingReader, SqlRow, SqlValue } from "./types"
import { crashPoint, readJournal, requireBarriers, saveJournal } from "./maintenanceJournal"
import type { MigrationJournal } from "./maintenanceJournal"
import { prepareFreshBootstrap } from "./freshBootstrap"
import { EXPORT_JOURNAL_NAME } from "./exportJournal"

export const BOOKKEEPING_FILENAME = "session-bookkeeping.sqlite"
export interface BookkeepingInitializeOptions {
  executeTransaction?: (db: Database.Database, sql: string) => void
  closeDatabase?: (db: Database.Database) => void
}
export interface Connection {
  db?: Database.Database
  path: string
  refs: number
  pending: number
  scope: "read" | "write" | undefined
  poisoned?: boolean
  phase: string
  guard: GuardLease
  ownsGuard: boolean
  maintenance: boolean
  releaseGuardReference: () => void
  executeTransaction?: BookkeepingInitializeOptions["executeTransaction"]
  closeDatabase?: BookkeepingInitializeOptions["closeDatabase"]
}
const registry = new Map<string, Connection>()
const directories = new Map<string, string>()
const terminal = new Map<string, unknown>()

export function busy(error: unknown): boolean {
  return /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(errorCode(error) ?? "")
}
export function getBookkeepingLockWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const parse = (raw: string | undefined, fallback: number): number => {
    const value = raw?.trim() ? Number(raw) : fallback
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback
  }
  const gc =
    env.MERIDIAN_SESSION_GC_LOCK_WAIT_MS ??
    env.CLAUDE_PROXY_SESSION_GC_LOCK_WAIT_MS ??
    env.SESSION_GC_LOCK_WAIT_MS
  return Math.max(
    parse(gc, 2000),
    parse(env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS ?? env.CLAUDE_PROXY_SESSION_LOCK_TIMEOUT_MS, 10_000),
  )
}

function checkFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      closeSync(ownedFd(path + suffix))
    } catch (error) {
      if (suffix && errorCode(error) === "ENOENT") continue
      throw error
    }
  }
}
export function closeNative(
  db: Database.Database,
  close: (value: Database.Database) => void = (value) => { value.close() },
): void {
  try {
    if (db.inTransaction) db.exec("ROLLBACK")
  } finally {
    try {
      close(db)
    } catch (cause) {
      throw new BookkeepingMaintenanceRequiredError("native close failed; restart process before maintenance", {
        cause,
      })
    }
  }
}
export function database(connection: Connection): Database.Database {
  assertNotTerminal(connection.path)
  if (!connection.db) throw new Error("bookkeeping connection is closed")
  assertGuardHeld(connection.guard, connection.maintenance ? "exclusive" : "shared")
  return connection.db
}
export class BookkeepingTextParameterError extends TypeError {}

export function checkParameters(parameters: SqlValue[]): void {
  if (parameters.some((value) => typeof value === "string" && value.includes("\0"))) {
    throw new BookkeepingTextParameterError("bookkeeping scalar TEXT cannot contain U+0000; encode payload as JSON")
  }
  if (parameters.some((value) => typeof value === "number" && !Number.isSafeInteger(value))) {
    throw new RangeError("bookkeeping numbers must be safe integers")
  }
}
export function getRow(db: Database.Database, sql: string, parameters: SqlValue[]): SqlRow | undefined {
  checkParameters(parameters)
  const row = db.prepare(sql).get(...parameters) as SqlRow | undefined
  if (row) delete row._metadata
  return row
}
export function assertRead(sql: string): void {
  assertSingleStatement(sql)
  const pragmas =
    "journal_mode|synchronous|foreign_keys|busy_timeout|wal_autocheckpoint|user_version|application_id"
  if (
    !/^\s*(SELECT\b|EXPLAIN QUERY PLAN\b)/i.test(sql) &&
    !new RegExp(`^\\s*PRAGMA (${pragmas})\\s*$`, "i").test(sql)
  ) {
    throw new Error("bookkeeping reader cannot mutate")
  }
}
export function assertSingleStatement(sql: string): void {
  if (/;\s*\S/.test(sql)) throw new Error("multiple SQL statements are forbidden")
}
function pragmas(db: Database.Database, journal: "WAL" | "DELETE"): void {
  const values = [
    ["busy_timeout=0", 0],
    ["wal_autocheckpoint=0", 0],
    ["foreign_keys=ON", 1],
    [`journal_mode=${journal}`, journal.toLowerCase()],
    ["synchronous=FULL", 2],
  ] as const
  for (const [setting, expected] of values) {
    db.pragma(setting)
    if (pragmaValue(db, setting.split("=")[0]!) !== expected) throw new Error(`pragma refused: ${setting}`)
  }
}

function bootstrap(path: string, phase = "READY", provenance?: MigrationJournal): void {
  cleanupBootstrapOrphans(path)
  if (existsSync(path)) return
  const temporary = createBootstrapPath(path)
  closeSync(openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600))
  let db: Database.Database | undefined
  const close = () => {
    const owned = db
    db = undefined
    try {
      if (owned) closeNative(owned)
    } catch (error) {
      if (error instanceof BookkeepingMaintenanceRequiredError) terminal.set(path, error)
      throw error
    }
  }
  try {
    db = new Database(temporary)
    pragmas(db, "DELETE")
    db.exec("BEGIN IMMEDIATE")
    initializeBookkeepingSchema(db, true)
    db.prepare("UPDATE schema_meta SET phase=?").run(phase)
    if (provenance) db.prepare("UPDATE schema_meta SET migration_id=?,source_digests_json=?")
      .run(provenance.id, JSON.stringify(provenance.finalSources))
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
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
  } finally {
    close()
    if (!terminal.has(path)) finishBootstrap(temporary)
  }
}

/** Maintenance owns the guard before publishing even an empty, explicitly unfinished main database. */
export function createMaintenanceDatabase(directory: string, guard: MaintenanceGuardLease): void {
  const canonical = realpathSync.native(resolve(directory))
  assertGuardLease(guard, canonical, "exclusive")
  bootstrap(join(canonical, BOOKKEEPING_FILENAME), "PREPARED")
}

function openDatabase(path: string, phase: string, full: boolean, skipRealpathAudit = false): Database.Database {
  checkFiles(path)
  const db = new Database(path)
  try {
    pragmas(db, "WAL")
    db.exec("BEGIN")
    const meta = db.prepare("SELECT phase FROM schema_meta").get() as { phase: string } | undefined
    if (meta?.phase !== phase)
      throw new BookkeepingMaintenanceRequiredError(`bookkeeping phase is not ${phase}`)
    validateBookkeepingSchema(db, phase, full)
    let validatePins: (() => void) | undefined
    let validateResourcePaths: (() => void) | undefined
    if (full) {
      const reader: BookkeepingReader = {
        get: (sql, ...params) => getRow(db, sql, params),
        all: (sql, ...params) => db.prepare(sql).all(...params) as SqlRow[],
      }
      validatePins = captureMappingPinsValidation(reader)
      validateResourcePaths = validateResourceRows(reader)
    }
    db.exec("COMMIT")
    if (!skipRealpathAudit) {
      validatePins?.()
      validateResourcePaths?.()
    }
    return db
  } catch (error) {
    try {
      closeNative(db)
    } catch (closeError) {
      if (closeError instanceof BookkeepingMaintenanceRequiredError) terminal.set(path, closeError)
      throw new AggregateError([error, closeError], "bookkeeping startup cleanup failed")
    }
    throw error
  }
}
export function recover(connection: Connection): void {
  assertNotTerminal(connection.path)
  if (!connection.poisoned) return
  connection.db = openDatabase(connection.path, connection.phase, false)
  connection.poisoned = false
}
export function poison(connection: Connection): unknown | undefined {
  connection.poisoned = true
  const db = connection.db
  connection.db = undefined
  try {
    if (db) closeNative(db, connection.closeDatabase)
  } catch (error) {
    if (error instanceof BookkeepingMaintenanceRequiredError) terminal.set(connection.path, error)
    return error
  }
}
function assertNotTerminal(path: string): void {
  if (terminal.has(path)) {
    throw new BookkeepingMaintenanceRequiredError("native close failed; restart process before maintenance", {
      cause: terminal.get(path),
    })
  }
}
export function executeTransaction(connection: Connection, sql: string): void {
  if (connection.executeTransaction) connection.executeTransaction(database(connection), sql)
  else database(connection).exec(sql)
}
export function connectionFor(directory: string): Connection {
  const known = directories.get(resolve(directory))
  if (!known && [...registry.values()].some((connection) => connection.scope)) {
    throw new Error("cross-database publication is forbidden")
  }
  const path = known ?? join(realpathSync.native(resolve(directory)), BOOKKEEPING_FILENAME)
  const connection = registry.get(path)
  if (!connection)
    throw new BookkeepingMaintenanceRequiredError("initializeSessionBookkeeping before admission")
  return connection
}
export interface BookkeepingHandle {
  readonly path: string
  readonly reader: BookkeepingReader
  close(): void
}

/** Internal opening primitive; expectPhase is exposed only by maintenance.ts, not database.ts. */
export function openHandle(
  directory: string,
  options: BookkeepingInitializeOptions = {},
  expectPhase?: string,
  maintenanceGuard?: MaintenanceGuardLease,
  skipRealpathAudit = false,
): BookkeepingHandle {
  if (skipRealpathAudit && (!maintenanceGuard || expectPhase !== "READY")) {
    throw new Error("skipping realpath audit requires an exclusive READY maintenance handle")
  }
  if ([...registry.values()].some((connection) => connection.scope)) {
    throw new Error("cannot initialize bookkeeping inside a transaction")
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const canonical = realpathSync.native(resolve(directory))
  closeSync(ownedFd(canonical, true))
  assertSupportedFilesystem(Number(statfsSync(canonical).type))
  const path = join(canonical, BOOKKEEPING_FILENAME)
  assertNotTerminal(path)
  let connection = registry.get(path)
  if (connection) {
    if (skipRealpathAudit) throw new BookkeepingBusyError("projection maintenance requires its own handle")
    if (connection.maintenance !== (expectPhase !== undefined)) {
      throw new BookkeepingBusyError("stop all proxies before maintenance; incompatible main handle is open")
    }
    if (expectPhase !== undefined && maintenanceGuard !== connection.guard) {
      throw new BookkeepingBusyError("maintenance main handle requires its owning guard lease")
    }
    if (options.executeTransaction || options.closeDatabase)
      throw new Error("cannot change executor on an already open connection")
    if (connection.scope) throw new Error("cannot initialize bookkeeping inside a transaction")
    if (connection.phase !== (expectPhase ?? "READY"))
      throw new BookkeepingMaintenanceRequiredError("phase mismatch")
  } else {
    const freshGuard = expectPhase === undefined && !existsSync(path) && !readJournal(canonical)
      ? acquireMaintenanceGuard(canonical) : undefined
    const guard =
      maintenanceGuard ?? freshGuard ??
      (expectPhase === undefined ? acquireRuntimeGuard(canonical) : acquireMaintenanceGuard(canonical))
    const ownsGuard = maintenanceGuard === undefined
    let releaseGuardReference: (() => void) | undefined
    try {
      if (freshGuard) {
        const provenance = prepareFreshBootstrap(canonical, freshGuard)
        bootstrap(path, "READY", provenance)
        crashPoint("fresh:database-published")
        provenance.phase = "READY"
        saveJournal(canonical, provenance)
        crashPoint("fresh:READY")
        freshGuard.toShared(() => {
          if (readJournal(canonical)?.phase !== "READY") throw new Error("fresh handoff lost READY")
          requireBarriers(canonical, provenance.id)
        })
      }
      assertGuardLease(guard, canonical, expectPhase === undefined ? "shared" : "exclusive")
      releaseGuardReference = retainGuardLease(guard, expectPhase === undefined ? "shared" : "exclusive")
      const migration = expectPhase === undefined ? readJournal(canonical) : undefined
      if (expectPhase === undefined) {
        if (existsSync(join(canonical, EXPORT_JOURNAL_NAME))) {
          throw new BookkeepingMaintenanceRequiredError("export in progress or completed; resume export-json, not runtime")
        }
        if (migration) {
          if (migration.phase !== "READY" || !existsSync(path)) {
            throw new BookkeepingMaintenanceRequiredError("migration in progress; resume explicit maintenance")
          }
          requireBarriers(canonical, migration.id)
        }
        for (const name of [
          "sessions.json",
          "session-gc.json",
          "sessions.json.lock",
          "session-gc.json.lock",
        ]) {
          if (existsSync(join(canonical, name))) {
            if (migration && name.endsWith(".lock")) continue
            throw new BookkeepingMaintenanceRequiredError("legacy bookkeeping requires offline migration")
          }
        }
        if (!migration) throw new BookkeepingMaintenanceRequiredError("database without owned provenance; refuse implicit adoption")
      }
      const publication = lstatSync(path)
      if (expectPhase === undefined && publication.isFile() && publication.nlink !== 1)
        throw new BookkeepingMaintenanceRequiredError("published bootstrap alias requires recover-bootstrap --writers-stopped before runtime")
      cleanupBootstrapOrphans(path)
      const db = openDatabase(path, expectPhase ?? "READY", true, skipRealpathAudit)
      if (expectPhase === undefined) {
        const meta = getRow(db, "SELECT migration_id,source_digests_json FROM schema_meta", [])
        if ((meta?.migration_id ?? undefined) !== migration?.id
          || (migration && meta?.source_digests_json !== JSON.stringify(migration.finalSources))) {
          try {
            closeNative(db)
          } catch (error) {
            if (error instanceof BookkeepingMaintenanceRequiredError) terminal.set(path, error)
            throw error
          }
          throw new BookkeepingMaintenanceRequiredError("migration database/journal identity mismatch")
        }
      }
      connection = {
        db,
        path,
        refs: 0,
        pending: 0,
        scope: undefined,
        phase: expectPhase ?? "READY",
        guard,
        ownsGuard,
        maintenance: expectPhase !== undefined,
        releaseGuardReference,
        executeTransaction: options.executeTransaction,
        closeDatabase: options.closeDatabase,
      }
      registry.set(path, connection)
    } catch (error) {
      if (terminal.has(path)) throw error
      releaseGuardReference?.()
      if (ownsGuard) guard.close()
      if (error instanceof BookkeepingBusyError || busy(error)) {
        throw new BookkeepingBusyError("bookkeeping startup busy; retry admission", { cause: error })
      }
      if (error instanceof SessionLifecycleCorruptError || error instanceof BookkeepingMaintenanceRequiredError)
        throw error
      throw new SessionLifecycleCorruptError(`bookkeeping startup failed: ${String(error)}`, { cause: error })
    }
  }
  connection.refs++
  directories.set(resolve(directory), path)
  directories.set(canonical, path)
  let owned: Connection | undefined = connection
  function readable(): Database.Database {
    if (!owned) throw new Error("bookkeeping handle is closed")
    if (owned.scope === "write") throw new Error("use the transaction reader inside a write")
    return database(owned)
  }
  return {
    path,
    reader: {
      get(sql, ...params) {
        assertRead(sql)
        return getRow(readable(), sql, params)
      },
      all(sql, ...params) {
        assertRead(sql)
        checkParameters(params)
        return readable()
          .prepare(sql)
          .all(...params) as SqlRow[]
      },
    },
    close() {
      if (!owned) return
      // Releasing a nonfinal owner never closes SQLite or drops its maintenance
      // guard. Only the final owner must wait for every scope/admission to join.
      if (owned.refs === 1 && (owned.scope || owned.pending))
        throw new Error("cannot close during transaction/admission")
      const closing = owned
      owned = undefined
      if (--closing.refs === 0) {
        assertNotTerminal(path)
        const db = closing.db
        let rollbackError: unknown
        try {
          if (db) closeNative(db, closing.closeDatabase)
        } catch (error) {
          if (error instanceof BookkeepingMaintenanceRequiredError) {
            terminal.set(path, error)
            throw error
          }
          rollbackError = error
        }
        closing.db = undefined
        registry.delete(path)
        for (const [alias, target] of directories) if (target === path) directories.delete(alias)
        closing.releaseGuardReference()
        if (closing.ownsGuard) closing.guard.close()
        if (rollbackError) throw rollbackError
      }
    },
  }
}

export function initializeSessionBookkeeping(
  directory: string,
  options: BookkeepingInitializeOptions = {},
): BookkeepingHandle {
  return openHandle(directory, options)
}
export function closeSessionBookkeeping(handle: BookkeepingHandle): void {
  handle.close()
}

/** Startup admission for concurrent fresh-directory publication; no blocking retry loop. */
export async function initializeSessionBookkeepingAsync(
  directory: string,
  options: BookkeepingInitializeOptions = {},
): Promise<BookkeepingHandle> {
  const deadline = performance.now() + getBookkeepingLockWaitMs()
  while (true) {
    try {
      return initializeSessionBookkeeping(directory, options)
    } catch (error) {
      const remaining = deadline - performance.now()
      if (!(error instanceof BookkeepingBusyError) || remaining <= 0) throw error
      await delay(Math.min(remaining, 20 + Math.random() * 10))
    }
  }
}
