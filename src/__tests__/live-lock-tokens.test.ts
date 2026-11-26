/**
 * Every lock this process takes holds its owner token from before the lock can
 * be seen until the release attempt is over, so only a lock whose release
 * failed reads as abandoned by this process (see lock-release-leak.test.ts).
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  abandonedBySelf,
  dropLockToken,
  holdLockToken,
  lockTokenIsHeld,
} from "../proxy/session/liveLockTokens"
import { captureProcessIncarnation, type ProcessIncarnation } from "../proxy/session/processIncarnation"
import { reconcile } from "../proxy/sessionLifecycle"
import { setSessionStoreDir, storeSharedSession, withLegacyStoreMaintenanceLock } from "../proxy/sessionStore"

type LockOwner = { token: string, incarnation: ProcessIncarnation }

const roots: string[] = []
function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `meridian-live-lock-tokens-${label}-`))
  roots.push(root)
  return root
}
afterEach(() => {
  setSessionStoreDir(null)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("live lock tokens", () => {
  it("are shared through globalThis by every copy of the module", () => {
    const registry = (globalThis as typeof globalThis & Record<symbol, Set<string> | undefined>)[Symbol.for("meridian.session.liveLockTokens")]
    holdLockToken("shared-token")
    try {
      expect(registry?.has("shared-token")).toBe(true)
    } finally {
      dropLockToken("shared-token")
    }
    expect(registry?.has("shared-token")).toBe(false)
  })

  it("only this exact incarnation can abandon a lock by itself", () => {
    const current = captureProcessIncarnation()
    if (!current) throw new Error("test process incarnation unavailable")
    expect(abandonedBySelf({ token: "not-held", incarnation: current })).toBe(true)
    holdLockToken("held")
    try {
      expect(abandonedBySelf({ token: "held", incarnation: current })).toBe(false)
    } finally {
      dropLockToken("held")
    }
    expect(abandonedBySelf({ token: "other-start", incarnation: { ...current, startId: `${current.startId}-other` } })).toBe(false)
    expect(abandonedBySelf({ token: "other-pid", incarnation: { ...current, pid: current.pid + 1 } })).toBe(false)
  })

  it("are held across the store lock's async publication and release, then dropped", async () => {
    const storeDir = makeRoot("store")
    setSessionStoreDir(storeDir)
    const lock = join(storeDir, "sessions.json.lock")
    const link = fsPromises.link
    const unlink = fsPromises.unlink
    let owner: LockOwner | undefined
    const observations: boolean[] = []
    const linkSpy = spyOn(fsPromises, "link").mockImplementation(async (from, to) => {
      await link(from, to)
      if (to === lock) {
        owner = JSON.parse(readFileSync(lock, "utf8")) as LockOwner
        observations.push(lockTokenIsHeld(owner.token))
      }
    })
    const unlinkSpy = spyOn(fsPromises, "unlink").mockImplementation(async path => {
      if (path === lock) {
        await Promise.resolve()
        observations.push(lockTokenIsHeld(owner!.token))
      }
      await unlink(path)
    })
    try {
      await storeSharedSession("async-owner", "claude-async-owner")
      expect(observations).toEqual([true, true])
      expect(lockTokenIsHeld(owner!.token)).toBe(false)
    } finally {
      linkSpy.mockRestore()
      unlinkSpy.mockRestore()
    }
  })

  it("are held while a lifecycle operation runs, then dropped", async () => {
    const storeDir = makeRoot("lifecycle")
    let owner: LockOwner | undefined
    await reconcile([], {
      storeDir,
      pinProvider: () => {
        owner = JSON.parse(readFileSync(join(storeDir, "session-gc.json.lock"), "utf8").split("\n", 1)[0]!) as LockOwner
        expect(lockTokenIsHeld(owner.token)).toBe(true)
        return []
      },
    })
    expect(owner).toBeDefined()
    expect(lockTokenIsHeld(owner!.token)).toBe(false)
  })

  it("are dropped by the legacy maintenance lock even when it became a barrier", () => {
    const directory = makeRoot("legacy")
    const lock = join(directory, "sessions.json.lock")
    let owner: LockOwner | undefined
    withLegacyStoreMaintenanceLock(directory, () => {
      owner = JSON.parse(readFileSync(lock, "utf8")) as LockOwner
      expect(lockTokenIsHeld(owner.token)).toBe(true)
      // Offline migration replaces the lock with a barrier, which is never released.
      writeFileSync(lock, "barrier")
    })
    expect(readFileSync(lock, "utf8")).toBe("barrier")
    expect(lockTokenIsHeld(owner!.token)).toBe(false)
  })
})
