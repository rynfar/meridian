/**
 * Integration tests for adapter instances (#476) — full HTTP layer, mocked SDK.
 *
 * Proves the resolution invariant end-to-end:
 *   - BEHAVIOR (transforms → tool config) comes from the BASE adapter
 *   - FEATURES (system prompt preset, thinking) come from the instance
 *   - PASSTHROUGH override comes from the instance
 */
import { describe, it, expect, mock, beforeAll, beforeEach, afterEach } from "bun:test"
import { assistantMessage } from "./helpers"

let mockMessages: any[] = []
let capturedQueryParams: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
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

async function post(app: any, headers: Record<string, string> = {}) {
  const r = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "dummy", "user-agent": "opencode/1.0.0", ...headers },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  }))
  await r.json()
  return capturedQueryParams
}

describe("Integration: adapter instances (#476)", () => {
  let app: any
  let savedInstances: string | undefined
  let savedPassthrough: string | undefined

  beforeAll(() => {
    const { app: a } = createProxyServer({ port: 0, host: "127.0.0.1" })
    app = a
  })

  beforeEach(() => {
    savedInstances = process.env.MERIDIAN_ADAPTER_INSTANCES
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    capturedQueryParams = null
  })

  afterEach(() => {
    if (savedInstances !== undefined) process.env.MERIDIAN_ADAPTER_INSTANCES = savedInstances
    else delete process.env.MERIDIAN_ADAPTER_INSTANCES
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("instance inherits base transforms (opencode tool blocking) while running non-passthrough via override", async () => {
    process.env.MERIDIAN_PASSTHROUGH = "1" // global default: passthrough ON
    process.env.MERIDIAN_ADAPTER_INSTANCES = JSON.stringify({
      "oc-internal": { base: "opencode", passthrough: false },
    })

    const params = await post(app, { "x-meridian-agent": "oc-internal" })
    const opts = params.options
    // Behavior invariant: opencode's transforms applied → built-ins blocked.
    expect(opts.disallowedTools).toContain("Read")
    expect(opts.disallowedTools).toContain("Bash")
    // Passthrough override: NON-passthrough → internal MCP server registered,
    // allowedTools are the mcp__opencode__* set (not passthrough's empty tools).
    expect(Object.keys(opts.mcpServers ?? {})).toContain("opencode")
    expect(opts.allowedTools.some((t: string) => t.startsWith("mcp__opencode__"))).toBe(true)
  })

  it("instance feature override flips the system-prompt preset off", async () => {
    process.env.MERIDIAN_PASSTHROUGH = "0"
    process.env.MERIDIAN_ADAPTER_INSTANCES = JSON.stringify({
      "oc-nopreset": { base: "opencode", features: { codeSystemPrompt: false } },
    })

    // Base opencode (non-passthrough): preset ON by default.
    const baseParams = await post(app)
    const basePrompt = baseParams.options.systemPrompt
    // Instance: preset forced OFF.
    const instParams = await post(app, { "x-meridian-agent": "oc-nopreset" })
    const instPrompt = instParams.options.systemPrompt

    const isPreset = (sp: any) => !!sp && typeof sp === "object" && sp.preset === "claude_code"
    expect(isPreset(instPrompt)).toBe(false)
    // (Base assertion is contextual — depends on systemContext presence — so
    // only assert the instance side strictly, plus that they differ.)
    expect(isPreset(basePrompt)).not.toBe(isPreset(instPrompt))
  })

  it("GOLDEN: with instances configured, un-matched requests behave identically", async () => {
    process.env.MERIDIAN_PASSTHROUGH = "0"
    delete process.env.MERIDIAN_ADAPTER_INSTANCES
    const before = await post(app)

    process.env.MERIDIAN_ADAPTER_INSTANCES = JSON.stringify({
      "oc-nopreset": { base: "opencode", features: { codeSystemPrompt: false } },
    })
    const after = await post(app)

    expect(after.options.disallowedTools).toEqual(before.options.disallowedTools)
    expect(after.options.allowedTools).toEqual(before.options.allowedTools)
    expect(JSON.stringify(after.options.systemPrompt)).toBe(JSON.stringify(before.options.systemPrompt))
  })
})
