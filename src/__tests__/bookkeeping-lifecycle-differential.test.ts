import { expect, it, spyOn } from "bun:test"
import * as crypto from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as lifecycle from "../proxy/sessionLifecycle"
import * as incarnation from "../proxy/session/processIncarnation"
import * as store from "../proxy/sessionStore"
import { initializeSessionBookkeeping } from "../proxy/session/bookkeeping/database"
import { sqliteLifecycleBackend } from "../proxy/session/bookkeeping/lifecycleSql"
import { sqliteSessionStoreBackend } from "../proxy/session/bookkeeping/sqliteStoreBackend"
import { observeLifecycleLedger } from "./fixtures/bookkeeping-lifecycle-observer"

it("compares lifecycle results, errors and observed ledger after every JSON/SQLite operation", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-differential-")))
  const owner = incarnation.captureProcessIncarnation()!
  let step = 0, now = 1000, dead = false
  const uuid = spyOn(crypto, "randomUUID").mockImplementation(() =>
    `00000000-0000-4000-8000-${step.toString(16).padStart(12, "0")}`)
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const capture = spyOn(incarnation, "captureProcessIncarnation").mockReturnValue(owner)
  const probe = spyOn(incarnation, "processIncarnationIsDead").mockImplementation(() => dead)
  let handle: ReturnType<typeof initializeSessionBookkeeping> | undefined
  const execute = async (sqlite: boolean) => {
    step = 0; now = 1000; dead = false
    const results: unknown[] = []
    const options: lifecycle.SessionLifecycleOptions = {
      storeDir: directory, now: () => now, retiredGraceMs: 0, preparedGraceMs: 0,
      unarmedLeaseTtlMs: 10, maxOwned: 20, maxPending: 20, maxTombstones: 2,
    }
    const locator = (sessionId: string) => ({ configDir: directory, sessionId })
    async function run<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
      step++
      let result: T | undefined, error: unknown
      try { result = await operation() }
      catch (caught) {
        if (!(caught instanceof Error)) throw caught
        error = { constructor: caught.constructor.name, name: caught.name, message: caught.message }
      }
      if (name.includes("refusal")) expect(error).toBeDefined()
      else expect(error).toBeUndefined()
      const { state, pins } = observeLifecycleLedger(directory, sqlite)
      // rowVersion is a SQL CAS implementation detail with no JSON analogue.
      for (const resource of Object.values(state.resources)) delete (resource as { rowVersion?: number }).rowVersion
      results.push(structuredClone({ name, result, error, state, pins }))
      return result as T
    }
    const a = await run("prepare", () => lifecycle.prepareFork(locator("a"), options))
    await run("publish false", () => lifecycle.publishPinnedTranscript(a, () => false, options))
    const publish = (key: string, target: lifecycle.TranscriptLocator) => store.storeSharedSession(
      key, target.sessionId, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, target)
    await run("publish success", () => lifecycle.publishPinnedTranscript(a, () => publish("a", a), options))
    const b = locator("b")
    await run("attach pinned", () => lifecycle.attachPinnedTranscript(b, () => publish("b", b), options))
    const lease = await run("acquire", () => lifecycle.acquireActiveTranscriptLease([a], options))
    await run("attach executor", () => lifecycle.attachActiveTranscriptExecutor(lease, owner, options))
    await run("release", () => lifecycle.releaseActiveTranscriptLease(lease, options))
    await run("ensure no-op", () => lifecycle.ensureTranscriptJournaled(a, options))
    await run("register no-op", () => lifecycle.registerLiveTranscript(a, options))
    const c = await run("prepare commit", () => lifecycle.prepareFork(locator("c"), options))
    await run("commit", () => lifecycle.commitFork(c, options))
    await run("abandon", () => lifecycle.abandonFork(c, options))
    await run("repeat prepare", () => lifecycle.prepareFork(c, options))
    await run("capacity refusal", () => lifecycle.prepareFork(locator("capacity"), { ...options, maxOwned: 3 }))
    await run("pending admission deferral", () => lifecycle.prepareFork(locator("pending"), { ...options, maxPending: 1 }))
    await run("pending refusal", () => lifecycle.prepareFork(locator("over-pending"), { ...options, maxPending: 1 }))
    const d = await run("publication prepare", () => lifecycle.prepareForkForPublication(locator("d"), options))
    await run("publication repeat refusal", () => lifecycle.prepareForkForPublication(d, options))
    await run("publication false", () => lifecycle.publishPinnedTranscript(d, () => false, options))
    await run("live owner reconcile", () => lifecycle.reconcile(store.readSessionTranscriptPins(), options))
    now += 11
    await run("expired unarmed reconcile", () => lifecycle.reconcile(store.readSessionTranscriptPins(), options))
    const e = await run("dead owner prepare", () => lifecycle.prepareForkForPublication(locator("e"), options))
    dead = true
    await run("dead owner reconcile", () => lifecycle.reconcile(store.readSessionTranscriptPins(), options))
    dead = false
    await run("abandon already retired", () => lifecycle.abandonFork(e, options))
    const collected = await run("GC success and tombstone bound", () => lifecycle.runGc(store.readSessionTranscriptPins(), {
      ...options, deleter: async () => {},
    }))
    expect(collected).toEqual({ deleted: 4, notFound: 0, failed: 0, deferred: 0 })
    expect(observeLifecycleLedger(directory, sqlite).state.counts["resources:deleted"]).toBe(2)
    for (const kind of ["notFound", "failure", "hung"] as const) {
      const target = await run(`${kind} prepare`, () => lifecycle.prepareFork(locator(kind), options))
      await run(`${kind} abandon`, () => lifecycle.abandonFork(target, options))
      const result = await run(`${kind} GC`, () => lifecycle.runGc(store.readSessionTranscriptPins(), {
        ...options, deletionTimeoutMs: 10, runTimeoutMs: 1000, deleter: async () => {
          if (kind === "notFound") throw new Error("Session notFound not found")
          if (kind === "failure") throw new Error("deletion failed")
          await new Promise(() => {})
        },
      }))
      expect(result).toEqual(kind === "notFound" ? { deleted: 0, notFound: 1, failed: 0, deferred: 0 }
        : kind === "failure" ? { deleted: 0, notFound: 0, failed: 1, deferred: 1 }
          : { deleted: 0, notFound: 0, failed: 0, deferred: 3 })
    }
    await run("hung fence reconcile", () => lifecycle.reconcile(store.readSessionTranscriptPins(), options))
    await run("hung fence repeated GC", () => lifecycle.runGc(store.readSessionTranscriptPins(), {
      ...options, deleter: async () => { throw new Error("must not retry") },
    }))
    // Both backends give an admitted deletion its full timeout;
    // the sweep deadline only prevents beginning the next claim.
    now++ // Keep this tombstone newer than the bound's tie-break candidates.
    const budgetTarget = await lifecycle.prepareFork(locator("full-budget"), options)
    await lifecycle.abandonFork(budgetTarget, options)
    const budget = await lifecycle.runGc(store.readSessionTranscriptPins(), {
      ...options, runTimeoutMs: 20, deletionTimeoutMs: 500,
      deleter: async () => { await new Promise(resolve => setTimeout(resolve, 60)) },
    })
    expect(budget).toEqual({ deleted: 1, notFound: 0, failed: 0, deferred: 2 })
    const budgetState = observeLifecycleLedger(directory, sqlite).state
    expect(budgetState.resources[lifecycle.getTranscriptResourceKey(budgetTarget)]?.state)
      .toBe("deleted")
    return results
  }
  try {
    store.setSessionStoreDir(directory)
    const json = await execute(false)
    rmSync(directory, { recursive: true, force: true }); mkdirSync(directory, { mode: 0o700 })
    handle = initializeSessionBookkeeping(directory)
    store.setSessionStoreBackendForTest(sqliteSessionStoreBackend)
    lifecycle.setSessionLifecycleBackendForTest(sqliteLifecycleBackend)
    const sql = await execute(true)
    expect(sql.length).toBe(json.length)
    for (let index = 0; index < json.length; index++) expect(sql[index]).toEqual(json[index])
  } finally {
    lifecycle.setSessionLifecycleBackendForTest(null); store.setSessionStoreBackendForTest(null)
    handle?.close(); store.setSessionStoreDir(null)
    probe.mockRestore(); capture.mockRestore(); clock.mockRestore(); uuid.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
