import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as durableFileSystem from "../proxy/session/durableFileSystem"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import {
  SessionLifecycleBacklogError,
  SessionLifecycleCorruptError,
  SessionLifecycleLockError,
  abandonFork,
  acquireActiveTranscriptLease,
  attachActiveTranscriptExecutor,
  attachPinnedTranscript,
  commitFork,
  getSessionGcNodeExecutable,
  getTranscriptResourceKey,
  prepareFork,
  publishPinnedTranscript,
  reconcile,
  registerLiveTranscript,
  releaseActiveTranscriptLease,
  runGc,
  type SessionLifecycleOptions,
  type TranscriptLocator,
} from "../proxy/sessionLifecycle"
import {
  captureProcessIncarnation,
  type ProcessIncarnation,
} from "../proxy/session/processIncarnation"
import {
  getRecoveryClaimPath,
  getRecoveryClaimTombstonePath,
} from "../proxy/session/recoveryClaim"

interface StoredResource {
  key: string
  generation: string
  locator: TranscriptLocator
  state: string
  createdAt: number
  updatedAt: number
  attempts: number
  nextAttemptAt?: number
  lastError?: string
  deletionToken?: string
  deletionOwner?: ProcessIncarnation
  deletionExecutor?: ProcessIncarnation
  deletionProcessGroupId?: number
}

interface StoredSidecar {
  version: number
  resources: Record<string, StoredResource>
}

describe("session transcript lifecycle", () => {
  let storeDir: string
  let now: number
  let options: SessionLifecycleOptions

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "meridian-session-lifecycle-"))
    now = 10_000
    options = {
      storeDir,
      now: () => now,
      preparedGraceMs: 0,
      retiredGraceMs: 0,
      // Positive recovery cases perform real fsyncs. Use the production wait
      // budget; tests of contention and fail-closed deadlines override it.
      lockWaitMs: 2_000,
      lockRetryMs: 1,
      lockStaleMs: 60_000,
    }
  })

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true })
  })

  async function withSlowRecoverySync(operation: () => Promise<void>): Promise<void> {
    const sync = durableFileSystem.syncDirectoryDurably
    let delayed = 0
    const syncSpy = spyOn(durableFileSystem, "syncDirectoryDurably").mockImplementation(async path => {
      if (path.startsWith(storeDir) && path.includes(".recover-")) {
        // Successful recovery must tolerate storage latency greater than the
        // former 20 ms test deadline, while still performing real fsyncs.
        await new Promise(resolve => setTimeout(resolve, 30))
        delayed++
      }
      await sync(path)
    })
    try {
      await operation()
      expect(delayed).toBeGreaterThan(0)
    } finally {
      syncSpy.mockRestore()
    }
  }

  it("keys ownership by config directory and session id", () => {
    const first = locator("same-id", "profile-a")
    const second = locator("same-id", "profile-b")

    expect(getTranscriptResourceKey(first)).toMatch(/^[a-f0-9]{64}$/)
    expect(getTranscriptResourceKey(first)).not.toBe(getTranscriptResourceKey(second))
    expect(getTranscriptResourceKey({
      ...first,
      configDir: join(first.configDir, "child", ".."),
    })).toBe(getTranscriptResourceKey(first))
    expect(() => getTranscriptResourceKey({ sessionId: "id", configDir: "relative" })).toThrow(
      "configDir must be an absolute path",
    )
  })

  it("persists a prepared intent before commit with private atomic storage", async () => {
    const fork = locator("fork-1")
    const key = getTranscriptResourceKey(await prepareFork(fork, options))

    let sidecar = readSidecar(storeDir)
    expect(sidecar.version).toBe(2)
    expect(sidecar.resources[key]?.state).toBe("prepared")
    expect(statSync(join(storeDir, "session-gc.json")).mode & 0o777).toBe(0o600)
    expect(readdirSync(storeDir).filter((name) => name.includes(".tmp-"))).toEqual([])

    await commitFork(fork, options)
    await commitFork(fork, options)
    sidecar = readSidecar(storeDir)
    expect(sidecar.resources[key]?.state).toBe("live")
  })

  it("validates and upgrades a legacy v1 resource without unsafe shape coercion", async () => {
    const legacy = locator("legacy-v1-sidecar")
    const key = getTranscriptResourceKey(legacy)
    writeFileSync(join(storeDir, "session-gc.json"), JSON.stringify({
      version: 1,
      resources: {
        [key]: {
          key,
          locator: legacy,
          state: "retired",
          createdAt: now - 100,
          updatedAt: now - 100,
          attempts: 0,
          nextAttemptAt: now,
        },
      },
    }), { mode: 0o600 })

    const deleted: TranscriptLocator[] = []
    expect(await runGc([], {
      ...options,
      deleter: async (entry) => { deleted.push(entry) },
    })).toEqual({ deleted: 1, notFound: 0, failed: 0, deferred: 0 })
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toMatchObject(legacy)
    expect(readSidecar(storeDir).resources[key]).toMatchObject({
      state: "deleted",
      generation: expect.stringMatching(new RegExp(`^r:${key}:[1-9][0-9]*$`)),
    })
  })

  it("registers a legacy live transcript and safely revives only pre-delete states", async () => {
    const source = locator("legacy-source")
    const key = getTranscriptResourceKey(await registerLiveTranscript(source, options))
    expect(readSidecar(storeDir).resources[key]?.state).toBe("live")

    await abandonFork(source, { ...options, retiredGraceMs: 100 })
    expect(readSidecar(storeDir).resources[key]?.nextAttemptAt).toBe(now + 100)
    await registerLiveTranscript(source, options)
    expect(readSidecar(storeDir).resources[key]).toMatchObject({ state: "live" })
    expect(readSidecar(storeDir).resources[key]?.nextAttemptAt).toBeUndefined()

    await abandonFork(source, options)
    await runGc([], { ...options, deleter: async () => undefined })
    await expect(registerLiveTranscript(source, options)).rejects.toThrow("from state deleted")

    const prepared = locator("prepared-registration")
    const preparedKey = getTranscriptResourceKey(await prepareFork(prepared, options))
    await registerLiveTranscript(prepared, options)
    expect(readSidecar(storeDir).resources[preparedKey]?.state).toBe("live")

    const inFlight = locator("in-flight-delete")
    const inFlightKey = getTranscriptResourceKey(await registerLiveTranscript(inFlight, options))
    const sidecar = readSidecar(storeDir)
    sidecar.resources[inFlightKey]!.state = "deleting"
    writeFileSync(join(storeDir, "session-gc.json"), JSON.stringify(sidecar), { mode: 0o600 })
    await expect(registerLiveTranscript(inFlight, options)).rejects.toThrow("from state deleting")
  })

  it("requires preallocation and separately bounds backlog and total ownership", async () => {
    await expect(commitFork(locator("unknown"), options)).rejects.toThrow("was not prepared")

    const backlogBounded = { ...options, maxPending: 1 }
    await prepareFork(locator("prepared-backlog"), backlogBounded)
    await expect(prepareFork(locator("second-prepared"), backlogBounded)).rejects.toBeInstanceOf(
      SessionLifecycleBacklogError,
    )
    // Live mappings do not consume the smaller crash/deletion backlog budget.
    await registerLiveTranscript(locator("healthy-live"), backlogBounded)

    const ownershipBounded = { ...options, maxPending: 2, maxOwned: 3 }
    const first = locator("first-owned")
    await prepareFork(first, ownershipBounded)
    await commitFork(first, ownershipBounded)
    await expect(registerLiveTranscript(locator("second-owned"), ownershipBounded)).rejects.toBeInstanceOf(
      SessionLifecycleBacklogError,
    )
  })

  it("reserves live current/predecessor capacity beyond the pending backlog limit", async () => {
    const saved = process.env.MERIDIAN_MAX_STORED_SESSIONS
    process.env.MERIDIAN_MAX_STORED_SESSIONS = "2"
    const derived = { ...options, storeDir: join(storeDir, "derived-capacity"), maxPending: 1 }
    try {
      // Two durable mappings can each pin current + predecessor. The smaller
      // pending budget must not deadlock those four healthy live resources.
      for (const id of ["live-a", "live-b", "live-c", "live-d"]) {
        await registerLiveTranscript(locator(id), derived)
      }
      await prepareFork(locator("one-transient"), derived)
      await expect(registerLiveTranscript(locator("over-total"), derived)).rejects.toBeInstanceOf(
        SessionLifecycleBacklogError,
      )
    } finally {
      if (saved === undefined) delete process.env.MERIDIAN_MAX_STORED_SESSIONS
      else process.env.MERIDIAN_MAX_STORED_SESSIONS = saved
    }
  })

  it("never exceeds the pending bound when many live resources become unpinned", async () => {
    const bounded = { ...options, storeDir: join(storeDir, "bounded-reconcile"), maxPending: 1 }
    const first = locator("unpin-first")
    const second = locator("unpin-second")
    const third = locator("unpin-third")
    for (const live of [first, second, third]) await registerLiveTranscript(live, bounded)

    const result = await reconcile([], bounded)
    expect(result.liveRetired).toBe(1)
    const resources = Object.values(readSidecar(bounded.storeDir).resources)
    expect(resources.filter((resource) => resource.state === "retired")).toHaveLength(1)
    expect(resources.filter((resource) => resource.state === "live")).toHaveLength(2)

    const liveResource = resources.find((resource) => resource.state === "live")!
    const stillLive = { ...liveResource.locator, lifecycleGeneration: liveResource.generation }
    await expect(abandonFork(stillLive, bounded)).rejects.toBeInstanceOf(
      SessionLifecycleBacklogError,
    )
    expect(readSidecar(bounded.storeDir).resources[getTranscriptResourceKey(stillLive)]?.state).toBe("live")
  })

  it("leaves admission capacity while retiring live resources after a profile switch", async () => {
    const bounded = { ...options, storeDir: join(storeDir, "retirement-headroom"), maxPending: 2 }
    const firstStale = locator("first-stale-after-profile-switch")
    const secondStale = locator("second-stale-after-profile-switch")
    const fresh = locator("fresh-after-profile-switch")
    await registerLiveTranscript(firstStale, bounded)
    await registerLiveTranscript(secondStale, bounded)

    expect((await reconcile([], bounded)).liveRetired).toBe(1)
    await prepareFork(fresh, bounded)

    const resources = readSidecar(bounded.storeDir).resources
    expect(resources[getTranscriptResourceKey(fresh)]?.state).toBe("prepared")
    expect(Object.values(resources).filter((resource) => resource.state === "retired")).toHaveLength(1)
    expect(Object.values(resources).filter((resource) => resource.state === "live")).toHaveLength(1)
  })

  it("never lets a delayed publisher recreate a deleted locator after tombstone pruning", async () => {
    const bounded = { ...options, maxTombstones: 1, deleter: async () => undefined }
    const stale = locator("stale-publisher")
    await prepareFork(stale, bounded)
    await commitFork(stale, bounded)
    await abandonFork(stale, bounded)
    await runGc([], bounded)

    // Make replacement recency explicit. Equal timestamps would make the
    // one-slot tombstone choice depend on path-derived key ordering.
    now += 1
    const replacementTombstone = locator("replacement-tombstone")
    await prepareFork(replacementTombstone, bounded)
    await abandonFork(replacementTombstone, bounded)
    await runGc([], bounded)
    expect(readSidecar(storeDir).resources[getTranscriptResourceKey(stale)]).toBeUndefined()

    let published = false
    await expect(publishPinnedTranscript(stale, () => {
      published = true
      return "generation"
    }, bounded)).rejects.toThrow("unjournaled transcript")
    expect(published).toBe(false)

    const legacy = locator("legacy-attach")
    expect(await attachPinnedTranscript(legacy, () => "legacy-generation", bounded))
      .toBe("legacy-generation")
  })

  it("rejects delayed exact references after prune and same-locator recreation", async () => {
    const bounded = { ...options, maxTombstones: 1, deleter: async () => undefined }
    const oldRef = locator("lifecycle-aba")
    await prepareFork(oldRef, bounded)
    const oldGeneration = oldRef.lifecycleGeneration
    await commitFork(oldRef, bounded)
    await abandonFork(oldRef, bounded)
    await runGc([], bounded)
    const other = locator("lifecycle-aba-pruner")
    await prepareFork(other, bounded)
    await abandonFork(other, bounded)
    await runGc([], bounded)

    const replacement = { ...oldRef, lifecycleGeneration: undefined }
    await prepareFork(replacement, bounded)
    expect(replacement.lifecycleGeneration).not.toBe(oldGeneration)
    let callbackRan = false
    await expect(publishPinnedTranscript(oldRef, () => {
      callbackRan = true
      return "impossible"
    }, bounded)).rejects.toThrow("lifecycle generation")
    await expect(commitFork(oldRef, bounded)).rejects.toThrow("lifecycle generation")
    await expect(abandonFork(oldRef, bounded)).rejects.toThrow("lifecycle generation")
    expect(callbackRan).toBe(false)
  })

  it("rolls back legacy lifecycle attachment when its exact store CAS loses or throws", async () => {
    const lost = locator("legacy-cas-loser")
    expect(await attachPinnedTranscript(lost, () => false, options)).toBe(false)
    expect(readSidecar(storeDir).resources[getTranscriptResourceKey(lost)]).toBeUndefined()

    const failed = locator("legacy-cas-error")
    await expect(attachPinnedTranscript(failed, () => {
      throw new Error("store unavailable")
    }, options)).rejects.toThrow("store unavailable")
    expect(readSidecar(storeDir).resources[getTranscriptResourceKey(failed)]).toBeUndefined()
  })

  it("promotes a pinned prepared intent after crash recovery", async () => {
    const current = locator("prepared-current")
    const key = getTranscriptResourceKey(await prepareFork(current, options))

    await reconcile([current], options)

    expect(readSidecar(storeDir).resources[key]?.state).toBe("live")
  })

  it("blocks cross-process deletion while a durable writer lease is active", async () => {
    const fork = locator("durably-active-writer")
    await prepareFork(fork, options)
    const lease = await acquireActiveTranscriptLease([fork], options)
    const executor = captureProcessIncarnation()
    if (!executor) throw new Error("test process incarnation unavailable")
    await attachActiveTranscriptExecutor(lease, executor, options)
    await abandonFork(fork, options)
    let deleted = 0

    const blocked = await runGc([], { ...options, deleter: async () => { deleted++ } })
    expect(blocked.deleted).toBe(0)
    expect(blocked.deferred).toBe(1)
    expect(deleted).toBe(0)

    await releaseActiveTranscriptLease(lease, options)
    expect((await runGc([], { ...options, deleter: async () => { deleted++ } })).deleted).toBe(1)
    expect(deleted).toBe(1)
  })

  it("makes durable SDK writer leases exclusive across requests and proxies", async () => {
    const fork = locator("exclusive-writer")
    await prepareFork(fork, options)
    const first = await acquireActiveTranscriptLease([fork], options)
    await expect(acquireActiveTranscriptLease([fork], options)).rejects.toThrow("active SDK writer")
    await releaseActiveTranscriptLease(first, options)
    const second = await acquireActiveTranscriptLease([fork], options)
    expect(second.token).not.toBe(first.token)
    await releaseActiveTranscriptLease(second, options)
  })

  it("keeps current and previous pins and deletes only retired forks", async () => {
    const current = locator("current")
    const previous = locator("previous")
    const old = locator("old")
    const abandoned = locator("abandoned")
    for (const item of [current, previous, old, abandoned]) await prepareFork(item, options)
    for (const item of [current, previous, old]) await commitFork(item, options)
    await abandonFork(abandoned, options)

    const reconciled = await reconcile([current, previous], options)
    expect(reconciled.resourcesPinned).toBe(2)
    expect(reconciled.liveRetired).toBe(1)

    const deleted: TranscriptLocator[] = []
    const result = await runGc([current, previous], {
      ...options,
      deleter: async (item) => { deleted.push(item) },
    })

    expect(result).toEqual({ deleted: 2, notFound: 0, failed: 0, deferred: 0 })
    expect(deleted.map((item) => item.sessionId).sort()).toEqual(["abandoned", "old"])
    const resources = Object.values(readSidecar(storeDir).resources)
    expect(resources.filter((resource) => resource.state === "live").map((resource) => resource.locator.sessionId).sort())
      .toEqual(["current", "previous"])
    expect(resources.filter((resource) => resource.state === "deleted")).toHaveLength(2)
  })

  it("treats not-found as idempotent success and tombstones the resource", async () => {
    const fork = locator("already-gone")
    await prepareFork(fork, options)
    await abandonFork(fork, options)

    const result = await runGc([], {
      ...options,
      deleter: async () => {
        throw new Error(`Session ${fork.sessionId} not found in project`)
      },
    })

    expect(result.notFound).toBe(1)
    expect(Object.values(readSidecar(storeDir).resources)[0]?.state).toBe("deleted")
  })

  it("does not mistake child ENOENT or generic errors for a missing session", async () => {
    const fork = locator("sdk-load-failure")
    await prepareFork(fork, options)
    await abandonFork(fork, options)

    const result = await runGc([], {
      ...options,
      deleter: async () => {
        const error = new Error("SDK module not found") as Error & { code: string }
        error.code = "ENOENT"
        throw error
      },
    })

    expect(result).toEqual({ deleted: 0, notFound: 0, failed: 1, deferred: 1 })
    expect(Object.values(readSidecar(storeDir).resources)[0]?.state).toBe("retired")
  })

  it("uses a real Node executable when tests run under Bun", () => {
    expect(process.versions.bun).toBeDefined()
    expect(getSessionGcNodeExecutable()).toBe("node")
  })

  it("defers retired deletion through the reader-drain grace period", async () => {
    const fork = locator("reader-grace")
    const graceOptions = { ...options, retiredGraceMs: 100 }
    await prepareFork(fork, graceOptions)
    await abandonFork(fork, graceOptions)
    let calls = 0
    const gcOptions = {
      ...graceOptions,
      deleter: async () => { calls++ },
    }

    expect(await runGc([], gcOptions)).toEqual({ deleted: 0, notFound: 0, failed: 0, deferred: 1 })
    expect(calls).toBe(0)
    now += 99
    expect((await runGc([], gcOptions)).deleted).toBe(0)
    now++
    expect((await runGc([], gcOptions)).deleted).toBe(1)
    expect(calls).toBe(1)
  })

  it("backs off failures and retries deterministically", async () => {
    const fork = locator("retry")
    await prepareFork(fork, options)
    await abandonFork(fork, options)
    let calls = 0
    const retryOptions: SessionLifecycleOptions = {
      ...options,
      retryBaseMs: 100,
      retryMaxMs: 1_000,
      deleter: async () => {
        calls++
        if (calls === 1) throw new Error("temporary failure")
      },
    }

    expect(await runGc([], retryOptions)).toEqual({ deleted: 0, notFound: 0, failed: 1, deferred: 1 })
    let resource = Object.values(readSidecar(storeDir).resources)[0]!
    expect(resource.state).toBe("retired")
    expect(resource.attempts).toBe(1)
    expect(resource.nextAttemptAt).toBe(now + 100)

    expect((await runGc([], retryOptions)).deleted).toBe(0)
    expect(calls).toBe(1)
    now += 100
    expect((await runGc([], retryOptions)).deleted).toBe(1)
    expect(calls).toBe(2)
    resource = Object.values(readSidecar(storeDir).resources)[0]!
    expect(resource.state).toBe("deleted")
  })

  it("keeps an uncertain stale deleting lease fail-closed", async () => {
    const fork = locator("crash")
    const key = getTranscriptResourceKey(await prepareFork(fork, options))
    await abandonFork(fork, options)
    const sidecar = readSidecar(storeDir)
    sidecar.resources[key]!.state = "deleting"
    sidecar.resources[key]!.updatedAt = now - 1_000
    writeFileSync(join(storeDir, "session-gc.json"), JSON.stringify(sidecar), { mode: 0o600 })

    const result = await reconcile([], { ...options, deletingLeaseMs: 100 })
    expect(result.deletingRecovered).toBe(0)
    expect(readSidecar(storeDir).resources[key]?.state).toBe("deleting")
  })

  it("recovers a deleting orphan only after the exact executor is dead", async () => {
    const fork = locator("dead-deletion-executor")
    const key = getTranscriptResourceKey(await prepareFork(fork, options))
    await abandonFork(fork, options)
    const sidecar = readSidecar(storeDir)
    sidecar.resources[key]!.state = "deleting"
    sidecar.resources[key]!.deletionToken = "old-delete-token"
    sidecar.resources[key]!.deletionOwner = deadProcessIncarnation(999_999_998)
    sidecar.resources[key]!.deletionExecutor = deadProcessIncarnation(999_999_999)
    sidecar.resources[key]!.deletionProcessGroupId = 999_999_999
    writeFileSync(join(storeDir, "session-gc.json"), JSON.stringify(sidecar), { mode: 0o600 })

    const recovered = await reconcile([], options)
    expect(recovered.deletingRecovered).toBe(1)
    expect(readSidecar(storeDir).resources[key]?.state).toBe("retired")
    expect((await runGc([], { ...options, deleter: async () => undefined })).deleted).toBe(1)
  })

  it("keeps a deleting orphan fenced while its exact executor may be alive", async () => {
    const current = captureProcessIncarnation()
    if (!current) throw new Error("test process incarnation unavailable")
    const fork = locator("live-deletion-executor")
    const key = getTranscriptResourceKey(await prepareFork(fork, options))
    await abandonFork(fork, options)
    const sidecar = readSidecar(storeDir)
    sidecar.resources[key]!.state = "deleting"
    sidecar.resources[key]!.deletionToken = "live-delete-token"
    sidecar.resources[key]!.deletionOwner = current
    sidecar.resources[key]!.deletionExecutor = current
    sidecar.resources[key]!.deletionProcessGroupId = current.pid
    writeFileSync(join(storeDir, "session-gc.json"), JSON.stringify(sidecar), { mode: 0o600 })

    expect((await reconcile([], options)).deletingRecovered).toBe(0)
    const gc = await runGc([], { ...options, deleter: async () => undefined })
    expect(gc.deferred).toBe(1)
    expect(readSidecar(storeDir).resources[key]?.state).toBe("deleting")
  })

  it("fails closed on a corrupt sidecar without calling the deleter", async () => {
    const path = join(storeDir, "session-gc.json")
    writeFileSync(path, "{broken", { mode: 0o600 })
    let called = false

    await expect(runGc([], {
      ...options,
      deleter: async () => { called = true },
    })).rejects.toBeInstanceOf(SessionLifecycleCorruptError)
    expect(called).toBe(false)
    expect(readFileSync(path, "utf8")).toBe("{broken")
  })

  it("recovers an abandoned stale lock without unlinking a successor", async () => {
    const lock = join(storeDir, "session-gc.json.lock")
    writeFileSync(lock, `${JSON.stringify({ pid: 999_999_999, hostname: hostname(), token: "stale", incarnation: deadProcessIncarnation(999_999_999) })}\n`, { mode: 0o600 })
    const stale = (Date.now() - 1_000) / 1_000
    utimesSync(lock, stale, stale)

    await withSlowRecoverySync(() => prepareFork(locator("after-crash"), {
      ...options,
      lockStaleMs: 10,
    }).then(() => undefined))

    expect(readdirSync(storeDir)).toEqual(["session-gc.json"])
  })

  it("repeatedly adopts dead lifecycle recovery claims and cleans resolved tombstones", async () => {
    const lock = join(storeDir, "session-gc.json.lock")
    const contents = `${JSON.stringify({ pid: 999_999_999, hostname: hostname(), token: "stale-claim-generation", incarnation: deadProcessIncarnation(999_999_999) })}
`
    writeFileSync(lock, contents, { mode: 0o600 })
    const stale = (Date.now() - 1_000) / 1_000
    utimesSync(lock, stale, stale)

    const claim = getRecoveryClaimPath(lock, contents)
    const firstToken = "first-dead-lifecycle-recoverer"
    writeLifecycleRecoveryClaim(
      getRecoveryClaimTombstonePath(claim, firstToken),
      contents,
      firstToken,
      999_999_998,
    )
    writeLifecycleRecoveryClaim(claim, contents, "second-dead-lifecycle-recoverer", 999_999_999)

    await withSlowRecoverySync(() => prepareFork(locator("after-orphaned-lifecycle-recovery"), {
      ...options,
      lockStaleMs: 10,
    }).then(() => undefined))

    expect(readSidecar(storeDir).resources).toBeDefined()
    expect(readdirSync(storeDir).some((name) => name.includes(".recover-"))).toBe(false)
  })

  it("fails closed for live and remote lifecycle recovery owners", async () => {
    const lock = join(storeDir, "session-gc.json.lock")
    const contents = `${JSON.stringify({ pid: 999_999_999, hostname: hostname(), token: "blocked-claim-generation", incarnation: deadProcessIncarnation(999_999_999) })}
`
    const stale = (Date.now() - 1_000) / 1_000

    for (const [claimHostname, claimPid] of [[hostname(), process.pid], ["remote.example", 999_999_999]] as const) {
      writeFileSync(lock, contents, { mode: 0o600 })
      utimesSync(lock, stale, stale)
      const claim = getRecoveryClaimPath(lock, contents)
      writeLifecycleRecoveryClaim(claim, contents, `blocked-${claimHostname}`, claimPid, claimHostname)

      await expect(prepareFork(locator(`blocked-${claimHostname}`), {
        ...options,
        lockWaitMs: 5,
        lockRetryMs: 1,
        lockStaleMs: 10,
      })).rejects.toBeInstanceOf(SessionLifecycleLockError)
      expect(readFileSync(join(claim, "owner.json"), "utf8")).toContain(`blocked-${claimHostname}`)

      rmSync(claim, { recursive: true, force: true })
      rmSync(lock, { force: true })
    }
  })

  it("times out under lock contention and never proceeds unlocked", async () => {
    const lock = join(storeDir, "session-gc.json.lock")
    writeFileSync(lock, "another-owner\n", { mode: 0o600 })
    chmodSync(lock, 0o600)

    await expect(prepareFork(locator("blocked"), {
      ...options,
      lockWaitMs: 3,
      lockRetryMs: 1,
    })).rejects.toBeInstanceOf(SessionLifecycleLockError)
    expect(readdirSync(storeDir)).not.toContain("session-gc.json")
  })
  it("never overlaps a second physical deleter with an uncertain first", async () => {
    const target = locator("lease-token")
    let now = 1_000
    await prepareFork(target, { ...options, now: () => now })
    await commitFork(target, { ...options, now: () => now })

    let releaseFirst!: () => void
    let markFirstEntered!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve })
    const first = runGc([], {
      ...options,
      now: () => now,
      retiredGraceMs: 0,
      deletingLeaseMs: 10,
      deleter: async () => {
        markFirstEntered()
        await firstBlocked
      },
    })
    await firstEntered

    now += 11
    const second = await runGc([], {
      ...options,
      now: () => now,
      retiredGraceMs: 0,
      deletingLeaseMs: 10,
      deleter: async () => {},
    })
    expect(second.deleted).toBe(0)
    releaseFirst()
    expect((await first).deleted).toBe(1)
    expect(readSidecar(storeDir).resources[getTranscriptResourceKey(target)]?.state).toBe("deleted")
  })

  it("leaves a timed-out custom deleter fenced in deleting state", async () => {
    const target = locator("timed-custom-delete")
    await prepareFork(target, options)
    await commitFork(target, options)
    let calls = 0
    const result = await runGc([], {
      ...options,
      retiredGraceMs: 0,
      deletionTimeoutMs: 2,
      runTimeoutMs: 20,
      deleter: async () => {
        calls++
        await new Promise<void>(() => {})
      },
    })
    expect(result.deferred).toBeGreaterThan(0)
    expect(calls).toBe(1)
    expect(readSidecar(storeDir).resources[getTranscriptResourceKey(target)]?.state).toBe("deleting")
    await runGc([], { ...options, retiredGraceMs: 0, deleter: async () => { calls++ } })
    expect(calls).toBe(1)
  })

  it("refreshes durable pins before every destructive claim", async () => {
    const target = locator("fresh-pin")
    await prepareFork(target, options)
    await commitFork(target, options)
    let deleted = false
    const result = await runGc([], {
      ...options,
      retiredGraceMs: 0,
      pinProvider: () => [target],
      deleter: async () => { deleted = true },
    })
    expect(deleted).toBe(false)
    expect(result.deleted).toBe(0)
    expect(readSidecar(storeDir).resources[getTranscriptResourceKey(target)]?.state).toBe("live")
  })

})

function deadProcessIncarnation(pid: number) {
  const current = captureProcessIncarnation()
  if (!current) throw new Error("test process incarnation unavailable")
  return { ...current, pid, bootId: "00000000-0000-4000-8000-000000000000" }
}

function writeLifecycleRecoveryClaim(
  path: string,
  generation: string,
  token: string,
  pid: number,
  ownerHostname = hostname(),
): void {
  const current = captureProcessIncarnation()
  if (!current) throw new Error("test process incarnation unavailable")
  const incarnation = ownerHostname !== hostname()
    ? { ...current, pid, hostId: "b".repeat(64) }
    : pid === process.pid
      ? current
      : { ...current, pid, bootId: "00000000-0000-4000-8000-000000000000" }
  mkdirSync(path, { mode: 0o700 })
  writeFileSync(join(path, "owner.json"), JSON.stringify({
    version: 2,
    generation,
    token,
    pid,
    hostname: ownerHostname,
    createdAt: 1,
    incarnation,
  }), { mode: 0o600 })
}

function locator(sessionId: string, profile = "profile"): TranscriptLocator {
  return {
    sessionId,
    configDir: join(tmpdir(), profile),
    projectDir: join(tmpdir(), "project"),
  }
}

function readSidecar(storeDir: string): StoredSidecar {
  return JSON.parse(readFileSync(join(storeDir, "session-gc.json"), "utf8")) as StoredSidecar
}
