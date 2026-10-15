/**
 * The SQLite database behind the shared session store and the transcript
 * lifecycle journal: one file per store directory, shared by every Meridian
 * process that uses the directory.
 *
 * Each process holds two connections to it:
 *
 * - The reader, libsql's synchronous API, serves the store's synchronous reads
 *   on the JS thread. In WAL mode a read never waits for a writer.
 * - The writer, libsql's promise API, runs every write transaction. libsql
 *   executes `exec()` on its own worker threads, so BEGIN IMMEDIATE waiting for
 *   another process's write lock, and COMMIT waiting for its fsync, never block
 *   the event loop. The row writes between them are synchronous statement runs
 *   that only touch SQLite's page cache.
 *
 * The writer's statements are prepared once and live as long as its
 * connection. libsql frees a statement from the garbage collector's finalizer
 * on the JS thread, and freeing it takes the connection's mutex, which a worker
 * thread holds for the whole busy wait or fsync of an `exec()` in flight. A
 * statement collected at the wrong moment would stall the event loop for
 * exactly the wait this design moves off it, so the writer never runs a
 * statement it has not cached. For the same reason nothing but the write queue
 * touches the writer while an `exec()` may be in flight.
 *
 * Nothing in this process may open and close a file descriptor on the
 * database file itself while SQLite has it open: POSIX drops every lock a
 * process holds on a file when any of its descriptors on that file is closed.
 *
 * Tests: under `bun test`, `expect(promise).resolves` and `.rejects` wait for
 * the promise in a nested event loop that never delivers libsql's promise
 * settlements, so a store write inside one hangs until the test times out.
 * Await the write first and assert on its result or error.
 */

import { createHash } from "node:crypto"
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, statSync } from "node:fs"
import { readFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import SyncDatabase from "libsql"
import AsyncDatabase from "libsql/promise"
import { syncDirectoryDurably } from "./durableFileSystem"

export const STORE_DATABASE_NAME = "sessions.db"
const STORE_DATABASE_FORMAT = 1
/** Bounds file descriptors in processes that switch store directories (tests). */
const MAX_OPEN_DATABASES = 4
const DEFAULT_LOCK_WAIT_MS = 10_000

/** How long a write waits for another process's write to finish. */
export function getStoreLockWaitMs(): number {
  const raw = process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS
    ?? process.env.CLAUDE_PROXY_SESSION_LOCK_TIMEOUT_MS
  if (!raw) return DEFAULT_LOCK_WAIT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LOCK_WAIT_MS
  return parsed
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS store_info (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  format               INTEGER NOT NULL,
  meta_version         INTEGER NOT NULL,
  seq                  INTEGER NOT NULL,
  commit_token         TEXT,
  imported_json_sha256 TEXT,
  imported_json_at     INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  key   TEXT PRIMARY KEY,
  seq   INTEGER NOT NULL,
  entry TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS generation_slots (
  slot    TEXT PRIMARY KEY,
  counter INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS priority_assignments (
  route_key TEXT PRIMARY KEY,
  record    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS priority_attempts (
  route_key TEXT PRIMARY KEY,
  record    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS priority_rollbacks (
  route_key TEXT PRIMARY KEY,
  record    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lifecycle_info (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  version              INTEGER NOT NULL,
  seq                  INTEGER NOT NULL,
  commit_token         TEXT,
  imported_json_sha256 TEXT,
  imported_json_at     INTEGER
);
CREATE TABLE IF NOT EXISTS lifecycle_resources (
  key    TEXT PRIMARY KEY,
  seq    INTEGER NOT NULL,
  record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lifecycle_fence_slots (
  slot    TEXT PRIMARY KEY,
  counter INTEGER NOT NULL,
  seq     INTEGER NOT NULL
) WITHOUT ROWID;
INSERT OR IGNORE INTO store_info (id, format, meta_version, seq) VALUES (1, ${STORE_DATABASE_FORMAT}, 1, 0);
INSERT OR IGNORE INTO lifecycle_info (id, version, seq) VALUES (1, 2, 0);
`
const STORE_TABLES = [
  "store_info",
  "sessions",
  "generation_slots",
  "priority_assignments",
  "priority_attempts",
  "priority_rollbacks",
  "lifecycle_info",
  "lifecycle_resources",
  "lifecycle_fence_slots",
]

export type SqlValue = string | number | null

/** One statement of a write transaction and its bound parameters. */
export type WriteOp = readonly [sql: string, params: readonly SqlValue[]]

interface WriterStatement {
  run(...params: SqlValue[]): unknown
}

/** The subset of libsql's untyped promise API the writer relies on. */
interface WriterConnection {
  exec(sql: string): Promise<void>
  prepare(sql: string): Promise<WriterStatement>
  close(): void
}

export interface WriteTransaction<T> {
  /** How long BEGIN IMMEDIATE may wait for another process's write. */
  lockWaitMs: number
  /**
   * Runs synchronously once this process holds the write lock, so everything
   * it reads through the reader is the state the transaction commits on top
   * of. No ops means nothing to commit: the transaction is rolled back.
   */
  build: () => { ops: readonly WriteOp[]; result: T }
  /** Consulted when COMMIT reports an error: whether it landed anyway, which
   *  SQLite allows when the checkpoint that follows a commit fails. */
  landedDespiteError?: () => boolean
}

export interface WriteOutcome<T> {
  committed: boolean
  result: T
}

export class StoreLockTimeoutError extends Error {}

function sqliteCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}

function isBusy(error: unknown): boolean {
  const code = sqliteCode(error)
  return code === "SQLITE_BUSY" || code?.startsWith("SQLITE_BUSY_") === true
}

interface FileIdentity {
  dev: number
  ino: number
}

export class StoreDatabase {
  readonly reader: SyncDatabase.Database
  private readonly writer: WriterConnection
  private readonly writerStatements = new Map<string, WriterStatement>()
  private readonly readerStatements = new Map<string, SyncDatabase.Statement>()
  private writerReady: Promise<void> | undefined
  private writerLockWaitMs: number | undefined
  private queueTail: Promise<void> = Promise.resolve()
  private pending = 0
  private closed = false

  constructor(
    readonly dir: string,
    readonly path: string,
    readonly identity: FileIdentity,
    lockWaitMs: number,
  ) {
    this.reader = new SyncDatabase(path)
    try {
      this.reader.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(lockWaitMs))}`)
      // The reader writes nothing but the schema of a new database, and that
      // needs no fsync of its own: the writer's first FULL commit syncs the
      // whole WAL. It never checkpoints, since an unsynced checkpoint could
      // corrupt the database on power loss.
      this.reader.exec("PRAGMA synchronous = OFF")
      this.reader.exec("PRAGMA wal_autocheckpoint = 0")
      const mode = this.get<{ journal_mode: string }>("PRAGMA journal_mode = WAL")?.journal_mode
      if (mode?.toLowerCase() !== "wal") {
        throw new Error(`cannot enable WAL mode on ${path} (journal_mode=${String(mode)})`)
      }
      this.ensureSchema()
    } catch (error) {
      this.readerStatements.clear()
      this.reader.close()
      throw error
    }
    this.writer = new AsyncDatabase(path, {})
  }

  private ensureSchema(): void {
    const tables = new Set(this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name))
    if (!STORE_TABLES.every((table) => tables.has(table))) {
      this.reader.exec("BEGIN IMMEDIATE")
      try {
        this.reader.exec(SCHEMA)
        this.reader.exec("COMMIT")
      } catch (error) {
        this.reader.exec("ROLLBACK")
        throw error
      }
    }
    const format = this.get<{ format: number }>("SELECT format FROM store_info WHERE id = 1")?.format
    if (format !== STORE_DATABASE_FORMAT) {
      throw new Error(`${this.path} has format ${String(format)}; this Meridian understands only format ${STORE_DATABASE_FORMAT}`)
    }
  }

  /** Synchronous read of one row through the reader. */
  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return (this.readerStatement(sql).get(...params) as T | undefined) ?? undefined
  }

  /** Synchronous read of every matching row through the reader. */
  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.readerStatement(sql).all(...params) as T[]
  }

  /** Run several reads against one snapshot of the database. */
  snapshot<T>(read: () => T): T {
    if (this.reader.inTransaction) return read()
    this.reader.exec("BEGIN")
    try {
      return read()
    } finally {
      this.reader.exec("COMMIT")
    }
  }

  private readerStatement(sql: string): SyncDatabase.Statement {
    let statement = this.readerStatements.get(sql)
    if (!statement) {
      statement = this.reader.prepare(sql)
      this.readerStatements.set(sql, statement)
    }
    return statement
  }

  /** Settles, never rejecting, once every write this process has already
   *  queued has landed. */
  settled(): Promise<void> {
    return this.queueTail
  }

  get idle(): boolean {
    return this.pending === 0
  }

  /** Run `task` after every write this process queued before it. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`[sessionStore] ${this.path} is closed`))
    this.pending++
    const run = this.queueTail.then(task)
    const tail = run.then(() => undefined, () => undefined)
    this.queueTail = tail
    void tail.then(() => { this.pending-- })
    return run
  }

  /** One IMMEDIATE transaction, run in process order through the queue. */
  transact<T>(transaction: WriteTransaction<T>): Promise<WriteOutcome<T>> {
    return this.enqueue(() => this.transactNow(transaction))
  }

  /** One IMMEDIATE transaction, run at once. Only from inside an enqueued task. */
  async transactNow<T>(transaction: WriteTransaction<T>): Promise<WriteOutcome<T>> {
    await this.prepareWriter(transaction.lockWaitMs)
    try {
      await this.writer.exec("BEGIN IMMEDIATE")
    } catch (error) {
      if (isBusy(error)) {
        throw new StoreLockTimeoutError(`[sessionStore] timed out waiting for lock on ${this.path}`, { cause: error })
      }
      throw new Error(`[sessionStore] lock acquire failed: ${(error as Error).message}`, { cause: error })
    }

    let built: { ops: readonly WriteOp[]; result: T }
    try {
      built = transaction.build()
      if (built.ops.length === 0) {
        await this.writer.exec("ROLLBACK")
        return { committed: false, result: built.result }
      }
      const statements: Array<[WriterStatement, readonly SqlValue[]]> = []
      for (const [sql, params] of built.ops) statements.push([await this.writerStatement(sql), params])
      for (const [statement, params] of statements) statement.run(...params)
    } catch (error) {
      await this.rollbackQuietly()
      throw error
    }

    try {
      await this.writer.exec("COMMIT")
    } catch (error) {
      if (transaction.landedDespiteError?.()) {
        console.error("[sessionStore] commit reported an error after landing:", (error as Error).message)
        return { committed: true, result: built.result }
      }
      await this.rollbackQuietly()
      throw new Error(`[sessionStore] write failed: ${(error as Error).message}`, { cause: error })
    }
    return { committed: true, result: built.result }
  }

  private async prepareWriter(lockWaitMs: number): Promise<void> {
    this.writerReady ??= (async () => {
      await this.writer.exec("PRAGMA synchronous = FULL")
      // Keep a one-off large transaction (the import) from leaving a WAL of
      // its size on disk for good. Steady state stays near the 1000-page
      // autocheckpoint, about 4 MB.
      await this.writer.exec("PRAGMA journal_size_limit = 8388608")
    })()
    await this.writerReady
    const busyTimeout = Math.max(0, Math.floor(lockWaitMs))
    if (this.writerLockWaitMs !== busyTimeout) {
      await this.writer.exec(`PRAGMA busy_timeout = ${busyTimeout}`)
      this.writerLockWaitMs = busyTimeout
    }
  }

  private async writerStatement(sql: string): Promise<WriterStatement> {
    let statement = this.writerStatements.get(sql)
    if (!statement) {
      statement = await this.writer.prepare(sql)
      this.writerStatements.set(sql, statement)
    }
    return statement
  }

  private async rollbackQuietly(): Promise<void> {
    try {
      await this.writer.exec("ROLLBACK")
    } catch (error) {
      // SQLite already rolled back a transaction a failed statement or COMMIT
      // aborted; anything else is worth knowing about.
      if (!/no transaction is active/i.test(String((error as Error).message))) {
        console.error("[sessionStore] rollback failed:", (error as Error).message)
      }
    }
  }

  /**
   * Close both connections, the reader first: the last connection to close
   * checkpoints the WAL, and only the writer does that with fsync. Only once
   * idle, since the writer must have nothing in flight.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.readerStatements.clear()
    this.writerStatements.clear()
    try { this.reader.close() } catch (error) {
      console.error("[sessionStore] reader close failed:", (error as Error).message)
    }
    try { this.writer.close() } catch (error) {
      console.error("[sessionStore] writer close failed:", (error as Error).message)
    }
  }
}

const openDatabases = new Map<string, StoreDatabase>()

function statIdentity(path: string): FileIdentity | undefined {
  try {
    const info = statSync(path)
    return { dev: info.dev, ino: info.ino }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function retire(database: StoreDatabase): void {
  if (openDatabases.get(database.dir) === database) openDatabases.delete(database.dir)
  if (database.idle) database.close()
  else void database.settled().then(() => database.close())
}

/**
 * The open database for a store directory, created on first use. A database
 * file that was removed or replaced since it was opened is reopened, so the
 * store never keeps writing to an unlinked inode other processes cannot see.
 */
export function openStoreDatabase(dir: string, lockWaitMs: number): StoreDatabase {
  const path = join(dir, STORE_DATABASE_NAME)
  const existing = openDatabases.get(dir)
  const identity = statIdentity(path)
  if (existing && identity && existing.identity.dev === identity.dev && existing.identity.ino === identity.ino) {
    // Most recently used last, so the bound below closes the stalest.
    openDatabases.delete(dir)
    openDatabases.set(dir, existing)
    return existing
  }
  if (existing) retire(existing)

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  if (!identity) {
    // SQLite gives the -wal and -shm files the mode of the database file, so
    // creating it 0600 first keeps all three private. No SQLite connection in
    // this process has the file open yet, so closing this descriptor is safe.
    try {
      closeSync(openSync(path, "wx", 0o600))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  const opened = new StoreDatabase(dir, path, statIdentity(path) ?? { dev: -1, ino: -1 }, lockWaitMs)
  openDatabases.set(dir, opened)
  for (const [otherDir, other] of openDatabases) {
    if (openDatabases.size <= MAX_OPEN_DATABASES) break
    if (otherDir !== dir && other.idle) retire(other)
  }
  return opened
}

/** The database already open for a directory, without opening one. */
export function peekStoreDatabase(dir: string): StoreDatabase | undefined {
  return openDatabases.get(dir)
}

/** Close the database open for a directory once its queued writes have landed.
 *  Windows refuses to remove a directory that holds an open file. */
export async function closeStoreDatabase(dir: string): Promise<void> {
  const database = openDatabases.get(dir)
  if (!database) return
  openDatabases.delete(dir)
  await database.settled()
  database.close()
}

export function fileDigest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

/**
 * Rename a JSON store the database has taken in to
 * `<name>.migrated-<timestamp>`, never deleting it or anything already there.
 * Returns the new path, or undefined when the file is gone or no longer holds
 * the contents that were imported.
 */
export async function retireImportedFile(path: string, digest: string): Promise<string | undefined> {
  let current: Buffer
  try {
    current = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  if (fileDigest(current) !== digest) return undefined
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  let retiredPath = `${path}.migrated-${stamp}`
  for (let attempt = 1; pathExists(retiredPath); attempt++) retiredPath = `${path}.migrated-${stamp}-${attempt}`
  try {
    await rename(path, retiredPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  await syncDirectoryDurably(dirname(path))
  return retiredPath
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}
