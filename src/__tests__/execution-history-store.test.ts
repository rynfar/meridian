import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lookupSession, rollbackPrioritySessionPublication, storeSession, type PrioritySessionPublication } from "../proxy/session/cache"
import { computeLineageHash } from "../proxy/session/lineage"
import { claimPriorityAttempt, lookupPriorityAssignmentResult, lookupSharedSession, lookupSharedSessionResult, setSessionStoreDir } from "../proxy/sessionStore"

const messages = [{ role: "user", content: "raw original objective" }]
const continuation = [...messages, { role: "assistant", content: "answer" }, { role: "user", content: "next question" }]

function priorityPublication(routeKey: string): PrioritySessionPublication {
  const route = lookupPriorityAssignmentResult(routeKey)
  if (route.status === "error") throw route.error
  const claim = claimPriorityAttempt({ routeKey, expectedAssignmentGeneration: route.generation })
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

  it("ordinary transformed publication keeps raw continuation and strips inherited UUID/checkpoint authority", () => {
    expect(storeSession("ordinary", messages, "sdk-transformed", undefined,
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
    const serialized = JSON.parse(readFileSync(join(directory, "sessions.json"), "utf8"))
    expect(serialized.ordinary.clientLineageHash).toBe(computeLineageHash(messages))
    expect(serialized.ordinary.lineageHash).toBe("")

    expect(storeSession("ordinary", continuation, "sdk-full-replay")).not.toBe(false)
    const restored = lookupSharedSession("ordinary")
    expect(restored?.lineageHash).toBe(computeLineageHash(continuation))
    expect(restored?.clientLineageHash).toBeUndefined()
    expect(JSON.parse(readFileSync(join(directory, "sessions.json"), "utf8")).ordinary.clientLineageHash).toBeUndefined()
  })

  it("priority atomic publication, reload and rollback retain distinct proofs", () => {
    storeSession("work:priority", messages, "sdk-transformed", undefined, [null, "current-only"], undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, false)
    const before = lookupSharedSessionResult("work:priority")
    if (before.status !== "found") throw new Error("fixture mapping missing")
    const publication = priorityPublication("priority")
    expect(storeSession("work:priority", continuation, "sdk-full-replay", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, before.generation, publication)).not.toBe(false)
    expect(lookupSharedSession("work:priority")?.clientLineageHash).toBeUndefined()
    expect(lookupSharedSession("work:priority")?.lineageHash).toBe(computeLineageHash(continuation))
    expect(rollbackPrioritySessionPublication("work:priority", continuation, undefined, publication)).not.toBe(false)
    const restored = lookupSharedSession("work:priority")
    expect(restored?.lineageHash).toBe("")
    expect(restored?.clientLineageHash).toBe(computeLineageHash(messages))
    expect(restored?.sdkMessageUuids).toEqual([null, "current-only"])
    setSessionStoreDir(null)
    setSessionStoreDir(directory)
    expect(lookupSession("work:priority", continuation).type).toBe("continuation")
  })

  it("priority transformed publication clears checkpoint proof in the atomic stored record", () => {
    const mapping = lookupSharedSessionResult("work:transformed-priority")
    if (mapping.status === "error") throw mapping.error
    const publication = priorityPublication("transformed-priority")
    expect(storeSession("work:transformed-priority", messages, "sdk-priority", undefined,
      ["old-user", "new-assistant"], undefined, "old-checkpoint", ["old-tool"], undefined,
      undefined, mapping.generation, publication, false)).not.toBe(false)
    const stored = lookupSharedSession("work:transformed-priority")
    expect(stored?.lineageHash).toBe("")
    expect(stored?.clientLineageHash).toBe(computeLineageHash(messages))
    expect(stored?.sdkMessageUuids).toEqual([null, "new-assistant"])
    expect(stored?.passthroughToolCallAssistantUuid).toBeUndefined()
    expect(stored?.passthroughToolCallIds).toBeUndefined()
  })

  it("fails closed on malformed persisted raw proof rather than granting SDK resume", () => {
    storeSession("malformed", messages, "sdk-malformed", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, false)
    const file = join(directory, "sessions.json")
    const document = JSON.parse(readFileSync(file, "utf8"))
    document.malformed.clientLineageHash = 7
    writeFileSync(file, JSON.stringify(document))
    setSessionStoreDir(null)
    setSessionStoreDir(directory)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(lookupSharedSessionResult("malformed").status).toBe("error")
    } finally { errors.mockRestore() }
  })
})
