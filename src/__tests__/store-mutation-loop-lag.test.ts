/**
 * A session store mutation is synchronous, so its whole cost is event-loop
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
  readSessionStoreSnapshot,
  setSessionStoreDir,
  storeSharedSession,
} from "../proxy/sessionStore"
import { rewriteFullStore } from "./fixtures/full-document-store-rewrite"

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

/** Event-loop delay caused by a synchronous call: how late an immediately due timer fires. */
async function loopLagOf(work: () => unknown): Promise<number> {
  const scheduledAt = performance.now()
  const fired = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now()), 0))
  work()
  return (await fired) - scheduledAt
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

    // Full-document work with the same lock, atomic rename and directory flush as a mutation.
    const baselines: number[] = []
    for (let run = 0; run < 3; run++) {
      baselines.push(await loopLagOf(() => rewriteFullStore(dir)))
    }

    // The first mutation after a foreign write parses once and encodes every entry once.
    storeSharedSession(keys[0]!, randomUUID(), 3, hash(), [hash(), hash(), hash()])
    const lags: number[] = []
    for (let index = 1; index <= 5; index++) {
      lags.push(await loopLagOf(() => {
        storeSharedSession(keys[index]!, randomUUID(), 3, hash(), [hash(), hash(), hash()])
      }))
    }
    const entry = lookupSharedSession(keys[6]!)!
    lags.push(await loopLagOf(() => {
      attachSharedTranscriptLocator(keys[6]!, entry.claudeSessionId, {
        sessionId: entry.claudeSessionId,
        configDir: "/home/user/.claude",
        projectDir: "/home/user/.claude/projects/other",
      })
    }))

    console.log(`[loop-lag] ${(text.length / 1e6).toFixed(1)} MB store: warm mutation median ${median(lags).toFixed(1)} ms, max ${Math.max(...lags).toFixed(1)} ms; full-document baseline median ${median(baselines).toFixed(1)} ms`)
    expect(median(lags)).toBeLessThan(median(baselines) * 0.75)
  })

  it("never re-parses the store or re-serializes unchanged entries on a warm mutation", () => {
    const { keys, text } = buildFixture(dir, 60, 40)
    storeSharedSession(keys[0]!, randomUUID(), 1, hash(), [hash()])

    const parse = spyOn(JSON, "parse")
    const stringify = spyOn(JSON, "stringify")
    try {
      storeSharedSession(keys[1]!, randomUUID(), 1, hash(), [hash()])
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
    expect(readFileSync(join(dir, "sessions.json"), "utf8").length).toBeLessThan(text.length)
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

  it("writes exactly the document a full serialization would produce", () => {
    storeSharedSession("a", "claude-a", 2, "h", ["m1", "m2"])
    storeSharedSession("b", "claude-b", 1, "h", ["m1"])
    storeSharedSession("a", "claude-a", 3, "h", ["m1", "m2", "m3"])
    const raw = readFileSync(join(dir, "sessions.json"), "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual([META_KEY, "a", "b"])
    expect(raw).toBe(JSON.stringify(parsed))
    expect((parsed.a as { messageCount: number }).messageCount).toBe(3)
  })

  it("owns nested caller data before memoizing serialized entries", () => {
    const hashes = ["m1"]
    const blockHashes = [["b1"]]
    const uuids = ["sdk-1"]
    storeSharedSession("a", "claude-a", 1, "h", hashes, uuids, undefined, blockHashes)
    hashes[0] = "changed"
    blockHashes[0]![0] = "changed"
    uuids[0] = "changed"
    const cached = lookupSharedSession("a")!
    expect(cached.messageHashes).toEqual(["m1"])
    expect(cached.messageBlockHashes).toEqual([["b1"]])
    expect(cached.sdkMessageUuids).toEqual(["sdk-1"])
    storeSharedSession("b", "claude-b", 1, "h", ["b"])
    const disk = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"))
    expect(disk.a.messageHashes).toEqual(cached.messageHashes)
    expect(disk.a.messageBlockHashes).toEqual(cached.messageBlockHashes)
  })

  it("prevents nested lookup edits from diverging from memoized disk bytes", () => {
    storeSharedSession("a", "claude-a", 1, "h", ["m1"], undefined, undefined, [["b1"]])
    const cached = lookupSharedSession("a")!
    expect(() => { cached.messageHashes![0] = "changed" }).toThrow()
    expect(() => { cached.messageBlockHashes![0]![0] = "changed" }).toThrow()
    expect(cached.messageHashes).toEqual(["m1"])
    const snapshot = readSessionStoreSnapshot()
    expect(() => { delete snapshot.a }).toThrow()
    expect(lookupSharedSession("a")).toBe(cached)
  })

  it("protects nested history parsed from a foreign writer before exposing it", () => {
    publishForeign(dir, { [META_KEY]: { version: 1, slots: {} }, a: fixtureEntry(2, Date.now()) })
    const cached = lookupSharedSession("a")!
    const original = cached.messageBlockHashes![0]![0]
    expect(() => { cached.messageBlockHashes![0]![0] = "changed" }).toThrow()
    storeSharedSession("b", "claude-b", 1, "h", ["b"])
    const disk = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"))
    expect(disk.a.messageBlockHashes[0][0]).toBe(original)
  })

  it("hands out frozen entries and leaves earlier reads untouched by later mutations", () => {
    storeSharedSession("a", "claude-a", 1, "h", ["m1"])
    const before = lookupSharedSession("a")!
    expect(Object.isFrozen(before)).toBe(true)

    expect(attachSharedTranscriptLocator("a", "claude-a", { sessionId: "claude-a", configDir: "/tmp/config" })).toBeTruthy()
    expect(before.currentTranscript).toBeUndefined()
    expect(lookupSharedSession("a")!.currentTranscript).toEqual({ sessionId: "claude-a", configDir: "/tmp/config" })
  })

  it("discards a mutator's partial changes when it throws", () => {
    storeSharedSession("a", "claude-a", 1, "h", ["m1"])
    const bytes = readFileSync(join(dir, "sessions.json"), "utf8")
    expect(() => storeSharedSession(
      "a", "claude-other", 1, "h", ["m1"], undefined, undefined, undefined, undefined, undefined,
      { sessionId: "claude-other", configDir: "/tmp/config" },
      { sessionId: "not-the-replaced-session", configDir: "/tmp/config" },
    )).toThrow()
    expect(readFileSync(join(dir, "sessions.json"), "utf8")).toBe(bytes)
    expect(lookupSharedSession("a")!.claudeSessionId).toBe("claude-a")
  })

  it("builds a mutation on a foreign writer's document, not on the stale cache", () => {
    storeSharedSession("a", "claude-a", 1, "h", ["m1"])
    const foreign = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")) as Record<string, unknown>
    foreign.b = fixtureEntry(2, Date.now())
    publishForeign(dir, foreign)

    storeSharedSession("c", "claude-c", 1, "h", ["m1"])
    const parsed = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual([META_KEY, "a", "b", "c"].sort())
  })
})
