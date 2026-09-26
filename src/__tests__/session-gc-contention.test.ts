import { expect, it, spyOn } from "bun:test"
import * as crypto from "node:crypto"
import * as fsPromises from "node:fs/promises"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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

it.each([false, true])("durably admits 24 simultaneous registrations with a large sidecar (GC=%s)", async withGc => {
  // Given: an isolated real sidecar with 1,400 resources and 800 pinned sessions.
  // macOS may return /var for a directory whose real path is /private/var.
  // Use the same canonical path for fixture keys and lifecycle registrations.
  const storeDir = realpathSync(mkdtempSync(join(tmpdir(), "meridian-gc-contention-")))
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
  const options: SessionLifecycleOptions = { storeDir, retiredGraceMs: 60_000, now: () => 10_000 }
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
    const gcEntered = Promise.withResolvers<void>()
    try {
      // The arrival continuation belongs to the request context, not the GC's
      // synchronous pin callback (which must not reenter lifecycle bookkeeping).
      const started = performance.now()
      const requestsFinished = gcEntered.promise.then(async () => {
        for (let i = 0; i < 24; i++) {
          const requestStarted = performance.now()
          requests.push(registerLiveTranscript({ sessionId: `request-${i}`, configDir: storeDir }, options)
            .then(() => true, error => {
              if (error instanceof SessionLifecycleLockError) return false
              throw error
            }).finally(() => { durations.push(performance.now() - requestStarted) }))
        }
        return Promise.all(requests)
      })
      const gc = withGc ? runGc(pins, {
        ...options,
        pinProvider: () => {
          gcEntered.resolve()
          return pins
        },
        deleter: async () => { throw new Error("quarantined resources must not be deleted") },
      }) : Promise.resolve()
      if (!withGc) gcEntered.resolve()
      const [results, gcError] = await Promise.all([requestsFinished, gc.then(() => undefined, error => error)])
      const timeouts = results.filter(result => !result).length
      console.log(JSON.stringify({ gc: withGc, resources: 1_400, pins: pins.length, requests: results.length,
        timeouts, gcFailed: gcError !== undefined, hashes, elapsedMs: Math.round(performance.now() - started), maxRequestMs: Math.round(Math.max(...durations)),
        lockHoldsMs: holds.map(value => Math.round(value)) }))
      // Then: work scales with the input, not resources multiplied by pins.
      expect(hashes).toBeLessThan(100_000)
      expect(timeouts).toBe(0)
      expect(gcError).toBeUndefined()
      const persisted: unknown = JSON.parse(readFileSync(join(storeDir, "session-gc.json"), "utf8"))
      for (let i = 0; i < 24; i++) {
        const key = getTranscriptResourceKey({ sessionId: `request-${i}`, configDir: storeDir })
        expect(persisted).toHaveProperty(`resources.${key}.state`, "live")
        expect(persisted).toHaveProperty(`resources.${key}.generation`)
      }
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
