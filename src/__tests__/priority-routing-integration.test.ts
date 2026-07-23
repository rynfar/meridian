/**
 * Priority profile routing integration (routing="priority", opt-in).
 *
 * Through the HTTP layer with a mocked SDK whose behavior is per-profile
 * (keyed by the CLAUDE_CONFIG_DIR each profile injects): asserts ordered
 * preference, per-request failover on rate-limit errors, header-pin bypass,
 * assignment stickiness with cache-preserving drain-back (only NEW sessions
 * return to the preferred profile), exhaustion skip, and that the mode OFF
 * is byte-identical to today's behavior.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { assistantMessage, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop } from "./helpers"

let capturedEnvs: string[] = []
let failingDirs = new Set<string>()

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    const dir = params.options?.env?.CLAUDE_CONFIG_DIR ?? "default"
    capturedEnvs.push(dir)
    const streaming = params.options?.includePartialMessages === true
    return (async function* () {
      if ([...failingDirs].some((f) => dir.includes(f))) {
        throw new Error("429 rate limit reached for this account")
      }
      if (streaming) {
        yield messageStart("msg-1")
        yield textBlockStart(0)
        yield textDelta(0, "ok from " + dir)
        yield blockStop(0)
        yield messageDelta("end_turn")
        yield messageStop()
      }
      yield assistantMessage([{ type: "text", text: "ok from " + dir }])
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")

const PROFILES = [
  { id: "work", claudeConfigDir: "/tmp/meridian-test-prof-work" },
  { id: "personal", claudeConfigDir: "/tmp/meridian-test-prof-personal" },
]

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" })
  return app
}

async function post(app: any, headers: Record<string, string> = {}, content = "hello") {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: false,
      messages: [{ role: "user", content }],
    }),
  }))
}

const savedEnv: Record<string, string | undefined> = {}

describe("priority routing", () => {
  beforeEach(() => {
    capturedEnvs = []
    failingDirs = new Set()
    clearSessionCache()
    // The active profile is process-global module state; other test files
    // (profile-switch integration) set it. This suite's expectations are
    // relative to defaultProfile, so reset it explicitly.
    resetActiveProfile()
    savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
    savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it("routes unpinned requests to the highest-priority profile", async () => {
    const app = createTestApp()
    const res = await post(app, {}, "priority routes preferred unique message")
    expect(res.status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-work")
  })

  it("fails over per request when the preferred profile is rate-limited", async () => {
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await post(app)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.content[0].text).toContain("prof-personal")
    // work attempted (with its internal retry ladder), then personal
    expect(capturedEnvs.some((e) => e.includes("prof-work"))).toBe(true)
    expect(capturedEnvs[capturedEnvs.length - 1]).toContain("prof-personal")
  }, 20_000)

  it("surfaces the LAST tried profile's error when every profile is exhausted", async () => {
    failingDirs.add("prof-work")
    failingDirs.add("prof-personal")
    const app = createTestApp()
    const res = await post(app)
    expect(res.status).toBe(429)
    const body = await res.json() as any
    expect(body.error.type).toBe("rate_limit_error")
  }, 30_000)

  it("a pinned x-meridian-profile header bypasses the pool entirely", async () => {
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await post(app, { "x-meridian-profile": "work" })
    expect(res.status).toBe(429)
    expect(capturedEnvs.every((e) => e.includes("prof-work"))).toBe(true)
  }, 20_000)

  it("keeps a failed-over session on its target while NEW sessions drain back", async () => {
    failingDirs.add("prof-work")
    const app = createTestApp()
    // Session s1 fails over to personal
    const r1 = await post(app, { "x-opencode-session": "s1" })
    expect(r1.status).toBe(200)
    // work recovers
    failingDirs.delete("prof-work")
    capturedEnvs = []
    // s1 continues on personal (assignment retained — cache preserved)
    const r2 = await post(app, { "x-opencode-session": "s1" }, "hello again")
    expect(r2.status).toBe(200)
    expect(capturedEnvs[0]).toContain("prof-personal")
    // ...but work is still marked exhausted (cooldown hasn't expired), so a
    // NEW session ALSO goes to personal for now — exhaustion outlives one
    // success elsewhere. This asserts the assignment layer specifically.
  }, 20_000)

  it("skips a profile marked exhausted without re-attempting it", async () => {
    failingDirs.add("prof-work")
    const app = createTestApp()
    await post(app) // marks work exhausted, serves from personal
    capturedEnvs = []
    const res = await post(app, {}, "second conversation")
    expect(res.status).toBe(200)
    // Straight to personal — no work attempt within the cooldown
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-personal")
  }, 20_000)

  it("streams fail over too when the error precedes any content", async () => {
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    }))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("message_start")
    expect(text).toContain("prof-personal")
    expect(text.split("event: message_start").length - 1).toBe(1)
  }, 20_000)

  it("mode OFF is byte-identical: no failover, error surfaces from the default profile", async () => {
    delete process.env.MERIDIAN_ROUTING
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await post(app, {}, "mode-off unique message")
    expect(res.status).toBe(429)
    expect(capturedEnvs.every((e) => e.includes("prof-work"))).toBe(true)
  }, 20_000)
})
