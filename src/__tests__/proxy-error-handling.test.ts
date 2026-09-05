/**
 * Error Handling Tests
 *
 * Verifies the proxy returns clear, actionable error messages
 * instead of cryptic SDK crashes.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"

import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
// Make the SDK throw specific errors
let mockError: Error | null = null

import { resolveMockSdkSessionId } from "./helpers"

installSdkMock(() => ({
  query: (params: any) => {
    if (mockError) {
      return (async function* () {
        throw mockError
      })()
    }
    return (async function* () {
      yield {
        type: "assistant",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: resolveMockSdkSessionId(params.options, "sess-1"),
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-error-handling.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))
}

const BASIC_REQUEST = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: false,
  messages: [{ role: "user", content: "hello" }],
}

describe("Error classification", () => {
  beforeEach(() => {
    mockError = null
    clearSessionCache()
  })

  for (const stream of [false, true]) {
    for (const quoted of [false, true]) {
      it(`keeps model rejection distinct from quoted overload text (stream=${stream}, quoted=${quoted})`, async () => {
        const rejection = "Claude Code 2.1.177 does not support this model; version 2.1.251 or newer is required."
        mockError = new Error(quoted
          ? `API Error: 503 Upstream overloaded; documentation mentions ${rejection}`
          : `Claude Code returned an error result: API Error: 400 ${rejection}`)
        const response: Response = await post(createTestApp(), { ...BASIC_REQUEST, stream })
        const raw = await response.text()
        const expectedType = quoted ? "overloaded_error" : "invalid_request_error"
        if (stream) {
          expect(response.status).toBe(200)
          const events = raw.split("\n").filter(line => line.startsWith("data:"))
            .map(line => JSON.parse(line.slice(5)))
          expect(events.find(event => event.type === "error")?.error.type).toBe(expectedType)
          expect(events.some(event => event.type === "message_stop")).toBe(false)
        } else {
          expect(response.status).toBe(quoted ? 503 : 400)
          expect(JSON.parse(raw).error.type).toBe(expectedType)
          expect(response.headers.get("Retry-After")).toBe(quoted ? "5" : null)
        }
        if (!quoted) {
          expect(raw).toContain("2.1.177")
          expect(raw).toContain("2.1.251")
          expect(raw).toContain("MERIDIAN_CLAUDE_PATH")
        }
      }, 15000)
    }
  }

  it("should return 401 for authentication errors", async () => {
    mockError = new Error("API Error: 401 authentication_error - Invalid authentication credentials")
    const app = createTestApp()
    const res = await post(app, BASIC_REQUEST)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.type).toBe("authentication_error")
    expect(body.error.message).toContain("claude login")
  })

  it("should return 401 for process exit code 1", async () => {
    mockError = new Error("Claude Code process exited with code 1")
    const app = createTestApp()
    const res = await post(app, BASIC_REQUEST)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.type).toBe("authentication_error")
    expect(body.error.message).toContain("claude login")
  })

  it("should return 429 for rate limit errors", async () => {
    mockError = new Error("429 Too Many Requests - rate limit exceeded")
    const app = createTestApp()
    const res = await post(app, BASIC_REQUEST)
    const body = await res.json()

    expect(res.status).toBe(429)
    expect(body.error.type).toBe("rate_limit_error")
    expect(body.error.message).toContain("rate limit")
  })

  it("should return 402 for billing errors", async () => {
    mockError = new Error("402 billing_error - subscription expired")
    const app = createTestApp()
    const res = await post(app, BASIC_REQUEST)
    const body = await res.json()

    expect(res.status).toBe(402)
    expect(body.error.type).toBe("billing_error")
    expect(body.error.message).toContain("subscription")
  })

  it("should return 503 for overloaded errors", async () => {
    mockError = new Error("503 overloaded")
    const app = createTestApp()
    const res = await post(app, BASIC_REQUEST)
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.error.type).toBe("overloaded_error")
  })

  it("should return 504 for timeout errors", async () => {
    mockError = new Error("Request timed out after 120s")
    const app = createTestApp()
    const res = await post(app, BASIC_REQUEST)
    const body = await res.json()

    expect(res.status).toBe(504)
    expect(body.error.type).toBe("timeout_error")
  })

  it("should return 500 for unknown errors", async () => {
    mockError = new Error("Something weird happened")
    const app = createTestApp()
    const res = await post(app, BASIC_REQUEST)
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error.type).toBe("api_error")
    expect(body.error.message).toContain("Something weird happened")
  })

  it("should return 200 when no error", async () => {
    const app = createTestApp()
    const res = await post(app, BASIC_REQUEST)
    expect(res.status).toBe(200)
  })

  describe("Retry-After (#901)", () => {
    it("puts a conservative hint on a 429 with no known reset", async () => {
      // A bare 429 gives a concurrent harness nothing to coordinate against:
      // every child backs off on its own schedule and they all wake together.
      mockError = new Error("429 Too Many Requests - rate limit exceeded")
      const app = createTestApp()
      const res = await post(app, BASIC_REQUEST)

      expect(res.status).toBe(429)
      expect(res.headers.get("Retry-After")).toBe("60")
      const body = await res.json()
      expect(body.error.retry_after).toBe(60)
    })

    it("propagates the wait upstream named instead of guessing", async () => {
      mockError = new Error('API Error: 429 {"type":"rate_limit_error","retry-after":17}')
      const app = createTestApp()
      const res = await post(app, BASIC_REQUEST)

      expect(res.status).toBe(429)
      expect(res.headers.get("Retry-After")).toBe("17")
    })

    it("puts a short hint on a 503 — overload is transient, not a spent window", async () => {
      mockError = new Error("503 overloaded")
      const app = createTestApp()
      const res = await post(app, BASIC_REQUEST)

      expect(res.status).toBe(503)
      expect(res.headers.get("Retry-After")).toBe("5")
    })

    it("stays silent on failures that waiting cannot fix", async () => {
      for (const [message, status] of [
        ["402 billing_error - subscription expired", 402],
        ["Request timed out after 120s", 504],
        ["Something weird happened", 500],
      ] as const) {
        mockError = new Error(message)
        const app = createTestApp()
        const res = await post(app, BASIC_REQUEST)
        expect(res.status).toBe(status)
        expect(res.headers.get("Retry-After")).toBeNull()
        const body = await res.json()
        expect(body.error.retry_after).toBeUndefined()
      }
    })

    it("carries the hint in the SSE error frame, where headers cannot reach", async () => {
      // A streaming turn's response headers went out with message_start, long
      // before the rate limit that killed it existed.
      mockError = new Error("429 Too Many Requests - rate limit exceeded")
      const app = createTestApp()
      const res = await post(app, { ...BASIC_REQUEST, stream: true })

      expect(res.status).toBe(200)
      const text: string = await res.text()
      const frame = text
        .split("\n")
        .find((line) => line.startsWith("data:") && line.includes("rate_limit_error"))
      expect(frame).toBeDefined()
      const payload = JSON.parse(frame!.slice("data:".length))
      expect(payload.error.type).toBe("rate_limit_error")
      expect(payload.error.retry_after).toBe(60)
    })
  })

  it("should return 400 for missing messages field", async () => {
    const app = createTestApp()
    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      // Intentionally omit 'messages' field
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("messages")
  })
})

describe("Empty messages array (regression #450)", () => {
  beforeEach(() => {
    mockError = null
    clearSessionCache()
  })

  it("rejects empty messages array with 400 — cold-start safety, no RangeError crash", async () => {
    // Before this guard, an empty messages array crashed the streaming
    // controller with `RangeError: Invalid array length` because
    // `new Array(allMessages.length - 1)` evaluated to `new Array(-1)`.
    const app = createTestApp()
    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [], // explicitly empty
    })
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("messages")
    expect(body.error.message.toLowerCase()).toContain("empty")
  })

  it("rejects empty messages on non-streaming path too", async () => {
    const app = createTestApp()
    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [],
    })
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error.type).toBe("invalid_request_error")
  })

  it("does not return 500 for cold-start empty-messages requests (was the bug)", async () => {
    const app = createTestApp()
    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [],
    })
    // The exact behavior we want: clean 400, never the 500 cascade from
    // RangeError: Invalid array length.
    expect(res.status).not.toBe(500)
  })

  it("still accepts a single-message request (regression-adjacent)", async () => {
    // Defensive: make sure the new guard doesn't reject the minimal valid
    // case (one message). This is the smallest non-empty array and the most
    // common cold-start shape after this fix.
    const app = createTestApp()
    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
  })
})
