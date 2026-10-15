import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lookupSession, rollbackPrioritySessionPublication, storeSession, type PrioritySessionPublication } from "../proxy/session/cache"
import { computeLineageHash } from "../proxy/session/lineage"
import { claimPriorityAttempt, lookupPriorityAssignmentResult, lookupSharedSession, lookupSharedSessionResult, setSessionStoreDir } from "../proxy/sessionStore"
import { commitRawSession, readCommittedSession } from "./storeDatabaseHelpers"

const messages = [{ role: "user", content: "raw original objective" }]
const continuation = [...messages, { role: "assistant", content: "answer" }, { role: "user", content: "next question" }]

async function priorityPublication(routeKey: string): Promise<PrioritySessionPublication> {
  const route = lookupPriorityAssignmentResult(routeKey)
  if (route.status === "error") throw route.error
  const claim = await claimPriorityAttempt({ routeKey, expectedAssignmentGeneration: route.generation })
  if (!claim) throw new Error("fixture priority claim failed")
  return { routeKey, profileId: "work", lastHumanTurnDigest: "a".repeat(43), lastHumanTurnIssuedAt: 1_900_000_000,
    attemptOwnerToken: claim.ownerToken, expectedAssignmentGeneration: route.generation }
}

describe("durable raw proof and execution reuse proof", () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "meridian-execution-proof-"))
    setSessionStoreDir(directory)
  })
  afterEach(() => {
    setSessionStoreDir(null)
    rmSync(directory, { recursive: true, force: true })
  })

  it("ordinary transformed publication keeps raw continuation and strips inherited UUID/checkpoint authority", async () => {
    expect(await storeSession("ordinary", messages, "sdk-transformed", undefined,
      ["raw-user-uuid", "new-assistant-uuid", "unrelated-uuid"], undefined,
      "inherited-checkpoint", ["inherited-tool"], undefined, undefined, undefined, undefined, false)).not.toBe(false)
    const stored = lookupSharedSession("ordinary")
    expect(stored).toMatchObject({ messageCount: 1, lineageHash: "", clientLineageHash: computeLineageHash(messages),
      sdkMessageUuids: [null, "new-assistant-uuid", null] })
    expect(stored?.passthroughToolCallAssistantUuid).toBeUndefined()
    expect(stored?.passthroughToolCallIds).toBeUndefined()
    expect(lookupSession("ordinary", continuation).type).toBe("continuation")
    // Reset the disk cache, then load from the serialized record.
    setSessionStoreDir(null)
    setSessionStoreDir(directory)
    expect(lookupSession("ordinary", continuation).type).toBe("continuation")
    const serialized = readCommittedSession(directory, "ordinary")
    expect(serialized?.clientLineageHash).toBe(computeLineageHash(messages))
    expect(serialized?.lineageHash).toBe("")

    expect(await storeSession("ordinary", continuation, "sdk-full-replay")).not.toBe(false)
    const restored = lookupSharedSession("ordinary")
    expect(restored?.lineageHash).toBe(computeLineageHash(continuation))
    expect(restored?.clientLineageHash).toBeUndefined()
    expect(readCommittedSession(directory, "ordinary")?.clientLineageHash).toBeUndefined()
  })

  it("priority atomic publication, reload and rollback retain distinct proofs", async () => {
    await storeSession("work:priority", messages, "sdk-transformed", undefined, [null, "current-only"], undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, false)
    const before = lookupSharedSessionResult("work:priority")
    if (before.status !== "found") throw new Error("fixture mapping missing")
    const publication = await priorityPublication("priority")
    expect(await storeSession("work:priority", continuation, "sdk-full-replay", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, before.generation, publication)).not.toBe(false)
    expect(lookupSharedSession("work:priority")?.clientLineageHash).toBeUndefined()
    expect(lookupSharedSession("work:priority")?.lineageHash).toBe(computeLineageHash(continuation))
    expect(await rollbackPrioritySessionPublication("work:priority", continuation, undefined, publication)).not.toBe(false)
    const restored = lookupSharedSession("work:priority")
    expect(restored?.lineageHash).toBe("")
    expect(restored?.clientLineageHash).toBe(computeLineageHash(messages))
    expect(restored?.sdkMessageUuids).toEqual([null, "current-only"])
    setSessionStoreDir(null)
    setSessionStoreDir(directory)
    expect(lookupSession("work:priority", continuation).type).toBe("continuation")
  })

  it("priority transformed publication clears checkpoint proof in the atomic stored record", async () => {
    const mapping = lookupSharedSessionResult("work:transformed-priority")
    if (mapping.status === "error") throw mapping.error
    const publication = await priorityPublication("transformed-priority")
    expect(await storeSession("work:transformed-priority", messages, "sdk-priority", undefined,
      ["old-user", "new-assistant"], undefined, "old-checkpoint", ["old-tool"], undefined,
      undefined, mapping.generation, publication, false)).not.toBe(false)
    const stored = lookupSharedSession("work:transformed-priority")
    expect(stored?.lineageHash).toBe("")
    expect(stored?.clientLineageHash).toBe(computeLineageHash(messages))
    expect(stored?.sdkMessageUuids).toEqual([null, "new-assistant"])
    expect(stored?.passthroughToolCallAssistantUuid).toBeUndefined()
    expect(stored?.passthroughToolCallIds).toBeUndefined()
  })

  it("fails closed on malformed persisted raw proof rather than granting SDK resume", async () => {
    await storeSession("malformed", messages, "sdk-malformed", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, false)
    const entry = readCommittedSession(directory, "malformed")
    if (!entry) throw new Error("fixture mapping missing")
    commitRawSession(directory, "malformed", { ...entry, clientLineageHash: 7 })
    setSessionStoreDir(null)
    setSessionStoreDir(directory)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(lookupSharedSessionResult("malformed").status).toBe("error")
    } finally { errors.mockRestore() }
  })
})
