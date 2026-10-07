import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initializeSessionBookkeeping, withBookkeepingWrite } from "../proxy/session/bookkeeping/database"
import { BookkeepingBusyError } from "../proxy/session/bookkeeping/database"
import { SessionLifecycleLockError } from "../proxy/session/lifecycleErrors"
import type { BookkeepingHandle } from "../proxy/session/bookkeeping/database"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { readMapping, readMappingGeneration } from "../proxy/session/bookkeeping/mappings"
import { storeSharedSession } from "../proxy/session/bookkeeping/storeWriteSql"
import { attachSharedTranscriptLocator, evictSharedSession, clearSharedSessions } from "../proxy/session/bookkeeping/storeMaintenanceWriteSql"
import { sqliteSessionStoreBackend } from "../proxy/session/bookkeeping/sqliteStoreBackend"
import { mappingDigest } from "../proxy/session/bookkeeping/mappingMetadata"
import { claimPriorityAttempt, releasePriorityAttempt, blockPriorityAttempt } from "../proxy/session/bookkeeping/storeAttemptsSql"
import { lookupPriorityAssignmentResult } from "../proxy/session/bookkeeping/storePrioritySql"
import { storeSharedSessionAndPriorityAssignment } from "../proxy/session/bookkeeping/storePublicationSql"
import { finalizeSharedSessionAndPriorityAssignment, rollbackSharedSessionAndPriorityAssignment } from "../proxy/session/bookkeeping/storeSettlementSql"
import type { SharedSessionAndPriorityAssignmentOptions } from "../proxy/session/bookkeeping/storeTypes"
import { snapshotForExport } from "../proxy/session/bookkeeping/exportSnapshot"
import { withStoreWrite } from "../proxy/session/bookkeeping/storeScope"
import * as legacy from "../proxy/sessionStore"

let directory: string
let handle: BookkeepingHandle | undefined
const originalLimit = process.env.MERIDIAN_MAX_STORED_SESSIONS
const originalAttemptsLimit = process.env.MERIDIAN_MAX_PRIORITY_ATTEMPTS
const originalAssignmentsLimit = process.env.MERIDIAN_MAX_PRIORITY_ASSIGNMENTS
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-store-mutations-")))
  legacy.setSessionStoreBackendForTest(null)
  legacy.setSessionStoreDir(directory)
})
afterEach(() => {
  handle?.close()
  handle = undefined
  legacy.setSessionStoreBackendForTest(null)
  legacy.setSessionStoreDir(null)
  if (originalLimit === undefined) delete process.env.MERIDIAN_MAX_STORED_SESSIONS
  else process.env.MERIDIAN_MAX_STORED_SESSIONS = originalLimit
  if (originalAttemptsLimit === undefined) delete process.env.MERIDIAN_MAX_PRIORITY_ATTEMPTS
  else process.env.MERIDIAN_MAX_PRIORITY_ATTEMPTS = originalAttemptsLimit
  if (originalAssignmentsLimit === undefined) delete process.env.MERIDIAN_MAX_PRIORITY_ASSIGNMENTS
  else process.env.MERIDIAN_MAX_PRIORITY_ASSIGNMENTS = originalAssignmentsLimit
  rmSync(directory, { recursive: true, force: true })
})
async function migrate() {
  await migrateBookkeeping(directory, { writersStopped: true })
  handle = initializeSessionBookkeeping(directory)
}
const generation = (key: string) => readMappingGeneration(handle!.reader, key)
const mapping = (key: string) => readMapping(handle!.reader, key)
function priority(route = "route") {
  const value = lookupPriorityAssignmentResult(directory, route)
  if (value.status === "error") throw value.error
  return value
}
function publication(key = "key", route = "route"): SharedSessionAndPriorityAssignmentOptions {
  return { key, claudeSessionId: "id", messageCount: 1, lineageHash: "h", messageHashes: ["h"], messageBlockHashes: [["b"]],
    expectedMappingGeneration: generation(key), priority: { routeKey: route, profileId: "p",
      lastHumanTurnDigest: "a".repeat(43), lastHumanTurnIssuedAt: 1, expectedAssignmentGeneration: priority(route).generation } }
}

it("store: absent/null, exact/stale/present CAS, export invalidation, copies and replacement lineage", async () => {
  const original = { claudeSessionId: "old", createdAt: 1, lastUsedAt: 1, messageCount: 2,
    messageHashes: ["old"], unknown: "imported" }
  writeFileSync(join(directory, "sessions.json"), JSON.stringify({ key: original }), { mode: 0o600 })
  const exact = legacy.getStoredSessionGeneration(original, "key")
  await migrate()
  expect(storeSharedSession(directory, "key", "new", undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, null)).toBe(false)
  expect(storeSharedSession(directory, "key", "new", undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, "stale")).toBe(false)
  expect(mapping("key")).toEqual(original)
  const current = { sessionId: "new", configDir: directory }
  const source = { sessionId: "old", configDir: directory }
  const hashes = ["new"]
  const stored = storeSharedSession(directory, "key", "new", 3, "lineage", hashes, [null],
    undefined, [["block"]], "assistant", ["tool"], current, source, exact)
  expect(stored).toBe(generation("key"))
  current.sessionId = "mutated"
  source.configDir = "/mutated"
  hashes[0] = "mutated"
  expect(mapping("key")).toMatchObject({ claudeSessionId: "new", previousClaudeSessionId: "old",
    messageCount: 3, messageHashes: ["new"], currentTranscript: { sessionId: "new", configDir: directory },
    previousTranscript: { sessionId: "old", configDir: directory }, revision: 1, createdAt: 1 })
  expect(handle!.reader.get("SELECT key FROM legacy_exports WHERE kind='mapping'")).toBeUndefined()
  expect(JSON.parse(snapshotForExport(handle!.reader).store).key.unknown).toBeUndefined()
  expect(handle!.reader.all("SELECT slot FROM mapping_pins WHERE mapping_key='key' ORDER BY slot"))
    .toEqual([{ slot: "current" }, { slot: "previous" }])
  const order = handle!.reader.get("SELECT insertion_order FROM mappings WHERE key='key'")
  expect(storeSharedSession(directory, "key", "new", undefined, undefined, undefined, undefined,
    undefined, undefined, null, null, { sessionId: "new", configDir: "/ignored" })).not.toBe(false)
  expect(mapping("key")!.currentTranscript!.configDir).toBe(directory)
  expect(mapping("key")!.passthroughToolCallIds).toBeUndefined()
  expect(mapping("key")!.passthroughToolCallAssistantUuid).toBeUndefined()
  expect(handle!.reader.get("SELECT insertion_order FROM mappings WHERE key='key'")).toEqual(order)
  expect(storeSharedSession(directory, "absent", "id", undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, null)).not.toBe(false)
  const absent = generation("missing")
  expect(storeSharedSession(directory, "missing", "id", undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, absent)).not.toBe(false)
  expect(() => storeSharedSession(directory, "key", "new", undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { sessionId: "new", configDir: directory }))
    .toThrow("sourceTranscript.sessionId")
})

it("store: rollback protection and protected capacity reject atomically; route generations refresh", async () => {
  legacy.storeSharedSession("protected", "id")
  const prior = legacy.lookupSharedSessionResult("protected")
  const route = legacy.lookupPriorityAssignmentResult("route")
  if (prior.status === "error" || !prior.generation || route.status === "error") throw new Error("fixture")
  legacy.storeSharedSessionAndPriorityAssignment({ key: "protected", claudeSessionId: "id", messageCount: 1,
    lineageHash: "h", messageHashes: [], messageBlockHashes: [], expectedMappingGeneration: prior.generation,
    priority: { routeKey: "route", profileId: "p", lastHumanTurnDigest: "x".repeat(43),
      lastHumanTurnIssuedAt: 1, expectedAssignmentGeneration: route.generation } })
  await migrate()
  process.env.MERIDIAN_MAX_STORED_SESSIONS = "1"
  const before = snapshotForExport(handle!.reader)
  expect(storeSharedSession(directory, "overflow", "id")).toBe(false)
  expect(snapshotForExport(handle!.reader)).toEqual(before)
  expect(storeSharedSession(directory, "protected", "id")).not.toBe(false)
  expect(handle!.reader.get("SELECT mapping_generation FROM priority_assignments WHERE route_key='route'")?.mapping_generation)
    .toBe(generation("protected"))
  process.env.MERIDIAN_MAX_STORED_SESSIONS = "2"
  expect(storeSharedSession(directory, "fallback", "id")).not.toBe(false)
  withStoreWrite(directory, (tx) => tx.run("INSERT INTO priority_rollbacks VALUES(?,?,?)",
    "route", "fallback", readMappingGeneration(tx, "fallback")))
  const protectedBefore = snapshotForExport(handle!.reader)
  expect(storeSharedSession(directory, "fallback", "replacement")).toBe(false)
  expect(snapshotForExport(handle!.reader)).toEqual(protectedBefore)
})

it("store: equal timestamp pruning uses object insertion order and advances absence slots", async () => {
  const entry = { claudeSessionId: "id", createdAt: 1, lastUsedAt: 1, messageCount: 0 }
  writeFileSync(join(directory, "sessions.json"), JSON.stringify({ z: entry, a: entry, "2": entry }), { mode: 0o600 })
  await migrate()
  process.env.MERIDIAN_MAX_STORED_SESSIONS = "2"
  const absentBefore = generation("2")
  expect(storeSharedSession(directory, "new", "id")).not.toBe(false)
  expect(mapping("2")).toBeUndefined()
  expect(mapping("z")).toBeUndefined()
  expect(mapping("a")).toBeDefined()
  expect(generation("2")).not.toBe(absentBefore)
  expect(storeSharedSession(directory, "2", "id", undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, null)).toBe(false)
})

it("store: joins publication, read-your-writes, false rollback and afterCommit ordering", async () => {
  await migrate()
  const events: string[] = []
  withBookkeepingWrite(directory, { scope: "publication" }, (tx) => {
    expect(storeSharedSession(directory, "key", "id")).not.toBe(false)
    expect(readMapping(tx, "key")!.claudeSessionId).toBe("id")
    tx.afterCommit(() => events.push("discarded"))
    return false
  })
  expect(mapping("key")).toBeUndefined()
  expect(events).toEqual([])
  withBookkeepingWrite(directory, { scope: "publication" }, (tx) => {
    expect(storeSharedSession(directory, "key", "id")).not.toBe(false)
    tx.afterCommit(() => events.push(mapping("key")!.claudeSessionId))
    expect(events).toEqual([])
  })
  expect(events).toEqual(["id"])
  const before = generation("key")
  expect(() => withBookkeepingWrite(directory, { scope: "publication" }, () => {
    storeSharedSession(directory, "key", "changed")
    expect(storeSharedSession(directory, "key", "changed", undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, randomUUID())).toBe(false)
    return true
  })).toThrow("nested bookkeeping write requested rollback")
  expect(generation("key")).toBe(before)
})

it("claim: generation, floor, capacity, input validation and newer pending supersession", async () => {
  await migrate()
  const expectedAssignmentGeneration = priority().generation
  const options = { routeKey: "route", expectedAssignmentGeneration }
  expect(claimPriorityAttempt(directory, { ...options, expectedAssignmentGeneration: "stale" })).toBe(false)
  expect(() => claimPriorityAttempt(directory, { ...options, routeKey: "" })).toThrow("bounded route key")
  expect(() => claimPriorityAttempt(directory, { ...options, turn: { turnId: "bad", issuedAt: 0 } })).toThrow("trusted turn")
  const first = claimPriorityAttempt(directory, { ...options, turn: { turnId: "a".repeat(43), issuedAt: 5 } })
  if (!first) throw new Error("claim rejected")
  expect(first.ownerToken).toMatch(/^[\da-f-]{36}$/)
  const before = priority()
  expect(claimPriorityAttempt(directory, options)).toBe(false)
  expect(claimPriorityAttempt(directory, { ...options, turn: { turnId: "a".repeat(43), issuedAt: 5 } })).toBe(false)
  expect(claimPriorityAttempt(directory, { ...options, turn: { turnId: "a".repeat(43), issuedAt: 4 } })).toBe(false)
  expect(priority()).toEqual(before)
  process.env.MERIDIAN_MAX_PRIORITY_ATTEMPTS = "1"
  expect(claimPriorityAttempt(directory, { routeKey: "other", expectedAssignmentGeneration: priority("other").generation })).toBe(false)
  const second = claimPriorityAttempt(directory, { ...options, turn: { turnId: "b".repeat(43), issuedAt: 6 } })
  expect(second).not.toBe(false)
  expect(priority().attempt).toMatchObject({ blocked: true, blockedTurnDigest: "a".repeat(43),
    blockedTurnIssuedAt: 5, pendingTurnDigest: "b".repeat(43), pendingTurnIssuedAt: 6 })
  expect(releasePriorityAttempt(directory, "route", first.ownerToken)).toBe(false)
})

it("release: invalid/missing/stale token false; deletes clean attempt, preserves older blocker", async () => {
  await migrate()
  for (const [route, token] of [["", randomUUID()], ["x".repeat(513), randomUUID()], ["route", "bad"], ["missing", randomUUID()]])
    expect(releasePriorityAttempt(directory, route!, token!)).toBe(false)
  const options = { routeKey: "route", expectedAssignmentGeneration: priority().generation }
  const first = claimPriorityAttempt(directory, options)
  if (!first) throw new Error("claim rejected")
  expect(releasePriorityAttempt(directory, "route", randomUUID())).toBe(false)
  expect(releasePriorityAttempt(directory, "route", first.ownerToken)).toBe(true)
  expect(priority().attempt).toBeUndefined()
  const blocked = claimPriorityAttempt(directory, { ...options, turn: { turnId: "a".repeat(43), issuedAt: 1 } })
  if (!blocked) throw new Error("claim rejected")
  expect(blockPriorityAttempt(directory, "route", blocked.ownerToken)).toBe(true)
  const next = claimPriorityAttempt(directory, { ...options, turn: { turnId: "b".repeat(43), issuedAt: 2 } })
  if (!next) throw new Error("claim rejected")
  expect(releasePriorityAttempt(directory, "route", next.ownerToken)).toBe(true)
  expect(priority().attempt).toMatchObject({ blocked: true, blockedTurnIssuedAt: 1,
    pendingTurnIssuedAt: null, pendingTurnDigest: null, ownerToken: null })
})

it("block: invalid/missing/stale token false; promotes pending turn and handles untrusted turn", async () => {
  await migrate()
  for (const [route, token] of [["", randomUUID()], ["x".repeat(513), randomUUID()], ["route", "bad"], ["missing", randomUUID()]])
    expect(blockPriorityAttempt(directory, route!, token!)).toBe(false)
  const options = { routeKey: "route", expectedAssignmentGeneration: priority().generation }
  const first = claimPriorityAttempt(directory, options)
  if (!first) throw new Error("claim rejected")
  expect(blockPriorityAttempt(directory, "route", randomUUID())).toBe(false)
  expect(blockPriorityAttempt(directory, "route", first.ownerToken)).toBe(true)
  expect(blockPriorityAttempt(directory, "route", first.ownerToken)).toBe(false)
  expect(priority().attempt).toMatchObject({ blocked: true, blockedTurnIssuedAt: null, ownerToken: null })
  const next = claimPriorityAttempt(directory, { ...options, turn: { turnId: "b".repeat(43), issuedAt: 2 } })
  if (!next) throw new Error("claim rejected")
  expect(blockPriorityAttempt(directory, "route", next.ownerToken)).toBe(true)
  expect(priority().attempt).toMatchObject({ blocked: true, blockedTurnIssuedAt: 2,
    blockedTurnDigest: "b".repeat(43), pendingTurnIssuedAt: null, ownerToken: null })
})

it("publish: exact joint CAS, stale mapping/route/owner, attempt bypass and rollback ownership guards", async () => {
  await migrate()
  const options = publication()
  const before = snapshotForExport(handle!.reader)
  expect(storeSharedSessionAndPriorityAssignment(directory, { ...options, expectedMappingGeneration: "stale" })).toBe(false)
  expect(storeSharedSessionAndPriorityAssignment(directory, { ...options,
    priority: { ...options.priority, expectedAssignmentGeneration: "stale" } })).toBe(false)
  expect(storeSharedSessionAndPriorityAssignment(directory, { ...options, attemptOwnerToken: randomUUID() })).toBe(false)
  expect(snapshotForExport(handle!.reader)).toEqual(before)
  const claim = claimPriorityAttempt(directory, { routeKey: "route", expectedAssignmentGeneration: priority().generation })
  if (!claim) throw new Error("claim rejected")
  expect(storeSharedSessionAndPriorityAssignment(directory, options)).toBe(false)
  const result = storeSharedSessionAndPriorityAssignment(directory, { ...options, attemptOwnerToken: claim.ownerToken })
  if (!result) throw new Error("publication rejected")
  expect(result.previousMapping).toBeNull()
  expect(result.previousAssignment).toBeNull()
  expect(result.mappingGeneration).toBe(generation("key"))
  expect(result.assignmentGeneration).toBe(priority().generation)
  expect(priority().attempt?.ownerToken).toBe(claim.ownerToken)
  const replacement = storeSharedSessionAndPriorityAssignment(directory, { ...publication("new"), attemptOwnerToken: claim.ownerToken })
  if (!replacement) throw new Error("replacement rejected")
  expect(handle!.reader.get("SELECT mapping_key FROM priority_rollbacks WHERE route_key='route'")?.mapping_key).toBe("key")
  expect(storeSharedSessionAndPriorityAssignment(directory, publication("key", "other"))).toBe(false)
  withStoreWrite(directory, (tx) => {
    tx.run("UPDATE priority_rollbacks SET mapping_generation='stale' WHERE route_key='route'")
    expect(storeSharedSessionAndPriorityAssignment(directory, { ...publicationInside(tx, "key"), attemptOwnerToken: claim.ownerToken })).toBe(false)
    return false
  })
})

function publicationInside(tx: import("../proxy/session/bookkeeping/types").BookkeepingReader, key: string) {
  // Avoid the external handle during a transaction; the public lookup joins the same snapshot.
  return { key, claudeSessionId: "id", messageCount: 1, lineageHash: "h", messageHashes: [], messageBlockHashes: [],
    expectedMappingGeneration: readMappingGeneration(tx, key), priority: { routeKey: "route", profileId: "p",
      lastHumanTurnDigest: "a".repeat(43), lastHumanTurnIssuedAt: 1, expectedAssignmentGeneration: priority().generation } }
}

it("finalize: mapping/route/rollback/attempt CAS; exact finalize clears claim and prunes rollback backlog", async () => {
  await migrate()
  process.env.MERIDIAN_MAX_STORED_SESSIONS = "1"
  const old = storeSharedSessionAndPriorityAssignment(directory, publication("old"))
  if (!old) throw new Error("publication rejected")
  const claim = claimPriorityAttempt(directory, { routeKey: "route", expectedAssignmentGeneration: priority().generation })
  if (!claim) throw new Error("claim rejected")
  const result = storeSharedSessionAndPriorityAssignment(directory, { ...publication(), attemptOwnerToken: claim.ownerToken })
  if (!result) throw new Error("publication rejected")
  expect(mapping("old")).toBeDefined()
  const options = { key: "key", routeKey: "route", expectedMappingGeneration: result.mappingGeneration,
    expectedAssignmentGeneration: result.assignmentGeneration, rollbackMappingKey: "old", attemptOwnerToken: claim.ownerToken }
  const before = snapshotForExport(handle!.reader)
  for (const change of [{ expectedMappingGeneration: "stale" }, { expectedAssignmentGeneration: "stale" },
    { rollbackMappingKey: "wrong" }, { attemptOwnerToken: randomUUID() }, { attemptOwnerToken: undefined }, { routeKey: "missing" }]) {
    expect(finalizeSharedSessionAndPriorityAssignment(directory, { ...options, ...change })).toBe(false)
    expect(snapshotForExport(handle!.reader)).toEqual(before)
  }
  expect(finalizeSharedSessionAndPriorityAssignment(directory, options)).toBe(true)
  expect(mapping("old")).toBeUndefined()
  expect(priority().attempt).toBeUndefined()
  expect(priority().generation).not.toBe(result.assignmentGeneration)
  expect(finalizeSharedSessionAndPriorityAssignment(directory, options)).toBe(false)
})

it("rollback: mapping/assignment/attempt/marker CAS; restore prior mapping and route with fresh authorities", async () => {
  await migrate()
  const first = storeSharedSessionAndPriorityAssignment(directory, publication())
  if (!first) throw new Error("publication rejected")
  const result = storeSharedSessionAndPriorityAssignment(directory, { ...publication(), claudeSessionId: "new" })
  if (!result) throw new Error("publication rejected")
  const options = { key: "key", routeKey: "route", expectedMappingGeneration: result.mappingGeneration,
    expectedAssignmentGeneration: result.assignmentGeneration, previousMapping: result.previousMapping,
    previousAssignment: result.previousAssignment }
  const before = snapshotForExport(handle!.reader)
  for (const change of [{ expectedMappingGeneration: "stale" }, { expectedAssignmentGeneration: "stale" },
    { attemptOwnerToken: randomUUID() }, { previousAssignment: { ...result.previousAssignment!, mappingKey: "wrong" } }]) {
    expect(rollbackSharedSessionAndPriorityAssignment(directory, { ...options, ...change })).toBe(false)
    expect(snapshotForExport(handle!.reader)).toEqual(before)
  }
  const restored = rollbackSharedSessionAndPriorityAssignment(directory, options)
  if (!restored) throw new Error("rollback rejected")
  expect(restored.restoredMapping?.claudeSessionId).toBe("id")
  expect(restored.mappingGeneration).toBe(generation("key"))
  expect(restored.mappingGeneration).not.toBe(first.mappingGeneration)
  expect(restored.restoredAssignment?.mappingGeneration).toBe(restored.mappingGeneration)
  const newResult = storeSharedSessionAndPriorityAssignment(directory, publication("new", "new-route"))
  if (!newResult) throw new Error("publication rejected")
  const removed = rollbackSharedSessionAndPriorityAssignment(directory, { key: "new", routeKey: "new-route",
    expectedMappingGeneration: newResult.mappingGeneration, expectedAssignmentGeneration: newResult.assignmentGeneration,
    previousMapping: null, previousAssignment: null })
  expect(removed).not.toBe(false)
  expect(mapping("new")).toBeUndefined()
  expect(priority("new-route").status).toBe("missing")
})

it("publish: rollback generation mismatch, missing rollback and exhausted protected-route capacity roll back all writes", async () => {
  await migrate()
  expect(storeSharedSessionAndPriorityAssignment(directory, publication("old"))).not.toBe(false)
  const before = snapshotForExport(handle!.reader)
  expect(() => storeSharedSessionAndPriorityAssignment(directory,
    { ...publication("next"), rollbackMappingKey: "missing" })).toThrow("rollback mapping disappeared")
  expect(snapshotForExport(handle!.reader)).toEqual(before)
  withStoreWrite(directory, (tx) => {
    tx.run("UPDATE priority_assignments SET mapping_generation='stale' WHERE route_key='route'")
    expect(storeSharedSessionAndPriorityAssignment(directory, publicationInside(tx, "next"))).toBe(false)
    return false
  })
  expect(storeSharedSessionAndPriorityAssignment(directory, publication("next"))).not.toBe(false)
  process.env.MERIDIAN_MAX_PRIORITY_ASSIGNMENTS = "1"
  const protectedBefore = snapshotForExport(handle!.reader)
  expect(storeSharedSessionAndPriorityAssignment(directory, publication("other", "other-route"))).toBe(false)
  expect(snapshotForExport(handle!.reader)).toEqual(protectedBefore)
})

it("priority pruning: equal timestamps evict earliest insertion, preserve order across update and export", async () => {
  await migrate()
  expect(storeSharedSessionAndPriorityAssignment(directory, publication("z", "z-route"))).not.toBe(false)
  expect(storeSharedSessionAndPriorityAssignment(directory, publication("a", "a-route"))).not.toBe(false)
  expect(storeSharedSessionAndPriorityAssignment(directory, publication("z", "z-route"))).not.toBe(false)
  withStoreWrite(directory, (tx) => tx.run("UPDATE priority_assignments SET updated_at=1"))
  const exported = JSON.parse(snapshotForExport(handle!.reader).store)
  expect(Object.keys(exported["\u0000meridian-session-store"].priorityAssignments)).toEqual(["z-route", "a-route"])
  process.env.MERIDIAN_MAX_PRIORITY_ASSIGNMENTS = "2"
  expect(storeSharedSessionAndPriorityAssignment(directory, publication("third", "third-route"))).not.toBe(false)
  expect(priority("z-route").status).toBe("missing")
  expect(priority("a-route").status).toBe("found")
})

it("rollback: v1 refuses, exact different-key restoration preserves claim; missing/incorrect marker rejects", async () => {
  await migrate()
  expect(rollbackSharedSessionAndPriorityAssignment(directory, { key: "key", routeKey: "route",
    expectedMappingGeneration: generation("key"), expectedAssignmentGeneration: priority().generation,
    previousMapping: null, previousAssignment: null })).toBe(false)
  expect(finalizeSharedSessionAndPriorityAssignment(directory, { key: "key", routeKey: "route",
    expectedMappingGeneration: generation("key"), expectedAssignmentGeneration: priority().generation })).toBe(false)
  const first = storeSharedSessionAndPriorityAssignment(directory, publication("old"))
  if (!first) throw new Error("publication rejected")
  const claim = claimPriorityAttempt(directory, { routeKey: "route", expectedAssignmentGeneration: priority().generation,
    turn: { turnId: "a".repeat(43), issuedAt: 1 } })
  if (!claim) throw new Error("claim rejected")
  const result = storeSharedSessionAndPriorityAssignment(directory, { ...publication(), attemptOwnerToken: claim.ownerToken })
  if (!result) throw new Error("publication rejected")
  const options = { key: "key", routeKey: "route", expectedMappingGeneration: result.mappingGeneration,
    expectedAssignmentGeneration: result.assignmentGeneration, previousMapping: result.previousMapping,
    previousAssignment: result.previousAssignment, attemptOwnerToken: claim.ownerToken }
  expect(rollbackSharedSessionAndPriorityAssignment(directory, { ...options, attemptOwnerToken: undefined })).toBe(false)
  expect(rollbackSharedSessionAndPriorityAssignment(directory, { ...options,
    previousAssignment: { ...result.previousAssignment!, mappingGeneration: "stale" } })).toBe(false)
  withStoreWrite(directory, (tx) => {
    tx.run("DELETE FROM priority_rollbacks WHERE route_key='route'")
    expect(rollbackSharedSessionAndPriorityAssignment(directory, options)).toBe(false)
    return false
  })
  const restored = rollbackSharedSessionAndPriorityAssignment(directory, options)
  if (!restored) throw new Error("rollback rejected")
  expect(restored.restoredMapping).toBeNull()
  expect(restored.restoredAssignment?.mappingKey).toBe("old")
  expect(restored.restoredAssignment?.mappingGeneration).toBe(first.mappingGeneration)
  expect(priority().attempt?.ownerToken).toBe(claim.ownerToken)
  expect(mapping("key")).toBeUndefined()
})

it("claim: assigned turn is a floor when an attempt exists; release keeps a higher existing blocker", async () => {
  await migrate()
  expect(storeSharedSessionAndPriorityAssignment(directory, { ...publication(), priority: {
    ...publication().priority, lastHumanTurnIssuedAt: 10 } })).not.toBe(false)
  const options = { routeKey: "route", expectedAssignmentGeneration: priority().generation }
  const claim = claimPriorityAttempt(directory, options)
  if (!claim) throw new Error("claim rejected")
  expect(claimPriorityAttempt(directory, { ...options, turn: { turnId: "b".repeat(43), issuedAt: 10 } })).toBe(false)
  const next = claimPriorityAttempt(directory, { ...options, turn: { turnId: "b".repeat(43), issuedAt: 11 } })
  if (!next) throw new Error("claim rejected")
  expect(blockPriorityAttempt(directory, "route", next.ownerToken)).toBe(true)
  expect(priority().attempt).toMatchObject({ blockedTurnIssuedAt: 11, pendingTurnIssuedAt: null })
})

it("store transaction: actual mutation fails immediately with typed overload under a child writer", async () => {
  await migrate()
  expect(Object.values(handle!.reader.get("PRAGMA busy_timeout")!)).toEqual([0])
  const child = spawn("node", ["--input-type=module", "-e", `
    import Database from 'libsql';
    const db = new Database(${JSON.stringify(handle!.path)});
    db.exec('BEGIN IMMEDIATE'); process.send('locked');
    process.on('disconnect', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
  let stderr = ""
  child.stderr!.on("data", (chunk) => { stderr += String(chunk) })
  try {
    await Promise.race([once(child, "message"), once(child, "exit").then(([code]) => {
      throw new Error(`holder exited before ready: ${code}: ${stderr}`)
    })])
    const sleeping = spyOn(Atomics, "wait").mockImplementation(() => { throw new Error("sync sleep forbidden") })
    try {
      const started = performance.now()
      let failure: unknown
      try { storeSharedSession(directory, "key", "id") } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(BookkeepingBusyError)
      expect(failure).toBeInstanceOf(SessionLifecycleLockError)
      expect(performance.now() - started).toBeLessThan(1000)
      expect(sleeping).not.toHaveBeenCalled()
      expect(mapping("key")).toBeUndefined()
    } finally { sleeping.mockRestore() }
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit")
      if (child.connected) child.disconnect()
      else child.kill("SIGKILL")
      await exited
    }
  }
}, 20000)

it("store transaction: cross-database mutation refuses before writing", async () => {
  await migrate()
  const other = join(directory, "other")
  const otherHandle = initializeSessionBookkeeping(other)
  try {
    expect(() => withBookkeepingWrite(directory, { scope: "publication" }, () =>
      storeSharedSession(other, "key", "id"))).toThrow("cross-database publication")
    expect(otherHandle.reader.get("SELECT key FROM mappings")).toBeUndefined()
    expect(mapping("key")).toBeUndefined()
  } finally { otherHandle.close() }
})

it("attach: missing/id/generation/rollback false; exact no-op, copied locator, route refresh and pins", async () => {
  await migrate()
  const locator = { sessionId: "id", configDir: directory }
  expect(attachSharedTranscriptLocator(directory, "missing", "id", locator)).toBe(false)
  expect(storeSharedSessionAndPriorityAssignment(directory, publication())).not.toBe(false)
  const before = snapshotForExport(handle!.reader)
  expect(attachSharedTranscriptLocator(directory, "key", "wrong", { ...locator, sessionId: "wrong" })).toBe(false)
  expect(attachSharedTranscriptLocator(directory, "key", "id", locator, "stale")).toBe(false)
  expect(snapshotForExport(handle!.reader)).toEqual(before)
  const attached = attachSharedTranscriptLocator(directory, "key", "id", locator, generation("key"))
  if (!attached) throw new Error("attach rejected")
  expect(attached).toBe(generation("key"))
  const after = snapshotForExport(handle!.reader)
  expect(attachSharedTranscriptLocator(directory, "key", "id", locator, generation("key"))).toBe(attached)
  expect(snapshotForExport(handle!.reader)).toEqual(after)
  locator.configDir = "/mutated"
  expect(mapping("key")?.currentTranscript?.configDir).toBe(directory)
  expect(handle!.reader.get("SELECT mapping_generation FROM priority_assignments WHERE route_key='route'")?.mapping_generation).toBe(attached)
  expect(handle!.reader.get("SELECT slot FROM mapping_pins WHERE mapping_key='key'")?.slot).toBe("current")
  expect(storeSharedSessionAndPriorityAssignment(directory, publication("next"))).not.toBe(false)
  const protectedBefore = snapshotForExport(handle!.reader)
  expect(attachSharedTranscriptLocator(directory, "key", "id", { sessionId: "id", configDir: directory })).toBe(false)
  expect(snapshotForExport(handle!.reader)).toEqual(protectedBefore)
})

it("evict: absent no-op, stale/protected false; cascades mapping dependants but keeps assignment and attempt", async () => {
  await migrate()
  const empty = snapshotForExport(handle!.reader)
  expect(evictSharedSession(directory, "missing", "stale")).toBe(true)
  expect(snapshotForExport(handle!.reader)).toEqual(empty)
  const result = storeSharedSessionAndPriorityAssignment(directory, { ...publication(),
    currentTranscript: { sessionId: "id", configDir: directory } })
  if (!result) throw new Error("publication rejected")
  expect(claimPriorityAttempt(directory, { routeKey: "route", expectedAssignmentGeneration: result.assignmentGeneration })).not.toBe(false)
  const routeBefore = priority()
  const before = snapshotForExport(handle!.reader)
  expect(evictSharedSession(directory, "key", "stale")).toBe(false)
  expect(snapshotForExport(handle!.reader)).toEqual(before)
  const slot = mappingDigest("key").slice(0, 4)
  const counter = Number(handle!.reader.get("SELECT counter FROM fence_slots WHERE namespace='store' AND slot=?", slot)?.counter)
  expect(evictSharedSession(directory, "key", result.mappingGeneration)).toBe(true)
  expect(mapping("key")).toBeUndefined()
  expect(priority()).toEqual(routeBefore)
  expect(handle!.reader.get("SELECT counter FROM fence_slots WHERE namespace='store' AND slot=?", slot)?.counter).toBe(counter + 1)
  for (const table of ["mapping_history", "mapping_pins"])
    expect(handle!.reader.get(`SELECT mapping_key FROM ${table} WHERE mapping_key='key'`)).toBeUndefined()
  const deleted = snapshotForExport(handle!.reader)
  expect(evictSharedSession(directory, "key", result.mappingGeneration)).toBe(true)
  expect(snapshotForExport(handle!.reader)).toEqual(deleted)
  clearSharedSessions(directory)
  expect(storeSharedSessionAndPriorityAssignment(directory, publication("old"))).not.toBe(false)
  expect(storeSharedSessionAndPriorityAssignment(directory, publication("new"))).not.toBe(false)
  const protectedBefore = snapshotForExport(handle!.reader)
  expect(evictSharedSession(directory, "old", generation("old"))).toBe(false)
  expect(snapshotForExport(handle!.reader)).toEqual(protectedBefore)
})

it("clear: removes mapping/history/pins/exports/routes/rollbacks/attempts and advances all affected slots", async () => {
  legacy.storeSharedSession("imported", "id")
  await migrate()
  expect(handle!.reader.get("SELECT key FROM legacy_exports WHERE kind='mapping'")).toBeDefined()
  expect(evictSharedSession(directory, "imported")).toBe(true)
  expect(handle!.reader.get("SELECT key FROM legacy_exports WHERE kind='mapping'")).toBeUndefined()
  expect(storeSharedSessionAndPriorityAssignment(directory, publication("old"))).not.toBe(false)
  expect(storeSharedSessionAndPriorityAssignment(directory, publication("new"))).not.toBe(false)
  expect(claimPriorityAttempt(directory, { routeKey: "route", expectedAssignmentGeneration: priority().generation })).not.toBe(false)
  const keys = ["old", "new", "priority:route", "priority-attempt:route"]
  const slots = new Map<string, number>()
  for (const key of keys) {
    const slot = mappingDigest(key).slice(0, 4)
    slots.set(slot, Number(handle!.reader.get("SELECT counter FROM fence_slots WHERE namespace='store' AND slot=?", slot)?.counter ?? 0))
  }
  clearSharedSessions(directory)
  for (const table of ["mappings", "mapping_history", "mapping_pins", "legacy_exports", "priority_assignments", "priority_rollbacks", "priority_attempts"])
    expect(handle!.reader.get(`SELECT count(*) AS n FROM ${table}`)?.n).toBe(0)
  for (const [slot, before] of slots)
    expect(handle!.reader.get("SELECT counter FROM fence_slots WHERE namespace='store' AND slot=?", slot)?.counter)
      .toBe(before + keys.filter((key) => mappingDigest(key).slice(0, 4) === slot).length)
  const empty = snapshotForExport(handle!.reader)
  clearSharedSessions(directory)
  expect(snapshotForExport(handle!.reader)).toEqual(empty)
})

it("full backend: every store facade operation dispatches to migrated SQLite, JSON remains barred", async () => {
  legacy.storeSharedSession("seed", "seed-id")
  await migrate()
  legacy.setSessionStoreBackendForTest(sqliteSessionStoreBackend)
  expect(legacy.getSessionStoreDir()).toBe(directory)
  expect(legacy.getMaxStoredSessionsLimit()).toBeGreaterThan(0)
  expect(legacy.getMaxPriorityAssignmentsLimit()).toBeGreaterThan(0)
  expect(legacy.getMaxPriorityAttemptsLimit()).toBeGreaterThan(0)
  const stored = legacy.storeSharedSession("key", "id")
  if (!stored) throw new Error("store rejected")
  expect(stored).toBe(generation("key"))
  const found = legacy.lookupSharedSessionResult("key")
  expect(found.status).toBe("found")
  expect(legacy.lookupSharedSession("key")?.claudeSessionId).toBe("id")
  expect(legacy.lookupSharedSessionByClaudeIdResult("id").status).toBe("found")
  expect(legacy.lookupSharedSessionByClaudeId("id")?.claudeSessionId).toBe("id")
  expect(legacy.getStoredSessionGeneration(legacy.lookupSharedSession("key")!, "key")).toBe(stored)
  expect(legacy.attachSharedTranscriptLocator("key", "id", { sessionId: "id", configDir: directory })).not.toBe(false)
  expect(legacy.readSessionTranscriptPins()).toHaveLength(1)
  expect(legacy.readSessionStoreSnapshot().key?.claudeSessionId).toBe("id")
  expect(legacy.readSessionStoreGenerationSnapshot("key", ["p"]).key).toBe(generation("key"))
  expect(legacy.lookupSessionRecovery("key")?.claudeSessionId).toBe("id")
  expect(legacy.listStoredSessions().map((row) => row.key)).toContain("seed")
  const missing = legacy.lookupPriorityAssignmentResult("route")
  if (missing.status === "error") throw missing.error
  const first = legacy.claimPriorityAttempt({ routeKey: "route", expectedAssignmentGeneration: missing.generation })
  if (!first) throw new Error("claim rejected")
  expect(legacy.releasePriorityAttempt("route", first.ownerToken)).toBe(true)
  const second = legacy.claimPriorityAttempt({ routeKey: "route", expectedAssignmentGeneration: missing.generation })
  if (!second) throw new Error("claim rejected")
  expect(legacy.blockPriorityAttempt("route", second.ownerToken)).toBe(true)
  const third = legacy.claimPriorityAttempt({ routeKey: "route", expectedAssignmentGeneration: missing.generation,
    turn: { turnId: "a".repeat(43), issuedAt: 1 } })
  if (!third) throw new Error("claim rejected")
  const published = legacy.storeSharedSessionAndPriorityAssignment({ ...publication(), attemptOwnerToken: third.ownerToken })
  if (!published) throw new Error("publication rejected")
  const assigned = legacy.lookupPriorityAssignmentResult("route")
  if (assigned.status !== "found") throw new Error("assignment missing")
  expect(legacy.getPriorityAssignmentGeneration(assigned.assignment, "route")).toBe(published.assignmentGeneration)
  expect(legacy.finalizeSharedSessionAndPriorityAssignment({ key: "key", routeKey: "route",
    expectedMappingGeneration: published.mappingGeneration, expectedAssignmentGeneration: published.assignmentGeneration,
    attemptOwnerToken: third.ownerToken })).toBe(true)
  const next = legacy.storeSharedSessionAndPriorityAssignment(publication())
  if (!next) throw new Error("publication rejected")
  expect(legacy.rollbackSharedSessionAndPriorityAssignment({ key: "key", routeKey: "route",
    expectedMappingGeneration: next.mappingGeneration, expectedAssignmentGeneration: next.assignmentGeneration,
    previousMapping: next.previousMapping, previousAssignment: next.previousAssignment })).not.toBe(false)
  expect(legacy.evictSharedSession("key")).toBe(true)
  expect(mapping("key")).toBeUndefined()
  legacy.clearSharedSessions()
  expect(legacy.readSessionStoreSnapshot()).toEqual({})
  expect(handle!.reader.get("SELECT count(*) AS n FROM mappings")?.n).toBe(0)
})
