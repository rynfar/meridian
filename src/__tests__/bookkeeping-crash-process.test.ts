import { afterAll, beforeAll, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { exportBookkeepingJson } from "../proxy/session/bookkeeping/exportJson"
import { abortBookkeepingMigration } from "../proxy/session/bookkeeping/abortMigration"
import { canonicalizeLocator, resourceKey } from "../proxy/session/bookkeeping/locator"
import { initializeSessionBookkeeping } from "../proxy/session/bookkeeping/database"
import { readMappingGeneration } from "../proxy/session/bookkeeping/mappings"
import {
  getStoredSessionGeneration, parseLegacySidecar, parseLegacyStoreForMaintenance, STORE_META_KEY,
} from "../proxy/session/bookkeeping/legacyCodec"
import { readJournal, requireBarriers } from "../proxy/session/bookkeeping/maintenanceJournal"
import { buildNodeFixture } from "./fixtures/bookkeeping-support"
import { readExportJournal } from "../proxy/session/bookkeeping/exportJournal"
import { legacyInput, expectLegacyInput } from "./fixtures/bookkeeping-export-oracle"
import {
  enrichFixture, richArchivedSnapshot, richSnapshot, uninterruptedRichSnapshot,
} from "./fixtures/bookkeeping-rich-fixture"

for (const cut of ["PREPARED", "linked:session-gc.migrated.json", "moved:session-gc.migrated.json",
  "linked:sessions.migrated.json", "moved:sessions.migrated.json", "linked:database", "moved:database",
  "linked:session-bookkeeping-export.json", "moved:session-bookkeeping-export.json",
  "linked:session-bookkeeping-migration.json", "moved:session-bookkeeping-migration.json", "ARCHIVED"]) {
  it(`SIGKILL cycle archive ${cut} preserves export digests`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-cycle-")))
    try {
      seed(directory, 2, 3)
      enrichFixture(directory)
      const first = await migrateBookkeeping(directory, { writersStopped: true })
      const expected = richSnapshot(directory)
      expect(first.resources).toBe(2)
      expect(first.mappings).toBe(3)
      expect(expected.counts.resources).toBe(first.resources)
      expect(expected.counts.mappings).toBe(first.mappings)
      const down = exportBookkeepingJson(directory)
      expect(down.documents).toEqual(expected.documents)
      expect(down.resources).toBe(first.resources)
      expect(down.mappings).toBe(first.mappings)
      expect(richArchivedSnapshot(directory, down)).toEqual(expected)
      const point = cut.replace("database", `session-bookkeeping.sqlite.exported-${down.id}`)
      child("migrate", directory, `cycle:${point}`)
      const up = await migrateBookkeeping(directory, { writersStopped: true })
      expect(up.id).not.toBe(first.id)
      expect(up.resources).toBe(first.resources)
      expect(up.mappings).toBe(first.mappings)
      expect(richSnapshot(directory)).toEqual(expected)
      expect(existsSync(join(directory, "bookkeeping-cycles", first.id,
        "session-bookkeeping-migration.json"))).toBe(true)
      const again = exportBookkeepingJson(directory)
      expect(again.documents).toEqual(down.documents)
      expect(again.resources).toBe(up.resources)
      expect(again.mappings).toBe(up.mappings)
      expect(richArchivedSnapshot(directory, again)).toEqual(expected)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 20000)
}

let buildDirectory: string
beforeAll(async () => {
  buildDirectory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-crash-build-")))
  const build = await buildNodeFixture("bookkeeping-transition.ts", "transition.mjs", buildDirectory)
  expect(build.success).toBe(true)
})
afterAll(() => { rmSync(buildDirectory, { recursive: true, force: true }) })
function child(action: string, directory: string, point: string): void {
  const result = spawnSync("node", [join(buildDirectory, "transition.mjs"), action, directory], {
    env: { ...process.env, MERIDIAN_BOOKKEEPING_TEST_CRASH: point }, encoding: "utf8", timeout: 15000,
  })
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe("")
  expect(result.status).toBeNull()
  expect(result.signal).toBe("SIGKILL")
}
function seed(directory: string, sidecarVersion: number, storeVersion: number) {
  const locator = canonicalizeLocator({ configDir: directory, sessionId: "session" })
  const key = resourceKey(locator)
  const resource = { key, locator, state: "live", createdAt: 1, updatedAt: 2, attempts: 0 }
  const v1 = { version: 1, resources: { [key]: resource } }
  const sidecar = sidecarVersion === 1 ? v1 : parseLegacySidecar(JSON.stringify(v1))
  const entry = { unknown: { b: 1, a: 2 }, claudeSessionId: "session", createdAt: 1, lastUsedAt: 2,
    messageCount: 1, messageHashes: [], sdkMessageUuids: [null, "uuid"] }
  const priority = storeVersion === 3
    ? { priorityAssignments: {}, priorityAttempts: {}, priorityRollbackMappings: {} } : {}
  writeFileSync(join(directory, "session-gc.json"), JSON.stringify(sidecar), { mode: 0o600 })
  writeFileSync(join(directory, "sessions.json"), JSON.stringify({
    [STORE_META_KEY]: { version: storeVersion, slots: { abcd: 0 }, ...priority }, entry,
  }), { mode: 0o600 })
  return { key, entry }
}

const migrationPoints = ["PREPARED", "barrier:session-gc.json", "barrier:sessions.json", "BARRIERS",
  "database-prepared", "before-import-commit", "after-import-commit", "IMPORTED",
  "backup-linked:session-gc.json", "backup:session-gc.json", "backup-linked:sessions.json", "backup:sessions.json",
  "migration:checkpoint", "migration:closed", "READY", "retire:intent:sessions.json", "retire:captured:sessions.json", "retire:deleted:sessions.json"]
const exportPoints = ["PREPARED", "staged:session-gc.json", "staged:sessions.json", "STAGED",
  "linked:session-gc.json", "moved:session-gc.json", "linked:sessions.json", "moved:sessions.json", "INSTALLED",
  "checkpoint", "closed", "CHECKPOINTED", "linked:session-bookkeeping.sqlite", "moved:session-bookkeeping.sqlite",
  "linked:session-bookkeeping.sqlite-wal", "moved:session-bookkeeping.sqlite-wal",
  "linked:session-bookkeeping.sqlite-shm", "moved:session-bookkeeping.sqlite-shm",
  "ARCHIVED", "EXPORTED", "released:session-gc.json", "released:sessions.json",
  "barrier:intent:session-gc.json", "barrier:intent:sessions.json",
  "barrier:captured:session-gc.json", "barrier:captured:sessions.json",
  "barrier:releasing:session-gc.json", "barrier:releasing:sessions.json"]

for (const sidecarVersion of [1, 2] as const) for (const storeVersion of [1, 3]) {
  for (const point of migrationPoints) it(`SIGKILL migration ${sidecarVersion}/${storeVersion} ${point}`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-crash-migrate-")))
    try {
      const { entry, key } = seed(directory, sidecarVersion, storeVersion)
      enrichFixture(directory, sidecarVersion)
      const original = legacyInput(directory)
      expect(JSON.parse(readFileSync(join(directory, "session-gc.json"), "utf8")).version).toBe(sidecarVersion)
      const expected = await uninterruptedRichSnapshot(directory)
      expect(expected.counts.schema_meta).toBe(1)
      expect(expected.counts.resource_leases).toBe(1)
      expect(expected.counts.fence_slots).toBeGreaterThanOrEqual(4)
      for (const table of ["priority_assignments", "priority_attempts", "priority_rollbacks"]) {
        expect(expected.counts[table]).toBe(storeVersion === 3 ? 1 : 0)
      }
      child("migrate", directory, point)
      const result = await migrateBookkeeping(directory, { writersStopped: true })
      expect(result.resources).toBe(2)
      expect(result.mappings).toBe(3)
      expect(richSnapshot(directory)).toEqual(expected)
      requireBarriers(directory, result.id)
      const handle = initializeSessionBookkeeping(directory)
      try {
        expect(readMappingGeneration(handle.reader, "entry")).toBe(getStoredSessionGeneration(entry, "entry"))
        expect(handle.reader.get("SELECT generation FROM resources WHERE key=?", key)?.generation).toBe(`r:${key}:1`)
      } finally { handle.close() }
      const exported = exportBookkeepingJson(directory)
      expectLegacyInput(directory, original)
      expect(exported.documents).toEqual(expected.documents)
      expect(richArchivedSnapshot(directory, exported)).toEqual(expected)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 20000)
  for (const point of exportPoints) it(`SIGKILL export ${sidecarVersion}/${storeVersion} ${point}`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-crash-export-")))
    try {
      const { entry, key } = seed(directory, sidecarVersion, storeVersion)
      enrichFixture(directory)
      const original = legacyInput(directory)
      await migrateBookkeeping(directory, { writersStopped: true })
      const expected = richSnapshot(directory)
      child("export", directory, point.startsWith("barrier:") ? point : `export:${point}`)
      expect(() => initializeSessionBookkeeping(directory)).toThrow("export in progress or completed")
      const result = exportBookkeepingJson(directory)
      expect(result.phase).toBe("EXPORTED")
      expectLegacyInput(directory, original)
      expect(result.documents).toEqual(expected.documents)
      const store = parseLegacyStoreForMaintenance(readFileSync(join(directory, "sessions.json"), "utf8"))
      expect(JSON.stringify(store.sessions.entry)).toBe(JSON.stringify(entry))
      expect(store.meta.version).toBe(storeVersion as 1 | 3)
      expect(store.meta.slots.abcd).toBe(0)
      const sidecar = parseLegacySidecar(readFileSync(join(directory, "session-gc.json"), "utf8"))
      expect(sidecar.resources[key]?.generation).toBe(`r:${key}:1`)
      expect(existsSync(join(directory, "session-bookkeeping.sqlite"))).toBe(false)
      expect(existsSync(join(directory, "sessions.json.lock"))).toBe(false)
      expect(existsSync(join(directory, "session-gc.json.lock"))).toBe(false)
      await migrateBookkeeping(directory, { writersStopped: true })
      expect(richSnapshot(directory)).toEqual(expected)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 20000)
}
for (const point of ["ABORTING", "released:session-gc.json", "released:sessions.json", "ABORTED"]) {
  it(`SIGKILL abort ${point}`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-crash-abort-")))
    try {
      writeFileSync(join(directory, "sessions.json"), "{}", { mode: 0o600 })
      child("migrate", directory, "BARRIERS")
      // Materialize the historical preflight bug's malformed protected input.
      // New migrations reject it before any barrier; abort must still recover old states.
      writeFileSync(join(directory, "sessions.json"), "invalid", { mode: 0o600 })
      child("abort", directory, `abort:${point}`)
      abortBookkeepingMigration(directory)
      expect(readJournal(directory)?.phase).toBe("ABORTED")
      expect(readFileSync(join(directory, "sessions.json"), "utf8")).toBe("invalid")
      expect(existsSync(join(directory, "session-bookkeeping.sqlite"))).toBe(false)
      expect(existsSync(join(directory, "sessions.json.lock"))).toBe(false)
      expect(existsSync(join(directory, "session-gc.json.lock"))).toBe(false)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 20000)
}

for (const target of ["sessions.json", "archive"]) it(`resume refuses modified ${target}`, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-crash-corrupt-")))
  try {
    seed(directory, 2, 3)
    const migration = await migrateBookkeeping(directory, { writersStopped: true })
    child("export", directory, target === "archive" ? "export:ARCHIVED" : "export:INSTALLED")
    const journal = readExportJournal(directory)!
    const name = target === "archive" ? `session-bookkeeping.sqlite.exported-${journal.id}` : target
    writeFileSync(join(directory, name), "foreign", { mode: 0o600 })
    expect(() => exportBookkeepingJson(directory)).toThrow("digest/size mismatch")
    requireBarriers(directory, migration.id)
    expect(readFileSync(join(directory, name), "utf8")).toBe("foreign")
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 20000)
