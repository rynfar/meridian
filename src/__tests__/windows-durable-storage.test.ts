import { afterEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { CrossProcessTurnCoordinator } from "../proxy/session/crossProcessTurnCoordinator"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"
import { prepareFork } from "../proxy/sessionLifecycle"
import {
  lookupSharedSession,
  setSessionStoreDir,
  storeSharedSession,
} from "../proxy/sessionStore"

const roots: string[] = []

afterEach(() => {
  setSessionStoreDir(null)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("Windows-safe durable session storage", () => {
  it("writes lifecycle sidecars and recovers an exact dead lock owner", async () => {
    const root = makeRoot("lifecycle")
    const lockPath = join(root, "session-gc.json.lock")
    const owner = {
      pid: 999_999_999,
      hostname: hostname(),
      token: "dead-lifecycle-owner",
      incarnation: deadIncarnation(999_999_999),
    }
    writeFileSync(lockPath, `${JSON.stringify(owner)}
1
`, { mode: 0o600 })
    makeStale(lockPath)

    const prepared = await prepareFork({
      sessionId: "platform-lifecycle-target",
      configDir: root,
    }, {
      storeDir: root,
      lockWaitMs: 10_000,
      lockRetryMs: 5,
      lockStaleMs: 1,
    })

    expect(prepared.lifecycleGeneration).toMatch(/^r:[a-f0-9]{64}:1$/)
    expect(JSON.parse(readFileSync(join(root, "session-gc.json"), "utf8")).version).toBe(2)
    expect(existsSync(lockPath)).toBe(false)
  }, 30_000)

  it("recovers the synchronous store lock before publishing a mapping", () => {
    const root = makeRoot("store")
    setSessionStoreDir(root, { skipLocking: false })
    const lockPath = join(root, "sessions.json.lock")
    writeFileSync(lockPath, JSON.stringify({
      pid: 999_999_999,
      hostname: hostname(),
      token: "dead-store-owner",
      incarnation: deadIncarnation(999_999_999),
    }), { mode: 0o600 })
    makeStale(lockPath)

    storeSharedSession("platform-store-key", "platform-store-session")

    expect(lookupSharedSession("platform-store-key")?.claudeSessionId)
      .toBe("platform-store-session")
    expect(existsSync(lockPath)).toBe(false)
  }, 30_000)

  it("recovers a durable cross-process turn lock", async () => {
    const root = makeRoot("turn")
    const key = "platform-logical-turn"
    const token = "dead-turn-owner"
    const lockPath = join(root, `${createHash("sha256").update(key).digest("hex")}.lock`)
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      token,
      pid: 999_999_999,
      hostname: hostname(),
      createdAt: 1,
      incarnation: deadIncarnation(999_999_999),
    }))
    const heartbeat = join(lockPath, `heartbeat-${token}`)
    writeFileSync(heartbeat, "")
    makeStale(heartbeat)

    const coordinator = new CrossProcessTurnCoordinator(root, {
      acquireTimeoutMs: 10_000,
      staleAfterMs: 100,
      heartbeatIntervalMs: 20,
      retryDelayMs: 5,
    })
    const lease = await coordinator.acquire(key)
    expect(lease.waitedMs).toBeGreaterThanOrEqual(0)
    await lease.release()
    expect(existsSync(lockPath)).toBe(false)
  }, 30_000)
})

function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `meridian-platform-${label}-`))
  roots.push(root)
  return root
}

function makeStale(path: string): void {
  const old = new Date(1)
  utimesSync(path, old, old)
}

function deadIncarnation(pid: number) {
  const current = captureProcessIncarnation()
  if (!current) throw new Error("test process incarnation unavailable")
  return {
    ...current,
    pid,
    bootId: "00000000-0000-4000-8000-000000000000",
  }
}
