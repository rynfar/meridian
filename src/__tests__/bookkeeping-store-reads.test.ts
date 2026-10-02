import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initializeSessionBookkeeping, withBookkeepingWrite } from "../proxy/session/bookkeeping/database"
import type { BookkeepingHandle } from "../proxy/session/bookkeeping/database"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { readMapping, readMappingGeneration, writeMappingRow, LOOKUP_CLAUDE_SQL,
  captureMappingPinsValidation } from "../proxy/session/bookkeeping/mappings"
import { readSharedSession, readSharedSessionByClaudeId } from "../proxy/session/bookkeeping/storeMappingsSql"
import * as mappings from "../proxy/session/bookkeeping/storeMappingsSql"
import * as maintenance from "../proxy/session/bookkeeping/storeMaintenanceSql"
import * as priority from "../proxy/session/bookkeeping/storePrioritySql"
import { snapshotForExport } from "../proxy/session/bookkeeping/exportSnapshot"
import { withStoreRead, withStoreWrite } from "../proxy/session/bookkeeping/storeScope"
import { STORE_META_KEY, getStoredSessionGeneration } from "../proxy/session/bookkeeping/legacyCodec"
import * as legacy from "../proxy/sessionStore"
import type { BookkeepingReader, SqlValue, CanonicalStoredSession } from "../proxy/session/bookkeeping/types"
import { canonicalizeLocator } from "../proxy/session/bookkeeping/locator"
import { connectionFor } from "../proxy/session/bookkeeping/connection"
import { sqliteSessionStoreBackend } from "../proxy/session/bookkeeping/sqliteStoreBackend"

let directory: string
let handle: BookkeepingHandle | undefined
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-store-reads-")))
  legacy.setSessionStoreBackendForTest(null)
  legacy.setSessionStoreDir(directory)
})
afterEach(() => {
  legacy.setSessionStoreBackendForTest(null)
  handle?.close()
  handle = undefined
  legacy.setSessionStoreDir(null)
  rmSync(directory, { recursive: true, force: true })
})
const entry = (extra: Partial<CanonicalStoredSession> = {}): CanonicalStoredSession => ({
  claudeSessionId: "claude", createdAt: 1, lastUsedAt: 10, messageCount: 1,
  messageHashes: ["x".repeat(1024 * 1024)], ...extra,
})
async function migrate() {
  await migrateBookkeeping(directory, { writersStopped: true })
  handle = initializeSessionBookkeeping(directory)
}
function seed(sessions: Record<string, unknown>) {
  writeFileSync(join(directory, "sessions.json"), JSON.stringify(sessions), { mode: 0o600 })
}
function traced(reader: BookkeepingReader) {
  const calls: Array<{ sql: string; parameters: SqlValue[] }> = []
  return { calls, reader: {
    get(sql: string, ...parameters: SqlValue[]) { calls.push({ sql, parameters }); return reader.get(sql, ...parameters) },
    all(sql: string, ...parameters: SqlValue[]) { calls.push({ sql, parameters }); return reader.all(sql, ...parameters) },
  } }
}

it("matches JSON reads, legacy denial, equal timestamps and exact legacy digest after path projection", async () => {
  const alias = join(directory, "alias")
  symlinkSync(directory, alias)
  const original = { unknown: { z: 1, a: 2 }, ...entry(),
    currentTranscript: { configDir: alias, sessionId: "claude" } }
  seed({ "z-first": original, "a-second": entry(), denied: {
    ...entry({ lastUsedAt: 11 }), passthroughResumeUuid: "old-user-uuid",
  }, "modern-denied": { ...entry({ generationId: randomUUID(), lastUsedAt: 12 }), passthroughResumeUuid: "old" } })
  const byKey = legacy.lookupSharedSessionResult("z-first")
  const byId = legacy.lookupSharedSessionByClaudeIdResult("claude")
  const denied = legacy.lookupSharedSessionResult("denied")
  const modernDenied = legacy.lookupSharedSessionResult("modern-denied")
  const absent = legacy.lookupSharedSessionResult("absent")
  const recovery = legacy.lookupSessionRecovery("z-first")
  const list = legacy.listStoredSessions()
  const snapshot = legacy.readSessionStoreSnapshot()
  await migrate()
  expect(mappings.lookupSharedSessionResult(directory, "z-first")).toEqual(byKey)
  expect(mappings.lookupSharedSessionByClaudeIdResult(directory, "claude")).toEqual(byId)
  expect(mappings.lookupSharedSessionResult(directory, "denied")).toEqual(denied)
  expect(mappings.lookupSharedSessionResult(directory, "modern-denied")).toEqual(modernDenied)
  expect(mappings.lookupSharedSessionResult(directory, "absent")).toEqual(absent)
  expect(maintenance.lookupSessionRecovery(directory, "z-first")).toEqual(recovery)
  expect(maintenance.listStoredSessions(directory)).toEqual(list)
  expect(maintenance.readSessionStoreSnapshot(directory)).toEqual(snapshot)
  expect(readMappingGeneration(handle!.reader, "z-first")).toBe(getStoredSessionGeneration(original, "z-first"))
  const exported = JSON.parse(snapshotForExport(handle!.reader).store)
  expect(Object.keys(exported).filter((key) => key !== STORE_META_KEY)).toEqual(Object.keys(snapshot))
})

it("hydrates only the addressed winner; generation snapshots never read history", async () => {
  const adapter = "😀_%tail"
  seed({ [adapter]: entry(), [`z:${adapter}`]: entry(), other: entry(),
    ...Object.fromEntries(Array.from({ length: 50 }, (_, n) => [`other-${n}`, entry({ messageHashes: ["other"] })])),
    denied: {
    ...entry({ lastUsedAt: 11 }), passthroughResumeUuid: "user",
  } })
  const expected = legacy.readSessionStoreGenerationSnapshot(adapter, ["p", "", "default"])
  await migrate()
  withStoreRead(directory, (reader) => {
    for (const operation of [
      (r: BookkeepingReader) => readSharedSession(r, adapter),
      (r: BookkeepingReader) => readSharedSessionByClaudeId(r, "claude"),
    ]) {
      const trace = traced(reader)
      expect(operation(trace.reader).status).toBe("found")
      expect(trace.calls.filter(({ sql }) => /mapping_history/i.test(sql)).map(({ parameters }) => parameters))
        .toEqual([[adapter]])
    }
    const trace = traced(reader)
    expect(maintenance.readGenerationSnapshot(trace.reader, adapter, ["p", "", "default"])).toEqual(expected)
    expect(trace.calls.some(({ sql }) => /mapping_history|history_json/i.test(sql))).toBe(false)
    const plan = reader.all(`EXPLAIN QUERY PLAN ${LOOKUP_CLAUDE_SQL}`, "claude").map((row) => row.detail).join(" ")
    expect(plan).toContain("mappings_claude")
    expect(plan).not.toContain("TEMP B-TREE")
  })
  legacy.setSessionStoreBackendForTest(sqliteSessionStoreBackend)
  const winner = mappings.lookupSharedSessionResult(directory, adapter)
  const prepare = spyOn(connectionFor(directory).db!, "prepare")
  try {
    for (const lookup of [() => legacy.lookupSharedSessionResult(adapter),
      () => legacy.lookupSharedSessionByClaudeIdResult("claude")]) {
      prepare.mockClear()
      expect(lookup()).toEqual(winner)
      const payload = prepare.mock.calls.map(([sql]) => sql).filter((sql) => /mapping_history|history_json/i.test(sql))
      expect(payload).toHaveLength(1)
      expect(payload.every((sql) => /WHERE mapping_key\s*=\s*\?/i.test(sql))).toBe(true)
    }
    prepare.mockClear()
    expect(legacy.readSessionStoreGenerationSnapshot(adapter, ["p", "", "default"])).toEqual(expected)
    expect(prepare.mock.calls.some(([sql]) => /mapping_history|history_json/i.test(sql))).toBe(false)
  } finally { prepare.mockRestore() }
})

it("preserves Object.entries numeric/string order across updates and delete/reinsert", async () => {
  seed({ z: entry(), "4294967295": entry(), "01": entry(), "2": entry(), "0": entry(), a: entry() })
  const expected = legacy.lookupSharedSessionByClaudeIdResult("claude")
  await migrate()
  expect(mappings.lookupSharedSessionByClaudeIdResult(directory, "claude")).toEqual(expected)
  expect(maintenance.listStoredSessions(directory).map((row) => row.key)).toEqual(["0", "2", "z", "4294967295", "01", "a"])
  withStoreWrite(directory, (tx) => {
    tx.run("DELETE FROM mappings WHERE key IN ('0','2')")
    writeMappingRow(tx, "z", entry({ generationId: randomUUID() }), true)
    expect(readSharedSessionByClaudeId(tx, "claude")).toEqual(readSharedSession(tx, "z"))
    tx.run("DELETE FROM mappings WHERE key='z'")
    writeMappingRow(tx, "z", entry({ generationId: randomUUID() }))
    expect(readSharedSessionByClaudeId(tx, "claude")).toEqual(readSharedSession(tx, "4294967295"))
  })
})

it("returns copies and observes writes on the outer publication connection, then rolls them back", async () => {
  seed({ key: entry({ currentTranscript: canonicalizeLocator({ configDir: directory, sessionId: "claude" }) }) })
  await migrate()
  const before = mappings.lookupSharedSessionResult(directory, "key")
  const copy = mappings.lookupSharedSessionResult(directory, "key")
  if (copy.status !== "found") throw new Error("fixture missing")
  copy.session.messageHashes![0] = "mutated"
  copy.session.currentTranscript!.configDir = "/mutated"
  const pins = maintenance.readSessionTranscriptPins(directory)
  pins[0]!.sessionId = "mutated"
  expect(mappings.lookupSharedSessionResult(directory, "key")).toEqual(before)
  expect(maintenance.readSessionTranscriptPins(directory)[0]!.sessionId).toBe("claude")
  withBookkeepingWrite(directory, { scope: "publication" }, () => {
    withStoreWrite(directory, (tx) => writeMappingRow(tx, "key", entry({ generationId: "new" }), true))
    const current = mappings.lookupSharedSessionResult(directory, "key")
    expect(current.status === "found" && current.session.generationId).toBe("new")
    return false
  })
  expect(mappings.lookupSharedSessionResult(directory, "key")).toEqual(before)
})

it("invalidates preserved export bytes on mapping replacement, without reviving them on a same-shaped replacement", async () => {
  const original = { ...entry({ generationId: randomUUID() }), unknown: "preserved" }
  seed({ key: original })
  await migrate()
  expect(JSON.parse(snapshotForExport(handle!.reader).store).key).toEqual(original)
  withStoreWrite(directory, (tx) => writeMappingRow(tx, "key", entry({ generationId: randomUUID(), messageCount: 2 }), true))
  const exported = JSON.parse(snapshotForExport(handle!.reader).store).key
  expect(exported.messageCount).toBe(2)
  expect(exported.unknown).toBeUndefined()
  expect(handle!.reader.get("SELECT key FROM legacy_exports WHERE kind='mapping'")).toBeUndefined()
  withStoreWrite(directory, (tx) => writeMappingRow(tx, "key", entry({ generationId: original.generationId }), true))
  expect(JSON.parse(snapshotForExport(handle!.reader).store).key.unknown).toBeUndefined()
})

it("validates derived digest, denial and object ordering before trusting metadata", async () => {
  seed({ key: entry() })
  await migrate()
  for (const [column, value] of [["generation_token", "wrong"], ["legacy_denial", 1], ["object_index", 0]] as const) {
    withStoreWrite(directory, (tx) => {
      tx.run(`UPDATE mappings SET ${column}=? WHERE key='key'`, value)
      expect(() => captureMappingPinsValidation(tx)).toThrow("mapping lookup metadata/payload mismatch")
      return false
    })
  }
  expect(readMapping(handle!.reader, "key")).toEqual(entry())
})

it("matches exact priority assignment/attempt and absence generations without reading mappings", async () => {
  legacy.storeSharedSession("key", "claude")
  const mapping = legacy.lookupSharedSessionResult("key")
  const unassigned = legacy.lookupPriorityAssignmentResult("assigned")
  if (mapping.status === "error" || !mapping.generation || unassigned.status === "error") throw new Error("fixture read failed")
  expect(legacy.storeSharedSessionAndPriorityAssignment({ key: "key", claudeSessionId: "claude",
    messageCount: 1, lineageHash: "lineage", messageHashes: ["hash"], messageBlockHashes: [["block"]],
    expectedMappingGeneration: mapping.generation, priority: { routeKey: "assigned", profileId: "p",
      lastHumanTurnDigest: "a".repeat(43), lastHumanTurnIssuedAt: 1,
      expectedAssignmentGeneration: unassigned.generation } })).not.toBe(false)
  const assigned = legacy.lookupPriorityAssignmentResult("assigned")
  const empty = legacy.lookupPriorityAssignmentResult("route")
  if (empty.status !== "missing") throw new Error("expected missing")
  const claim = legacy.claimPriorityAttempt({ routeKey: "route", expectedAssignmentGeneration: empty.generation })
  expect(claim).not.toBe(false)
  const pending = legacy.lookupPriorityAssignmentResult("route")
  const absent = legacy.lookupPriorityAssignmentResult("absent")
  await migrate()
  expect(priority.lookupPriorityAssignmentResult(directory, "assigned")).toEqual(assigned)
  expect(priority.lookupPriorityAssignmentResult(directory, "route")).toEqual(pending)
  expect(priority.lookupPriorityAssignmentResult(directory, "absent")).toEqual(absent)
  withStoreRead(directory, (reader) => {
    const trace = traced(reader)
    priority.readPriorityAssignment(trace.reader, "route")
    expect(trace.calls.some(({ sql }) => /mappings|mapping_history/.test(sql))).toBe(false)
  })
})
