import { performance } from "node:perf_hooks"
import { setTimeout as delay } from "node:timers/promises"
import { lifecycleLockQueue } from "../lifecycleLockQueue"
import { SessionLifecycleLockError, SessionLifecycleReentrancyError } from "../lifecycleErrors"
import { claudeLog } from "../../../logger"
import {
  assertRead,
  assertSingleStatement,
  busy,
  checkParameters,
  connectionFor,
  database,
  executeTransaction,
  getBookkeepingLockWaitMs,
  getRow,
  poison,
  recover,
  BookkeepingBusyError,
} from "./connection"
import type { Connection } from "./connection"
import type { BookkeepingReader, BookkeepingTransaction, BookkeepingWriteOptions, SqlRow } from "./types"
import { enterBookkeepingIdentityScope } from "./storeIdentity"

export class BookkeepingCommitUncertainError extends Error {
  readonly committed = "unknown"
}
interface Scope {
  connection: Connection
  mode: "read" | "store" | "publication" | "lifecycle"
  tx: BookkeepingTransaction
  reader: BookkeepingReader
  hooks: Array<() => void>
  rollbackOnly: boolean
}
let active: Scope | undefined

type AdmissionWait = (ms: number, signal: AbortSignal) => Promise<void>
export class BookkeepingAdmissionSeamError extends Error {
  constructor(readonly reason: "admission-started" | "already-installed") {
    super(`bookkeeping admission wait seam refused: ${reason}`)
  }
}
let admissionWaitForTest: AdmissionWait | undefined
let admissionWaitInstalled = false
let admissionStarted = false
/** Internal test seam, not public API; production always uses the abortable timer. Installable once,
 * only before the first async admission, so it never changes waits already admitted; clearing is always allowed. */
export function setBookkeepingAdmissionWaitForTest(wait: AdmissionWait | undefined): void {
  if (active) throw new SessionLifecycleReentrancyError("cannot change admission wait inside a transaction")
  if (wait === undefined) {
    admissionWaitForTest = undefined
    return
  }
  if (admissionStarted) throw new BookkeepingAdmissionSeamError("admission-started")
  if (admissionWaitInstalled) throw new BookkeepingAdmissionSeamError("already-installed")
  admissionWaitInstalled = true
  admissionWaitForTest = wait
}

function synchronous<T>(callback: () => T): T {
  const value = callback()
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  ) {
    if (value instanceof Promise) void value.catch(() => undefined)
    throw new TypeError("bookkeeping callback must be synchronous; thenable/await forbidden")
  }
  return value
}
function addressed(directory: string): Connection {
  const connection = connectionFor(directory)
  if (active && active.connection !== connection) throw new Error("cross-database publication is forbidden")
  return connection
}
function rollback(connection: Connection, original: unknown): void {
  if (!connection.db?.inTransaction) return
  try {
    executeTransaction(connection, "ROLLBACK")
  } catch (error) {
    const closeError = poison(connection)
    throw new AggregateError(
      [original, error, ...(closeError ? [closeError] : [])],
      "bookkeeping rollback failed",
    )
  }
}
function commit(connection: Connection): void {
  try {
    executeTransaction(connection, "COMMIT")
  } catch (error) {
    if (busy(error)) throw new BookkeepingBusyError("bookkeeping COMMIT busy; callback not replayed", { cause: error })
    const closeError = poison(connection)
    const cause = closeError ? new AggregateError([error, closeError]) : error
    throw new BookkeepingCommitUncertainError("bookkeeping COMMIT outcome unknown; retain publication pins", {
      cause,
    })
  }
}
function scopeFor(connection: Connection, mode: Scope["mode"]): Scope {
  const check = () => {
    if (active !== scope) throw new Error("bookkeeping transaction capability has expired")
  }
  const reader: BookkeepingReader = {
    get(sql, ...parameters) {
      check()
      assertRead(sql)
      return getRow(database(connection), sql, parameters)
    },
    all(sql, ...parameters) {
      check()
      assertRead(sql)
      checkParameters(parameters)
      return database(connection)
        .prepare(sql)
        .all(...parameters) as SqlRow[]
    },
  }
  const scope: Scope = {
    connection,
    mode,
    reader,
    rollbackOnly: false,
    hooks: [],
    tx: {
      ...reader,
      run(sql, ...parameters) {
        check()
        if (mode === "read") throw new Error("write inside read snapshot")
        const forbidden = /\b(BEGIN|END|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|PRAGMA|VACUUM)\b/i
        if (forbidden.test(sql)) throw new Error("transaction-control SQL is not a row operation")
        assertSingleStatement(sql)
        checkParameters(parameters)
        const db = database(connection)
        try {
          return db.prepare(sql).run(...parameters).changes
        } finally {
          if (!db.inTransaction) {
            const closeError = poison(connection)
            throw new BookkeepingCommitUncertainError("row operation lost its transaction", { cause: closeError })
          }
        }
      },
      afterCommit(hook) {
        check()
        if (mode === "read") throw new Error("hook inside read snapshot")
        scope.hooks.push(hook)
      },
    },
  }
  return scope
}
function report(errors: readonly unknown[], handler: BookkeepingWriteOptions["onHookError"]): void {
  try {
    if (handler) synchronous(() => handler(errors))
    else {
      claudeLog("bookkeeping.hook_error", { errors: errors.map(String) })
      console.error("[bookkeeping] afterCommit hooks failed:", errors)
    }
  } catch (error) {
    try {
      console.error("[bookkeeping] hook error reporting failed:", error)
    } catch {
      return /* Already committed: reporting cannot invalidate publication. */
    }
  }
}
function runStarted<T>(
  connection: Connection,
  options: BookkeepingWriteOptions,
  callback: (tx: BookkeepingTransaction) => T,
  read = false,
): T {
  const scope = scopeFor(connection, read ? "read" : (options.scope ?? "lifecycle"))
  active = scope
  connection.scope = read ? "read" : "write"
  const leaveIdentityScope = enterBookkeepingIdentityScope()
  let result: T
  try {
    result = synchronous(() => callback(scope.tx))
    if (!read && (result === false || scope.rollbackOnly)) {
      scope.hooks.length = 0
      rollback(connection, new Error("callback requested rollback"))
      if (result !== false) throw new Error("nested bookkeeping write requested rollback")
      return result
    }
    commit(connection)
  } catch (error) {
    scope.hooks.length = 0
    rollback(connection, error)
    throw error
  } finally {
    active = undefined
    connection.scope = undefined
    leaveIdentityScope()
  }
  const errors: unknown[] = []
  for (const hook of scope.hooks.splice(0)) {
    try {
      synchronous(hook)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) report(errors, options.onHookError)
  return result
}

export function withBookkeepingWrite<T>(
  directory: string,
  options: BookkeepingWriteOptions,
  callback: (tx: BookkeepingTransaction) => T,
): T {
  const connection = addressed(directory)
  if (active) {
    if ((active.mode !== "store" && active.mode !== "publication") || options.scope !== "store") {
      throw new SessionLifecycleReentrancyError("unexpected recursive lifecycle transaction")
    }
    try {
      const result = synchronous(() => callback(active!.tx))
      if (result === false) active.rollbackOnly = true
      return result
    } catch (error) {
      active.rollbackOnly = true
      throw error
    }
  }
  options.admissionSignal?.throwIfAborted()
  try {
    recover(connection)
    executeTransaction(connection, "BEGIN IMMEDIATE")
  } catch (error) {
    if (busy(error)) throw new BookkeepingBusyError("synchronous bookkeeping busy", { cause: error })
    throw error
  }
  return runStarted(connection, options, callback)
}

export function withBookkeepingWriteAsync<T>(
  directory: string,
  options: BookkeepingWriteOptions,
  callback: (tx: BookkeepingTransaction) => T,
): Promise<T> {
  const connection = addressed(directory)
  if (active)
    throw new SessionLifecycleReentrancyError("async admission inside synchronous bookkeeping callback")
  admissionStarted = true
  const budget = options.lockWaitMs ?? getBookkeepingLockWaitMs(),
    retry = options.lockRetryMs ?? 25
  if (!Number.isSafeInteger(budget) || budget < 0 || !Number.isSafeInteger(retry) || retry <= 0) {
    throw new RangeError("invalid bookkeeping admission budget")
  }
  const started = performance.now()
  const deadline = started + budget
  const timeout = new SessionLifecycleLockError("bookkeeping admission expired")
  const controller = new AbortController()
  const abort = () => controller.abort(options.admissionSignal?.reason)
  options.admissionSignal?.addEventListener("abort", abort, { once: true })
  if (options.admissionSignal?.aborted) abort()
  // Node timers may fire before their monotonic deadline after rounding.
  const expire = () => {
    const remaining = deadline - performance.now()
    if (remaining > 0) timer = setTimeout(expire, Math.max(1, remaining))
    else controller.abort(timeout)
  }
  let timer = setTimeout(expire, budget)
  connection.pending++
  return lifecycleLockQueue
    .run(connection.path, controller.signal, async () => {
      while (true) {
        controller.signal.throwIfAborted()
        if (budget && performance.now() - started >= budget) throw timeout
        try {
          recover(connection)
          executeTransaction(connection, "BEGIN IMMEDIATE")
          break
        } catch (error) {
          if (!busy(error)) throw error
          const left = budget - (performance.now() - started)
          if (left <= 0) throw timeout
          try {
            const waitMs = Math.min(left, retry * (0.75 + Math.random() * 0.5))
            if (admissionWaitForTest) await admissionWaitForTest(waitMs, controller.signal)
            else await delay(waitMs, undefined, { signal: controller.signal })
          } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason
            throw error
          }
        }
      }
      if ((budget !== 0 && performance.now() - started >= budget) || controller.signal.aborted) {
        const error: unknown = controller.signal.aborted ? controller.signal.reason : timeout
        rollback(connection, error)
        throw error
      }
      return runStarted(connection, options, callback)
    })
    .finally(() => {
      connection.pending--
      clearTimeout(timer)
      options.admissionSignal?.removeEventListener("abort", abort)
    })
}
export function withBookkeepingRead<T>(directory: string, callback: (reader: BookkeepingReader) => T): T {
  const connection = addressed(directory)
  if (active) return synchronous(() => callback(active!.reader))
  recover(connection)
  executeTransaction(connection, "BEGIN")
  return runStarted(connection, {}, (tx) => callback({ get: tx.get, all: tx.all }), true)
}

export interface BookkeepingCheckpoint {
  busy: number
  log: number
  checkpointed: number
}
function checkpointIdle(connection: Connection, mode: "PASSIVE" | "TRUNCATE"): BookkeepingCheckpoint {
  if (active) throw new Error("checkpoint requires idle bookkeeping connection")
  if (mode === "TRUNCATE" && connection.refs !== 1)
    throw new Error("offline checkpoint requires sole local handle")
  recover(connection)
  const db = database(connection)
  if (db.inTransaction) throw new Error("checkpoint requires idle bookkeeping connection")
  let rows: BookkeepingCheckpoint[]
  try {
    rows = db.pragma(`wal_checkpoint(${mode})`) as BookkeepingCheckpoint[]
  } catch (error) {
    if (busy(error)) throw new BookkeepingBusyError("bookkeeping checkpoint busy", { cause: error })
    throw error
  }
  if (!rows[0]) throw new Error("missing checkpoint result")
  return rows[0]
}
function checkpoint(directory: string, mode: "PASSIVE" | "TRUNCATE"): BookkeepingCheckpoint {
  const connection = addressed(directory)
  if (connection.pending) throw new Error("checkpoint requires idle bookkeeping connection")
  return checkpointIdle(connection, mode)
}

/** One PASSIVE opportunity at the FIFO head, outside BEGIN; later arrivals cannot overtake it.
 * The whole queue wait is bounded, and pending retains the handle until settlement.
 * External readers/writers may still prevent progress: the returned frame counts expose that debt. */
export function checkpointBookkeepingAsync(
  directory: string,
  options: Pick<BookkeepingWriteOptions, "lockWaitMs" | "admissionSignal"> = {},
): Promise<BookkeepingCheckpoint> {
  const connection = addressed(directory)
  if (active) throw new SessionLifecycleReentrancyError("checkpoint admission inside bookkeeping transaction")
  const budget = options.lockWaitMs ?? getBookkeepingLockWaitMs()
  if (!Number.isSafeInteger(budget) || budget < 0) throw new RangeError("invalid checkpoint admission budget")
  const deadline = performance.now() + budget
  const controller = new AbortController()
  const timeout = new SessionLifecycleLockError("bookkeeping checkpoint admission expired")
  const abort = () => controller.abort(options.admissionSignal?.reason)
  options.admissionSignal?.addEventListener("abort", abort, { once: true })
  if (options.admissionSignal?.aborted) abort()
  const expire = () => {
    const remaining = deadline - performance.now()
    if (remaining > 0) timer = setTimeout(expire, Math.max(1, remaining))
    else controller.abort(timeout)
  }
  let timer = setTimeout(expire, budget)
  connection.pending++
  return lifecycleLockQueue.run(connection.path, controller.signal, async () => {
    controller.signal.throwIfAborted()
    if (budget && performance.now() >= deadline) throw timeout
    // pending includes this holder and later waiters; exclusion comes from owning the FIFO,
    // not from pretending those admissions do not exist. Never acquire a write transaction.
    return checkpointIdle(connection, "PASSIVE")
  }).finally(() => {
    connection.pending--
    clearTimeout(timer)
    options.admissionSignal?.removeEventListener("abort", abort)
  })
}
export function checkpointBookkeeping(directory: string, mode: "PASSIVE" = "PASSIVE"): BookkeepingCheckpoint {
  if (mode !== "PASSIVE") throw new Error("TRUNCATE requires explicit offline checkpoint")
  return checkpoint(directory, mode)
}
export function checkpointBookkeepingOffline(directory: string, mode: "TRUNCATE"): BookkeepingCheckpoint {
  if (mode !== "TRUNCATE") throw new Error("invalid offline checkpoint mode")
  return checkpoint(directory, mode)
}
