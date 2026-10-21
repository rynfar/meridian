import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"
import { getConversationFingerprint } from "../proxy/session/fingerprint"
import { join } from "node:path"
import { clearSessionCache, lookupSession, rollbackPrioritySessionPublication, storeSession, type PrioritySessionPublication } from "../proxy/session/cache"
import { computeLineageHash } from "../proxy/session/lineage"
import { openCodePrimaryAgentContextHash } from "../proxy/adapters/opencodeAgentContext"
import { claimPriorityAttempt, lookupPriorityAssignmentResult, lookupSharedSession, lookupSharedSessionResult, setSessionStoreDir } from "../proxy/sessionStore"

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
    const serialized = JSON.parse(readFileSync(join(directory, "sessions.json"), "utf8"))
    expect(serialized.ordinary.clientLineageHash).toBe(computeLineageHash(messages))
    expect(serialized.ordinary.lineageHash).toBe("")

    expect(await storeSession("ordinary", continuation, "sdk-full-replay")).not.toBe(false)
    const restored = lookupSharedSession("ordinary")
    expect(restored?.lineageHash).toBe(computeLineageHash(continuation))
    expect(restored?.clientLineageHash).toBeUndefined()
    expect(JSON.parse(readFileSync(join(directory, "sessions.json"), "utf8")).ordinary.clientLineageHash).toBeUndefined()
  })

  it("priority atomic publication, reload and rollback retain distinct proofs", async () => {
    const originalSystem = openCodePrimaryAgentContextHash("primary", "build")
    const revisedSystem = openCodePrimaryAgentContextHash("primary", "reviewer")
    await storeSession("work:priority", messages, "sdk-transformed", undefined, [null, "current-only"], undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, false, originalSystem)
    const before = lookupSharedSessionResult("work:priority")
    if (before.status !== "found") throw new Error("fixture mapping missing")
    const publication = (await priorityPublication("priority"))
    expect((await storeSession("work:priority", continuation, "sdk-full-replay", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, before.generation, publication, true, revisedSystem))).not.toBe(false)
    expect(lookupSharedSession("work:priority")?.resumeContextHash).toBe(revisedSystem)
    expect(lookupSharedSession("work:priority")?.clientLineageHash).toBeUndefined()
    expect(lookupSharedSession("work:priority")?.lineageHash).toBe(computeLineageHash(continuation))
    expect(await rollbackPrioritySessionPublication("work:priority", continuation, undefined, publication)).not.toBe(false)
    const restored = lookupSharedSession("work:priority")
    expect(restored?.lineageHash).toBe("")
    expect(restored?.clientLineageHash).toBe(computeLineageHash(messages))
    expect(restored?.sdkMessageUuids).toEqual([null, "current-only"])
    expect(restored?.resumeContextHash).toBe(originalSystem)
    setSessionStoreDir(null)
    setSessionStoreDir(directory)
    const reloaded = lookupSession("work:priority", continuation)
    expect(reloaded.type).toBe("continuation")
    if (reloaded.type === "diverged") throw new Error("Expected restored mapping")
    expect(reloaded.session.resumeContextHash).toBe(originalSystem)
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

  it("fails closed on malformed persisted adapter context proof", async () => {
    await storeSession("malformed-system", messages, "sdk-malformed-system")
    const file = join(directory, "sessions.json")
    const document = JSON.parse(readFileSync(file, "utf8"))
    document["malformed-system"].resumeContextHash = "not-a-digest"
    writeFileSync(file, JSON.stringify(document))
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try { expect(lookupSharedSessionResult("malformed-system").status).toBe("error") }
    finally { errors.mockRestore() }
  })

  it("captures the headerless rollback key before an ordered JSON write yields", async () => {
    const history = [{ role: "user", content: "headerless rollback original objective" }]
    const originalHistory = structuredClone(history)
    const cwd = "/fixture/headerless-rollback"
    const key = getConversationFingerprint(history, cwd)
    await storeSession(undefined, history, "sdk-before", cwd)
    const before = lookupSharedSessionResult(key)
    if (before.status !== "found") throw new Error("fixture mapping missing")
    const publication = await priorityPublication("headerless-rollback")
    expect(await storeSession(undefined, history, "sdk-published", cwd, undefined, undefined,
      undefined, undefined, undefined, undefined, before.generation, publication)).not.toBe(false)

    const incarnation = captureProcessIncarnation()
    if (!incarnation) throw new Error("fixture lock owner unavailable")
    const path = join(directory, "sessions.json")
    const lockPath = path + ".lock"
    const token = JSON.stringify({ pid: process.pid, hostname: hostname(), token: randomUUID(), incarnation })
    writeFileSync(lockPath, token, { flag: "wx", mode: 0o600 })
    const pending = rollbackPrioritySessionPublication(undefined, history, cwd, publication)
    try {
      expect(pending).toBeInstanceOf(Promise)
      history[0]!.content = "caller changed its input while rollback waited"
      expect(lookupSharedSession(key)?.claudeSessionId).toBe("sdk-published")
    } finally {
      if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath)
      await pending
    }
    expect(lookupSharedSession(key)?.claudeSessionId).toBe("sdk-before")
    // Force the genuine store-error fallback so disk reads cannot hide a stale LRU.
    const stored = readFileSync(path, "utf8")
    writeFileSync(path, "controlled read failure")
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const result = lookupSession(undefined, [...originalHistory,
        { role: "assistant", content: "answer" }, { role: "user", content: "next" }], cwd)
      expect(result.type).toBe("continuation")
      if (result.type !== "continuation") throw new Error("Expected restored fallback")
      expect(result.session.claudeSessionId).toBe("sdk-before")
    } finally {
      errors.mockRestore()
      writeFileSync(path, stored)
    }
  })

  it.each(["pending-clear", undefined])("clears JSON fallback repopulated while durable cleanup waits (%s)", async (key) => {
    const cwd = "/fixture/pending-json-clear"
    await storeSession(key, messages, "old-sdk", cwd)
    const incarnation = captureProcessIncarnation()
    if (!incarnation) throw new Error("fixture lock owner unavailable")
    const path = join(directory, "sessions.json")
    const lockPath = path + ".lock"
    const token = JSON.stringify({ pid: process.pid, hostname: hostname(), token: randomUUID(), incarnation })
    writeFileSync(lockPath, token, { flag: "wx", mode: 0o600 })
    const pending = clearSessionCache()
    const later = storeSession("later", messages, "later-sdk", cwd)
    try {
      expect(pending).toBeInstanceOf(Promise)
      // A synchronous read can populate memory from the still-authoritative disk record.
      const during = lookupSession(key, continuation, cwd)
      expect(during.type).toBe("continuation")
    } finally {
      if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath)
      await Promise.all([pending, later])
    }
    expect(lookupSharedSessionResult(key ?? getConversationFingerprint(messages, cwd)).status).toBe("missing")
    const stored = readFileSync(path, "utf8")
    writeFileSync(path, "controlled read failure")
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(lookupSession(key, continuation, cwd).type).toBe("diverged")
      const newest = lookupSession("later", continuation, cwd)
      expect(newest.type).toBe("continuation")
      if (newest.type !== "continuation") throw new Error("Later publication lost")
      expect(newest.session.claudeSessionId).toBe("later-sdk")
    } finally {
      errors.mockRestore()
      writeFileSync(path, stored)
    }
  })
})
