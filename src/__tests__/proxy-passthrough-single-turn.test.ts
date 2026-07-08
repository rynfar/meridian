/**
 * Passthrough Mode: client-driven single-step semantics (non-streaming)
 *
 * A passthrough /v1/messages request must behave like the raw Anthropic API:
 * return the tool calls the model makes for ONE logical step and hand them back
 * so the CLIENT drives the tool loop. Claude Code's nested SDK session instead
 * blocks each forwarded tool and lets the model keep going — fabricating results
 * and looping — which broke client-driven loops (AI SDK generateText /
 * generateObject, e.g. Anchor's workflow spine) two ways:
 *
 *   1. Turn budget: sequential loops / forced tool_choice keep the SDK looping
 *      until it trips maxTurns → the non-stream path threw HTTP 500.
 *   2. Concatenation / duplication: every internal turn's tool_use was merged
 *      into the single response → multiple concatenated tool_use / JSON objects
 *      (unparseable structured output; #528 parallel-call duplication).
 *
 * The capture path now distinguishes:
 *   - genuine parallel calls (DISTINCT tool names)     → all forwarded
 *   - an exact re-emit of a blocked call (same name+input, new id) → dropped
 *   - the same tool re-called with NEW args (loop continuation) → stop
 *   - a forced single tool (tool_choice:{type:"tool"})           → keep first
 *
 * This drives a hook-aware SDK mock that fires PreToolUse between turns — how
 * the real SDK accumulates captures — and asserts each rule.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { makeRequest } from "./helpers"

const PASSTHROUGH_PREFIX = "mcp__oc__"

// Assistant turns the mocked SDK yields, in order. Each tool_use turn's hook is
// fired after the turn is yielded, simulating the real SDK executing (and the
// passthrough PreToolUse hook capturing + blocking) between turns.
let mockTurns: any[] = []

function toolTurn(toolId: string, toolName: string, input: Record<string, unknown>) {
  return {
    type: "assistant",
    message: {
      id: `msg_${toolId}`,
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id: toolId, name: `${PASSTHROUGH_PREFIX}${toolName}`, input }],
      model: "claude-sonnet-4-5-20250929",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "test-session",
  }
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) =>
    (async function* () {
      const preHook = opts?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
      for (const turn of mockTurns) {
        yield turn
        // Simulate the SDK executing this turn's tool call: the passthrough
        // PreToolUse hook fires (captures + blocks) BEFORE the next turn is
        // produced. If the consumer has already broken, this never runs for
        // later turns.
        if (preHook && turn.type === "assistant") {
          for (const block of turn.message.content) {
            if (block.type === "tool_use") {
              await preHook({ tool_name: block.name, tool_use_id: block.id, tool_input: block.input })
            }
          }
        }
      }
    })(),
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

const tool = (name: string) => ({
  name,
  description: `${name} tool`,
  input_schema: { type: "object", properties: {}, additionalProperties: true },
})

async function postNonStream(app: any, overrides: Record<string, unknown> = {}): Promise<Response> {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      makeRequest({
        stream: false,
        tools: [tool("get_weather"), tool("get_time")],
        messages: [{ role: "user", content: "Do the thing." }],
        ...overrides,
      })
    ),
  })
  return app.fetch(req)
}

function toolBlocks(body: any): Array<{ name: string; id: string; input: any }> {
  return body.content.filter((b: any) => b.type === "tool_use")
}

describe("Passthrough non-streaming: client-driven single-step semantics", () => {
  let origEnv: string | undefined

  beforeEach(() => {
    mockTurns = []
    origEnv = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    clearSessionCache()
  })

  afterEach(() => {
    if (origEnv !== undefined) process.env.MERIDIAN_PASSTHROUGH = origEnv
    else delete process.env.MERIDIAN_PASSTHROUGH
    mockTurns = []
  })

  it("keeps DISTINCT parallel tool_use across internal turns (no truncation, no dup) — #528", async () => {
    // The SDK serializes even a parallel request into separate turns. Both
    // distinct tools must survive; neither may be dropped or duplicated.
    mockTurns = [
      toolTurn("toolu_w", "get_weather", { city: "Paris" }),
      toolTurn("toolu_t", "get_time", { city: "Paris" }),
    ]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
    const body = (await (await postNonStream(app)).json()) as any

    const tus = toolBlocks(body)
    expect(tus.map(t => t.name).sort()).toEqual(["get_time", "get_weather"])
    expect(body.stop_reason).toBe("tool_use")
  })

  it("drops an EXACT re-emit (same name+input, new id) but keeps a following distinct call — #528", async () => {
    // Order: distinct, then a duplicate of the first, then another distinct.
    // The duplicate is dropped without stopping collection of the distinct set.
    mockTurns = [
      toolTurn("toolu_w1", "get_weather", { city: "Paris" }),
      toolTurn("toolu_w2", "get_weather", { city: "Paris" }), // exact re-emit → dropped
      toolTurn("toolu_t1", "get_time", { city: "Paris" }),    // distinct → kept
    ]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
    const body = (await (await postNonStream(app)).json()) as any

    const tus = toolBlocks(body)
    expect(tus.map(t => t.name).sort()).toEqual(["get_time", "get_weather"])
    // The kept get_weather is the first occurrence.
    expect(tus.find(t => t.name === "get_weather")!.id).toBe("toolu_w1")
  })

  it("stops at the first repeat of the SAME tool with new args (sequential loop)", async () => {
    // A sequential-dependency loop: the model re-calls the same tool with a
    // fabricated ack. Only the first call is the client's real next step.
    mockTurns = [
      toolTurn("toolu_1", "get_weather", { city: "Paris" }),
      toolTurn("toolu_2", "get_weather", { city: "London" }), // same tool, new args → stop
      toolTurn("toolu_3", "get_weather", { city: "Tokyo" }),
    ]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
    const body = (await (await postNonStream(app)).json()) as any

    const tus = toolBlocks(body)
    expect(tus.length).toBe(1)
    expect(tus[0]!.id).toBe("toolu_1")
  })

  it("returns exactly one tool_use when tool_choice forces a single tool (structured output)", async () => {
    // generateObject sends tool_choice:{type:"tool",...}. Even if the SDK loops
    // and re-answers with different args, only the first structured call ships.
    mockTurns = [
      toolTurn("toolu_a", "json", { answer: "first" }),
      toolTurn("toolu_b", "json", { answer: "second, different" }),
    ]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
    const body = (await (await postNonStream(app, {
      tools: [tool("json")],
      tool_choice: { type: "tool", name: "json", disable_parallel_tool_use: true },
    })).json()) as any

    const tus = toolBlocks(body)
    expect(tus.length).toBe(1)
    expect(tus[0]!.id).toBe("toolu_a")
    expect(tus[0]!.input.answer).toBe("first")
  })

  it("preserves first-turn text alongside the tool_use", async () => {
    mockTurns = [
      {
        type: "assistant",
        message: {
          id: "msg_mixed",
          type: "message",
          role: "assistant",
          content: [
            { type: "text", text: "Fetching the weather." },
            { type: "tool_use", id: "toolu_a", name: `${PASSTHROUGH_PREFIX}get_weather`, input: { city: "Paris" } },
          ],
          model: "claude-sonnet-4-5-20250929",
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        parent_tool_use_id: null,
        uuid: crypto.randomUUID(),
        session_id: "test-session",
      },
      toolTurn("toolu_b", "get_weather", { city: "London" }), // same tool repeat → stop
    ]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
    const body = (await (await postNonStream(app)).json()) as any

    const tus = toolBlocks(body)
    const texts = body.content.filter((b: any) => b.type === "text")
    expect(tus.length).toBe(1)
    expect(tus[0]!.id).toBe("toolu_a")
    expect(texts.some((b: any) => b.text.includes("Fetching the weather."))).toBe(true)
  })
})
