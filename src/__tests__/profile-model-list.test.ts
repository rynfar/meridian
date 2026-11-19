import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { installModelsMock } from "./modelsMock"

installSdkMock(() => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "profile-model-list.test.ts")

const logged: Array<{ event: string; data: unknown }> = []
installLoggerMock(() => ({
  claudeLog: (event: string, data?: unknown) => { logged.push({ event, data }) },
  withClaudeLogContext: (_context: unknown, run: () => unknown) => run(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

installModelsMock(() => ({
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, subscriptionType: "team" }),
}))

const { createProxyServer } = await import("../proxy/server")
const { clearAccountModels } = await import("../proxy/accountModels")

const PROFILES = [
  { id: "team", type: "oauth-token" as const, oauthToken: "token-team" },
  { id: "max", type: "oauth-token" as const, oauthToken: "token-max" },
]

const MODELS_BY_TOKEN: Record<string, unknown[]> = {
  "Bearer token-team": [
    { type: "model", id: "claude-mythos-5-2", display_name: "Claude Mythos 5.2", created_at: "2026-11-01T00:00:00Z", max_input_tokens: 1_000_000, max_tokens: 128_000 },
    { type: "model", id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", created_at: "2026-02-17T00:00:00Z", max_input_tokens: 1_000_000, max_tokens: 64_000 },
  ],
  "Bearer token-max": [
    { type: "model", id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", created_at: "2026-02-17T00:00:00Z", max_input_tokens: 1_000_000, max_tokens: 64_000 },
  ],
}

const realFetch = globalThis.fetch
let upstreamCalls: string[] = []
let upstreamStatus = 200

beforeEach(() => {
  clearAccountModels()
  logged.length = 0
  upstreamCalls = []
  upstreamStatus = 200
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const url = String(args[0])
      if (!url.startsWith("https://api.anthropic.com/v1/models")) throw new Error(`unexpected network call in test: ${url}`)
      const authorization = new Headers(args[1]?.headers).get("authorization") ?? ""
      upstreamCalls.push(authorization)
      if (upstreamStatus !== 200) return new Response("{}", { status: upstreamStatus })
      return Response.json({ data: MODELS_BY_TOKEN[authorization] ?? [], has_more: false })
    },
    { preconnect: realFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = realFetch
})

function app() {
  return createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "team" }).app
}

async function models(target: ReturnType<typeof app>, profile?: string) {
  const response = await target.fetch(new Request("http://localhost/v1/models", {
    headers: profile === undefined ? {} : { "x-meridian-profile": profile },
  }))
  const body = await response.json() as { data?: Array<Record<string, unknown>>; error?: { type?: string } }
  return { response, body, ids: (body.data ?? []).map(model => model.id) }
}

describe("GET /v1/models pinned to a profile", () => {
  it("lists that account's own models, Mythos included on a Team account", async () => {
    const server = app()

    const team = await models(server, "team")
    const max = await models(server, "max")

    expect(team.response.status).toBe(200)
    expect(team.response.headers.get("x-meridian-models-source")).toBe("account")
    expect(team.ids).toEqual(["claude-mythos-5-2", "claude-sonnet-4-6"])
    expect(team.body.data![0]).toMatchObject({
      id: "claude-mythos-5-2", object: "model", owned_by: "anthropic", display_name: "Claude Mythos 5.2",
      context_window: 1_000_000, max_output_tokens: 128_000,
    })
    expect(max.ids).toEqual(["claude-sonnet-4-6"])
    expect(upstreamCalls).toEqual(["Bearer token-team", "Bearer token-max"])
  })

  it("serves the cached list on the next read", async () => {
    const server = app()

    await models(server, "team")
    await models(server, "team")

    expect(upstreamCalls).toHaveLength(1)
  })

  it("falls back to the static list when the account's cannot be read", async () => {
    upstreamStatus = 500

    const team = await models(app(), "team")

    expect(team.response.status).toBe(200)
    expect(team.response.headers.get("x-meridian-models-source")).toBe("static")
    expect(team.ids).toContain("claude-sonnet-4-6")
    expect(team.ids).not.toContain("claude-mythos-5-2")
  })

  it("answers 400 unknown_profile for a profile this instance does not have", async () => {
    const unknown = await models(app(), "nobody")

    expect(unknown.response.status).toBe(400)
    expect(unknown.body.error?.type).toBe("unknown_profile")
    expect(upstreamCalls).toHaveLength(0)
  })

  it("leaves the unpinned list static and makes no upstream call", async () => {
    const unpinned = await models(app())

    expect(unpinned.response.status).toBe(200)
    expect(unpinned.response.headers.get("x-meridian-models-source")).toBeNull()
    expect(unpinned.ids).toContain("claude-opus-4-7")
    expect(upstreamCalls).toHaveLength(0)
  })

  it("never logs or returns the credential", async () => {
    const team = await models(app(), "team")

    expect(JSON.stringify(team.body)).not.toContain("token-team")
    expect(JSON.stringify(logged)).not.toContain("token-team")
  })
})
