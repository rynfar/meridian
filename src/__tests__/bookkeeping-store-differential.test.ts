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
it("runs the same store/priority ledger on JSON and SQLite with exact step results", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-differential-")))
  const limits = ["MERIDIAN_MAX_STORED_SESSIONS", "MERIDIAN_MAX_PRIORITY_ASSIGNMENTS",
    "MERIDIAN_MAX_PRIORITY_ATTEMPTS"] as const
  const previous = limits.map((name) => process.env[name])
  let step = 0
  const clock = spyOn(Date, "now").mockImplementation(() => 1_900_000_000_000 + step)
  const uuid = spyOn(crypto, "randomUUID").mockImplementation(() =>
    `00000000-0000-4000-8000-${step.toString(16).padStart(12, "0")}`)
  const execute = () => {
    step = 0
    for (const name of limits) process.env[name] = "20"
    const results: Array<{ name: string; result: unknown }> = []
    function run<T>(name: string, operation: () => T): T {
      step++
      const value = operation()
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
    const publish = (key: string, route: string, owner?: string) => store.storeSharedSessionAndPriorityAssignment({
      key, claudeSessionId: `sdk-${key}`, messageCount: 2, lineageHash: "lineage",
      messageHashes: ["a", "b"], messageBlockHashes: [["a"], ["b"]],
      expectedMappingGeneration: mapping(key), attemptOwnerToken: owner,
      priority: { routeKey: route, profileId: "p", lastHumanTurnDigest: "a".repeat(43),
        lastHumanTurnIssuedAt: 1, expectedAssignmentGeneration: priority(route) },
    })
    run("store", () => store.storeSharedSession("key", "sdk-key"))
    run("CAS conflict", () => store.storeSharedSession("key", "wrong", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, null))
    run("CAS exact", () => store.storeSharedSession("key", "sdk-key", 2, undefined, ["history"],
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, mapping("key")))
    const claim = run("claim", () => store.claimPriorityAttempt({ routeKey: "route",
      expectedAssignmentGeneration: priority("route"), turn: { turnId: "a".repeat(43), issuedAt: 1 } }))
    if (!claim) throw new Error("claim fixture")
    const stranger = "11111111-1111-4111-8111-111111111111"
    run("block foreign", () => store.blockPriorityAttempt("route", stranger))
    run("release foreign", () => store.releasePriorityAttempt("route", stranger))
    run("block own", () => store.blockPriorityAttempt("route", claim.ownerToken))
    run("release settled", () => store.releasePriorityAttempt("route", claim.ownerToken))
    const second = run("newer claim", () => store.claimPriorityAttempt({ routeKey: "route",
      expectedAssignmentGeneration: priority("route"), turn: { turnId: "b".repeat(43), issuedAt: 2 } }))
    if (!second) throw new Error("second claim fixture")
    run("release own", () => store.releasePriorityAttempt("route", second.ownerToken))
    run("clear blocker", () => store.clearSharedSessions())
    run("seed fallback", () => publish("fallback", "route"))
    const promoted = run("publish", () => publish("promoted", "route"))
    if (!promoted) throw new Error("publication fixture")
    run("evict rollback", () => store.evictSharedSession("fallback", mapping("fallback")))
    run("rollback stale", () => store.rollbackSharedSessionAndPriorityAssignment({
      key: "promoted", routeKey: "route",
      expectedMappingGeneration: "stale", expectedAssignmentGeneration: promoted.assignmentGeneration,
      previousMapping: promoted.previousMapping, previousAssignment: promoted.previousAssignment }))
    run("rollback", () => store.rollbackSharedSessionAndPriorityAssignment({ key: "promoted", routeKey: "route",
      expectedMappingGeneration: promoted.mappingGeneration, expectedAssignmentGeneration: promoted.assignmentGeneration,
      previousMapping: promoted.previousMapping, previousAssignment: promoted.previousAssignment }))
    const final = run("republish", () => publish("promoted", "route"))
    if (!final) throw new Error("final publication fixture")
    run("finalize stale", () => store.finalizeSharedSessionAndPriorityAssignment({ key: "promoted", routeKey: "route",
      expectedMappingGeneration: "stale", expectedAssignmentGeneration: final.assignmentGeneration,
      rollbackMappingKey: "fallback" }))
    run("finalize", () => store.finalizeSharedSessionAndPriorityAssignment({ key: "promoted", routeKey: "route",
      expectedMappingGeneration: final.mappingGeneration, expectedAssignmentGeneration: final.assignmentGeneration,
      rollbackMappingKey: "fallback" }))
    run("attach", () => store.attachSharedTranscriptLocator("promoted", "sdk-promoted",
      { configDir: directory, sessionId: "sdk-promoted" }, mapping("promoted")))
    run("pins before eviction", () => store.readSessionTranscriptPins())
    run("evict live assignment", () => store.evictSharedSession("promoted", mapping("promoted")))
    run("assignment survives", () => store.lookupPriorityAssignmentResult("route"))
    run("clear", () => store.clearSharedSessions())
    process.env.MERIDIAN_MAX_STORED_SESSIONS = "1"
    run("mapping cap first", () => store.storeSharedSession("old", "old"))
    run("mapping cap second", () => store.storeSharedSession("new", "new"))
    run("pruned mapping", () => store.lookupSharedSessionResult("old"))
    process.env.MERIDIAN_MAX_STORED_SESSIONS = "20"
    process.env.MERIDIAN_MAX_PRIORITY_ASSIGNMENTS = "1"
    run("route cap first", () => publish("one", "one"))
    run("route cap second", () => publish("two", "two"))
    run("pruned route", () => store.lookupPriorityAssignmentResult("one"))
    process.env.MERIDIAN_MAX_PRIORITY_ATTEMPTS = "1"
    run("attempt cap first", () => store.claimPriorityAttempt({ routeKey: "one",
      expectedAssignmentGeneration: priority("one") }))
    run("attempt cap reject", () => store.claimPriorityAttempt({ routeKey: "two",
      expectedAssignmentGeneration: priority("two") }))
    run("recovery", () => store.lookupSessionRecovery("two"))
    run("list", () => store.listStoredSessions())
    run("snapshot", () => store.readSessionStoreSnapshot())
    run("generations", () => store.readSessionStoreGenerationSnapshot("two", ["p", "default"]))
    run("pins", () => store.readSessionTranscriptPins())
    run("final clear", () => store.clearSharedSessions())
    run("empty snapshot", () => store.readSessionStoreSnapshot())
    run("empty generations", () => store.readSessionStoreGenerationSnapshot("two", ["p"]))
    run("empty pins", () => store.readSessionTranscriptPins())
    return results
  }
  let handle: ReturnType<typeof initializeSessionBookkeeping> | undefined
  try {
    store.setSessionStoreBackendForTest(null)
    store.setSessionStoreDir(directory)
    const json = execute()
    // A fresh SQL store starts with the same absence authority as a fresh JSON store.
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { mode: 0o700 })
    handle = initializeSessionBookkeeping(directory)
    store.setSessionStoreBackendForTest(sqliteSessionStoreBackend)
    const sql = execute()
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
