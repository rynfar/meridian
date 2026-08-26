/**
 * Stream Error Recovery Tests
 *
 * When an error occurs mid-stream (after message_start has been emitted), the
 * proxy must close the message lifecycle so clients don't crash accessing
 * usage.input_tokens on an incomplete response (#168) — AND the error must
 * reach them.
 *
 * Order changed deliberately: the error event now precedes message_stop. #168
 * put it after, which satisfied the lifecycle but hid the failure — clients stop
 * reading the body at message_stop, so the error was written into a stream
 * nobody was consuming. A failed turn then looked exactly like a successful
 * empty one, and an autonomous loop treated it as a completed turn. The
 * lifecycle guarantee is unchanged; only the frame that carries the bad news
 * moved ahead of the marker that ends the read.
 *
 * The failed turn also stops claiming stop_reason "end_turn" when it produced no
 * text: a cut-off turn is truncated, and "max_tokens" is the wire's word for
 * that.
 *
 * See: https://github.com/rynfar/meridian/issues/168
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import {
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  parseSSE,
  withMockSdkSessionId,
} from "./helpers"

let mockMessages: any[] = []
let mockErrorAfter: number | null = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    return (async function* () {
      let yielded = 0
      for (const msg of mockMessages) {
        yield withMockSdkSessionId(msg, params.options)
        yielded++
        if (mockErrorAfter !== null && yielded >= mockErrorAfter) {
          throw new Error("429 Too Many Requests - rate limit exceeded")
        }
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

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function postStream(app: any, content = "hello") {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content }],
    }),
  })
  const response = await app.fetch(req)
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

describe("Stream error recovery after message_start", () => {
  beforeEach(() => {
    mockMessages = []
    mockErrorAfter = null
    clearSessionCache()
  })

  it("closes the message lifecycle and puts the error where the client will read it", async () => {
    mockMessages = [
      messageStart("msg_1"),
      textBlockStart(0),
      textDelta(0, "Starting to respond..."),
      blockStop(0),
    ]
    // Error after all 4 events (after blockStop)
    mockErrorAfter = 4

    const app = createTestApp()
    const events = await postStream(app)

    const eventTypes = events.map((e) => e.event)

    // Should have message_start
    expect(eventTypes).toContain("message_start")

    // Should have message_delta before error (the recovery delta)
    const messageDeltaIdx = eventTypes.lastIndexOf("message_delta")
    const errorIdx = eventTypes.indexOf("error")
    expect(messageDeltaIdx).toBeGreaterThan(-1)
    expect(errorIdx).toBeGreaterThan(-1)
    expect(messageDeltaIdx).toBeLessThan(errorIdx)

    // message_stop comes AFTER the error: it is the marker at which clients
    // stop reading, so anything queued behind it is never seen.
    const messageStopIdx = eventTypes.lastIndexOf("message_stop")
    expect(messageStopIdx).toBeGreaterThan(-1)
    expect(messageStopIdx).toBeGreaterThan(errorIdx)

    // The recovery message_delta should have usage with output_tokens
    const recoveryDelta = events[messageDeltaIdx]
    expect((recoveryDelta?.data as any).usage).toBeDefined()
    expect((recoveryDelta?.data as any).usage.output_tokens).toBe(0)

    // The error should still be present
    const errorEvent = events[errorIdx]
    expect((errorEvent?.data as any).error.type).toBe("rate_limit_error")

    // #770: a turn that streamed text and THEN failed used to close with
    // "end_turn" — the wire's word for a clean finish. The client commits a
    // successful message and never retries. Partial output followed by a crash
    // is a truncation, and nothing here can know the answer was complete.
    expect((recoveryDelta?.data as any).delta.stop_reason).toBe("max_tokens")
  })

  it("should emit error immediately when message_start was NOT sent", async () => {
    // Error before any events are yielded
    mockMessages = []
    mockErrorAfter = 0

    // Need at least one message to trigger the generator
    mockMessages = [messageStart("msg_1")]
    mockErrorAfter = 0

    const app = createTestApp()

    // When error happens before message_start, it goes to the outer catch
    // which returns a JSON error response (not SSE)
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    const response = await app.fetch(req)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let result = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      result += decoder.decode(value, { stream: true })
    }
    const events = parseSSE(result)

    // Should NOT have message_delta or message_stop (no recovery needed)
    const eventTypes = events.map((e) => e.event)
    if (eventTypes.includes("error")) {
      // If we got SSE events, message_start should not be present
      // and there should be no recovery delta/stop
      const hasMessageStart = eventTypes.includes("message_start")
      if (!hasMessageStart) {
        expect(eventTypes.filter((t) => t === "message_delta").length).toBe(0)
        expect(eventTypes.filter((t) => t === "message_stop").length).toBe(0)
      }
    }
  })

  it("should error after message_start but before any content", async () => {
    mockMessages = [messageStart("msg_1")]
    // Error right after message_start
    mockErrorAfter = 1

    const app = createTestApp()
    const events = await postStream(app)

    const eventTypes = events.map((e) => e.event)

    expect(eventTypes).toContain("message_start")
    expect(eventTypes).toContain("message_delta")
    expect(eventTypes).toContain("message_stop")
    expect(eventTypes).toContain("error")

    // The lifecycle closes, but the error is reachable: delta, error, stop.
    const messageDeltaIdx = eventTypes.lastIndexOf("message_delta")
    const messageStopIdx = eventTypes.lastIndexOf("message_stop")
    const errorIdx = eventTypes.indexOf("error")
    expect(messageDeltaIdx).toBeLessThan(errorIdx)
    expect(messageStopIdx).toBeGreaterThan(errorIdx)

    // A turn that died before producing text must not claim it finished: that
    // is the shape an autonomous loop reads as a completed, empty turn.
    const delta = events[messageDeltaIdx]?.data as any
    expect(delta.delta.stop_reason).toBe("max_tokens")
  })
})
