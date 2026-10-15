/**
 * Shared Session Store Tests
 *
 * Tests the file-based session store that enables cross-proxy
 * session resume when running per-terminal proxies.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  lookupSharedSession,
  lookupSharedSessionByClaudeId,
  lookupSharedSessionResult,
  evictSharedSession,
  storeSharedSession,
  attachSharedTranscriptLocator,
  clearSharedSessions,
  getSessionStoreDir,
  readSessionStoreDocument,
  readSessionStoreSnapshot,
  readSessionStoreGenerationSnapshot,
  sessionStoreWritesSettled,
  setSessionStoreDir,
} from "../proxy/sessionStore"
import { join } from "node:path"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { holdWriteLock, readCommittedSession, storeIntegrity } from "./storeDatabaseHelpers"

const META_KEY = "\u0000meridian-session-store"

/** The error a promise rejects with. `expect(promise).rejects` cannot wait for
 *  a store write under bun test (see session/storeDatabase.ts). */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected the promise to reject")
}

interface OtherProcessResult {
  exitCode: number
  signalCode: string | null
  stdout: string
  stderr: string
}

/** Run a module-level snippet in a new process, as another proxy on `dir`.
 *  The snippet sees the store module as `store`. */
async function spawnInOtherProcess(dir: string, code: string): Promise<OtherProcessResult> {
  const modulePath = join(import.meta.dir, "../proxy/sessionStore.ts")
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `import * as store from ${JSON.stringify(modulePath)}\n${code}`],
    env: { ...process.env, MERIDIAN_SESSION_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, signalCode: child.signalCode, stdout, stderr }
}

async function runInOtherProcess(dir: string, code: string): Promise<OtherProcessResult> {
  const result = await spawnInOtherProcess(dir, code)
  if (result.exitCode !== 0) throw new Error(`other process exited ${result.exitCode}: ${result.stderr}`)
  return result
}

describe("Shared session store", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-store-basic-"))
    setSessionStoreDir(tmpDir)
    await clearSharedSessions()
  })

  afterEach(() => {
    setSessionStoreDir(null)
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  it("should store and retrieve a session", async () => {
    await storeSharedSession("session-123", "claude-sess-abc")
    const result = lookupSharedSession("session-123")
    expect(result).toBeDefined()
    expect(result!.claudeSessionId).toBe("claude-sess-abc")
  })

  it("should return undefined for unknown session", () => {
    const result = lookupSharedSession("nonexistent")
    expect(result).toBeUndefined()
  })

  it("should update lastUsedAt on store", async () => {
    await storeSharedSession("session-123", "claude-sess-abc")
    const first = lookupSharedSession("session-123")!.lastUsedAt

    // Small delay
    const start = Date.now()
    while (Date.now() - start < 10) {} // busy wait 10ms

    await storeSharedSession("session-123", "claude-sess-abc")
    const second = lookupSharedSession("session-123")!.lastUsedAt
    expect(second).toBeGreaterThanOrEqual(first)
  })

  it("should preserve createdAt on update", async () => {
    await storeSharedSession("session-123", "claude-sess-abc")
    const created = lookupSharedSession("session-123")!.createdAt

    await storeSharedSession("session-123", "claude-sess-def")
    const result = lookupSharedSession("session-123")!
    expect(result.createdAt).toBe(created)
    expect(result.claudeSessionId).toBe("claude-sess-def")
  })

  it("should handle multiple sessions", async () => {
    await storeSharedSession("sess-1", "claude-1")
    await storeSharedSession("sess-2", "claude-2")
    await storeSharedSession("sess-3", "claude-3")

    expect(lookupSharedSession("sess-1")!.claudeSessionId).toBe("claude-1")
    expect(lookupSharedSession("sess-2")!.claudeSessionId).toBe("claude-2")
    expect(lookupSharedSession("sess-3")!.claudeSessionId).toBe("claude-3")
  })

  it("should clear all sessions", async () => {
    await storeSharedSession("sess-1", "claude-1")
    await storeSharedSession("sess-2", "claude-2")
    await clearSharedSessions()
    expect(lookupSharedSession("sess-1")).toBeUndefined()
    expect(lookupSharedSession("sess-2")).toBeUndefined()
  })

  it("should serve consecutive reads from the identity cache", async () => {
    await storeSharedSession("session-123", "claude-sess-abc")
    const first = lookupSharedSessionResult("session-123")
    const second = lookupSharedSessionResult("session-123")
    if (first.status !== "found" || second.status !== "found") throw new Error("lookup failed")
    // Same object identity proves the second read served the cached document.
    expect(second.session).toBe(first.session)
    expect(second.generation).toBe(first.generation)
  })

  it("should reflect an in-process write after a cached read", async () => {
    await storeSharedSession("session-123", "claude-sess-abc")
    expect(lookupSharedSession("session-123")!.claudeSessionId).toBe("claude-sess-abc")

    await storeSharedSession("session-123", "claude-sess-def")
    expect(lookupSharedSession("session-123")!.claudeSessionId).toBe("claude-sess-def")
  })

  it("should pick up writes and evictions committed by another process", async () => {
    await storeSharedSession("session-123", "claude-sess-abc")
    await storeSharedSession("session-evicted", "claude-sess-evicted")
    expect(lookupSharedSession("session-123")!.claudeSessionId).toBe("claude-sess-abc")

    await runInOtherProcess(tmpDir, `
      await store.storeSharedSession("session-456", "claude-sess-xyz")
      await store.storeSharedSession("session-123", "claude-sess-def")
      await store.evictSharedSession("session-evicted")
    `)

    expect(lookupSharedSession("session-123")!.claudeSessionId).toBe("claude-sess-def")
    expect(lookupSharedSession("session-456")!.claudeSessionId).toBe("claude-sess-xyz")
    expect(lookupSharedSessionResult("session-evicted").status).toBe("missing")
  })

  it("should treat a deleted store as missing instead of serving the stale cache", async () => {
    await storeSharedSession("session-123", "claude-sess-abc")
    expect(lookupSharedSession("session-123")!.claudeSessionId).toBe("claude-sess-abc")

    for (const name of ["sessions.db", "sessions.db-wal", "sessions.db-shm"]) {
      rmSync(join(getSessionStoreDir(), name), { force: true })
    }
    expect(lookupSharedSessionResult("session-123").status).toBe("missing")
    expect(await storeSharedSession("session-after", "claude-sess-after")).not.toBe(false)
    expect(readCommittedSession(tmpDir, "session-after")?.claudeSessionId).toBe("claude-sess-after")
  })

  it("never aliases a caller-owned locator into the cached document", async () => {
    // A shared locator object would let a later caller-side mutation diverge the
    // read cache from the file on disk.
    const callerLocator: { sessionId: string; configDir: string; projectDir?: string } =
      { sessionId: "claude-sess-alias", configDir: "/config" }
    await storeSharedSession(
      "alias-session", "claude-sess-alias", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, callerLocator
    )
    expect(lookupSharedSession("alias-session")!.currentTranscript).toEqual(callerLocator)

    callerLocator.projectDir = "/mutated-by-caller"
    expect(lookupSharedSession("alias-session")!.currentTranscript).not.toHaveProperty("projectDir")
    expect(readCommittedSession(tmpDir, "alias-session")?.currentTranscript).not.toHaveProperty("projectDir")

    const attachedLocator: { sessionId: string; configDir: string; lifecycleGeneration?: string } =
      { sessionId: "claude-sess-alias", configDir: "/config-2" }
    expect(await attachSharedTranscriptLocator("alias-session", "claude-sess-alias", attachedLocator)).not.toBe(false)
    attachedLocator.lifecycleGeneration = "r:forged:1"
    expect(lookupSharedSession("alias-session")!.currentTranscript).not.toHaveProperty("lifecycleGeneration")
  })

  it("should persist context usage and find it by Claude session ID", async () => {
    await storeSharedSession(
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

  it("should persist and clear the passthrough assistant resume checkpoint", async () => {
    await storeSharedSession(
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

    await storeSharedSession(
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

  it("ignores legacy user-denial boundaries after upgrade", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "session-store-legacy-boundary-"))
    writeFileSync(join(legacyDir, "sessions.json"), JSON.stringify({
      "legacy-boundary": {
        claudeSessionId: "claude-legacy",
        createdAt: 1,
        lastUsedAt: 1,
        messageCount: 1,
        passthroughResumeUuid: "user-denial-uuid",
      },
    }))
    setSessionStoreDir(legacyDir)
    try {
      expect(Object.keys(readSessionStoreSnapshot())).toEqual(["legacy-boundary"])
      // Force a one-time fresh replay instead of resuming the invalid tail.
      expect(lookupSharedSession("legacy-boundary")).toBeUndefined()
      expect(lookupSharedSessionByClaudeId("claude-legacy")).toBeUndefined()
      await sessionStoreWritesSettled()
      expect(lookupSharedSession("legacy-boundary")).toBeUndefined()
      expect(readCommittedSession(legacyDir, "legacy-boundary")).toMatchObject({ passthroughResumeUuid: "user-denial-uuid" })
    } finally {
      setSessionStoreDir(tmpDir)
      rmSync(legacyDir, { recursive: true, force: true })
    }
  })

  it("should return the freshest match when multiple keys share a Claude session ID", async () => {
    await storeSharedSession("session-old", "claude-shared")
    const first = lookupSharedSessionByClaudeId("claude-shared")

    const start = Date.now()
    while (Date.now() - start < 10) {} // busy wait 10ms

    await storeSharedSession("session-new", "claude-shared", 2, undefined, undefined, undefined, {
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

  it("keeps tolerant lookups but rejects strict reads and mutations on corruption", async () => {
    for (const corruptFile of ["sessions.json", "sessions.db"]) {
      const corruptDir = mkdtempSync(join(tmpdir(), "session-store-corrupt-"))
      const corruptPath = join(corruptDir, corruptFile)
      writeFileSync(corruptPath, "not json{{{ and not a database either, of any length at all")
      const before = readFileSync(corruptPath)
      setSessionStoreDir(corruptDir)
      try {
        expect(lookupSharedSession("anything")).toBeUndefined()
        expect(() => readSessionStoreSnapshot()).toThrow()
        expect(await rejectionOf(storeSharedSession("new-sess", "claude-new"))).toBeInstanceOf(Error)
        expect(await rejectionOf(clearSharedSessions())).toBeInstanceOf(Error)
        expect(readFileSync(corruptPath).equals(before)).toBe(true)
      } finally {
        setSessionStoreDir(tmpDir)
        rmSync(corruptDir, { recursive: true, force: true })
      }
    }
  })

  it("reports the overridden session store directory", () => {
    expect(getSessionStoreDir()).toBe(tmpDir)
  })

  it("moves the exact transcript locator when the Claude session ID changes", async () => {
    const original = { sessionId: "claude-old", configDir: "/config-a", projectDir: "/project-a" }
    const replacement = { sessionId: "claude-new", configDir: "/config-b" }
    await storeSharedSession(
      "located-session", "claude-old", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, original
    )

    await storeSharedSession(
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
    await storeSharedSession("located-session", "claude-new", 3)
    expect(lookupSharedSession("located-session")).toMatchObject({
      currentTranscript: replacement,
      previousTranscript: original,
    })

    await storeSharedSession("located-session", "claude-third")
    expect(lookupSharedSession("located-session")?.currentTranscript).toBeUndefined()
    expect(lookupSharedSession("located-session")?.previousTranscript).toEqual(replacement)

    // Never reuse a locator that belongs to an older, non-immediate ID.
    await storeSharedSession("located-session", "claude-fourth")
    expect(lookupSharedSession("located-session")?.previousTranscript).toBeUndefined()
  })

  it("uses a validated legacy source locator for the first managed fork", async () => {
    const source = { sessionId: "claude-legacy", configDir: "/legacy-config", projectDir: "/legacy-project" }
    const current = { sessionId: "claude-managed", configDir: "/managed-config" }
    await storeSharedSession("legacy-fork", "claude-legacy")
    await storeSharedSession(
      "legacy-fork", "claude-managed", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, current, source
    )

    expect(lookupSharedSession("legacy-fork")).toMatchObject({
      previousClaudeSessionId: "claude-legacy",
      currentTranscript: current,
      previousTranscript: source,
    })
  })

  it("validates transcript locators before changing the stored mapping", async () => {
    await storeSharedSession("validated", "claude-original")
    const before = readSessionStoreSnapshot()

    expect((await rejectionOf(storeSharedSession(
      "validated", "claude-new", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { sessionId: "wrong-id", configDir: "/config" }
    ))).message).toContain("currentTranscript.sessionId")
    expect((await rejectionOf(storeSharedSession(
      "validated", "claude-new", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { sessionId: "claude-new", configDir: "relative/config" }
    ))).message).toContain("currentTranscript.configDir")
    expect((await rejectionOf(storeSharedSession(
      "validated", "claude-new", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { sessionId: "claude-new", configDir: "/config", projectDir: "relative/project" }
    ))).message).toContain("currentTranscript.projectDir")
    expect((await rejectionOf(storeSharedSession(
      "validated", "claude-new", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      { sessionId: "not-claude-original", configDir: "/legacy-config" }
    ))).message).toContain("sourceTranscript.sessionId")
    expect((await rejectionOf(storeSharedSession(
      "validated", "claude-new", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      { sessionId: "claude-original", configDir: "relative/legacy-config" }
    ))).message).toContain("sourceTranscript.configDir")
    expect((await rejectionOf(storeSharedSession(
      "validated", "claude-new", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      { sessionId: "claude-original", configDir: "/legacy-config", projectDir: "relative/project" }
    ))).message).toContain("sourceTranscript.projectDir")

    expect(readSessionStoreSnapshot()).toEqual(before)
  })

  it("uses a key-bound expected-generation CAS and increments durable revisions", async () => {
    const first = await storeSharedSession("cas", "sdk-a")
    expect(typeof first).toBe("string")
    expect(String(first)).toStartWith("p:")
    expect(lookupSharedSession("cas")?.revision).toBe(1)

    expect(await storeSharedSession(
      "cas", "sdk-stale", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, "wrong-source",
    )).toBe(false)
    expect(lookupSharedSession("cas")?.claudeSessionId).toBe("sdk-a")
    expect(lookupSharedSession("cas")?.revision).toBe(1)

    const second = await storeSharedSession(
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

  it("rejects replacement, delete/recreate, and absent-key ABA by exact generation", async () => {
    const first = await storeSharedSession("aba", "sdk-a")
    expect(typeof first).toBe("string")
    const second = await storeSharedSession(
      "aba", "sdk-b", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, first || undefined,
    )
    const third = await storeSharedSession(
      "aba", "sdk-a", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, second || undefined,
    )
    expect(typeof third).toBe("string")
    expect(await storeSharedSession(
      "aba", "sdk-stale", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, first || undefined,
    )).toBe(false)
    expect(await evictSharedSession("aba", first || undefined)).toBe(false)
    expect(await evictSharedSession("aba", third || undefined)).toBe(true)

    const absentAfterDelete = lookupSharedSessionResult("aba")
    expect(absentAfterDelete.status).toBe("missing")
    const recreated = await storeSharedSession(
      "aba", "sdk-recreated", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      absentAfterDelete.status === "missing" ? absentAfterDelete.generation : undefined,
    )
    expect(typeof recreated).toBe("string")
    expect(await storeSharedSession(
      "aba", "sdk-stale-after-recreate", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, third || undefined,
    )).toBe(false)

    const neverSeen = lookupSharedSessionResult("never-seen")
    expect(neverSeen.status).toBe("missing")
    const initialAbsence = neverSeen.status === "missing" ? neverSeen.generation : undefined
    const created = await storeSharedSession(
      "never-seen", "sdk-created", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, initialAbsence,
    )
    expect(typeof created).toBe("string")
    expect(await evictSharedSession("never-seen", created || undefined)).toBe(true)
    const alreadyAbsent = lookupSharedSessionResult("never-seen")
    expect(alreadyAbsent.status).toBe("missing")
    expect(await evictSharedSession(
      "never-seen",
      alreadyAbsent.status === "missing" ? alreadyAbsent.generation : undefined,
    )).toBe(true)
    expect(await storeSharedSession(
      "never-seen", "sdk-stale-absence", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, initialAbsence,
    )).toBe(false)
  })

})

describe("Session store import of a legacy sessions.json", () => {
  let dir: string
  const originalLockTimeout = process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-store-import-"))
  })

  afterEach(async () => {
    await sessionStoreWritesSettled()
    setSessionStoreDir(null)
    if (originalLockTimeout === undefined) delete process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS
    else process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = originalLockTimeout
    rmSync(dir, { recursive: true, force: true })
  })

  const legacyPath = () => join(dir, "sessions.json")
  const retiredFiles = () => readdirSync(dir).filter((name) => name.startsWith("sessions.json.migrated-"))

  function generationOf(key: string): string | undefined {
    const result = lookupSharedSessionResult(key)
    if (result.status === "error") throw result.error
    return result.generation
  }

  function entry(claudeSessionId: string, lastUsedAt: number): Record<string, unknown> {
    return { claudeSessionId, revision: 1, generationId: randomUUID(), createdAt: 1, lastUsedAt, messageCount: 2 }
  }

  function writeLegacyStore(sessions: Record<string, Record<string, unknown>>, slots: Record<string, number> = {}): string {
    const raw = JSON.stringify({ [META_KEY]: { version: 1, slots }, ...sessions })
    writeFileSync(legacyPath(), raw, { mode: 0o600 })
    return raw
  }

  it("imports a sessions.json into a new database once, then keeps the file renamed aside", async () => {
    const raw = writeLegacyStore({
      "conversation-a": entry("claude-a", 10),
      "work:conversation-b": entry("claude-b", 20),
    }, { "00ff": 7 })
    setSessionStoreDir(dir)

    // Until the import commits, readers are served the file's contents.
    const armed = lookupSharedSessionResult("conversation-a")
    expect(armed).toMatchObject({ status: "found", session: { claudeSessionId: "claude-a" } })
    if (armed.status !== "found" || !armed.generation) throw new Error("the file's mapping is missing")
    await sessionStoreWritesSettled()

    expect(existsSync(legacyPath())).toBe(false)
    expect(retiredFiles()).toHaveLength(1)
    expect(readFileSync(join(dir, retiredFiles()[0]!), "utf8")).toBe(raw)
    expect(readCommittedSession(dir, "work:conversation-b")?.claudeSessionId).toBe("claude-b")
    expect(readSessionStoreDocument()).toMatchObject({ [META_KEY]: { version: 1, slots: { "00ff": 7 } } })
    // Generations survive the import, so a compare-and-swap armed before it lands after it.
    expect(generationOf("conversation-a")).toBe(armed.generation)
    expect(await storeSharedSession(
      "conversation-a", "claude-a2", undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, armed.generation,
    )).not.toBe(false)
    expect(readCommittedSession(dir, "conversation-a")?.claudeSessionId).toBe("claude-a2")
  })

  it("only renames a file it already imported, never importing it twice", async () => {
    const raw = writeLegacyStore({ "conversation-a": entry("claude-a", 10) })
    setSessionStoreDir(dir)
    readSessionStoreSnapshot()
    await sessionStoreWritesSettled()
    expect(await storeSharedSession("conversation-a", "claude-after-import")).not.toBe(false)
    // What a crash between the import's commit and the rename leaves behind.
    writeFileSync(legacyPath(), raw, { mode: 0o600 })

    const next = await runInOtherProcess(dir, `
      console.log(store.readSessionStoreSnapshot()["conversation-a"].claudeSessionId)
      await store.sessionStoreWritesSettled()
    `)
    expect(next.stdout.trim()).toBe("claude-after-import")
    expect(next.stderr).not.toContain("imported")
    expect(existsSync(legacyPath())).toBe(false)
    expect(retiredFiles()).toHaveLength(2)
    expect(lookupSharedSession("conversation-a")?.claudeSessionId).toBe("claude-after-import")
  })

  it("keeps the file when the process dies before the import commits", async () => {
    const raw = writeLegacyStore({ "conversation-a": entry("claude-a", 10) })
    const crashed = await spawnInOtherProcess(dir, `
      import AsyncDatabase from "libsql/promise"
      const exec = AsyncDatabase.prototype.exec
      AsyncDatabase.prototype.exec = function (sql) {
        if (sql === "COMMIT") process.kill(process.pid, "SIGKILL")
        return exec.call(this, sql)
      }
      store.readSessionStoreSnapshot()
      await store.sessionStoreWritesSettled()
      process.exit(3)
    `)
    expect(crashed.signalCode).toBe("SIGKILL")
    expect(crashed.stderr).toBe("")
    expect(readFileSync(legacyPath(), "utf8")).toBe(raw)
    expect(readCommittedSession(dir, "conversation-a")).toBeUndefined()
    expect(storeIntegrity(dir)).toBe("ok")

    setSessionStoreDir(dir)
    expect(lookupSharedSession("conversation-a")?.claudeSessionId).toBe("claude-a")
    await sessionStoreWritesSettled()
    expect(readCommittedSession(dir, "conversation-a")?.claudeSessionId).toBe("claude-a")
    expect(existsSync(legacyPath())).toBe(false)
  })

  it("leaves the file authoritative while the import cannot commit, and retries it with the next write", async () => {
    await runInOtherProcess(dir, "store.readSessionStoreSnapshot()")
    const raw = writeLegacyStore({ "conversation-a": entry("claude-a", 10) })
    const errors = spyOn(console, "error").mockImplementation(() => {})
    const holder = await holdWriteLock(dir)
    process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "200"
    setSessionStoreDir(dir)
    try {
      expect(lookupSharedSession("conversation-a")?.claudeSessionId).toBe("claude-a")
      await sessionStoreWritesSettled()
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("importing sessions.json failed"), expect.any(String))
      expect(readFileSync(legacyPath(), "utf8")).toBe(raw)
      // No write may land before the file it would overwrite has been taken in.
      expect((await rejectionOf(storeSharedSession("conversation-b", "claude-b"))).message)
        .toContain("timed out waiting for lock")
      expect(lookupSharedSession("conversation-a")?.claudeSessionId).toBe("claude-a")
    } finally {
      await holder.release()
      errors.mockRestore()
    }

    expect(await storeSharedSession("conversation-b", "claude-b")).not.toBe(false)
    expect(readCommittedSession(dir, "conversation-a")?.claudeSessionId).toBe("claude-a")
    expect(readCommittedSession(dir, "conversation-b")?.claudeSessionId).toBe("claude-b")
    expect(existsSync(legacyPath())).toBe(false)
  })

  it("merges a file an older version rewrote after the import, by recency, deleting nothing", async () => {
    setSessionStoreDir(dir)
    await storeSharedSession("kept-newer", "claude-db-newer")
    await storeSharedSession("db-only", "claude-db-only")
    await storeSharedSession("replaced-older", "claude-db-older")
    const replacedBefore = generationOf("replaced-older")
    // Written by a process still on the file store, after this one moved on.
    writeLegacyStore({
      "kept-newer": entry("claude-file-older", 1),
      "replaced-older": entry("claude-file-newer", Date.now() + 60_000),
      "file-only": entry("claude-file-only", 5),
    })

    const next = await runInOtherProcess(dir, `
      store.readSessionStoreSnapshot()
      await store.sessionStoreWritesSettled()
    `)
    expect(next.stderr).toContain("merged 2 sessions")

    expect(lookupSharedSession("kept-newer")?.claudeSessionId).toBe("claude-db-newer")
    expect(lookupSharedSession("db-only")?.claudeSessionId).toBe("claude-db-only")
    expect(lookupSharedSession("replaced-older")?.claudeSessionId).toBe("claude-file-newer")
    expect(lookupSharedSession("file-only")?.claudeSessionId).toBe("claude-file-only")
    expect(generationOf("replaced-older")).not.toBe(replacedBefore)
    expect(existsSync(legacyPath())).toBe(false)
  })
})
