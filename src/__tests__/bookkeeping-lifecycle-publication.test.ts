import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as facade from "../proxy/sessionLifecycle"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"
import { initializeSessionBookkeeping, withBookkeepingRead, withBookkeepingWrite,
  BookkeepingBusyError, BookkeepingCommitUncertainError, type BookkeepingHandle } from "../proxy/session/bookkeeping/database"
import { BookkeepingTextParameterError, connectionFor } from "../proxy/session/bookkeeping/connection"
import { allocateResource, insertResourceLease, readResource } from "../proxy/session/bookkeeping/resources"
import { canonicalizeLocator, resourceKey } from "../proxy/session/bookkeeping/locator"
import { sqliteLifecyclePrepare } from "../proxy/session/bookkeeping/lifecyclePrepareSql"
import { sqliteLifecyclePublication } from "../proxy/session/bookkeeping/lifecyclePublicationSql"
import { sqliteSessionStoreBackend as store } from "../proxy/session/bookkeeping/sqliteStoreBackend"
import { readMappingGeneration, PIN_LOOKUP_SQL } from "../proxy/session/bookkeeping/mappings"
import { withStoreWrite } from "../proxy/session/bookkeeping/storeScope"
import { buildNodeFixture, writeBenchArtifact } from "./fixtures/bookkeeping-support"
import type { TranscriptLocator, TranscriptResourceState } from "../proxy/session/bookkeeping/types"

let directory: string, handle: BookkeepingHandle, options: facade.SessionLifecycleOptions
let statements: string[], commitFault: "busy" | "before" | "after" | undefined
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-publication-")))
  statements = []
  commitFault = undefined
  handle = initializeSessionBookkeeping(directory, { executeTransaction(db, sql) {
    statements.push(sql)
    if (sql === "COMMIT" && commitFault) {
      const fault = commitFault
      commitFault = undefined
      if (fault === "after") db.exec(sql)
      throw Object.assign(new Error("injected COMMIT failure"), { code: fault === "busy" ? "SQLITE_BUSY" : "SQLITE_IOERR" })
    }
    db.exec(sql)
  } })
  options = { storeDir: directory, now: () => 1000 }
  facade.setSessionLifecycleBackendForTest({ ...sqliteLifecyclePrepare, ...sqliteLifecyclePublication },
    ["acquireActiveTranscriptLease", "attachActiveTranscriptExecutor", "releaseActiveTranscriptLease",
      "releaseJoinedTranscriptLease", "ensureTranscriptJournaled", "registerLiveTranscript", "commitFork",
      "abandonFork", "reconcile", "runGc"])
})
afterEach(() => {
  facade.setSessionLifecycleBackendForTest(null)
  handle.close()
  rmSync(directory, { recursive: true, force: true })
})
const locator = (sessionId = "a"): TranscriptLocator => ({ configDir: directory, sessionId })
const row = (loc: TranscriptLocator) => readResource(handle.reader, resourceKey(loc))!
function seed(state: TranscriptResourceState, id: string = state): TranscriptLocator {
  const normalized = canonicalizeLocator(locator(id))
  return withBookkeepingWrite(directory, {}, (tx) => {
    const resource = allocateResource(tx, normalized, { state, createdAt: 1, updatedAt: 1, attempts: 2 })
    return { ...normalized, lifecycleGeneration: resource.generation }
  })
}
function snapshot() {
  return Object.fromEntries(["resources", "resource_leases", "mappings", "mapping_history", "mapping_pins",
    "fence_slots", "bookkeeping_counts", "priority_assignments", "priority_rollbacks", "priority_attempts"]
    .map((table) => [table, handle.reader.all(`SELECT * FROM ${table} ORDER BY 1,2`)]))
}
function storeMapping(loc: TranscriptLocator, expected?: string, key = "key") {
  return store.storeSharedSession(directory, key, loc.sessionId, 1, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, loc, undefined, expected)
}

for (const operation of [facade.publishPinnedTranscript, facade.attachPinnedTranscript]) {
  for (const state of ["prepared", "live", "retired", "deleting", "deleted"] as const) {
    it(`${operation.name}: ${state} guards, lease release and callback signature`, async () => {
      const loc = seed(state)
      const owner = captureProcessIncarnation()!
      withBookkeepingWrite(directory, {}, (tx) => {
        tx.run("UPDATE resources SET next_attempt_at=10,last_error='retry' WHERE key=?", resourceKey(loc))
        for (const token of ["pub1", "pub2", "writer"]) insertResourceLease(tx, resourceKey(loc),
          { token, owner, createdAt: 1, ...(token === "writer" ? {} : { purpose: "publication" as const }) })
      })
      const before = snapshot()
      let calls = 0
      const callback = (...args: unknown[]) => {
        calls++
        expect(args).toEqual([])
        withBookkeepingRead(directory, (reader) => {
          expect(readResource(reader, resourceKey(loc))?.state).toBe("live")
          expect(reader.all("SELECT token FROM resource_leases")).toEqual([{ token: "writer" }])
        })
        return "mapped"
      }
      if (state === "deleting" || state === "deleted") {
        await expect(operation(loc, callback, options)).rejects.toThrow(`from state ${state}`)
        expect(calls).toBe(0)
        expect(snapshot()).toEqual(before)
      } else {
        expect(await operation(loc, callback, options)).toBe("mapped")
        expect(calls).toBe(1)
        expect(row(loc).state).toBe("live")
        expect(row(loc).attempts).toBe(2)
        if (state !== "live") {
          expect(row(loc).nextAttemptAt).toBeUndefined()
          expect(row(loc).lastError).toBeUndefined()
          expect(row(loc).updatedAt).toBe(1000)
        }
        const committed = snapshot()
        expect(await operation(loc, () => true, options)).toBe(true)
        expect(snapshot()).toEqual(committed)
      }
    })
  }
  it(`${operation.name}: collision, stale generation, NUL reject before callback`, async () => {
    const loc = seed("prepared")
    const before = snapshot()
    const callback = () => { throw new Error("unexpected callback") }
    await expect(operation({ ...loc, projectDir: directory }, callback, options))
      .rejects.toBeInstanceOf(facade.SessionLifecycleCorruptError)
    await expect(operation({ ...loc, lifecycleGeneration: "stale" }, callback, options)).rejects.toThrow("stale or missing")
    for (const field of ["sessionId", "configDir", "projectDir", "lifecycleGeneration"])
      await expect(operation({ ...loc, [field]: "bad\0text" }, callback, options)).rejects.toBeInstanceOf(BookkeepingTextParameterError)
    expect(snapshot()).toEqual(before)
  })
  for (const outcome of ["false", "throw", "thenable"] as const) {
    it(`${operation.name}: callback ${outcome} restores all rows, versions, pins, locator and hooks`, async () => {
      const loc = operation === facade.publishPinnedTranscript
        ? await facade.prepareForkForPublication(locator(), options) : locator()
      const original = { ...loc }, before = snapshot(), events: string[] = []
      const failure = new Error("callback failure")
      const callback = () => {
        expect(storeMapping(loc)).not.toBe(false)
        withStoreWrite(directory, (tx) => tx.afterCommit(() => events.push("unexpected")))
        if (outcome === "throw") throw failure
        if (outcome === "thenable") return Promise.resolve(true) as unknown as boolean
        return false
      }
      const pending = operation(loc, callback, options)
      if (outcome === "false") expect(await pending).toBe(false)
      else if (outcome === "throw") await expect(pending).rejects.toBe(failure)
      else await expect(pending).rejects.toThrow("must be synchronous")
      expect(snapshot()).toEqual(before)
      expect(loc).toEqual(original)
      expect(events).toEqual([])
    })
  }
}

it("missing publish refuses; attach creates despite supplied generation, and absent generation attaches existing", async () => {
  await expect(facade.publishPinnedTranscript(locator(), () => true, options)).rejects.toThrow("unjournaled")
  const loc = { ...locator(), lifecycleGeneration: "old" }
  expect(await facade.attachPinnedTranscript(loc, () => true, options)).toBe(true)
  expect(loc.lifecycleGeneration).toBe(row(loc).generation)
  const before = snapshot(), plain = locator()
  await expect(facade.publishPinnedTranscript(plain, () => true, options)).rejects.toThrow("stale or missing")
  expect(await facade.attachPinnedTranscript(plain, () => true, options)).toBe(true)
  expect(plain.lifecycleGeneration).toBe(loc.lifecycleGeneration)
  expect(snapshot()).toEqual(before)
  const restored = { ...locator("rollback"), lifecycleGeneration: "previous" }
  expect(await facade.attachPinnedTranscript(restored, () => false, options)).toBe(false)
  expect(restored.lifecycleGeneration).toBe("previous")
})

it("publication is the outer scope: one BEGIN, store joins, lookup sees writes and hooks see COMMIT", async () => {
  const loc = await facade.prepareForkForPublication(locator(), options)
  const expected = readMappingGeneration(handle.reader, "key"), events: string[] = []
  statements.length = 0
  const result = await facade.publishPinnedTranscript(loc, () => {
    const result = storeMapping(loc, expected)
    expect(result).not.toBe(false)
    const lookup = store.lookupSharedSessionResult(directory, "key")
    expect(lookup).toMatchObject({ status: "found", generation: result, session: { currentTranscript: loc } })
    expect(store.lookupSharedSessionByClaudeIdResult(directory, loc.sessionId)).toEqual(lookup)
    withStoreWrite(directory, (tx) => tx.afterCommit(() => {
      expect(statements.at(-1)).toBe("COMMIT")
      expect(handle.reader.all("SELECT * FROM mapping_pins")).toHaveLength(1)
      events.push("committed")
    }))
    expect(events).toEqual([])
    return result
  }, options)
  expect(typeof result).toBe("string")
  expect(events).toEqual(["committed"])
  expect(statements).toEqual(["BEGIN IMMEDIATE", "COMMIT"])
  expect(handle.reader.all("SELECT * FROM resource_leases")).toEqual([])
  const before = snapshot()
  expect(await facade.publishPinnedTranscript(loc, () => storeMapping(loc, expected), options)).toBe(false)
  expect(snapshot()).toEqual(before)
})

for (const fault of ["busy", "before", "after"] as const) {
  it(`COMMIT ${fault}: typed error, no hooks/replay, restores locator; uncertain durable result remains pinned`, async () => {
    const loc = locator(), original = { ...loc }, before = snapshot(), events: string[] = []
    let calls = 0
    commitFault = fault
    await expect(facade.attachPinnedTranscript(loc, () => {
      calls++
      const result = storeMapping(loc)
      withStoreWrite(directory, (tx) => tx.afterCommit(() => events.push("unexpected")))
      return result
    }, options)).rejects.toBeInstanceOf(fault === "busy" ? BookkeepingBusyError : BookkeepingCommitUncertainError)
    expect(calls).toBe(1)
    expect(events).toEqual([])
    expect(loc).toEqual(original)
    expect(!!connectionFor(directory).poisoned).toBe(fault !== "busy")
    withBookkeepingRead(directory, () => undefined)
    if (fault === "after") {
      expect(row(loc).state).toBe("live")
      expect(handle.reader.all("SELECT * FROM mapping_pins")).toHaveLength(1)
      expect(handle.reader.get(PIN_LOOKUP_SQL, resourceKey(loc), row(loc).generation)).toEqual({ mapping_key: "key" })
    } else expect(snapshot()).toEqual(before)
  })
}

it("durable exact/NULL pins coexist; publication adds no JSON-incompatible foreign-pin or owner guard", async () => {
  const loc = await facade.prepareForkForPublication(locator(), options)
  expect(storeMapping({ ...loc, lifecycleGeneration: undefined }, undefined, "legacy")).not.toBe(false)
  expect(storeMapping({ ...loc, lifecycleGeneration: "different" }, undefined, "stale")).not.toBe(false)
  expect(await facade.publishPinnedTranscript(loc, () => {
    expect(storeMapping(loc)).not.toBe(false)
    withBookkeepingRead(directory, (reader) => {
      expect(reader.all(PIN_LOOKUP_SQL, resourceKey(loc), loc.lifecycleGeneration!).map((r) => r.mapping_key).sort())
        .toEqual(["key", "legacy"])
    })
    return true
  }, options)).toBe(true)
  expect(handle.reader.all("SELECT * FROM mapping_pins")).toHaveLength(3)
})

it("joint priority/mapping CAS joins publication and a stale route restores resource, lease and all store rows", async () => {
  const loc = await facade.prepareForkForPublication(locator(), options)
  const mappingGeneration = readMappingGeneration(handle.reader, "key")
  const route = store.lookupPriorityAssignmentResult(directory, "route")
  if (route.status === "error") throw route.error
  const publication = { key: "key", claudeSessionId: loc.sessionId, messageCount: 1, lineageHash: "h",
    messageHashes: ["h"], messageBlockHashes: [["b"]], currentTranscript: loc,
    expectedMappingGeneration: mappingGeneration, priority: { routeKey: "route", profileId: "p",
      lastHumanTurnDigest: "a".repeat(43), lastHumanTurnIssuedAt: 1, expectedAssignmentGeneration: route.generation } }
  const before = snapshot()
  expect(await facade.publishPinnedTranscript(loc, () => !!store.storeSharedSessionAndPriorityAssignment(directory,
    { ...publication, priority: { ...publication.priority, expectedAssignmentGeneration: "stale" } }), options)).toBe(false)
  expect(snapshot()).toEqual(before)
  statements.length = 0
  expect(await facade.publishPinnedTranscript(loc, () => {
    const result = store.storeSharedSessionAndPriorityAssignment(directory, publication)
    if (!result) return false
    expect(store.lookupPriorityAssignmentResult(directory, "route")).toMatchObject({ status: "found",
      generation: result.assignmentGeneration, assignment: { mappingGeneration: result.mappingGeneration } })
    return result.mappingGeneration
  }, options)).toBe(readMappingGeneration(handle.reader, "key"))
  expect(statements).toEqual(["BEGIN IMMEDIATE", "COMMIT"])
  expect(handle.reader.all("SELECT * FROM resource_leases")).toEqual([])
  expect(handle.reader.all("SELECT * FROM mapping_pins")).toHaveLength(1)
})

it("swallowed nested store CAS false still rolls back the publication and restores an attached generation", async () => {
  const loc = locator(), before = snapshot()
  await expect(facade.attachPinnedTranscript(loc, () => {
    expect(storeMapping(loc)).not.toBe(false)
    expect(storeMapping(loc, "stale")).toBe(false)
    return true
  }, options)).rejects.toThrow("nested bookkeeping write requested rollback")
  expect(snapshot()).toEqual(before)
  expect(loc.lifecycleGeneration).toBeUndefined()
})

it("attach capacity, invalid options/clock and pruning failure roll back before callback", async () => {
  seed("live")
  const before = snapshot()
  for (const invalid of [{ maxOwned: 1 }, { maxOwned: 0 }, { maxTombstones: 0 }, { now: () => NaN }]) {
    const loc = locator("new")
    await expect(facade.attachPinnedTranscript(loc, () => { throw new Error("unexpected callback") }, { ...options, ...invalid }))
      .rejects.toThrow()
    expect(snapshot()).toEqual(before)
    expect(loc.lifecycleGeneration).toBeUndefined()
  }
  seed("deleted")
  seed("deleted", "second-deleted")
  expect(await facade.attachPinnedTranscript(locator("new"), () => true, { ...options, maxTombstones: 1 })).toBe(true)
  expect(handle.reader.all("SELECT key FROM resources WHERE state='deleted'")).toHaveLength(1)
})

it("recursive lifecycle rejects before realpath; cross-database writes roll back publication", async () => {
  const loc = await facade.prepareForkForPublication(locator(), options)
  let recursive: Promise<unknown> | undefined
  expect(await facade.publishPinnedTranscript(loc, () => {
    const realpath = spyOn(realpathSync, "native").mockImplementation(() => { throw new Error("OS observation under lock") })
    try {
      recursive = facade.attachPinnedTranscript(locator("recursive"), () => true, options)
      void recursive.catch(() => undefined)
      expect(storeMapping(loc)).not.toBe(false)
    } finally { realpath.mockRestore() }
    return true
  }, options)).toBe(true)
  await expect(recursive!).rejects.toBeInstanceOf(facade.SessionLifecycleReentrancyError)
  const other = join(directory, "other"), otherHandle = initializeSessionBookkeeping(other), before = snapshot()
  try {
    await expect(facade.attachPinnedTranscript(locator("new"), () => store.storeSharedSession(other, "key", "id"), options))
      .rejects.toThrow("cross-database publication")
    await expect(facade.attachPinnedTranscript(locator("new"), () => {
      const realpath = spyOn(realpathSync, "native").mockImplementation(() => { throw new Error("OS observation under lock") })
      try {
        return store.storeSharedSession(other, "key", "id", undefined, undefined, undefined, undefined,
          undefined, undefined, undefined, undefined, { configDir: other, sessionId: "id" })
      } finally { realpath.mockRestore() }
    }, options)).rejects.toThrow("cross-database publication")
    expect(snapshot()).toEqual(before)
    expect(otherHandle.reader.all("SELECT * FROM mappings")).toEqual([])
  } finally { otherHandle.close() }
})

it("pre-BEGIN canonicalization reaches callback store pins without changing caller paths", async () => {
  const alias = join(directory, "alias")
  symlinkSync(directory, alias)
  const loc = { sessionId: "alias", configDir: alias, projectDir: alias }
  expect(await facade.attachPinnedTranscript(loc, () => {
    const realpath = spyOn(realpathSync, "native").mockImplementation(() => { throw new Error("OS observation under lock") })
    try { return storeMapping(loc) } finally { realpath.mockRestore() }
  }, options)).not.toBe(false)
  expect(loc.configDir).toBe(alias)
  expect(store.lookupSharedSessionResult(directory, "key")).toMatchObject({ status: "found",
    session: { currentTranscript: { configDir: directory, projectDir: directory } } })
  expect(handle.reader.get("SELECT resource_key FROM mapping_pins")?.resource_key)
    .toBe(resourceKey({ ...loc, configDir: directory }))
})

it("two real Node publishers: one mapping CAS winner, no partial rows (N=10)", async () => {
  const build = await buildNodeFixture("bookkeeping-publication-process.ts", "publication.mjs", directory)
  expect(build.success).toBe(true)
  const results: unknown[] = []
  for (let iteration = 0; iteration < 10; iteration++) {
    const locators = await Promise.all([0, 1].map((id) =>
      facade.prepareForkForPublication(locator(`race-${iteration}-${id}`), options)))
    const before = locators.map((loc) => ({ resource: row(loc),
      leases: handle.reader.all("SELECT * FROM resource_leases WHERE resource_key=?", resourceKey(loc)) }))
    const key = `race-${iteration}`, expected = readMappingGeneration(handle.reader, key)
    const workers = locators.map((loc) => {
      const child = spawn("node", [join(directory, "publication.mjs"), directory, JSON.stringify(loc), key, expected],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] })
      let stdout = "", stderr = ""
      child.stdout!.on("data", (chunk) => { stdout += String(chunk) })
      child.stderr!.on("data", (chunk) => { stderr += String(chunk) })
      const ready = Promise.withResolvers<void>()
      void ready.promise.catch(() => undefined)
      child.on("message", (value) => { if (value === "ready") ready.resolve() })
      const exit = new Promise<{ result: string | false; node: string }>((resolve, reject) => {
        child.on("error", (error) => { ready.reject(error); reject(error) })
        child.on("exit", (code) => {
          if (code !== 0) {
            const error = new Error(`publisher exit ${code}: ${stderr}`)
            ready.reject(error); reject(error)
          } else {
            try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) }
          }
        })
      })
      void exit.catch(() => undefined)
      return { child, ready: ready.promise, exit }
    })
    try {
      await Promise.all(workers.map((worker) => worker.ready))
      workers.forEach((worker) => worker.child.send("publish"))
      const outcomes = await Promise.all(workers.map((worker) => worker.exit))
      expect(outcomes.filter((value) => typeof value.result === "string" && value.result !== "busy")).toHaveLength(1)
      expect(outcomes.filter((value) => value.result === false || value.result === "busy")).toHaveLength(1)
      expect(outcomes.every((value) => value.node.startsWith("22."))).toBe(true)
      expect(handle.reader.all("SELECT key FROM mappings WHERE key=?", key)).toHaveLength(1)
      expect(handle.reader.all("SELECT * FROM mapping_pins WHERE mapping_key=?", key)).toHaveLength(1)
      for (const [id, loc] of locators.entries()) {
        const leases = handle.reader.all("SELECT * FROM resource_leases WHERE resource_key=?", resourceKey(loc))
        if (outcomes[id]!.result === false || outcomes[id]!.result === "busy") {
          expect(row(loc)).toEqual(before[id]!.resource)
          expect(leases).toEqual(before[id]!.leases)
        } else {
          expect(leases).toHaveLength(0)
          expect(row(loc).state).toBe("live")
          expect(handle.reader.get("SELECT resource_key,generation FROM mapping_pins WHERE mapping_key=?", key))
            .toEqual({ resource_key: resourceKey(loc), generation: loc.lifecycleGeneration! })
        }
      }
      expect(handle.reader.get("SELECT revision FROM mappings WHERE key=?", key)?.revision).toBe(1)
      results.push({ iteration, outcomes })
    } finally {
      for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill("SIGTERM")
      await Promise.allSettled(workers.map((worker) => worker.exit))
    }
  }
  writeBenchArtifact("publication-process.json", results)
}, 60000)
