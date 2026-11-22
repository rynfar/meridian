// Adapted from Máté Rémiás (@materemias)'s synthetic reproduction in #1303.
// Run with Bun on Linux /dev/shm tmpfs. No SDK, credentials or model calls.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  attachSharedTranscriptLocator,
  lookupSharedSessionResult,
  setSessionStoreDir,
  storeSharedSession,
  type StoredSession,
} from "../src/proxy/sessionStore"

assert.equal(process.platform, "linux", "this proof requires Linux tmpfs")
assert.equal(statfsSync("/dev/shm").type, 0x01021994, "/dev/shm must be tmpfs")
const root = mkdtempSync("/dev/shm/meridian-locator-noop-")
const originalHome = process.env.HOME
process.env.HOME = root
const results: Array<{
  sessions: number
  seedBytes: number
  completeStoreReplacements: number
  completeStorePayloadBytes: number
  identicalLocatorReplacements: number
  identicalLocatorPayloadBytes: number
  identicalLocatorFileContentsUnchanged: boolean
  identicalLocatorGenerationUnchanged: boolean
  identicalLocatorFileIdentityUnchanged: boolean
  seededSessionHash: string
}> = []

try {
  for (const count of [100, 900]) {
    const dir = join(root, `fixture-${count}`)
    setSessionStoreDir(dir)
    await storeSharedSession("bootstrap", "bootstrap-sdk")
    const path = join(dir, "sessions.json")
    const fixture: Record<string, StoredSession> = {}
    const hashes = Array.from({ length: 128 }, (_, n) => n.toString(16).padStart(64, "0"))
    for (let i = 0; i < count; i++) {
      fixture[`session-${i}`] = {
        claudeSessionId: `sdk-${i}`,
        revision: 1,
        generationId: `synthetic-generation-${i}`,
        createdAt: 1,
        lastUsedAt: 1,
        messageCount: hashes.length,
        lineageHash: "a".repeat(64),
        messageHashes: hashes,
        sdkMessageUuids: Array(hashes.length).fill(null),
      }
    }
    writeFileSync(path, JSON.stringify(fixture), { mode: 0o600 })
    const seedBytes = statSync(path).size
    let replacements = 0
    let replacementBytes = 0
    for (let i = 0; i < 20; i++) {
      const before = statSync(path)
      assert.notEqual(await storeSharedSession("session-0", "sdk-0"), false)
      const after = statSync(path)
      if (after.ino !== before.ino) {
        replacements++
        replacementBytes += after.size
      }
    }
    assert.equal(replacements, 20, "genuine mutations must still publish")
    const locator = {
      sessionId: "sdk-0",
      configDir: join(dir, "synthetic-sdk-config"),
      projectDir: dir,
    }
    const firstGeneration = await attachSharedTranscriptLocator("session-0", "sdk-0", locator)
    assert.notEqual(firstGeneration, false)
    if (firstGeneration === false) throw new Error("fixture attachment failed")
    const identicalContents = readFileSync(path)
    const originalStat = statSync(path, { bigint: true })
    let identicalReplacements = 0
    let identicalReplacementBytes = 0
    for (let i = 0; i < 5; i++) {
      const before = statSync(path)
      assert.equal(await attachSharedTranscriptLocator("session-0", "sdk-0", { ...locator }, firstGeneration), firstGeneration)
      assert.deepEqual(readFileSync(path), identicalContents)
      const after = statSync(path)
      if (after.ino !== before.ino) {
        identicalReplacements++
        identicalReplacementBytes += after.size
      }
    }
    const lookup = lookupSharedSessionResult("session-0")
    assert.equal(lookup.status, "found")
    if (lookup.status === "found") assert.equal(lookup.generation, firstGeneration)
    const finalStat = statSync(path, { bigint: true })
    results.push({
      sessions: count,
      seedBytes,
      completeStoreReplacements: replacements,
      completeStorePayloadBytes: replacementBytes,
      identicalLocatorReplacements: identicalReplacements,
      identicalLocatorPayloadBytes: identicalReplacementBytes,
      identicalLocatorFileContentsUnchanged: true,
      identicalLocatorGenerationUnchanged: true,
      identicalLocatorFileIdentityUnchanged: originalStat.ino === finalStat.ino
        && originalStat.dev === finalStat.dev && originalStat.size === finalStat.size
        && originalStat.mtimeNs === finalStat.mtimeNs && originalStat.ctimeNs === finalStat.ctimeNs,
      seededSessionHash: createHash("sha256").update(identicalContents).digest("hex"),
    })
  }
  console.log(JSON.stringify({
    runtime: `Bun ${Bun.version}`,
    platform: process.platform,
    architecture: process.arch,
    filesystem: "Linux tmpfs /dev/shm; synthetic metadata only",
    metric: "Replacement-file payload sizes, NOT physical SSD/NAND writes; lock-file work is excluded",
    mutationsPerFixture: 20,
    identicalLocatorCallsPerFixture: 5,
    results,
  }, null, 2))
  // The same assertion fails unchanged main and passes the correction. Emit
  // both fixture measurements first, so a baseline failure retains all facts.
  for (const result of results) {
    assert.equal(result.identicalLocatorReplacements, 0, `${result.sessions} sessions: identical locator republished`)
    assert.equal(result.identicalLocatorPayloadBytes, 0)
    assert.equal(result.identicalLocatorFileIdentityUnchanged, true)
  }
} finally {
  setSessionStoreDir(null)
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(root, { recursive: true, force: true })
}
