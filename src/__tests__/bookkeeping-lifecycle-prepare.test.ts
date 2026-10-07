import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as facade from "../proxy/sessionLifecycle"
import * as incarnations from "../proxy/session/processIncarnation"
import * as store from "../proxy/sessionStore"
import { initializeSessionBookkeeping, withBookkeepingWrite, type BookkeepingHandle }
  from "../proxy/session/bookkeeping/database"
import { BookkeepingTextParameterError } from "../proxy/session/bookkeeping/connection"
import { allocateResource, insertResourceLease, readResource } from "../proxy/session/bookkeeping/resources"
import { canonicalizeLocator, resourceKey } from "../proxy/session/bookkeeping/locator"
import { sqliteLifecyclePrepare } from "../proxy/session/bookkeeping/lifecyclePrepareSql"
import { sqliteLifecycleRegister } from "../proxy/session/bookkeeping/lifecycleRegisterSql"
import { sqliteLifecycleTransitions } from "../proxy/session/bookkeeping/lifecycleTransitionsSql"
import { sqliteLifecycleLeases } from "../proxy/session/bookkeeping/lifecycleLeasesSql"
import type { TranscriptLocator, TranscriptResourceState } from "../proxy/session/bookkeeping/types"

let directory: string, handle: BookkeepingHandle, options: facade.SessionLifecycleOptions
let statements: string[]
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-prepare-")))
  statements = []
  handle = initializeSessionBookkeeping(directory, { executeTransaction(db, sql) { statements.push(sql); db.exec(sql) } })
  options = { storeDir: directory, now: () => 1000 }
  facade.setSessionLifecycleBackendForTest({ ...sqliteLifecycleLeases, ...sqliteLifecyclePrepare,
    ...sqliteLifecycleRegister, ...sqliteLifecycleTransitions },
  ["publishPinnedTranscript", "attachPinnedTranscript", "reconcile", "runGc"])
})
afterEach(() => {
  facade.setSessionLifecycleBackendForTest(null)
  handle.close()
  rmSync(directory, { recursive: true, force: true })
})
const locator = (sessionId = "a"): TranscriptLocator => ({ configDir: directory, sessionId })
const row = (loc: TranscriptLocator) => readResource(handle.reader, resourceKey(loc))!
function seed(id: string, state: TranscriptResourceState, updatedAt = 1) {
  const canonical = canonicalizeLocator(locator(id))
  return withBookkeepingWrite(directory, {}, (tx) => {
    const resource = allocateResource(tx, canonical, { state, createdAt: 1, updatedAt, attempts: 0 })
    return { ...resource.locator, lifecycleGeneration: resource.generation }
  })
}
function counts() {
  return Object.fromEntries(handle.reader.all("SELECT kind,value FROM bookkeeping_counts WHERE kind LIKE 'resources:%'")
    .map((r) => [String(r.kind).slice(10), r.value]))
}

it("allocates fence, prepared row and publication incarnation in one transaction; rollback includes every row", async () => {
  const loc = locator()
  const result = await facade.prepareForkForPublication(loc, options)
  expect(loc).toEqual(result)
  expect(row(loc).state).toBe("prepared")
  expect(result.lifecycleGeneration).toBe(`r:${resourceKey(loc)}:1`)
  const lease = handle.reader.get("SELECT * FROM resource_leases")!
  expect(lease.purpose).toBe("publication")
  expect(JSON.parse(String(lease.owner_json)).pid).toBe(process.pid)
  expect(statements).toEqual(["BEGIN IMMEDIATE", "COMMIT"])
  expect(counts()).toEqual({ prepared: 1, live: 0, retired: 0, deleting: 0, deleted: 0 })
  const before = handle.reader.all("SELECT * FROM fence_slots")
  const failed = locator("rollback")
  await expect(facade.prepareForkForPublication(failed, { ...options, maxTombstones: 0 })).rejects.toThrow("maxTombstones")
  expect(row(failed)).toBeUndefined()
  expect(failed.lifecycleGeneration).toBeUndefined()
  expect(handle.reader.all("SELECT * FROM fence_slots")).toEqual(before)
  expect(handle.reader.all("SELECT * FROM resource_leases")).toEqual([lease])
  expect(existsSync(join(directory, "session-gc.json"))).toBe(false)
})

for (const state of ["prepared", "live", "retired", "deleting", "deleted"] as const) {
  it(`matches existing prepare/journal/register/commit/abandon guards for ${state}`, async () => {
    const loc = seed(state, state)
    const before = row(loc)
    await expect(facade.prepareForkForPublication(loc, options)).rejects.toThrow("already exists")
    await expect(facade.prepareFork({ ...loc, lifecycleGeneration: undefined }, options)).rejects.toThrow("stale or missing")
    if (state === "deleted") await expect(facade.prepareFork(loc, options)).rejects.toThrow("already deleted")
    else expect(await facade.prepareFork(loc, options)).toEqual(loc)
    if (state === "deleted" || state === "deleting") {
      await expect(facade.ensureTranscriptJournaled(loc, options)).rejects.toThrow(`from state ${state}`)
      await expect(facade.registerLiveTranscript(loc, options)).rejects.toThrow(`from state ${state}`)
    } else {
      statements.length = 0
      expect(await facade.ensureTranscriptJournaled(loc, options)).toEqual(loc)
      expect(row(loc)).toEqual(before)
      expect(statements.filter((sql) => sql === "BEGIN IMMEDIATE")).toHaveLength(0)
    }
    if (state === "prepared" || state === "live") {
      await facade.commitFork(loc, options)
      expect(row(loc).state).toBe("live")
      const committed = row(loc)
      await facade.commitFork(loc, options)
      expect(row(loc)).toEqual(committed)
    } else await expect(facade.commitFork(loc, options)).rejects.toThrow(`from state ${state}`)
    await facade.abandonFork(loc, { ...options, retiredGraceMs: 3 })
    expect(row(loc).state).toBe(state === "live" || state === "prepared" ? "retired" : state)
    if (state === "live" || state === "prepared") expect(row(loc).nextAttemptAt).toBe(1003)
    const abandoned = row(loc)
    await facade.abandonFork(loc, options)
    expect(row(loc)).toEqual(abandoned)
  })
}

for (const operation of ["prepareFork", "ensureTranscriptJournaled", "registerLiveTranscript", "commitFork", "abandonFork"] as const) {
  it(`${operation} rejects locator collisions, stale generations and NUL scalars`, async () => {
    const loc = seed("a", "prepared")
    const before = row(loc)
    await expect(facade[operation]({ ...loc, projectDir: directory }, options))
      .rejects.toBeInstanceOf(facade.SessionLifecycleCorruptError)
    await expect(facade[operation]({ ...loc, lifecycleGeneration: "stale" }, options)).rejects.toThrow("stale or missing")
    for (const field of ["sessionId", "configDir", "projectDir", "lifecycleGeneration"]) {
      await expect(facade[operation]({ ...loc, [field]: "bad\0text" }, options)).rejects.toBeInstanceOf(BookkeepingTextParameterError)
    }
    expect(row(loc)).toEqual(before)
  })
}

it("register creates live, promotes prepared/retired, clears retry fields and does not write matching rows", async () => {
  for (const operation of [facade.ensureTranscriptJournaled, facade.registerLiveTranscript]) {
    const loc = locator(operation.name)
    await operation(loc, options)
    expect(row(loc).state).toBe("live")
    const before = row(loc)
    statements.length = 0
    await operation(loc, { ...options, now: () => 2000 })
    expect(row(loc)).toEqual(before)
    expect(statements).toEqual(["BEGIN", "COMMIT"])
    await expect(operation({ ...locator("missing"), lifecycleGeneration: "stale" }, options))
      .rejects.toThrow("stale lifecycle generation for missing")
  }
  for (const state of ["prepared", "retired"] as const) {
    const loc = seed(state, state)
    withBookkeepingWrite(directory, {}, (tx) => tx.run(
      "UPDATE resources SET next_attempt_at=9000,last_error='retry' WHERE key=?", resourceKey(loc)))
    const before = row(loc)
    await facade.registerLiveTranscript(loc, options)
    expect(row(loc)).toEqual({ ...before, state: "live", updatedAt: 1000, rowVersion: before.rowVersion + 1,
      nextAttemptAt: undefined, lastError: undefined })
  }
})

it("rejects missing commit/abandon and missing publication incarnation", async () => {
  for (const operation of [facade.commitFork, facade.abandonFork])
    await expect(operation(locator(), options)).rejects.toThrow("was not prepared")
  const capture = spyOn(incarnations, "captureProcessIncarnation").mockReturnValue(undefined)
  try { await expect(facade.prepareForkForPublication(locator(), options)).rejects.toThrow("cannot capture publication") }
  finally { capture.mockRestore() }
  expect(handle.reader.all("SELECT * FROM resources")).toHaveLength(0)
})

it("enforces distinct ownership/pending ceilings and rolls back admission deferral on capacity failure", async () => {
  const retired = seed("retired", "retired")
  await expect(facade.prepareFork(locator(), { ...options, maxPending: 1, maxOwned: 1 }))
    .rejects.toThrow("session transcript ownership capacity is full")
  expect(row(retired).state).toBe("retired")
  await facade.registerLiveTranscript(retired, options)
  const prepared = await facade.prepareFork(locator(), { ...options, maxPending: 1 })
  await expect(facade.prepareFork(locator("full"), { ...options, maxPending: 1 }))
    .rejects.toThrow("session transcript ownership backlog is full")
  await expect(facade.abandonFork(retired, { ...options, maxPending: 1 })).rejects.toBeInstanceOf(facade.SessionLifecycleBacklogError)
  await facade.abandonFork(prepared, { ...options, maxPending: 1 })
  expect(row(prepared).state).toBe("retired")
  expect(row(retired).state).toBe("live")
  await expect(facade.ensureTranscriptJournaled(locator("owned"), { ...options, maxOwned: 2 }))
    .rejects.toThrow("session transcript ownership capacity is full")
})

for (const maximum of [1, 2, 3]) {
  it(`defers newest retirement to exact admission headroom at maxPending=${maximum}`, async () => {
    const old = seed("old", "retired", 10)
    const newer = seed("newer", "retired", 20)
    const tied = seed("tied", "retired", 20)
    const ordered = [newer, tied].sort((a, b) => resourceKey(a).localeCompare(resourceKey(b)))
    const result = await facade.prepareFork(locator(), { ...options, maxPending: maximum })
    const promoted = 4 - maximum
    for (const [index, loc] of [...ordered, old].entries()) expect(row(loc).state).toBe(index < promoted ? "live" : "retired")
    expect(row(result).state).toBe("prepared")
    const c = counts()
    expect(Number(c.prepared) + Number(c.retired) + Number(c.deleting)).toBe(maximum)
  })
}

it("cannot defer deleting/prepared; tombstones are pruned newest-first without resetting fences", async () => {
  seed("deleting", "deleting")
  await expect(facade.prepareFork(locator(), { ...options, maxPending: 1 })).rejects.toThrow("backlog is full")
  const old = seed("old", "deleted", 1), newer = seed("new", "deleted", 2)
  const fences = handle.reader.all("SELECT * FROM fence_slots ORDER BY slot")
  await facade.prepareFork(locator(), { ...options, maxTombstones: 1 })
  expect(row(old)).toBeUndefined()
  expect(row(newer).state).toBe("deleted")
  for (const fence of fences) expect(handle.reader.get("SELECT counter FROM fence_slots WHERE namespace=? AND slot=?",
    fence.namespace!, fence.slot!)!.counter).toBeGreaterThanOrEqual(Number(fence.counter))
})

it("abandon releases all publication tokens but never the physical writer or deleting fence", async () => {
  for (const state of ["prepared", "live", "retired", "deleting", "deleted"] as const) {
    const loc = seed(state, state)
    const owner = incarnations.captureProcessIncarnation()!
    withBookkeepingWrite(directory, {}, (tx) => {
      for (const token of ["pub1", "pub2", "writer"]) insertResourceLease(tx, resourceKey(loc),
        { token, owner, createdAt: 1, ...(token !== "writer" ? { purpose: "publication" as const } : {}) })
      if (state === "deleting") tx.run("UPDATE resources SET deletion_token='claim',deletion_owner_json=? WHERE key=?",
        JSON.stringify(owner), resourceKey(loc))
    })
    await facade.abandonFork(loc, options)
    expect(handle.reader.all("SELECT token FROM resource_leases WHERE resource_key=?", resourceKey(loc))).toEqual([{ token: "writer" }])
    if (state === "deleting") {
      expect(row(loc).deletionToken).toBe("claim")
      expect(row(loc).deletionOwner).toEqual(owner)
    }
  }
})

it("default owned ceiling is twice stored-session limit plus pending, bounded by MAX_SAFE_INTEGER", async () => {
  const limit = spyOn(store, "getMaxStoredSessionsLimit").mockReturnValue(1)
  try {
    for (const id of ["one", "two", "three"]) await facade.registerLiveTranscript(locator(id), { ...options, maxPending: 1 })
    await expect(facade.prepareFork(locator("four"), { ...options, maxPending: 1 }))
      .rejects.toThrow("session transcript ownership capacity is full")
    limit.mockReturnValue(Number.MAX_SAFE_INTEGER)
    expect((await facade.prepareFork(locator("four"), { ...options, maxPending: 1 })).lifecycleGeneration).toBeDefined()
  } finally { limit.mockRestore() }
})

it("full backlog abandonment retains publication and writer leases atomically", async () => {
  const loc = await facade.prepareForkForPublication(locator(), options)
  await facade.commitFork(loc, options)
  const writer = await facade.acquireActiveTranscriptLease([loc], options)
  seed("other", "deleting")
  const before = row(loc), leases = handle.reader.all("SELECT * FROM resource_leases ORDER BY token")
  await expect(facade.abandonFork(loc, { ...options, maxPending: 1 })).rejects.toThrow("backlog is full")
  expect(row(loc)).toEqual(before)
  expect(handle.reader.all("SELECT * FROM resource_leases ORDER BY token")).toEqual(leases)
  await facade.abandonFork(loc, { ...options, maxPending: 2, retiredGraceMs: 0 })
  expect(row(loc).nextAttemptAt).toBe(1000)
  expect(handle.reader.all("SELECT token FROM resource_leases WHERE resource_key=?", resourceKey(loc)))
    .toEqual([{ token: writer.token }])
})

it("invalid clock/options roll back preparation, fence and leases; zero grace is allowed", async () => {
  for (const invalid of [{ maxPending: 0 }, { maxOwned: -1 }, { now: () => NaN }, { maxTombstones: 0 }]) {
    await expect(facade.prepareForkForPublication(locator(), { ...options, ...invalid })).rejects.toBeInstanceOf(TypeError)
    expect(handle.reader.all("SELECT * FROM resources")).toHaveLength(0)
    expect(handle.reader.all("SELECT * FROM fence_slots")).toHaveLength(0)
    expect(handle.reader.all("SELECT * FROM resource_leases")).toHaveLength(0)
  }
  const loc = await facade.prepareForkForPublication(locator(), options)
  const before = row(loc), leases = handle.reader.all("SELECT * FROM resource_leases")
  for (const invalid of [{ retiredGraceMs: -1 }, { now: () => Infinity }]) {
    await expect(facade.abandonFork(loc, { ...options, ...invalid })).rejects.toBeInstanceOf(TypeError)
    expect(row(loc)).toEqual(before)
    expect(handle.reader.all("SELECT * FROM resource_leases")).toEqual(leases)
  }
})
