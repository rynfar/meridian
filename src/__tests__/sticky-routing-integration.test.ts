/**
 * Integration tests for sticky session-to-profile routing (#383) — full HTTP
 * layer, mocked SDK. The profile that served a request is observable via the
 * SDK subprocess env (CLAUDE_CONFIG_DIR carries the profile's config dir).
 */
import { describe, it, expect, mock, beforeAll, beforeEach, afterEach } from "bun:test"
import { assistantMessage } from "./helpers"

let mockMessages: any[] = []
let capturedEnvs: Array<Record<string, string | undefined>> = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedEnvs.push(params.options?.env ?? {})
    return (async function* () {
      for (const msg of mockMessages) yield msg
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")

const PROFILES = [
  { id: "personal", type: "claude-max" as const, claudeConfigDir: "/cfg/personal" },
  { id: "work", type: "claude-max" as const, claudeConfigDir: "/cfg/work" },
]

function servedProfile(env: Record<string, string | undefined>): string {
  if (env.CLAUDE_CONFIG_DIR === "/cfg/personal") return "personal"
  if (env.CLAUDE_CONFIG_DIR === "/cfg/work") return "work"
  return "default"
}

async function post(app: any, session: string, extraHeaders: Record<string, string> = {}) {
  const r = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "dummy",
      "x-opencode-session": session,
      "user-agent": "opencode/1.0.0",
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: `hello from ${session}` }],
    }),
  }))
  await r.json()
  return servedProfile(capturedEnvs[capturedEnvs.length - 1]!)
}

describe("Integration: sticky profile routing (#383)", () => {
  let app: any
  let savedRouting: string | undefined
  let savedPassthrough: string | undefined

  beforeAll(() => {
    const { app: a } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES })
    app = a
  })

  beforeEach(() => {
    savedRouting = process.env.MERIDIAN_ROUTING
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
    resetActiveProfile()
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    capturedEnvs = []
  })

  afterEach(() => {
    if (savedRouting !== undefined) process.env.MERIDIAN_ROUTING = savedRouting
    else delete process.env.MERIDIAN_ROUTING
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("GOLDEN: without MERIDIAN_ROUTING every session lands on the first profile (current behavior)", async () => {
    delete process.env.MERIDIAN_ROUTING
    expect(await post(app, "sess-a")).toBe("personal")
    expect(await post(app, "sess-b")).toBe("personal")
    expect(await post(app, "sess-c")).toBe("personal")
  })

  it("sticky: sessions distribute across profiles and stay sticky", async () => {
    process.env.MERIDIAN_ROUTING = "sticky"
    const seen = new Map<string, string>()
    for (const s of ["sess-a", "sess-b", "sess-c", "sess-d", "sess-e", "sess-f"]) {
      seen.set(s, await post(app, s))
    }
    // Both arms used (sess-a → work, sess-b → personal are pinned by the hash guard).
    expect(new Set(seen.values()).size).toBe(2)
    // Re-request each session: identical assignment every time.
    for (const [s, first] of seen) {
      expect(await post(app, s)).toBe(first)
    }
  })

  it("sticky: x-meridian-profile header still wins", async () => {
    process.env.MERIDIAN_ROUTING = "sticky"
    // sess-a hashes to "work" (pinned) — the explicit header overrides it.
    expect(await post(app, "sess-a", { "x-meridian-profile": "personal" })).toBe("personal")
  })

  it("sticky: subagent requests with the same session header share the arm", async () => {
    process.env.MERIDIAN_ROUTING = "sticky"
    const main = await post(app, "sess-a")
    const subagent = await post(app, "sess-a", { "x-meridian-source": "subagent-scout" })
    expect(subagent).toBe(main)
  })
})
