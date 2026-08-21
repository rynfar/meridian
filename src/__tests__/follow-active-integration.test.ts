/**
 * HTTP surface of follow mode: what `/profiles/list` reports, and what
 * `POST /profiles/active` does when this instance does not own its active
 * profile.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mock } from "bun:test"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => (async function* () {
    yield {
      type: "assistant",
      message: { type: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: `session-${Date.now()}`,
    }
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

// Pass through the real resolveSdkModelDefaults — mock.module is process-global
// in Bun, and stubbing it as () => ({}) leaks to proxy-env-stripping.test.ts.
import { resolveSdkModelDefaults } from "../proxy/models"

mock.module("../proxy/models", () => ({
  mapModelToClaudeModel: () => "sonnet",
  resolveClaudeExecutableAsync: async () => "claude",
  resolveSdkModelDefaults,
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, email: "test@test.com", subscriptionType: "max" }),
  getAuthCacheInfo: () => ({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }),
  hasExtendedContext: () => false,
  stripExtendedContext: (m: string) => m,
  isClosedControllerError: (e: unknown) => e instanceof Error && e.message.includes("controller is closed"),
  recordExtendedContextUnavailable: () => {},
  isExtendedContextKnownUnavailable: () => false,
}))

const { createProxyServer } = await import("../proxy/server")
const { resetActiveProfile, setActiveProfile } = await import("../proxy/profiles")
const { resetFollowActive, setFollowStateForTesting } = await import("../proxy/followActive")
const { clearSessionCache } = await import("../proxy/session/cache")

const FOLLOWED = "http://127.0.0.1:3456"
const profiles = [
  { id: "personal", claudeConfigDir: "/home/.claude" },
  { id: "work", claudeConfigDir: "/home/.claude-work" },
]

beforeEach(() => {
  resetActiveProfile()
  resetFollowActive()
  clearSessionCache()
  delete process.env.MERIDIAN_FOLLOW_ACTIVE
})

afterEach(() => {
  resetFollowActive()
  resetActiveProfile()
  delete process.env.MERIDIAN_FOLLOW_ACTIVE
})

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles })
  return app
}

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init)
}

function following(profileId: string, at = Date.now()): void {
  process.env.MERIDIAN_FOLLOW_ACTIVE = FOLLOWED
  setFollowStateForTesting({ lastGood: { profileId, at } })
}

describe("GET /profiles/list under follow mode", () => {
  test("no follow block when the mode is off", async () => {
    const res = await createTestApp().fetch(req("/profiles/list"))
    const body = await res.json() as Record<string, unknown>
    expect(body.follow).toBeUndefined()
  })

  test("activeProfile and isActive report the followed value", async () => {
    setActiveProfile("personal")
    following("work")

    const res = await createTestApp().fetch(req("/profiles/list"))
    const body = await res.json() as {
      activeProfile: string
      profiles: Array<{ id: string; isActive: boolean }>
      follow: { url: string; activeProfile: string | null; reason: string | null; stale: boolean }
    }

    expect(body.activeProfile).toBe("work")
    expect(body.profiles.find(p => p.id === "work")?.isActive).toBe(true)
    expect(body.profiles.find(p => p.id === "personal")?.isActive).toBe(false)
    expect(body.follow).toMatchObject({ url: FOLLOWED, activeProfile: "work", reason: null, stale: false })
  })

  test("a followed profile this instance lacks is reported, not routed to", async () => {
    setActiveProfile("personal")
    following("randall-personal")

    const res = await createTestApp().fetch(req("/profiles/list"))
    const body = await res.json() as {
      activeProfile: string
      follow: { activeProfile: string | null; followedValue: string | null; reason: string | null }
    }

    expect(body.activeProfile).toBe("personal")
    expect(body.follow).toMatchObject({
      activeProfile: null,
      followedValue: "randall-personal",
      reason: "unknown-profile",
    })
  })
})

describe("POST /profiles/active under follow mode", () => {
  test("refuses with 409 and names what is in charge", async () => {
    setActiveProfile("personal")
    following("work")

    const res = await createTestApp().fetch(req("/profiles/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "personal" }),
    }))

    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; following: { url: string; activeProfile: string | null } }
    expect(body.error).toContain(FOLLOWED)
    expect(body.error).toContain("MERIDIAN_FOLLOW_ACTIVE")
    expect(body.error).toContain("x-meridian-profile")
    expect(body.following).toMatchObject({ url: FOLLOWED, activeProfile: "work" })
  })

  test("the refusal does not change what is served", async () => {
    setActiveProfile("personal")
    following("work")
    const app = createTestApp()

    await app.fetch(req("/profiles/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "personal" }),
    }))

    const body = await (await app.fetch(req("/profiles/list"))).json() as { activeProfile: string }
    expect(body.activeProfile).toBe("work")
  })

  test("refuses even before a followed value has arrived", async () => {
    process.env.MERIDIAN_FOLLOW_ACTIVE = FOLLOWED

    const res = await createTestApp().fetch(req("/profiles/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "work" }),
    }))

    expect(res.status).toBe(409)
  })

  test("switching still works when the mode is off", async () => {
    const res = await createTestApp().fetch(req("/profiles/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "work" }),
    }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, activeProfile: "work" })
  })
})
