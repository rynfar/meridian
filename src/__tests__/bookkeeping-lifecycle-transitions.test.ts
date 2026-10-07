import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as facade from "../proxy/sessionLifecycle"
import * as incarnations from "../proxy/session/processIncarnation"
import { initializeSessionBookkeeping, withBookkeepingWrite, type BookkeepingHandle }
  from "../proxy/session/bookkeeping/database"
import { connectionFor, BookkeepingTextParameterError } from "../proxy/session/bookkeeping/connection"
import { allocateResource, insertResourceLease, readResource, readResourceLease }
  from "../proxy/session/bookkeeping/resources"
import { canonicalizeLocator } from "../proxy/session/bookkeeping/locator"
import { activeLifecycleBackend, lifecycleBackendMethods, SessionLifecycleOperationUnavailableError }
  from "../proxy/session/bookkeeping/lifecycleBackend"
import { sqliteLifecycleLeases, retryDeferredLeaseReleases } from "../proxy/session/bookkeeping/lifecycleLeasesSql"
import { assertAdmissionHeartbeat, measureAdmissionHeartbeat } from "./fixtures/bookkeeping-heartbeat"
import type { ActiveTranscriptLeaseRecord, TranscriptLocator, TranscriptResourceState }
  from "../proxy/session/bookkeeping/types"
import { writeBenchArtifact } from "./fixtures/bookkeeping-support"

let directory: string
let handle: BookkeepingHandle
let options: facade.SessionLifecycleOptions
const unavailable = ["prepareFork", "prepareForkForPublication", "ensureTranscriptJournaled", "registerLiveTranscript",
  "commitFork", "publishPinnedTranscript", "attachPinnedTranscript", "abandonFork", "reconcile", "runGc"] as const
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-sql-")))
  handle = initializeSessionBookkeeping(directory)
  options = { storeDir: directory, now: () => 1000 }
  facade.setSessionLifecycleBackendForTest(sqliteLifecycleLeases, unavailable)
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
function resource(locator: TranscriptLocator) {
  return readResource(handle.reader, facade.getTranscriptResourceKey(locator))!
}
function insertLease(locator: TranscriptLocator, fields: Partial<ActiveTranscriptLeaseRecord> = {}) {
  const lease: ActiveTranscriptLeaseRecord = {
    token: "old", owner: incarnations.captureProcessIncarnation()!, createdAt: 1, ...fields,
  }
  withBookkeepingWrite(directory, {}, (tx) => insertResourceLease(tx, facade.getTranscriptResourceKey(locator), lease))
  return lease
}

it("dispatches into SQLite, never silently completes an unavailable operation or writes JSON", async () => {
  const locator = seed()
  const lease = await facade.acquireActiveTranscriptLease([locator, locator], options)
  expect(lease.resourceKeys).toEqual([resource(locator).key])
  expect(readResourceLease(handle.reader, resource(locator).key, lease.token)?.owner.pid).toBe(process.pid)
  expect(existsSync(join(directory, "session-gc.json"))).toBe(false)
  await expect(facade.prepareFork({ sessionId: "b", configDir: directory }, options))
    .rejects.toBeInstanceOf(SessionLifecycleOperationUnavailableError)
  expect(() => facade.setSessionLifecycleBackendForTest(sqliteLifecycleLeases, []))
    .toThrow("exact list")
  expect(() => facade.setSessionLifecycleBackendForTest({}, [...lifecycleBackendMethods, "runGc"]))
    .toThrow("exact list")
  const inherited = Object.create(sqliteLifecycleLeases) as typeof sqliteLifecycleLeases
  facade.setSessionLifecycleBackendForTest(inherited, unavailable)
  await facade.releaseActiveTranscriptLease(lease, options)
  expect(readResourceLease(handle.reader, resource(locator).key, lease.token)).toBeUndefined()
  expect(() => withBookkeepingWrite(directory, {}, () => facade.setSessionLifecycleBackendForTest(null)))
    .toThrow("cannot change")
  facade.setSessionLifecycleBackendForTest(null)
  expect(activeLifecycleBackend()).toBeUndefined()
})

it("rejects empty, missing, stale, mismatched and unavailable owner before granting ownership", async () => {
  await expect(facade.acquireActiveTranscriptLease([], options)).rejects.toThrow("at least one")
  const locator = seed()
  await expect(facade.acquireActiveTranscriptLease([{ ...locator, sessionId: "missing" }], options))
    .rejects.toThrow("unjournaled")
  await expect(facade.acquireActiveTranscriptLease([{ ...locator, lifecycleGeneration: "stale" }], options))
    .rejects.toThrow("stale or missing")
  await expect(facade.acquireActiveTranscriptLease([{ ...locator, lifecycleGeneration: undefined }], options))
    .rejects.toThrow("stale or missing")
  await expect(facade.acquireActiveTranscriptLease([{ ...locator, projectDir: directory }], options))
    .rejects.toBeInstanceOf(facade.SessionLifecycleCorruptError)
  const capture = spyOn(incarnations, "captureProcessIncarnation").mockReturnValue(undefined)
  try { await expect(facade.acquireActiveTranscriptLease([locator], options)).rejects.toThrow("cannot capture") }
  finally { capture.mockRestore() }
  expect(handle.reader.get("SELECT count(*) AS n FROM resource_leases")?.n).toBe(0)
})

for (const state of ["prepared", "live", "retired", "deleting", "deleted"] as const) {
  it(`preserves the ${state} acquisition guard`, async () => {
    const locator = seed("state", state)
    if (state === "deleting" || state === "deleted") {
      await expect(facade.acquireActiveTranscriptLease([locator], options)).rejects.toThrow(`from state ${state}`)
    } else {
      expect((await facade.acquireActiveTranscriptLease([locator], options)).resourceKeys).toHaveLength(1)
    }
  })
}

it("keeps publication ownership separate, arms exact tokens, and atomically rejects a multi-resource lost lease", async () => {
  const locator = seed()
  insertLease(locator, { purpose: "publication" })
  const lease = await facade.acquireActiveTranscriptLease([locator], options)
  const executor = incarnations.captureProcessIncarnation()!
  await expect(facade.acquireActiveTranscriptLease([locator], options)).rejects.toThrow("active SDK writer")
  await expect(facade.attachActiveTranscriptExecutor({ token: "old", resourceKeys: lease.resourceKeys }, executor, options))
    .rejects.toThrow("cannot arm a publication")
  await expect(facade.attachActiveTranscriptExecutor({ ...lease, resourceKeys: [...lease.resourceKeys, "missing"] }, executor, options))
    .rejects.toThrow("was lost")
  expect(readResourceLease(handle.reader, lease.resourceKeys[0]!, lease.token)?.executor).toBeUndefined()
  await facade.attachActiveTranscriptExecutor(lease, executor, options, false)
  expect(readResourceLease(handle.reader, lease.resourceKeys[0]!, lease.token)?.executorRecoverable).toBe(false)
  await facade.releaseActiveTranscriptLease({ ...lease, token: "wrong" }, options)
  expect(readResourceLease(handle.reader, lease.resourceKeys[0]!, lease.token)).toBeDefined()
  await facade.releaseActiveTranscriptLease(lease, options)
  const version = resource(locator).rowVersion
  await facade.releaseActiveTranscriptLease(lease, options)
  expect(resource(locator).rowVersion).toBe(version)
  expect(readResourceLease(handle.reader, lease.resourceKeys[0]!, "old")?.purpose).toBe("publication")
  await expect(facade.attachActiveTranscriptExecutor(lease, { ...executor, pid: -1 }, options))
    .rejects.toThrow("invalid active transcript executor")
})

it("rolls back earlier grants when a later locator fails", async () => {
  const locator = seed()
  const version = resource(locator).rowVersion
  await expect(facade.acquireActiveTranscriptLease([locator, { ...locator, sessionId: "missing" }], options))
    .rejects.toThrow("unjournaled")
  expect(resource(locator).rowVersion).toBe(version)
  expect(handle.reader.get("SELECT count(*) AS n FROM resource_leases")?.n).toBe(0)
})

it("retains the strict unarmed TTL boundary and validates time/options", async () => {
  const locator = seed()
  insertLease(locator)
  await expect(facade.acquireActiveTranscriptLease([locator], { ...options, unarmedLeaseTtlMs: 999 }))
    .rejects.toThrow("active SDK writer")
  const lease = await facade.acquireActiveTranscriptLease([locator], { ...options, unarmedLeaseTtlMs: 998 })
  expect(readResourceLease(handle.reader, resource(locator).key, "old")).toBeUndefined()
  await facade.releaseActiveTranscriptLease(lease, options)
  await expect(facade.acquireActiveTranscriptLease([locator], { ...options, unarmedLeaseTtlMs: -1 }))
    .rejects.toThrow("non-negative integer")
  await expect(facade.acquireActiveTranscriptLease([locator], { ...options, now: () => NaN }))
    .rejects.toThrow("finite number")
})

it("observes executor death outside SQL, but never applies it after the owner/executor row changes", async () => {
  const locator = seed()
  const executor = incarnations.captureProcessIncarnation()!
  insertLease(locator, { executor })
  const probe = spyOn(incarnations, "processIncarnationIsDead").mockImplementation(() => {
    expect(connectionFor(directory).scope).toBeUndefined()
    withBookkeepingWrite(directory, {}, (tx) => tx.run(
      "UPDATE resource_leases SET created_at=created_at+1 WHERE resource_key=?", facade.getTranscriptResourceKey(locator)))
    return true
  })
  try {
    await expect(facade.acquireActiveTranscriptLease([locator], options)).rejects.toThrow("active SDK writer")
    expect(readResourceLease(handle.reader, resource(locator).key, "old")?.createdAt).toBe(2)
    probe.mockImplementation(() => { expect(connectionFor(directory).scope).toBeUndefined(); return true })
    await facade.acquireActiveTranscriptLease([locator], options)
    expect(readResourceLease(handle.reader, resource(locator).key, "old")).toBeUndefined()
  } finally { probe.mockRestore() }
})

it("does not recover a nonrecoverable executor on death alone; reboot is required", async () => {
  const locator = seed()
  insertLease(locator, { executor: incarnations.captureProcessIncarnation()!, executorRecoverable: false })
  const death = spyOn(incarnations, "processIncarnationIsDead").mockReturnValue(true)
  const reboot = spyOn(incarnations, "processIncarnationPredatesBoot").mockReturnValue(false)
  try {
    await expect(facade.acquireActiveTranscriptLease([locator], options)).rejects.toThrow("active SDK writer")
    expect(death).not.toHaveBeenCalled()
    reboot.mockImplementation(() => { expect(connectionFor(directory).scope).toBeUndefined(); return true })
    await facade.acquireActiveTranscriptLease([locator], options)
  } finally { death.mockRestore(); reboot.mockRestore() }
})

it("recovers an unarmed dead owner but preserves live or indeterminate owners", async () => {
  const locator = seed()
  insertLease(locator)
  const probe = spyOn(incarnations, "processIncarnationIsDead").mockImplementation(() => {
    expect(connectionFor(directory).scope).toBeUndefined()
    return false
  })
  try {
    await expect(facade.acquireActiveTranscriptLease([locator], options)).rejects.toThrow("active SDK writer")
    probe.mockImplementation(() => { expect(connectionFor(directory).scope).toBeUndefined(); return true })
    await facade.acquireActiveTranscriptLease([locator], options)
    expect(readResourceLease(handle.reader, resource(locator).key, "old")).toBeUndefined()
  } finally { probe.mockRestore() }
})

it("lease release does not clear a permanent deleting fence", async () => {
  const locator = seed("fenced", "deleting")
  insertLease(locator)
  await facade.releaseActiveTranscriptLease({ token: "old", resourceKeys: [resource(locator).key] }, options)
  expect(resource(locator).state).toBe("deleting")
})

it("fails closed before process capture in an outer transaction (joining remains a later boundary)", async () => {
  const locator = seed()
  const capture = spyOn(incarnations, "captureProcessIncarnation")
  let result: Promise<facade.ActiveTranscriptLease> | undefined
  try {
    withBookkeepingWrite(directory, { scope: "store" }, () => {
      result = facade.acquireActiveTranscriptLease([locator], options)
      void result.catch(() => undefined)
    })
    await expect(result).rejects.toBeInstanceOf(facade.SessionLifecycleReentrancyError)
    expect(capture).not.toHaveBeenCalled()
  } finally { capture.mockRestore() }
})

it("rejects scalar NUL rather than truncating resource IDs or tokens", async () => {
  const locator = seed()
  for (const field of ["sessionId", "configDir", "projectDir", "lifecycleGeneration"] as const) {
    await expect(facade.acquireActiveTranscriptLease([{ ...locator, [field]: `${directory}\0bad` }], options))
      .rejects.toBeInstanceOf(BookkeepingTextParameterError)
  }
  await expect(facade.releaseActiveTranscriptLease({ token: "bad\0token", resourceKeys: [] }, options))
    .rejects.toBeInstanceOf(BookkeepingTextParameterError)
})

it("yields while a real Node child holds BEGIN IMMEDIATE; joined cleanup is retried after typed timeout", async () => {
  const locator = seed()
  const lease = await facade.acquireActiveTranscriptLease([locator], options)
  const child = spawn("node", ["--input-type=module", "-e", `
    import Database from 'libsql';
    const db = new Database(${JSON.stringify(handle.path)});
    db.exec('BEGIN IMMEDIATE'); process.send('locked');
    process.on('disconnect', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
  let stderr = ""
  child.stderr!.on("data", (chunk) => { stderr += String(chunk) })
  try {
    await Promise.race([once(child, "message"), once(child, "exit").then(([code]) => {
      throw new Error(`holder exited: ${code}: ${stderr}`)
    })])
    const sample = await measureAdmissionHeartbeat(80, async () => {
      await expect(facade.releaseActiveTranscriptLease(lease, { ...options, lockWaitMs: 80, lockRetryMs: 5 }))
        .rejects.toBeInstanceOf(facade.SessionLifecycleLockError)
    })
    assertAdmissionHeartbeat(sample)
    writeBenchArtifact("lifecycle-contention.json", sample)
    // The starved-timer negative control needs a process with no prior admission: bookkeeping-admission-seam.test.ts.
    await facade.releaseJoinedTranscriptLease(lease, { ...options, lockWaitMs: 0 })
    expect(readResourceLease(handle.reader, resource(locator).key, lease.token)).toBeDefined()
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit")
      if (child.connected) child.disconnect()
      else child.kill("SIGKILL")
      await exited
    }
  }
  await retryDeferredLeaseReleases(options)
  expect(readResourceLease(handle.reader, resource(locator).key, lease.token)).toBeUndefined()
}, 20000)

it("preserves the portable JSON publication API, exact generations and callback rollback", async () => {
  facade.setSessionLifecycleBackendForTest(null)
  const legacyOptions: facade.SessionLifecycleOptions = { storeDir: join(directory, "legacy"), now: () => 1000,
    deletionTimeoutMs: 5000, deletionHandshakeTimeoutMs: 3000, runTimeoutMs: 1 }
  const locator: facade.TranscriptLocator = { configDir: directory, sessionId: "legacy-contract" }
  const prepared: facade.TranscriptLocator = await facade.prepareForkForPublication(locator, legacyOptions)
  const sidecarPath = join(legacyOptions.storeDir!, "session-gc.json")
  const before = readFileSync(sidecarPath, "utf8")
  const rejected: Promise<false> = facade.publishPinnedTranscript(prepared, () => false as const, legacyOptions)
  expect(await rejected).toBe(false)
  expect(readFileSync(sidecarPath, "utf8")).toBe(before)
  await expect(facade.publishPinnedTranscript(prepared, () => { throw new Error("callback failed") }, legacyOptions))
    .rejects.toThrow("callback failed")
  expect(readFileSync(sidecarPath, "utf8")).toBe(before)
  const published: Promise<"published"> = facade.publishPinnedTranscript(prepared, () => "published" as const, legacyOptions)
  expect(await published).toBe("published")
  const key = facade.getTranscriptResourceKey(prepared)
  const live = JSON.parse(readFileSync(sidecarPath, "utf8")).resources[key]
  expect(live.state).toBe("live")
  expect(live.generation).toBe(prepared.lifecycleGeneration)
  expect(live.activeLeases).toBeUndefined()
  await expect(facade.commitFork({ ...prepared, lifecycleGeneration: "stale" }, legacyOptions))
    .rejects.toThrow("stale or missing")
  const lease: facade.ActiveTranscriptLease = await facade.acquireActiveTranscriptLease([prepared], legacyOptions)
  expect(lease.resourceKeys).toEqual([key])
  await facade.releaseActiveTranscriptLease(lease, legacyOptions)
  const reconciled: facade.ReconcileResult = await facade.reconcile([prepared], legacyOptions)
  expect(reconciled).toEqual({ preparedRetired: 0, liveRetired: 0, resourcesPinned: 1, deletingRecovered: 0 })
  await facade.abandonFork(prepared, legacyOptions)
  expect(JSON.parse(readFileSync(sidecarPath, "utf8")).resources[key].state).toBe("retired")
})
