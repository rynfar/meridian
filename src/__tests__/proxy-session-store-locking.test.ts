import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearSharedSessions,
  evictSharedSession,
  lookupSharedSession,
  readSessionStoreSnapshot,
  setSessionStoreDir,
  storeSharedSession,
} from "../proxy/sessionStore"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"
import {
  getRecoveryClaimPath,
  getRecoveryClaimTombstonePath,
} from "../proxy/session/recoveryClaim"

describe("Shared session store locking", () => {
  let tmpDir: string
  const originalLockTimeout = process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-store-locking-test-"))
    setSessionStoreDir(tmpDir, { skipLocking: false })
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
    const modulePath = join(import.meta.dir, "../proxy/sessionStore.ts")
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

  it("atomically takes over a stale lock", async () => {
    const sessionsPath = join(tmpDir, "sessions.json")
    const lockPath = `${sessionsPath}.lock`

    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, hostname: hostname(), token: "stale", incarnation: deadProcessIncarnation(999_999_999) }), { mode: 0o600 })
    const staleTime = (Date.now() - 31_000) / 1000
    utimesSync(lockPath, staleTime, staleTime)

    await storeSharedSession("stale-lock-session", "claude-stale")

    expect(lookupSharedSession("stale-lock-session")?.claudeSessionId).toBe("claude-stale")
    expect(existsSync(lockPath)).toBe(false)
    expect(readdirSync(tmpDir).some((name) => name.includes(".lock.stale-"))).toBe(false)
  })

  it("repeatedly adopts dead recovery claims and cleans tombstones after resolution", async () => {
    const lockPath = join(tmpDir, "sessions.json.lock")
    const staleOwner = JSON.stringify({ pid: 999_999_999, hostname: hostname(), token: "stale-generation", incarnation: deadProcessIncarnation(999_999_999) })
    writeFileSync(lockPath, staleOwner, { mode: 0o600 })
    const staleTime = (Date.now() - 31_000) / 1000
    utimesSync(lockPath, staleTime, staleTime)

    const claimPath = getRecoveryClaimPath(lockPath, staleOwner)
    const firstToken = "first-dead-recoverer"
    const firstTombstone = getRecoveryClaimTombstonePath(claimPath, firstToken)
    writeRecoveryClaim(firstTombstone, staleOwner, firstToken, 999_999_998)
    writeRecoveryClaim(claimPath, staleOwner, "second-dead-recoverer", 999_999_999)

    await storeSharedSession("after-orphaned-recovery", "claude-after-orphan")

    expect(lookupSharedSession("after-orphaned-recovery")?.claudeSessionId).toBe("claude-after-orphan")
    expect(existsSync(lockPath)).toBe(false)
    expect(readdirSync(tmpDir).some((name) => name.includes(".recover-"))).toBe(false)
  })

  it("fails closed for live and remote recovery claim owners", async () => {
    const lockPath = join(tmpDir, "sessions.json.lock")
    const staleOwner = JSON.stringify({ pid: 999_999_999, hostname: hostname(), token: "blocked-generation", incarnation: deadProcessIncarnation(999_999_999) })
    const staleTime = (Date.now() - 31_000) / 1000
    process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "20"

    for (const [claimHostname, claimPid] of [[hostname(), process.pid], ["remote.example", 999_999_999]] as const) {
      writeFileSync(lockPath, staleOwner, { mode: 0o600 })
      utimesSync(lockPath, staleTime, staleTime)
      const claimPath = getRecoveryClaimPath(lockPath, staleOwner)
      writeRecoveryClaim(claimPath, staleOwner, `blocked-${claimHostname}`, claimPid, claimHostname)

      await expect(storeSharedSession(`blocked-${claimHostname}`, "claude-never-written")).rejects
        .toThrow("timed out waiting for lock")
      expect(existsSync(join(claimPath, "owner.json"))).toBe(true)

      rmSync(claimPath, { recursive: true, force: true })
      rmSync(lockPath, { force: true })
    }
  })

  it("waits for an active owner, then throws without deleting its token", async () => {
    const lockPath = join(tmpDir, "sessions.json.lock")
    writeFileSync(lockPath, "different-owner-token", { mode: 0o600 })
    process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "30"

    await expect(storeSharedSession("lock-contention", "claude-never-written")).rejects
      .toThrow("timed out waiting for lock")
    expect(readFileSync(lockPath, "utf8")).toBe("different-owner-token")
    expect(lookupSharedSession("lock-contention")).toBeUndefined()
  })

  it("fails all mutations closed when the store is corrupt", async () => {
    const sessionsPath = join(tmpDir, "sessions.json")
    const corrupt = "{invalid-json"
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    writeFileSync(sessionsPath, corrupt)

    expect(lookupSharedSession("broken")).toBeUndefined()
    await expect(storeSharedSession("write", "claude-write")).rejects.toThrow()
    await expect(evictSharedSession("broken")).rejects.toThrow()
    await expect(clearSharedSessions()).rejects.toThrow()
    expect(readFileSync(sessionsPath, "utf8")).toBe(corrupt)
    expect(errorSpy).toHaveBeenCalledWith("[sessionStore] read failed:", expect.any(String))

    errorSpy.mockRestore()
  })

  it("writes through a unique mode-0600 temporary file and leaves no artifacts", async () => {
    await storeSharedSession("secure", "claude-secure")

    const sessionsPath = join(tmpDir, "sessions.json")
    expect(statSync(sessionsPath).mode & 0o777).toBe(0o600)
    expect(readdirSync(tmpDir).filter((name) => name.includes(".tmp-"))).toEqual([])
    expect(JSON.parse(readFileSync(sessionsPath, "utf8")).secure.claudeSessionId).toBe("claude-secure")
  })

  it("keeps serving the event loop while a write waits for the disk", async () => {
    const delayMs = 150
    let syncs = 0
    const restore = await delayFileHandleSync(tmpDir, delayMs, () => { syncs++ })
    let ticks = 0
    const heartbeat = setInterval(() => { ticks++ }, 5)
    try {
      const write = storeSharedSession("slow-disk", "claude-slow-disk")
      const ticksBeforeWrite = ticks
      await write
      // Lock candidate, the store's temporary file, and the directory.
      expect(syncs).toBe(3)
      expect(ticks - ticksBeforeWrite).toBeGreaterThanOrEqual(10)
    } finally {
      clearInterval(heartbeat)
      restore()
    }
    expect(lookupSharedSession("slow-disk")?.claudeSessionId).toBe("claude-slow-disk")
  })

  it("applies overlapping writes in call order, so the last writer wins", async () => {
    // Earlier calls get slower syncs: without in-process ordering the last
    // caller would take the lock first and the first caller's write would land last.
    let syncCall = 0
    const restore = await delayFileHandleSync(tmpDir, () => Math.max(0, 120 - 20 * syncCall++))
    try {
      const generations = await Promise.all(Array.from({ length: 6 }, (_, i) =>
        storeSharedSession("contended", `claude-${i}`, i)))
      expect(new Set(generations).size).toBe(6)
    } finally {
      restore()
    }
    expect(lookupSharedSession("contended")).toMatchObject({ claudeSessionId: "claude-5", messageCount: 5 })
  })

  it("leaves the previous store intact when the writer dies between fsync and rename", async () => {
    const modulePath = join(import.meta.dir, "../proxy/sessionStore.ts")
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `
        import { open } from "node:fs/promises"
        import { storeSharedSession } from ${JSON.stringify(modulePath)}
        await storeSharedSession("kept", "claude-kept")
        const probe = await open(process.env.PROBE, "w")
        const proto = Object.getPrototypeOf(probe)
        await probe.close()
        const writeFile = proto.writeFile
        const sync = proto.sync
        const storeFiles = new WeakSet()
        proto.writeFile = async function (data, ...rest) {
          const head = typeof data === "string" ? data.slice(0, 64) : Buffer.isBuffer(data) ? data.subarray(0, 64).toString("utf8") : ""
          if (head.includes("meridian-session-store")) storeFiles.add(this)
          return writeFile.call(this, data, ...rest)
        }
        proto.sync = async function () {
          await sync.call(this)
          if (storeFiles.has(this)) process.kill(process.pid, "SIGKILL")
        }
        await storeSharedSession("lost", "claude-lost")
        process.exit(3)
      `],
      env: { ...process.env, MERIDIAN_SESSION_DIR: tmpDir, PROBE: join(tmpDir, "probe") },
      stdout: "ignore",
      stderr: "pipe",
    })
    const [, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(child.signalCode).toBe("SIGKILL")
    expect(stderr).toBe("")

    const stored = JSON.parse(readFileSync(join(tmpDir, "sessions.json"), "utf8"))
    expect(stored.kept?.claudeSessionId).toBe("claude-kept")
    expect(stored.lost).toBeUndefined()
    // The replacement reached the disk in full; only the rename never happened.
    const orphans = readdirSync(tmpDir).filter((name) => name.startsWith("sessions.json.tmp-"))
    expect(orphans).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(tmpDir, orphans[0]!), "utf8")).lost?.claudeSessionId).toBe("claude-lost")
  }, 20_000)

  it("keeps a second process out while the lock holder waits for the disk", async () => {
    const modulePath = join(import.meta.dir, "../proxy/sessionStore.ts")
    const holding = join(tmpDir, "holding")
    const release = join(tmpDir, "release")
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `
        import { existsSync, writeFileSync } from "node:fs"
        import { open } from "node:fs/promises"
        import { storeSharedSession } from ${JSON.stringify(modulePath)}
        const probe = await open(process.env.PROBE, "w")
        const proto = Object.getPrototypeOf(probe)
        await probe.close()
        const writeFile = proto.writeFile
        const sync = proto.sync
        const storeFiles = new WeakSet()
        proto.writeFile = async function (data, ...rest) {
          const head = typeof data === "string" ? data.slice(0, 64) : Buffer.isBuffer(data) ? data.subarray(0, 64).toString("utf8") : ""
          if (head.includes("meridian-session-store")) storeFiles.add(this)
          return writeFile.call(this, data, ...rest)
        }
        proto.sync = async function () {
          if (storeFiles.has(this)) {
            writeFileSync(process.env.HOLDING, "")
            while (!existsSync(process.env.RELEASE)) await new Promise((resolve) => setTimeout(resolve, 10))
          }
          return sync.call(this)
        }
        await storeSharedSession("holder", "claude-holder")
      `],
      env: { ...process.env, MERIDIAN_SESSION_DIR: tmpDir, PROBE: join(tmpDir, "probe"), HOLDING: holding, RELEASE: release },
      stdout: "ignore",
      stderr: "pipe",
    })
    try {
      await waitForFile(holding, 10_000)
      expect(JSON.parse(readFileSync(join(tmpDir, "sessions.json.lock"), "utf8")).pid).toBe(child.pid)
      process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "300"
      await expect(storeSharedSession("contender", "claude-contender")).rejects.toThrow("timed out waiting for lock")
    } finally {
      writeFileSync(release, "")
    }
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)

    await storeSharedSession("contender", "claude-contender")
    expect(readSessionStoreSnapshot()).toMatchObject({
      holder: { claudeSessionId: "claude-holder" },
      contender: { claudeSessionId: "claude-contender" },
    })
  }, 20_000)
})

async function delayFileHandleSync(
  dir: string,
  delayMs: number | (() => number),
  onSync?: () => void,
): Promise<() => void> {
  const probe = await open(join(dir, "sync-probe"), "w")
  const prototype = Object.getPrototypeOf(probe) as FileHandle
  await probe.close()
  rmSync(join(dir, "sync-probe"), { force: true })
  const sync = prototype.sync
  prototype.sync = async function (this: FileHandle) {
    onSync?.()
    await Bun.sleep(typeof delayMs === "number" ? delayMs : delayMs())
    return sync.call(this)
  }
  return () => { prototype.sync = sync }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
    await Bun.sleep(10)
  }
}

function deadProcessIncarnation(pid: number) {
  const current = captureProcessIncarnation()
  if (!current) throw new Error("test process incarnation unavailable")
  return { ...current, pid, bootId: "00000000-0000-4000-8000-000000000000" }
}

function writeRecoveryClaim(
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
