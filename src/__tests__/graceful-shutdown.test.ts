import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { mkdtempSync, rmSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lookupSharedSession, setSessionStoreDir } from "../proxy/sessionStore"
import {
  assistantMessage,
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
  resolveMockSdkSessionId,
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

installSdkMock(() => ({
  query: (params: any) => {
    queryCalls++
    const control = deferredAttempt()
    controls.push(control)
    const sessionId = resolveMockSdkSessionId(params?.options, `sdk-drain-${queryCalls}`)
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
}), "graceful-shutdown.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
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
  let isolatedSessionDir = ""

  beforeEach(() => {
    isolatedSessionDir = mkdtempSync(join(tmpdir(), "meridian-shutdown-test-"))
    setSessionStoreDir(isolatedSessionDir)
    queryCalls = 0
    controls = []
    clearSessionCache()
  })

  afterEach(async () => {
    await Bun.sleep(25)
    rmSync(isolatedSessionDir, { recursive: true, force: true })
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

  // The Stable API Contract entry that plugins depend on. Draining adds a
  // fourth value to a `status` field that already varied, behind a 503 the
  // endpoint already returned for "unhealthy" — so the guarantee worth pinning
  // is that an undrained health check is untouched by any of it.
  it("leaves the undrained /health contract alone: same keys, never 'draining'", async () => {
    const server = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const response = await server.app.fetch(new Request("http://localhost/health"))
    const body = await response.json() as Record<string, unknown>

    expect(body.status).not.toBe("draining")
    expect(["healthy", "degraded", "unhealthy"]).toContain(String(body.status))
    expect(typeof body.version).toBe("string")
    // 200 when authed, 503 when not — both predate this change; the point is
    // that no new status code appears until beginDrain() is actually called.
    expect([200, 503]).toContain(response.status)
    expect(response.headers.get("x-meridian-draining")).toBeNull()

    server.beginDrain!()
    const drained = await server.app.fetch(new Request("http://localhost/health"))
    expect((await drained.json() as Record<string, unknown>).status).toBe("draining")
  }, 20_000)

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

  it("revokes durable publication when forced shutdown aborts an admitted request", async () => {
    const server = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const responseP = server.app.fetch(request("forced-shutdown", true))
    const control = await waitForControl(0)

    server.forceAbortInFlight!()
    // The mock deliberately ignores AbortSignal and completes normally. This
    // proves revocation, not cooperative SDK cancellation, fences the late
    // publication callback after the shutdown deadline.
    control.release()

    const response = await responseP
    await response.text()
    for (let index = 0; index < 100 && server.getInFlightCount!() !== 0; index++) {
      await Bun.sleep(1)
    }
    expect(server.getInFlightCount!()).toBe(0)
    expect(lookupSharedSession("forced-shutdown")).toBeUndefined()
  })

  it("evicts an existing mapping when forced shutdown interrupts its next turn", async () => {
    const server = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const opening = [{ role: "user", content: "hi" }]
    const firstP = server.app.fetch(request("forced-existing", true, opening))
    const firstControl = await waitForControl(0)
    const first = await firstP
    firstControl.release()
    await first.text()
    expect(lookupSharedSession("forced-existing")).toBeDefined()

    const continuation = [
      ...opening,
      { role: "assistant", content: "ok" },
      { role: "user", content: "continue" },
    ]
    const interruptedP = server.app.fetch(request("forced-existing", true, continuation))
    const interruptedControl = await waitForControl(1)
    const interrupted = await interruptedP

    // The mock ignores AbortSignal and exposes target content after shutdown.
    // Cleanup must evict the source mapping so that partial fork output cannot
    // be treated as if it already existed in that immutable source.
    server.forceAbortInFlight!()
    interruptedControl.release()
    await interrupted.text()
    for (let index = 0; index < 100 && server.getInFlightCount!() !== 0; index++) {
      await Bun.sleep(1)
    }
    expect(server.getInFlightCount!()).toBe(0)
    expect(lookupSharedSession("forced-existing")).toBeUndefined()
  })

  it("preserves the source when shutdown cancels a non-stream fork before response", async () => {
    const server = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const opening = [{ role: "user", content: "hi" }]
    const firstP = server.app.fetch(request("forced-existing-nonstream", false, opening))
    const firstControl = await waitForControl(0)
    firstControl.release()
    const first = await firstP
    await first.text()
    const sourceSessionId = lookupSharedSession("forced-existing-nonstream")?.claudeSessionId
    expect(sourceSessionId).toBeDefined()

    const continuation = [
      ...opening,
      { role: "assistant", content: "ok" },
      { role: "user", content: "continue" },
    ]
    const interruptedP = server.app.fetch(request("forced-existing-nonstream", false, continuation))
    const interruptedControl = await waitForControl(1)
    server.forceAbortInFlight!()
    interruptedControl.release()
    const interrupted = await interruptedP
    await interrupted.text()
    expect(lookupSharedSession("forced-existing-nonstream")?.claudeSessionId).toBe(sourceSessionId)
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
