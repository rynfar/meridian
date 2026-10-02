import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureProcessIncarnation } from "../../proxy/session/processIncarnation"
import { canonicalizeLocator, resourceKey } from "../../proxy/session/bookkeeping/locator"
import {
  getStoredSessionGeneration, parseLegacySidecar, parseLegacyStoreForMaintenance, serializeLegacySidecar,
  serializeLegacyStore,
} from "../../proxy/session/bookkeeping/legacyCodec"
import { initializeSessionBookkeeping, withBookkeepingRead } from "../../proxy/session/bookkeeping/database"
import { snapshotForExport } from "../../proxy/session/bookkeeping/exportSnapshot"
import { digestBytes, SOURCE_NAMES } from "../../proxy/session/bookkeeping/maintenanceJournal"
import Database from "libsql"
import { pathToFileURL } from "node:url"
import { fileIdentity } from "../../proxy/session/bookkeeping/exportJournal"
import type { ExportJournal } from "../../proxy/session/bookkeeping/exportJournal"
import { validateBookkeepingSchema } from "../../proxy/session/bookkeeping/schema"
import { migrateBookkeeping } from "../../proxy/session/bookkeeping/migration"

const TABLES = ["schema_meta", "resources", "resource_leases", "fence_slots", "mappings", "mapping_history",
  "mapping_pins", "priority_assignments", "priority_attempts", "priority_rollbacks", "bookkeeping_counts", "legacy_exports"]

export function enrichFixture(directory: string, sidecarVersion: 1 | 2 = 2): void {
  const sidecar = parseLegacySidecar(readFileSync(join(directory, "session-gc.json"), "utf8"))
  const store = parseLegacyStoreForMaintenance(readFileSync(join(directory, "sessions.json"), "utf8"))
  const captured = captureProcessIncarnation()
  if (!captured) throw new Error("rich fixture requires incarnation")
  const owner = { ...captured, bootId: "00000000-0000-0000-0000-000000000001" }
  const first = Object.values(sidecar.resources)[0]!
  first.rowVersion = Number.MAX_SAFE_INTEGER
  first.activeLeases = { dead: { token: "dead", owner, executor: owner, executorRecoverable: false, createdAt: 1 } }
  let locator = canonicalizeLocator({ configDir: directory, projectDir: directory, sessionId: "retired" })
  let key = resourceKey(locator)
  for (let suffix = 1; key.slice(0, 4) === first.key.slice(0, 4); suffix++) {
    locator = canonicalizeLocator({ configDir: directory, projectDir: directory, sessionId: `retired-${suffix}` })
    key = resourceKey(locator)
  }
  sidecar.resources[key] = { key, locator, state: "retired", generation: `r:${key}:7`,
    createdAt: 1, updatedAt: 2, attempts: 1, nextAttemptAt: 99, lastError: "retry" }
  sidecar.meta.fenceSlots[key.slice(0, 4)] = 7
  sidecar.meta.fenceSlots.abcd = Math.max(sidecar.meta.fenceSlots.abcd ?? 0, 9)
  sidecar.meta.fenceSlots.dcba = Math.max(sidecar.meta.fenceSlots.dcba ?? 0, 3)
  const common = { claudeSessionId: "history", createdAt: 1, lastUsedAt: 2, messageCount: 2,
    sdkMessageUuids: [null, "uuid"], messageHashes: [] }
  const previous = { ...common, generationId: randomUUID(), unknown: { b: 1, a: 2 }, nullableExtension: null }
  const current = { ...common, generationId: randomUUID(), unknown: { b: 1, a: 2 } }
  store.sessions.previous = previous
  store.sessions.current = current
  store.meta.slots.dcba = 12
  store.meta.slots.abcd = 0
  if (store.meta.version === 3) {
    store.meta.priorityAssignments.route = { profileId: "p", lastHumanTurnDigest: "a".repeat(43),
      lastHumanTurnIssuedAt: 1, mappingKey: "current", mappingGeneration: getStoredSessionGeneration(current, "current"),
      generationId: randomUUID(), updatedAt: 2 }
    store.meta.priorityAttempts.route = { blocked: true, blockedTurnDigest: null, blockedTurnIssuedAt: null,
      pendingTurnDigest: null, pendingTurnIssuedAt: null, ownerToken: null, generationId: randomUUID(), updatedAt: 2 }
    store.meta.priorityRollbackMappings.route = { mappingKey: "previous",
      mappingGeneration: getStoredSessionGeneration(previous, "previous") }
  }
  const sidecarBytes = sidecarVersion === 1 ? JSON.stringify({ version: 1,
    resources: Object.fromEntries(Object.entries(sidecar.resources).map(([key, resource]) => {
      const { generation: _generation, ...legacy } = resource
      return [key, legacy]
    })) }) : serializeLegacySidecar(sidecar)
  writeFileSync(join(directory, "session-gc.json"), sidecarBytes)
  writeFileSync(join(directory, "sessions.json"), serializeLegacyStore(store))
}

/** Same source bytes/locator paths, separate uninterrupted control migration. */
export async function uninterruptedRichSnapshot(directory: string) {
  const control = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-migration-control-")))
  try {
    for (const name of SOURCE_NAMES) {
      writeFileSync(join(control, name), readFileSync(join(directory, name)), { mode: 0o600 })
    }
    await migrateBookkeeping(control, { writersStopped: true })
    return richSnapshot(control)
  } finally { rmSync(control, { recursive: true, force: true }) }
}

export function richSnapshot(directory: string) {
  const handle = initializeSessionBookkeeping(directory)
  try {
    return withBookkeepingRead(directory, (reader) => {
      const tables = reader.all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .map((row) => String(row.name)).sort()
      if (JSON.stringify(tables) !== JSON.stringify([...TABLES].sort())) {
        throw new Error("rich snapshot must count every bookkeeping table")
      }
      const snapshot = snapshotForExport(reader)
      const documents = SOURCE_NAMES.map((name, index) => {
        const bytes = index === 0 ? snapshot.sidecar : snapshot.store
        return { name, digest: digestBytes(bytes), bytes: Buffer.byteLength(bytes) }
      })
      const counts = Object.fromEntries(TABLES
        .map((table) => [table, Number(reader.get(`SELECT count(*) AS n FROM ${table}`)?.n)]))
      return { documents, counts }
    })
  } finally { handle.close() }
}

export function richArchivedSnapshot(directory: string, journal: ExportJournal) {
  const path = join(directory, `session-bookkeeping.sqlite.exported-${journal.id}`)
  const db = new Database(`${pathToFileURL(path).href}?mode=ro&immutable=1`)
  try {
    validateBookkeepingSchema(db)
    const counts = Object.fromEntries(TABLES.map((table) => [table,
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n]))
    return { documents: SOURCE_NAMES.map((name) => fileIdentity(directory, name)), counts }
  } finally { db.close() }
}
