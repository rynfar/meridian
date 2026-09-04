/**
 * A client's `x-request-id` must survive failover intact.
 *
 * Priority routing retries a turn against the next profile when an account
 * refuses. Each attempt records its own telemetry row, which is correct — but
 * the row is also the client's only way to ask "what happened to MY request".
 * Forking the id per attempt (`<id>.1`) made the row that actually served the
 * request unfindable by the id the client sent.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, withMockSdkSessionId } from "./helpers"

let failingDirs = new Set<string>()

installSdkMock(() => ({
  query: (params: any) => {
    const dir = params.options?.env?.CLAUDE_CONFIG_DIR ?? "default"
    return (async function* () {
      if ([...failingDirs].some(f => dir.includes(f))) {
        throw new Error("429 rate limit reached for this account")
      }
      const message = assistantMessage([{ type: "text", text: "ok from " + dir }])
      yield withMockSdkSessionId(message, params.options)
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "failover-request-id.test.ts")

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
const { telemetryStore } = await import("../telemetry")

const PROFILES = [
  { id: "work", claudeConfigDir: "/tmp/meridian-reqid-work" },
  { id: "personal", claudeConfigDir: "/tmp/meridian-reqid-personal" },
]

const savedEnv: Record<string, string | undefined> = {}

describe("request id stability across priority failover", () => {
  beforeEach(() => {
    resetProcessSdkSemaphoreForTests()
    clearSessionCache()
    resetActiveProfile()
    rateLimitStore.clear?.()
    failingDirs = new Set()
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

  it("keeps the caller's x-request-id byte-identical on every failover attempt", async () => {
    failingDirs.add("meridian-reqid-work")
    const { app } = createProxyServer({
      port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work",
    })

    const clientId = `client-correlation-${Date.now()}`
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-request-id": clientId },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    }))
    expect(res.status).toBe(200)

    const rows = telemetryStore.getRecent({ limit: 500 })

    // The bug: the winning attempt was filed under `<clientId>.1`, so a client
    // looking up the id it sent found only the row for the account that
    // refused — or nothing at all.
    const mangled = rows.filter(m => m.requestId.startsWith(`${clientId}.`))
    expect(mangled.map(m => m.requestId)).toEqual([])

    const mine = rows.filter(m => m.requestId === clientId)
    expect(mine.length).toBeGreaterThanOrEqual(2)

    // Both the refusal and the success are reachable by the client's own id...
    expect(mine.some(m => m.error !== null)).toBe(true)
    expect(mine.some(m => m.error === null)).toBe(true)

    // ...and the attempts stay distinguishable, which is what forking the id
    // was really for. The served row names the profile that answered; the
    // refusal is identified by its status/error.
    const served = mine.filter(m => m.error === null)
    expect(served).toHaveLength(1)
    expect(served[0]!.profileId).toBe("personal")
    expect(mine.filter(m => m.status === 429)).toHaveLength(1)
  })
})
