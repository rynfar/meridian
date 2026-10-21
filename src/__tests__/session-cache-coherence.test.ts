import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupStoreBackend, teardownStoreBackend } from "./fixtures/bookkeeping-store-backend"
import { clearSessionCache, evictSession, getSessionByClaudeId, lookupSession, storeSession } from "../proxy/session/cache"
import { getConversationFingerprint } from "../proxy/session/fingerprint"
import { evictSharedSession, lookupSharedSession, lookupSharedSessionResult, setSessionStoreDir, storeSharedSession } from "../proxy/sessionStore"

describe("cross-process session cache coherence", () => {
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "meridian-cache-coherence-"))
    setSessionStoreDir(dir, { skipLocking: false })
    setupStoreBackend(dir)
    await clearSessionCache()
  })

  afterEach(async () => {
    await clearSessionCache()
    teardownStoreBackend()
    setSessionStoreDir(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([true, false])("owns queued local-fallback inputs as well as durable data (keyed=%s)", async keyed => {
    const messages = [{ role: "user", content: "hello" }]
    const cwd = "/tmp/owned-cache-input"
    const sessionId = keyed ? "owned-cache-session" : undefined
    const uuids = ["original-uuid"]
    const locator = { sessionId: "owned-sdk", configDir: "/tmp/owned-config" }
    const pending = (await storeSession(sessionId, messages, "owned-sdk", cwd, uuids,
      undefined, undefined, undefined, locator))
    uuids[0] = "changed-uuid"
    locator.configDir = "invalid-relative-path"
    await pending
    // Force the genuine local-fallback path before a successful shared lookup
    // can replace the locally published state with the durable owned snapshot.
    writeFileSync(join(dir, "sessions.json"), "corrupt fixture")
    const found = lookupSession(sessionId, [...messages, { role: "user", content: "next" }], cwd)
    expect(found.type).toBe("continuation")
    if (found.type !== "continuation") throw new Error("expected continuation")
    expect(found.session).toMatchObject({
      sdkMessageUuids: ["original-uuid"],
      currentTranscript: { configDir: "/tmp/owned-config" },
    })
  })

  it.each([true, false])("awaited cleanup cannot revive an earlier queued write (keyed=%s)", async keyed => {
    const messages = [{ role: "user", content: "hello" }]
    const cwd = "/tmp/cleanup-ordering"
    const sessionId = keyed ? "client-session" : undefined
    const key = sessionId ?? getConversationFingerprint(messages, cwd)
    const pending = (await storeSession(sessionId, messages, "before-cleanup", cwd))
    const cleanup = clearSessionCache()
    await Promise.all([pending, cleanup])
    expect(lookupSharedSession(key)).toBeUndefined()
    // A genuine durable read error uses local fallback. No successful lookup
    // may first mask stale memory by observing authoritative absence.
    writeFileSync(join(dir, "sessions.json"), "corrupt fixture")
    expect(lookupSession(sessionId, [...messages, { role: "user", content: "next" }], cwd))
      .toEqual({ type: "diverged", reason: "not-found" })
  })

  it.each([true, false])("cleanup preserves a write started after it (keyed=%s)", async keyed => {
    const messages = [{ role: "user", content: "hello" }]
    const cwd = "/tmp/cleanup-ordering"
    const sessionId = keyed ? "client-session" : undefined
    const key = sessionId ?? getConversationFingerprint(messages, cwd)
    const old = (await storeSession(sessionId, messages, "before-cleanup", cwd))
    const cleanup = clearSessionCache()
    const later = (await storeSession(sessionId, messages, "after-cleanup", cwd))
    await Promise.all([old, cleanup, later])
    expect(lookupSharedSession(key)?.claudeSessionId).toBe("after-cleanup")
    writeFileSync(join(dir, "sessions.json"), "corrupt fixture")
    const found = lookupSession(sessionId, [...messages, { role: "user", content: "next" }], cwd)
    expect(found.type).toBe("continuation")
    if (found.type !== "continuation") throw new Error("expected continuation")
    expect(found.session.claudeSessionId).toBe("after-cleanup")
  })

  it("refreshes a stale in-memory generation from the shared mapping", async () => {
    const messages = [{ role: "user", content: "hello" }]
    const continuation = [...messages, { role: "user", content: "next" }]
    await storeSession("client-session", messages, "sdk-generation-a")

    const cached = lookupSession("client-session", continuation)
    expect(cached.type).toBe("continuation")
    if (cached.type !== "continuation") throw new Error("expected continuation")
    expect(cached.session.claudeSessionId).toBe("sdk-generation-a")

    // Simulate a second proxy process advancing this logical session. The
    // current process must not keep resuming its stale in-memory generation.
    await storeSharedSession("client-session", "sdk-generation-b")

    const refreshed = lookupSession("client-session", continuation)
    expect(refreshed.type).toBe("continuation")
    if (refreshed.type !== "continuation") throw new Error("expected continuation")
    expect(refreshed.session.claudeSessionId).toBe("sdk-generation-b")
    expect(lookupSharedSession("client-session")?.claudeSessionId).toBe("sdk-generation-b")
  })

  it("honors an authoritative cross-process eviction over stale local memory", async () => {
    const messages = [{ role: "user", content: "hello" }]
    await storeSession("client-session", messages, "sdk-generation-a")
    // Leave the process cache populated while another process removes the
    // authoritative mapping.
    await evictSharedSession("client-session")

    const continuation = lookupSession("client-session", [
      ...messages,
      { role: "user", content: "next" },
    ])
    expect(continuation).toEqual({ type: "diverged", reason: "not-found" })
  })

  it("never applies a keyed generation token to an unrelated fingerprint key", async () => {
    const keyedMessages = [{ role: "user", content: "keyed" }]
    const headerlessMessages = [{ role: "user", content: "headerless" }]
    const cwd = "/tmp/cache-key-bound"
    await storeSession("keyed-session", keyedMessages, "keyed-sdk", cwd)
    await storeSession(undefined, headerlessMessages, "headerless-sdk", cwd)
    const keyed = lookupSharedSessionResult("keyed-session")
    if (keyed.status !== "found" || !keyed.generation) throw new Error("missing keyed generation")
    const fingerprint = getConversationFingerprint(headerlessMessages, cwd)

    expect(await evictSession("keyed-session", cwd, keyedMessages, keyed.generation)).toBe(true)
    expect(lookupSharedSession("keyed-session")).toBeUndefined()
    expect(lookupSharedSession(fingerprint)?.claudeSessionId).toBe("headerless-sdk")
  })

  it("purges every local alias when Claude-ID lookup observes durable absence", async () => {
    const messages = [{ role: "user", content: "hello" }]
    await storeSession("client-session", messages, "sdk-generation-a")
    expect(getSessionByClaudeId("sdk-generation-a")?.claudeSessionId).toBe("sdk-generation-a")
    await evictSharedSession("client-session")
    expect(getSessionByClaudeId("sdk-generation-a")).toBeUndefined()
    expect(lookupSession("client-session", [...messages, { role: "user", content: "next" }]))
      .toEqual({ type: "diverged", reason: "not-found" })
  })

})
