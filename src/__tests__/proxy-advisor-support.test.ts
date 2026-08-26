/**
 * Integration tests for advisor tool support.
 *
 * Covers:
 *   - advisorModel extracted from tools and passed to SDK query options
 *   - Advisor tool stripped from passthrough MCP tools
 *   - stop_reason preserved from upstream (pause_turn for advisors)
 *   - Non-advisor requests unaffected
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import {
  assistantMessage,
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  streamEvent,
  parseSSE,
  withMockSdkSessionId,
} from "./helpers"

let capturedOptions: Record<string, unknown> = {}
let mockMessages: unknown[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedOptions = params.options ?? {}
    return (async function* () {
      for (const msg of mockMessages) {
        yield withMockSdkSessionId(msg, params.options)
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
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

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(
  app: ReturnType<typeof createTestApp>,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

async function readStreamFull(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let result = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return result
}

const BASE_BODY = {
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  stream: false,
  messages: [{ role: "user", content: "hi" }],
}

describe("Advisor tool — SDK option passthrough", () => {
  beforeEach(() => {
    capturedOptions = {}
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    clearSessionCache()
  })

  it("passes advisorModel to SDK when advisor tool is in request", async () => {
    const app = createTestApp()
    const res = await post(app, {
      ...BASE_BODY,
      // Only the advisor tool — after extraction and stripping, requestTools
      // becomes empty so no passthrough MCP server is created
      tools: [
        { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-7" },
      ],
    })
    expect(res.status).toBe(200)
    expect(capturedOptions.advisorModel).toBe("claude-opus-4-7")
  })

  it("does not set advisorModel when no advisor tool is present", async () => {
    const app = createTestApp()
    await post(app, {
      ...BASE_BODY,
      tools: [
        { name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
      ],
    })
    expect(capturedOptions.advisorModel).toBeUndefined()
  })

  it("strips advisor tool so it does not appear in SDK tools", async () => {
    const app = createTestApp()
    const res = await post(app, {
      ...BASE_BODY,
      tools: [
        { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-7" },
      ],
    })
    expect(res.status).toBe(200)
    // advisorModel is set, and no passthrough tools remain
    expect(capturedOptions.advisorModel).toBe("claude-opus-4-7")
    // No MCP tools from the advisor definition
    const disallowed = capturedOptions.disallowedTools as string[] | undefined
    if (disallowed) {
      expect(disallowed.some((t: string) => t.includes("advisor"))).toBe(false)
    }
  })
})

describe("Advisor response — stop_reason preservation", () => {
  beforeEach(() => {
    capturedOptions = {}
    mockMessages = []
    clearSessionCache()
  })

  it("preserves pause_turn stop_reason in non-streaming response", async () => {
    const msg = assistantMessage([
      { type: "text", text: "Let me consult the advisor." },
      { type: "server_tool_use", id: "srvtoolu_1", name: "advisor", input: {} },
    ])
    msg.message.stop_reason = "pause_turn"
    mockMessages = [msg]

    const app = createTestApp()
    const res = await post(app, BASE_BODY)

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.stop_reason).toBe("pause_turn")
  })

  it("still uses end_turn when upstream does not set stop_reason", async () => {
    const msg = assistantMessage([{ type: "text", text: "Done." }])
    // Default assistantMessage sets stop_reason to "end_turn" via the helper,
    // but let's explicitly clear it to test the fallback
    ;(msg.message as { stop_reason: string | null }).stop_reason = null as unknown as string
    mockMessages = [msg]

    const app = createTestApp()
    const res = await post(app, BASE_BODY)

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.stop_reason).toBe("end_turn")
  })

  it("preserves tool_use stop_reason from upstream", async () => {
    const msg = assistantMessage([
      { type: "text", text: "I need to read a file." },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/tmp/test" } },
    ])
    msg.message.stop_reason = "tool_use"
    mockMessages = [msg]

    const app = createTestApp()
    const res = await post(app, BASE_BODY)

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.stop_reason).toBe("tool_use")
  })

  it("forwards pause_turn in streaming response", async () => {
    mockMessages = [
      messageStart("msg_advisor_stream"),
      textBlockStart(0),
      textDelta(0, "Consulting advisor."),
      blockStop(0),
      streamEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "advisor", input: {} },
      }),
      streamEvent({ type: "content_block_stop", index: 1 }),
      messageDelta("pause_turn"),
      streamEvent({ type: "message_stop" }),
    ]

    const app = createTestApp()
    const res = await post(app, { ...BASE_BODY, stream: true })

    expect(res.status).toBe(200)
    const events = parseSSE(await readStreamFull(res))
    const msgDelta = events.find((e) => e.event === "message_delta")
    expect((msgDelta?.data as Record<string, unknown> & { delta: Record<string, unknown> }).delta.stop_reason).toBe("pause_turn")
  })
})
