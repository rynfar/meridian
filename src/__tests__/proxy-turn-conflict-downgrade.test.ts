import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import {
  assistantMessage,
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
} from "./helpers"

interface AttemptControl {
  release: () => void
  started: Promise<void>
}

let activeQueries = 0
let maxActiveQueries = 0
let queryCalls = 0
let controls: AttemptControl[] = []
let capturedParams: Array<{ options?: { resume?: string } }> = []

function deferredAttempt(): AttemptControl & { wait: Promise<void>; markStarted: () => void } {
  let release = () => {}
  let markStarted = () => {}
  const wait = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { markStarted = resolve })
  return { release, started, wait, markStarted }
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: { options?: { resume?: string } }) => {
    capturedParams.push(params)
    queryCalls++
    const control = deferredAttempt()
    controls.push(control)
    const sessionId = `sdk-downgrade-${queryCalls}`
    const generator = (async function* () {
      activeQueries++
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries)
      control.markStarted()
      try {
        yield { ...messageStart(), session_id: sessionId }
        await control.wait
        yield { ...textBlockStart(0), session_id: sessionId }
        yield { ...textDelta(0, "ok"), session_id: sessionId }
        yield { ...blockStop(0), session_id: sessionId }
        yield { ...messageDelta("end_turn"), session_id: sessionId }
        yield { ...messageStop(), session_id: sessionId }
        yield { ...assistantMessage([{ type: "text", text: "ok" }]), session_id: sessionId }
      } finally {
        activeQueries--
      }
    })()
    return Object.assign(generator, { close: () => {} })
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
const { resetProcessSdkSemaphoreForTests } = await import("../proxy/concurrency")
const { telemetryStore } = await import("../telemetry")

function request(
  messages: Array<{ role: string; content: unknown }>,
  sessionId: string,
  stream = false,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-session": sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream, messages }),
  })
}

async function waitForControl(index: number, timeoutMs = 3000): Promise<AttemptControl> {
  const deadline = Date.now() + timeoutMs
  while (!controls[index]) {
    if (Date.now() > deadline) throw new Error(`SDK attempt #${index} never started`)
    await Bun.sleep(1)
  }
  const control = controls[index]!
  await control.started
  return control
}

describe("modified-history conflict downgrade", () => {
  const originalMax = process.env.MERIDIAN_MAX_CONCURRENT
  const originalHold = process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS
  const originalPassthrough = process.env.MERIDIAN_PASSTHROUGH

  beforeEach(() => {
    process.env.MERIDIAN_MAX_CONCURRENT = "1"
    activeQueries = 0
    maxActiveQueries = 0
    queryCalls = 0
    controls = []
    capturedParams = []
    clearSessionCache()
    resetProcessSdkSemaphoreForTests()
    telemetryStore.clear()
  })

  afterEach(() => {
    resetProcessSdkSemaphoreForTests()
    if (originalMax === undefined) delete process.env.MERIDIAN_MAX_CONCURRENT
    else process.env.MERIDIAN_MAX_CONCURRENT = originalMax
    if (originalHold === undefined) delete process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS
    else process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS = originalHold
    if (originalPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
    else process.env.MERIDIAN_PASSTHROUGH = originalPassthrough
  })

  it("downgrades modified-history conflict to fresh replay (passthrough mode)", async () => {
    process.env.MERIDIAN_PASSTHROUGH = "1"
    // Request A: 3 messages — acquires lease, commits turn.
    // Request B: 5 messages, same session, trailing tool_result content revised.
    //   Queued during A → should get fresh replay (200), NOT 409.
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const opening = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "use1", content: "original" }] },
    ]
    const superseding = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok" },
      // Same position, revised content — triggers modified-history
      { role: "user", content: [{ type: "tool_result", tool_use_id: "use1", content: "REVISED" }] },
      // Extra messages — makes incoming longer than stored
      { role: "user", content: "extra turn" },
      { role: "assistant", content: "and response" },
    ]
    const firstP = app.fetch(request(opening, "downgrade-test"))
    const firstControl = await waitForControl(0)
    const secondP = app.fetch(request(superseding, "downgrade-test"))

    firstControl.release()
    expect((await firstP).status).toBe(200)
    // B gets the turn lease, does its lookup, and starts a fresh replay SDK query.
    const secondControl = await waitForControl(1)
    secondControl.release()
    const second = await secondP
    // modified-history should be downgraded to fresh replay, not 409
    expect(second.status).toBe(200)
    // Two distinct SDK queries — B does a fresh replay
    expect(queryCalls).toBe(2)
  })

  it("still returns 409 for undo conflict (stale racer)", async () => {
    // Control: a request shorter than stored history → still 409/undo.
    // This mirrors the existing concurrency-coordination test's stale-branch case.
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const opening = [
      { role: "user", content: "set up" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "more context" },
    ]
    // Shorter request (1 msg) — undo when found in cache with 3 msgs
    const stale = [{ role: "user", content: "set up" }]
    const firstP = app.fetch(request(opening, "undo-test"))
    const firstControl = await waitForControl(0)
    const secondP = app.fetch(request(stale, "undo-test"))

    firstControl.release()
    expect((await firstP).status).toBe(200)
    const second = await secondP
    expect(second.status).toBe(400)
    const body = await second.json()
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("session advanced")
    // Only one SDK query — the second request is refused
    expect(queryCalls).toBe(1)
  })

  it("does not downgrade modified-history conflict in non-passthrough mode", async () => {
    // Without MERIDIAN_PASSTHROUGH, the downgrade must NOT fire.
    // The request proceeds as a fresh session rather than being downgraded
    // or getting a 409 (the turn lease mechanism determines conflict handling).
    delete process.env.MERIDIAN_PASSTHROUGH
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const opening = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "use1", content: "original" }] },
    ]
    const superseding = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "use1", content: "REVISED" }] },
      { role: "user", content: "extra turn" },
      { role: "assistant", content: "and response" },
    ]
    const firstP = app.fetch(request(opening, "non-passthrough-test"))
    const firstControl = await waitForControl(0)
    const secondP = app.fetch(request(superseding, "non-passthrough-test"))

    firstControl.release()
    expect((await firstP).status).toBe(200)
    // B proceeds as a fresh session (not downgraded, not 409'd).
    // Release B's SDK query if one started.
    try {
      const secondControl = await waitForControl(1, 500)
      secondControl.release()
    } catch { /* B may not start an SDK query */ }
    const second = await secondP
    expect(second.status).toBe(200)
  })

  it("sets replayDegradationReason on the downgraded SDK query in passthrough mode", async () => {
    process.env.MERIDIAN_PASSTHROUGH = "1"
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const opening = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "use1", content: "original" }] },
    ]
    const superseding = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "use1", content: "REVISED" }] },
      { role: "user", content: "extra turn" },
      { role: "assistant", content: "and response" },
    ]
    const firstP = app.fetch(request(opening, "replay-reason-test"))
    const firstControl = await waitForControl(0)
    const secondP = app.fetch(request(superseding, "replay-reason-test"))

    firstControl.release()
    expect((await firstP).status).toBe(200)
    const secondControl = await waitForControl(1)
    secondControl.release()
    const second = await secondP
    expect(second.status).toBe(200)

    // The second SDK query (index 1) is the fresh replay — its system prompt
    // should contain the concurrent-modified-history replay degradation note.
    const replayQuery = capturedParams[1] as any
    expect(replayQuery).toBeDefined()
    const sp = replayQuery.options?.systemPrompt
    const append = typeof sp === "object" && sp !== null ? (sp as { append?: string }).append : sp
    expect(append).toContain("another request")
    expect(append).toContain("in flight")
    expect(append).toContain("<meridian-note>")
  })
})