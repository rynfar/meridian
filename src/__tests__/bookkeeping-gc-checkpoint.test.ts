import { expect, it } from "bun:test"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "libsql"
import ts from "typescript"
import { initializeSessionBookkeeping, connectionFor, BookkeepingBusyError } from "../proxy/session/bookkeeping/connection"
import { checkpointBookkeepingAsync, withBookkeepingWriteAsync } from "../proxy/session/bookkeeping/transaction"
import { SessionLifecycleLockError, SessionLifecycleQueueCapacityError, SessionLifecycleQueueStalledError } from "../proxy/session/lifecycleErrors"

// Execute the authored server closure with explicit dependencies rather than importing
// the SDK/server's process-global mocks. SQL admission/checkpoint remain real libsql.
function sweepHarness(run: () => Promise<object>, checkpoint: () => Promise<unknown>) {
  const source = ts.createSourceFile("server.ts", readFileSync("src/proxy/server.ts", "utf8"), ts.ScriptTarget.Latest, true)
  let initializer: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "sweepSessionGc") initializer = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!initializer) throw new Error("server GC closure missing")
  const code = ts.transpileModule(`let sessionGcRunning; const sweep = ${initializer.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const rows: Array<{ name: string; data: Record<string, unknown> }> = []
  const warnings: string[] = []
  const create = new Function("runSessionGc", "checkpointProxyBookkeeping", "collectSessionGcPins", "sessionGcOptions",
    "profileCopyPruningEnabled", "pruneSupersededProfileCopies",
    "claudeLog", "plog", "SessionLifecycleLockError", "SessionLifecycleQueueCapacityError", "SessionLifecycleQueueStalledError", "BookkeepingBusyError",
    code + "return sweep;")
  const sweep: () => Promise<void> = create(run, checkpoint, () => [], {}, false, async () => {},
    (name: string, data: Record<string, unknown>) => rows.push({ name, data }),
    (message: string) => warnings.push(message),
    SessionLifecycleLockError, SessionLifecycleQueueCapacityError, SessionLifecycleQueueStalledError, BookkeepingBusyError)
  return { sweep, rows, warnings }
}

it("publishes committed GC counts and deletion warnings even when queued checkpoint expires; retries next sweep", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-checkpoint-"))
  const handle = initializeSessionBookkeeping(dir)
  const blocker = new Database(handle.path)
  blocker.exec("BEGIN IMMEDIATE")
  const pending = withBookkeepingWriteAsync(dir, { lockWaitMs: 2000, lockRetryMs: 2 }, () => true)
  const result = { deleted: 2, notFound: 1, failed: 1 }
  const harness = sweepHarness(async () => result, () => checkpointBookkeepingAsync(dir, { lockWaitMs: 25 }))
  try {
    await harness.sweep()
    expect(harness.rows).toEqual([
      { name: "session.gc", data: result },
      { name: "session.checkpoint_deferred", data: { error: "bookkeeping checkpoint admission expired" } },
    ])
    expect(harness.warnings[0]).toContain("1 failed deletion(s)")
    expect(connectionFor(dir).pending).toBe(1)
    blocker.exec("ROLLBACK")
    await pending
    await harness.sweep()
    expect(harness.rows.filter(row => row.name === "session.gc")).toHaveLength(2)
    expect(harness.rows.filter(row => row.name === "session.gc_failed_closed")).toHaveLength(0)
    expect(connectionFor(dir).pending).toBe(0)
  } finally {
    if (blocker.inTransaction) blocker.exec("ROLLBACK")
    await pending
    blocker.close()
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it("does not classify fatal checkpoint I/O as contention or a failed GC", async () => {
  const result = { deleted: 1, notFound: 0, failed: 0 }
  const fatal = Object.assign(new Error("checkpoint fsync failed"), { code: "SQLITE_IOERR_FSYNC" })
  const harness = sweepHarness(async () => result, async () => { throw fatal })
  await harness.sweep()
  expect(harness.rows).toEqual([
    { name: "session.gc", data: result },
    { name: "session.checkpoint_failed", data: { error: fatal.message } },
  ])
  expect(harness.warnings[0]).toContain("checkpoint failed")
})

it("reports incomplete PASSIVE frames as observable checkpoint debt, not failed GC", async () => {
  const checkpoint = { busy: 0, log: 9, checkpointed: 4 }
  const harness = sweepHarness(async () => ({ deleted: 0, notFound: 0, failed: 0 }), async () => checkpoint)
  await harness.sweep()
  expect(harness.rows).toEqual([{ name: "session.checkpoint_deferred", data: checkpoint }])
})

it("keeps genuine runSessionGc failure fail-closed and never calls checkpoint", async () => {
  let calls = 0
  const harness = sweepHarness(async () => { throw new Error("metadata corrupt") }, async () => { calls++ })
  await harness.sweep()
  expect(harness.rows).toEqual([{ name: "session.gc_failed_closed", data: { error: "metadata corrupt" } }])
  expect(calls).toBe(0)
})
