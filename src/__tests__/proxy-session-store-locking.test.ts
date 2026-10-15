import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import {
  clearSharedSessions,
  lookupSharedSession,
  lookupSharedSessionResult,
  readSessionStoreSnapshot,
  setSessionStoreDir,
  storeSharedSession,
} from "../proxy/sessionStore"
import { holdWriteLock, readCommittedSession, storeIntegrity } from "./storeDatabaseHelpers"

const modulePath = join(import.meta.dir, "../proxy/sessionStore.ts")

/** The error a promise rejects with. `expect(promise).rejects` cannot wait for
 *  a store write under bun test (see session/storeDatabase.ts). */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected the promise to reject")
}

describe("Shared session store locking", () => {
  let tmpDir: string
  const originalLockTimeout = process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-store-locking-test-"))
    setSessionStoreDir(tmpDir)
    await clearSharedSessions()
  })

  afterEach(() => {
    setSessionStoreDir(null)
    rmSync(tmpDir, { recursive: true, force: true })
    if (originalLockTimeout === undefined) delete process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS
    else process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = originalLockTimeout
  })

  it("preserves every entry from real concurrent writer processes", async () => {
    const workerCount = 8
    const entriesPerWorker = 12
    const childCode = `
      import { storeSharedSession } from ${JSON.stringify(modulePath)}
      const worker = Number(process.env.WORKER)
      for (let i = 0; i < ${entriesPerWorker}; i++) {
        const key = \`worker-\${worker}-session-\${i}\`
        await storeSharedSession(key, \`claude-\${worker}-\${i}\`, i)
      }
    `

    const children = Array.from({ length: workerCount }, (_, worker) => Bun.spawn({
      cmd: [process.execPath, "-e", childCode],
      env: {
        ...process.env,
        MERIDIAN_SESSION_DIR: tmpDir,
        MERIDIAN_SESSION_LOCK_TIMEOUT_MS: "10000",
        MERIDIAN_MAX_STORED_SESSIONS: "10000",
        WORKER: String(worker),
      },
      stdout: "ignore",
      stderr: "pipe",
    }))

    for (const child of children) {
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ])
      expect(stderr).toBe("")
      expect(exitCode).toBe(0)
    }

    const snapshot = readSessionStoreSnapshot()
    expect(Object.keys(snapshot)).toHaveLength(workerCount * entriesPerWorker)
    for (let worker = 0; worker < workerCount; worker++) {
      for (let i = 0; i < entriesPerWorker; i++) {
        expect(snapshot[`worker-${worker}-session-${i}`]?.claudeSessionId).toBe(`claude-${worker}-${i}`)
      }
    }
  }, 20_000)

  it("gives exactly one of several processes the compare-and-swap on one generation", async () => {
    const initial = await storeSharedSession("contended", "claude-initial")
    expect(initial).not.toBe(false)
    const go = join(tmpDir, "go")
    const children = Array.from({ length: 4 }, (_, worker) => Bun.spawn({
      cmd: [process.execPath, "-e", `
        import { existsSync } from "node:fs"
        import { lookupSharedSessionResult, storeSharedSession } from ${JSON.stringify(modulePath)}
        const armed = lookupSharedSessionResult("contended")
        if (armed.status !== "found" || armed.generation !== ${JSON.stringify(initial)}) process.exit(2)
        while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(5)
        const won = await storeSharedSession(
          "contended", "claude-worker-${worker}", undefined, undefined, undefined, undefined, undefined,
          undefined, undefined, undefined, undefined, undefined, armed.generation,
        )
        console.log(won === false ? "lost" : "won")
      `],
      env: { ...process.env, MERIDIAN_SESSION_DIR: tmpDir },
      stdout: "pipe",
      stderr: "pipe",
    }))
    await Bun.sleep(200)
    writeFileSync(go, "")

    const outcomes: string[] = []
    for (const [worker, child] of children.entries()) {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(stderr).toBe("")
      expect(exitCode).toBe(0)
      outcomes.push(`${worker}:${stdout.trim()}`)
    }
    const winners = outcomes.filter((outcome) => outcome.endsWith(":won"))
    expect(winners).toHaveLength(1)
    const winner = winners[0]!.split(":")[0]
    expect(lookupSharedSession("contended")?.claudeSessionId).toBe(`claude-worker-${winner}`)
  }, 20_000)

  it("waits for a process holding the write lock, then times out without touching the store", async () => {
    await storeSharedSession("existing", "claude-existing")
    const holder = await holdWriteLock(tmpDir)
    process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "300"
    try {
      const started = performance.now()
      const error = await rejectionOf(storeSharedSession("contender", "claude-contender"))
      expect(error.message).toContain("timed out waiting for lock")
      expect(performance.now() - started).toBeGreaterThanOrEqual(250)
      // Reads never wait for a writer.
      expect(lookupSharedSession("existing")?.claudeSessionId).toBe("claude-existing")
      expect(lookupSharedSession("contender")).toBeUndefined()
    } finally {
      await holder.release()
    }
    expect(await storeSharedSession("contender", "claude-contender")).not.toBe(false)
    expect(readCommittedSession(tmpDir, "contender")?.claudeSessionId).toBe("claude-contender")
  }, 20_000)

  it("keeps serving the event loop while a write waits for another process's lock", async () => {
    const holder = await holdWriteLock(tmpDir)
    const delay = monitorEventLoopDelay({ resolution: 1 })
    let ticks = 0
    let collections = 0
    // Collecting garbage while the write waits is what would stall the loop if
    // the writer ever let one of its statements be finalized.
    const heartbeat = setInterval(() => {
      ticks++
      if (ticks % 10 === 0) {
        Bun.gc(true)
        collections++
      }
    }, 5)
    delay.enable()
    try {
      const write = storeSharedSession("waiting-write", "claude-waiting")
      await Bun.sleep(400)
      expect(lookupSharedSession("waiting-write")).toBeUndefined()
      await holder.release()
      expect(await write).not.toBe(false)
    } finally {
      clearInterval(heartbeat)
      delay.disable()
    }
    expect(ticks).toBeGreaterThanOrEqual(40)
    expect(collections).toBeGreaterThanOrEqual(4)
    expect(delay.max / 1e6).toBeLessThan(100)
    expect(lookupSharedSession("waiting-write")?.claudeSessionId).toBe("claude-waiting")
  }, 20_000)

  it("keeps what a writer committed, and nothing of the transaction it died in", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `
        import AsyncDatabase from "libsql/promise"
        import { storeSharedSession } from ${JSON.stringify(modulePath)}
        await storeSharedSession("kept", "claude-kept")
        const exec = AsyncDatabase.prototype.exec
        AsyncDatabase.prototype.exec = function (sql) {
          // The rows are written; the transaction dies before it commits.
          if (sql === "COMMIT") process.kill(process.pid, "SIGKILL")
          return exec.call(this, sql)
        }
        await storeSharedSession("lost", "claude-lost")
        process.exit(3)
      `],
      env: { ...process.env, MERIDIAN_SESSION_DIR: tmpDir },
      stdout: "ignore",
      stderr: "pipe",
    })
    const [, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(child.signalCode).toBe("SIGKILL")
    expect(stderr).toBe("")

    expect(readCommittedSession(tmpDir, "kept")?.claudeSessionId).toBe("claude-kept")
    expect(readCommittedSession(tmpDir, "lost")).toBeUndefined()
    expect(lookupSharedSession("kept")?.claudeSessionId).toBe("claude-kept")
    expect(storeIntegrity(tmpDir)).toBe("ok")
    // The dead writer left no lock behind.
    process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "1000"
    expect(await storeSharedSession("after", "claude-after")).not.toBe(false)
  }, 20_000)

  it("takes the lock of a writer that died holding it at once", async () => {
    const holder = await holdWriteLock(tmpDir)
    process.kill(holder.pid, "SIGKILL")
    await Bun.sleep(50)
    process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "1000"
    const started = performance.now()
    expect(await storeSharedSession("after-dead-holder", "claude-after")).not.toBe(false)
    expect(performance.now() - started).toBeLessThan(900)
  }, 20_000)

  it("keeps the database and its write-ahead log private and leaves nothing else", async () => {
    await storeSharedSession("secure", "claude-secure")
    expect(readdirSync(tmpDir).sort()).toEqual(["sessions.db", "sessions.db-shm", "sessions.db-wal"])
    for (const name of readdirSync(tmpDir)) {
      expect({ name, mode: statSync(join(tmpDir, name)).mode & 0o777 }).toEqual({ name, mode: 0o600 })
    }
  })

  it("applies overlapping writes in call order, so the last writer wins", async () => {
    const generations = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      storeSharedSession("contended", `claude-${i}`, i)))
    expect(new Set(generations).size).toBe(6)
    expect(lookupSharedSession("contended")).toMatchObject({ claudeSessionId: "claude-5", messageCount: 5 })
    const result = lookupSharedSessionResult("contended")
    expect(result.status === "found" ? result.generation : undefined).toBe(generations[5] as string)
  })

  // A slow disk is imitated by delaying every fsync of a child process through
  // LD_PRELOAD, which needs Linux and a C compiler.
  const compiler = process.platform === "linux" ? Bun.which("cc") : null
  it.skipIf(!compiler)("keeps serving the event loop while COMMIT waits for a slow fsync", async () => {
    const shimSource = join(tmpDir, "slow-fsync.c")
    const shim = join(tmpDir, "slow-fsync.so")
    writeFileSync(shimSource, `
      #define _GNU_SOURCE
      #include <dlfcn.h>
      #include <stdlib.h>
      #include <unistd.h>
      static void slow(void) { const char *ms = getenv("SLOW_FSYNC_MS"); if (ms) usleep(atoi(ms) * 1000); }
      int fsync(int fd) { static int (*real)(int); if (!real) real = dlsym(RTLD_NEXT, "fsync"); slow(); return real(fd); }
      int fdatasync(int fd) { static int (*real)(int); if (!real) real = dlsym(RTLD_NEXT, "fdatasync"); slow(); return real(fd); }
    `)
    const build = Bun.spawnSync({ cmd: [compiler!, "-shared", "-fPIC", "-o", shim, shimSource, "-ldl"], stderr: "pipe" })
    expect(build.exitCode).toBe(0)
    const storeDir = join(tmpDir, "store")

    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `
        import { monitorEventLoopDelay } from "node:perf_hooks"
        import { storeSharedSession } from ${JSON.stringify(modulePath)}
        await storeSharedSession("warm", "claude-warm")
        const delay = monitorEventLoopDelay({ resolution: 1 })
        let ticks = 0
        const heartbeat = setInterval(() => { ticks++ }, 5)
        delay.enable()
        const started = performance.now()
        for (let i = 0; i < 3; i++) await storeSharedSession("slow-" + i, "claude-slow-" + i)
        const writesMs = performance.now() - started
        delay.disable()
        clearInterval(heartbeat)
        console.log(JSON.stringify({ writesMs, ticks, maxDelayMs: delay.max / 1e6 }))
      `],
      env: { ...process.env, MERIDIAN_SESSION_DIR: storeDir, LD_PRELOAD: shim, SLOW_FSYNC_MS: "250" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    const measured = JSON.parse(stdout) as { writesMs: number; ticks: number; maxDelayMs: number }
    // Every write's commit waited for the delayed fsync, and the loop kept running.
    expect(measured.writesMs).toBeGreaterThanOrEqual(3 * 250)
    expect(measured.ticks).toBeGreaterThanOrEqual(Math.floor(measured.writesMs / 5 / 2))
    expect(measured.maxDelayMs).toBeLessThan(100)

    setSessionStoreDir(storeDir)
    expect(lookupSharedSession("slow-2")?.claudeSessionId).toBe("claude-slow-2")
  }, 30_000)
})
