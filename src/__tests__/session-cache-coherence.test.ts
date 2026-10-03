import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearSessionCache, evictSession, getSessionByClaudeId, lookupSession, storeSession } from "../proxy/session/cache"
import { getConversationFingerprint } from "../proxy/session/fingerprint"
import { evictSharedSession, lookupSharedSession, lookupSharedSessionResult, setSessionStoreDir, storeSharedSession } from "../proxy/sessionStore"

describe("cross-process session cache coherence", () => {
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "meridian-cache-coherence-"))
    setSessionStoreDir(dir, { skipLocking: false })
    await clearSessionCache()
  })

  afterEach(async () => {
    await clearSessionCache()
    setSessionStoreDir(null)
    rmSync(dir, { recursive: true, force: true })
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
