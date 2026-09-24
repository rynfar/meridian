import { expect, it, spyOn } from "bun:test"
import * as crypto from "node:crypto"
import * as fsPromises from "node:fs/promises"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getTranscriptResourceKey,
  reconcile,
  registerLiveTranscript,
  runGc,
  SessionLifecycleLockError,
  type SessionLifecycleOptions,
  type TranscriptLocator,
} from "../proxy/sessionLifecycle"

it("keeps pin matching linear when a large GC sweep competes with request bookkeeping", async () => {
  // Given: an isolated real sidecar with 1,400 resources and 800 pinned sessions.
  const storeDir = mkdtempSync(join(tmpdir(), "meridian-gc-contention-"))
  const locators: TranscriptLocator[] = Array.from({ length: 1_400 }, (_, i) => ({
    sessionId: `synthetic-${i}`,
    configDir: storeDir,
    projectDir: storeDir,
  }))
  const pins = locators.slice(0, 800)
  const resources = Object.fromEntries(locators.map(locator => {
    const key = getTranscriptResourceKey(locator)
    return [key, { key, locator, state: "live", createdAt: 1, updatedAt: 1, attempts: 0 }]
  }))
  writeFileSync(join(storeDir, "session-gc.json"), JSON.stringify({ version: 1, resources }), { mode: 0o600 })
  // The regression gate counts work; it must not depend on the host's fsync latency.
  const options: SessionLifecycleOptions = {
    storeDir, retiredGraceMs: 60_000, now: () => 10_000, lockWaitMs: 30_000,
  }
  try {
    await reconcile(pins, options)
    const createHash = crypto.createHash
    let hashes = 0
    const hashSpy = spyOn(crypto, "createHash").mockImplementation((algorithm, settings) => {
      hashes++
      return createHash(algorithm, settings)
    })
    const durations: number[] = []
    const holds: number[] = []
    const link = fsPromises.link
    const unlink = fsPromises.unlink
    const lockPath = join(storeDir, "session-gc.json.lock")
    let acquiredAt = 0
    const linkSpy = spyOn(fsPromises, "link").mockImplementation(async (source, target) => {
      await link(source, target)
      if (target === lockPath) acquiredAt = performance.now()
    })
    const unlinkSpy = spyOn(fsPromises, "unlink").mockImplementation(async path => {
      await unlink(path)
      if (path === lockPath) holds.push(performance.now() - acquiredAt)
    })
    const requests: Promise<boolean>[] = []
    let launched = false
    let gcMs = 0
    try {
      // When: requests arrive after GC owns the lock, without artificial I/O delays.
      const started = performance.now()
      await runGc(pins, {
        ...options,
        pinProvider: () => {
          if (!launched) {
            launched = true
            for (let i = 0; i < 4; i++) {
              const requestStarted = performance.now()
              requests.push(registerLiveTranscript({ sessionId: `request-${i}`, configDir: storeDir }, options)
                .then(() => true, error => {
                  if (error instanceof SessionLifecycleLockError) return false
                  throw error
                }).finally(() => { durations.push(performance.now() - requestStarted) }))
            }
          }
          return pins
        },
        deleter: async () => { throw new Error("quarantined resources must not be deleted") },
      })
      gcMs = performance.now() - started
      const results = await Promise.all(requests)
      const timeouts = results.filter(result => !result).length
      console.log(JSON.stringify({ resources: 1_400, pins: pins.length, requests: results.length,
        timeouts, hashes, gcMs: Math.round(gcMs), maxRequestMs: Math.round(Math.max(...durations)),
        lockHoldsMs: holds.map(value => Math.round(value)) }))
      // Then: work scales with the input, not resources multiplied by pins.
      expect(hashes).toBeLessThan(20_000)
      expect(timeouts).toBe(0)
    } finally {
      await Promise.allSettled(requests)
      hashSpy.mockRestore()
      linkSpy.mockRestore()
      unlinkSpy.mockRestore()
    }
  } finally {
    rmSync(storeDir, { recursive: true, force: true })
  }
}, 60_000)
