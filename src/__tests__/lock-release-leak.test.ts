/**
 * A lock whose own release failed must not outlive the operation that held it.
 *
 * Stale-lock recovery takes another process's lock only once that owner is
 * proven dead. When this process's release fails (EACCES after a permission
 * change on the store directory, EIO), the lock file stays behind stamped with
 * this process, which is alive, so nothing ever retired it: every later
 * acquisition waited out its deadline until the proxy restarted.
 *
 * Each reclaim case fails one release, then expects the next acquisition to
 * succeed well inside the default stale threshold. The guard cases check that a
 * lock held by another live process, or by an operation still running in this
 * one, is never taken over.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import * as fsPromises from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import * as durable from "../proxy/session/durableFileSystem"
import { CrossProcessTurnCoordinator } from "../proxy/session/crossProcessTurnCoordinator"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"
import { getRecoveryClaimPath } from "../proxy/session/recoveryClaim"
import {
  SessionLifecycleLockError,
  reconcile,
  registerLiveTranscript,
} from "../proxy/sessionLifecycle"
import {
  lookupSharedSession,
  setSessionStoreDir,
  storeSharedSession,
  withLegacyStoreMaintenanceLock,
} from "../proxy/sessionStore"

const roots: string[] = []
const originalLockTimeout = process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS

function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `meridian-lock-leak-${label}-`))
  roots.push(root)
  return root
}

afterEach(() => {
  setSessionStoreDir(null)
  if (originalLockTimeout === undefined) delete process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS
  else process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = originalLockTimeout
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

// Root ignores directory permissions, and win32 has no traversal bit.
const canRevokeTraversal = process.platform !== "win32" && process.getuid?.() !== 0

function accessDenied(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, '${path}'`), { code: "EACCES" })
}

/** A real process that stays alive, so its incarnation probes as live. */
function spawnLiveProcess() {
  return Bun.spawn({
    cmd: [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
    stdout: "ignore",
    stderr: "ignore",
  })
}

function currentIncarnation() {
  const current = captureProcessIncarnation()
  if (!current) throw new Error("test process incarnation unavailable")
  return current
}

function deadIncarnation(pid: number) {
  return { ...currentIncarnation(), pid, bootId: "00000000-0000-4000-8000-000000000000" }
}

/** A recovery claim stamped with this process that no recovery here holds. */
function writeOwnRecoveryClaim(path: string, generation: string, token: string): void {
  mkdirSync(path, { mode: 0o700 })
  writeFileSync(join(path, "owner.json"), JSON.stringify({
    version: 2,
    generation,
    token,
    pid: process.pid,
    hostname: hostname(),
    createdAt: 1,
    incarnation: currentIncarnation(),
  }), { mode: 0o600 })
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) return false
    await Bun.sleep(50)
  }
  return true
}

/** Run one reconcile whose lock release fails because the store's parent
 *  directory became untraversable while the lock was held. */
async function leakLifecycleLock(label: string): Promise<{ storeDir: string, lock: string }> {
  const parent = join(makeRoot(label), "parent")
  const storeDir = join(parent, "store")
  mkdirSync(storeDir, { recursive: true })
  const lock = join(storeDir, "session-gc.json.lock")
  let revoked = false
  try {
    await expect(reconcile([], {
      storeDir,
      pinProvider: () => {
        // Runs while the lifecycle lock is held.
        if (!revoked) {
          revoked = true
          chmodSync(parent, 0o000)
        }
        return []
      },
    })).rejects.toThrow("EACCES")
  } finally {
    chmodSync(parent, 0o755)
  }
  expect(revoked).toBe(true)
  const leaked = JSON.parse(readFileSync(lock, "utf8").split("\n", 1)[0] ?? "") as { pid: number }
  expect(leaked.pid).toBe(process.pid)
  return { storeDir, lock }
}

describe("session lifecycle lock", () => {
  it.skipIf(!canRevokeTraversal)("takes the lock again after its own release failed", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const { storeDir, lock } = await leakLifecycleLock("lifecycle")
      expect(errorSpy).toHaveBeenCalledWith(
        "[sessionLifecycle] lock release failed:",
        expect.stringContaining("EACCES"),
      )
      // Default lockStaleMs (60 s): the lock's age is not what clears it.
      await expect(reconcile([], { storeDir, lockWaitMs: 1_500 })).resolves.toBeDefined()
      expect(existsSync(lock)).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it.skipIf(!canRevokeTraversal)("keeps clearing its own leaked lock in the background for other processes", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const { lock } = await leakLifecycleLock("lifecycle-retry")
      // No further acquisition here: only the release retry can clear it.
      expect(await waitUntil(() => !existsSync(lock), 5_000)).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  }, 10_000)

  it("still waits out a lock that another live process holds", async () => {
    const storeDir = makeRoot("lifecycle-foreign")
    const lock = join(storeDir, "session-gc.json.lock")
    const other = spawnLiveProcess()
    try {
      const incarnation = captureProcessIncarnation(other.pid)
      if (!incarnation) throw new Error("child process incarnation unavailable")
      const contents = `${JSON.stringify({ pid: other.pid, hostname: hostname(), token: "other-live-owner", incarnation })}\n1\n`
      writeFileSync(lock, contents, { mode: 0o600 })
      utimesSync(lock, new Date(1), new Date(1))

      await expect(reconcile([], { storeDir, lockWaitMs: 50, lockRetryMs: 5, lockStaleMs: 1 }))
        .rejects.toBeInstanceOf(SessionLifecycleLockError)
      expect(readFileSync(lock, "utf8")).toBe(contents)
    } finally {
      other.kill()
      await other.exited
    }
  })

  it.skipIf(process.platform === "win32")("never takes over a lock that an operation of this process still holds", async () => {
    const root = makeRoot("lifecycle-in-flight")
    const storeDir = join(root, "store")
    mkdirSync(storeDir, { mode: 0o700 })
    // The same lock through another path, so the in-process queue, which is
    // keyed by path, does not serialize the two callers.
    const alias = join(root, "alias")
    symlinkSync(storeDir, alias)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const sync = durable.syncDirectoryDurably
    const syncSpy = spyOn(durable, "syncDirectoryDurably").mockImplementation(async path => {
      if (path === storeDir) {
        entered.resolve()
        await release.promise
      }
      await sync(path)
    })
    try {
      const holder = registerLiveTranscript({ sessionId: "holder", configDir: storeDir }, { storeDir })
      await entered.promise
      await expect(registerLiveTranscript(
        { sessionId: "contender", configDir: storeDir },
        { storeDir: alias, lockWaitMs: 50, lockRetryMs: 5, lockStaleMs: 1 },
      )).rejects.toBeInstanceOf(SessionLifecycleLockError)
      release.resolve()
      await expect(holder).resolves.toHaveProperty("sessionId", "holder")
      expect(existsSync(join(storeDir, "session-gc.json.lock"))).toBe(false)
    } finally {
      release.resolve()
      syncSpy.mockRestore()
    }
  })

  it("retires a recovery claim this process left behind", async () => {
    const storeDir = makeRoot("lifecycle-claim")
    const lock = join(storeDir, "session-gc.json.lock")
    const contents = `${JSON.stringify({ pid: 999_999_999, hostname: hostname(), token: "dead-owner", incarnation: deadIncarnation(999_999_999) })}\n1\n`
    writeFileSync(lock, contents, { mode: 0o600 })
    utimesSync(lock, new Date(1), new Date(1))
    // Its cleanup failed. It used to block recovery of the dead lock for good.
    writeOwnRecoveryClaim(getRecoveryClaimPath(lock, contents), contents, "claim-left-by-this-process")

    await expect(reconcile([], { storeDir, lockWaitMs: 2_000, lockRetryMs: 1, lockStaleMs: 10 }))
      .resolves.toBeDefined()
    expect(readdirSync(storeDir).filter(name => name.includes(".recover-") || name.endsWith(".lock"))).toEqual([])
  })
})

describe("session store lock", () => {
  /** One store write whose lock unlink fails once with EACCES. */
  async function leakStoreLock(label: string): Promise<{ lock: string, restore: () => void }> {
    const storeDir = makeRoot(label)
    setSessionStoreDir(storeDir)
    const lock = join(storeDir, "sessions.json.lock")
    const unlink = fsPromises.unlink
    let failed = false
    const unlinkSpy = spyOn(fsPromises, "unlink").mockImplementation(async path => {
      if (path === lock && !failed) {
        failed = true
        throw accessDenied(lock)
      }
      await unlink(path)
    })
    await storeSharedSession("before-leak", "claude-before")
    expect(failed).toBe(true)
    expect(existsSync(lock)).toBe(true)
    return { lock, restore: () => unlinkSpy.mockRestore() }
  }

  it("takes the lock again after its own release failed", async () => {
    process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "500"
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    const { lock, restore } = await leakStoreLock("store")
    try {
      expect(errorSpy).toHaveBeenCalledWith("[sessionStore] lock release failed:", expect.stringContaining("EACCES"))
      // The stale threshold is 30 s; this must not wait for it.
      await storeSharedSession("after-leak", "claude-after")
      expect(lookupSharedSession("after-leak")?.claudeSessionId).toBe("claude-after")
      expect(lookupSharedSession("before-leak")?.claudeSessionId).toBe("claude-before")
      expect(existsSync(lock)).toBe(false)
    } finally {
      restore()
      errorSpy.mockRestore()
    }
  })

  it("keeps clearing its own leaked lock in the background for other processes", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    const { lock, restore } = await leakStoreLock("store-retry")
    try {
      // No further store write here: only the release retry can clear it.
      expect(await waitUntil(() => !existsSync(lock), 5_000)).toBe(true)
    } finally {
      restore()
      errorSpy.mockRestore()
    }
  }, 10_000)

  it("still waits out a lock that another live process holds", async () => {
    const storeDir = makeRoot("store-foreign")
    setSessionStoreDir(storeDir)
    process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "50"
    const lock = join(storeDir, "sessions.json.lock")
    const other = spawnLiveProcess()
    try {
      const incarnation = captureProcessIncarnation(other.pid)
      if (!incarnation) throw new Error("child process incarnation unavailable")
      const contents = JSON.stringify({ pid: other.pid, hostname: hostname(), token: "other-live-owner", incarnation })
      writeFileSync(lock, contents, { mode: 0o600 })
      utimesSync(lock, new Date(1), new Date(1))

      await expect(storeSharedSession("blocked", "claude-never-written")).rejects.toThrow("timed out waiting for lock")
      expect(readFileSync(lock, "utf8")).toBe(contents)
    } finally {
      other.kill()
      await other.exited
    }
  })

  it("retires a recovery claim this process left behind", async () => {
    const storeDir = makeRoot("store-claim")
    setSessionStoreDir(storeDir)
    process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "2000"
    const lock = join(storeDir, "sessions.json.lock")
    const contents = JSON.stringify({ pid: 999_999_999, hostname: hostname(), token: "dead-owner", incarnation: deadIncarnation(999_999_999) })
    writeFileSync(lock, contents, { mode: 0o600 })
    utimesSync(lock, new Date(1), new Date(1))
    writeOwnRecoveryClaim(getRecoveryClaimPath(lock, contents), contents, "claim-left-by-this-process")

    await storeSharedSession("after-leaked-claim", "claude-after-claim")
    expect(lookupSharedSession("after-leaked-claim")?.claudeSessionId).toBe("claude-after-claim")
    expect(readdirSync(storeDir).filter(name => name.includes(".recover-") || name.endsWith(".lock"))).toEqual([])
  })

  it("legacy maintenance lock: takes the lock again after its own release failed", () => {
    const directory = makeRoot("store-legacy")
    const lock = join(directory, "sessions.json.lock")
    const unlinkSync = fs.unlinkSync
    let failed = false
    const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation(path => {
      if (path === lock && !failed) {
        failed = true
        throw accessDenied(lock)
      }
      unlinkSync(path)
    })
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      expect(withLegacyStoreMaintenanceLock(directory, () => "first")).toBe("first")
      expect(failed).toBe(true)
      expect(existsSync(lock)).toBe(true)
      expect(withLegacyStoreMaintenanceLock(directory, () => "second")).toBe("second")
      expect(existsSync(lock)).toBe(false)
    } finally {
      unlinkSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})

describe("cross-process turn lock", () => {
  it("retires a recovery claim this process left behind", async () => {
    const root = makeRoot("turn-claim")
    const lockPath = join(root, `${createHash("sha256").update("logical-session").digest("hex")}.lock`)
    const generation = "dead-owner"
    mkdirSync(lockPath, { mode: 0o700 })
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      token: generation, pid: 999_999_999, hostname: hostname(), createdAt: 1, incarnation: deadIncarnation(999_999_999),
    }))
    const heartbeat = join(lockPath, `heartbeat-${generation}`)
    writeFileSync(heartbeat, "")
    utimesSync(heartbeat, new Date(1), new Date(1))
    writeOwnRecoveryClaim(getRecoveryClaimPath(lockPath, generation), generation, "claim-left-by-this-process")

    const coordinator = new CrossProcessTurnCoordinator(root, { acquireTimeoutMs: 1_000, staleAfterMs: 20, heartbeatIntervalMs: 5, retryDelayMs: 5 })
    const lease = await coordinator.acquire("logical-session")
    await lease.release()
    expect(readdirSync(root)).toEqual([])
  })
})
