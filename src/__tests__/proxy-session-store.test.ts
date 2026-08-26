/**
 * Shared Session Store Tests
 *
 * Tests the file-based session store that enables cross-proxy
 * session resume when running per-terminal proxies.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  lookupSharedSession,
  lookupSharedSessionByClaudeId,
  lookupSharedSessionResult,
  evictSharedSession,
  storeSharedSession,
  clearSharedSessions,
  getSessionStoreDir,
  readSessionStoreSnapshot,
  readSessionStoreGenerationSnapshot,
  setSessionStoreDir,
} from "../proxy/sessionStore"
import { join } from "node:path"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

describe("Shared session store", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-store-basic-"))
    setSessionStoreDir(tmpDir)
    clearSharedSessions()
  })

  afterEach(() => {
    setSessionStoreDir(null)
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  it("should store and retrieve a session", () => {
    storeSharedSession("session-123", "claude-sess-abc")
    const result = lookupSharedSession("session-123")
    expect(result).toBeDefined()
    expect(result!.claudeSessionId).toBe("claude-sess-abc")
  })

  it("should return undefined for unknown session", () => {
    const result = lookupSharedSession("nonexistent")
    expect(result).toBeUndefined()
  })

  it("should update lastUsedAt on store", () => {
    storeSharedSession("session-123", "claude-sess-abc")
    const first = lookupSharedSession("session-123")!.lastUsedAt

    // Small delay
    const start = Date.now()
    while (Date.now() - start < 10) {} // busy wait 10ms

    storeSharedSession("session-123", "claude-sess-abc")
    const second = lookupSharedSession("session-123")!.lastUsedAt
    expect(second).toBeGreaterThanOrEqual(first)
  })

  it("should preserve createdAt on update", () => {
    storeSharedSession("session-123", "claude-sess-abc")
    const created = lookupSharedSession("session-123")!.createdAt

    storeSharedSession("session-123", "claude-sess-def")
    const result = lookupSharedSession("session-123")!
    expect(result.createdAt).toBe(created)
    expect(result.claudeSessionId).toBe("claude-sess-def")
  })

  it("should handle multiple sessions", () => {
    storeSharedSession("sess-1", "claude-1")
    storeSharedSession("sess-2", "claude-2")
    storeSharedSession("sess-3", "claude-3")

    expect(lookupSharedSession("sess-1")!.claudeSessionId).toBe("claude-1")
    expect(lookupSharedSession("sess-2")!.claudeSessionId).toBe("claude-2")
    expect(lookupSharedSession("sess-3")!.claudeSessionId).toBe("claude-3")
  })

  it("should clear all sessions", () => {
    storeSharedSession("sess-1", "claude-1")
    storeSharedSession("sess-2", "claude-2")
    clearSharedSessions()
    expect(lookupSharedSession("sess-1")).toBeUndefined()
    expect(lookupSharedSession("sess-2")).toBeUndefined()
  })

  it("should persist context usage and find it by Claude session ID", () => {
    storeSharedSession(
      "session-usage",
      "claude-sess-usage",
      1,
      undefined,
      undefined,
      undefined,
      { input_tokens: 9, output_tokens: 4 },
      [["block-hash-a", "block-hash-b"]]
    )

    const byKey = lookupSharedSession("session-usage")
    expect(byKey?.contextUsage).toEqual({ input_tokens: 9, output_tokens: 4 })
    expect(byKey?.messageBlockHashes).toEqual([["block-hash-a", "block-hash-b"]])

    const byClaudeId = lookupSharedSessionByClaudeId("claude-sess-usage")
    expect(byClaudeId?.contextUsage).toEqual({ input_tokens: 9, output_tokens: 4 })
    expect(byClaudeId?.messageBlockHashes).toEqual([["block-hash-a", "block-hash-b"]])
  })

  it("should persist and clear the passthrough assistant resume checkpoint", () => {
    storeSharedSession(
      "session-boundary",
      "claude-sess-boundary",
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "assistant-uuid",
      ["tool-1", "tool-2"]
    )
    expect(lookupSharedSession("session-boundary")?.passthroughToolCallAssistantUuid).toBe("assistant-uuid")
    expect(lookupSharedSession("session-boundary")?.passthroughToolCallIds).toEqual(["tool-1", "tool-2"])

    storeSharedSession(
      "session-boundary",
      "claude-sess-boundary",
      2,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      null
    )
    expect(lookupSharedSession("session-boundary")?.passthroughToolCallAssistantUuid).toBeUndefined()
    expect(lookupSharedSession("session-boundary")?.passthroughToolCallIds).toBeUndefined()
  })

  it("ignores legacy user-denial boundaries after upgrade", () => {
    writeFileSync(join(tmpDir, "sessions.json"), JSON.stringify({
      "legacy-boundary": {
        claudeSessionId: "claude-legacy",
        createdAt: 1,
        lastUsedAt: 1,
        messageCount: 1,
        passthroughResumeUuid: "user-denial-uuid",
      },
    }))

    // Force a one-time fresh replay instead of resuming the invalid tail.
    expect(lookupSharedSession("legacy-boundary")).toBeUndefined()
    expect(lookupSharedSessionByClaudeId("claude-legacy")).toBeUndefined()
  })

  it("should return the freshest match when multiple keys share a Claude session ID", () => {
    storeSharedSession("session-old", "claude-shared")
    const first = lookupSharedSessionByClaudeId("claude-shared")

    const start = Date.now()
    while (Date.now() - start < 10) {} // busy wait 10ms

    storeSharedSession("session-new", "claude-shared", 2, undefined, undefined, undefined, {
      input_tokens: 20,
      output_tokens: 8,
    })

    const latest = lookupSharedSessionByClaudeId("claude-shared")
    expect(latest?.lastUsedAt).toBeGreaterThanOrEqual(first?.lastUsedAt ?? 0)
    expect(latest?.messageCount).toBe(2)
    expect(latest?.contextUsage).toEqual({ input_tokens: 20, output_tokens: 8 })
  })

  it("should handle concurrent writes safely", async () => {
    // Simulate two proxies writing at the same time
    const writes = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() => storeSharedSession(`sess-${i}`, `claude-${i}`))
    )
    await Promise.all(writes)

    // All should be readable
    for (let i = 0; i < 10; i++) {
      const session = lookupSharedSession(`sess-${i}`)
      expect(session).toBeDefined()
      expect(session!.claudeSessionId).toBe(`claude-${i}`)
    }
  })

  it("keeps tolerant lookups but rejects strict reads and mutations on corruption", () => {
    const sessionsPath = join(tmpDir, "sessions.json")
    writeFileSync(sessionsPath, "not json{{{")

    expect(lookupSharedSession("anything")).toBeUndefined()
    expect(() => readSessionStoreSnapshot()).toThrow()
    expect(() => storeSharedSession("new-sess", "claude-new")).toThrow()
    expect(() => clearSharedSessions()).toThrow()
    expect(readFileSync(sessionsPath, "utf8")).toBe("not json{{{")
  })

  it("reports the overridden session store directory", () => {
    expect(getSessionStoreDir()).toBe(tmpDir)
  })

  it("moves the exact transcript locator when the Claude session ID changes", () => {
    const original = { sessionId: "claude-old", configDir: "/config-a", projectDir: "/project-a" }
    const replacement = { sessionId: "claude-new", configDir: "/config-b" }
    storeSharedSession(
      "located-session", "claude-old", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, original
    )

    storeSharedSession(
      "located-session", "claude-new", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, replacement,
      { sessionId: "claude-old", configDir: "/fallback-must-not-win" }
    )
    expect(lookupSharedSession("located-session")).toMatchObject({
      claudeSessionId: "claude-new",
      previousClaudeSessionId: "claude-old",
      currentTranscript: replacement,
      previousTranscript: original,
    })

    // Updating the same ID without another locator preserves both locations.
    storeSharedSession("located-session", "claude-new", 3)
    expect(lookupSharedSession("located-session")).toMatchObject({
      currentTranscript: replacement,
      previousTranscript: original,
    })

    storeSharedSession("located-session", "claude-third")
    expect(lookupSharedSession("located-session")?.currentTranscript).toBeUndefined()
    expect(lookupSharedSession("located-session")?.previousTranscript).toEqual(replacement)

    // Never reuse a locator that belongs to an older, non-immediate ID.
    storeSharedSession("located-session", "claude-fourth")
    expect(lookupSharedSession("located-session")?.previousTranscript).toBeUndefined()
  })

  it("uses a validated legacy source locator for the first managed fork", () => {
    const source = { sessionId: "claude-legacy", configDir: "/legacy-config", projectDir: "/legacy-project" }
    const current = { sessionId: "claude-managed", configDir: "/managed-config" }
    storeSharedSession("legacy-fork", "claude-legacy")
    storeSharedSession(
      "legacy-fork", "claude-managed", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, current, source
    )

    expect(lookupSharedSession("legacy-fork")).toMatchObject({
      previousClaudeSessionId: "claude-legacy",
      currentTranscript: current,
      previousTranscript: source,
    })
  })

  it("validates transcript locators before changing the stored mapping", () => {
    storeSharedSession("validated", "claude-original")
    const before = readSessionStoreSnapshot()

    expect(() => storeSharedSession(
      "validated", "claude-new", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { sessionId: "wrong-id", configDir: "/config" }
    )).toThrow("currentTranscript.sessionId")
    expect(() => storeSharedSession(
      "validated", "claude-new", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { sessionId: "claude-new", configDir: "relative/config" }
    )).toThrow("currentTranscript.configDir")
    expect(() => storeSharedSession(
      "validated", "claude-new", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { sessionId: "claude-new", configDir: "/config", projectDir: "relative/project" }
    )).toThrow("currentTranscript.projectDir")
    expect(() => storeSharedSession(
      "validated", "claude-new", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      { sessionId: "not-claude-original", configDir: "/legacy-config" }
    )).toThrow("sourceTranscript.sessionId")
    expect(() => storeSharedSession(
      "validated", "claude-new", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      { sessionId: "claude-original", configDir: "relative/legacy-config" }
    )).toThrow("sourceTranscript.configDir")
    expect(() => storeSharedSession(
      "validated", "claude-new", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      { sessionId: "claude-original", configDir: "/legacy-config", projectDir: "relative/project" }
    )).toThrow("sourceTranscript.projectDir")

    expect(readSessionStoreSnapshot()).toEqual(before)
  })

  it("uses a key-bound expected-generation CAS and increments durable revisions", () => {
    const first = storeSharedSession("cas", "sdk-a")
    expect(typeof first).toBe("string")
    expect(String(first)).toStartWith("p:")
    expect(lookupSharedSession("cas")?.revision).toBe(1)

    expect(storeSharedSession(
      "cas", "sdk-stale", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, "wrong-source",
    )).toBe(false)
    expect(lookupSharedSession("cas")?.claudeSessionId).toBe("sdk-a")
    expect(lookupSharedSession("cas")?.revision).toBe(1)

    const second = storeSharedSession(
      "cas", "sdk-b", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, first || undefined,
    )
    expect(typeof second).toBe("string")
    expect(second).not.toBe(first)
    expect(lookupSharedSession("cas")?.claudeSessionId).toBe("sdk-b")
    expect(lookupSharedSession("cas")?.revision).toBe(2)
  })

  it("snapshots key-bound absence for every configured profile scope", () => {
    const snapshot = readSessionStoreGenerationSnapshot("client-session", ["default", "work", "personal"])
    expect(snapshot["client-session"]).toMatch(/^a:/)
    expect(snapshot["work:client-session"]).toMatch(/^a:/)
    expect(snapshot["personal:client-session"]).toMatch(/^a:/)
    expect(new Set(Object.values(snapshot))).toHaveLength(3)
  })

  it("rejects replacement, delete/recreate, and absent-key ABA by exact generation", () => {
    const first = storeSharedSession("aba", "sdk-a")
    expect(typeof first).toBe("string")
    const second = storeSharedSession(
      "aba", "sdk-b", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, first || undefined,
    )
    const third = storeSharedSession(
      "aba", "sdk-a", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, second || undefined,
    )
    expect(typeof third).toBe("string")
    expect(storeSharedSession(
      "aba", "sdk-stale", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, first || undefined,
    )).toBe(false)
    expect(evictSharedSession("aba", first || undefined)).toBe(false)
    expect(evictSharedSession("aba", third || undefined)).toBe(true)

    const absentAfterDelete = lookupSharedSessionResult("aba")
    expect(absentAfterDelete.status).toBe("missing")
    const recreated = storeSharedSession(
      "aba", "sdk-recreated", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      absentAfterDelete.status === "missing" ? absentAfterDelete.generation : undefined,
    )
    expect(typeof recreated).toBe("string")
    expect(storeSharedSession(
      "aba", "sdk-stale-after-recreate", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, third || undefined,
    )).toBe(false)

    const neverSeen = lookupSharedSessionResult("never-seen")
    expect(neverSeen.status).toBe("missing")
    const initialAbsence = neverSeen.status === "missing" ? neverSeen.generation : undefined
    const created = storeSharedSession(
      "never-seen", "sdk-created", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, initialAbsence,
    )
    expect(typeof created).toBe("string")
    expect(evictSharedSession("never-seen", created || undefined)).toBe(true)
    const alreadyAbsent = lookupSharedSessionResult("never-seen")
    expect(alreadyAbsent.status).toBe("missing")
    expect(evictSharedSession(
      "never-seen",
      alreadyAbsent.status === "missing" ? alreadyAbsent.generation : undefined,
    )).toBe(true)
    expect(storeSharedSession(
      "never-seen", "sdk-stale-absence", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, initialAbsence,
    )).toBe(false)
  })

})
