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
  storeSharedSession,
  clearSharedSessions,
  setSessionStoreDir,
} from "../proxy/sessionStore"
import { join } from "node:path"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

  it("should handle corrupted file gracefully", () => {
    writeFileSync(join(tmpDir, "sessions.json"), "not json{{{")
    const result = lookupSharedSession("anything")
    expect(result).toBeUndefined()
    // Should still be able to write after corruption
    storeSharedSession("new-sess", "claude-new")
    expect(lookupSharedSession("new-sess")!.claudeSessionId).toBe("claude-new")
  })
})
