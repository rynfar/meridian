/**
 * Session Recovery Tests
 *
 * Tests the previousClaudeSessionId preservation in the session store
 * and the recovery endpoints that help users find lost conversations.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  lookupSharedSession,
  storeSharedSession,
  clearSharedSessions,
  setSessionStoreDir,
  lookupSessionRecovery,
  listStoredSessions,
} from "../proxy/sessionStore"
import { join } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

describe("Session recovery — previousClaudeSessionId", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-recovery-"))
    setSessionStoreDir(tmpDir)
    await clearSharedSessions()
  })

  afterEach(() => {
    setSessionStoreDir(null)
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  it("should not set previousClaudeSessionId on first store", async () => {
    await storeSharedSession("key-1", "claude-aaa")
    const session = lookupSharedSession("key-1")!
    expect(session.claudeSessionId).toBe("claude-aaa")
    expect(session.previousClaudeSessionId).toBeUndefined()
  })

  it("should not set previousClaudeSessionId when same session is updated", async () => {
    await storeSharedSession("key-1", "claude-aaa")
    await storeSharedSession("key-1", "claude-aaa", 5)
    const session = lookupSharedSession("key-1")!
    expect(session.claudeSessionId).toBe("claude-aaa")
    expect(session.previousClaudeSessionId).toBeUndefined()
  })

  it("should preserve previousClaudeSessionId when session ID changes", async () => {
    await storeSharedSession("key-1", "claude-aaa")
    await storeSharedSession("key-1", "claude-bbb")
    const session = lookupSharedSession("key-1")!
    expect(session.claudeSessionId).toBe("claude-bbb")
    expect(session.previousClaudeSessionId).toBe("claude-aaa")
  })

  it("should update previousClaudeSessionId on subsequent changes", async () => {
    await storeSharedSession("key-1", "claude-aaa")
    await storeSharedSession("key-1", "claude-bbb")
    await storeSharedSession("key-1", "claude-ccc")
    const session = lookupSharedSession("key-1")!
    expect(session.claudeSessionId).toBe("claude-ccc")
    // The most recent previous session is preserved (not the original)
    expect(session.previousClaudeSessionId).toBe("claude-bbb")
  })

  it("should preserve createdAt through session changes", async () => {
    await storeSharedSession("key-1", "claude-aaa")
    const created = lookupSharedSession("key-1")!.createdAt
    await storeSharedSession("key-1", "claude-bbb")
    expect(lookupSharedSession("key-1")!.createdAt).toBe(created)
  })
})

describe("Session recovery — lookupSessionRecovery", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-recovery-lookup-"))
    setSessionStoreDir(tmpDir)
    await clearSharedSessions()
  })

  afterEach(() => {
    setSessionStoreDir(null)
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  it("should return undefined for unknown key", () => {
    expect(lookupSessionRecovery("nonexistent")).toBeUndefined()
  })

  it("should return recovery info with no previous session", async () => {
    await storeSharedSession("key-1", "claude-aaa", 10)
    const recovery = lookupSessionRecovery("key-1")!
    expect(recovery.claudeSessionId).toBe("claude-aaa")
    expect(recovery.previousClaudeSessionId).toBeUndefined()
    expect(recovery.messageCount).toBe(10)
  })

  it("should return recovery info with previous session after replacement", async () => {
    await storeSharedSession("key-1", "claude-aaa", 10)
    await storeSharedSession("key-1", "claude-bbb", 2)
    const recovery = lookupSessionRecovery("key-1")!
    expect(recovery.claudeSessionId).toBe("claude-bbb")
    expect(recovery.previousClaudeSessionId).toBe("claude-aaa")
    expect(recovery.messageCount).toBe(2)
  })
})

describe("Session recovery — listStoredSessions", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-recovery-list-"))
    setSessionStoreDir(tmpDir)
    await clearSharedSessions()
  })

  afterEach(() => {
    setSessionStoreDir(null)
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  it("should return empty array when no sessions", () => {
    expect(listStoredSessions()).toEqual([])
  })

  it("should list all stored sessions", async () => {
    await storeSharedSession("key-1", "claude-aaa")
    await storeSharedSession("key-2", "claude-bbb")
    const sessions = listStoredSessions()
    expect(sessions.length).toBe(2)
    const keys = sessions.map(s => s.key).sort()
    expect(keys).toEqual(["key-1", "key-2"])
  })

  it("should include previousClaudeSessionId in listing", async () => {
    await storeSharedSession("key-1", "claude-aaa")
    await storeSharedSession("key-1", "claude-bbb")
    const sessions = listStoredSessions()
    expect(sessions.length).toBe(1)
    expect(sessions[0]!.previousClaudeSessionId).toBe("claude-aaa")
  })
})
