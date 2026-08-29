import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  attachSharedTranscriptLocator,
  blockPriorityAttempt,
  claimPriorityAttempt,
  clearSharedSessions,
  finalizeSharedSessionAndPriorityAssignment,
  lookupPriorityAssignmentResult,
  lookupSharedSession,
  lookupSharedSessionResult,
  releasePriorityAttempt,
  rollbackSharedSessionAndPriorityAssignment,
  setSessionStoreDir,
  storeSharedSession,
  storeSharedSessionAndPriorityAssignment,
} from "../proxy/sessionStore"

const META_KEY = "\u0000meridian-session-store"
const HUMAN_A = "a".repeat(43)
const HUMAN_B = "b".repeat(43)
const HUMAN_C = "c".repeat(43)

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function priorityAttempt(routeKey: string) {
  const result = lookupPriorityAssignmentResult(routeKey)
  if (result.status === "error") throw result.error
  return result.attempt
}

async function waitForFile(path: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (existsSync(path)) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${path}`)
}

function atomicPublish(input: {
  routeKey: string
  mappingKey: string
  profileId: string
  sdkSessionId: string
  digest: string
  issuedAt?: number
  attemptOwnerToken?: string
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
    attemptOwnerToken: input.attemptOwnerToken,
    priority: {
      routeKey: input.routeKey,
      profileId: input.profileId,
      lastHumanTurnDigest: input.digest,
      lastHumanTurnIssuedAt: input.issuedAt ?? 1_900_000_000,
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
    delete process.env.MERIDIAN_MAX_PRIORITY_ATTEMPTS
    delete process.env.MERIDIAN_MAX_STORED_SESSIONS
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
    expect(document[META_KEY].version).toBe(3)
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

  it("blocks same-turn replay after exposure and clears only at exact terminal finalization", () => {
    const initialRoute = lookupPriorityAssignmentResult("attempt-route")
    if (initialRoute.status === "error") throw initialRoute.error
    const firstClaim = claimPriorityAttempt({
      routeKey: "attempt-route",
      expectedAssignmentGeneration: initialRoute.generation,
      turn: { turnId: HUMAN_A, issuedAt: 1_900_000_000 },
    })
    expect(firstClaim).not.toBe(false)
    if (!firstClaim) return
    expect(blockPriorityAttempt("attempt-route", firstClaim.ownerToken)).toBe(true)

    const blockedRoute = lookupPriorityAssignmentResult("attempt-route")
    if (blockedRoute.status === "error") throw blockedRoute.error
    expect(blockedRoute.attempt).toMatchObject({
      blocked: true,
      blockedTurnDigest: HUMAN_A,
      blockedTurnIssuedAt: 1_900_000_000,
      ownerToken: null,
    })
    expect(claimPriorityAttempt({
      routeKey: "attempt-route",
      expectedAssignmentGeneration: blockedRoute.generation,
      turn: { turnId: HUMAN_A, issuedAt: 1_900_000_000 },
    })).toBe(false)
    expect(claimPriorityAttempt({
      routeKey: "attempt-route",
      expectedAssignmentGeneration: blockedRoute.generation,
    })).toBe(false)

    const newer = claimPriorityAttempt({
      routeKey: "attempt-route",
      expectedAssignmentGeneration: blockedRoute.generation,
      turn: { turnId: HUMAN_B, issuedAt: 1_900_000_001 },
    })
    expect(newer).not.toBe(false)
    if (!newer) return
    expect(releasePriorityAttempt("attempt-route", newer.ownerToken)).toBe(true)
    expect(priorityAttempt("attempt-route")).toMatchObject({
      blocked: true,
      blockedTurnDigest: HUMAN_A,
      ownerToken: null,
    })

    const finalClaim = claimPriorityAttempt({
      routeKey: "attempt-route",
      expectedAssignmentGeneration: blockedRoute.generation,
      turn: { turnId: HUMAN_B, issuedAt: 1_900_000_001 },
    })
    expect(finalClaim).not.toBe(false)
    if (!finalClaim) return
    const published = atomicPublish({
      routeKey: "attempt-route",
      mappingKey: "work:attempt-route",
      profileId: "work",
      sdkSessionId: "sdk-attempt-route",
      digest: HUMAN_B,
      issuedAt: 1_900_000_001,
      attemptOwnerToken: finalClaim.ownerToken,
    })
    expect(published).not.toBe(false)
    if (!published) return
    expect(priorityAttempt("attempt-route")?.ownerToken).toBe(finalClaim.ownerToken)
    expect(finalizeSharedSessionAndPriorityAssignment({
      key: "work:attempt-route",
      routeKey: "attempt-route",
      expectedMappingGeneration: published.mappingGeneration,
      expectedAssignmentGeneration: published.assignmentGeneration,
      attemptOwnerToken: finalClaim.ownerToken,
    })).toBe(true)
    expect(priorityAttempt("attempt-route")).toBeUndefined()
  })

  it("bounds unresolved attempt claims without evicting an active blocker", () => {
    process.env.MERIDIAN_MAX_PRIORITY_ATTEMPTS = "1"
    const firstRoute = lookupPriorityAssignmentResult("attempt-cap-1")
    if (firstRoute.status === "error") throw firstRoute.error
    const first = claimPriorityAttempt({
      routeKey: "attempt-cap-1",
      expectedAssignmentGeneration: firstRoute.generation,
      turn: { turnId: HUMAN_A, issuedAt: 1_900_000_000 },
    })
    expect(first).not.toBe(false)
    if (!first) return
    expect(blockPriorityAttempt("attempt-cap-1", first.ownerToken)).toBe(true)

    const secondRoute = lookupPriorityAssignmentResult("attempt-cap-2")
    if (secondRoute.status === "error") throw secondRoute.error
    expect(claimPriorityAttempt({
      routeKey: "attempt-cap-2",
      expectedAssignmentGeneration: secondRoute.generation,
      turn: { turnId: HUMAN_B, issuedAt: 1_900_000_001 },
    })).toBe(false)
    expect(priorityAttempt("attempt-cap-1")).toMatchObject({ blocked: true })
  })

  it("keeps claims and route authority coherent across crashes before and after publication", async () => {
    const modulePath = join(import.meta.dir, "../proxy/sessionStore.ts")
    const childCode = `
      import {
        claimPriorityAttempt,
        lookupPriorityAssignmentResult,
        lookupSharedSessionResult,
        storeSharedSessionAndPriorityAssignment,
      } from ${JSON.stringify(modulePath)}
      const routeKey = process.env.ROUTE_KEY
      const route = lookupPriorityAssignmentResult(routeKey)
      if (route.status === "error") throw route.error
      const claim = claimPriorityAttempt({
        routeKey,
        expectedAssignmentGeneration: route.generation,
        turn: { turnId: process.env.DIGEST, issuedAt: Number(process.env.ISSUED_AT) },
      })
      if (!claim) process.exit(2)
      if (process.env.PHASE === "after") {
        const key = "work:" + routeKey
        const mapping = lookupSharedSessionResult(key)
        if (mapping.status === "error" || !mapping.generation) process.exit(3)
        const published = storeSharedSessionAndPriorityAssignment({
          key,
          claudeSessionId: "sdk-crash-after",
          messageCount: 1,
          lineageHash: "lineage-crash-after",
          messageHashes: ["message-crash-after"],
          messageBlockHashes: [["block-crash-after"]],
          expectedMappingGeneration: mapping.generation,
          attemptOwnerToken: claim.ownerToken,
          priority: {
            routeKey,
            profileId: "work",
            lastHumanTurnDigest: process.env.DIGEST,
            lastHumanTurnIssuedAt: Number(process.env.ISSUED_AT),
            expectedAssignmentGeneration: route.generation,
          },
        })
        if (!published) process.exit(4)
      }
      process.kill(process.pid, "SIGKILL")
    `
    const runCrash = async (routeKey: string, phase: "before" | "after") => {
      const child = Bun.spawn({
        cmd: [process.execPath, "-e", childCode],
        env: {
          ...process.env,
          MERIDIAN_SESSION_DIR: dir,
          ROUTE_KEY: routeKey,
          PHASE: phase,
          DIGEST: HUMAN_B,
          ISSUED_AT: "1900000001",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const timeout = Symbol("timeout")
      const exited = await Promise.race([child.exited, Bun.sleep(10_000).then(() => timeout)])
      if (exited === timeout) {
        child.kill()
        throw new Error(`crash worker timed out during ${phase}`)
      }
      expect(exited).not.toBe(0)
      expect(await new Response(child.stderr).text()).toBe("")
    }

    const beforeRoute = lookupPriorityAssignmentResult("crash-before")
    if (beforeRoute.status === "error") throw beforeRoute.error
    const beforeRaw = existsSync(join(dir, "sessions.json"))
      ? readFileSync(join(dir, "sessions.json"), "utf8")
      : undefined
    await runCrash("crash-before", "before")
    const afterBeforeCrash = lookupPriorityAssignmentResult("crash-before")
    if (afterBeforeCrash.status === "error") throw afterBeforeCrash.error
    expect(afterBeforeCrash.status).toBe("missing")
    expect(afterBeforeCrash.attempt?.ownerToken).toBeString()
    expect(claimPriorityAttempt({
      routeKey: "crash-before",
      expectedAssignmentGeneration: afterBeforeCrash.generation,
      turn: { turnId: HUMAN_B, issuedAt: 1_900_000_001 },
    })).toBe(false)
    if (beforeRaw !== undefined) expect(readFileSync(join(dir, "sessions.json"), "utf8")).not.toBe(beforeRaw)

    expect(atomicPublish({
      routeKey: "crash-after",
      mappingKey: "personal:crash-after",
      profileId: "personal",
      sdkSessionId: "sdk-crash-fallback",
      digest: HUMAN_A,
      issuedAt: 1_900_000_000,
    })).not.toBe(false)
    await runCrash("crash-after", "after")
    const crashedRoute = lookupPriorityAssignmentResult("crash-after")
    if (crashedRoute.status !== "found") throw new Error("crash-after route is missing")
    const crashedMapping = lookupSharedSessionResult(crashedRoute.assignment.mappingKey)
    expect(crashedRoute.assignment.profileId).toBe("work")
    expect(crashedMapping.status).toBe("found")
    if (crashedMapping.status !== "found" || !crashedMapping.generation) {
      throw new Error("crash-after mapping is missing")
    }
    expect(crashedRoute.assignment.mappingGeneration).toBe(crashedMapping.generation)
    expect(crashedRoute.attempt?.ownerToken).toBeString()
    expect(claimPriorityAttempt({
      routeKey: "crash-after",
      expectedAssignmentGeneration: crashedRoute.generation,
      turn: { turnId: HUMAN_B, issuedAt: 1_900_000_001 },
    })).toBe(false)
    expect(claimPriorityAttempt({
      routeKey: "crash-after",
      expectedAssignmentGeneration: crashedRoute.generation,
      turn: { turnId: HUMAN_C, issuedAt: 1_900_000_002 },
    })).not.toBe(false)
  }, 20_000)

  it("keeps cross-process readers coherent across route-refresh renames", async () => {
    expect(atomicPublish({
      routeKey: "reader-route",
      mappingKey: "work:reader-route",
      profileId: "work",
      sdkSessionId: "sdk-reader-0",
      digest: HUMAN_A,
    })).not.toBe(false)
    const ready = join(dir, "reader.ready")
    const stop = join(dir, "reader.stop")
    const storePath = join(dir, "sessions.json")
    const childCode = `
      import { createHash } from "node:crypto"
      import { existsSync, readFileSync, writeFileSync } from "node:fs"
      const metaKey = ${JSON.stringify(META_KEY)}
      const key = "work:reader-route"
      writeFileSync(process.env.READY, "ready")
      while (!existsSync(process.env.STOP)) {
        const document = JSON.parse(readFileSync(process.env.STORE, "utf8"))
        const route = document[metaKey].priorityAssignments["reader-route"]
        const mapping = document[key]
        if (!route || !mapping) throw new Error("reader observed missing atomic authority")
        const digest = createHash("sha256").update(key).digest("hex")
        if (route.mappingGeneration !== "p:" + digest + ":" + mapping.generationId) {
          throw new Error("reader observed a mixed route/mapping generation")
        }
      }
    `
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", childCode],
      env: { ...process.env, READY: ready, STOP: stop, STORE: storePath },
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      await waitForFile(ready)
      for (let index = 1; index <= 30; index += 1) {
        expect(storeSharedSession("work:reader-route", `sdk-reader-${index}`)).not.toBe(false)
      }
      writeFileSync(stop, "stop")
      const timeout = Symbol("timeout")
      const exited = await Promise.race([child.exited, Bun.sleep(10_000).then(() => timeout)])
      if (exited === timeout) throw new Error("coherent reader timed out")
      expect(exited).toBe(0)
      expect(await new Response(child.stderr).text()).toBe("")
    } finally {
      child.kill()
    }
  }, 20_000)

  it("makes a frozen v1 writer reject the claimed v3 store byte-identically", async () => {
    storeSharedSession("v1-frozen", "sdk-v1-frozen")
    const storePath = join(dir, "sessions.json")
    expect(JSON.parse(readFileSync(storePath, "utf8"))[META_KEY].version).toBe(1)
    const ready = join(dir, "v1.ready")
    const go = join(dir, "v1.go")
    const childCode = `
      import { existsSync, readFileSync, writeFileSync } from "node:fs"
      const metaKey = ${JSON.stringify(META_KEY)}
      const initial = JSON.parse(readFileSync(process.env.STORE, "utf8"))
      if (initial[metaKey].version !== 1) process.exit(2)
      writeFileSync(process.env.READY, "ready")
      while (!existsSync(process.env.GO)) await Bun.sleep(10)
      const before = readFileSync(process.env.STORE, "utf8")
      const current = JSON.parse(before)
      if (current[metaKey].version !== 1) {
        console.log("rejected")
        process.exit(0)
      }
      writeFileSync(process.env.STORE, before + " ")
      process.exit(3)
    `
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", childCode],
      env: { ...process.env, STORE: storePath, READY: ready, GO: go },
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      await waitForFile(ready)
      const route = lookupPriorityAssignmentResult("v1-upgrade-claim")
      if (route.status === "error") throw route.error
      expect(claimPriorityAttempt({
        routeKey: "v1-upgrade-claim",
        expectedAssignmentGeneration: route.generation,
        turn: { turnId: HUMAN_A, issuedAt: 1_900_000_000 },
      })).not.toBe(false)
      const claimed = readFileSync(storePath, "utf8")
      expect(JSON.parse(claimed)[META_KEY].version).toBe(3)
      writeFileSync(go, "go")
      const timeout = Symbol("timeout")
      const exited = await Promise.race([child.exited, Bun.sleep(10_000).then(() => timeout)])
      if (exited === timeout) throw new Error("frozen v1 worker timed out")
      expect(exited).toBe(0)
      expect((await new Response(child.stdout).text()).trim()).toBe("rejected")
      expect(await new Response(child.stderr).text()).toBe("")
      expect(readFileSync(storePath, "utf8")).toBe(claimed)
    } finally {
      child.kill()
    }
  }, 20_000)

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
        lastHumanTurnIssuedAt: 1_900_000_001,
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
        lastHumanTurnIssuedAt: 1_900_000_001,
        expectedAssignmentGeneration: currentRoute.generation,
      },
    })).toBe(false)
    expect(readFileSync(join(dir, "sessions.json"), "utf8")).toBe(before)
  })

  it("keeps a v1 document byte-identical when either side of the first dual CAS is stale", () => {
    storeSharedSession("ordinary-v1", "sdk-ordinary-v1")
    const path = join(dir, "sessions.json")
    const before = readFileSync(path, "utf8")
    expect(JSON.parse(before)[META_KEY].version).toBe(1)

    const mapping = lookupSharedSessionResult("personal:first-route")
    const route = lookupPriorityAssignmentResult("first-route")
    if (mapping.status === "error" || !mapping.generation) throw new Error("mapping lookup failed")
    if (route.status === "error") throw route.error

    const attempt = (
      expectedMappingGeneration: string,
      expectedAssignmentGeneration: string,
    ) => storeSharedSessionAndPriorityAssignment({
      key: "personal:first-route",
      claudeSessionId: "sdk-never-published",
      messageCount: 1,
      lineageHash: "lineage-never-published",
      messageHashes: ["message-never-published"],
      messageBlockHashes: [["block-never-published"]],
      expectedMappingGeneration,
      priority: {
        routeKey: "first-route",
        profileId: "personal",
        lastHumanTurnDigest: HUMAN_A,
        lastHumanTurnIssuedAt: 1_900_000_000,
        expectedAssignmentGeneration,
      },
    })

    expect(attempt(mapping.generation, "stale-route-generation")).toBe(false)
    expect(readFileSync(path, "utf8")).toBe(before)
    expect(attempt("stale-mapping-generation", route.generation)).toBe(false)
    expect(readFileSync(path, "utf8")).toBe(before)
    expect(JSON.parse(readFileSync(path, "utf8"))[META_KEY].version).toBe(1)
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

  it("keeps the fallback route and exact mapping rollback-safe at session cap one", () => {
    process.env.MERIDIAN_MAX_STORED_SESSIONS = "1"
    const fallback = atomicPublish({
      routeKey: "cap-one-conversation",
      mappingKey: "personal:cap-one-conversation",
      profileId: "personal",
      sdkSessionId: "sdk-personal-cap-one",
      digest: HUMAN_A,
    })
    expect(fallback).not.toBe(false)
    if (!fallback) return

    const promotion = atomicPublish({
      routeKey: "cap-one-conversation",
      mappingKey: "work:cap-one-conversation",
      profileId: "work",
      sdkSessionId: "sdk-work-cap-one",
      digest: HUMAN_B,
    })
    expect(promotion).not.toBe(false)
    if (!promotion) return

    // The publication may temporarily retain one rollback mapping beyond the
    // configured cap, but it must not prune the exact fallback authority.
    expect(lookupSharedSessionResult("personal:cap-one-conversation")).toMatchObject({
      status: "found",
      generation: fallback.mappingGeneration,
    })

    const restored = rollbackSharedSessionAndPriorityAssignment({
      key: "work:cap-one-conversation",
      routeKey: "cap-one-conversation",
      expectedMappingGeneration: promotion.mappingGeneration,
      expectedAssignmentGeneration: promotion.assignmentGeneration,
      previousMapping: promotion.previousMapping,
      previousAssignment: promotion.previousAssignment,
    })
    expect(restored).not.toBe(false)
    if (!restored) return

    expect(lookupSharedSessionResult("work:cap-one-conversation").status).toBe("missing")
    const restoredFallback = lookupSharedSessionResult("personal:cap-one-conversation")
    const restoredRoute = lookupPriorityAssignmentResult("cap-one-conversation")
    expect(restoredFallback).toMatchObject({
      status: "found",
      generation: fallback.mappingGeneration,
      session: { claudeSessionId: "sdk-personal-cap-one" },
    })
    expect(restoredRoute).toMatchObject({
      status: "found",
      assignment: {
        profileId: "personal",
        mappingKey: "personal:cap-one-conversation",
        mappingGeneration: fallback.mappingGeneration,
      },
    })
  })

  it("blocks every ordinary mutation of an exact rollback mapping", () => {
    const fallback = atomicPublish({
      routeKey: "protected-rollback",
      mappingKey: "personal:protected-rollback",
      profileId: "personal",
      sdkSessionId: "sdk-protected-personal",
      digest: HUMAN_A,
    })
    expect(fallback).not.toBe(false)
    const promotion = atomicPublish({
      routeKey: "protected-rollback",
      mappingKey: "work:protected-rollback",
      profileId: "work",
      sdkSessionId: "sdk-protected-work",
      digest: HUMAN_B,
    })
    expect(promotion).not.toBe(false)
    if (!promotion) return

    const before = readFileSync(join(dir, "sessions.json"), "utf8")
    expect(storeSharedSession("personal:protected-rollback", "sdk-mutated")).toBe(false)
    expect(atomicPublish({
      routeKey: "other-route",
      mappingKey: "personal:protected-rollback",
      profileId: "personal",
      sdkSessionId: "sdk-mutated",
      digest: HUMAN_A,
    })).toBe(false)
    expect(attachSharedTranscriptLocator(
      "personal:protected-rollback",
      "sdk-protected-personal",
      { sessionId: "sdk-protected-personal", configDir: dir },
    )).toBe(false)
    expect(readFileSync(join(dir, "sessions.json"), "utf8")).toBe(before)

    const restored = rollbackSharedSessionAndPriorityAssignment({
      key: "work:protected-rollback",
      routeKey: "protected-rollback",
      expectedMappingGeneration: promotion.mappingGeneration,
      expectedAssignmentGeneration: promotion.assignmentGeneration,
      previousMapping: promotion.previousMapping,
      previousAssignment: promotion.previousAssignment,
    })
    expect(restored).not.toBe(false)
    const route = lookupPriorityAssignmentResult("protected-rollback")
    const mapping = lookupSharedSessionResult("personal:protected-rollback")
    expect(route.status).toBe("found")
    expect(mapping.status).toBe("found")
    if (route.status !== "found" || mapping.status !== "found" || !mapping.generation) {
      throw new Error("restored fallback authority is missing")
    }
    expect(route.assignment.mappingGeneration).toBe(mapping.generation)
  })

  it("lets the same route publish back onto its exact rollback profile after owner loss", () => {
    const fallback = atomicPublish({
      routeKey: "marker-failback",
      mappingKey: "personal:marker-failback",
      profileId: "personal",
      sdkSessionId: "sdk-marker-personal",
      digest: HUMAN_A,
    })
    expect(fallback).not.toBe(false)
    const provisional = atomicPublish({
      routeKey: "marker-failback",
      mappingKey: "work:marker-failback",
      profileId: "work",
      sdkSessionId: "sdk-marker-work",
      digest: HUMAN_B,
    })
    expect(provisional).not.toBe(false)
    if (!provisional) return

    const beforeForeign = readFileSync(join(dir, "sessions.json"), "utf8")
    expect(atomicPublish({
      routeKey: "foreign-route",
      mappingKey: "personal:marker-failback",
      profileId: "personal",
      sdkSessionId: "sdk-foreign",
      digest: HUMAN_A,
    })).toBe(false)
    expect(readFileSync(join(dir, "sessions.json"), "utf8")).toBe(beforeForeign)

    const republished = atomicPublish({
      routeKey: "marker-failback",
      mappingKey: "personal:marker-failback",
      profileId: "personal",
      sdkSessionId: "sdk-marker-personal-new",
      digest: HUMAN_A,
    })
    expect(republished).not.toBe(false)
    if (!republished) return
    const route = lookupPriorityAssignmentResult("marker-failback")
    const mapping = lookupSharedSessionResult("personal:marker-failback")
    expect(route.status).toBe("found")
    expect(mapping.status).toBe("found")
    if (route.status !== "found" || mapping.status !== "found" || !mapping.generation) {
      throw new Error("republished authority is missing")
    }
    expect(route.assignment.profileId).toBe("personal")
    expect(route.assignment.mappingGeneration).toBe(mapping.generation)
    const document = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")) as Record<string, unknown>
    const meta = asRecord(document[META_KEY], "meta")
    const rollbacks = asRecord(meta.priorityRollbackMappings, "rollbacks")
    expect(rollbacks["marker-failback"]).toMatchObject({ mappingKey: "work:marker-failback" })

    expect(finalizeSharedSessionAndPriorityAssignment({
      key: "work:marker-failback",
      routeKey: "marker-failback",
      expectedMappingGeneration: provisional.mappingGeneration,
      expectedAssignmentGeneration: provisional.assignmentGeneration,
      rollbackMappingKey: "personal:marker-failback",
    })).toBe(false)
    expect(rollbackSharedSessionAndPriorityAssignment({
      key: "work:marker-failback",
      routeKey: "marker-failback",
      expectedMappingGeneration: provisional.mappingGeneration,
      expectedAssignmentGeneration: provisional.assignmentGeneration,
      previousMapping: provisional.previousMapping,
      previousAssignment: provisional.previousAssignment,
    })).toBe(false)

    expect(rollbackSharedSessionAndPriorityAssignment({
      key: "personal:marker-failback",
      routeKey: "marker-failback",
      expectedMappingGeneration: republished.mappingGeneration,
      expectedAssignmentGeneration: republished.assignmentGeneration,
      previousMapping: republished.previousMapping,
      previousAssignment: republished.previousAssignment,
    })).not.toBe(false)
    const restored = lookupPriorityAssignmentResult("marker-failback")
    const restoredMapping = lookupSharedSessionResult("work:marker-failback")
    expect(restored.status).toBe("found")
    expect(restoredMapping.status).toBe("found")
    if (restored.status !== "found" || restoredMapping.status !== "found" || !restoredMapping.generation) {
      throw new Error("new rollback authority is missing")
    }
    expect(restored.assignment.mappingGeneration).toBe(restoredMapping.generation)
  })

  it("finalizes a cap-one promotion and prunes its rollback backlog exactly once", () => {
    process.env.MERIDIAN_MAX_STORED_SESSIONS = "1"
    const fallback = atomicPublish({
      routeKey: "finalize-cap-one",
      mappingKey: "personal:finalize-cap-one",
      profileId: "personal",
      sdkSessionId: "sdk-personal-finalize",
      digest: HUMAN_A,
    })
    expect(fallback).not.toBe(false)
    const promotion = atomicPublish({
      routeKey: "finalize-cap-one",
      mappingKey: "work:finalize-cap-one",
      profileId: "work",
      sdkSessionId: "sdk-work-finalize",
      digest: HUMAN_B,
    })
    expect(promotion).not.toBe(false)
    if (!promotion) return

    const finalized = {
      key: "work:finalize-cap-one",
      routeKey: "finalize-cap-one",
      expectedMappingGeneration: promotion.mappingGeneration,
      expectedAssignmentGeneration: promotion.assignmentGeneration,
      rollbackMappingKey: "personal:finalize-cap-one",
    }
    expect(finalizeSharedSessionAndPriorityAssignment(finalized)).toBe(true)
    expect(lookupSharedSessionResult("personal:finalize-cap-one").status).toBe("missing")
    expect(lookupSharedSessionResult("work:finalize-cap-one")).toMatchObject({
      status: "found",
      generation: promotion.mappingGeneration,
    })
    const finalizedRoute = lookupPriorityAssignmentResult("finalize-cap-one")
    expect(finalizedRoute).toMatchObject({
      status: "found",
      assignment: { profileId: "work", mappingGeneration: promotion.mappingGeneration },
    })
    if (finalizedRoute.status !== "found") throw new Error("finalized route is missing")
    expect(finalizedRoute.generation).not.toBe(promotion.assignmentGeneration)
    const afterFirst = readFileSync(join(dir, "sessions.json"), "utf8")
    expect(rollbackSharedSessionAndPriorityAssignment({
      key: "work:finalize-cap-one",
      routeKey: "finalize-cap-one",
      expectedMappingGeneration: promotion.mappingGeneration,
      expectedAssignmentGeneration: promotion.assignmentGeneration,
      previousMapping: promotion.previousMapping,
      previousAssignment: promotion.previousAssignment,
    })).toBe(false)
    expect(finalizeSharedSessionAndPriorityAssignment(finalized)).toBe(false)
    expect(readFileSync(join(dir, "sessions.json"), "utf8")).toBe(afterFirst)
  })

  it("makes repeated rollback a one-shot safe CAS with no second mutation", () => {
    storeSharedSession("work:one-shot", "sdk-work-before")
    const first = atomicPublish({
      routeKey: "one-shot",
      mappingKey: "personal:one-shot",
      profileId: "personal",
      sdkSessionId: "sdk-personal",
      digest: HUMAN_A,
    })
    expect(first).not.toBe(false)
    const publication = atomicPublish({
      routeKey: "one-shot",
      mappingKey: "work:one-shot",
      profileId: "work",
      sdkSessionId: "sdk-work-published",
      digest: HUMAN_B,
    })
    expect(publication).not.toBe(false)
    if (!publication) return

    const rollback = {
      key: "work:one-shot",
      routeKey: "one-shot",
      expectedMappingGeneration: publication.mappingGeneration,
      expectedAssignmentGeneration: publication.assignmentGeneration,
      previousMapping: publication.previousMapping,
      previousAssignment: publication.previousAssignment,
    }
    expect(rollbackSharedSessionAndPriorityAssignment(rollback)).not.toBe(false)
    const afterFirst = readFileSync(join(dir, "sessions.json"), "utf8")

    expect(rollbackSharedSessionAndPriorityAssignment(rollback)).toBe(false)
    expect(finalizeSharedSessionAndPriorityAssignment({
      key: rollback.key,
      routeKey: rollback.routeKey,
      expectedMappingGeneration: rollback.expectedMappingGeneration,
      expectedAssignmentGeneration: rollback.expectedAssignmentGeneration,
      rollbackMappingKey: publication.previousAssignment?.mappingKey,
    })).toBe(false)
    expect(readFileSync(join(dir, "sessions.json"), "utf8")).toBe(afterFirst)
    expect(lookupSharedSession("work:one-shot")?.claudeSessionId).toBe("sdk-work-before")
    expect(lookupPriorityAssignmentResult("one-shot")).toMatchObject({
      status: "found",
      assignment: { profileId: "personal", mappingKey: "personal:one-shot" },
    })
  })

  it("preserves v3 routes during ordinary writes and clears them explicitly", () => {
    const first = atomicPublish({
      routeKey: "conversation-4",
      mappingKey: "personal:conversation-4",
      profileId: "personal",
      sdkSessionId: "sdk-personal",
      digest: HUMAN_A,
    })
    expect(first).not.toBe(false)
    const updated = storeSharedSession("personal:conversation-4", "sdk-personal-updated")
    expect(updated).not.toBe(false)
    const refreshedRoute = lookupPriorityAssignmentResult("conversation-4")
    expect(refreshedRoute).toMatchObject({
      status: "found",
      assignment: { mappingGeneration: updated },
    })
    const attached = attachSharedTranscriptLocator(
      "personal:conversation-4",
      "sdk-personal-updated",
      { sessionId: "sdk-personal-updated", configDir: dir },
      updated || undefined,
    )
    expect(attached).not.toBe(false)
    const attachedRoute = lookupPriorityAssignmentResult("conversation-4")
    expect(attachedRoute).toMatchObject({
      status: "found",
      assignment: { mappingGeneration: attached },
    })
    storeSharedSession("unrelated", "sdk-unrelated")
    expect(lookupPriorityAssignmentResult("conversation-4")).toEqual(attachedRoute)
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

  it("prunes routes and mappings together and fences both absent-key ABA domains", () => {
    process.env.MERIDIAN_MAX_PRIORITY_ASSIGNMENTS = "2"
    process.env.MERIDIAN_MAX_STORED_SESSIONS = "1"

    const oldMappingBefore = lookupSharedSessionResult("personal:aba-old")
    const oldRouteBefore = lookupPriorityAssignmentResult("aba-old")
    if (oldMappingBefore.status === "error" || !oldMappingBefore.generation) throw new Error("mapping lookup failed")
    if (oldRouteBefore.status === "error") throw oldRouteBefore.error

    expect(atomicPublish({
      routeKey: "aba-old",
      mappingKey: "personal:aba-old",
      profileId: "personal",
      sdkSessionId: "sdk-aba-old",
      digest: HUMAN_A,
    })).not.toBe(false)
    const survivor = atomicPublish({
      routeKey: "aba-new",
      mappingKey: "personal:aba-new",
      profileId: "personal",
      sdkSessionId: "sdk-aba-new",
      digest: HUMAN_B,
    })
    expect(survivor).not.toBe(false)
    if (!survivor) return

    const oldMappingAfter = lookupSharedSessionResult("personal:aba-old")
    const oldRouteAfter = lookupPriorityAssignmentResult("aba-old")
    expect(oldMappingAfter.status).toBe("missing")
    expect(oldRouteAfter.status).toBe("missing")
    if (oldMappingAfter.status !== "missing" || !oldMappingAfter.generation) return
    if (oldRouteAfter.status !== "missing") return
    expect(oldMappingAfter.generation).not.toBe(oldMappingBefore.generation)
    expect(oldRouteAfter.generation).not.toBe(oldRouteBefore.generation)

    const survivingRoute = lookupPriorityAssignmentResult("aba-new")
    const survivingMapping = lookupSharedSessionResult("personal:aba-new")
    expect(survivingRoute).toMatchObject({
      status: "found",
      assignment: {
        mappingKey: "personal:aba-new",
        mappingGeneration: survivor.mappingGeneration,
      },
    })
    expect(survivingMapping).toMatchObject({
      status: "found",
      generation: survivor.mappingGeneration,
    })

    const staleRouteAttempt = storeSharedSessionAndPriorityAssignment({
      key: "personal:aba-old",
      claudeSessionId: "sdk-stale-route-aba",
      messageCount: 1,
      lineageHash: "stale-route-aba",
      messageHashes: ["stale-route-aba"],
      messageBlockHashes: [["stale-route-aba"]],
      expectedMappingGeneration: oldMappingAfter.generation,
      priority: {
        routeKey: "aba-old",
        profileId: "personal",
        lastHumanTurnDigest: HUMAN_A,
        lastHumanTurnIssuedAt: 1_900_000_002,
        expectedAssignmentGeneration: oldRouteBefore.generation,
      },
    })
    expect(staleRouteAttempt).toBe(false)

    const staleMappingAttempt = storeSharedSessionAndPriorityAssignment({
      key: "personal:aba-old",
      claudeSessionId: "sdk-stale-mapping-aba",
      messageCount: 1,
      lineageHash: "stale-mapping-aba",
      messageHashes: ["stale-mapping-aba"],
      messageBlockHashes: [["stale-mapping-aba"]],
      expectedMappingGeneration: oldMappingBefore.generation,
      priority: {
        routeKey: "aba-old",
        profileId: "personal",
        lastHumanTurnDigest: HUMAN_A,
        lastHumanTurnIssuedAt: 1_900_000_002,
        expectedAssignmentGeneration: oldRouteAfter.generation,
      },
    })
    expect(staleMappingAttempt).toBe(false)

    // A fresh lookup can recreate the old key, proving the cap can cycle while
    // both stale absence tokens remain rejected.
    expect(atomicPublish({
      routeKey: "aba-old",
      mappingKey: "personal:aba-old",
      profileId: "personal",
      sdkSessionId: "sdk-aba-old-recreated",
      digest: HUMAN_A,
    })).not.toBe(false)
    expect(lookupPriorityAssignmentResult("aba-new").status).toBe("missing")
    expect(lookupSharedSessionResult("personal:aba-new").status).toBe("missing")
  })

  it("allows exactly one real-process winner for identical dual generations", async () => {
    const mapping = lookupSharedSessionResult("work:two-process")
    const route = lookupPriorityAssignmentResult("two-process")
    if (mapping.status === "error" || !mapping.generation) throw new Error("mapping lookup failed")
    if (route.status === "error") throw route.error
    const modulePath = join(import.meta.dir, "../proxy/sessionStore.ts")
    const childCode = `
      import { storeSharedSessionAndPriorityAssignment } from ${JSON.stringify(modulePath)}
      const result = storeSharedSessionAndPriorityAssignment({
        key: "work:two-process",
        claudeSessionId: "sdk-" + process.env.WORKER,
        messageCount: 1,
        lineageHash: "lineage-" + process.env.WORKER,
        messageHashes: ["message-" + process.env.WORKER],
        messageBlockHashes: [["block-" + process.env.WORKER]],
        expectedMappingGeneration: process.env.MAPPING_GENERATION,
        priority: {
          routeKey: "two-process",
          profileId: "work",
          lastHumanTurnDigest: "${HUMAN_A}",
          lastHumanTurnIssuedAt: 1900000000,
          expectedAssignmentGeneration: process.env.ROUTE_GENERATION,
        },
      })
      console.log(JSON.stringify({ won: result !== false }))
    `
    const children = ["a", "b"].map((worker) => Bun.spawn({
      cmd: [process.execPath, "-e", childCode],
      env: {
        ...process.env,
        WORKER: worker,
        MERIDIAN_SESSION_DIR: dir,
        MAPPING_GENERATION: mapping.generation,
        ROUTE_GENERATION: route.generation,
      },
      stdout: "pipe",
      stderr: "pipe",
    }))
    try {
      const timeout = Symbol("timeout")
      const exited = await Promise.race([
        Promise.all(children.map((child) => child.exited)),
        Bun.sleep(10_000).then(() => timeout),
      ])
      if (exited === timeout) throw new Error("priority publication workers timed out")
      expect(exited).toEqual([0, 0])
      const stderr = await Promise.all(children.map((child) => new Response(child.stderr).text()))
      expect(stderr).toEqual(["", ""])
      const results = await Promise.all(children.map(async (child) => (
        JSON.parse(await new Response(child.stdout).text()) as { won: boolean }
      )))
      expect(results.filter((result) => result.won)).toHaveLength(1)
      const finalRoute = lookupPriorityAssignmentResult("two-process")
      const finalMapping = lookupSharedSessionResult("work:two-process")
      expect(finalRoute.status).toBe("found")
      expect(finalMapping.status).toBe("found")
      if (finalRoute.status !== "found" || finalMapping.status !== "found" || !finalMapping.generation) {
        throw new Error("winning dual publication is missing")
      }
      expect(finalRoute.assignment.mappingGeneration).toBe(finalMapping.generation)
    } finally {
      for (const child of children) child.kill()
    }
  }, 20_000)

  it("allows exactly one real-process finalize-or-rollback winner", async () => {
    expect(atomicPublish({
      routeKey: "two-terminal-process",
      mappingKey: "personal:two-terminal-process",
      profileId: "personal",
      sdkSessionId: "sdk-two-terminal-personal",
      digest: HUMAN_A,
    })).not.toBe(false)
    const publication = atomicPublish({
      routeKey: "two-terminal-process",
      mappingKey: "work:two-terminal-process",
      profileId: "work",
      sdkSessionId: "sdk-two-terminal-work",
      digest: HUMAN_B,
    })
    expect(publication).not.toBe(false)
    if (!publication) return
    const shared = {
      key: "work:two-terminal-process",
      routeKey: "two-terminal-process",
      expectedMappingGeneration: publication.mappingGeneration,
      expectedAssignmentGeneration: publication.assignmentGeneration,
    }
    const modulePath = join(import.meta.dir, "../proxy/sessionStore.ts")
    const childCode = `
      import {
        finalizeSharedSessionAndPriorityAssignment,
        rollbackSharedSessionAndPriorityAssignment,
      } from ${JSON.stringify(modulePath)}
      const input = JSON.parse(process.env.INPUT)
      const won = process.env.ROLE === "finalize"
        ? finalizeSharedSessionAndPriorityAssignment(input.finalize)
        : rollbackSharedSessionAndPriorityAssignment(input.rollback) !== false
      console.log(JSON.stringify({ won }))
    `
    const input = JSON.stringify({
      finalize: {
        ...shared,
        rollbackMappingKey: publication.previousAssignment?.mappingKey,
      },
      rollback: {
        ...shared,
        previousMapping: publication.previousMapping,
        previousAssignment: publication.previousAssignment,
      },
    })
    const children = ["finalize", "rollback"].map((role) => Bun.spawn({
      cmd: [process.execPath, "-e", childCode],
      env: { ...process.env, ROLE: role, INPUT: input, MERIDIAN_SESSION_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    }))
    try {
      const timeout = Symbol("timeout")
      const exited = await Promise.race([
        Promise.all(children.map((child) => child.exited)),
        Bun.sleep(10_000).then(() => timeout),
      ])
      if (exited === timeout) throw new Error("terminal authority workers timed out")
      expect(exited).toEqual([0, 0])
      const stderr = await Promise.all(children.map((child) => new Response(child.stderr).text()))
      expect(stderr).toEqual(["", ""])
      const results = await Promise.all(children.map(async (child) => (
        JSON.parse(await new Response(child.stdout).text()) as { won: boolean }
      )))
      expect(results.filter((result) => result.won)).toHaveLength(1)

      const route = lookupPriorityAssignmentResult("two-terminal-process")
      expect(route.status).toBe("found")
      if (route.status !== "found") throw new Error("terminal winner route is missing")
      const mapping = lookupSharedSessionResult(route.assignment.mappingKey)
      expect(mapping.status).toBe("found")
      if (mapping.status !== "found" || !mapping.generation) throw new Error("terminal winner mapping is missing")
      expect(route.assignment.mappingGeneration).toBe(mapping.generation)
    } finally {
      for (const child of children) child.kill()
    }
  }, 20_000)

  it("fails closed on malformed or stale exact rollback markers", () => {
    expect(atomicPublish({
      routeKey: "strict-rollback",
      mappingKey: "personal:strict-rollback",
      profileId: "personal",
      sdkSessionId: "sdk-strict-personal",
      digest: HUMAN_A,
    })).not.toBe(false)
    expect(atomicPublish({
      routeKey: "strict-rollback",
      mappingKey: "work:strict-rollback",
      profileId: "work",
      sdkSessionId: "sdk-strict-work",
      digest: HUMAN_B,
    })).not.toBe(false)
    const path = join(dir, "sessions.json")
    const baseline = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    const corruptions: Array<(document: Record<string, unknown>) => void> = [
      (document) => {
        const meta = asRecord(document[META_KEY], "meta")
        const rollbacks = asRecord(meta.priorityRollbackMappings, "rollbacks")
        rollbacks["strict-rollback"] = "personal:strict-rollback"
      },
      (document) => {
        delete document["personal:strict-rollback"]
      },
      (document) => {
        const meta = asRecord(document[META_KEY], "meta")
        const rollbacks = asRecord(meta.priorityRollbackMappings, "rollbacks")
        const assignments = asRecord(meta.priorityAssignments, "assignments")
        const assignment = asRecord(assignments["strict-rollback"], "assignment")
        rollbacks["strict-rollback"] = {
          mappingKey: assignment.mappingKey,
          mappingGeneration: assignment.mappingGeneration,
        }
      },
      (document) => {
        const meta = asRecord(document[META_KEY], "meta")
        const rollbacks = asRecord(meta.priorityRollbackMappings, "rollbacks")
        const rollback = asRecord(rollbacks["strict-rollback"], "rollback")
        const generation = String(rollback.mappingGeneration)
        rollback.mappingGeneration = generation.replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          "00000000-0000-4000-8000-000000000000",
        )
      },
    ]

    for (const corrupt of corruptions) {
      const document = structuredClone(baseline)
      corrupt(document)
      const raw = JSON.stringify(document)
      writeFileSync(path, raw)
      expect(lookupPriorityAssignmentResult("strict-rollback").status).toBe("error")
      expect(readFileSync(path, "utf8")).toBe(raw)
    }
  })

  it("fails closed on malformed durable attempt claims without rewriting the file", () => {
    const route = lookupPriorityAssignmentResult("strict-attempt")
    if (route.status === "error") throw route.error
    const claim = claimPriorityAttempt({
      routeKey: "strict-attempt",
      expectedAssignmentGeneration: route.generation,
      turn: { turnId: HUMAN_A, issuedAt: 1_900_000_000 },
    })
    expect(claim).not.toBe(false)
    if (!claim) return
    expect(blockPriorityAttempt("strict-attempt", claim.ownerToken)).toBe(true)
    const path = join(dir, "sessions.json")
    const baseline = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    const corruptions: Array<(attempt: Record<string, unknown>) => void> = [
      (attempt) => { attempt.currentTranscript = { sessionId: "private", configDir: "/private" } },
      (attempt) => { attempt.ownerToken = "not-a-uuid" },
      (attempt) => { attempt.pendingTurnDigest = HUMAN_B },
      (attempt) => {
        attempt.blocked = false
        attempt.ownerToken = null
      },
    ]
    for (const corrupt of corruptions) {
      const document = structuredClone(baseline)
      const meta = asRecord(document[META_KEY], "meta")
      const attempts = asRecord(meta.priorityAttempts, "attempts")
      corrupt(asRecord(attempts["strict-attempt"], "attempt"))
      const raw = JSON.stringify(document)
      writeFileSync(path, raw)
      expect(lookupPriorityAssignmentResult("strict-attempt").status).toBe("error")
      expect(readFileSync(path, "utf8")).toBe(raw)
    }
  })

  it("fails closed on a strict malformed-v3 route matrix without rewriting the file", () => {
    const published = atomicPublish({
      routeKey: "strict-route",
      mappingKey: "personal:strict-route",
      profileId: "personal",
      sdkSessionId: "sdk-strict-route",
      digest: HUMAN_A,
    })
    expect(published).not.toBe(false)
    storeSharedSession("wrong-key", "sdk-wrong-key")
    const wrongKeyMapping = lookupSharedSessionResult("wrong-key")
    if (wrongKeyMapping.status !== "found" || !wrongKeyMapping.generation) {
      throw new Error("wrong-key mapping lookup failed")
    }

    const path = join(dir, "sessions.json")
    const validDocument: unknown = JSON.parse(readFileSync(path, "utf8"))
    const cases: Array<{
      name: string
      mutate: (meta: Record<string, unknown>, route: Record<string, unknown>) => void
    }> = [
      {
        name: "unknown route field",
        mutate: (_meta, route) => { route.unexpected = "value" },
      },
      {
        name: "unknown meta field",
        mutate: (meta) => { meta.unexpected = "value" },
      },
      {
        name: "wrong-key mapping generation",
        mutate: (_meta, route) => { route.mappingGeneration = wrongKeyMapping.generation },
      },
      {
        name: "invalid route UUID",
        mutate: (_meta, route) => { route.generationId = "not-a-uuid" },
      },
      {
        name: "invalid route update time",
        mutate: (_meta, route) => { route.updatedAt = -1 },
      },
      {
        name: "invalid human-turn issue time",
        mutate: (_meta, route) => { route.lastHumanTurnIssuedAt = 1.5 },
      },
      {
        name: "private transcript locator field",
        mutate: (_meta, route) => {
          route.currentTranscript = { sessionId: "private", configDir: "/private" }
        },
      },
    ]

    for (const [index, malformedCase] of cases.entries()) {
      const document = structuredClone(validDocument)
      const top = asRecord(document, "session store")
      const meta = asRecord(top[META_KEY], "session store metadata")
      const assignments = asRecord(meta.priorityAssignments, "priority assignments")
      const route = asRecord(assignments["strict-route"], "strict route")
      malformedCase.mutate(meta, route)
      const malformed = JSON.stringify(document)
      writeFileSync(path, malformed)

      const lookup = lookupPriorityAssignmentResult("strict-route")
      expect({ name: malformedCase.name, status: lookup.status }).toEqual({
        name: malformedCase.name,
        status: "error",
      })
      expect(() => storeSharedSession(`malformed-${index}`, `sdk-malformed-${index}`)).toThrow()
      expect(readFileSync(path, "utf8")).toBe(malformed)
    }
  })
})
