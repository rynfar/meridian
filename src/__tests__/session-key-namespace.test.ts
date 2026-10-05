import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearSessionCache, evictSession, lookupSession, storeSession } from "../proxy/session/cache"
import { lookupSharedSessionResult, readSessionStoreSnapshot, setSessionStoreDir, storeSharedSession } from "../proxy/sessionStore"
import { computeLineageHash, computeMessageHashes } from "../proxy/session/lineage"

const key = "synthetic-reserved-key"
const namespace = "synthetic-keyspace:1"
const opening = [{ role: "user", content: "same opening" }]
const continuation = [...opening, { role: "assistant", content: "ok" }, { role: "user", content: "continue" }]
let directory: string

function seedLegacy() {
  const transcript = join(directory, "unproven-sdk-transcript.jsonl")
  writeFileSync(transcript, "synthetic unproven bytes\n", { mode: 0o600 })
  const generation = storeSharedSession(
    key, "unproven-sdk-id", opening.length,
    computeLineageHash(opening), computeMessageHashes(opening), ["old-assistant-uuid"],
    undefined, undefined, "old-checkpoint-uuid", ["old-tool-id"],
    { sessionId: "unproven-sdk-id", configDir: directory },
  )
  if (!generation) throw new Error("synthetic legacy seed failed")
  return { generation, transcript }
}

describe("Mapping namespace ownership", () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "meridian-session-key-namespace-"))
    setSessionStoreDir(directory)
    clearSessionCache()
  })
  afterEach(() => {
    clearSessionCache()
    setSessionStoreDir(null)
    rmSync(directory, { recursive: true, force: true })
  })

  it("preserves ordinary unmarked main-session lookup and continuation", () => {
    seedLegacy()
    const result = lookupSession(key, continuation, directory)
    expect(result.type).toBe("continuation")
    if (result.type !== "continuation") throw new Error("expected legacy continuation")
    expect(result.session.claudeSessionId).toBe("unproven-sdk-id")
    expect(readSessionStoreSnapshot()[key]?.keyNamespace).toBeUndefined()
  })

  it("rejects legacy authority in a namespaced lookup and leaves its bytes unchanged", () => {
    const { transcript } = seedLegacy()
    const before = readSessionStoreSnapshot()[key]
    expect(lookupSession(key, continuation, directory, namespace))
      .toEqual({ type: "diverged", reason: "not-found" })
    expect(readSessionStoreSnapshot()[key]).toEqual(before)
    expect(readFileSync(transcript, "utf8")).toBe("synthetic unproven bytes\n")
  })

  it("freshly replaces an ambiguous legacy slot without inheriting checkpoint/recovery/transcript ownership", () => {
    const { generation, transcript } = seedLegacy()
    expect(storeSession(key, opening, "fresh-sdk-id", directory,
      [null], undefined, null, null, undefined, undefined, generation, undefined, namespace)).toBeTruthy()
    const fresh = readSessionStoreSnapshot()[key]
    expect(fresh?.keyNamespace).toBe(namespace)
    expect(fresh?.claudeSessionId).toBe("fresh-sdk-id")
    expect(fresh?.previousClaudeSessionId).toBeUndefined()
    expect(fresh?.currentTranscript).toBeUndefined()
    expect(fresh?.previousTranscript).toBeUndefined()
    expect(fresh?.passthroughToolCallAssistantUuid).toBeUndefined()
    expect(fresh?.passthroughToolCallIds).toBeUndefined()
    expect(readFileSync(transcript, "utf8")).toBe("synthetic unproven bytes\n")
    const resumed = lookupSession(key, continuation, directory, namespace)
    expect(resumed.type).toBe("continuation")
    if (resumed.type !== "continuation") throw new Error("expected namespaced continuation")
    expect(resumed.session.claudeSessionId).toBe("fresh-sdk-id")
    expect(lookupSession(key, continuation, directory)).toEqual({ type: "diverged", reason: "not-found" })
  })

  it("does not evict an unproven namespace or alter its synthetic transcript on cancellation", () => {
    const { generation, transcript } = seedLegacy()
    const before = readSessionStoreSnapshot()[key]
    expect(evictSession(key, directory, opening, generation, namespace)).toBe(true)
    expect(readSessionStoreSnapshot()[key]).toEqual(before)
    expect(readFileSync(transcript, "utf8")).toBe("synthetic unproven bytes\n")
    expect(evictSession(key, directory, opening, generation)).toBe(true)
    expect(lookupSharedSessionResult(key).status).toBe("missing")
    expect(readFileSync(transcript, "utf8")).toBe("synthetic unproven bytes\n")
  })

  it("fences a stale namespaced replacement and preserves the winning ordinary mapping", () => {
    const { generation } = seedLegacy()
    expect(storeSharedSession(key, "other-main-sdk-id", 1)).toBeTruthy()
    const before = readSessionStoreSnapshot()[key]
    expect(storeSession(key, opening, "fresh-sdk-id", directory,
      undefined, undefined, null, null, undefined, undefined, generation, undefined, namespace)).toBe(false)
    expect(readSessionStoreSnapshot()[key]).toEqual(before)
  })
})
