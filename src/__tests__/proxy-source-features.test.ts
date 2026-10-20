/**
 * One-shot title/summary requests skip the Claude Code preset.
 *
 * Under the preset, OpenCode's title prompt is only appended context and the
 * model answers the user's message, which OpenCode then stores as the title.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, withMockSdkSessionId } from "./helpers"

let mockMessages: unknown[] = []
let capturedQueryParams: any = null

installSdkMock(() => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) {
        yield withMockSdkSessionId(msg, params.options)
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "proxy-source-features.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer } = await import("../proxy/server")
const { getSourceFeatureOverrides } = await import("../proxy/sdkFeatures")

const TITLE_PROMPT = "You are a title generator. You output ONLY a thread title. Nothing else."

async function post(app: any, headers: Record<string, string> = {}) {
  const r = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "dummy", "user-agent": "opencode/1.0.0", ...headers },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 64,
      stream: false,
      system: [{ type: "text", text: TITLE_PROMPT }],
      messages: [{ role: "user", content: "How do I improve session names?" }],
    }),
  }))
  await r.json()
  return capturedQueryParams
}

const isPreset = (sp: any) => !!sp && typeof sp === "object" && sp.preset === "claude_code"

describe("getSourceFeatureOverrides", () => {
  it("turns the preset off only for one-shot title and summary sources", () => {
    expect(getSourceFeatureOverrides("subagent-title")).toEqual({ codeSystemPrompt: false })
    expect(getSourceFeatureOverrides("subagent-summary")).toEqual({ codeSystemPrompt: false })
    expect(getSourceFeatureOverrides("subagent-compaction")).toEqual({})
    expect(getSourceFeatureOverrides("subagent-explore")).toEqual({})
    expect(getSourceFeatureOverrides(undefined)).toEqual({})
  })
})

describe("Integration: x-meridian-source feature overrides", () => {
  let app: any
  let savedPassthrough: string | undefined

  beforeAll(() => {
    app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
  })

  beforeEach(() => {
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    mockMessages = [assistantMessage([{ type: "text", text: "Session name summaries" }])]
    capturedQueryParams = null
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("sends the title prompt as the whole system prompt for subagent-title", async () => {
    const params = await post(app, {
      "x-meridian-source": "subagent-title",
      "x-opencode-agent-mode": "subagent",
      "x-opencode-agent-name": "title",
    })
    expect(isPreset(params.options.systemPrompt)).toBe(false)
    expect(params.options.systemPrompt).toContain(TITLE_PROMPT)
  })

  it("keeps the preset for an ordinary OpenCode turn", async () => {
    const params = await post(app, { "x-opencode-session": "ses_source_features" })
    expect(isPreset(params.options.systemPrompt)).toBe(true)
  })
})
