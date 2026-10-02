import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as facade from "../proxy/sessionLifecycle"
import * as incarnations from "../proxy/session/processIncarnation"
import { initializeSessionBookkeeping, withBookkeepingWrite, type BookkeepingHandle } from "../proxy/session/bookkeeping/database"
import { connectionFor, BookkeepingTextParameterError } from "../proxy/session/bookkeeping/connection"
import { allocateResource, insertResourceLease, readResource, readResourceLease } from "../proxy/session/bookkeeping/resources"
import { canonicalizeLocator, resourceKey } from "../proxy/session/bookkeeping/locator"
import { writeMappingRow } from "../proxy/session/bookkeeping/mappings"
import { sqliteLifecycleBackend } from "../proxy/session/bookkeeping/lifecycleSql"
import { claimDeletion, attachDeletionExecutor } from "../proxy/session/bookkeeping/lifecycleDeletionSql"
import type { TranscriptLocator, TranscriptResourceState } from "../proxy/session/bookkeeping/types"

let directory: string, handle: BookkeepingHandle, options: facade.SessionLifecycleOptions
let writeStarted = 0, writeTimes: number[] = []
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-reconcile-")))
  writeTimes = []
  handle = initializeSessionBookkeeping(directory, { executeTransaction(db, sql) {
    if (sql === "BEGIN IMMEDIATE") writeStarted = performance.now()
    db.exec(sql)
    if (sql === "COMMIT" && writeStarted) {
      writeTimes.push(performance.now() - writeStarted)
      writeStarted = 0
    }
  } })
  facade.setSessionLifecycleBackendForTest(sqliteLifecycleBackend)
  options = { storeDir: directory, now: () => 1000, preparedGraceMs: 0, retiredGraceMs: 0, maxPending: 4096 }
})
afterEach(() => {
  facade.setSessionLifecycleBackendForTest(null)
  handle.close()
  rmSync(directory, { recursive: true, force: true })
})
function seed(id = "a", state: TranscriptResourceState = "live"): TranscriptLocator {
  return withBookkeepingWrite(directory, {}, (tx) => {
    const resource = allocateResource(tx, canonicalizeLocator({ configDir: directory, sessionId: id }),
      { state, createdAt: 1, updatedAt: 1, attempts: 0 })
    return { ...resource.locator, lifecycleGeneration: resource.generation }
  })
}
const row = (locator: TranscriptLocator) => readResource(handle.reader, resourceKey(locator))!
function pin(locator: TranscriptLocator, generation = locator.lifecycleGeneration, previous = false) {
  withBookkeepingWrite(directory, {}, (tx) => writeMappingRow(tx, locator.sessionId, {
    claudeSessionId: locator.sessionId, createdAt: 1, lastUsedAt: 1, messageCount: 0,
    ...(previous ? { previousClaudeSessionId: locator.sessionId } : {}),
    [previous ? "previousTranscript" : "currentTranscript"]: canonicalizeLocator({ ...locator, lifecycleGeneration: generation }),
  }))
}
function lease(locator: TranscriptLocator, createdAt = 1, executorRecoverable?: boolean) {
  const owner = incarnations.captureProcessIncarnation()!
  withBookkeepingWrite(directory, {}, (tx) => insertResourceLease(tx, resourceKey(locator), {
    token: "old", owner, createdAt, ...(executorRecoverable === undefined ? {} : { executor: owner, executorRecoverable }),
  }))
}

it("keyset visits 257 resources exactly once per phase and retires all eligible rows", async () => {
  const rows = Array.from({ length: 257 }, (_, i) => seed(`r${i}`, i % 2 ? "prepared" : "live"))
  expect(await facade.reconcile([], options)).toEqual({ liveRetired: 129, preparedRetired: 128, resourcesPinned: 0, deletingRecovered: 0 })
  for (const locator of rows) {
    expect(row(locator).state).toBe("retired")
    expect(row(locator).rowVersion).toBe(2)
  }
  expect((await facade.reconcile([], options)).liveRetired).toBe(0)
})

it("captures an upper key boundary before caller publication and excludes later higher keys", async () => {
  seed()
  const upper = String(handle.reader.get("SELECT max(key) AS key FROM resources")!.key)
  let later: TranscriptLocator | undefined
  for (let i = 0; ; i++) {
    const candidate = { configDir: directory, sessionId: `later${i}` }
    if (resourceKey(candidate) > upper) { later = candidate; break }
  }
  let added = false
  await facade.reconcile([], { ...options, pinProvider: () => {
    if (!added) { added = true; later = seed(later!.sessionId) }
    return []
  } })
  expect(row(later!).state).toBe("live")
  expect((await facade.reconcile([], options)).liveRetired).toBe(1)
})

it("a separate scope publishes a durable pin for the next page between page commits", async () => {
  const rows = Array.from({ length: 257 }, (_, i) => seed(`r${i}`)).sort((a, b) => resourceKey(a).localeCompare(resourceKey(b)))
  let scheduled = false, published = false
  const result = await facade.reconcile([], { ...options, pinProvider: () => {
    expect(connectionFor(directory).scope).toBeUndefined()
    if (!scheduled) {
      scheduled = true
      setImmediate(() => { pin(rows[200]!); published = true })
    }
    return []
  } })
  expect(published).toBe(true)
  expect(result.liveRetired).toBe(256)
  expect(result.resourcesPinned).toBe(1)
  expect(row(rows[200]!).state).toBe("live")
})

it("does not apply an old death observation after the lease token is replaced", async () => {
  const locator = seed()
  lease(locator)
  let replaced = false
  const dead = spyOn(incarnations, "processIncarnationIsDead").mockImplementation(() => {
    expect(connectionFor(directory).scope).toBeUndefined()
    if (!replaced) {
      replaced = true
      withBookkeepingWrite(directory, {}, (tx) => tx.run("UPDATE resource_leases SET token='new' WHERE resource_key=?", resourceKey(locator)))
    }
    return true
  })
  try { expect((await facade.reconcile([], options)).liveRetired).toBe(0) }
  finally { dead.mockRestore() }
  expect(readResourceLease(handle.reader, resourceKey(locator), "new")).toBeDefined()
  expect(row(locator).state).toBe("live")
})

it("expires only strictly older unarmed leases and respects prepared grace", async () => {
  const expired = seed("expired"), exact = seed("exact"), prepared = seed("prepared", "prepared")
  lease(expired, 899); lease(exact, 900)
  const result = await facade.reconcile([], { ...options, unarmedLeaseTtlMs: 100, preparedGraceMs: 1000 })
  expect(result.liveRetired).toBe(1)
  expect(result.preparedRetired).toBe(0)
  expect(row(exact).state).toBe("live")
  expect(row(expired).state).toBe("retired")
  expect(row(prepared).state).toBe("prepared")
})

it("rescues pending slots on later pages before passive retirement and preserves admission headroom", async () => {
  const rows = Array.from({ length: 257 }, (_, i) => seed(`r${i}`)).sort((a, b) => resourceKey(a).localeCompare(resourceKey(b)))
  for (const locator of rows.slice(200)) {
    withBookkeepingWrite(directory, {}, (tx) => tx.run("UPDATE resources SET state='retired',row_version=row_version+1 WHERE key=?", resourceKey(locator)))
    pin(locator)
  }
  const result = await facade.reconcile([], { ...options, maxPending: 3 })
  expect(result.liveRetired).toBe(2)
  expect(result.resourcesPinned).toBe(57)
  expect(row(rows[0]!).state).toBe("retired")
  expect(row(rows[1]!).state).toBe("retired")
  expect(row(rows[200]!).state).toBe("live")
  await facade.prepareFork({ configDir: directory, sessionId: "admission" }, { ...options, maxPending: 3 })
  await facade.prepareFork({ configDir: directory, sessionId: "admission2" }, { ...options, maxPending: 3 })
  expect(handle.reader.get("SELECT value FROM bookkeeping_counts WHERE kind='resources:retired'")!.value).toBe(1)
})

it("one-slot configuration still permits passive retirement", async () => {
  seed()
  expect((await facade.reconcile([], { ...options, maxPending: 1 })).liveRetired).toBe(1)
})

it("unrecoverable executor survives apparent death until authoritative boot change", async () => {
  const locator = seed()
  lease(locator, 1, false)
  const dead = spyOn(incarnations, "processIncarnationIsDead").mockReturnValue(true)
  const boot = spyOn(incarnations, "processIncarnationPredatesBoot").mockReturnValue(false)
  try {
    expect((await facade.reconcile([], { ...options, unarmedLeaseTtlMs: 0 })).liveRetired).toBe(0)
    expect(dead).not.toHaveBeenCalled()
    boot.mockReturnValue(true)
    expect((await facade.reconcile([], options)).liveRetired).toBe(1)
  } finally { dead.mockRestore(); boot.mockRestore() }
})

it("indeterminate incarnation is not dead and executor leases do not expire by unarmed TTL", async () => {
  const locator = seed()
  lease(locator, 1, true)
  const owner = incarnations.captureProcessIncarnation()!
  const foreign = { ...owner, hostId: owner.hostId === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64) }
  expect(incarnations.probeProcessIncarnation(foreign)).toBe("indeterminate")
  withBookkeepingWrite(directory, {}, (tx) => tx.run("UPDATE resource_leases SET executor_json=? WHERE resource_key=?",
    JSON.stringify(foreign), resourceKey(locator)))
  expect((await facade.reconcile([], { ...options, unarmedLeaseTtlMs: 0 })).liveRetired).toBe(0)
  expect(readResourceLease(handle.reader, resourceKey(locator), "old")).toBeDefined()
})

for (const mode of ["null", "exact", "foreign"] as const) it(`long-lived previous ${mode} pin uses durable generation matching`, async () => {
  const locator = seed()
  const pinnedLocator = mode === "null" ? { ...locator, lifecycleGeneration: undefined } : locator
  pin(pinnedLocator, mode === "foreign" ? "other" : pinnedLocator.lifecycleGeneration, true)
  for (let i = 0; i < 8; i++) {
    const result = await facade.reconcile([], { ...options, now: () => 1_000_000 + i * 1_000_000 })
    expect(result.resourcesPinned).toBe(mode === "foreign" ? 0 : 1)
    expect(row(locator).state).toBe(mode === "foreign" ? "retired" : "live")
  }
})

it("recovers dead pre-handshake owner but cannot rescue an in-flight deleting pin", async () => {
  const locator = seed("a", "retired")
  await claimDeletion([], options)
  pin(locator)
  expect((await facade.reconcile([], options)).deletingRecovered).toBe(0)
  expect(row(locator).state).toBe("deleting")
  const dead = spyOn(incarnations, "processIncarnationIsDead").mockReturnValue(true)
  try {
    expect(await facade.reconcile([], options)).toEqual({ liveRetired: 0, preparedRetired: 0, resourcesPinned: 1, deletingRecovered: 1 })
  } finally { dead.mockRestore() }
  expect(row(locator).state).toBe("live")
})

it("a surviving process group prevents recovery even after the executor died", async () => {
  if (process.platform === "win32") return // Recovery skips the POSIX process-group probe on win32.
  const locator = seed("a", "retired")
  const claim = await claimDeletion([], options)
  // A real detached group leader: the frozen deletion runtime probes it, nothing is mocked there.
  const group = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
  const dead = spyOn(incarnations, "processIncarnationIsDead").mockReturnValue(true)
  try {
    await attachDeletionExecutor(resourceKey(locator), claim!.deletionToken!, incarnations.captureProcessIncarnation()!, group.pid!, options)
    expect((await facade.reconcile([], options)).deletingRecovered).toBe(0)
    const exited = once(group, "exit")
    group.kill("SIGKILL")
    await exited
    expect((await facade.reconcile([], options)).deletingRecovered).toBe(1)
  } finally {
    dead.mockRestore()
    if (group.exitCode === null && group.signalCode === null) group.kill("SIGKILL")
  }
})

it("deleted pins fail closed; caller NUL and invalid options fail before mutation", async () => {
  const locator = seed("a", "deleted")
  pin(locator)
  await expect(facade.reconcile([], options)).rejects.toThrow("already deleted")
  await expect(facade.reconcile([{ configDir: directory, sessionId: "bad\u0000" }], options)).rejects.toBeInstanceOf(BookkeepingTextParameterError)
  await expect(facade.reconcile([], { ...options, maxPending: 0 })).rejects.toThrow("positive integer")
})

for (const durable of [false, true]) it(`public runGc full expired-lease cycle, durable pin=${durable}`, async () => {
  const locator = seed()
  lease(locator)
  if (durable) pin(locator)
  let deleted = 0
  const result = await facade.runGc([], { ...options, unarmedLeaseTtlMs: 0, deleter: async () => {
    expect(connectionFor(directory).scope).toBeUndefined()
    expect(row(locator).state).toBe("deleting")
    deleted++
  } })
  expect(result).toEqual({ deleted: durable ? 0 : 1, notFound: 0, failed: 0, deferred: 0 })
  expect(deleted).toBe(durable ? 0 : 1)
  expect(row(locator).state).toBe(durable ? "live" : "deleted")
})

for (const count of [128, 2000]) it(`measures full reconcile for ${count} resources`, async () => {
  for (let i = 0; i < count; i++) seed(`bench${i}`)
  const start = performance.now()
  writeTimes = []
  const result = await facade.reconcile([], options)
  const elapsedMs = performance.now() - start
  console.log(JSON.stringify({ reconcileRows: count, elapsedMs, writeTransactions: writeTimes.length,
    maxWriteTransactionMs: Math.max(...writeTimes), writeTimes }))
  expect(result.liveRetired).toBe(count)
})

it("dead armed and unarmed owners are pruned without using executor TTL", async () => {
  const armed = seed("armed"), unarmed = seed("unarmed")
  lease(armed, 1000, true); lease(unarmed, 1000)
  const dead = spyOn(incarnations, "processIncarnationIsDead").mockImplementation(() => {
    expect(connectionFor(directory).scope).toBeUndefined()
    return true
  })
  try { expect((await facade.reconcile([], options)).liveRetired).toBe(2) }
  finally { dead.mockRestore() }
  expect(handle.reader.get("SELECT count(*) AS n FROM resource_leases")!.n).toBe(0)
})

it("stale deletion-owner observation cannot recover a replacement claim", async () => {
  const locator = seed("a", "retired")
  await claimDeletion([], options)
  let changed = false
  const dead = spyOn(incarnations, "processIncarnationIsDead").mockImplementation(() => {
    if (!changed) {
      changed = true
      withBookkeepingWrite(directory, {}, (tx) => tx.run(`UPDATE resources SET deletion_token='new',
        row_version=row_version+1 WHERE key=?`, resourceKey(locator)))
    }
    return true
  })
  try { expect((await facade.reconcile([], options)).deletingRecovered).toBe(0) }
  finally { dead.mockRestore() }
  expect(row(locator).state).toBe("deleting")
  expect(row(locator).deletionToken).toBe("new")
})

it("ephemeral NULL/exact pins supplement durable pins and prepared cutoff is inclusive", async () => {
  const wildcard = seed("wildcard", "prepared"), exact = seed("exact", "retired"), stale = seed("stale", "prepared")
  const result = await facade.reconcile([{ ...wildcard, lifecycleGeneration: undefined }, exact,
    { ...stale, lifecycleGeneration: "foreign" }], { ...options, preparedGraceMs: 999 })
  expect(result).toEqual({ resourcesPinned: 2, preparedRetired: 1, liveRetired: 0, deletingRecovered: 0 })
  expect(row(wildcard).state).toBe("live")
  expect(row(exact).state).toBe("live")
  expect(row(stale).state).toBe("retired")
})
