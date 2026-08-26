import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage } from "./helpers"

type QueryCall = {
  readonly oauthToken?: string
  readonly model?: string
  readonly resume?: string
  readonly promptTexts: string[]
}

let queryCalls: QueryCall[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: { prompt: string | AsyncIterable<unknown>; options?: { env?: Record<string, string>; model?: string; resume?: string } }) => {
    const call: QueryCall = {
      oauthToken: params.options?.env?.CLAUDE_CODE_OAUTH_TOKEN,
      model: params.options?.model,
      resume: params.options?.resume,
      promptTexts: [],
    }
    queryCalls.push(call)
    return (async function* () {
      if (typeof params.prompt === "string") {
        call.promptTexts.push(params.prompt)
      } else {
        for await (const message of params.prompt) {
          if (message && typeof message === "object" && "message" in message) {
            const envelope = message.message
            if (envelope && typeof envelope === "object" && "content" in envelope) {
              if (typeof envelope.content === "string") call.promptTexts.push(envelope.content)
            }
          }
        }
      }
      yield assistantMessage([{ type: "text", text: "ok" }])
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_context: unknown, run: () => unknown) => run(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

mock.module("../proxy/models", () => ({
  CANONICAL_SONNET_MODEL: "claude-sonnet-4-6",
  explicitModelPin: () => ({}),
  getAuthCacheInfo: () => ({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }),
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, subscriptionType: "max" }),
  getResolvedClaudeExecutableInfo: () => null,
  hasExtendedContext: () => false,
  isClosedControllerError: () => false,
  mapModelToClaudeModel: (model: string) => model,
  recordExtendedContextUnavailable: () => {},
  resolveClaudeExecutableAsync: async () => "claude",
  resolveClaudeExecutableSync: () => ({ path: "claude", source: "path" }),
  resolveSdkModelDefaults: () => ({
    ANTHROPIC_DEFAULT_FABLE_MODEL: "fable",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "opus",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku",
  }),
  stripExtendedContext: (model: string) => model,
  subscriptionIncludesExtendedContext: () => false,
}))

const designDir = mkdtempSync(join(tmpdir(), "meridian-routing-exclusions-"))
process.env.MERIDIAN_DESIGN_TOKEN_PATH = join(designDir, "missing-token.json")

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile, setActiveProfile } = await import("../proxy/profiles")
const { setSetting } = await import("../proxy/settings")

const PROFILES: Array<{ readonly id: string; readonly type: "oauth-token"; readonly oauthToken: string }> = [
  { id: "work", type: "oauth-token", oauthToken: "token-work" },
  { id: "personal", type: "oauth-token", oauthToken: "token-personal" },
]

type TestApp = ReturnType<typeof createProxyServer>["app"]

function createTestApp(): TestApp {
  return createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" }).app
}

function anthropicRequest(path = "/v1/messages", profile?: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(profile ? { "x-meridian-profile": profile } : {}) },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 32, stream: false, messages: [{ role: "user", content: "work" }] }),
  })
}

async function responseErrorType(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json()
  if (!body || typeof body !== "object" || !("error" in body)) return undefined
  const error = body.error
  if (!error || typeof error !== "object" || !("type" in error)) return undefined
  return typeof error.type === "string" ? error.type : undefined
}

beforeEach(() => {
  queryCalls = []
  clearSessionCache()
  resetActiveProfile()
  setSetting("routingExcludedProfiles", [])
  setSetting("routingManagedExcludedProfiles", [])
  setSetting("routing", "active")
  setSetting("profileOrder", [])
  delete process.env.MERIDIAN_API_KEY
  delete process.env.MERIDIAN_ROUTING
  delete process.env.MERIDIAN_PROFILE_ORDER
})

afterEach(() => {
  setSetting("routingExcludedProfiles", [])
  setSetting("routingManagedExcludedProfiles", [])
  setSetting("routing", "active")
  setSetting("profileOrder", [])
  delete process.env.MERIDIAN_API_KEY
  delete process.env.MERIDIAN_ROUTING
  delete process.env.MERIDIAN_PROFILE_ORDER
})

afterAll(() => {
  delete process.env.MERIDIAN_DESIGN_TOKEN_PATH
  rmSync(designDir, { recursive: true, force: true })
})

describe("routing exclusion settings", () => {
  it("does not persist any fields when a composite routing update is invalid", async () => {
    // Given
    setSetting("routing", "active")
    setSetting("profileOrder", ["work", "personal"])
    setSetting("routingExcludedProfiles", ["personal"])
    const app = createTestApp()

    // When
    const put = await app.fetch(new Request("http://localhost/settings/api/routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routing: "sticky",
        profileOrder: ["personal", "work"],
        routingExcludedProfiles: "work",
      }),
    }))
    const get = await app.fetch(new Request("http://localhost/settings/api/routing"))
    const body = await get.json() as {
      routing: string
      profileOrder: string[]
      routingExcludedProfiles: string[]
    }

    // Then
    expect(put.status).toBe(400)
    expect(body.routing).toBe("active")
    expect(body.profileOrder).toEqual(["work", "personal"])
    expect(body.routingExcludedProfiles).toEqual(["personal"])
  })

  it("reports the implicit default profile as active when no profiles are configured", async () => {
    // Given
    const app = createProxyServer({ port: 0, host: "127.0.0.1", profiles: [] }).app

    // When
    const response = await app.fetch(new Request("http://localhost/profiles/list"))
    const body = await response.json() as { activeProfile: string | null; profiles: unknown[] }

    // Then
    expect(response.status).toBe(200)
    expect(body.activeProfile).toBe("default")
    expect(body.profiles).toEqual([])
  })

  it("persists unknown future profile ids through the routing API", async () => {
    // Given
    const app = createTestApp()

    // When
    const put = await app.fetch(new Request("http://localhost/settings/api/routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routingExcludedProfiles: ["work", "future-profile"] }),
    }))

    // Then
    expect(put.status).toBe(200)
    const get = await app.fetch(new Request("http://localhost/settings/api/routing"))
    const body: unknown = await get.json()
    expect(body).toMatchObject({ routingExcludedProfiles: ["work", "future-profile"] })
  })

  it("replaces managed exclusions without deleting manual exclusions", async () => {
    // Given
    setSetting("routingExcludedProfiles", ["work"])
    setSetting("routingManagedExcludedProfiles", ["personal"])
    const app = createTestApp()

    // When
    const put = await app.fetch(new Request("http://localhost/settings/api/routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routingManagedExcludedProfiles: ["future-profile"] }),
    }))

    // Then
    expect(put.status).toBe(200)
    const get = await app.fetch(new Request("http://localhost/settings/api/routing"))
    const body: unknown = await get.json()
    expect(body).toMatchObject({
      routingExcludedProfiles: ["work"],
      routingManagedExcludedProfiles: ["future-profile"],
    })
  })

  it("moves active state to an eligible profile when exclusions change", async () => {
    // Given
    setActiveProfile("work")
    const app = createTestApp()

    // When
    const put = await app.fetch(new Request("http://localhost/settings/api/routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routingManagedExcludedProfiles: ["work"] }),
    }))
    const listed = await app.fetch(new Request("http://localhost/profiles/list"))
    const body = await listed.json() as {
      activeProfile: string
      profiles: Array<{ readonly id: string; readonly isActive: boolean }>
    }

    // Then
    expect(put.status).toBe(200)
    expect(body.activeProfile).toBe("personal")
    expect(body.profiles.find(profile => profile.id === "personal")?.isActive).toBe(true)
  })
})

describe("work routing exclusions", () => {
  it.each(["active", "sticky", "priority", "active+priority"])("skips an excluded profile in %s routing", async (routing) => {
    // Given
    process.env.MERIDIAN_ROUTING = routing
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
    setSetting("routingExcludedProfiles", ["work"])
    const app = createTestApp()

    // When
    const response = await app.fetch(anthropicRequest())

    // Then
    expect(response.status).toBe(200)
    expect(queryCalls.map(call => call.oauthToken)).toEqual(["token-personal"])
  })

  it("keeps the preferred profile when the exclusion list is empty", async () => {
    // Given
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
    const app = createTestApp()

    // When
    const response = await app.fetch(anthropicRequest())

    // Then
    expect(response.status).toBe(200)
    expect(queryCalls.map(call => call.oauthToken)).toEqual(["token-work"])
  })

  it("returns 409 without provider traffic for an explicitly excluded Anthropic target", async () => {
    // Given
    setSetting("routingExcludedProfiles", ["work"])
    const app = createTestApp()

    // When
    const response = await app.fetch(anthropicRequest("/v1/messages", "work"))

    // Then
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "profile_excluded",
        message: "Profile \"work\" is excluded from work routing",
      },
    })
    expect(queryCalls).toHaveLength(0)
  })

  it("returns 503 without provider traffic when no automatic target is eligible", async () => {
    // Given
    setSetting("routingExcludedProfiles", ["work", "personal"])
    const app = createTestApp()

    // When
    const response = await app.fetch(anthropicRequest())

    // Then
    expect(response.status).toBe(503)
    expect(await responseErrorType(response)).toBe("no_eligible_profiles")
    expect(queryCalls).toHaveLength(0)
  })

  it("combines manual and managed exclusions for work routing", async () => {
    // Given
    setSetting("routingExcludedProfiles", ["work"])
    setSetting("routingManagedExcludedProfiles", ["personal"])
    const app = createTestApp()

    // When
    const response = await app.fetch(anthropicRequest())

    // Then
    expect(response.status).toBe(503)
    expect(await responseErrorType(response)).toBe("no_eligible_profiles")
    expect(queryCalls).toHaveLength(0)
  })

  it("rejects switching the active profile to an excluded target", async () => {
    // Given
    setSetting("routingExcludedProfiles", ["work"])
    const app = createTestApp()

    // When
    const response = await app.fetch(new Request("http://localhost/profiles/active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "work" }),
    }))

    // Then
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "profile_excluded",
        message: "Profile \"work\" is excluded from work routing",
      },
    })
  })

  it("preserves the exclusion contract through OpenAI compatibility", async () => {
    // Given
    setSetting("routingExcludedProfiles", ["work"])
    const app = createTestApp()

    // When
    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-meridian-profile": "work" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "work" }] }),
    }))

    // Then
    expect(response.status).toBe(409)
    expect(await responseErrorType(response)).toBe("profile_excluded")
    expect(queryCalls).toHaveLength(0)
  })

  it("preserves the exclusion contract through the OpenAI Responses API", async () => {
    // Given
    setSetting("routingExcludedProfiles", ["work"])
    const app = createTestApp()

    // When
    const response = await app.fetch(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-meridian-profile": "work" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", input: "work", stream: false }),
    }))

    // Then
    expect(response.status).toBe(409)
    expect(await responseErrorType(response)).toBe("profile_excluded")
    expect(queryCalls).toHaveLength(0)
  })
})

describe("Design and warm routing", () => {
  it("uses an eligible profile for an automatic Design request", async () => {
    // Given
    setSetting("routingExcludedProfiles", ["work"])
    const app = createTestApp()
    const originalFetch = globalThis.fetch
    const capture: { authorization: string | null } = { authorization: null }
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>): Promise<Response> => {
        capture.authorization = new Headers(args[1]?.headers).get("authorization")
        return new Response("{}", { status: 200 })
      },
      { preconnect: originalFetch.preconnect },
    )

    try {
      // When
      const response = await app.fetch(new Request("http://localhost/v1/design/mcp", { method: "POST", body: "{}" }))

      // Then
      expect(response.status).toBe(200)
      expect(capture.authorization).toBe("Bearer token-personal")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("rejects an explicitly excluded Design target before upstream traffic", async () => {
    // Given
    setSetting("routingExcludedProfiles", ["work"])
    const app = createTestApp()

    // When
    const response = await app.fetch(new Request("http://localhost/v1/design/mcp", {
      method: "POST",
      headers: { "x-meridian-profile": "work" },
      body: "{}",
    }))

    // Then
    expect(response.status).toBe(409)
    expect(await responseErrorType(response)).toBe("profile_excluded")
  })

  it("warms an excluded profile with the server-owned fixed request only", async () => {
    // Given
    process.env.MERIDIAN_API_KEY = "warm-secret"
    setSetting("routingExcludedProfiles", ["work"])
    const app = createTestApp()

    // When
    const response = await app.fetch(new Request("http://localhost/profiles/work/warm", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "warm-secret" },
      body: JSON.stringify({ model: "attacker-model", max_tokens: 999, messages: [{ role: "user", content: "attacker prompt" }] }),
    }))

    // Then
    expect(response.status).toBe(200)
    expect(queryCalls).toHaveLength(1)
    expect(queryCalls[0]?.oauthToken).toBe("token-work")
    expect(queryCalls[0]?.model).toBe("claude-haiku-4-5")
    expect(queryCalls[0]?.promptTexts).toEqual(["hi"])
  })

  it("does not let warm calls seed resumable work sessions", async () => {
    // Given
    const app = createTestApp()
    setSetting("routingExcludedProfiles", ["work"])

    // When
    const warmResponse = await app.fetch(new Request("http://localhost/profiles/work/warm", { method: "POST" }))
    setSetting("routingExcludedProfiles", [])
    const workResponse = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-meridian-agent": "openai", "x-meridian-profile": "work" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 8,
        stream: false,
        messages: [
          { role: "user", content: "hi" },
          { role: "user", content: "actual work" },
        ],
      }),
    }))

    // Then
    expect(warmResponse.status).toBe(200)
    expect(workResponse.status).toBe(200)
    expect(queryCalls).toHaveLength(2)
    expect(queryCalls[0]?.resume).toBeUndefined()
    expect(queryCalls[1]?.resume).toBeUndefined()
  })

  it("requires API authentication for the warm endpoint", async () => {
    // Given
    process.env.MERIDIAN_API_KEY = "warm-secret"
    const app = createTestApp()

    // When
    const response = await app.fetch(new Request("http://localhost/profiles/work/warm", { method: "POST" }))

    // Then
    expect(response.status).toBe(401)
    expect(queryCalls).toHaveLength(0)
  })
})
