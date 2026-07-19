/**
 * /v1/responses endpoint integration — #475.
 *
 * Through the HTTP layer with a mocked SDK: asserts the route forwards to
 * /v1/messages, forces passthrough (codex adapter), and returns Responses
 * shapes for both non-stream and stream.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import {
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
} from "./helpers"

let capturedOptions: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    capturedOptions.push(opts.options || {})
    const isStreaming = opts.options?.includePartialMessages === true
    return (async function* () {
      // Fire the PreToolUse deny hook if present (passthrough capture path)
      const preHook = opts?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
      if (isStreaming) {
        yield messageStart("msg-1")
        yield textBlockStart(0)
        yield textDelta(0, "Hello from Codex")
        yield blockStop(0)
        yield messageDelta("end_turn")
        yield messageStop()
      }
      void preHook
      yield {
        type: "assistant",
        uuid: "uuid-1",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello from Codex" }],
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 11, output_tokens: 4 },
        },
        session_id: "sdk-1",
      }
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
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  // Force internal mode globally — the codex adapter must override it to
  // passthrough regardless.
  const prev = process.env.MERIDIAN_PASSTHROUGH
  process.env.MERIDIAN_PASSTHROUGH = "0"
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  process.env.MERIDIAN_PASSTHROUGH = prev
  return app
}

function postResponses(app: any, body: any) {
  return app.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

describe("/v1/responses (#475)", () => {
  beforeEach(() => {
    clearSessionCache()
    capturedOptions = []
  })

  it("400s when input is missing", async () => {
    const app = createTestApp()
    const res = await postResponses(app, { model: "claude-sonnet-5" })
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error.type).toBe("invalid_request_error")
  })

  it("non-stream: returns a completed response object", async () => {
    const app = createTestApp()
    const res = await postResponses(app, { model: "claude-sonnet-5", input: "hi", stream: false })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.object).toBe("response")
    expect(body.status).toBe("completed")
    expect(body.id).toStartWith("resp_")
    const msg = body.output.find((o: any) => o.type === "message")
    expect(msg.content[0].text).toBe("Hello from Codex")
    expect(body.usage.total_tokens).toBe(15)
  })

  it("forces passthrough even when the global default is internal", async () => {
    const app = createTestApp()
    await postResponses(app, {
      model: "claude-sonnet-5",
      input: "list files",
      tools: [{ type: "function", name: "shell", description: "run", parameters: { type: "object", properties: {} } }],
      stream: false,
    })
    // Passthrough forwards tools as MCP + registers the deny hook — the SDK
    // options reflect passthrough mode (disallowedTools present, mcpServers set).
    expect(capturedOptions.length).toBeGreaterThan(0)
    const opts = capturedOptions[0]!
    expect(opts.mcpServers).toBeDefined()
    // codeSystemPrompt OFF: no claude_code preset appended to the system prompt
    const sp = opts.systemPrompt
    const spStr = typeof sp === "string" ? sp : JSON.stringify(sp ?? "")
    expect(spStr).not.toContain("claude_code")
  })

  it("stream: emits the Responses SSE sequence terminating in response.completed", async () => {
    const app = createTestApp()
    const res = await postResponses(app, { model: "claude-sonnet-5", input: "hi", stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain("event: response.created")
    expect(text).toContain("event: response.output_text.delta")
    expect(text).toContain("event: response.completed")
    expect(text).not.toContain("Human:")
    // Accumulated text present in the terminal event
    const lastCompleted = text.split("event: response.completed")[1] || ""
    expect(lastCompleted).toContain("Hello from Codex")
  })

  it("is advertised in the root endpoint list", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/", { headers: { accept: "application/json" } }))
    const body = await res.json() as any
    expect(body.endpoints).toContain("/v1/responses")
  })
})

describe("/v1/responses session continuity via prompt_cache_key (#655)", () => {
  beforeEach(() => {
    clearSessionCache()
    capturedOptions = []
  })

  const userItem = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Read data.txt and count the lines." }],
  }
  // A mid-loop turn: same user item plus the echoed tool call and its output.
  // The last translated message is a tool_result — exactly the shape the
  // headerless client-driven-loop guard excludes from fingerprint resume.
  const loopTurnInput = [
    userItem,
    { type: "function_call", name: "exec_command", arguments: '{"cmd":"wc -l data.txt"}', call_id: "toolu_test_1" },
    { type: "function_call_output", call_id: "toolu_test_1", output: "3 data.txt" },
  ]

  it("resumes the prior SDK session when prompt_cache_key is stable", async () => {
    const app = createTestApp()
    const key = "019f7945-b6ff-77a2-85a7-8875ef953a68"
    const r1 = await postResponses(app, { model: "claude-sonnet-5", input: [userItem], stream: false, prompt_cache_key: key })
    expect(r1.status).toBe(200)
    const r2 = await postResponses(app, { model: "claude-sonnet-5", input: loopTurnInput, stream: false, prompt_cache_key: key })
    expect(r2.status).toBe(200)
    expect(capturedOptions).toHaveLength(2)
    expect(capturedOptions[0].resume).toBeUndefined()
    expect(capturedOptions[1].resume).toBe("sdk-1")
  })

  it("does not resume across different prompt_cache_keys", async () => {
    const app = createTestApp()
    await postResponses(app, { model: "claude-sonnet-5", input: [userItem], stream: false, prompt_cache_key: "conv-a" })
    await postResponses(app, { model: "claude-sonnet-5", input: loopTurnInput, stream: false, prompt_cache_key: "conv-b" })
    expect(capturedOptions[1].resume).toBeUndefined()
  })

  it("without prompt_cache_key, tool-loop turns stay independent (pre-#655 behavior)", async () => {
    const app = createTestApp()
    await postResponses(app, { model: "claude-sonnet-5", input: [userItem], stream: false })
    await postResponses(app, { model: "claude-sonnet-5", input: loopTurnInput, stream: false })
    expect(capturedOptions[1].resume).toBeUndefined()
  })
})
