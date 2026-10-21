import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initializeSessionBookkeeping, withBookkeepingWrite, type BookkeepingHandle } from "../proxy/session/bookkeeping/database"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { exportBookkeepingJson } from "../proxy/session/bookkeeping/exportJson"
import { STORE_META_KEY } from "../proxy/session/bookkeeping/legacyCodec"
import { sqliteSessionStoreBackend } from "../proxy/session/bookkeeping/sqliteStoreBackend"
import { claimPriorityAttempt, lookupPriorityAssignmentResult, lookupSharedSessionResult,
  rollbackSharedSessionAndPriorityAssignment, setSessionStoreBackendForTest, setSessionStoreDir,
  storeSharedSession, storeSharedSessionAndPriorityAssignment } from "../proxy/sessionStore"

let directory: string
let handle: BookkeepingHandle | undefined
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bookkeeping-lineage-context-"))
  setSessionStoreDir(directory)
})
afterEach(() => {
  setSessionStoreBackendForTest(null)
  handle?.close()
  handle = undefined
  setSessionStoreDir(null)
  rmSync(directory, { recursive: true, force: true })
})
function open() {
  handle = initializeSessionBookkeeping(directory)
  setSessionStoreBackendForTest(sqliteSessionStoreBackend)
}
function reopen() {
  setSessionStoreBackendForTest(null)
  handle?.close()
  open()
}
function session() {
  const result = lookupSharedSessionResult("key")
  if (result.status !== "found") throw new Error("owned fixture mapping is not readable")
  return result.session
}
async function store(client?: string | null, context?: string | null, id = "owned-session") {
  return (await storeSharedSession("key", id, 1, "execution", ["owned-history"],
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, client, context))
}

it("preserves current-main proofs through explicit migration, native reopen and latest-state export", async () => {
  writeFileSync(join(directory, "sessions.json"), JSON.stringify({
    [STORE_META_KEY]: { version: 1, slots: {} },
    key: { claudeSessionId: "owned-import", generationId: randomUUID(), revision: 1,
      createdAt: 1, lastUsedAt: 2, messageCount: 1, lineageHash: "execution",
      clientLineageHash: "owned-client", resumeContextHash: "a".repeat(64) },
  }), { mode: 0o600 })
  await migrateBookkeeping(directory, { writersStopped: true })
  open()
  expect(session()).toMatchObject({ clientLineageHash: "owned-client", resumeContextHash: "a".repeat(64) })
  reopen()
  expect(session()).toMatchObject({ clientLineageHash: "owned-client", resumeContextHash: "a".repeat(64) })
  setSessionStoreBackendForTest(null)
  handle?.close()
  handle = undefined
  exportBookkeepingJson(directory)
  const exported = JSON.parse(readFileSync(join(directory, "sessions.json"), "utf8"))
  expect(exported.key).toMatchObject({ clientLineageHash: "owned-client", resumeContextHash: "a".repeat(64) })
})

it("preserves omitted proofs, clears the agent proof on a new SDK session and honors explicit null", async () => {
  open()
  expect((await store("owned-client", "a".repeat(64)))).not.toBe(false)
  expect((await store())).not.toBe(false)
  reopen()
  expect(session()).toMatchObject({ clientLineageHash: "owned-client", resumeContextHash: "a".repeat(64) })
  expect((await store(undefined, undefined, "owned-new-session"))).not.toBe(false)
  expect(session().resumeContextHash).toBeUndefined()
  expect((await store("owned-new-client", "b".repeat(64)))).not.toBe(false)
  expect((await store(null, null))).not.toBe(false)
  reopen()
  expect(session().clientLineageHash).toBeUndefined()
  expect(session().resumeContextHash).toBeUndefined()
})

it("publishes both proofs atomically and restores the original pair on priority rollback", async () => {
  open()
  const original = (await store("owned-original", "a".repeat(64)))
  if (!original) throw new Error("fixture publication failed")
  const route = lookupPriorityAssignmentResult("owned-route")
  if (route.status === "error") throw route.error
  const claim = (await claimPriorityAttempt({ routeKey: "owned-route", expectedAssignmentGeneration: route.generation }))
  if (!claim) throw new Error("fixture claim failed")
  const published = (await storeSharedSessionAndPriorityAssignment({
    key: "key", claudeSessionId: "owned-priority", messageCount: 1, lineageHash: "execution",
    clientLineageHash: "owned-revised", resumeContextHash: "b".repeat(64),
    messageHashes: ["owned-history"], messageBlockHashes: [["owned-block"]],
    expectedMappingGeneration: original, attemptOwnerToken: claim.ownerToken,
    priority: { routeKey: "owned-route", profileId: "work", lastHumanTurnDigest: "d".repeat(43),
      lastHumanTurnIssuedAt: 1, expectedAssignmentGeneration: route.generation },
  }))
  if (!published) throw new Error("fixture atomic publication failed")
  reopen()
  expect(session()).toMatchObject({ clientLineageHash: "owned-revised", resumeContextHash: "b".repeat(64) })
  expect((await rollbackSharedSessionAndPriorityAssignment({
    key: "key", routeKey: "owned-route", expectedMappingGeneration: published.mappingGeneration,
    expectedAssignmentGeneration: published.assignmentGeneration,
    previousMapping: published.previousMapping, previousAssignment: published.previousAssignment,
    attemptOwnerToken: claim.ownerToken,
  }))).not.toBe(false)
  reopen()
  expect(session()).toMatchObject({ clientLineageHash: "owned-original", resumeContextHash: "a".repeat(64) })
})

it.each([
  { clientLineageHash: 17 },
  { resumeContextHash: "not-a-digest" },
])("fails closed on malformed modern proof payload %j", async (payload) => {
  open()
  await store()
  withBookkeepingWrite(directory, { scope: "store" }, tx => {
    tx.run("UPDATE mapping_history SET history_json=? WHERE mapping_key='key'", JSON.stringify(payload))
  })
  const log = spyOn(console, "error").mockImplementation(() => {})
  try { expect(lookupSharedSessionResult("key").status).toBe("error") }
  finally { log.mockRestore() }
})
