/**
 * One-shot title/summary requests skip the Claude Code preset.
 *
 * Under the preset, OpenCode's title prompt is only appended context and the
 * model answers the user's message, which OpenCode then stores as the title.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
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
const { updateAdapterFeatures } = await import("../proxy/sdkFeatures")
const { getOpenCodeSourceFeatureOverrides } = await import("../proxy/adapters/opencodeSourceFeatures")

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

describe("getOpenCodeSourceFeatureOverrides", () => {
  it("turns the preset off only for one-shot title and summary sources", () => {
    expect(getOpenCodeSourceFeatureOverrides("subagent-title")).toEqual({ codeSystemPrompt: false })
    expect(getOpenCodeSourceFeatureOverrides("subagent-summary")).toEqual({ codeSystemPrompt: false })
    expect(getOpenCodeSourceFeatureOverrides("subagent-compaction")).toEqual({})
    expect(getOpenCodeSourceFeatureOverrides("subagent-explore")).toEqual({})
    expect(getOpenCodeSourceFeatureOverrides(undefined)).toEqual({})
    expect(getOpenCodeSourceFeatureOverrides("subagent-title", false)).toEqual({})
  })
})

describe("Integration: x-meridian-source feature overrides", () => {
  let app: any
  let proxy: ReturnType<typeof createProxyServer>
  let savedPassthrough: string | undefined
  let savedConfigDir: string | undefined
  let featureRoot = ""

  beforeEach(() => {
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    featureRoot = mkdtempSync(join(tmpdir(), "meridian-title-features-"))
    process.env.MERIDIAN_CONFIG_DIR = featureRoot
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    mockMessages = [assistantMessage([{ type: "text", text: "Session name summaries" }])]
    capturedQueryParams = null
    proxy = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    app = proxy.app
  })

  afterEach(async () => {
    proxy.beginDrain?.()
    const deadline = Date.now() + 5000
    while ((proxy.getInFlightCount?.() ?? 0) > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect((proxy.getInFlightCount?.() ?? 0)).toBe(0)
    await proxy.sweepSessionGc?.()
    await proxy.closeBackend?.()
    if (savedConfigDir === undefined) delete process.env.MERIDIAN_CONFIG_DIR
    else process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    rmSync(featureRoot, { recursive: true, force: true })
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

  it("retains the preset when client prompts are explicitly disabled", async () => {
    updateAdapterFeatures("opencode", { codeSystemPrompt: true, clientSystemPrompt: false })
    const params = await post(app, { "x-meridian-source": "subagent-title" })
    expect(isPreset(params.options.systemPrompt)).toBe(true)
    expect(JSON.stringify(params.options.systemPrompt)).not.toContain(TITLE_PROMPT)
  })

  it("retains another adapter's explicit preset for the same source tag", async () => {
    updateAdapterFeatures("claude-code", { codeSystemPrompt: true, clientSystemPrompt: true })
    const params = await post(app, { "x-meridian-agent": "claude-code", "x-meridian-source": "subagent-title" })
    expect(isPreset(params.options.systemPrompt)).toBe(true)
  })

  it("keeps the preset for an ordinary OpenCode turn", async () => {
    const params = await post(app, { "x-opencode-session": "ses_source_features" })
    expect(isPreset(params.options.systemPrompt)).toBe(true)
  })
})
