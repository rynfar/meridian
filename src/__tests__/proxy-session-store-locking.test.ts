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

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-store-locking-test-"))
    setSessionStoreDir(tmpDir, { skipLocking: false })
    clearSharedSessions()
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
        storeSharedSession(key, \`claude-\${worker}-\${i}\`, i)
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

  it("atomically takes over a stale lock", () => {
    const sessionsPath = join(tmpDir, "sessions.json")
    const lockPath = `${sessionsPath}.lock`

    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, hostname: hostname(), token: "stale", incarnation: deadProcessIncarnation(999_999_999) }), { mode: 0o600 })
    const staleTime = (Date.now() - 31_000) / 1000
    utimesSync(lockPath, staleTime, staleTime)

    storeSharedSession("stale-lock-session", "claude-stale")

    expect(lookupSharedSession("stale-lock-session")?.claudeSessionId).toBe("claude-stale")
    expect(existsSync(lockPath)).toBe(false)
    expect(readdirSync(tmpDir).some((name) => name.includes(".lock.stale-"))).toBe(false)
  })

  it("repeatedly adopts dead recovery claims and cleans tombstones after resolution", () => {
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

    storeSharedSession("after-orphaned-recovery", "claude-after-orphan")

    expect(lookupSharedSession("after-orphaned-recovery")?.claudeSessionId).toBe("claude-after-orphan")
    expect(existsSync(lockPath)).toBe(false)
    expect(readdirSync(tmpDir).some((name) => name.includes(".recover-"))).toBe(false)
  })

  it("fails closed for live and remote recovery claim owners", () => {
    const lockPath = join(tmpDir, "sessions.json.lock")
    const staleOwner = JSON.stringify({ pid: 999_999_999, hostname: hostname(), token: "blocked-generation", incarnation: deadProcessIncarnation(999_999_999) })
    const staleTime = (Date.now() - 31_000) / 1000
    process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "20"

    for (const [claimHostname, claimPid] of [[hostname(), process.pid], ["remote.example", 999_999_999]] as const) {
      writeFileSync(lockPath, staleOwner, { mode: 0o600 })
      utimesSync(lockPath, staleTime, staleTime)
      const claimPath = getRecoveryClaimPath(lockPath, staleOwner)
      writeRecoveryClaim(claimPath, staleOwner, `blocked-${claimHostname}`, claimPid, claimHostname)

      expect(() => storeSharedSession(`blocked-${claimHostname}`, "claude-never-written"))
        .toThrow("timed out waiting for lock")
      expect(existsSync(join(claimPath, "owner.json"))).toBe(true)

      rmSync(claimPath, { recursive: true, force: true })
      rmSync(lockPath, { force: true })
    }
  })

  it("waits for an active owner, then throws without deleting its token", () => {
    const lockPath = join(tmpDir, "sessions.json.lock")
    writeFileSync(lockPath, "different-owner-token", { mode: 0o600 })
    process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "30"

    expect(() => storeSharedSession("lock-contention", "claude-never-written"))
      .toThrow("timed out waiting for lock")
    expect(readFileSync(lockPath, "utf8")).toBe("different-owner-token")
    expect(lookupSharedSession("lock-contention")).toBeUndefined()
  })

  it("fails all mutations closed when the store is corrupt", () => {
    const sessionsPath = join(tmpDir, "sessions.json")
    const corrupt = "{invalid-json"
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    writeFileSync(sessionsPath, corrupt)

    expect(lookupSharedSession("broken")).toBeUndefined()
    expect(() => storeSharedSession("write", "claude-write")).toThrow()
    expect(() => evictSharedSession("broken")).toThrow()
    expect(() => clearSharedSessions()).toThrow()
    expect(readFileSync(sessionsPath, "utf8")).toBe(corrupt)
    expect(errorSpy).toHaveBeenCalledWith("[sessionStore] read failed:", expect.any(String))

    errorSpy.mockRestore()
  })

  it("writes through a unique mode-0600 temporary file and leaves no artifacts", () => {
    storeSharedSession("secure", "claude-secure")

    const sessionsPath = join(tmpDir, "sessions.json")
    expect(statSync(sessionsPath).mode & 0o777).toBe(0o600)
    expect(readdirSync(tmpDir).filter((name) => name.includes(".tmp-"))).toEqual([])
    expect(JSON.parse(readFileSync(sessionsPath, "utf8")).secure.claudeSessionId).toBe("claude-secure")
  })
})

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
