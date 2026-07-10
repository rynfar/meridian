/**
 * Passthrough deny → SDK abort (supersedes the approach in PR #570)
 *
 * When the PreToolUse hook detects that the model has stopped making progress
 * against blocked passthrough tools (same tool re-called with new args, or a
 * forced-single tool exceeded), every distinct tool_use for this exchange is
 * already captured. Returning `interrupt: true` or `continue: false` from the
 * hook does NOT stop the nested session — both keys are absent from the CLI's
 * hook-output schema and are stripped by its Zod validation (verified
 * empirically against the real SDK + bundled CLI). The only reliable way to
 * end the nested session immediately is to abort the SDK query's
 * AbortController from the proxy side.
 *
 * These tests assert:
 *   1. Non-stream: the loop-detection deny aborts the SDK controller, and the
 *      response still recovers as a clean stop_reason:"tool_use" message.
 *   2. Stream: an abort-shaped SDK termination with captured tool_uses
 *      recovers to tool_use + message_stop (not an error event) — the stream
 *      gate must accept "aborted" like the non-stream gate does.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { makeRequest, parseSSE } from "./helpers"

const PASSTHROUGH_PREFIX = "mcp__oc__"

let mockTurns: any[] = []
let capturedController: AbortController | undefined
let capturedResume: string | undefined

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

function streamMessageStart() {
  return {
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        id: "msg_stream_1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-5-20250929",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "test-session",
  }
}

// Hook-aware, abort-aware SDK mock. Mirrors the real SDK: each assistant
// turn's PreToolUse hook fires after the turn is yielded, and an aborted
// controller terminates the query with an abort-shaped error (the real
// subprocess is SIGTERMed and surfaces "aborted by user").
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    capturedController = opts?.options?.abortController
    capturedResume = opts?.options?.resume
    return (async function* () {
      const preHook = opts?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
      for (const turn of mockTurns) {
        if (capturedController?.signal.aborted) {
          throw new Error("Claude Code process aborted by user")
        }
        yield turn
        if (preHook && turn.type === "assistant") {
          for (const block of turn.message.content) {
            if (block.type === "tool_use") {
              await preHook({ tool_name: block.name, tool_use_id: block.id, tool_input: block.input })
            }
          }
        }
        if (capturedController?.signal.aborted) {
          throw new Error("Claude Code process aborted by user")
        }
      }
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
  tool: () => ({}),
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

async function post(
  app: any,
  stream: boolean,
  messages: unknown[] = [{ role: "user", content: "Do the thing." }]
): Promise<Response> {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": "deny-abort-session" },
    body: JSON.stringify(
      makeRequest({
        stream,
        tools: [tool("get_weather"), tool("get_time")],
        messages,
      })
    ),
  })
  return app.fetch(req)
}

async function readSSE(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let result = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return parseSSE(result)
}

describe("Passthrough deny aborts the nested SDK session on loop detection", () => {
  let origEnv: string | undefined

  beforeEach(() => {
    origEnv = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    mockTurns = []
    capturedController = undefined
    capturedResume = undefined
    clearSessionCache()
  })

  afterEach(() => {
    if (origEnv === undefined) delete process.env.MERIDIAN_PASSTHROUGH
    else process.env.MERIDIAN_PASSTHROUGH = origEnv
  })

  it("non-stream: aborts the SDK query when a same-tool repeat is detected and still returns the distinct tool_use", async () => {
    mockTurns = [
      toolTurn("toolu_1", "get_weather", { city: "SF" }),
      // Same tool, NEW args — the loop-continuation signal. The hook should
      // abort here; the mock then terminates with an abort-shaped error.
      toolTurn("toolu_2", "get_weather", { city: "LA" }),
      // Must never be reached once the abort fires.
      toolTurn("toolu_3", "get_weather", { city: "NYC" }),
    ]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await post(app, false)
    const body = await response.json() as any

    expect(capturedController).toBeDefined()
    expect(capturedController!.signal.aborted).toBe(true)
    expect(response.status).toBe(200)
    expect(body.stop_reason).toBe("tool_use")
    const toolUses = body.content.filter((b: any) => b.type === "tool_use")
    expect(toolUses.length).toBe(1)
    expect(toolUses[0].id).toBe("toolu_1")
  })

  it("stream: recovers an abort-shaped termination as tool_use + message_stop instead of an error event", async () => {
    mockTurns = [
      streamMessageStart(),
      toolTurn("toolu_s1", "get_weather", { city: "SF" }),
      toolTurn("toolu_s2", "get_weather", { city: "LA" }),
      toolTurn("toolu_s3", "get_weather", { city: "NYC" }),
    ]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await post(app, true)
    const events = await readSSE(response)
    const eventTypes = events.map((e: any) => e.event)

    expect(capturedController).toBeDefined()
    expect(capturedController!.signal.aborted).toBe(true)
    expect(eventTypes).not.toContain("error")
    expect(eventTypes).toContain("message_stop")
    const deltas = events.filter((e: any) => e.event === "message_delta")
    const stopReasons = deltas.map((e: any) => e.data?.delta?.stop_reason).filter(Boolean)
    expect(stopReasons).toContain("tool_use")
    // The distinct captured tool_use must reach the client exactly once.
    const toolStartIds = events
      .filter((e: any) => e.event === "content_block_start" && e.data?.content_block?.type === "tool_use")
      .map((e: any) => e.data.content_block.id)
    expect(toolStartIds).toEqual(["toolu_s1"])
  })

  it("does not offer a single-step-aborted session for resume — the follow-up starts fresh (#552)", async () => {
    mockTurns = [
      toolTurn("toolu_1", "get_weather", { city: "SF" }),
      toolTurn("toolu_2", "get_weather", { city: "LA" }),
    ]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const first = await post(app, false)
    expect(first.status).toBe(200)
    expect(capturedController!.signal.aborted).toBe(true)

    // Follow-up turn: client executed the forwarded call and returns its
    // result. The aborted session's history contains a dangling dropped call
    // ("Stream closed") — resuming it hands the model diverged memory, the
    // source of the "read tool is returning the wrong file" confusion.
    mockTurns = [toolTurn("toolu_3", "get_time", { tz: "UTC" })]
    const second = await post(app, false, [
      { role: "user", content: "Do the thing." },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "72F" }] },
    ])
    expect(second.status).toBe(200)
    expect(capturedResume).toBeUndefined()
  })
})
