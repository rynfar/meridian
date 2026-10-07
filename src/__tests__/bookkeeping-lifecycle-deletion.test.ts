import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { sqliteLifecycleBackend } from "../proxy/session/bookkeeping/lifecycleSql"
import * as facade from "../proxy/sessionLifecycle"
import * as incarnations from "../proxy/session/processIncarnation"
import { initializeSessionBookkeeping, withBookkeepingWrite, type BookkeepingHandle }
  from "../proxy/session/bookkeeping/database"
import { BookkeepingTextParameterError, connectionFor } from "../proxy/session/bookkeeping/connection"
import { allocateResource, insertResourceLease, readResource } from "../proxy/session/bookkeeping/resources"
import { canonicalizeLocator, resourceKey } from "../proxy/session/bookkeeping/locator"
import { writeMappingRow } from "../proxy/session/bookkeeping/mappings"
import { claimDeletion, attachDeletionExecutor, finishDeletion, runDeletionPhase }
  from "../proxy/session/bookkeeping/lifecycleDeletionSql"
import { sqliteLifecycleLeases, releaseJoinedTranscriptLease } from "../proxy/session/bookkeeping/lifecycleLeasesSql"
import { lifecycleBackendMethods, SessionLifecycleOperationUnavailableError }
  from "../proxy/session/bookkeeping/lifecycleBackend"
import type { TranscriptLocator, TranscriptResourceState } from "../proxy/session/bookkeeping/types"

let directory: string, handle: BookkeepingHandle, options: facade.SessionLifecycleOptions
let onCommit: (() => void) | undefined
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-deletion-")))
  onCommit = undefined
  handle = initializeSessionBookkeeping(directory, { executeTransaction(db, sql) {
    if (sql === "COMMIT") onCommit?.()
    db.exec(sql)
  } })
  options = { storeDir: directory, now: () => 1000 }
})
afterEach(() => {
  onCommit = undefined
  facade.setSessionLifecycleBackendForTest(null)
  handle.close()
  rmSync(directory, { recursive: true, force: true })
})
function seed(id = "a", state: TranscriptResourceState = "retired", updatedAt = 1): TranscriptLocator {
  return withBookkeepingWrite(directory, {}, (tx) => {
    const row = allocateResource(tx, canonicalizeLocator({ configDir: directory, sessionId: id }),
      { state, createdAt: 1, updatedAt, attempts: 0 })
    return { ...row.locator, lifecycleGeneration: row.generation }
  })
}
const row = (locator: TranscriptLocator) => readResource(handle.reader, resourceKey(locator))!
function pin(locator: TranscriptLocator, generation: string | undefined) {
  withBookkeepingWrite(directory, {}, (tx) => writeMappingRow(tx, locator.sessionId, {
    claudeSessionId: locator.sessionId, createdAt: 1, lastUsedAt: 1, messageCount: 0,
    generationId: "mapping", currentTranscript: canonicalizeLocator({ ...locator, lifecycleGeneration: generation }),
  }))
}
function lease(locator: TranscriptLocator) {
  const owner = incarnations.captureProcessIncarnation()!
  withBookkeepingWrite(directory, {}, (tx) => insertResourceLease(tx, resourceKey(locator),
    { token: "lease", owner, createdAt: 1000 }))
  return { token: "lease", resourceKeys: [resourceKey(locator)] }
}

it("an explicitly empty partial backend still refuses public runGc rather than falling through to JSON", async () => {
  facade.setSessionLifecycleBackendForTest({}, lifecycleBackendMethods)
  await expect(facade.runGc([], options)).rejects.toBeInstanceOf(SessionLifecycleOperationUnavailableError)
})

for (const mode of ["null", "exact", "foreign"] as const) {
  it(`durable ${mode} pin cannot be removed by an empty deletion-phase pins argument`, async () => {
    const locator = seed()
    pin(locator, mode === "null" ? undefined : mode === "exact" ? locator.lifecycleGeneration : "foreign")
    let deletes = 0
    const result = await runDeletionPhase([], { ...options, pinProvider: () => [], deleter: async () => { deletes++ } })
    expect(deletes).toBe(mode === "foreign" ? 1 : 0)
    expect(row(locator).state).toBe(mode === "foreign" ? "deleted" : "retired")
    expect(result).toEqual({ deleted: deletes, notFound: 0, failed: 0, deferred: 0 })
  })
}

it("honors ephemeral wildcard/exact pins and refreshes provider outside the transaction", async () => {
  const locator = seed()
  expect(await claimDeletion([{ ...locator, lifecycleGeneration: undefined }], options)).toBeUndefined()
  expect(await claimDeletion([locator], options)).toBeUndefined()
  expect(await claimDeletion([], { ...options, pinProvider: () => {
    expect(connectionFor(directory).scope).toBeUndefined()
    return [locator]
  } })).toBeUndefined()
  expect((await claimDeletion([{ ...locator, lifecycleGeneration: "foreign" }], options))?.state).toBe("deleting")
})

it("claims oldest eligible row across pages, preserving leases, backoff and non-retired states", async () => {
  const leased = seed("leased", "retired", 0)
  lease(leased)
  const future = seed("future", "retired", 0)
  withBookkeepingWrite(directory, {}, (tx) => tx.run("UPDATE resources SET next_attempt_at=1001 WHERE key=?", resourceKey(future)))
  for (const state of ["prepared", "live", "deleted"] as const) seed(state, state, 0)
  const blocked: TranscriptLocator[] = []
  for (let i = 0; i < 130; i++) blocked.push(seed(`p${i}`, "retired", 1))
  const a = seed("z", "retired", 2), b = seed("y", "retired", 2)
  const expected = [a, b].sort((left, right) => resourceKey(left).localeCompare(resourceKey(right)))
  const first = await claimDeletion(blocked, options)
  expect(first?.key).toBe(resourceKey(expected[0]!))
  expect(first?.deletionToken).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
  expect(first?.deletionOwner?.pid).toBe(process.pid)
  expect(first?.rowVersion).toBe(2)
  expect((await claimDeletion(blocked, options))?.key).toBe(resourceKey(expected[1]!))
  expect(await claimDeletion(blocked, options)).toBeUndefined()
  expect(row(leased).state).toBe("retired")
  expect(row(future).state).toBe("retired")
})

it("captures owner outside scope; missing incarnation cannot mutate a row", async () => {
  const locator = seed()
  const original = incarnations.captureProcessIncarnation
  const capture = spyOn(incarnations, "captureProcessIncarnation").mockImplementation(() => {
    expect(connectionFor(directory).scope).toBeUndefined()
    return undefined
  })
  try { await expect(claimDeletion([], options)).rejects.toThrow("cannot capture") }
  finally { capture.mockRestore() }
  expect(row(locator).state).toBe("retired")
  expect(original()).toBeDefined()
})

it("rechecks durable pins inside claim after outside observations have completed", async () => {
  const locator = seed()
  const original = incarnations.captureProcessIncarnation
  const capture = spyOn(incarnations, "captureProcessIncarnation").mockImplementation(() => {
    pin(locator, undefined)
    return original()
  })
  try { expect(await claimDeletion([], options)).toBeUndefined() }
  finally { capture.mockRestore() }
  expect(row(locator).state).toBe("retired")
})

it("defaults to the JSON retry base and cap; invalid finish options roll back the claim unchanged", async () => {
  const locator = seed()
  const candidate = (await claimDeletion([], options))!
  await expect(finishDeletion(candidate.key, candidate.deletionToken!, new Error("error"),
    { ...options, retryBaseMs: 0 })).rejects.toThrow("retryBaseMs")
  expect(row(locator)).toEqual(candidate)
  await finishDeletion(candidate.key, candidate.deletionToken!, new Error("error"), options)
  expect(row(locator).nextAttemptAt).toBe(6000)
  withBookkeepingWrite(directory, {}, (tx) => tx.run("UPDATE resources SET attempts=50,next_attempt_at=0 WHERE key=?", candidate.key))
  const retry = (await claimDeletion([], options))!
  await finishDeletion(retry.key, retry.deletionToken!, "error", options)
  expect(row(locator).nextAttemptAt).toBe(3_601_000)
})

it("phase rejects invalid budgets before claims and invalid scalars without side effects", async () => {
  const locator = seed()
  await expect(runDeletionPhase([], { ...options, maxDeletesPerRun: 0 })).rejects.toThrow("maxDeletesPerRun")
  await expect(runDeletionPhase([], { ...options, runTimeoutMs: 0 })).rejects.toThrow("runTimeoutMs")
  await expect(claimDeletion([], { ...options, now: () => NaN })).rejects.toThrow("finite")
  expect(row(locator).state).toBe("retired")
})

it("claim and finish counters roll back with COMMIT failure; no callback replay", async () => {
  const locator = seed()
  const before = row(locator)
  const counts = handle.reader.all("SELECT * FROM bookkeeping_counts ORDER BY kind")
  onCommit = () => { throw Object.assign(new Error("busy commit"), { code: "SQLITE_BUSY" }) }
  await expect(claimDeletion([], options)).rejects.toThrow("COMMIT busy")
  onCommit = undefined
  expect(row(locator)).toEqual(before)
  expect(handle.reader.all("SELECT * FROM bookkeeping_counts ORDER BY kind")).toEqual(counts)
  const claimed = (await claimDeletion([], options))!
  onCommit = () => { throw Object.assign(new Error("busy commit"), { code: "SQLITE_BUSY" }) }
  await expect(finishDeletion(claimed.key, claimed.deletionToken!, undefined, options)).rejects.toThrow("COMMIT busy")
  onCommit = undefined
  expect(row(locator)).toEqual(claimed)
})

it("attach and finish reject stale token/missing state and only resolve after commit", async () => {
  const locator = seed(), owner = incarnations.captureProcessIncarnation()!
  const candidate = (await claimDeletion([], options))!
  let gateOpened = false
  await expect(attachDeletionExecutor(candidate.key, "wrong", owner, owner.pid, options)
    .then(() => { gateOpened = true })).rejects.toThrow("handshake")
  expect(gateOpened).toBe(false)
  await expect(finishDeletion(candidate.key, "wrong", undefined, options)).rejects.toThrow("was lost")
  expect(row(locator)).toEqual(candidate)
  let committed = false
  onCommit = () => { expect(gateOpened).toBe(false); committed = true }
  await attachDeletionExecutor(candidate.key, candidate.deletionToken!, owner, owner.pid, options)
  expect(committed).toBe(true)
  gateOpened = true
  onCommit = undefined
  expect(row(locator).deletionExecutor).toEqual(owner)
  expect(row(locator).deletionProcessGroupId).toBe(owner.pid)
  await finishDeletion(candidate.key, candidate.deletionToken!, undefined, options)
  expect(row(locator).state).toBe("deleted")
  expect(row(locator).deletionToken).toBeUndefined()
  expect(row(locator).deletionOwner).toBeUndefined()
  expect(row(locator).deletionExecutor).toBeUndefined()
  await expect(attachDeletionExecutor(candidate.key, candidate.deletionToken!, owner, owner.pid, options)).rejects.toThrow("handshake")
  await expect(finishDeletion("missing", "x", undefined, options)).rejects.toThrow("was lost")
  expect(handle.reader.get("SELECT value FROM bookkeeping_counts WHERE kind='resources:deleted'")?.value).toBe(1)
  expect(handle.reader.get("SELECT value FROM bookkeeping_counts WHERE kind='resources:deleting'")?.value).toBe(0)
})

it("failure increments attempts, clips error and applies exponential capped backoff with inclusive due time", async () => {
  const locator = seed()
  let time = 1000
  const opts = { ...options, now: () => time, retryBaseMs: 10, retryMaxMs: 15 }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const candidate = (await claimDeletion([], opts))!
    await finishDeletion(candidate.key, candidate.deletionToken!, new Error("x".repeat(1200)), opts)
    expect(row(locator).attempts).toBe(attempt)
    expect(row(locator).lastError).toHaveLength(1000)
    expect(row(locator).nextAttemptAt).toBe(time + (attempt === 1 ? 10 : 15))
    expect(await claimDeletion([], opts)).toBeUndefined()
    time = row(locator).nextAttemptAt!
  }
  const candidate = (await claimDeletion([], opts))!
  await finishDeletion(candidate.key, candidate.deletionToken!, undefined, opts)
  expect(row(locator).attempts).toBe(3)
  expect(row(locator).lastError).toBeUndefined()
  expect(row(locator).nextAttemptAt).toBeUndefined()
})

it("prunes tombstones by descending timestamp and ascending key tie-break in the finish transaction", async () => {
  const old = seed("old", "deleted", 10), a = seed("a", "deleted", 1000), b = seed("b")
  const candidate = (await claimDeletion([], options))!
  await finishDeletion(candidate.key, candidate.deletionToken!, undefined, { ...options, maxTombstones: 1 })
  expect(readResource(handle.reader, resourceKey(old))).toBeUndefined()
  const winner = [resourceKey(a), resourceKey(b)].sort()[0]
  expect(handle.reader.all("SELECT key FROM resources WHERE state='deleted'")).toEqual([{ key: winner! }])
  expect(handle.reader.get("SELECT value FROM bookkeeping_counts WHERE kind='resources:deleted'")?.value).toBe(1)
})

it("rejects NUL scalars and recursive observation before mutation", async () => {
  const locator = seed(), owner = incarnations.captureProcessIncarnation()!
  await expect(claimDeletion([{ ...locator, sessionId: "bad\0" }], options)).rejects.toBeInstanceOf(BookkeepingTextParameterError)
  await expect(attachDeletionExecutor("bad\0", "x", owner, owner.pid, options)).rejects.toBeInstanceOf(BookkeepingTextParameterError)
  await expect(finishDeletion("x", "bad\0", undefined, options)).rejects.toBeInstanceOf(BookkeepingTextParameterError)
  let nested: Promise<unknown> | undefined
  withBookkeepingWrite(directory, {}, () => { nested = claimDeletion([], options); void nested.catch(() => undefined) })
  await expect(nested!).rejects.toBeInstanceOf(facade.SessionLifecycleReentrancyError)
  expect(row(locator).state).toBe("retired")
})

it("phase runs physical work outside scope and enforces maxDeletesPerRun", async () => {
  seed("a"); seed("b")
  const result = await runDeletionPhase([], { ...options, maxDeletesPerRun: 1, deleter: async (locator) => {
    expect(connectionFor(directory).scope).toBeUndefined()
    expect(row(locator).state).toBe("deleting")
    await Promise.resolve()
    expect(connectionFor(directory).scope).toBeUndefined()
  } })
  expect(result).toEqual({ deleted: 1, notFound: 0, failed: 0, deferred: 1 })
  expect(existsSync(join(directory, "session-gc.json"))).toBe(false)
})

it("phase distinguishes session-specific absence from a generic ENOENT/failure", async () => {
  seed("absent"); seed("failed")
  const result = await runDeletionPhase([], { ...options, deleter: async (locator) => {
    throw new Error(locator.sessionId === "absent" ? "Session absent not found" : "ENOENT SDK module not found")
  } })
  expect(result).toEqual({ deleted: 0, notFound: 1, failed: 1, deferred: 1 })
})

it("hung custom deleter retains permanent fence, double deferred count and break exactly as JSON", async () => {
  const locator = seed()
  let calls = 0
  let settle: (() => void) | undefined
  const keepAlive = setInterval(() => undefined, 100)
  try {
    const result = await runDeletionPhase([], { ...options, deletionTimeoutMs: 15, deleter: () => {
      calls++
      return new Promise<void>((resolve) => { settle = resolve })
    } })
    expect(result).toEqual({ deleted: 0, notFound: 0, failed: 0, deferred: 2 })
    const fenced = row(locator)
    settle!()
    expect(await runDeletionPhase([], { ...options, deleter: async () => { calls++ } }))
      .toEqual({ deleted: 0, notFound: 0, failed: 0, deferred: 1 })
    expect(calls).toBe(1)
    expect(row(locator)).toEqual(fenced)
  } finally { settle?.(); clearInterval(keepAlive) }
})

it("run deadline stops the next claim, not an already started deletion's full timeout", async () => {
  seed("a"); seed("b")
  const result = await runDeletionPhase([], { ...options, runTimeoutMs: 20, deletionTimeoutMs: 500,
    deleter: async () => { await new Promise((resolve) => setTimeout(resolve, 40)) } })
  expect(result).toEqual({ deleted: 1, notFound: 0, failed: 0, deferred: 1 })
})

it("an opened, hung real Node deletion executor stays fenced across GC and reconcile until exact finish", async () => {
  facade.setSessionLifecycleBackendForTest(sqliteLifecycleBackend)
  const locator = seed(), marker = join(directory, "hung-deletion-marker.json")
  const claim = (await claimDeletion([], options))!
  const child = spawn(facade.getSessionGcNodeExecutable(), ["-e", `
    const fs = require('node:fs');
    process.stdin.once('data', () => {
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, node: process.versions.node}));
      process.stdout.write('deletion-entered');
      setInterval(() => {}, 1000);
    });
  `], { detached: true, stdio: ["pipe", "pipe", "pipe"] })
  const exited = once(child, "exit")
  const entered = once(child.stdout!, "data")
  let joined = false
  try {
    let executor: ReturnType<typeof incarnations.captureProcessIncarnation>
    for (let attempt = 0; attempt < 100 && !executor; attempt++) {
      executor = incarnations.captureProcessIncarnation(child.pid!)
      if (!executor) await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(executor).toBeDefined()
    expect(existsSync(marker)).toBe(false)
    await attachDeletionExecutor(claim.key, claim.deletionToken!, executor!, child.pid!, options)
    child.stdin!.write("open gate")
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000)
    try {
      await Promise.race([entered, exited.then(() => { throw new Error("executor exited before gate entry") })])
    } finally { clearTimeout(timeout) }
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ pid: child.pid, node: expect.stringMatching(/^22\./) })
    const fenced = row(locator)
    expect(fenced.state).toBe("deleting")
    expect(fenced.deletionToken).toBe(claim.deletionToken)
    let deletions = 0
    for (let pass = 0; pass < 2; pass++) {
      expect(await facade.runGc([], { ...options, deleter: async () => { deletions++ } }))
        .toEqual({ deleted: 0, notFound: 0, failed: 0, deferred: 1 })
      expect((await facade.reconcile([], options)).deletingRecovered).toBe(0)
      expect(row(locator)).toEqual(fenced)
      expect(await claimDeletion([], options)).toBeUndefined()
    }
    expect(deletions).toBe(0)
    await expect(finishDeletion(claim.key, "foreign-token", undefined, options)).rejects.toThrow("was lost")
    expect(row(locator)).toEqual(fenced)
    // Join only during cleanup; none of the sweeps above observed child completion.
    child.kill("SIGKILL"); await exited; joined = true
    await finishDeletion(claim.key, claim.deletionToken!, undefined, options)
    expect(row(locator).state).toBe("deleted")
  } finally {
    if (!joined) { child.kill("SIGKILL"); await exited }
  }
}, 10_000)

it("retries deferred lease release before claim instead of leaving a retired row fenced", async () => {
  const locator = seed(), active = lease(locator)
  // Aborted async admission produces the same retryable lifecycle lock error as overload.
  const abort = new AbortController(); abort.abort(new facade.SessionLifecycleLockError("admission unavailable"))
  await releaseJoinedTranscriptLease(active, { ...options, admissionSignal: abort.signal })
  expect(handle.reader.all("SELECT token FROM resource_leases")).toHaveLength(1)
  expect(await runDeletionPhase([], { ...options, deleter: async () => undefined }))
    .toEqual({ deleted: 1, notFound: 0, failed: 0, deferred: 0 })
  expect(handle.reader.all("SELECT token FROM resource_leases")).toHaveLength(0)
  expect(Object.keys(sqliteLifecycleLeases)).not.toContain("runGc")
})

it("SIGKILL of the real deletion parent after the SDK gate opens never releases its unjoined executor fence", async () => {
  facade.setSessionLifecycleBackendForTest(sqliteLifecycleBackend)
  const locator = seed(), marker = join(directory, "orphan-marker.json"), sdk = join(directory, "orphan-sdk.mjs")
  writeFileSync(sdk, `import { writeFileSync } from 'node:fs';
    export async function deleteSession(id) {
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify({id,pid:process.pid,node:process.versions.node}));
      setInterval(() => {}, 1000); await new Promise(() => {});
    }`)
  const moduleUrl = (name: string) => pathToFileURL(join(import.meta.dir, "../proxy/session/bookkeeping", name)).href
  const parent = Bun.spawn([process.execPath, "--eval", `
    import { initializeSessionBookkeeping } from ${JSON.stringify(moduleUrl("database.ts"))};
    import { sqliteLifecycleBackend } from ${JSON.stringify(moduleUrl("lifecycleSql.ts"))};
    const handle = initializeSessionBookkeeping(${JSON.stringify(directory)});
    await sqliteLifecycleBackend.runGc([], {
      storeDir: ${JSON.stringify(directory)}, now: () => 1000,
      deletionTimeoutMs: 60000, sdkModuleUrl: ${JSON.stringify(pathToFileURL(sdk).href)}
    });
    handle.close();
  `], { stdout: "ignore", stderr: "pipe" })
  let executor: ReturnType<typeof incarnations.captureProcessIncarnation>
  try {
    for (let attempt = 0; attempt < 500 && !existsSync(marker); attempt++) await Bun.sleep(10)
    expect(existsSync(marker)).toBe(true)
    const entered = JSON.parse(readFileSync(marker, "utf8")) as { id: string; pid: number; node: string }
    expect(entered.id).toBe(locator.sessionId); expect(entered.node).toMatch(/^22\./)
    const fenced = row(locator)
    executor = fenced.deletionExecutor
    expect(executor?.pid).toBe(entered.pid)
    expect(fenced.deletionOwner?.pid).toBe(parent.pid)
    expect(existsSync(join(directory, "deletion-gates", `${fenced.deletionToken}.go`))).toBe(true)
    parent.kill("SIGKILL"); await parent.exited
    expect(incarnations.processIncarnationIsDead(fenced.deletionOwner!)).toBe(true)
    expect(incarnations.processIncarnationIsDead(executor!)).toBe(false)
    let calls = 0
    for (let pass = 0; pass < 2; pass++) {
      expect(await facade.runGc([], { ...options, deleter: async () => { calls++ } }))
        .toEqual({ deleted: 0, notFound: 0, failed: 0, deferred: 1 })
      expect((await facade.reconcile([], options)).deletingRecovered).toBe(0)
      expect(row(locator)).toEqual(fenced)
      expect(await claimDeletion([], options)).toBeUndefined()
    }
    expect(calls).toBe(0)
    process.kill(executor!.pid, "SIGKILL")
    for (let attempt = 0; attempt < 500 && !incarnations.processIncarnationIsDead(executor!); attempt++) await Bun.sleep(10)
    expect(incarnations.processIncarnationIsDead(executor!)).toBe(true)
    await finishDeletion(fenced.key, fenced.deletionToken!, undefined, options)
    expect(row(locator).state).toBe("deleted")
  } finally {
    parent.kill("SIGKILL"); await parent.exited
    executor ??= row(locator).deletionExecutor
    if (executor && !incarnations.processIncarnationIsDead(executor)) process.kill(executor.pid, "SIGKILL")
  }
}, 15_000)

it("real Node child enters marker SDK only after executor attachment commits; capture has no SQL scope", async () => {
  const locator = seed(), marker = join(directory, "marker.json"), sdk = join(directory, "marker-sdk.mjs")
  writeFileSync(sdk, `import { writeFileSync } from 'node:fs';
    export async function deleteSession(id) { writeFileSync(${JSON.stringify(marker)}, JSON.stringify({id,pid:process.pid,node:process.versions.node})); }`)
  const original = incarnations.captureProcessIncarnation
  const capture = spyOn(incarnations, "captureProcessIncarnation").mockImplementation((pid) => {
    expect(connectionFor(directory).scope).toBeUndefined()
    return original(pid)
  })
  let observedAttachmentCommit = false
  onCommit = () => {
    // The raw connection observes the pending update; the gate must not exist until COMMIT returns.
    const connection = connectionFor(directory)
    const pending = connection.db!.prepare("SELECT deletion_token,deletion_executor_json FROM resources WHERE key=?").get(resourceKey(locator)) as
      { deletion_token: string | null; deletion_executor_json: string | null }
    if (pending.deletion_executor_json !== null) {
      observedAttachmentCommit = true
      expect(existsSync(join(directory, "deletion-gates", `${pending.deletion_token}.go`))).toBe(false)
      expect(existsSync(marker)).toBe(false)
    }
  }
  try {
    expect(await runDeletionPhase([], { ...options, sdkModuleUrl: pathToFileURL(sdk).href, deletionTimeoutMs: 2000 }))
      .toEqual({ deleted: 1, notFound: 0, failed: 0, deferred: 0 })
  } finally { capture.mockRestore(); onCommit = undefined }
  expect(observedAttachmentCommit).toBe(true)
  const value = JSON.parse(readFileSync(marker, "utf8")) as { id: string; pid: number; node: string }
  expect(value.id).toBe("a"); expect(value.pid).not.toBe(process.pid); expect(value.node).toMatch(/^22\./)
})

it("failed attachment COMMIT never opens real child gate or runs marker SDK", async () => {
  const locator = seed(), marker = join(directory, "marker"), sdk = join(directory, "marker-sdk.mjs")
  writeFileSync(sdk, `import { writeFileSync } from 'node:fs'; export async function deleteSession() { writeFileSync(${JSON.stringify(marker)}, 'bad'); }`)
  let refused = false
  onCommit = () => {
    const pending = connectionFor(directory).db!.prepare("SELECT deletion_executor_json FROM resources WHERE key=?").get(resourceKey(locator)) as
      { deletion_executor_json: string | null }
    if (pending.deletion_executor_json !== null && !refused) {
      refused = true
      throw Object.assign(new Error("attachment commit refused"), { code: "SQLITE_BUSY" })
    }
  }
  const result = await runDeletionPhase([], { ...options, sdkModuleUrl: pathToFileURL(sdk).href, deletionTimeoutMs: 1000 })
  expect(refused).toBe(true)
  expect(existsSync(marker)).toBe(false)
  expect(result.failed).toBe(1)
  expect(row(locator).state).toBe("retired")
})

it("real child preserves session-specific not-found and ordinary SDK failure classifications", async () => {
  seed("absent"); seed("error")
  const sdk = join(directory, "errors-sdk.mjs")
  writeFileSync(sdk, `export async function deleteSession(id) {
    throw new Error(id === 'absent' ? 'Session absent not found' : 'SDK module not found');
  }`)
  expect(await runDeletionPhase([], { ...options, sdkModuleUrl: pathToFileURL(sdk).href, deletionTimeoutMs: 2000 }))
    .toEqual({ deleted: 0, notFound: 1, failed: 1, deferred: 1 })
})
