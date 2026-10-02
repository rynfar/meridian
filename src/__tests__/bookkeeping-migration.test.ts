import { afterEach, beforeEach, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { initializeSessionBookkeeping, withBookkeepingWrite } from "../proxy/session/bookkeeping/database"
import { readMapping, readMappingGeneration } from "../proxy/session/bookkeeping/mappings"
import { canonicalizeLocator, resourceKey } from "../proxy/session/bookkeeping/locator"
import {
  parseLegacySidecar, serializeLegacySidecar, STORE_META_KEY, getStoredSessionGeneration,
} from "../proxy/session/bookkeeping/legacyCodec"
import { readJournal, requireBarriers } from "../proxy/session/bookkeeping/maintenanceJournal"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"
import { writeBenchArtifact, buildNodeFixture } from "./fixtures/bookkeeping-support"
import { insertMapping } from "../proxy/session/bookkeeping/resourceImport"

let directory: string
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-migration-"))) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
const migrate = () => migrateBookkeeping(directory, { writersStopped: true })
function source(name: string, value: unknown): void {
  writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600 })
}
function legacyResource(sessionId = "session") {
  const locator = canonicalizeLocator({ configDir: directory, sessionId })
  return { key: resourceKey(locator), locator, state: "live", createdAt: 1, updatedAt: 2, attempts: 0 }
}
function mapping(sessionId = "session") {
  return { claudeSessionId: sessionId, createdAt: 1, lastUsedAt: 2, messageCount: 2,
    messageHashes: ["a", "b"], sdkMessageUuids: [null, "uuid"] }
}

for (const sidecarVersion of [1, 2]) for (const storeVersion of [1, 3]) {
  it(`migrates sidecar v${sidecarVersion} and store v${storeVersion}, preserving fences and digests`, async () => {
    const resource = legacyResource()
    const v1 = { version: 1, resources: { [resource.key]: resource } }
    const sidecar = sidecarVersion === 1 ? v1 : parseLegacySidecar(JSON.stringify(v1))
    source("session-gc.json", sidecar)
    const alias = join(directory, "alias")
    symlinkSync(directory, alias)
    const entry = { unknown: { z: 1, a: 2 }, ...mapping(),
      currentTranscript: { configDir: alias, sessionId: "session" } }
    const current = { ...mapping("current"), generationId: randomUUID() }
    const previous = { ...mapping("previous"), generationId: randomUUID() }
    const priority = storeVersion === 3 ? {
      priorityAssignments: { route: { profileId: "profile", lastHumanTurnDigest: "a".repeat(43),
        lastHumanTurnIssuedAt: 1, mappingKey: "current",
        mappingGeneration: getStoredSessionGeneration(current, "current"),
        generationId: randomUUID(), updatedAt: 2 } },
      priorityAttempts: { route: { blocked: true, blockedTurnDigest: null, blockedTurnIssuedAt: null,
        pendingTurnDigest: null, pendingTurnIssuedAt: null, ownerToken: null,
        generationId: randomUUID(), updatedAt: 2 } },
      priorityRollbackMappings: { route: { mappingKey: "previous",
        mappingGeneration: getStoredSessionGeneration(previous, "previous") } },
    } : {}
    source("sessions.json", { [STORE_META_KEY]: { version: storeVersion, slots: { abcd: 0, dcba: 19 }, ...priority },
      entry, current, previous })
    const result = await migrate()
    expect(result.resources).toBe(1)
    expect(result.mappings).toBe(3)
    expect(readJournal(directory)?.phase).toBe("READY")
    requireBarriers(directory, result.id)
    expect(existsSync(join(directory, "sessions.json"))).toBe(false)
    expect(existsSync(join(directory, "sessions.migrated.json"))).toBe(true)
    const handle = initializeSessionBookkeeping(directory)
    try {
      expect(readMapping(handle.reader, "entry")).toEqual(entry)
      expect(readMappingGeneration(handle.reader, "entry")).toBe(getStoredSessionGeneration(entry, "entry"))
      expect(handle.reader.get("SELECT resource_key FROM mapping_pins")?.resource_key).toBe(resource.key)
      expect(handle.reader.get(
        "SELECT counter FROM fence_slots WHERE namespace='store' AND slot='abcd'",
      )?.counter).toBe(0)
      expect(handle.reader.get("SELECT count(*) AS n FROM priority_assignments")?.n).toBe(storeVersion === 3 ? 1 : 0)
      expect(handle.reader.get("SELECT count(*) AS n FROM priority_attempts")?.n).toBe(storeVersion === 3 ? 1 : 0)
      expect(handle.reader.get("SELECT count(*) AS n FROM priority_rollbacks")?.n).toBe(storeVersion === 3 ? 1 : 0)
    } finally { handle.close() }
    expect(await migrate()).toEqual(result)
  })
}

it("requires explicit operator attestation, not just an empty lease table", async () => {
  await expect(migrateBookkeeping(directory, { writersStopped: false })).rejects.toThrow("--writers-stopped")
  expect(readJournal(directory)).toBeUndefined()
})
it("absent sources are empty, malformed sources are not", async () => {
  expect((await migrate()).mappings).toBe(0)
})
for (const raw of ["", "not json", "[]", '{"entry":{}}']) {
  it(`rejects malformed store ${JSON.stringify(raw)}`, async () => {
    writeFileSync(join(directory, "sessions.json"), raw, { mode: 0o600 })
    await expect(migrate()).rejects.toThrow()
    expect(readFileSync(join(directory, "sessions.json"), "utf8")).toBe(raw)
    expect(readJournal(directory)).toBeUndefined()
    expect(existsSync(join(directory, "session-bookkeeping.sqlite"))).toBe(false)
    expect(existsSync(join(directory, "sessions.json.lock"))).toBe(false)
    expect(existsSync(join(directory, "session-gc.json.lock"))).toBe(false)
    await expect(migrate()).rejects.toThrow()
  })
}
it("refuses a foreign backup without overwriting it, then resumes after operator removal", async () => {
  source("sessions.json", { entry: mapping() })
  source("sessions.migrated.json", { foreign: true })
  await expect(migrate()).rejects.toThrow("foreign backup")
  expect(readFileSync(join(directory, "sessions.migrated.json"), "utf8")).toBe('{"foreign":true}')
  expect(readJournal(directory)?.phase).toBe("IMPORTED")
  rmSync(join(directory, "sessions.migrated.json"))
  expect((await migrate()).mappings).toBe(1)
})
it("ENOSPC seam fails before barriers or journal publication", async () => {
  await expect(migrateBookkeeping(directory, { writersStopped: true, availableBytes: () => 0 }))
    .rejects.toMatchObject({ code: "ENOSPC" })
  expect(readJournal(directory)).toBeUndefined()
  expect(existsSync(join(directory, "sessions.json.lock"))).toBe(false)
})
it("refuses an observable publication owner even with --writers-stopped", async () => {
  const owner = captureProcessIncarnation()
  expect(owner).toBeDefined()
  const resource = legacyResource()
  source("session-gc.json", { version: 1, resources: { [resource.key]: { ...resource,
    activeLeases: { publication: { token: "publication", owner, purpose: "publication", createdAt: 1 } } } } })
  await expect(migrate()).rejects.toThrow("publication")
  expect(readJournal(directory)).toBeUndefined()
})
it("retains full dead incarnations and explicit false lease flags", async () => {
  const captured = captureProcessIncarnation()
  if (!captured) throw new Error("fixture cannot capture incarnation")
  const owner = { ...captured, bootId: "00000000-0000-0000-0000-000000000001" }
  const resource = legacyResource()
  const lease = { token: "dead", owner, executor: owner, executorRecoverable: false, createdAt: 1 }
  source("session-gc.json", { version: 1, resources: {
    [resource.key]: { ...resource, activeLeases: { dead: lease } },
  } })
  await migrate()
  const handle = initializeSessionBookkeeping(directory)
  try {
    const row = handle.reader.get("SELECT * FROM resource_leases")
    expect(JSON.parse(String(row?.owner_json))).toEqual(owner)
    expect(JSON.parse(String(row?.executor_json))).toEqual(owner)
    expect(row?.executor_recoverable).toBe(0)
  } finally { handle.close() }
})
it("never reimports sources after committed publication, even when rows subsequently change", async () => {
  source("sessions.json", { entry: mapping() })
  await migrate()
  const handle = initializeSessionBookkeeping(directory)
  try {
    withBookkeepingWrite(directory, {}, (tx) => insertMapping(tx, "later", mapping("later")))
  } finally { handle.close() }
  expect((await migrate()).mappings).toBe(2)
})
it("a damaged committed database is not treated as an unfinished empty database", async () => {
  await migrate()
  writeFileSync(join(directory, "session-bookkeeping.sqlite"), "broken", { mode: 0o600 })
  await expect(migrate()).rejects.toThrow()
  expect(readFileSync(join(directory, "session-bookkeeping.sqlite"), "utf8")).toBe("broken")
  expect(readJournal(directory)?.phase).toBe("READY")
})
it("imports production-sized 6400 resources / 2500 mappings / about 38 MB", async () => {
  const resources = Object.fromEntries(Array.from({ length: 6400 }, (_, index) => {
    const row = legacyResource(`session-${index}`)
    return [row.key, row]
  }))
  const sidecar = parseLegacySidecar(JSON.stringify({ version: 1, resources }))
  writeFileSync(join(directory, "session-gc.json"), serializeLegacySidecar(sidecar), { mode: 0o600 })
  const entries = Object.fromEntries(Array.from({ length: 2500 }, (_, index) => [
    `mapping-${index}`, { ...mapping(`session-${index}`), messageHashes: ["x".repeat(14100)] },
  ]))
  source("sessions.json", entries)
  const bytes = ["session-gc.json", "sessions.json"]
    .reduce((n, name) => n + Buffer.byteLength(readFileSync(join(directory, name), "utf8")), 0)
  expect(bytes).toBeGreaterThan(37_000_000)
  expect(bytes).toBeLessThan(40_000_000)
  const start = performance.now()
  const result = await migrate()
  const elapsedMs = performance.now() - start
  expect(result.resources).toBe(6400)
  expect(result.mappings).toBe(2500)
  writeBenchArtifact("migration-production-size.json", { bytes, elapsedMs, ...result })
}, 30000)

for (const point of ["PREPARED", "barrier:session-gc.json", "barrier:sessions.json", "BARRIERS",
  "database-prepared", "before-import-commit", "after-import-commit", "IMPORTED",
  "backup-linked:sessions.json", "backup:sessions.json", "READY"]) {
  it(`migration resumes after actual SIGKILL at ${point}`, async () => {
    source("sessions.json", { entry: mapping() })
    const build = await buildNodeFixture("bookkeeping-migrate.ts", "migrate.mjs", directory)
    expect(build.success).toBe(true)
    const child = spawnSync("node", [join(directory, "migrate.mjs"), directory], {
      env: { ...process.env, MERIDIAN_BOOKKEEPING_TEST_CRASH: point }, encoding: "utf8", timeout: 15000,
    })
    expect(child.error).toBeUndefined()
    expect(child.stderr).toBe("")
    expect(child.signal).toBe("SIGKILL")
    const journal = readJournal(directory)
    expect(journal).toBeDefined()
    const result = await migrate()
    expect(result.id).toBe(journal!.id)
    expect(result.mappings).toBe(1)
    const handle = initializeSessionBookkeeping(directory)
    try {
      expect(readMappingGeneration(handle.reader, "entry")).toBe(getStoredSessionGeneration(mapping(), "entry"))
    } finally { handle.close() }
  }, 20000)
}

it("a source that disappears after PREPARED is not silently imported as empty", async () => {
  source("sessions.json", { entry: mapping() })
  expect((await buildNodeFixture("bookkeeping-migrate.ts", "migrate.mjs", directory)).success).toBe(true)
  const child = spawnSync("node", [join(directory, "migrate.mjs"), directory], {
    env: { ...process.env, MERIDIAN_BOOKKEEPING_TEST_CRASH: "PREPARED" }, timeout: 15000,
  })
  expect(child.signal).toBe("SIGKILL")
  rmSync(join(directory, "sessions.json"))
  await expect(migrate()).rejects.toThrow("disappeared after PREPARED")
  expect(readJournal(directory)?.phase).toBe("PREPARED")
})
