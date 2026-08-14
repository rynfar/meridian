import { beforeEach, describe, expect, it, mock } from "bun:test"
import type { AddressInfo } from "node:net"
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

let controls: AttemptControl[] = []
let queryCalls = 0

function deferredAttempt(): AttemptControl & { wait: Promise<void>; markStarted: () => void } {
  let release = () => {}
  let markStarted = () => {}
  const wait = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { markStarted = resolve })
  return { release, started, wait, markStarted }
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    queryCalls++
    const control = deferredAttempt()
    controls.push(control)
    const sessionId = `sdk-drain-${queryCalls}`
    const generator = (async function* () {
      control.markStarted()
      yield { ...messageStart(), session_id: sessionId }
      await control.wait
      yield { ...textBlockStart(0), session_id: sessionId }
      yield { ...textDelta(0, "ok"), session_id: sessionId }
      yield { ...blockStop(0), session_id: sessionId }
      yield { ...messageDelta("end_turn"), session_id: sessionId }
      yield { ...messageStop(), session_id: sessionId }
      yield { ...assistantMessage([{ type: "text", text: "ok" }]), session_id: sessionId }
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

const { createProxyServer, startProxyServer, clearSessionCache } = await import("../proxy/server")

function request(
  sessionId: string,
  stream = true,
  messages: Array<{ role: string; content: string }> = [{ role: "user", content: "hi" }],
): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": sessionId },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      stream,
      messages,
    }),
  })
}

/** Same request over a real socket, for the end-to-end `close()` drain test. */
function post(base: string, sessionId: string, stream = true): Promise<Response> {
  return fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": sessionId },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      stream,
      messages: [{ role: "user", content: "hi" }],
    }),
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

describe("graceful shutdown", () => {
  beforeEach(() => {
    queryCalls = 0
    controls = []
    clearSessionCache()
  })

  it("exposes beginDrain and getInFlightCount, starting undrained with no in-flight requests", () => {
    const server = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    expect(typeof server.beginDrain).toBe("function")
    expect(typeof server.getInFlightCount).toBe("function")
    expect(server.getInFlightCount!()).toBe(0)
  })

  it("/health reports 503 draining once beginDrain is called", async () => {
    const server = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    server.beginDrain!()
    const response = await server.app.fetch(new Request("http://localhost/health"))
    expect(response.status).toBe(503)
    const body = await response.json() as Record<string, unknown>
    expect(body.status).toBe("draining")
    expect(typeof body.version === "string" || body.version === undefined).toBe(true)
  })

  it("rejects new /v1/messages requests with 503 once draining, without invoking the SDK", async () => {
    const server = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    server.beginDrain!()
    const response = await server.app.fetch(request("drain-reject"))
    expect(response.status).toBe(503)
    expect(response.headers.get("x-meridian-draining")).toBe("1")
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "overloaded_error",
        message: "Meridian is shutting down and is not accepting new requests. Retry against another instance.",
      },
    })
    expect(queryCalls).toBe(0)
  })

  it("lets a request admitted before draining finish, and drops getInFlightCount back to 0", async () => {
    const server = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const responseP = server.app.fetch(request("drain-inflight"))
    const control = await waitForControl(0)

    await Bun.sleep(10)
    expect(server.getInFlightCount!()).toBe(1)

    server.beginDrain!()
    expect(server.getInFlightCount!()).toBe(1)

    control.release()
    const response = await responseP
    expect(response.status).toBe(200)
    await response.text()
    await Bun.sleep(10)
    expect(server.getInFlightCount!()).toBe(0)
  })

  it("counts a same-session request while it waits for the active turn", async () => {
    const server = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const opening = [{ role: "user", content: "hi" }]
    const continuation = [
      ...opening,
      { role: "assistant", content: "ok" },
      { role: "user", content: "continue" },
    ]

    const firstResponseP = server.app.fetch(request("drain-queued", true, opening))
    const firstControl = await waitForControl(0)
    const firstResponse = await firstResponseP
    const secondResponseP = server.app.fetch(request("drain-queued", true, continuation))

    await Bun.sleep(10)
    expect(queryCalls).toBe(1)
    expect(server.getInFlightCount!()).toBe(2)

    firstControl.release()
    await firstResponse.text()

    const secondControl = await waitForControl(1)
    const secondResponse = await secondResponseP
    expect(server.getInFlightCount!()).toBe(1)

    secondControl.release()
    await secondResponse.text()
    await Bun.sleep(10)
    expect(server.getInFlightCount!()).toBe(0)
  })

  it("close() drains a live listener: refuses new work, waits for in-flight, frees the port", async () => {
    // The tests above drive the Hono app directly, which cannot show that the
    // drain gate and the socket teardown are actually wired into close() —
    // that wiring is what every plugin's SIGTERM handler depends on.
    const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const base = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`

    const inFlightP = post(base, "e2e-drain")
    const control = await waitForControl(0)
    const inFlight = await inFlightP
    expect(inFlight.status).toBe(200)

    const closeP = instance.close()
    let closed = false
    void closeP.then(() => { closed = true })

    // close() is idempotent: a second caller joins the same drain rather than
    // starting a second teardown.
    expect(instance.close()).toBe(closeP)

    const health = await fetch(`${base}/health`)
    expect(health.status).toBe(503)
    expect((await health.json() as Record<string, unknown>).status).toBe("draining")

    const refused = await post(base, "e2e-drain-refused")
    expect(refused.status).toBe(503)
    expect(refused.headers.get("x-meridian-draining")).toBe("1")
    await refused.text()
    expect(queryCalls).toBe(1)

    // The listener stays up for those drain responses, so close() must still be
    // pending — resolving here would mean cutting the in-flight stream off.
    await Bun.sleep(20)
    expect(closed).toBe(false)

    control.release()
    await inFlight.text()
    await closeP
    expect(closed).toBe(true)

    let portStillAccepting = true
    try {
      await fetch(`${base}/health`)
    } catch {
      portStillAccepting = false
    }
    expect(portStillAccepting).toBe(false)
  })
})
