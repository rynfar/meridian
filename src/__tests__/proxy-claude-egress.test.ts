import { afterEach, beforeEach, expect, it } from "bun:test"
import type { query } from "@anthropic-ai/claude-agent-sdk"
import { sanitizeClaudeEgressEnv } from "../proxy/claudeEgress"
import { assistantMessage, makeRequest, resolveMockSdkSessionId } from "./helpers"
import { installSdkMock } from "./sdkMock"

const captured: Parameters<typeof query>[0][] = []

installSdkMock(() => ({
  query: (params: Parameters<typeof query>[0]) => {
    captured.push(params)
    return (async function* () {
      yield {
        ...assistantMessage([{ type: "text", text: "ok" }]),
        session_id: resolveMockSdkSessionId(params.options, "egress-fixture"),
      }
    })()
  },
  createSdkMcpServer: ({ name }: { name: string }) => ({ type: "sdk", name, instance: {} }),
  tool: (name: string) => ({ name }),
}), "proxy-claude-egress.test.ts")

const { createProxyServer } = await import("../proxy/server")

const inbound = {
  "content-type": "application/json",
  "x-meridian-client": "voice-ai/0.9.3",
  "x-meridian-installation": "verify-client-id",
  "x-meridian-device": "m4max",
  "x-meridian-purpose": "test",
  "x-meridian-session": "verify-1",
  "x-meridian-arbitrary": "raw-request-only",
  "x-meridian-profile": "egress-profile",
} as const
const allowedHeaders = ["X-Gateway-Route: region-a, region-b:443", "X-Other: retained"] as const
const configuredHeaders = `x-meridian-client: env-only\n${allowedHeaders[0]}\r\n  X-Meridian-Arbitrary \t: env-only-too\r\n${allowedHeaders[1]}`
const profileBaseUrl = "https://selected.example.invalid"
const customHeadersKey = "ANTHROPIC_CUSTOM_HEADERS"

let originalCustomHeaders: string | undefined
let originalPassthrough: string | undefined
beforeEach(() => {
  captured.length = 0
  originalCustomHeaders = process.env[customHeadersKey]
  originalPassthrough = process.env.MERIDIAN_PASSTHROUGH
  process.env[customHeadersKey] = configuredHeaders
  process.env.MERIDIAN_PASSTHROUGH = "0"
})
afterEach(() => {
  captured.length = 0
  if (originalCustomHeaders === undefined) delete process.env[customHeadersKey]
  else process.env[customHeadersKey] = originalCustomHeaders
  if (originalPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
  else process.env.MERIDIAN_PASSTHROUGH = originalPassthrough
})

type Scenario = {
  readonly label: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: unknown
  readonly tools: string[] | undefined
  readonly forwardedTool?: string
}

const scenarios: Scenario[] = [
  {
    label: "standard Messages",
    path: "/v1/messages",
    headers: { "x-meridian-agent": "opencode", "x-opencode-session": "egress-standard" },
    body: makeRequest({ stream: false }),
    tools: undefined,
  },
  {
    label: "Messages with passthrough tools",
    path: "/v1/messages",
    headers: { "x-meridian-agent": "passthrough", "x-litellm-session-id": "egress-tool-loop" },
    body: makeRequest({ stream: false, tools: [{ name: "look_up", input_schema: { type: "object" } }] }),
    tools: [],
    forwardedTool: "mcp__litellm__look_up",
  },
  {
    label: "Codex Responses",
    path: "/v1/responses",
    headers: { "user-agent": "codex_cli_rs/0.144.0" },
    body: { model: "claude-sonnet-4-5-20250929", input: "Hello", stream: false, prompt_cache_key: "egress-codex" },
    tools: [],
  },
]

it.each(scenarios)("$label keeps Meridian headers out of Claude SDK options and the subprocess env", async (scenario) => {
  const server = createProxyServer({
    port: 0,
    host: "127.0.0.1",
    profiles: [
      { id: "default-fixture", type: "api", baseUrl: "https://default.example.invalid" },
      { id: "egress-profile", type: "api", baseUrl: profileBaseUrl },
    ],
  })
  try {
    const response = await server.app.fetch(new Request(new URL(scenario.path, "http://localhost").href, {
      method: "POST",
      headers: new Headers({ ...inbound, ...scenario.headers }),
      body: JSON.stringify(scenario.body),
    }))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("ok")
    expect(captured).toHaveLength(1)
    const params = captured[0]
    expect(params?.options?.tools).toEqual(scenario.tools)
    if (scenario.forwardedTool) expect(params?.options?.allowedTools).toContain(scenario.forwardedTool)
    expect(params?.options?.env?.ANTHROPIC_BASE_URL).toBe(profileBaseUrl)
    expect(params?.options?.env?.ANTHROPIC_CUSTOM_HEADERS?.split(/\r?\n/)).toEqual([...allowedHeaders])
    const leakedRequestAttribution = /x-meridian-|voice-ai\/0\.9\.3|verify-client-id|verify-1|raw-request-only/i.test(JSON.stringify(params))
    expect(leakedRequestAttribution).toBe(false)
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(configuredHeaders)
  } finally {
    await server.closeBackend?.()
  }
})

it("filters process headers when the SDK would otherwise inherit its entire environment", () => {
  const env = sanitizeClaudeEgressEnv(undefined)

  expect(env?.ANTHROPIC_CUSTOM_HEADERS?.split(/\r?\n/)).toEqual([...allowedHeaders])
  expect(env?.MERIDIAN_PASSTHROUGH).toBe("0")
  expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(configuredHeaders)
})

it("keeps the explicit SDK environment even when its only custom header is removed", () => {
  const explicit = { [customHeadersKey]: "x-meridian-profile-only: fixture", ANTHROPIC_BASE_URL: profileBaseUrl }

  expect(sanitizeClaudeEgressEnv(explicit)).toEqual({ ANTHROPIC_CUSTOM_HEADERS: "", ANTHROPIC_BASE_URL: profileBaseUrl })
  expect(explicit.ANTHROPIC_CUSTOM_HEADERS).toBe("x-meridian-profile-only: fixture")
})
