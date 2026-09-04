/**
 * Integration tests for OpenAI-compatible endpoints.
 *
 * Tests /v1/chat/completions (streaming + non-streaming) and /v1/models
 * through the full HTTP layer with a mocked SDK.
 *
 * These tests verify:
 *   1. Correct OpenAI response shapes (no regressions in the translation)
 *   2. Proper routing to the internal /v1/messages handler
 *   3. Error handling (empty messages, upstream errors)
 *   4. Existing /v1/messages behavior is unaffected (no regressions)
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import {
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
  assistantMessage,
  parseSSE,
  toolUseBlockStart,
  inputJsonDelta,
  resolveMockSdkSessionId,
  streamEvent,
} from "./helpers"

let mockMessages: unknown[] = []
let capturedPromptMessages: unknown[] = []
let capturedOptions: Record<string, unknown> | null = null
let capturedOptionHistory: Array<Record<string, unknown>> = []

installSdkMock(() => ({
  query: ({ prompt, options }: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }) => {
    capturedOptions = options ?? null
    capturedOptionHistory.push(options ?? {})
    const sessionId = resolveMockSdkSessionId(options)
    return (async function* () {
      capturedPromptMessages = []
      if (typeof prompt === "string") {
        capturedPromptMessages.push(prompt)
      } else {
        for await (const msg of prompt) {
          capturedPromptMessages.push(msg)
        }
      }
      for (const msg of mockMessages) {
        if (typeof sessionId === "string" && msg !== null && typeof msg === "object") {
          yield { ...msg, session_id: sessionId }
        } else {
          yield msg
        }
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-openai-compat.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { REPLAY_PROVENANCE_NOTE } = await import("../proxy/query")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function postChatCompletion(
  app: ReturnType<typeof createTestApp>,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.fetch(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

// ---------------------------------------------------------------------------
// Non-streaming
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — non-streaming", () => {
  beforeEach(() => {
    mockMessages = []
    capturedPromptMessages = []
    clearSessionCache()
  })

  it("returns OpenAI completion shape for a simple message", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hello!" }])]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      stream: false,
      messages: [{ role: "user", content: "Hi" }],
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.object).toBe("chat.completion")
    expect(typeof body.id).toBe("string")
    expect((body.id as string).startsWith("chatcmpl-")).toBe(true)
    expect(body.model).toBe("claude-haiku-4-5-20251001")
    const choices = body.choices as Array<Record<string, unknown>>
    expect(choices).toBeArray()
    expect(choices[0]!.message).toEqual({ role: "assistant", content: "Hello!" })
    expect(choices[0]!.finish_reason).toBe("stop")
    const usage = body.usage as Record<string, number>
    expect(typeof usage.prompt_tokens).toBe("number")
    expect(typeof usage.completion_tokens).toBe("number")
    expect(typeof usage.total_tokens).toBe("number")
  })

  it("returns 400 for missing messages field", async () => {
    const app = createTestApp()
    const res = await postChatCompletion(app, {
      model: "claude-haiku-4-5-20251001",
      stream: false,
      // messages intentionally omitted
    })
    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(body.type).toBe("error")
  })

  it("returns 400 for empty messages array", async () => {
    const app = createTestApp()
    const res = await postChatCompletion(app, {
      model: "claude-haiku-4-5-20251001",
      stream: false,
      messages: [],
    })
    expect(res.status).toBe(400)
  })

  it("filters thinking blocks from response", async () => {
    mockMessages = [assistantMessage([
      { type: "thinking", thinking: "internal thoughts" },
      { type: "text", text: "public answer" },
    ])]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: false,
      messages: [{ role: "user", content: "think" }],
    })

    const body = await res.json() as Record<string, unknown>
    const choices = body.choices as Array<Record<string, unknown>>
    expect((choices[0]!.message as Record<string, unknown>).content).toBe("public answer")
  })

  it("handles system message correctly", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: false,
      messages: [
        { role: "system", content: "You are a pirate." },
        { role: "user", content: "Hello" },
      ],
    })

    expect(res.status).toBe(200)
  })

  it("carries reasoning_effort through translation to the SDK effort flag", async () => {
    // OpenAI SDK clients send the reasoning level as `reasoning_effort`. It must
    // survive the OpenAI->Anthropic translation and reach the SDK, not get
    // dropped at the endpoint boundary.
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const app = createTestApp()

    await postChatCompletion(app, {
      stream: false,
      reasoning_effort: "high",
      messages: [{ role: "user", content: "Hi" }],
    })

    expect(capturedOptions?.effort).toBe("high")
  })

  it("carries response_format json_schema through to the SDK outputFormat", async () => {
    // Structured output is enforced by the SDK on the internal /v1/messages
    // hop. Without this the field is dropped at the endpoint boundary and the
    // client silently gets prose back instead of schema-valid JSON.
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    }
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const app = createTestApp()

    await postChatCompletion(app, {
      stream: false,
      response_format: { type: "json_schema", json_schema: { name: "answer", schema } },
      messages: [{ role: "user", content: "Hi" }],
    })

    expect(capturedOptions?.outputFormat).toEqual({ type: "json_schema", schema })
  })

  // The test above pins what reaches the SDK, but its request actually ends in
  // a 500: the mock yields no `result` carrying structured_output, so nothing
  // downstream of the SDK boundary is exercised. These two supply that result
  // and assert the bytes the client receives — otherwise the whole point of the
  // feature (schema-valid JSON in the response) has no coverage.
  it("returns the validated JSON as the message content", async () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    }
    mockMessages = [
      assistantMessage([{ type: "text", text: "ignored prose" }]),
      { type: "result", subtype: "success", is_error: false, structured_output: { answer: "42" } },
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: false,
      response_format: { type: "json_schema", json_schema: { name: "answer", schema } },
      messages: [{ role: "user", content: "Hi" }],
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { choices: Array<{ message: { content: string } }> }
    expect(JSON.parse(body.choices[0]!.message.content)).toEqual({ answer: "42" })
  })

  it("serves a request whose response_format is an explicit null", async () => {
    // Many OpenAI-compatible clients emit `"response_format": null` for an
    // unset optional instead of omitting the key. Reading `.type` off it threw
    // out of this handler, which has no try/catch — so a plain chat request
    // that worked before structured output existed came back 500.
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: false,
      response_format: null,
      messages: [{ role: "user", content: "Hi" }],
    })

    expect(res.status).toBe(200)
    expect(capturedOptions?.outputFormat).toBeUndefined()
  })

  it("rejects response_format json_object instead of silently ignoring it", async () => {
    // Anthropic has no schema-less JSON mode, so the request cannot be honored.
    // Failing loudly beats returning prose to a client expecting JSON.
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: false,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: "Hi" }],
    })

    expect(res.status).toBe(400)
  })

  it("keeps tool calling and drops the schema when both are sent", async () => {
    // OpenAI permits tools + response_format; structured-output mode cannot
    // honour both, because it replaces the content and swallows the tool_use
    // turn. This endpoint dropped response_format entirely before structured
    // output existed, so tool calling worked and clients depend on it — a 400
    // delivers neither capability, dropping the schema delivers the larger one.
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: { schema: { type: "object", properties: {} } },
      },
      tools: [{ type: "function", function: { name: "fn", parameters: {} } }],
      messages: [{ role: "user", content: "Hi" }],
    })

    expect(res.status).toBe(200)
    // The tools still reach the SDK; only the unsatisfiable schema is dropped.
    expect(capturedOptions?.outputFormat).toBeUndefined()
  })

  // Same rule applied to json_object: on its own it is a 400, because nothing
  // can be honoured (see "rejects response_format json_object" above, and note
  // Anthropic has no schema-less JSON mode). Sent alongside tools there IS
  // something to honour, so it degrades rather than failing the whole request.
  it("keeps tool calling when json_object is sent alongside tools", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: false,
      response_format: { type: "json_object" },
      tools: [{ type: "function", function: { name: "fn", parameters: {} } }],
      messages: [{ role: "user", content: "Hi" }],
    })

    expect(res.status).toBe(200)
    expect(capturedOptions?.outputFormat).toBeUndefined()
  })

  it("keeps client instructions intact with transport provenance and no claude_code preset", async () => {
    // The OpenAI endpoint serves generic chat clients (Open WebUI, curl).
    // Their system prompt must reach the SDK as a plain string — NOT wrapped
    // under the 28KB claude_code preset, which would hijack their intent with
    // the Claude Code persona. Regression guard for the #526 investigation.
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const app = createTestApp()

    await postChatCompletion(app, {
      stream: false,
      messages: [
        { role: "system", content: "You are TestBot. Reply with exactly: ZEBRA-7" },
        { role: "user", content: "Hello" },
      ],
    })

    expect(capturedOptions?.systemPrompt).toBe("You are TestBot. Reply with exactly: ZEBRA-7" + REPLAY_PROVENANCE_NOTE)
  })

  it("response has Content-Type application/json", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: false,
      messages: [{ role: "user", content: "Hi" }],
    })

    expect(res.headers.get("content-type")).toContain("application/json")
  })

  it("preserves data-url image_url blocks for the SDK prompt", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: false,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
        ],
      }],
    })

    expect(res.status).toBe(200)
    expect(capturedPromptMessages).toEqual([{
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
        ],
      },
      parent_tool_use_id: null,
    }])
  })
})

describe("POST /v1/chat/completions — Jcode session continuity", () => {
  const firstTurn = {
    stream: false,
    messages: [
      { role: "system", content: "stable system" },
      { role: "user", content: "Turn 1" },
    ],
  }
  const secondTurn = {
    stream: false,
    messages: [
      { role: "system", content: "stable system" },
      { role: "user", content: "Turn 1" },
      { role: "assistant", content: "Answer 1" },
      { role: "user", content: "Turn 2" },
    ],
  }

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    capturedPromptMessages = []
    capturedOptions = null
    capturedOptionHistory = []
    clearSessionCache()
  })

  it("resumes the same SDK session for two turns with one verified Jcode key", async () => {
    const app = createTestApp()
    const headers = {
      "User-Agent": "jcode/0.1.0",
      "x-jcode-session": "session-a",
    }

    expect((await postChatCompletion(app, firstTurn, headers)).status).toBe(200)
    expect((await postChatCompletion(app, secondTurn, headers)).status).toBe(200)

    expect(capturedOptionHistory).toHaveLength(2)
    expect(capturedOptionHistory[0]?.resume).toBeUndefined()
    expect(capturedOptionHistory[0]?.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(capturedOptionHistory[1]?.resume).toBe(capturedOptionHistory[0]?.sessionId)
    expect(capturedOptionHistory[1]?.systemPrompt).toBe("stable system" + REPLAY_PROVENANCE_NOTE)
  })

  it("keeps distinct Jcode session keys isolated", async () => {
    const app = createTestApp()

    await postChatCompletion(app, firstTurn, {
      "User-Agent": "jcode/0.1.0",
      "x-jcode-session": "session-a",
    })
    await postChatCompletion(app, secondTurn, {
      "User-Agent": "jcode/0.1.0",
      "x-jcode-session": "session-b",
    })

    expect(capturedOptionHistory).toHaveLength(2)
    expect(capturedOptionHistory[1]?.resume).toBeUndefined()
  })

  it("falls back to generic history packing when Jcode omits its session header", async () => {
    const app = createTestApp()
    const headers = { "User-Agent": "jcode/0.1.0" }

    await postChatCompletion(app, firstTurn, headers)
    await postChatCompletion(app, secondTurn, headers)

    expect(capturedOptionHistory).toHaveLength(2)
    expect(capturedOptionHistory[1]?.resume).toBeUndefined()
    expect(capturedOptionHistory[1]?.systemPrompt).toContain("<conversation_history>")
  })

  it("ignores x-jcode-session from a non-Jcode client", async () => {
    const app = createTestApp()
    const headers = {
      "User-Agent": "curl/8.0.0",
      "x-jcode-session": "session-a",
    }

    await postChatCompletion(app, firstTurn, headers)
    await postChatCompletion(app, secondTurn, headers)

    expect(capturedOptionHistory).toHaveLength(2)
    expect(capturedOptionHistory[1]?.resume).toBeUndefined()
    expect(capturedOptionHistory[1]?.systemPrompt).toContain("<conversation_history>")
  })
})

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — streaming", () => {
  beforeEach(() => {
    mockMessages = []
    capturedPromptMessages = []
    clearSessionCache()
  })

  async function readStream(res: Response): Promise<string> {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    return text
  }

  it("returns text/event-stream content type", async () => {
    mockMessages = [
      messageStart("msg_1"), textBlockStart(0), textDelta(0, "hi"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
  })

  it("emits OpenAI SSE chunks with correct shape", async () => {
    mockMessages = [
      messageStart("msg_1"), textBlockStart(0), textDelta(0, "hello"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    })

    const text = await readStream(res)
    const dataLines = text.split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]")
    expect(dataLines.length).toBeGreaterThan(0)

    const firstChunk = JSON.parse(dataLines[0]!.slice(6)) as Record<string, unknown>
    expect(firstChunk.object).toBe("chat.completion.chunk")
    expect(typeof firstChunk.id).toBe("string")
    expect((firstChunk.id as string).startsWith("chatcmpl-")).toBe(true)

    const choices = firstChunk.choices as Array<Record<string, unknown>>
    expect(choices[0]!.delta).toHaveProperty("role", "assistant")
  })

  it("emits text content chunks", async () => {
    mockMessages = [
      messageStart("msg_1"), textBlockStart(0),
      textDelta(0, "Hello"), textDelta(0, " World"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    })

    const text = await readStream(res)
    const contentChunks = text.split("\n")
      .filter(l => l.startsWith("data: ") && l !== "data: [DONE]")
      .map(l => JSON.parse(l.slice(6)) as Record<string, unknown>)
      .filter(c => {
        const choices = c.choices as Array<Record<string, unknown>>
        const delta = choices[0]!.delta as Record<string, unknown>
        return typeof delta.content === "string" && delta.content.length > 0
      })
      .map(c => {
        const choices = c.choices as Array<Record<string, unknown>>
        return (choices[0]!.delta as Record<string, unknown>).content as string
      })

    expect(contentChunks.join("")).toBe("Hello World")
  })

  it("emits finish_reason stop in final chunk", async () => {
    mockMessages = [
      messageStart("msg_1"), textBlockStart(0), textDelta(0, "done"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    })

    const text = await readStream(res)
    const chunks = text.split("\n")
      .filter(l => l.startsWith("data: ") && l !== "data: [DONE]")
      .map(l => JSON.parse(l.slice(6)) as Record<string, unknown>)

    const finishChunk = chunks.find(c => {
      const choices = c.choices as Array<Record<string, unknown>>
      return choices[0]!.finish_reason !== null
    })
    expect(finishChunk).toBeDefined()
    const choices = finishChunk!.choices as Array<Record<string, unknown>>
    expect(choices[0]!.finish_reason).toBe("stop")
  })

  it("ends stream with data: [DONE]", async () => {
    mockMessages = [
      messageStart("msg_1"), textBlockStart(0), textDelta(0, "ok"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    })

    const text = await readStream(res)
    expect(text).toContain("data: [DONE]")
  })

  it("emits complete cached usage immediately before [DONE] when requested", async () => {
    mockMessages = [
      streamEvent({
        type: "message_start",
        message: {
          id: "msg_usage",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-5-20250929",
          stop_reason: null,
          usage: {
            input_tokens: 23,
            output_tokens: 0,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 77,
          },
        },
      }),
      textBlockStart(0),
      textDelta(0, "cached"),
      blockStop(0),
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 41 },
      }),
      messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Use the cached prompt" }],
    })

    const frames = (await readStream(res)).split("\n").filter(line => line.startsWith("data: "))
    expect(frames.at(-1)).toBe("data: [DONE]")
    const usageChunk = JSON.parse(frames.at(-2)!.slice(6)) as Record<string, unknown>
    expect(usageChunk.choices).toEqual([])
    expect(usageChunk.usage).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 41,
      total_tokens: 1041,
      prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 77 },
    })
  })

  it("all chunks share the same completion id", async () => {
    mockMessages = [
      messageStart("msg_1"), textBlockStart(0),
      textDelta(0, "a"), textDelta(0, "b"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    })

    const text = await readStream(res)
    const ids = text.split("\n")
      .filter(l => l.startsWith("data: ") && l !== "data: [DONE]")
      .map(l => (JSON.parse(l.slice(6)) as Record<string, unknown>).id as string)

    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(1)
    expect([...uniqueIds][0]).toMatch(/^chatcmpl-/)
  })

  it("forwards internal SSE keepalive comments to the client", async () => {
    const app = createTestApp()
    const originalFetch = app.fetch.bind(app)
    const internalFrames = [
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "claude-sonnet-5", stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}`,
      ": ping",
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}`,
      ": ping",
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
    ]
    app.fetch = (req, env, executionCtx) => {
      if (req.url === "http://internal/v1/messages") {
        return Promise.resolve(new Response(`${internalFrames.join("\n\n")}\n\n`, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }))
      }
      return originalFetch(req, env, executionCtx)
    }

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    })

    const text = await readStream(res)
    const pingLines = text.split("\n").filter(l => l === ": ping")
    expect(pingLines).toHaveLength(2)

    const contentChunks = text.split("\n")
      .filter(l => l.startsWith("data: ") && l !== "data: [DONE]")
      .map(l => JSON.parse(l.slice(6)) as Record<string, unknown>)
      .map(c => {
        const choices = c.choices as Array<Record<string, unknown>>
        return (choices[0]!.delta as Record<string, unknown>).content
      })
      .filter((content): content is string => typeof content === "string" && content.length > 0)
    expect(contentChunks.join("")).toBe("Hello")
    expect(text).toContain("data: [DONE]")
  })

  // --- tool_call_counter increment behavior ---

  type DeltaToolCall = {
    type?: string
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }
  type StreamChunk = {
    choices: Array<{
      delta: { tool_calls?: DeltaToolCall[]; content?: string; reasoning_content?: string }
      finish_reason: string | null
    }>
  }

  function streamChunks(text: string): StreamChunk[] {
    return text.split("\n")
      .filter(l => l.startsWith("data: ") && l !== "data: [DONE]")
      .map(l => JSON.parse(l.slice(6)) as StreamChunk)
  }

  it("single tool_use stream emits tool_call with index 0", async () => {
    mockMessages = [
      messageStart("msg_1"),
      toolUseBlockStart(0, "get_weather", "tu_1"),
      inputJsonDelta(0, '{"city":'),
      inputJsonDelta(0, '"NYC"}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    })

    const chunks = streamChunks(await readStream(res))
    const toolCallChunks = chunks
      .map(c => c.choices[0]!.delta.tool_calls)
      .filter((tc): tc is DeltaToolCall[] => Array.isArray(tc) && tc.length > 0)

    expect(toolCallChunks.length).toBeGreaterThan(0)
    // Every emitted tool_call delta for a single tool must use index 0
    for (const tc of toolCallChunks) {
      expect(tc[0]!.index).toBe(0)
    }

    // Final chunk has tool_calls finish_reason
    const finishChunk = chunks.find(c => c.choices[0]!.finish_reason !== null)
    expect(finishChunk?.choices[0]!.finish_reason).toBe("tool_calls")
  })

  it("multiple sequential tool_use blocks emit ascending indexes 0, 1, 2", async () => {
    mockMessages = [
      messageStart("msg_1"),
      toolUseBlockStart(0, "fn_a", "tu_a"),
      inputJsonDelta(0, '{"x":1}'),
      blockStop(0),
      toolUseBlockStart(1, "fn_b", "tu_b"),
      inputJsonDelta(1, '{"y":2}'),
      blockStop(1),
      toolUseBlockStart(2, "fn_c", "tu_c"),
      inputJsonDelta(2, '{"z":3}'),
      blockStop(2),
      messageDelta("tool_use"),
      messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "do all three" }],
    })

    const chunks = streamChunks(await readStream(res))

    // Tool starts are the chunks that carry id + name; collect their indexes in order
    const startIndexes = chunks
      .map(c => c.choices[0]!.delta.tool_calls?.[0])
      .filter((tc): tc is DeltaToolCall => !!tc && tc.type === "function" && typeof tc.id === "string")
      .map(tc => tc.index)
    expect(startIndexes).toEqual([0, 1, 2])

    // Argument-delta chunks for each tool should carry the matching index
    const argChunks = chunks
      .map(c => c.choices[0]!.delta.tool_calls?.[0])
      .filter((tc): tc is DeltaToolCall =>
        !!tc && !tc.id && typeof tc.function?.arguments === "string"
      )
    expect(argChunks.map(a => a.index)).toEqual([0, 1, 2])
    expect(argChunks.map(a => a.function!.arguments)).toEqual(['{"x":1}', '{"y":2}', '{"z":3}'])
  })

  it("text-then-tool stream: tool indexes start at 0 (not affected by preceding text block)", async () => {
    // tool_call_counter only increments on tool_use blocks, so a text block
    // before a tool_use should still result in index 0 for the first tool.
    mockMessages = [
      messageStart("msg_1"),
      textBlockStart(0), textDelta(0, "let me check"),
      blockStop(0),
      toolUseBlockStart(1, "search", "tu_1"),
      inputJsonDelta(1, '{"q":"x"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "go" }],
    })

    const chunks = streamChunks(await readStream(res))
    const startIndex = chunks
      .map(c => c.choices[0]!.delta.tool_calls?.[0])
      .find((tc): tc is DeltaToolCall => !!tc && tc.type === "function" && typeof tc.id === "string")
      ?.index
    expect(startIndex).toBe(0)
  })

  it("streams the validated JSON as a single content delta", async () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    }
    mockMessages = [
      messageStart("msg_1"), textBlockStart(0), textDelta(0, "ignored prose"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
      { type: "result", subtype: "success", is_error: false, structured_output: { answer: "42" } },
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      response_format: { type: "json_schema", json_schema: { name: "answer", schema } },
      messages: [{ role: "user", content: "Hi" }],
    })

    expect(res.status).toBe(200)
    const text = await readStream(res)
    const content = text.split("\n")
      .filter(l => l.startsWith("data: ") && l !== "data: [DONE]")
      .map(l => JSON.parse(l.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> })
      .map(c => c.choices?.[0]?.delta?.content ?? "")
      .join("")
    expect(JSON.parse(content)).toEqual({ answer: "42" })
  })
})

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

describe("GET /v1/models", () => {
  it("returns model list in OpenAI format", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/models"))

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.object).toBe("list")
    const data = body.data as Array<Record<string, unknown>>
    expect(data).toBeArray()
    expect(data.length).toBeGreaterThan(0)
  })

  it("includes claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/models"))
    const body = await res.json() as Record<string, unknown>
    const ids = (body.data as Array<Record<string, unknown>>).map(m => m.id)
    expect(ids).toContain("claude-sonnet-4-6")
    expect(ids).toContain("claude-opus-4-6")
    expect(ids).toContain("claude-haiku-4-5")
  })

  it("each model has required fields", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/models"))
    const body = await res.json() as Record<string, unknown>
    for (const model of body.data as Array<Record<string, unknown>>) {
      expect(model.object).toBe("model")
      expect(typeof model.id).toBe("string")
      expect(typeof model.context_window).toBe("number")
      expect(typeof model.created).toBe("number")
    }
  })

  it("context_window is a positive number for all models", async () => {
    // Subscription-dependent value tested in openai.test.ts unit tests
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/models"))
    const body = await res.json() as Record<string, unknown>
    for (const model of body.data as Array<Record<string, unknown>>) {
      expect(model.context_window as number).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Regression: existing /v1/messages still works
// ---------------------------------------------------------------------------

describe("Regression: /v1/messages unaffected", () => {
  beforeEach(() => {
    mockMessages = []
    clearSessionCache()
  })

  it("still returns Anthropic format from /v1/messages", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "Anthropic response" }])]
    const app = createTestApp()

    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 50,
        stream: false,
        messages: [{ role: "user", content: "Hi" }],
      }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    // Anthropic format has "type": "message", not "object": "chat.completion"
    expect(body.type).toBe("message")
    expect(body.role).toBe("assistant")
    expect(body.object).toBeUndefined()
  })

  it("/v1/messages 400 for missing messages still works", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", stream: false }),
    }))
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Auth (issue #415): forward caller's auth headers on the internal hop
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — MERIDIAN_API_KEY auth forwarding (#415)", () => {
  const TEST_KEY = "test-key-415"
  let savedKey: string | undefined

  beforeEach(() => {
    savedKey = process.env.MERIDIAN_API_KEY
    process.env.MERIDIAN_API_KEY = TEST_KEY
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    capturedPromptMessages = []
    clearSessionCache()
  })

  // Manual restore — bun:test's afterEach isn't imported in this file's other suites,
  // and we don't want to leak the env var into unrelated tests.
  function restoreKey() {
    if (savedKey === undefined) delete process.env.MERIDIAN_API_KEY
    else process.env.MERIDIAN_API_KEY = savedKey
  }

  it("accepts a valid Authorization: Bearer header and reaches the SDK", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TEST_KEY}` },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "hi" }],
      }),
    }))
    restoreKey()
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.object).toBe("chat.completion")
  })

  it("accepts a valid x-api-key header and reaches the SDK", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": TEST_KEY },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "hi" }],
      }),
    }))
    restoreKey()
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.object).toBe("chat.completion")
  })

  it("rejects requests with no auth header (regression guard against accidental bypass)", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "hi" }],
      }),
    }))
    restoreKey()
    expect(res.status).toBe(401)
  })

  it("rejects requests with a wrong Bearer token", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer wrong-key" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "hi" }],
      }),
    }))
    restoreKey()
    expect(res.status).toBe(401)
  })
})
