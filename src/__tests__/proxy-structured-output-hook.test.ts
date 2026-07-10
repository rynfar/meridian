/**
 * Native structured output vs the passthrough PreToolUse deny hook.
 *
 * Claude Code implements `output_config.format` through an SDK-internal
 * `StructuredOutput` tool: the model calls it, the CLI validates the payload
 * against the schema (with retries) and surfaces it as `structured_output`
 * on the result message. In passthrough mode Meridian's PreToolUse hook
 * denies every tool call as "forwarded to the client" — which blocked the
 * internal StructuredOutput call too. The model could never submit its
 * result, the session burned to max_turns, and the result arrived without
 * `structured_output` → HTTP 500 (observed live; see #576 discussion).
 *
 * The hook must exempt StructuredOutput exactly like ToolSearch: return {}
 * so the SDK handles it internally, and never capture it as a client
 * tool_use.
 *
 * The mock emulates the real SDK contract: if the PreToolUse hook denies
 * the StructuredOutput call, the result message carries no
 * structured_output; if the hook lets it through, it does.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

let capturedOptions: Record<string, unknown> = {}
let hookDeniedStructuredOutput: boolean | undefined

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
}

function structuredOutputTurn() {
  return {
    type: "assistant",
    message: {
      id: "msg_so_turn",
      type: "message",
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_so_1",
        name: "StructuredOutput",
        input: { answer: "grounded" },
      }],
      model: "claude-sonnet-4-6",
      stop_reason: "tool_use",
      usage: { input_tokens: 12, output_tokens: 7 },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "structured-hook-session",
  }
}

function resultMessage(withStructuredOutput: boolean) {
  const base: Record<string, unknown> = {
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: withStructuredOutput ? JSON.stringify({ answer: "grounded" }) : "denied",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { input_tokens: 12, output_tokens: 7 },
    modelUsage: {},
    permission_denials: [],
    errors: [],
    uuid: crypto.randomUUID(),
    session_id: "structured-hook-session",
  }
  if (withStructuredOutput) base.structured_output = { answer: "grounded" }
  return base
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: { options?: Record<string, unknown> }) => {
    capturedOptions = opts.options ?? {}
    return (async function* () {
      const preHook = (opts.options as any)?.hooks?.PreToolUse?.[0]?.hooks?.[0]
      const turn = structuredOutputTurn()
      yield turn
      let denied = false
      if (preHook) {
        const res = await preHook({
          tool_name: "StructuredOutput",
          tool_use_id: "toolu_so_1",
          tool_input: { answer: "grounded" },
        })
        denied = !!res && res.decision === "block"
      }
      hookDeniedStructuredOutput = denied
      yield resultMessage(!denied)
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
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

function request(stream: boolean) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      stream,
      messages: [{ role: "user", content: "Return an answer." }],
      output_config: { format: { type: "json_schema", schema } },
    }),
  })
}

describe("structured output survives the passthrough deny hook", () => {
  let originalPassthrough: string | undefined

  beforeEach(() => {
    originalPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    capturedOptions = {}
    hookDeniedStructuredOutput = undefined
    clearSessionCache()
  })

  afterEach(() => {
    if (originalPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
    else process.env.MERIDIAN_PASSTHROUGH = originalPassthrough
  })

  it("non-stream: the hook exempts StructuredOutput and the authoritative JSON is returned", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await app.fetch(request(false))
    const body = await response.json() as any

    expect(hookDeniedStructuredOutput).toBe(false)
    expect(response.status).toBe(200)
    expect(body.content).toEqual([{ type: "text", text: '{"answer":"grounded"}' }])
    expect(body.stop_reason).toBe("end_turn")
  })

  it("stream: the hook exempts StructuredOutput and one valid SSE message is emitted", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await app.fetch(request(true))
    const body = await response.text()

    expect(hookDeniedStructuredOutput).toBe(false)
    expect(response.status).toBe(200)
    expect(body).toContain('"text":"{\\"answer\\":\\"grounded\\"}"')
    expect(body).toContain('"stop_reason":"end_turn"')
    expect(body).not.toContain("event: error")
  })
})
