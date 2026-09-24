import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as lifecycle from "../proxy/sessionLifecycle"
import { lifecycleLockQueue } from "../proxy/session/lifecycleLockQueue"
import { getSessionStoreDir } from "../proxy/sessionStore"

import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
type QueryMode = "complete" | "wait-for-abort"

let mode: QueryMode = "complete"
let capturedController: AbortController | undefined
let notifyQueryStarted: (() => void) | undefined

function assistantMessage() {
  return {
    type: "assistant",
    message: {
      id: "msg_abort_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "abort-test-session",
  }
}

import { withMockSdkSessionId } from "./helpers"

installSdkMock(() => ({
  query: (params: { options?: { abortController?: AbortController; sessionId?: string } }) => {
    capturedController = params.options?.abortController
    notifyQueryStarted?.()
    return (async function* () {
      if (mode === "complete") {
        const message = assistantMessage()
        yield withMockSdkSessionId(message, params.options)
        return
      }

      const signal = capturedController?.signal
      await new Promise<void>((_resolve, reject) => {
        if (!signal) return reject(new Error("missing SDK abort controller"))
        if (signal.aborted) return reject(new Error("SDK query aborted"))
        signal.addEventListener("abort", () => reject(new Error("SDK query aborted")), { once: true })
      })
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "proxy-request-cancellation.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function makeRequest(stream: boolean, signal?: AbortSignal) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      stream,
      messages: [{ role: "user", content: "hello" }],
    }),
    signal,
  })
}

function queryStarted(): Promise<void> {
  return new Promise((resolve) => {
    notifyQueryStarted = resolve
  })
}

describe("request cancellation propagation", () => {
  let originalPassthrough: string | undefined

  beforeEach(() => {
    originalPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    mode = "complete"
    capturedController = undefined
    notifyQueryStarted = undefined
    clearSessionCache()
  })

  afterEach(() => {
    if (originalPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
    else process.env.MERIDIAN_PASSTHROUGH = originalPassthrough
  })

  it("aborts a running non-stream SDK query when the HTTP request aborts", async () => {
    mode = "wait-for-abort"
    const started = queryStarted()
    const requestController = new AbortController()
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const responsePromise = app.fetch(makeRequest(false, requestController.signal))
    await started
    requestController.abort("client timeout")
    const response = await responsePromise

    expect(capturedController).toBeDefined()
    expect(capturedController!.signal.aborted).toBe(true)
    expect(capturedController!.signal.reason).toBe("client timeout")
    expect(response.status).toBe(499)
  })

  it("cancels queued lifecycle admission without invoking the SDK", async () => {
    const requestController = new AbortController()
    const server = createProxyServer({ port: 0, host: "127.0.0.1" })
    const holder = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const preparing = Promise.withResolvers<void>()
    const prepare = lifecycle.prepareForkForPublication
    let admissionSignal: AbortSignal | undefined
    const spy = spyOn(lifecycle, "prepareForkForPublication").mockImplementation((locator, options) => {
      admissionSignal = options?.admissionSignal
      preparing.resolve()
      return prepare(locator, options)
    })
    const active = lifecycleLockQueue.run(join(getSessionStoreDir(), "session-gc.json.lock"), undefined, async () => {
      entered.resolve()
      await holder.promise
    })
    try {
      await entered.promise
      const response = server.app.fetch(makeRequest(false, requestController.signal))
      await preparing.promise
      requestController.abort("cancel queued admission")
      holder.resolve()
      await active
      expect((await response).status).toBe(499)
      expect(admissionSignal?.aborted).toBe(true)
      expect(capturedController).toBeUndefined()
    } finally {
      holder.resolve()
      await active
      spy.mockRestore()
      await server.sweepSessionGc?.()
    }
  })

  it("joins cleanup without the canceled admission signal after a durable lease was acquired", async () => {
    const requestController = new AbortController()
    const server = createProxyServer({ port: 0, host: "127.0.0.1" })
    const acquire = lifecycle.acquireActiveTranscriptLease
    const release = lifecycle.releaseJoinedTranscriptLease
    let resourceKey: string | undefined
    let released = false
    const acquireSpy = spyOn(lifecycle, "acquireActiveTranscriptLease").mockImplementation(async (...args) => {
      const lease = await acquire(...args)
      resourceKey = lease.resourceKeys[0]
      requestController.abort("cancel after durable admission")
      return lease
    })
    const releaseSpy = spyOn(lifecycle, "releaseJoinedTranscriptLease").mockImplementation(async (lease, options) => {
      expect(options?.admissionSignal).toBeUndefined()
      await release(lease, options)
      released = true
    })
    try {
      const response = await server.app.fetch(makeRequest(false, requestController.signal))
      expect(response.status).toBe(499)
      expect(capturedController).toBeUndefined()
      expect(released).toBe(true)
      expect(resourceKey).toBeDefined()
      const sidecar: unknown = JSON.parse(readFileSync(join(getSessionStoreDir(), "session-gc.json"), "utf8"))
      expect(sidecar).toHaveProperty(`resources.${resourceKey}`)
      expect(sidecar).not.toHaveProperty(`resources.${resourceKey}.activeLeases`)
    } finally {
      acquireSpy.mockRestore()
      releaseSpy.mockRestore()
      await server.sweepSessionGc?.()
    }
  })

  it("aborts a streaming SDK query when the response body is cancelled", async () => {
    mode = "wait-for-abort"
    const started = queryStarted()
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await app.fetch(makeRequest(true))
    await started
    await response.body!.cancel("reader closed")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(capturedController).toBeDefined()
    expect(capturedController!.signal.aborted).toBe(true)
    expect(capturedController!.signal.reason).toBe("reader closed")
  })

  it("detaches the request signal after a completed non-stream query", async () => {
    const requestController = new AbortController()
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await app.fetch(makeRequest(false, requestController.signal))
    expect(response.status).toBe(200)
    expect(capturedController).toBeDefined()
    expect(capturedController!.signal.aborted).toBe(false)

    requestController.abort("too late")
    expect(capturedController!.signal.aborted).toBe(false)
  })
})
