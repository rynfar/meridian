/**
 * Direct access to a session store's SQLite database, for tests that need to
 * see or leave rows the way another process, or an earlier version, would.
 */

import { spyOn } from "bun:test"
import Database from "libsql"
import { join } from "node:path"
import { closeStoreDatabase, StoreDatabase, type WriteOutcome, type WriteTransaction } from "../proxy/session/storeDatabase"

function withStoreDatabase<T>(dir: string, use: (database: Database.Database) => T): T {
  const database = new Database(join(dir, "sessions.db"))
  try {
    database.exec("PRAGMA busy_timeout = 10000")
    return use(database)
  } finally {
    database.close()
  }
}

/** A mapping as committed to disk, bypassing this process's cache. */
export function readCommittedSession(dir: string, key: string): Record<string, unknown> | undefined {
  return withStoreDatabase(dir, (database) => {
    const row = database.prepare("SELECT entry FROM sessions WHERE key = ?").get(key) as { entry: string } | undefined
    return row ? JSON.parse(row.entry) as Record<string, unknown> : undefined
  })
}

/**
 * Close a store directory's database and release its files, so the directory
 * can be removed on Windows. libsql closes a connection only once its prepared
 * statements are finalized, which happens when they are collected.
 */
export async function releaseStoreDatabase(dir: string): Promise<void> {
  await closeStoreDatabase(dir)
  Bun.gc(true)
  await new Promise((resolve) => setImmediate(resolve))
}

/** The sequence number of the store's latest commit. */
export function committedStoreSeq(dir: string): number {
  return withStoreDatabase(dir, (database) => (
    database.prepare("SELECT seq FROM store_info WHERE id = 1").get() as { seq: number }
  ).seq)
}

/** Commit a mapping row verbatim, as a process on another version would. */
export function commitRawSession(dir: string, key: string, entry: Record<string, unknown>): void {
  withStoreDatabase(dir, (database) => {
    database.exec("BEGIN IMMEDIATE")
    try {
      const { seq } = database.prepare("SELECT seq FROM store_info WHERE id = 1").get() as { seq: number }
      database.prepare(
        "INSERT INTO sessions (key, seq, entry) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET seq = excluded.seq, entry = excluded.entry",
      ).run(key, seq + 1, JSON.stringify(entry))
      database.prepare("UPDATE store_info SET seq = ? WHERE id = 1").run(seq + 1)
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  })
}

/** The transcript keys the lifecycle journal holds, as committed. */
export function committedLifecycleKeys(dir: string): string[] {
  return withStoreDatabase(dir, (database) => (
    database.prepare("SELECT key FROM lifecycle_resources ORDER BY key").all() as Array<{ key: string }>
  ).map((row) => row.key))
}

/** Commit lifecycle journal rows verbatim, as another process would, bypassing validation. */
export function commitRawLifecycleRows(
  dir: string,
  rows: { records?: Record<string, string>; fenceSlots?: Record<string, number> },
): void {
  withStoreDatabase(dir, (database) => {
    database.exec("BEGIN IMMEDIATE")
    try {
      const { seq } = database.prepare("SELECT seq FROM lifecycle_info WHERE id = 1").get() as { seq: number }
      for (const [key, record] of Object.entries(rows.records ?? {})) {
        database.prepare(
          "INSERT INTO lifecycle_resources (key, seq, record) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET seq = excluded.seq, record = excluded.record",
        ).run(key, seq + 1, record)
      }
      for (const [slot, counter] of Object.entries(rows.fenceSlots ?? {})) {
        database.prepare(
          "INSERT INTO lifecycle_fence_slots (slot, counter, seq) VALUES (?, ?, ?) ON CONFLICT(slot) DO UPDATE SET counter = excluded.counter, seq = excluded.seq",
        ).run(slot, counter, seq + 1)
      }
      database.prepare("UPDATE lifecycle_info SET seq = ? WHERE id = 1").run(seq + 1)
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  })
}

/** Rewrite one priority record as another process would, bypassing validation. */
export function commitRawPriorityRecord(
  dir: string,
  table: "priority_assignments" | "priority_attempts" | "priority_rollbacks",
  routeKey: string,
  record: string,
): void {
  withStoreDatabase(dir, (database) => {
    database.exec("BEGIN IMMEDIATE")
    try {
      database.prepare(`UPDATE ${table} SET record = ? WHERE route_key = ?`).run(record, routeKey)
      database.prepare("UPDATE store_info SET seq = seq + 1 WHERE id = 1").run()
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  })
}

/** One priority record exactly as stored. */
export function readCommittedPriorityRecord(
  dir: string,
  table: "priority_assignments" | "priority_attempts" | "priority_rollbacks",
  routeKey: string,
): string | undefined {
  return withStoreDatabase(dir, (database) => {
    const row = database.prepare(`SELECT record FROM ${table} WHERE route_key = ?`).get(routeKey) as { record: string } | undefined
    return row?.record
  })
}

export interface WriteLockHolder {
  pid: number
  /** End the holder's transaction without committing it, and wait for it to exit. */
  release: () => Promise<void>
}

/** Take the store's write lock in another process and keep it until released. */
export async function holdWriteLock(dir: string): Promise<WriteLockHolder> {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      import Database from "libsql"
      const database = new Database(${JSON.stringify(join(dir, "sessions.db"))})
      database.exec("BEGIN IMMEDIATE")
      process.stdout.write("locked\\n")
      for await (const _ of process.stdin) {}
      database.exec("ROLLBACK")
    `],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  })
  const reader = child.stdout.getReader()
  let output = ""
  while (!output.includes("locked")) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`write lock holder exited before locking (${await child.exited})`)
    output += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return {
    pid: child.pid,
    release: async () => {
      await child.stdin.end()
      await child.exited
    },
  }
}

/** The result of SQLite's own consistency check of the store. */
export function storeIntegrity(dir: string): string {
  return withStoreDatabase(dir, (database) => {
    const row = database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
    return row.integrity_check
  })
}

/** Hold the next writes to the store database in `storeDir` until `release`
 *  settles; `landed` runs as each held write commits. Restore the returned spy. */
export function holdStoreWrites(storeDir: string, entered: () => void, release: Promise<void>, landed?: () => void) {
  const transact = StoreDatabase.prototype.transact
  return spyOn(StoreDatabase.prototype, "transact").mockImplementation(async function <T>(
    this: StoreDatabase,
    transaction: WriteTransaction<T>,
  ): Promise<WriteOutcome<T>> {
    const run = transact.bind(this)
    if (this.dir !== storeDir) return run(transaction)
    entered()
    await release
    const outcome = await run(transaction)
    landed?.()
    return outcome
  })
}
