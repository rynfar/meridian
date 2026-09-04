import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
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

/**
 * Regression coverage for the hardening pass over the SDK/session concurrency
 * work. Every test here fails against the original change and passes with the
 * corrections; each one is named for the contract it pins.
 */

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
    const sessionId = resolveMockSdkSessionId(params.options, `sdk-harden-${queryCalls}`)
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
}), "concurrency-hardening.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer } = await import("../proxy/server")
const { telemetryStore } = await import("../telemetry")
const { AbortableSemaphore, resetProcessSdkSemaphoreForTests } = await import("../proxy/concurrency")

// The SDK semaphore is a process-wide singleton cached on first use, so a file
// that leaves one behind silently overrides the next file's maxConcurrent.
// Reset on both sides: the permit-wait test below depends on its own limit of
// 1, and proxy-concurrency-limiter.test.ts depends on getting a fresh one.
beforeEach(() => { resetProcessSdkSemaphoreForTests() })
afterEach(() => { resetProcessSdkSemaphoreForTests() })

function metricFor(requestId: string) {
  return telemetryStore.getRecent({ limit: 500 }).find(m => m.requestId === requestId)
}

async function waitForControl(index: number, timeoutMs = 3000): Promise<AttemptControl> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const control = controls[index]
    if (control) {
      await control.started
      return control
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`SDK attempt ${index} never started`)
}

describe("drain contract on the OpenAI-compatible routes", () => {
  it("refuses /v1/chat/completions with the drain contract, not a wrapped upstream_error", async () => {
    const proxy = createProxyServer({ silent: true })
    proxy.beginDrain?.()

    const res = await proxy.app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    }))

    expect(res.status).toBe(503)
    expect(res.headers.get("x-meridian-draining")).toBe("1")
    const body = await res.json() as { type?: string; error?: { type?: string; message?: string } }
    // The bug: the inner 503 was rewrapped as `upstream_error` with the whole
    // inner JSON stringified into `message`, and the header was dropped.
    expect(body.error?.type).toBe("overloaded_error")
    expect(body.error?.message).toContain("shutting down")
    expect(body.error?.message).not.toContain("{")
    // ...and in this route's own envelope, which is the Anthropic one.
    expect(body.type).toBe("error")
  })

  it("refuses /v1/responses with the drain contract", async () => {
    const proxy = createProxyServer({ silent: true })
    proxy.beginDrain?.()

    const res = await proxy.app.fetch(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: "hi" }),
    }))

    expect(res.status).toBe(503)
    expect(res.headers.get("x-meridian-draining")).toBe("1")
    // /v1/responses answers every other error -- including the two 400s
    // beside it -- in the OpenAI envelope, so the drain 503 must match rather
    // than hand a Codex-style client the one reply it parses differently.
    const body = await res.json() as { type?: string; error?: { type?: string; code?: unknown } }
    expect(body.error?.type).toBe("overloaded_error")
    expect(body).toHaveProperty("error.code", null)
    expect(body.type).toBeUndefined()
  })

  it("cannot be talked out of draining by a spoofed internal-hop header", async () => {
    const proxy = createProxyServer({ silent: true })
    proxy.beginDrain?.()

    // The hop exemption is a per-instance random token, so guessing the header
    // name buys a wire client nothing.
    for (const spoof of ["1", "true", "internal"]) {
      const res = await proxy.app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-session": "spoof-session",
          "x-meridian-internal-hop": spoof,
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 64,
          messages: [{ role: "user", content: "hi" }],
        }),
      }))
      expect(res.status).toBe(503)
      expect(res.headers.get("x-meridian-draining")).toBe("1")
    }
  })
})

describe("queue telemetry under cancellation", () => {
  it("records a row when a request is cancelled waiting for the session lease", async () => {
    controls = []
    const proxy = createProxyServer({ silent: true })
    const session = `lease-cancel-${Date.now()}`

    const first = proxy.app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-session": session },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 64, stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    }))
    const control = await waitForControl(0)

    const cancelledId = `cancelled-lease-${Date.now()}`
    const abort = new AbortController()
    const second = proxy.app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-session": session,
        "x-request-id": cancelledId,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 64,
        messages: [{ role: "user", content: "second" }],
      }),
      signal: abort.signal,
    }))

    // Let it reach the lease queue, then give up on it.
    await new Promise(resolve => setTimeout(resolve, 30))
    abort.abort()
    // app.fetch is typed Response | Promise<Response>; normalise before catching.
    const res = await Promise.resolve(second).catch(() => undefined)
    expect(res?.status).toBe(499)

    // The bug: this return happens before RequestMeta exists, so the whole
    // class of "client gave up waiting on the session lock" was unmeasurable.
    const metric = metricFor(cancelledId)
    expect(metric).toBeDefined()
    expect(metric!.status).toBe(499)
    expect(metric!.error).toBe("request_cancelled")
    expect(metric!.sessionQueueWaitMs ?? 0).toBeGreaterThan(0)

    control.release()
    const firstRes = await first
    await firstRes.text()
  })

  it("credits an aborted SDK-permit wait as queue time, not proxy overhead", async () => {
    controls = []
    const proxy = createProxyServer({ silent: true, maxConcurrent: 1 })

    // Occupy the single SDK permit.
    const holder = proxy.app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-session": `holder-${Date.now()}` },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 64, stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    }))
    const control = await waitForControl(0)

    const queuedId = `cancelled-permit-${Date.now()}`
    const abort = new AbortController()
    let queuedSemaphore: InstanceType<typeof AbortableSemaphore> | undefined
    const acquire = AbortableSemaphore.prototype.acquire
    const acquireSpy = spyOn(AbortableSemaphore.prototype, "acquire").mockImplementation(function (this: InstanceType<typeof AbortableSemaphore>, signal) {
      const pending = acquire.call(this, signal)
      if (this.snapshot.queued > 0) queuedSemaphore = this
      return pending
    })
    // Exercise setup taking longer than the former 40 ms cancellation timer.
    // A slow request body must not be mistaken for time spent in the SDK queue.
    const delayedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            model: "claude-sonnet-4-6", max_tokens: 64,
            messages: [{ role: "user", content: "queued" }],
          })))
          controller.close()
        }, 75)
      },
    })
    const queued = proxy.app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-session": `queued-${Date.now()}`,
        "x-request-id": queuedId,
      },
      body: delayedBody,
      signal: abort.signal,
    }))

    try {
      // Synchronize on the real queue, not a guessed request-setup duration.
      const deadline = Date.now() + 3000
      while (!queuedSemaphore && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(queuedSemaphore?.snapshot).toEqual({ active: 1, queued: 1, limit: 1 })
      // Ensure this wait spans the millisecond clock used by the metric.
      await new Promise(resolve => setTimeout(resolve, 10))
      abort.abort()
      const response = await queued
      expect(response.status).toBe(499)

      const metric = metricFor(queuedId)
      expect(metric).toBeDefined()
      // An aborted acquire never produces a lease, but its queue time must
      // still be measured separately from request setup / proxy overhead.
      expect(metric!.sdkQueueWaitMs ?? 0).toBeGreaterThan(0)
      expect(queuedSemaphore?.snapshot.queued).toBe(0)
      expect(controls).toHaveLength(1)
    } finally {
      abort.abort()
      acquireSpy.mockRestore()
      control.release()
      await queued
      const holderRes = await holder
      await holderRes.text()
    }
  })
})
