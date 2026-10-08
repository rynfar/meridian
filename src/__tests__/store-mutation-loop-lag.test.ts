/**
 * The CPU part of a session store mutation runs on the event loop, so it is
 * lag for every request the proxy serves. On a long-lived store (tens of MB)
 * re-parsing and re-serializing the whole file per mutation froze the loop for
 * hundreds of milliseconds at a time.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  attachSharedTranscriptLocator,
  lookupSharedSession,
  readSessionStoreDocument,
  readSessionStoreSnapshot,
  sessionStoreWritesSettled,
  setSessionStoreDir,
  storeSharedSession,
} from "../proxy/sessionStore"
import { commitRawSession, committedStoreSeq, readCommittedSession } from "./storeDatabaseHelpers"

const META_KEY = "\u0000meridian-session-store"

function hash(): string {
  return randomUUID().replaceAll("-", "")
}

function fixtureEntry(messageCount: number, lastUsedAt: number) {
  const claudeSessionId = randomUUID()
  return {
    claudeSessionId,
    revision: 1,
    generationId: randomUUID(),
    createdAt: lastUsedAt,
    lastUsedAt,
    messageCount,
    lineageHash: hash(),
    messageHashes: Array.from({ length: messageCount }, hash),
    messageBlockHashes: Array.from({ length: messageCount }, (_, index) => index % 3 ? [hash()] : [hash(), hash()]),
    sdkMessageUuids: Array.from({ length: messageCount }, (_, index) => index === messageCount - 1 ? randomUUID() : null),
    currentTranscript: { sessionId: claudeSessionId, configDir: "/home/user/.claude", projectDir: "/home/user/.claude/projects/p" },
  }
}

/** Write a store document the way a foreign writer does: temp file, fsync, rename. */
function publishForeign(dir: string, document: Record<string, unknown>): string {
  const text = JSON.stringify(document)
  const temp = join(dir, `sessions.json.tmp-foreign-${randomUUID()}`)
  const fd = openSync(temp, "wx", 0o600)
  writeFileSync(fd, text)
  fsyncSync(fd)
  closeSync(fd)
  renameSync(temp, join(dir, "sessions.json"))
  return text
}

function buildFixture(dir: string, entries: number, messagesPerEntry: number): { keys: string[]; text: string } {
  const document: Record<string, unknown> = { [META_KEY]: { version: 1, slots: {} } }
  const keys: string[] = []
  for (let index = 0; index < entries; index++) {
    const key = `profile${index % 4}:ses_${hash()}`
    keys.push(key)
    document[key] = fixtureEntry(messagesPerEntry, Date.now() - index * 1_000)
  }
  return { keys, text: publishForeign(dir, document) }
}

/** Worst event-loop delay while the work runs: how late a repeating 1 ms timer fires. */
async function loopLagOf(work: () => unknown): Promise<number> {
  let worst = 0
  let last = performance.now()
  const sampler = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
  }, 1)
  try {
    await work()
    // A stretch that ends the work is only seen once the sampler fires after it.
    await new Promise((resolve) => setTimeout(resolve, 2))
  } finally {
    clearInterval(sampler)
  }
  return worst
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

describe("session store mutation cost on a large store", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "store-loop-lag-"))
    setSessionStoreDir(dir)
  })

  afterEach(() => {
    setSessionStoreDir(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it("keeps a warm mutation's loop lag well below the full-document parse, serialize and write it replaced", async () => {
    const { keys, text } = buildFixture(dir, 400, 180)
    expect(text.length).toBeGreaterThan(5_000_000)

    // What every mutation used to do on the loop: parse, serialize, write, fsync.
    const baselines: number[] = []
    for (let run = 0; run < 3; run++) {
      baselines.push(await loopLagOf(() => {
        const parsed = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"))
        const fd = openSync(join(dir, `baseline-${run}`), "w", 0o600)
        writeFileSync(fd, JSON.stringify(parsed))
        fsyncSync(fd)
        closeSync(fd)
      }))
    }

    // The first mutation after a foreign write parses once and encodes every entry once.
    await storeSharedSession(keys[0]!, randomUUID(), 3, hash(), [hash(), hash(), hash()])
    const lags: number[] = []
    for (let index = 1; index <= 5; index++) {
      lags.push(await loopLagOf(() => (
        storeSharedSession(keys[index]!, randomUUID(), 3, hash(), [hash(), hash(), hash()])
      )))
    }
    const entry = lookupSharedSession(keys[6]!)!
    lags.push(await loopLagOf(() => attachSharedTranscriptLocator(keys[6]!, entry.claudeSessionId, {
      sessionId: entry.claudeSessionId,
      configDir: "/home/user/.claude",
      projectDir: "/home/user/.claude/projects/other",
    })))

    console.log(`[loop-lag] ${(text.length / 1e6).toFixed(1)} MB store: warm mutation median ${median(lags).toFixed(1)} ms, max ${Math.max(...lags).toFixed(1)} ms; full-document baseline median ${median(baselines).toFixed(1)} ms`)
    expect(median(lags)).toBeLessThan(median(baselines) * 0.75)
  })

  it("never re-parses the store or re-serializes unchanged entries on a warm mutation", async () => {
    const { keys, text } = buildFixture(dir, 60, 40)
    await storeSharedSession(keys[0]!, randomUUID(), 1, hash(), [hash()])

    const parse = spyOn(JSON, "parse")
    const stringify = spyOn(JSON, "stringify")
    try {
      await storeSharedSession(keys[1]!, randomUUID(), 1, hash(), [hash()])
      const largeParses = parse.mock.calls.filter(([input]) => typeof input === "string" && input.length > 1_000)
      expect(largeParses).toHaveLength(0)
      // One replaced entry, the metadata, and one small key literal per entry.
      const entryStringifies = stringify.mock.calls.filter(([value]) => (
        typeof value === "object" && value !== null && "claudeSessionId" in value
      ))
      expect(entryStringifies).toHaveLength(1)
    } finally {
      parse.mockRestore()
      stringify.mockRestore()
    }
    expect(JSON.stringify(readSessionStoreDocument()).length).toBeLessThan(text.length)
  })
})

describe("copy-on-write store mutations", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "store-cow-"))
    setSessionStoreDir(dir)
  })

  afterEach(() => {
    setSessionStoreDir(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it("commits each mapping's latest state, as the cache holds it", async () => {
    await storeSharedSession("a", "claude-a", 2, "h", ["m1", "m2"])
    await storeSharedSession("b", "claude-b", 1, "h", ["m1"])
    await storeSharedSession("a", "claude-a", 3, "h", ["m1", "m2", "m3"])
    const document = readSessionStoreDocument()
    expect(Object.keys(document)).toEqual([META_KEY, "a", "b"])
    expect(readCommittedSession(dir, "a")).toEqual(document.a as Record<string, unknown>)
    expect(readCommittedSession(dir, "b")).toEqual(document.b as Record<string, unknown>)
    expect(readCommittedSession(dir, "a")?.messageCount).toBe(3)
  })

  it("owns nested caller data before caching the committed entry", async () => {
    const hashes = ["m1"]
    const blockHashes = [["b1"]]
    const uuids = ["sdk-1"]
    await storeSharedSession("a", "claude-a", 1, "h", hashes, uuids, undefined, blockHashes)
    hashes[0] = "changed"
    blockHashes[0]![0] = "changed"
    uuids[0] = "changed"
    const cached = lookupSharedSession("a")!
    expect(cached.messageHashes).toEqual(["m1"])
    expect(cached.messageBlockHashes).toEqual([["b1"]])
    expect(cached.sdkMessageUuids).toEqual(["sdk-1"])
    const committed = readCommittedSession(dir, "a")!
    expect(committed.messageHashes).toEqual(cached.messageHashes)
    expect(committed.messageBlockHashes).toEqual(cached.messageBlockHashes)
  })

  it("prevents nested lookup edits from diverging from the database", async () => {
    await storeSharedSession("a", "claude-a", 1, "h", ["m1"], undefined, undefined, [["b1"]])
    const cached = lookupSharedSession("a")!
    expect(() => { cached.messageHashes![0] = "changed" }).toThrow()
    expect(() => { cached.messageBlockHashes![0]![0] = "changed" }).toThrow()
    expect(cached.messageHashes).toEqual(["m1"])
    const snapshot = readSessionStoreSnapshot()
    expect(() => { delete snapshot.a }).toThrow()
    expect(lookupSharedSession("a")).toBe(cached)
  })

  it("protects nested history another process committed before exposing it", async () => {
    await storeSharedSession("seed", "claude-seed", 1, "h", ["m1"])
    commitRawSession(dir, "a", fixtureEntry(2, Date.now()))
    const cached = lookupSharedSession("a")!
    const original = cached.messageBlockHashes![0]![0]
    expect(() => { cached.messageBlockHashes![0]![0] = "changed" }).toThrow()
    await storeSharedSession("b", "claude-b", 1, "h", ["b"])
    expect((readCommittedSession(dir, "a")!.messageBlockHashes as string[][])[0]![0]).toBe(original)
  })

  it("hands out frozen entries and leaves earlier reads untouched by later mutations", async () => {
    await storeSharedSession("a", "claude-a", 1, "h", ["m1"])
    const before = lookupSharedSession("a")!
    expect(Object.isFrozen(before)).toBe(true)

    expect(await attachSharedTranscriptLocator("a", "claude-a", { sessionId: "claude-a", configDir: "/tmp/config" })).toBeTruthy()
    expect(before.currentTranscript).toBeUndefined()
    expect(lookupSharedSession("a")!.currentTranscript).toEqual({ sessionId: "claude-a", configDir: "/tmp/config" })
  })

  it("discards a mutator's partial changes when it throws", async () => {
    await storeSharedSession("a", "claude-a", 1, "h", ["m1"])
    const seq = committedStoreSeq(dir)
    // Awaited rather than through expect().rejects, which cannot wait for a
    // store write under bun test (see session/storeDatabase.ts).
    const outcome = await storeSharedSession(
      "a", "claude-other", 1, "h", ["m1"], undefined, undefined, undefined, undefined, undefined,
      { sessionId: "claude-other", configDir: "/tmp/config" },
      { sessionId: "not-the-replaced-session", configDir: "/tmp/config" },
    ).then(() => "stored", (error: unknown) => error)
    expect(outcome).toBeInstanceOf(Error)
    expect(committedStoreSeq(dir)).toBe(seq)
    expect(lookupSharedSession("a")!.claudeSessionId).toBe("claude-a")
  })

  it("builds a mutation on a foreign writer's commit, not on the stale cache", async () => {
    await storeSharedSession("a", "claude-a", 1, "h", ["m1"])
    commitRawSession(dir, "b", fixtureEntry(2, Date.now()))

    await storeSharedSession("c", "claude-c", 1, "h", ["m1"])
    await sessionStoreWritesSettled()
    expect(Object.keys(readSessionStoreDocument()).sort()).toEqual([META_KEY, "a", "b", "c"].sort())
    for (const key of ["a", "b", "c"]) expect(readCommittedSession(dir, key)).toBeDefined()
  })
})
