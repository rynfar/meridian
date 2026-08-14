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
    const sessionId = `sdk-concurrency-${queryCalls}`
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
    // A refused request never reaches the SDK, so without this the assertion
    // "it was admitted" would surface as an opaque test-runner timeout.
    if (Date.now() > deadline) throw new Error(`SDK attempt #${index} never started`)
    await Bun.sleep(1)
  }
  const control = controls[index]!
  await control.started
  return control
}

describe("SDK and Session concurrency coordination", () => {
  const originalMax = process.env.MERIDIAN_MAX_CONCURRENT
  const originalHold = process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS

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
  })

  it("holds the SDK permit for the complete streaming lifecycle", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const first = await app.fetch(request([{ role: "user", content: "one" }], "stream-one", true))
    const firstControl = await waitForControl(0)
    const second = await app.fetch(request([{ role: "user", content: "two" }], "stream-two", true))

    await Bun.sleep(10)
    expect(queryCalls).toBe(1)
    expect(activeQueries).toBe(1)

    firstControl.release()
    await first.text()
    const secondControl = await waitForControl(1)
    expect(maxActiveQueries).toBe(1)
    secondControl.release()
    await second.text()
    expect(activeQueries).toBe(0)
  })

  it("shares the SDK permit across ProxyServer instances", async () => {
    const firstApp = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const secondApp = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app

    const first = await firstApp.fetch(request([{ role: "user", content: "one" }], "process-one", true))
    const firstControl = await waitForControl(0)
    const second = await secondApp.fetch(request([{ role: "user", content: "two" }], "process-two", true))

    await Bun.sleep(10)
    expect(queryCalls).toBe(1)
    expect(activeQueries).toBe(1)

    firstControl.release()
    await first.text()
    const secondControl = await waitForControl(1)
    expect(maxActiveQueries).toBe(1)
    secondControl.release()
    await second.text()
  })

  it("uses the latest resume state for a continuation that waited", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const opening = [{ role: "user", content: "hello" }]
    const continuation = [
      ...opening,
      { role: "assistant", content: "ok" },
      { role: "user", content: "continue" },
    ]
    const firstP = app.fetch(request(opening, "shared"))
    const firstControl = await waitForControl(0)
    const secondP = app.fetch(request(continuation, "shared"))

    await Bun.sleep(10)
    expect(queryCalls).toBe(1)
    firstControl.release()
    expect((await firstP).status).toBe(200)

    const secondControl = await waitForControl(1)
    expect(capturedParams[1]?.options?.resume).toBe("sdk-concurrency-1")
    secondControl.release()
    expect((await secondP).status).toBe(200)
  })

  it("returns an Anthropic-compatible invalid request for a stale repeated branch", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const messages = [{ role: "user", content: "same request" }]
    const firstP = app.fetch(request(messages, "conflict"))
    const firstControl = await waitForControl(0)
    const secondP = app.fetch(request(messages, "conflict"))

    firstControl.release()
    expect((await firstP).status).toBe(200)
    const second = await secondP
    expect(second.status).toBe(400)
    expect(second.headers.get("x-meridian-conflict")).toBeNull()
    expect(await second.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "This session advanced while the request was waiting. Retry with the latest conversation history or use a distinct session ID.",
      },
    })
    expect(queryCalls).toBe(1)

    // A refusal that never reaches telemetry is a refusal operators can't
    // count, so the rate of concurrency conflicts stays invisible.
    const conflicts = telemetryStore.getRecent().filter(m => m.error === "session_turn_conflict")
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.status).toBe(400)
    expect(conflicts[0]!.upstreamDurationMs).toBe(0)
  })

  it("does not refuse a turn because a DIFFERENT profile advanced the same session id", async () => {
    // One client session id backs an independent conversation per profile, each
    // with its own cache scope. A commit under "work" says nothing about the
    // lineage a queued "personal" request carries, so it must not refuse it.
    const app = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      silent: true,
      profiles: [
        { id: "work", claudeConfigDir: "/tmp/meridian-test-turn-work" },
        { id: "personal", claudeConfigDir: "/tmp/meridian-test-turn-personal" },
      ],
      defaultProfile: "work",
    }).app
    const messages = [{ role: "user", content: "same request" }]
    const firstP = app.fetch(request(messages, "cross-profile", false, { "x-meridian-profile": "work" }))
    const firstControl = await waitForControl(0)
    const secondP = app.fetch(request(messages, "cross-profile", false, { "x-meridian-profile": "personal" }))

    // Still serialized — they share one client session id.
    await Bun.sleep(10)
    expect(queryCalls).toBe(1)

    firstControl.release()
    expect((await firstP).status).toBe(200)

    const secondControl = await waitForControl(1)
    secondControl.release()
    expect((await secondP).status).toBe(200)
    expect(queryCalls).toBe(2)
  })

  it("lets a declared concurrent flow replay instead of refusing it", async () => {
    // fork-/subagent- sources knowingly run parallel turns under one session
    // key; a reclassification is their normal cost. Refusing them would break
    // flows that worked before turn coordination existed.
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const messages = [{ role: "user", content: "same request" }]
    const firstP = app.fetch(request(messages, "declared-flow"))
    const firstControl = await waitForControl(0)
    const secondP = app.fetch(
      request(messages, "declared-flow", false, { "x-meridian-source": "subagent-scout" }),
    )

    firstControl.release()
    expect((await firstP).status).toBe(200)

    const secondControl = await waitForControl(1)
    secondControl.release()
    expect((await secondP).status).toBe(200)
    expect(queryCalls).toBe(2)
  })

  it("force-releases a wedged turn instead of deadlocking the session", async () => {
    process.env.MERIDIAN_MAX_CONCURRENT = "2"
    process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS = "50"
    resetProcessSdkSemaphoreForTests()
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app

    // Never released and never read: the response body stays open, so this
    // request never finishes and would hold its lease for the lifetime of the
    // process without the watchdog.
    const wedged = await app.fetch(request([{ role: "user", content: "one" }], "wedged", true))
    const wedgedControl = await waitForControl(0)

    const secondP = app.fetch(request([{ role: "user", content: "two" }], "wedged", true))
    // Only reachable once the wedged turn's lease is force-released.
    const secondControl = await waitForControl(1)
    expect(queryCalls).toBe(2)

    secondControl.release()
    await (await secondP).text()
    wedgedControl.release()
    await wedged.text()
  })
})
