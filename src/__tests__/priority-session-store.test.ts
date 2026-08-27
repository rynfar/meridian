import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearSharedSessions,
  lookupPriorityAssignmentResult,
  lookupSharedSession,
  lookupSharedSessionResult,
  rollbackSharedSessionAndPriorityAssignment,
  setSessionStoreDir,
  storeSharedSession,
  storeSharedSessionAndPriorityAssignment,
} from "../proxy/sessionStore"

const META_KEY = "\u0000meridian-session-store"
const HUMAN_A = "a".repeat(43)
const HUMAN_B = "b".repeat(43)

function atomicPublish(input: {
  routeKey: string
  mappingKey: string
  profileId: string
  sdkSessionId: string
  digest: string
}) {
  const mapping = lookupSharedSessionResult(input.mappingKey)
  const route = lookupPriorityAssignmentResult(input.routeKey)
  if (mapping.status === "error" || !mapping.generation) throw new Error("mapping lookup failed")
  if (route.status === "error") throw route.error
  return storeSharedSessionAndPriorityAssignment({
    key: input.mappingKey,
    claudeSessionId: input.sdkSessionId,
    messageCount: 1,
    lineageHash: `lineage-${input.sdkSessionId}`,
    messageHashes: [`message-${input.sdkSessionId}`],
    messageBlockHashes: [[`block-${input.sdkSessionId}`]],
    expectedMappingGeneration: mapping.generation,
    priority: {
      routeKey: input.routeKey,
      profileId: input.profileId,
      lastHumanTurnDigest: input.digest,
      expectedAssignmentGeneration: route.generation,
    },
  })
}

describe("durable priority route publication", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-priority-store-"))
    setSessionStoreDir(dir)
  })

  afterEach(() => {
    delete process.env.MERIDIAN_MAX_PRIORITY_ASSIGNMENTS
    setSessionStoreDir(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it("upgrades lazily and publishes route plus mapping in one document", () => {
    storeSharedSession("ordinary", "sdk-ordinary")
    const before = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"))
    expect(before[META_KEY].version).toBe(1)

    const published = atomicPublish({
      routeKey: "conversation-1",
      mappingKey: "personal:conversation-1",
      profileId: "personal",
      sdkSessionId: "sdk-personal",
      digest: HUMAN_A,
    })
    expect(published).not.toBe(false)
    if (!published) return

    const document = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"))
    expect(document[META_KEY].version).toBe(2)
    expect(document[META_KEY].priorityAssignments["conversation-1"]).toMatchObject({
      profileId: "personal",
      lastHumanTurnDigest: HUMAN_A,
      mappingKey: "personal:conversation-1",
      mappingGeneration: published.mappingGeneration,
    })
    expect(document["personal:conversation-1"].claudeSessionId).toBe("sdk-personal")
    expect(lookupPriorityAssignmentResult("conversation-1")).toMatchObject({
      status: "found",
      generation: published.assignmentGeneration,
    })
  })

  it("loses atomically when either exact generation is stale", () => {
    const first = atomicPublish({
      routeKey: "conversation-2",
      mappingKey: "personal:conversation-2",
      profileId: "personal",
      sdkSessionId: "sdk-first",
      digest: HUMAN_A,
    })
    expect(first).not.toBe(false)
    if (!first) return
    const before = readFileSync(join(dir, "sessions.json"), "utf8")

    expect(storeSharedSessionAndPriorityAssignment({
      key: "personal:conversation-2",
      claudeSessionId: "sdk-stale-route",
      messageCount: 2,
      lineageHash: "stale",
      messageHashes: ["stale"],
      messageBlockHashes: [["stale"]],
      expectedMappingGeneration: first.mappingGeneration,
      priority: {
        routeKey: "conversation-2",
        profileId: "personal",
        lastHumanTurnDigest: HUMAN_B,
        expectedAssignmentGeneration: "wrong-route-generation",
      },
    })).toBe(false)
    expect(readFileSync(join(dir, "sessions.json"), "utf8")).toBe(before)

    const currentRoute = lookupPriorityAssignmentResult("conversation-2")
    if (currentRoute.status === "error") throw currentRoute.error
    expect(storeSharedSessionAndPriorityAssignment({
      key: "personal:conversation-2",
      claudeSessionId: "sdk-stale-mapping",
      messageCount: 2,
      lineageHash: "stale",
      messageHashes: ["stale"],
      messageBlockHashes: [["stale"]],
      expectedMappingGeneration: "wrong-mapping-generation",
      priority: {
        routeKey: "conversation-2",
        profileId: "personal",
        lastHumanTurnDigest: HUMAN_B,
        expectedAssignmentGeneration: currentRoute.generation,
      },
    })).toBe(false)
    expect(readFileSync(join(dir, "sessions.json"), "utf8")).toBe(before)
  })

  it("restores both authorities after a canceled promotion", () => {
    storeSharedSession("work:conversation-3", "sdk-work-old")
    const fallback = atomicPublish({
      routeKey: "conversation-3",
      mappingKey: "personal:conversation-3",
      profileId: "personal",
      sdkSessionId: "sdk-personal",
      digest: HUMAN_A,
    })
    expect(fallback).not.toBe(false)
    const promotion = atomicPublish({
      routeKey: "conversation-3",
      mappingKey: "work:conversation-3",
      profileId: "work",
      sdkSessionId: "sdk-work-new",
      digest: HUMAN_B,
    })
    expect(promotion).not.toBe(false)
    if (!promotion) return

    const restored = rollbackSharedSessionAndPriorityAssignment({
      key: "work:conversation-3",
      routeKey: "conversation-3",
      expectedMappingGeneration: promotion.mappingGeneration,
      expectedAssignmentGeneration: promotion.assignmentGeneration,
      previousMapping: promotion.previousMapping,
      previousAssignment: promotion.previousAssignment,
    })
    expect(restored).not.toBe(false)
    expect(lookupSharedSession("work:conversation-3")?.claudeSessionId).toBe("sdk-work-old")
    expect(lookupPriorityAssignmentResult("conversation-3")).toMatchObject({
      status: "found",
      assignment: {
        profileId: "personal",
        mappingKey: "personal:conversation-3",
        lastHumanTurnDigest: HUMAN_A,
      },
    })
  })

  it("preserves v2 routes during ordinary writes and clears them explicitly", () => {
    const first = atomicPublish({
      routeKey: "conversation-4",
      mappingKey: "personal:conversation-4",
      profileId: "personal",
      sdkSessionId: "sdk-personal",
      digest: HUMAN_A,
    })
    expect(first).not.toBe(false)
    storeSharedSession("unrelated", "sdk-unrelated")
    expect(lookupPriorityAssignmentResult("conversation-4").status).toBe("found")
    clearSharedSessions()
    expect(lookupPriorityAssignmentResult("conversation-4").status).toBe("missing")
  })

  it("bounds route records separately without deleting their session mappings", () => {
    process.env.MERIDIAN_MAX_PRIORITY_ASSIGNMENTS = "1"
    expect(atomicPublish({
      routeKey: "route-old",
      mappingKey: "personal:old",
      profileId: "personal",
      sdkSessionId: "sdk-old",
      digest: HUMAN_A,
    })).not.toBe(false)
    expect(atomicPublish({
      routeKey: "route-new",
      mappingKey: "personal:new",
      profileId: "personal",
      sdkSessionId: "sdk-new",
      digest: HUMAN_B,
    })).not.toBe(false)
    expect(lookupPriorityAssignmentResult("route-old").status).toBe("missing")
    expect(lookupPriorityAssignmentResult("route-new").status).toBe("found")
    expect(lookupSharedSession("personal:old")?.claudeSessionId).toBe("sdk-old")
    expect(lookupSharedSession("personal:new")?.claudeSessionId).toBe("sdk-new")
  })

  it("fails closed on malformed v2 route metadata", () => {
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({
      [META_KEY]: {
        version: 2,
        slots: {},
        priorityAssignments: {
          bad: {
            profileId: "personal",
            lastHumanTurnDigest: "not-a-digest",
            mappingKey: "personal:bad",
            mappingGeneration: "generation",
            generationId: "route-generation",
            updatedAt: 1,
          },
        },
      },
    }))
    expect(lookupPriorityAssignmentResult("bad").status).toBe("error")
    expect(() => storeSharedSession("unrelated", "sdk-unrelated")).toThrow()
  })
})
