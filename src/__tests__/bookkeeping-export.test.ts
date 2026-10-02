import { afterEach, beforeEach, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { createHash } from "node:crypto"
import Database from "libsql"
import { pathToFileURL } from "node:url"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { exportBookkeepingJson } from "../proxy/session/bookkeeping/exportJson"
import { abortBookkeepingMigration } from "../proxy/session/bookkeeping/abortMigration"
import { initializeSessionBookkeeping, withBookkeepingWrite } from "../proxy/session/bookkeeping/database"
import { createMaintenanceDatabase } from "../proxy/session/bookkeeping/connection"
import { openForMaintenance } from "../proxy/session/bookkeeping/maintenance"
import { acquireMaintenanceGuard } from "../proxy/session/bookkeeping/guard"
import { initializeProxyBookkeeping } from "../proxy/session/bookkeeping/runtime"
import { setSessionStoreDir } from "../proxy/sessionStore"
import { insertMapping } from "../proxy/session/bookkeeping/resourceImport"
import { canonicalizeLocator, resourceKey } from "../proxy/session/bookkeeping/locator"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"
import { insertResourceLease } from "../proxy/session/bookkeeping/resources"
import {
  getStoredSessionGeneration, parseLegacySidecar, parseLegacyStoreForMaintenance, STORE_META_KEY,
} from "../proxy/session/bookkeeping/legacyCodec"
import { barrierBytes, observeSource, readJournal, requireBarriers, saveJournal, SOURCE_NAMES, writeDurably } from "../proxy/session/bookkeeping/maintenanceJournal"
import { writeBenchArtifact } from "./fixtures/bookkeeping-support"
import { validateBookkeepingSchema } from "../proxy/session/bookkeeping/schema"
import { enrichFixture } from "./fixtures/bookkeeping-rich-fixture"
import { legacyInput, expectLegacyInput } from "./fixtures/bookkeeping-export-oracle"
import { inspectBookkeeping } from "../proxy/session/bookkeeping/inspect"

let directory: string
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-export-"))) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
const migrate = () => migrateBookkeeping(directory, { writersStopped: true })
const entry = () => ({ unknown: { z: 1, a: 2 }, claudeSessionId: "session", createdAt: 1, lastUsedAt: 2,
  messageCount: 2, sdkMessageUuids: [null, "uuid"], messageHashes: [] })
function source(name: string, value: unknown): void {
  writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600 })
}
function historicalBarriers(database = false): void {
  const guard = acquireMaintenanceGuard(directory)
  try {
    const id = randomUUID(), sources = SOURCE_NAMES.map(name => observeSource(directory, name).identity)
    saveJournal(directory, { format: "meridian-bookkeeping-migration", version: 1, targetVersion: 1,
      id, phase: "BARRIERS", sources, finalSources: sources })
    for (const name of SOURCE_NAMES) writeDurably(join(directory, name + ".lock"), barrierBytes(id))
    if (database) createMaintenanceDatabase(directory, guard)
  } finally { guard.close() }
}
function resource(sessionId = "session") {
  const locator = canonicalizeLocator({ configDir: directory, sessionId })
  return { key: resourceKey(locator), locator, state: "live", createdAt: 1, updatedAt: 2, attempts: 0 }
}

it("exports the rich legacy input, including entry digests, without leaking SQL columns", async () => {
  const row = resource()
  source("session-gc.json", { version: 1, resources: { [row.key]: row } })
  source("sessions.json", { [STORE_META_KEY]: { version: 3, slots: {}, priorityAssignments: {},
    priorityAttempts: {}, priorityRollbackMappings: {} }, entry: entry() })
  enrichFixture(directory)
  const expected = legacyInput(directory)
  await migrate()
  exportBookkeepingJson(directory)
  expectLegacyInput(directory, expected)
})

it("never restores raw resource payload after a row-version change, even when fields return to their old values", async () => {
  const row = resource()
  source("session-gc.json", { version: 1, resources: { [row.key]: { ...row, extension: "import-only" } } })
  await migrate()
  const handle = initializeSessionBookkeeping(directory)
  try {
    withBookkeepingWrite(directory, {}, (tx) => {
      tx.run("UPDATE resources SET state='retired',row_version=row_version+1 WHERE key=?", row.key)
      tx.run("UPDATE resources SET state='live',row_version=row_version+1 WHERE key=?", row.key)
    })
  } finally { handle.close() }
  exportBookkeepingJson(directory)
  const exported = JSON.parse(readFileSync(join(directory, "session-gc.json"), "utf8")).resources[row.key]
  expect(exported).toEqual({ ...row, generation: `r:${row.key}:1` })
  expect(Object.hasOwn(exported, "rowVersion")).toBe(false)
})

for (const version of [1, 3] as const) it(`exports current state to store v${version}, not migrated backups`, async () => {
  const row = resource()
  const captured = captureProcessIncarnation()!
  const owner = { ...captured, bootId: "00000000-0000-0000-0000-000000000001" }
  const lease = { token: "dead", owner, executor: owner, executorRecoverable: false, createdAt: 1 }
  source("session-gc.json", { version: 1, resources: { [row.key]: { ...row, activeLeases: { dead: lease } } } })
  const previous = { ...entry(), generationId: randomUUID() }
  const current = { ...entry(), generationId: randomUUID() }
  const priority = version === 3 ? {
    priorityAssignments: { route: { profileId: "p", lastHumanTurnDigest: "a".repeat(43),
      lastHumanTurnIssuedAt: 1, mappingKey: "current", mappingGeneration: getStoredSessionGeneration(current, "current"),
      generationId: randomUUID(), updatedAt: 2 } },
    priorityAttempts: { route: { blocked: true, blockedTurnDigest: null, blockedTurnIssuedAt: null,
      pendingTurnDigest: null, pendingTurnIssuedAt: null, ownerToken: null, generationId: randomUUID(), updatedAt: 2 } },
    priorityRollbackMappings: { route: { mappingKey: "previous",
      mappingGeneration: getStoredSessionGeneration(previous, "previous") } },
  } : {}
  source("sessions.json", { [STORE_META_KEY]: { version, slots: { abcd: 0 }, ...priority },
    entry: entry(), previous, current })
  await migrate()
  const handle = initializeSessionBookkeeping(directory)
  try { withBookkeepingWrite(directory, {}, (tx) => insertMapping(tx, "new", entry())) }
  finally { handle.close() }
  const result = exportBookkeepingJson(directory)
  expect(result.phase).toBe("EXPORTED")
  const store = parseLegacyStoreForMaintenance(readFileSync(join(directory, "sessions.json"), "utf8"))
  expect(store.sessions.entry).toEqual(entry())
  expect(JSON.stringify(store.sessions.entry)).toBe(JSON.stringify(entry()))
  expect(store.sessions.new).toEqual(entry())
  expect(store.meta.version).toBe(version)
  expect(store.meta.slots.abcd).toBe(0)
  if (store.meta.version === 3) {
    expect(store.meta.priorityAssignments).toEqual(priority.priorityAssignments!)
    expect(store.meta.priorityAttempts).toEqual(priority.priorityAttempts!)
    expect(store.meta.priorityRollbackMappings).toEqual(priority.priorityRollbackMappings!)
  }
  const sidecar = parseLegacySidecar(readFileSync(join(directory, "session-gc.json"), "utf8"))
  expect(sidecar.resources[row.key]?.activeLeases?.dead).toEqual(lease)
  expect(sidecar.resources[row.key]?.generation).toBe(`r:${row.key}:1`)
  expect(existsSync(join(directory, "session-bookkeeping.sqlite"))).toBe(false)
  expect(existsSync(join(directory, `session-bookkeeping.sqlite.exported-${result.id}`))).toBe(true)
  expect(result.archive?.some((file) => file.name === "session-bookkeeping.sqlite")).toBe(true)
  for (const file of result.archive!) {
    const archived = readFileSync(join(directory, `${file.name}.exported-${result.id}`))
    expect(archived.length).toBe(file.bytes)
    expect(createHash("sha256").update(archived).digest("hex")).toBe(file.digest)
  }
  const archivePath = join(directory, `session-bookkeeping.sqlite.exported-${result.id}`)
  const archived = new Database(`${pathToFileURL(archivePath).href}?mode=ro&immutable=1`)
  try {
    validateBookkeepingSchema(archived)
    expect(archived.prepare("SELECT migration_id FROM schema_meta").get()).toMatchObject({ migration_id: result.migrationId })
    expect(() => archived.exec("DELETE FROM mappings")).toThrow()
  } finally { archived.close() }
  for (const name of ["sessions.json.lock", "session-gc.json.lock"]) expect(existsSync(join(directory, name))).toBe(false)
  expect(() => initializeSessionBookkeeping(directory)).toThrow("export in progress or completed")
  expect(exportBookkeepingJson(directory)).toEqual(result)
  source("sessions.json", { laterLegacyWrite: entry() })
  expect(exportBookkeepingJson(directory)).toEqual(result)
})

it("refuses export with a shared holder or a live physical-executor incarnation", async () => {
  const row = resource()
  source("session-gc.json", { version: 1, resources: { [row.key]: row } })
  await migrate()
  const handle = initializeSessionBookkeeping(directory)
  try {
    expect(() => exportBookkeepingJson(directory)).toThrow("maintenance guard is held")
    const owner = captureProcessIncarnation()!
    withBookkeepingWrite(directory, {}, (tx) => insertResourceLease(tx, row.key,
      { token: "alive", owner, executor: owner, executorRecoverable: false, createdAt: 1 }))
  } finally { handle.close() }
  const owner = captureProcessIncarnation()!
  expect(() => exportBookkeepingJson(directory)).toThrow(/(?:live|indeterminate) process at/)
  expect(() => exportBookkeepingJson(directory)).toThrow(`${row.key}/lease/alive/owner`)
  expect(() => exportBookkeepingJson(directory)).toThrow(`pid=${owner.pid} startId=${JSON.stringify(owner.startId)}`)
  expect(existsSync(join(directory, "session-bookkeeping-export.json"))).toBe(false)
})

it("does not overwrite foreign JSON or remove foreign barriers", async () => {
  await migrate()
  source("sessions.json", { foreign: true })
  expect(() => exportBookkeepingJson(directory)).toThrow("foreign export destination")
  rmSync(join(directory, "sessions.json"))
  source("sessions.json.lock", { foreign: true })
  expect(() => exportBookkeepingJson(directory)).toThrow("foreign barrier")
  expect(readFileSync(join(directory, "sessions.json.lock"), "utf8")).toBe('{"foreign":true}')
})

it("aborts historical malformed pre-database sources and keeps originals untouched", async () => {
  source("sessions.json", { invalid: {} })
  historicalBarriers()
  expect(readJournal(directory)?.phase).toBe("BARRIERS")
  expect(existsSync(join(directory, "session-bookkeeping.sqlite"))).toBe(false)
  abortBookkeepingMigration(directory)
  expect(readJournal(directory)?.phase).toBe("ABORTED")
  expect(readFileSync(join(directory, "sessions.json"), "utf8")).toBe('{"invalid":{}}')
  expect(existsSync(join(directory, "sessions.json.lock"))).toBe(false)
  expect(existsSync(join(directory, "session-gc.json.lock"))).toBe(false)
  abortBookkeepingMigration(directory)
  source("sessions.json", { entry: entry() })
  const next = await migrate()
  expect(next.mappings).toBe(1)
})
it("refuses abort of committed authority or another operation's barrier", async () => {
  source("sessions.json", { invalid: {} })
  historicalBarriers()
  source("sessions.json.lock", { foreign: true })
  expect(() => abortBookkeepingMigration(directory)).toThrow("foreign barrier")
  expect(readJournal(directory)?.phase).toBe("BARRIERS")
  expect(readFileSync(join(directory, "sessions.json.lock"), "utf8")).toBe('{"foreign":true}')
})
it("aborts a historical failed import only after proving its PREPARED database exactly empty", async () => {
  source("sessions.json", { "bad\u0000key": entry() })
  historicalBarriers(true)
  const bytes = readFileSync(join(directory, "sessions.json"), "utf8")
  abortBookkeepingMigration(directory)
  expect(readJournal(directory)?.phase).toBe("ABORTED")
  expect(readFileSync(join(directory, "sessions.json"), "utf8")).toBe(bytes)
  expect(existsSync(join(directory, "session-bookkeeping.sqlite"))).toBe(false)
  expect(existsSync(join(directory, "sessions.json.lock"))).toBe(false)
  const saved = process.env.MERIDIAN_BOOKKEEPING
  setSessionStoreDir(directory)
  process.env.MERIDIAN_BOOKKEEPING = "json"
  try { expect(await initializeProxyBookkeeping()).toBeUndefined() } finally {
    setSessionStoreDir(null)
    if (saved === undefined) delete process.env.MERIDIAN_BOOKKEEPING
    else process.env.MERIDIAN_BOOKKEEPING = saved
  }
})
it("never aborts a nonempty PREPARED database or drops its fences", () => {
  source("sessions.json", { entry: entry() })
  historicalBarriers(true)
  const guard = acquireMaintenanceGuard(directory)
  const handle = openForMaintenance(directory, { expectPhase: "PREPARED", guard })
  try { withBookkeepingWrite(directory, {}, tx => tx.run("INSERT INTO fence_slots VALUES('store','owned',1)")) }
  finally { handle.close(); guard.close() }
  expect(() => abortBookkeepingMigration(directory)).toThrow("provably empty")
  expect(readJournal(directory)?.phase).toBe("BARRIERS")
  expect(existsSync(join(directory, "session-bookkeeping.sqlite"))).toBe(true)
  requireBarriers(directory, readJournal(directory)!.id)
})
it("refuses abort after a successful migration", async () => {
  const result = await migrate()
  expect(() => abortBookkeepingMigration(directory)).toThrow("BARRIERS migration journal")
  requireBarriers(directory, result.id)
  const handle = initializeSessionBookkeeping(directory)
  handle.close()
})

it("refuses silently dropping priority rows under v1 metadata", async () => {
  const result = await migrate()
  const handle = initializeSessionBookkeeping(directory)
  try {
    withBookkeepingWrite(directory, {}, (tx) => {
      tx.run("INSERT INTO priority_attempts VALUES(?,1,NULL,NULL,NULL,NULL,NULL,?,1)", "route", randomUUID())
    })
  } finally { handle.close() }
  expect(() => exportBookkeepingJson(directory)).toThrow("discard priority rows")
  requireBarriers(directory, result.id)
  expect(existsSync(join(directory, "session-bookkeeping-export.json"))).toBe(false)
})

it("exports production-size 6400 resources / 2500 mappings / about 38 MB", async () => {
  const resources = Object.fromEntries(Array.from({ length: 6400 }, (_, i) => {
    const row = resource(`session-${i}`)
    return [row.key, row]
  }))
  source("session-gc.json", { version: 1, resources })
  source("sessions.json", Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [
    `mapping-${i}`, { ...entry(), messageHashes: ["x".repeat(14100)] },
  ])))
  await migrate()
  const start = performance.now()
  const sizes = inspectBookkeeping(directory).sizes
  expect(sizes.wal).toBe(0)
  expect(sizes.main).toBeGreaterThan(37_000_000)
  const result = exportBookkeepingJson(directory)
  const elapsedMs = performance.now() - start
  const bytes = result.documents.reduce((n, doc) => n + doc.bytes, 0)
  expect(result.resources).toBe(6400)
  expect(result.mappings).toBe(2500)
  expect(bytes).toBeGreaterThan(37_000_000)
  expect(bytes).toBeLessThan(40_000_000)
  writeBenchArtifact("export-production-size.json", { bytes, elapsedMs, ...result })
}, 30000)
