/**
 * A request pinned with `x-meridian-profile` runs on that account or fails;
 * it is never served from another one.
 *
 * Two ways that promise was broken or at risk: a pin naming no profile fell
 * through `resolveProfile` to the first configured profile, and a pinned
 * account that refuses must not be failed over to the rest of the pool the
 * way an unpinned priority request is.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { assistantMessage, withMockSdkSessionId } from "./helpers"

import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"

let failingDirs = new Set<string>()
const queriedDirs: string[] = []

installSdkMock(() => ({
  query: (params: { options?: { env?: Record<string, string>; sessionId?: string; resume?: string } }) => {
    const dir = params.options?.env?.CLAUDE_CONFIG_DIR ?? "default"
    queriedDirs.push(dir)
    return (async function* () {
      if ([...failingDirs].some(f => dir.includes(f))) throw new Error("429 rate limit reached for this account")
      yield withMockSdkSessionId(assistantMessage([{ type: "text", text: "ok from " + dir }]), params.options)
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetProcessSdkSemaphoreForTests } = await import("../proxy/concurrency")
const { resetActiveProfile } = await import("../proxy/profiles")
const { rateLimitStore } = await import("../proxy/rateLimitStore")

const PROFILES = [
  { id: "work", claudeConfigDir: "/tmp/meridian-pinstrict-work" },
  { id: "personal", claudeConfigDir: "/tmp/meridian-pinstrict-personal" },
]

const savedEnv: Record<string, string | undefined> = {}

function pinned(profile: string): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-meridian-profile": profile },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    }),
  })
}

describe("a pinned request never reaches another account", () => {
  beforeEach(async () => {
    resetProcessSdkSemaphoreForTests()
    await clearSessionCache()
    resetActiveProfile()
    rateLimitStore.clear?.()
    failingDirs = new Set()
    queriedDirs.length = 0
    savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
    savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
  })

  afterEach(() => {
    resetProcessSdkSemaphoreForTests()
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it("refuses a pin naming no profile instead of serving it from the first one", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" })
    const res = await app.fetch(pinned("no-such-profile"))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe("unknown_profile")
    expect(body.error.message).toContain("no-such-profile")
    expect(queriedDirs).toEqual([])
  })

  it("serves a pin on the profile it names", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" })
    const res = await app.fetch(pinned("personal"))
    expect(res.status).toBe(200)
    expect(queriedDirs.every(dir => dir.includes("pinstrict-personal"))).toBe(true)
    expect(queriedDirs.length).toBeGreaterThan(0)
  })

  it("fails a pin whose account refuses rather than failing over to the pool", async () => {
    failingDirs.add("meridian-pinstrict-work")
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" })
    const res = await app.fetch(pinned("work"))
    expect(res.status).not.toBe(200)
    expect(queriedDirs.length).toBeGreaterThan(0)
    expect(queriedDirs.some(dir => dir.includes("pinstrict-personal"))).toBe(false)
  })
})
