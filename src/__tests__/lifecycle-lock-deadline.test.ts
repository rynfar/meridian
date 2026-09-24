import { expect, it, spyOn } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as durable from "../proxy/session/durableFileSystem"
import { registerLiveTranscript, SessionLifecycleLockError } from "../proxy/sessionLifecycle"

it.each([true, false])("starts a fresh external budget after long local waiting (external owner releases=%s)", async releases => {
  const storeDir = mkdtempSync(join(tmpdir(), "meridian-lock-deadline-"))
  const lock = join(storeDir, "session-gc.json.lock")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let clock = 0
  let externalInstalled = false
  let failedAttempts = 0
  const nowSpy = spyOn(performance, "now").mockImplementation(() => clock)
  const sync = durable.syncDirectoryDurably
  const syncSpy = spyOn(durable, "syncDirectoryDurably").mockImplementation(async path => {
    if (path === storeDir) { entered.resolve(); await release.promise }
    await sync(path)
  })
  const unlink = fsPromises.unlink
  const unlinkSpy = spyOn(fsPromises, "unlink").mockImplementation(async path => {
    await unlink(path)
    if (path === lock && !externalInstalled) {
      externalInstalled = true
      writeFileSync(lock, "external owner\n")
    }
  })
  const link = fsPromises.link
  const linkSpy = spyOn(fsPromises, "link").mockImplementation(async (source, destination) => {
    try {
      await link(source, destination)
    } catch (error) {
      if (destination !== lock || !externalInstalled) throw error
      failedAttempts++
      clock += 60
      if (releases) rmSync(lock)
      throw error
    }
  })
  const options = { storeDir, lockWaitMs: 100, lockRetryMs: 1 }
  const first = registerLiveTranscript({ sessionId: "first", configDir: storeDir }, options)
  let second: Promise<unknown> | undefined
  try {
    await entered.promise
    second = registerLiveTranscript({ sessionId: "second", configDir: storeDir }, options)
      .then(result => result, error => error)
    // Local service takes ten external budgets. Only time at the head counts.
    clock = 1_000
    release.resolve()
    await first
    const result = await second
    if (releases) {
      expect(result).toHaveProperty("lifecycleGeneration")
      expect(failedAttempts).toBe(1)
    } else {
      expect(result).toBeInstanceOf(SessionLifecycleLockError)
      expect(failedAttempts).toBe(2)
      expect(readFileSync(lock, "utf8")).toBe("external owner\n")
    }
  } finally {
    release.resolve()
    await Promise.allSettled([first, second])
    nowSpy.mockRestore()
    syncSpy.mockRestore()
    unlinkSpy.mockRestore()
    linkSpy.mockRestore()
    rmSync(storeDir, { recursive: true, force: true })
  }
})
