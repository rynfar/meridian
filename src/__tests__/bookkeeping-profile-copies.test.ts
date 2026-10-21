import { afterAll, afterEach, beforeAll, beforeEach, expect, it, spyOn } from "bun:test"
import { fork, spawnSync } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { initializeSessionBookkeeping, withBookkeepingWrite, type BookkeepingHandle } from "../proxy/session/bookkeeping/database"
import { sqliteSessionStoreBackend } from "../proxy/session/bookkeeping/sqliteStoreBackend"
import { sqliteLifecycleBackend } from "../proxy/session/bookkeeping/lifecycleSql"
import { connectionFor } from "../proxy/session/bookkeeping/connection"
import { resourceKey } from "../proxy/session/bookkeeping/locator"
import { pendingCount } from "../proxy/session/bookkeeping/lifecycleRowsSql"
import { CrossProcessTurnCoordinator } from "../proxy/session/crossProcessTurnCoordinator"
import { lifecycleLockQueue } from "../proxy/session/lifecycleLockQueue"
import { listSupersededProfileConversations, pruneSupersededProfileCopies, readSessionStoreSnapshot,
  setSessionStoreBackendForTest, setSessionStoreDir, storeSharedSession } from "../proxy/sessionStore"
import { acquireActiveTranscriptLease, registerLiveTranscript, releaseActiveTranscriptLease,
  releaseSupersededProfileCopies, setSessionLifecycleBackendForTest } from "../proxy/sessionLifecycle"

let directory: string, handle: BookkeepingHandle
let fixture: string, nativeNode: string, commitFaultKey: string | undefined
const graceMs = 24 * 60 * 60_000
const copies = { profileIds: ["work", "personal"], graceMs, isConversationActive: () => false }
beforeAll(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "profile-copy-node-fixture-")))
  symlinkSync(resolve("node_modules"), join(fixture, "node_modules"), "junction")
  const built = spawnSync(process.execPath, ["build", resolve("src/__tests__/fixtures/bookkeeping-profile-copy-worker.ts"),
    "--target=node", "--external", "libsql", `--outfile=${join(fixture, "worker.mjs")}`], { encoding: "utf8", timeout: 30_000 })
  expect(built.status, built.stdout + built.stderr).toBe(0)
  const node = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8", timeout: 10_000 })
  expect(node.status, node.stderr).toBe(0)
  nativeNode = node.stdout.trim()
})
afterAll(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }) })
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "sql-profile-copies-")))
  setSessionStoreDir(directory)
  commitFaultKey = undefined
  handle = initializeSessionBookkeeping(directory, { executeTransaction(db, sql) {
    if (sql === "COMMIT" && commitFaultKey
      && !db.prepare("SELECT key FROM mappings WHERE key=?").get(commitFaultKey)) {
      commitFaultKey = undefined
      throw Object.assign(new Error("owned pre-commit refusal"), { code: "SQLITE_BUSY" })
    }
    db.exec(sql)
  } })
  setSessionStoreBackendForTest(sqliteSessionStoreBackend)
  setSessionLifecycleBackendForTest(sqliteLifecycleBackend)
})
afterEach(() => {
  setSessionLifecycleBackendForTest(null)
  setSessionStoreBackendForTest(null)
  handle.close()
  setSessionStoreDir(null)
  rmSync(directory, { recursive: true, force: true })
})
const keys = () => Object.keys(readSessionStoreSnapshot()).sort()
const options = () => ({ storeDir: directory, maxPending: 8, pinProvider: () => [] })
async function seed(key: string, stale: boolean, transcript = true) {
  const locator = { sessionId: randomUUID(), configDir: directory }
  if (transcript) await registerLiveTranscript(locator, options())
  expect((await storeSharedSession(key, locator.sessionId, 1, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, transcript ? locator : undefined))).not.toBe(false)
  withBookkeepingWrite(directory, { scope: "store" }, tx => {
    tx.run("UPDATE mappings SET last_used_at=? WHERE key=?", Date.now() - (stale ? graceMs + 60_000 : 1000), key)
  })
  return locator
}

it("dispatches SQL copy selection/pruning without opening either JSON authority", async () => {
  await seed("work:conversation", true)
  await seed("personal:conversation", false)
  await seed("work:single", true)
  expect(listSupersededProfileConversations({ ...copies, maxUnpinnedTranscripts: 4 })).toEqual(["conversation"])
  expect((await pruneSupersededProfileCopies({ ...copies, maxUnpinnedTranscripts: 4 }))).toBe(1)
  expect(keys()).toEqual(["personal:conversation", "work:single"])
  expect(existsSync(join(directory, "sessions.json"))).toBe(false)
  expect(existsSync(join(directory, "session-gc.json"))).toBe(false)
})

it("preserves recent, active, unknown-prefix and priority-authoritative mappings", async () => {
  for (const id of ["active", "recent", "protected", "eligible"]) {
    await seed(`work:${id}`, id !== "recent")
    await seed(`personal:${id}`, false)
  }
  await seed("unknown:eligible", true)
  withBookkeepingWrite(directory, { scope: "store" }, tx => {
    tx.run(`INSERT INTO priority_assignments VALUES('route','work',?,1,'work:protected',?, ?,1,1)`,
      "d".repeat(43), String(tx.get("SELECT generation_token FROM mappings WHERE key='work:protected'")!.generation_token), randomUUID())
  })
  expect((await pruneSupersededProfileCopies({ ...copies, maxUnpinnedTranscripts: 4,
    isConversationActive: id => id === "active" }))).toBe(1)
  expect(keys()).toContain("work:protected")
  expect(keys()).toContain("work:active")
  expect(keys()).toContain("work:recent")
  expect(keys()).toContain("unknown:eligible")
  expect(keys()).not.toContain("work:eligible")
})

it("observes callbacks outside native transactions and retains a mapping refreshed during observation", async () => {
  const locator = await seed("work:conversation", true)
  await seed("personal:conversation", false)
  const observedAt = handle.reader.get("SELECT last_used_at FROM mappings WHERE key='work:conversation'")!.last_used_at
  let calls = 0
  const removed = (await pruneSupersededProfileCopies({ ...copies, maxUnpinnedTranscripts: 4,
    isConversationActive: () => {
      expect(connectionFor(directory).scope).toBeUndefined()
      if (calls++ === 0) {
        const refreshed = storeSharedSession("work:conversation", locator.sessionId, 2)
        expect(refreshed).not.toBeInstanceOf(Promise)
        expect(refreshed).not.toBe(false)
        // A new generation can retain imported old activity metadata. Age alone
        // must not let an observer delete a publication it never selected.
        withBookkeepingWrite(directory, { scope: "store" }, tx => {
          tx.run("UPDATE mappings SET last_used_at=? WHERE key='work:conversation'", observedAt!)
        })
      }
      return false
    } }))
  expect(calls).toBeGreaterThan(0)
  expect(removed).toBe(0)
  expect(keys()).toEqual(["personal:conversation", "work:conversation"])
})

it("atomically reserves half-budget retirement across competing SQL sweeps", async () => {
  for (let n = 0; n < 8; n++) {
    await seed(`work:conversation-${n}`, true)
    await seed(`personal:conversation-${n}`, false)
  }
  const removed = await Promise.all([0, 1].map(() => releaseSupersededProfileCopies(copies, options())))
  expect(removed.reduce((a, b) => a + b, 0)).toBe(4)
  expect(pendingCount(handle.reader)).toBe(4)
  expect(handle.reader.get("SELECT count(*) AS n FROM resources WHERE state='retired'")!.n).toBe(4)
  expect(keys().length).toBe(12)
  expect(existsSync(join(directory, "session-gc.json"))).toBe(false)
})

it("keeps every copy while another coordinator owns the conversation turn", async () => {
  await seed("work:conversation", true)
  await seed("personal:conversation", false)
  const coordinator = new CrossProcessTurnCoordinator(join(directory, "turn-locks"))
  const lease = await coordinator.acquire("session:conversation")
  try {
    expect(await releaseSupersededProfileCopies(copies, options())).toBe(0)
    expect(keys()).toEqual(["personal:conversation", "work:conversation"])
  } finally { await lease.release() }
  expect(await releaseSupersededProfileCopies(copies, options())).toBe(1)
})

it("a pin-provider failure precedes mapping deletion and all turn leases release", async () => {
  await seed("work:conversation", true)
  await seed("personal:conversation", false)
  const failure = new Error("owned pin observation failed")
  await expect(releaseSupersededProfileCopies(copies, { ...options(), pinProvider: () => { throw failure } })).rejects.toBe(failure)
  expect(keys()).toEqual(["personal:conversation", "work:conversation"])
  expect(await releaseSupersededProfileCopies(copies, options())).toBe(1)
})

it("respects additional pins and an active writer while retiring other unshared copies", async () => {
  const pinned = await seed("work:pinned", true)
  await seed("personal:pinned", false)
  const ordinary = await seed("work:ordinary", true)
  await seed("personal:ordinary", false)
  const writing = await seed("work:writing", true)
  await seed("personal:writing", false)
  const lease = await acquireActiveTranscriptLease([writing], options())
  try {
    expect(await releaseSupersededProfileCopies(copies, { ...options(), pinProvider: () => [pinned] })).toBe(3)
    expect(handle.reader.get("SELECT state FROM resources WHERE key=?", resourceKey(writing))!.state).toBe("live")
  } finally { await releaseActiveTranscriptLease(lease, options()) }
  expect(handle.reader.get("SELECT state FROM resources WHERE key=?", resourceKey(pinned))!.state).toBe("live")
  expect(handle.reader.get("SELECT state FROM resources WHERE key=?", resourceKey(ordinary))!.state).toBe("retired")
  expect(pendingCount(handle.reader)).toBe(1)
})

it("rechecks a local arrival after waiting for native-write FIFO admission", async () => {
  await seed("work:conversation", true)
  await seed("personal:conversation", false)
  const coordinator = new CrossProcessTurnCoordinator(join(directory, "turn-locks"))
  const acquire = coordinator.tryAcquireIdle.bind(coordinator)
  const gate = Promise.withResolvers<void>(), queued = Promise.withResolvers<void>()
  let blocker: Promise<void> | undefined, active = false
  const observations: boolean[] = []
  const original = spyOn(coordinator, "tryAcquireIdle").mockImplementation(async key => {
    const lease = await acquire(key)
    if (lease && !blocker) blocker = lifecycleLockQueue.run(connectionFor(directory).path, undefined, () => gate.promise)
    return lease
  })
  let pruning: Promise<number> | undefined
  try {
    pruning = releaseSupersededProfileCopies({ ...copies, isConversationActive: () => {
      expect(connectionFor(directory).scope).toBeUndefined()
      observations.push(active)
      return active
    } }, { ...options(), pinProvider: () => {
      expect(connectionFor(directory).scope).toBeUndefined()
      if (blocker) queued.resolve()
      return []
    } }, coordinator)
    await queued.promise
    active = true
    gate.resolve()
    expect(await pruning).toBe(0)
    expect(observations).toContain(false)
    expect(observations).toContain(true)
    expect(keys()).toEqual(["personal:conversation", "work:conversation"])
  } finally {
    gate.resolve()
    await Promise.allSettled([blocker, pruning])
    original.mockRestore()
  }
})

it("rolls back mapping deletion, fence slots and retirement together when COMMIT refuses", async () => {
  await seed("work:conversation", true)
  await seed("personal:conversation", false)
  const snapshot = () => Object.fromEntries(["mappings", "mapping_pins", "mapping_history", "resources",
    "resource_leases", "fence_slots", "bookkeeping_counts"].map(table => [table, handle.reader.all(`SELECT * FROM ${table} ORDER BY 1,2`)]))
  const before = snapshot()
  commitFaultKey = "work:conversation"
  await expect(releaseSupersededProfileCopies(copies, options())).rejects.toThrow("COMMIT busy")
  expect(snapshot()).toEqual(before)
  expect(await releaseSupersededProfileCopies(copies, options())).toBe(1)
})

it("shares one half-budget between two actual native Node processes with disjoint turns", async () => {
  for (let n = 0; n < 8; n++) {
    await seed(`work:conversation-${n}`, true)
    await seed(`personal:conversation-${n}`, false)
  }
  const actors = [0, 1].map(partition => {
    const child = fork(join(fixture, "worker.mjs"), [directory, String(partition)], {
      execPath: nativeNode, env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    child.stdout!.resume()
    let stderr = ""
    child.stderr!.on("data", bytes => { stderr += bytes })
    const closed = once(child, "close")
    const ready = Promise.race([once(child, "message"), closed.then(() => { throw new Error(stderr) })])
    return { child, closed, ready, errors: () => stderr }
  })
  try {
    await Promise.all(actors.map(actor => actor.ready))
    const reports = actors.map(actor => once(actor.child, "message"))
    for (const actor of actors) actor.child.send({ type: "start" })
    const done = await Promise.all(reports)
    for (const actor of actors) {
      const [code, signal] = await actor.closed
      expect(code, actor.errors()).toBe(0)
      expect(signal).toBeNull()
      expect(actor.child.stdout!.destroyed).toBe(true)
      expect(actor.child.stderr!.destroyed).toBe(true)
    }
    const rows = done.map(([row]) => row as { type: string; removed: number; pid: number; node: string })
    expect(rows.every(row => row.type === "done" && row.node.startsWith("v"))).toBe(true)
    expect(new Set(rows.map(row => row.pid)).size).toBe(2)
    expect(rows.reduce((sum, row) => sum + row.removed, 0)).toBe(4)
    expect(pendingCount(handle.reader)).toBe(4)
    expect(keys().length).toBe(12)
    console.info(JSON.stringify({ scope: "two original native Node processes", actors: rows, joined: true, pending: 4 }))
  } finally {
    for (const actor of actors) if (actor.child.exitCode === null && actor.child.signalCode === null) actor.child.kill("SIGKILL")
    await Promise.allSettled(actors.map(actor => actor.closed))
  }
}, 15_000)
