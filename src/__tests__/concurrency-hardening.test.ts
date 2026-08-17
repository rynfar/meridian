import { describe, expect, it, mock } from "bun:test"
import {
  assistantMessage,
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
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

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    queryCalls++
    const control = deferredAttempt()
    controls.push(control)
    const sessionId = `sdk-harden-${queryCalls}`
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

const { createProxyServer } = await import("../proxy/server")
const { telemetryStore } = await import("../telemetry")

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
    const body = await res.json() as { error?: { type?: string; message?: string } }
    // The bug: the inner 503 was rewrapped as `upstream_error` with the whole
    // inner JSON stringified into `message`, and the header was dropped.
    expect(body.error?.type).toBe("overloaded_error")
    expect(body.error?.message).toContain("shutting down")
    expect(body.error?.message).not.toContain("{")
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
    const body = await res.json() as { error?: { type?: string } }
    expect(body.error?.type).toBe("overloaded_error")
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
    const queued = proxy.app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-session": `queued-${Date.now()}`,
        "x-request-id": queuedId,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 64,
        messages: [{ role: "user", content: "queued" }],
      }),
      signal: abort.signal,
    }))

    await new Promise(resolve => setTimeout(resolve, 40))
    abort.abort()
    await Promise.resolve(queued).catch(() => undefined)

    const metric = metricFor(queuedId)
    expect(metric).toBeDefined()
    // The bug: wait time was credited only from a lease that an aborted
    // acquire never produces, so the entire wait landed in proxyOverheadMs —
    // the one number that is supposed to mean "the proxy is the bottleneck".
    expect(metric!.sdkQueueWaitMs ?? 0).toBeGreaterThan(0)

    control.release()
    const holderRes = await holder
    await holderRes.text()
  })
})
