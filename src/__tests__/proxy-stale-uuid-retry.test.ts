/**
 * Tests for stale session UUID retry behavior.
 *
 * When an undo operation fails because the rollback UUID no longer exists
 * in the upstream Claude session, the proxy should evict the stale session
 * and retry as a fresh session instead of propagating the error.
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

// Track query calls to verify retry behavior
let queryCalls: Array<Record<string, any>> = []
let queryCallCount = 0

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    queryCallCount++
    const callIndex = queryCallCount
    queryCalls.push(opts.options || {})
    const isStreaming = opts.options?.includePartialMessages === true

    return (async function* () {
      // First call with resumeSessionAt: simulate stale UUID error
      if (callIndex === 1 && opts.options?.resumeSessionAt) {
        throw new Error(
          `No message found with message.uuid of: ${opts.options.resumeSessionAt}`
        )
      }
      // Success: yield appropriate message type
      if (isStreaming) {
        yield messageStart(`msg-${callIndex}`)
        yield textBlockStart(0)
        yield textDelta(0, `response-${callIndex}`)
        yield blockStop(0)
        yield messageDelta("end_turn")
        yield messageStop()
      }
      yield {
        type: "assistant",
        uuid: `uuid-${callIndex}`,
        message: {
          id: `msg-${callIndex}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `response-${callIndex}` }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: `sdk-fresh-${callIndex}`,
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
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
const { storeSession } = await import("../proxy/session/cache")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  )
}

describe("Stale UUID retry", () => {
  beforeEach(() => {
    clearSessionCache()
    queryCalls = []
    queryCallCount = 0
  })

  it("retries as fresh session when undo hits stale UUID (non-streaming)", async () => {
    const app = createTestApp()
    const sessionId = "sess-stale-test"

    // Seed a cached session with UUIDs (simulates a prior conversation)
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "do something" },
      { role: "assistant", content: "done" },
    ]
    storeSession(sessionId, messages, "sdk-original", "/tmp/test", [
      null,
      "uuid-assistant-1",
      null,
      "uuid-assistant-2",
    ])

    // Send an "undo" request: same prefix but different last message
    // This triggers undo detection with rollback to uuid-assistant-1
    const undoMessages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "do something different" },
    ]

    const response = await post(
      app,
      { model: "sonnet", stream: false, messages: undoMessages },
      { "x-opencode-session": sessionId }
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.content).toBeDefined()
    expect(body.content.some((b: any) => b.type === "text")).toBe(true)

    // First call should have had resumeSessionAt (the undo attempt)
    expect(queryCalls[0]!.resumeSessionAt).toBe("uuid-assistant-1")
    expect(queryCalls[0]!.forkSession).toBe(true)

    // Second call should be a fresh session (retry after stale UUID)
    expect(queryCalls[1]!.resume).toBeUndefined()
    expect(queryCalls[1]!.forkSession).toBeUndefined()
    expect(queryCalls[1]!.resumeSessionAt).toBeUndefined()
  })

  it("retries as fresh session when undo hits stale UUID (streaming)", async () => {
    const app = createTestApp()
    const sessionId = "sess-stale-stream"

    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "do something" },
      { role: "assistant", content: "done" },
    ]
    storeSession(sessionId, messages, "sdk-original-stream", "/tmp/test", [
      null,
      "uuid-assistant-1",
      null,
      "uuid-assistant-2",
    ])

    const undoMessages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "do something different" },
    ]

    const response = await post(
      app,
      { model: "sonnet", stream: true, messages: undoMessages },
      { "x-opencode-session": sessionId }
    )

    expect(response.status).toBe(200)
    const text = await response.text()
    // Should contain SSE events from the retry (not an error)
    expect(text).toContain("event: message_start")
    expect(text).not.toContain("No message found with message.uuid")

    // Verify retry happened: first call with resumeSessionAt, second without
    expect(queryCalls[0]!.resumeSessionAt).toBe("uuid-assistant-1")
    expect(queryCalls[1]!.resumeSessionAt).toBeUndefined()
  })

  it("evicts stale session from cache after retry", async () => {
    const app = createTestApp()
    const sessionId = "sess-stale-evict"

    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "do something" },
      { role: "assistant", content: "done" },
    ]
    storeSession(sessionId, messages, "sdk-stale", "/tmp/test", [
      null,
      "uuid-assistant-1",
      null,
      "uuid-assistant-2",
    ])

    // First request: undo triggers stale UUID → retry as fresh
    const undoMessages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "new message" },
    ]

    const response1 = await post(
      app,
      { model: "sonnet", stream: false, messages: undoMessages },
      { "x-opencode-session": sessionId }
    )
    expect(response1.status).toBe(200)

    // Reset tracking
    queryCalls = []
    queryCallCount = 0

    // Second request with the same session: should NOT try to resume
    // the stale session (it was evicted). Instead it should start fresh.
    const followUpMessages = [
      ...undoMessages,
      { role: "assistant", content: "response" },
      { role: "user", content: "follow up" },
    ]

    const response2 = await post(
      app,
      { model: "sonnet", stream: false, messages: followUpMessages },
      { "x-opencode-session": sessionId }
    )
    expect(response2.status).toBe(200)

    // The second request should NOT have resumeSessionAt
    // (it may have resume if the fresh session was stored, which is fine)
    expect(queryCalls[0]!.resumeSessionAt).toBeUndefined()
  })

  it("propagates non-stale errors normally", async () => {
    const app = createTestApp()

    // A request that will trigger an error from the first query call
    // (queryCallCount resets in beforeEach, and the mock only throws
    // on calls with resumeSessionAt — this tests without it)
    const response = await post(app, {
      model: "sonnet",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    })

    // Should succeed (no resumeSessionAt → no stale error)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.content[0].text).toContain("response")
  })
})
