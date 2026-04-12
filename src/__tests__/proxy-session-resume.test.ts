/**
 * Session Resume Tests
 *
 * The proxy should track Claude SDK session IDs and resume conversations
 * instead of starting fresh every time. This avoids re-processing the
 * entire conversation history and gives Claude better context.
 *
 * Session tracking uses:
 * 1. x-opencode-session header (primary — reliable, from OpenCode plugin)
 * 2. Conversation fingerprint (fallback — hash of first user message)
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import {
  assistantMessage,
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
} from "./helpers"

// --- Capture SDK calls ---
let mockMessages: any[] = []
let capturedQueryParams: any = null
let queryCallCount = 0

// Simulate SDK returning a session_id in messages
const MOCK_SDK_SESSION = "sdk-session-abc123"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    queryCallCount++
    return (async function* () {
      for (const msg of mockMessages) {
        // Inject session_id into messages (like the real SDK does)
        yield { ...msg, session_id: MOCK_SDK_SESSION }
      }
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: {},
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

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
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

// ============================================================
// SESSION TRACKING
// ============================================================

describe("Session resume: session ID tracking", () => {
  beforeEach(() => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Hello" }]),
    ]
    clearSessionCache()
    capturedQueryParams = null
    queryCallCount = 0
  })

  it("should return X-Claude-Session-ID header in response", async () => {
    const app = createTestApp()
    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    })

    const sessionHeader = response.headers.get("x-claude-session-id")
    expect(sessionHeader).toBeTruthy()
  })

  it("should return X-Claude-Session-ID in streaming response", async () => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Hi"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const app = createTestApp()
    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    })

    const sessionHeader = response.headers.get("x-claude-session-id")
    expect(sessionHeader).toBeTruthy()
    await readStreamFull(response) // consume
  })

  it("should use resume option on follow-up requests with same session", async () => {
    const app = createTestApp()

    // First request — establishes session
    const r1 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    }, { "x-opencode-session": "oc-session-1" })
    await r1.json()

    const firstCallParams = { ...capturedQueryParams }

    // Second request — same session, should resume
    mockMessages = [
      assistantMessage([{ type: "text", text: "I remember!" }]),
    ]

    const r2 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        { role: "user", content: "Do you remember me?" },
      ],
    }, { "x-opencode-session": "oc-session-1" })
    await r2.json()

    // Second call should have resume option set
    expect(capturedQueryParams.options.resume).toBe(MOCK_SDK_SESSION)
  })

  it("should NOT resume for a different session ID", async () => {
    const app = createTestApp()

    // First request — session A
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    }, { "x-opencode-session": "oc-session-A" })).json()

    // Second request — session B (different)
    mockMessages = [
      assistantMessage([{ type: "text", text: "New conversation" }]),
    ]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    }, { "x-opencode-session": "oc-session-B" })).json()

    // Should NOT have resume set (different session)
    expect(capturedQueryParams.options.resume).toBeUndefined()
  })
})

// ============================================================
// FINGERPRINT FALLBACK
// ============================================================

describe("Session resume: fingerprint fallback", () => {
  beforeEach(() => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Hello" }]),
    ]
    clearSessionCache()
    capturedQueryParams = null
    queryCallCount = 0
  })

  it("should resume via fingerprint when no session header is present", async () => {
    const app = createTestApp()

    // First request — no header, fingerprint tracked
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "What is the meaning of life?" }],
    })).json()

    // Second request — same first message, should resume
    mockMessages = [
      assistantMessage([{ type: "text", text: "42" }]),
    ]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "What is the meaning of life?" },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        { role: "user", content: "Tell me more" },
      ],
    })).json()

    expect(capturedQueryParams.options.resume).toBe(MOCK_SDK_SESSION)
  })

  it("should NOT resume when first user message is different", async () => {
    const app = createTestApp()

    // First request
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello world" }],
    })).json()

    // Second request — different first message
    mockMessages = [
      assistantMessage([{ type: "text", text: "Different" }]),
    ]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Goodbye world" }],
    })).json()

    expect(capturedQueryParams.options.resume).toBeUndefined()
  })
})

// ============================================================
// LAST USER MESSAGE EXTRACTION
// ============================================================

describe("Session resume: only send last user message on resume", () => {
  beforeEach(() => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Hello" }]),
    ]
    clearSessionCache()
    capturedQueryParams = null
    queryCallCount = 0
  })

  it("should send only the last user message when resuming", async () => {
    const app = createTestApp()

    // First request — establish session
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "First message" }],
    }, { "x-opencode-session": "oc-resume-test" })).json()

    // Second request — resuming, has full history
    mockMessages = [
      assistantMessage([{ type: "text", text: "Continued" }]),
    ]

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        { role: "user", content: "Second message - this is the new one" },
      ],
    }, { "x-opencode-session": "oc-resume-test" })).json()

    // The prompt should only contain the last user message, not the full history
    expect(capturedQueryParams.prompt).toContain("Second message - this is the new one")
    expect(capturedQueryParams.prompt).not.toContain("First message")
  })

  it("should resume in streaming mode too", async () => {
    const app = createTestApp()

    // First request — establish session (non-streaming)
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Start conversation" }],
    }, { "x-opencode-session": "oc-stream-resume" })).json()

    // Second request — streaming, should resume
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Resumed!"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const r2 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [
        { role: "user", content: "Start conversation" },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        { role: "user", content: "Continue please" },
      ],
    }, { "x-opencode-session": "oc-stream-resume" })

    await readStreamFull(r2)
    expect(capturedQueryParams.options.resume).toBe(MOCK_SDK_SESSION)
    expect(capturedQueryParams.prompt).toContain("Continue please")
    expect(capturedQueryParams.prompt).not.toContain("Start conversation")
  })

  it("should send full history on first request (no resume)", async () => {
    const app = createTestApp()

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: [{ type: "text", text: "Response" }] },
        { role: "user", content: "Second message" },
      ],
    }, { "x-opencode-session": "oc-new-session" })).json()

    // No resume — should include full history
    expect(capturedQueryParams.prompt).toContain("First message")
    expect(capturedQueryParams.prompt).toContain("Second message")
    expect(capturedQueryParams.options.resume).toBeUndefined()
  })
})
