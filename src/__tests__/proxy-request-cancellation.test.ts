import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import * as files from "node:fs/promises"
import { join } from "node:path"
import * as lifecycle from "../proxy/sessionLifecycle"
import { lifecycleLockQueue } from "../proxy/session/lifecycleLockQueue"
import { getSessionStoreDir } from "../proxy/sessionStore"
import * as sessionStore from "../proxy/sessionStore"

import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
type QueryMode = "complete" | "wait-for-abort" | "expose-then-fail"

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

import { messageStart, textBlockStart, textDelta, withMockSdkSessionId } from "./helpers"

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
      if (mode === "expose-then-fail") {
        yield withMockSdkSessionId(messageStart("msg_cancel_cleanup"), params.options)
        yield withMockSdkSessionId(textBlockStart(0), params.options)
        yield withMockSdkSessionId(textDelta(0, "partial answer"), params.options)
        throw new Error("scripted upstream failure")
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

function makeRequest(
  stream: boolean,
  signal?: AbortSignal,
  sessionId?: string,
  messages: Array<{ role: string; content: string }> = [{ role: "user", content: "hello" }],
) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(sessionId ? { "x-opencode-session": sessionId } : {}) },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      stream,
      messages,
    }),
    signal,
  })
}

function queryStarted(): Promise<void> {
  return new Promise((resolve) => {
    notifyQueryStarted = resolve
  })
}

function gate() {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  return { enter, entered, release, released }
}

describe("request cancellation propagation", () => {
  let originalPassthrough: string | undefined

  beforeEach(async () => {
    originalPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    mode = "complete"
    capturedController = undefined
    notifyQueryStarted = undefined
    await clearSessionCache()
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

  it("keeps a stream's turn until the eviction its client cancel started has landed", async () => {
    mode = "expose-then-fail"
    const server = createProxyServer({ port: 0, host: "127.0.0.1" })
    const abandonFork = lifecycle.abandonFork
    const evictSharedSession = sessionStore.evictSharedSession
    const abandoning = gate()
    const evicting = gate()
    let abandoned = false
    const abandonSpy = spyOn(lifecycle, "abandonFork").mockImplementation(async (...args) => {
      abandoning.enter()
      await abandoning.released
      try {
        return await abandonFork(...args)
      } finally {
        abandoned = true
      }
    })
    const evictSpy = spyOn(sessionStore, "evictSharedSession").mockImplementation(async (...args) => {
      evicting.enter()
      await evicting.released
      return evictSharedSession(...args)
    })
    try {
      const response = await server.app.fetch(makeRequest(true, undefined, "cancel-during-stream-cleanup"))
      // The SDK fails after the text went out, so the stream closes with its
      // error event still queued and its cleanup abandons the unpublished fork.
      await abandoning.entered
      const cancelled = response.body!.cancel("client gone")
      await evicting.entered
      abandoning.release()
      while (!abandoned) await new Promise((resolve) => setImmediate(resolve))
      for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve))
      expect(server.getInFlightCount!()).toBe(1)

      evicting.release()
      await cancelled
      const deadline = Date.now() + 5_000
      while (server.getInFlightCount!() > 0 && Date.now() < deadline) await Bun.sleep(5)
      expect(server.getInFlightCount!()).toBe(0)
    } finally {
      abandoning.release()
      evicting.release()
      abandonSpy.mockRestore()
      evictSpy.mockRestore()
    }
  })

  it("lets a request see a store write this process started before it arrived", async () => {
    const sessionId = "arrival-after-pending-eviction"
    const server = createProxyServer({ port: 0, host: "127.0.0.1" })
    const first = await server.app.fetch(makeRequest(false, undefined, sessionId))
    expect(first.status).toBe(200)
    await first.text()
    expect(sessionStore.lookupSharedSession(sessionId)).toBeDefined()

    const disk = await holdStoreFileSync(getSessionStoreDir())
    let next: Promise<Response> | undefined
    try {
      // What a cancelled stream's body leaves behind once its turn has ended:
      // an eviction nobody waits for.
      const eviction = sessionStore.evictSharedSession(sessionId)
      next = Promise.resolve(server.app.fetch(makeRequest(false, undefined, sessionId, [
        { role: "user", content: "hello" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue" },
      ])))
      await Bun.sleep(100)
      disk.release()
      expect(await eviction).toBe(true)
    } finally {
      disk.release()
      disk.restore()
    }
    const response = await next!
    expect(response.status).toBe(200)
    expect(sessionStore.lookupSharedSession(sessionId)).toBeDefined()
  })

  it.each(["request", "shutdown"] as const)("never publishes a mapping revoked by %s while its fsync waits", async (cause) => {
    const controller = new AbortController()
    const server = createProxyServer({ port: 0, host: "127.0.0.1" })
    const disk = await holdStoreFileSync(getSessionStoreDir())
    const rename = files.rename
    let publications = 0
    const renames = spyOn(files, "rename").mockImplementation(async (...args) => {
      if (String(args[1]) === join(getSessionStoreDir(), "sessions.json")) publications++
      return rename(...args)
    })
    try {
      const response = server.app.fetch(makeRequest(false, controller.signal, "cancel-during-store-fsync"))
      await disk.entered
      if (cause === "request") controller.abort("cancel during durable write")
      else server.forceAbortInFlight?.()
      disk.release()
      expect((await response).status).toBe(499)
      expect(sessionStore.lookupSharedSession("cancel-during-store-fsync")).toBeUndefined()
      // Another proxy must never be able to resume the canceled target, even
      // briefly between a late publication and its compensating eviction.
      expect(publications).toBe(0)
    } finally {
      disk.release()
      disk.restore()
      renames.mockRestore()
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

async function holdStoreFileSync(dir: string): Promise<{ entered: Promise<void>; release: () => void; restore: () => void }> {
  const probe = await open(join(dir, "sync-probe"), "w")
  const prototype = Object.getPrototypeOf(probe) as FileHandle
  await probe.close()
  rmSync(join(dir, "sync-probe"), { force: true })
  const { writeFile, sync } = prototype
  const storeFiles = new WeakSet<FileHandle>()
  const entered = Promise.withResolvers<void>()
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  prototype.writeFile = function (this: FileHandle, ...args: Parameters<FileHandle["writeFile"]>) {
    const [data] = args
    const head = typeof data === "string" ? data.slice(0, 64) : Buffer.isBuffer(data) ? data.subarray(0, 64).toString("utf8") : ""
    if (head.includes("meridian-session-store")) storeFiles.add(this)
    return writeFile.apply(this, args)
  }
  prototype.sync = async function (this: FileHandle) {
    if (storeFiles.has(this)) {
      entered.resolve()
      await released
    }
    return sync.call(this)
  }
  return {
    entered: entered.promise,
    release,
    restore: () => {
      prototype.writeFile = writeFile
      prototype.sync = sync
    },
  }
}
