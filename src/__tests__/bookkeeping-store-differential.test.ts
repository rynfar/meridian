import { expect, it, spyOn } from "bun:test"
import * as crypto from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as store from "../proxy/sessionStore"
import { initializeSessionBookkeeping } from "../proxy/session/bookkeeping/database"
import { sqliteSessionStoreBackend } from "../proxy/session/bookkeeping/sqliteStoreBackend"

// Inject identical entropy per semantic operation, not per internal call (JSON file names also use UUIDs).
// No returned token, timestamp, array order or false outcome is normalized away.
it("runs the same store/priority ledger on JSON and SQLite with exact step results", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-differential-")))
  const limits = ["MERIDIAN_MAX_STORED_SESSIONS", "MERIDIAN_MAX_PRIORITY_ASSIGNMENTS",
    "MERIDIAN_MAX_PRIORITY_ATTEMPTS"] as const
  const previous = limits.map((name) => process.env[name])
  let step = 0
  const clock = spyOn(Date, "now").mockImplementation(() => 1_900_000_000_000 + step)
  const uuid = spyOn(crypto, "randomUUID").mockImplementation(() =>
    `00000000-0000-4000-8000-${step.toString(16).padStart(12, "0")}`)
  const execute = async () => {
    step = 0
    for (const name of limits) process.env[name] = "20"
    const results: Array<{ name: string; result: unknown }> = []
    async function run<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
      step++
      const value = await operation()
      results.push({ name, result: structuredClone(value) })
      return value
    }
    const mapping = (key: string) => {
      const found = store.lookupSharedSessionResult(key)
      if (found.status === "error" || !found.generation) throw new Error("missing generation")
      return found.generation
    }
    const priority = (route: string) => {
      const found = store.lookupPriorityAssignmentResult(route)
      if (found.status === "error") throw found.error
      return found.generation
    }
    const publish = async (key: string, route: string, owner?: string) => (await store.storeSharedSessionAndPriorityAssignment({
      key, claudeSessionId: `sdk-${key}`, messageCount: 2, lineageHash: "lineage",
      messageHashes: ["a", "b"], messageBlockHashes: [["a"], ["b"]],
      expectedMappingGeneration: mapping(key), attemptOwnerToken: owner,
      priority: { routeKey: route, profileId: "p", lastHumanTurnDigest: "a".repeat(43),
        lastHumanTurnIssuedAt: 1, expectedAssignmentGeneration: priority(route) },
    }))
    await run("store", async () => (await store.storeSharedSession("key", "sdk-key")))
    await run("CAS conflict", async () => (await store.storeSharedSession("key", "wrong", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, null)))
    await run("CAS exact", async () => (await store.storeSharedSession("key", "sdk-key", 2, undefined, ["history"],
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, mapping("key"))))
    const claim = await run("claim", async () => (await store.claimPriorityAttempt({ routeKey: "route",
      expectedAssignmentGeneration: priority("route"), turn: { turnId: "a".repeat(43), issuedAt: 1 } })))
    if (!claim) throw new Error("claim fixture")
    const stranger = "11111111-1111-4111-8111-111111111111"
    await run("block foreign", async () => (await store.blockPriorityAttempt("route", stranger)))
    await run("release foreign", async () => (await store.releasePriorityAttempt("route", stranger)))
    await run("block own", async () => (await store.blockPriorityAttempt("route", claim.ownerToken)))
    await run("release settled", async () => (await store.releasePriorityAttempt("route", claim.ownerToken)))
    const second = await run("newer claim", async () => (await store.claimPriorityAttempt({ routeKey: "route",
      expectedAssignmentGeneration: priority("route"), turn: { turnId: "b".repeat(43), issuedAt: 2 } })))
    if (!second) throw new Error("second claim fixture")
    await run("release own", async () => (await store.releasePriorityAttempt("route", second.ownerToken)))
    await run("clear blocker", async () => (await store.clearSharedSessions()))
    await run("seed fallback", async () => (await publish("fallback", "route")))
    const promoted = await run("publish", async () => (await publish("promoted", "route")))
    if (!promoted) throw new Error("publication fixture")
    await run("evict rollback", async () => (await store.evictSharedSession("fallback", mapping("fallback"))))
    await run("rollback stale", async () => (await store.rollbackSharedSessionAndPriorityAssignment({
      key: "promoted", routeKey: "route",
      expectedMappingGeneration: "stale", expectedAssignmentGeneration: promoted.assignmentGeneration,
      previousMapping: promoted.previousMapping, previousAssignment: promoted.previousAssignment })))
    await run("rollback", async () => (await store.rollbackSharedSessionAndPriorityAssignment({ key: "promoted", routeKey: "route",
      expectedMappingGeneration: promoted.mappingGeneration, expectedAssignmentGeneration: promoted.assignmentGeneration,
      previousMapping: promoted.previousMapping, previousAssignment: promoted.previousAssignment })))
    const final = await run("republish", async () => (await publish("promoted", "route")))
    if (!final) throw new Error("final publication fixture")
    await run("finalize stale", async () => (await store.finalizeSharedSessionAndPriorityAssignment({ key: "promoted", routeKey: "route",
      expectedMappingGeneration: "stale", expectedAssignmentGeneration: final.assignmentGeneration,
      rollbackMappingKey: "fallback" })))
    await run("finalize", async () => (await store.finalizeSharedSessionAndPriorityAssignment({ key: "promoted", routeKey: "route",
      expectedMappingGeneration: final.mappingGeneration, expectedAssignmentGeneration: final.assignmentGeneration,
      rollbackMappingKey: "fallback" })))
    await run("attach", async () => (await store.attachSharedTranscriptLocator("promoted", "sdk-promoted",
      { configDir: directory, sessionId: "sdk-promoted" }, mapping("promoted"))))
    await run("pins before eviction", () => store.readSessionTranscriptPins())
    await run("evict live assignment", async () => (await store.evictSharedSession("promoted", mapping("promoted"))))
    await run("assignment survives", () => store.lookupPriorityAssignmentResult("route"))
    await run("clear", async () => (await store.clearSharedSessions()))
    process.env.MERIDIAN_MAX_STORED_SESSIONS = "1"
    await run("mapping cap first", async () => (await store.storeSharedSession("old", "old")))
    await run("mapping cap second", async () => (await store.storeSharedSession("new", "new")))
    await run("pruned mapping", () => store.lookupSharedSessionResult("old"))
    process.env.MERIDIAN_MAX_STORED_SESSIONS = "20"
    process.env.MERIDIAN_MAX_PRIORITY_ASSIGNMENTS = "1"
    await run("route cap first", async () => (await publish("one", "one")))
    await run("route cap second", async () => (await publish("two", "two")))
    await run("pruned route", () => store.lookupPriorityAssignmentResult("one"))
    process.env.MERIDIAN_MAX_PRIORITY_ATTEMPTS = "1"
    await run("attempt cap first", async () => (await store.claimPriorityAttempt({ routeKey: "one",
      expectedAssignmentGeneration: priority("one") })))
    await run("attempt cap reject", async () => (await store.claimPriorityAttempt({ routeKey: "two",
      expectedAssignmentGeneration: priority("two") })))
    await run("recovery", () => store.lookupSessionRecovery("two"))
    await run("list", () => store.listStoredSessions())
    await run("snapshot", () => store.readSessionStoreSnapshot())
    await run("generations", () => store.readSessionStoreGenerationSnapshot("two", ["p", "default"]))
    await run("pins", () => store.readSessionTranscriptPins())
    await run("final clear", async () => (await store.clearSharedSessions()))
    await run("empty snapshot", () => store.readSessionStoreSnapshot())
    await run("empty generations", () => store.readSessionStoreGenerationSnapshot("two", ["p"]))
    await run("empty pins", () => store.readSessionTranscriptPins())
    return results
  }
  let handle: ReturnType<typeof initializeSessionBookkeeping> | undefined
  try {
    store.setSessionStoreBackendForTest(null)
    store.setSessionStoreDir(directory)
    const json = await execute()
    // A fresh SQL store starts with the same absence authority as a fresh JSON store.
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { mode: 0o700 })
    handle = initializeSessionBookkeeping(directory)
    store.setSessionStoreBackendForTest(sqliteSessionStoreBackend)
    const sql = await execute()
    expect(sql.length).toBe(json.length)
    for (let index = 0; index < json.length; index++) expect(sql[index]).toEqual(json[index])
  } finally {
    store.setSessionStoreBackendForTest(null)
    handle?.close()
    store.setSessionStoreDir(null)
    clock.mockRestore()
    uuid.mockRestore()
    limits.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    })
    rmSync(directory, { recursive: true, force: true })
  }
})
