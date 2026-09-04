/**
 * Parent-to-child cancellation at the server seam (issue #902).
 *
 * Prime Agent's RLM children are independent HTTP requests on independent
 * session keys. Before this, cancelling the parent left every child running —
 * holding an SDK permit and a turn lease, billing the subscription — until its
 * own socket closed or the lease watchdog tripped.
 *
 * The child declares its parent in the same `metadata.user_id` envelope that
 * carries its session id, so these tests drive the real wire contract:
 * client A is the parent, client B is a child stamped with
 * `parent_session_id`, and the parent's request is aborted the way a client
 * disconnect aborts it.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { resolveMockSdkSessionId, withMockSdkSessionId } from "./helpers"

type Behavior = "complete" | "hang"

interface SdkCall {
  readonly controller: AbortController | undefined
  readonly resume: string | undefined
  readonly sessionId: string | undefined
}

let behaviors: Behavior[] = []
let calls: SdkCall[] = []
let notifyQueryStarted: (() => void) | undefined

function assistantMessage(sessionId: string) {
  return {
    type: "assistant",
    message: {
      id: "msg_session_tree",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  }
}

installSdkMock(() => ({
  query: (params: { options?: { abortController?: AbortController; resume?: string; sessionId?: string } }) => {
    const behavior = behaviors.shift() ?? "complete"
    const controller = params.options?.abortController
    calls.push({
      controller,
      resume: params.options?.resume,
      sessionId: params.options?.sessionId,
    })
    const notify = notifyQueryStarted
    notifyQueryStarted = undefined
    notify?.()
    return (async function* () {
      if (behavior === "complete") {
        const sessionId = resolveMockSdkSessionId(params.options, crypto.randomUUID())
        yield withMockSdkSessionId(assistantMessage(sessionId), params.options)
        return
      }
      // Hold the turn open until something aborts it — the shape a live
      // subagent turn has when its parent is cancelled.
      await new Promise<void>((_resolve, reject) => {
        const signal = controller?.signal
        if (!signal) return reject(new Error("missing SDK abort controller"))
        if (signal.aborted) return reject(new Error("SDK query aborted"))
        signal.addEventListener("abort", () => reject(new Error("SDK query aborted")), { once: true })
      })
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "proxy-session-tree-cancellation.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { processSessionTree } = await import("../proxy/sessionTree")

const PARENT = "prime-parent-session"
const CHILD = "prime-child-session"
const GRANDCHILD = "prime-grandchild-session"

function messagesRequest(options: {
  sessionId: string
  parentSessionId?: string
  stream?: boolean
  messages?: Array<{ role: string; content: unknown }>
  signal?: AbortSignal
}) {
  const identity: Record<string, string> = { session_id: options.sessionId }
  if (options.parentSessionId) identity.parent_session_id = options.parentSessionId
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Prime Agent's User-Agent is the generic Anthropic SDK one, so the
      // adapter is selected explicitly — exactly as the provider config does.
      "x-meridian-agent": "prime",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      stream: options.stream ?? false,
      messages: options.messages ?? [{ role: "user", content: `hello from ${options.sessionId}` }],
      metadata: { user_id: JSON.stringify(identity) },
    }),
    signal: options.signal,
  })
}

function queryStarted(): Promise<void> {
  return new Promise((resolve) => { notifyQueryStarted = resolve })
}

/** Let the cascade's abort listeners and the aborted turns' teardown settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function drain(response: Response): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

describe("parent-to-child cancellation", () => {
  let originalPassthrough: string | undefined

  beforeEach(() => {
    originalPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    behaviors = []
    calls = []
    notifyQueryStarted = undefined
    clearSessionCache()
    processSessionTree.clear()
  })

  afterEach(() => {
    if (originalPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
    else process.env.MERIDIAN_PASSTHROUGH = originalPassthrough
    processSessionTree.clear()
  })

  it("aborts a linked child's in-flight SDK query when the parent's request aborts", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const parentAbort = new AbortController()

    behaviors = ["hang", "hang"]
    const parentStarted = queryStarted()
    const parentResponse = app.fetch(messagesRequest({ sessionId: PARENT, signal: parentAbort.signal }))
    await parentStarted

    const childStarted = queryStarted()
    const childResponse = app.fetch(messagesRequest({ sessionId: CHILD, parentSessionId: PARENT }))
    await childStarted

    expect(calls).toHaveLength(2)
    const childController = calls[1]!.controller!
    expect(childController.signal.aborted).toBe(false)

    parentAbort.abort("client hung up")
    await settle()

    // The child's own socket is still open; only the parent's was cut.
    expect(childController.signal.aborted).toBe(true)
    expect(calls[0]!.controller!.signal.aborted).toBe(true)

    expect((await parentResponse).status).toBe(499)
    expect((await childResponse).status).toBe(499)
  })

  it("aborts a linked child's stream, closing it with an error frame", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const parentAbort = new AbortController()

    behaviors = ["hang", "hang"]
    const parentStarted = queryStarted()
    const parentResponse = app.fetch(messagesRequest({ sessionId: PARENT, signal: parentAbort.signal }))
    await parentStarted

    const childStarted = queryStarted()
    const childStream = await app.fetch(messagesRequest({
      sessionId: CHILD,
      parentSessionId: PARENT,
      stream: true,
    }))
    await childStarted

    parentAbort.abort("client hung up")
    const childBody = await drain(childStream)
    await parentResponse

    expect(calls[1]!.controller!.signal.aborted).toBe(true)
    expect(childBody).toContain("event: error")
  })

  it("cancels children when a streaming parent's response body is cancelled", async () => {
    // Prime Agent streams every request, and a cancelled response body is the
    // abort path an in-process caller reaches — the request signal never fires.
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app

    behaviors = ["hang", "hang"]
    const parentStarted = queryStarted()
    const parentStream = await app.fetch(messagesRequest({ sessionId: PARENT, stream: true }))
    await parentStarted

    const childStarted = queryStarted()
    const childResponse = app.fetch(messagesRequest({ sessionId: CHILD, parentSessionId: PARENT }))
    await childStarted

    await parentStream.body!.cancel("reader closed")
    await settle()

    expect(calls[1]!.controller!.signal.aborted).toBe(true)
    expect(processSessionTree.stats().propagations).toBe(1)
    expect((await childResponse).status).toBe(499)
  })

  it("propagates once when a teardown trips both client abort paths", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const parentAbort = new AbortController()

    behaviors = ["hang", "hang"]
    const parentStarted = queryStarted()
    const parentStream = await app.fetch(messagesRequest({
      sessionId: PARENT,
      stream: true,
      signal: parentAbort.signal,
    }))
    await parentStarted

    const childStarted = queryStarted()
    const childResponse = app.fetch(messagesRequest({ sessionId: CHILD, parentSessionId: PARENT }))
    await childStarted

    parentAbort.abort("client hung up")
    await parentStream.body!.cancel("reader closed").catch(() => {})
    await settle()

    expect(calls[1]!.controller!.signal.aborted).toBe(true)
    expect(processSessionTree.stats().propagations).toBe(1)
    expect(processSessionTree.stats().cancelledDescendants).toBe(1)
    await childResponse
  })

  it("walks the whole subtree, not just the immediate children", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const parentAbort = new AbortController()

    behaviors = ["hang", "hang", "hang"]
    const parentStarted = queryStarted()
    const parentResponse = app.fetch(messagesRequest({ sessionId: PARENT, signal: parentAbort.signal }))
    await parentStarted

    const childStarted = queryStarted()
    const childResponse = app.fetch(messagesRequest({ sessionId: CHILD, parentSessionId: PARENT }))
    await childStarted

    // The grandchild names its IMMEDIATE parent, per the wire contract.
    const grandchildStarted = queryStarted()
    const grandchildResponse = app.fetch(messagesRequest({
      sessionId: GRANDCHILD,
      parentSessionId: CHILD,
    }))
    await grandchildStarted

    parentAbort.abort("client hung up")
    await settle()

    expect(calls[1]!.controller!.signal.aborted).toBe(true)
    expect(calls[2]!.controller!.signal.aborted).toBe(true)
    expect((await childResponse).status).toBe(499)
    expect((await grandchildResponse).status).toBe(499)
    await parentResponse
  })

  it("evicts the cancelled child's session mapping so no interrupted tail is resumable", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app

    // Turn 1 for the child completes normally and establishes a mapping.
    behaviors = ["complete"]
    const firstTurn = await app.fetch(messagesRequest({ sessionId: CHILD, parentSessionId: PARENT }))
    expect(firstTurn.status).toBe(200)
    await firstTurn.json()

    const continuation = [
      { role: "user", content: `hello from ${CHILD}` },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "keep going" },
    ]

    // Turn 2 resumes it, then dies to the parent's abort mid-flight.
    behaviors = ["hang", "hang"]
    const parentAbort = new AbortController()
    const parentStarted = queryStarted()
    const parentResponse = app.fetch(messagesRequest({ sessionId: PARENT, signal: parentAbort.signal }))
    await parentStarted

    const cancelledStarted = queryStarted()
    const cancelledTurn = app.fetch(messagesRequest({
      sessionId: CHILD,
      parentSessionId: PARENT,
      messages: continuation,
    }))
    await cancelledStarted
    expect(calls[2]!.resume).toBeDefined()

    parentAbort.abort("client hung up")
    await settle()
    expect((await cancelledTurn).status).toBe(499)
    await parentResponse

    // Turn 3 must start fresh: the interrupted turn may have advanced the SDK
    // transcript past what the mapping described.
    behaviors = ["complete"]
    const afterCancel = await app.fetch(messagesRequest({
      sessionId: CHILD,
      parentSessionId: PARENT,
      messages: continuation,
    }))
    expect(afterCancel.status).toBe(200)
    await afterCancel.json()
    expect(calls[3]!.resume).toBeUndefined()
  })

  it("leaves children alone when the parent's turn merely completes", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app

    behaviors = ["hang", "complete"]
    const childStarted = queryStarted()
    const childResponse = app.fetch(messagesRequest({ sessionId: CHILD, parentSessionId: PARENT }))
    await childStarted

    const parentTurn = await app.fetch(messagesRequest({ sessionId: PARENT }))
    expect(parentTurn.status).toBe(200)
    await parentTurn.json()
    await settle()

    // A subagent routinely outlives the parent turn that spawned it.
    expect(calls[0]!.controller!.signal.aborted).toBe(false)
    expect(processSessionTree.stats().cancelledDescendants).toBe(0)

    // Clean up the still-running child.
    calls[0]!.controller!.abort("test cleanup")
    await childResponse
  })

  it("leaves a request that declared no parent alone", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const parentAbort = new AbortController()

    behaviors = ["hang", "hang"]
    const parentStarted = queryStarted()
    const parentResponse = app.fetch(messagesRequest({ sessionId: PARENT, signal: parentAbort.signal }))
    await parentStarted

    // Same client, unrelated conversation: no parent_session_id, so propagation
    // cannot reach it. This is the gate that keeps every other client inert.
    const unlinkedStarted = queryStarted()
    const unlinkedResponse = app.fetch(messagesRequest({ sessionId: "prime-unrelated-session" }))
    await unlinkedStarted

    parentAbort.abort("client hung up")
    await settle()

    expect(calls[1]!.controller!.signal.aborted).toBe(false)
    expect(processSessionTree.stats().cancelledDescendants).toBe(0)
    await parentResponse

    calls[1]!.controller!.abort("test cleanup")
    await unlinkedResponse
  })

  it("counts propagated cancellations on /telemetry/summary", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const parentAbort = new AbortController()

    behaviors = ["hang", "hang"]
    const parentStarted = queryStarted()
    const parentResponse = app.fetch(messagesRequest({ sessionId: PARENT, signal: parentAbort.signal }))
    await parentStarted

    const childStarted = queryStarted()
    const childResponse = app.fetch(messagesRequest({ sessionId: CHILD, parentSessionId: PARENT }))
    await childStarted

    const before = await (await app.fetch(new Request("http://localhost/telemetry/summary"))).json() as {
      sessionTree: { tracked: number; linked: number; propagations: number; cancelledDescendants: number }
    }
    expect(before.sessionTree.tracked).toBe(2)
    expect(before.sessionTree.linked).toBe(1)
    expect(before.sessionTree.propagations).toBe(0)

    parentAbort.abort("client hung up")
    await settle()
    await parentResponse
    await childResponse

    const after = await (await app.fetch(new Request("http://localhost/telemetry/summary"))).json() as {
      sessionTree: { tracked: number; propagations: number; cancelledDescendants: number }
    }
    expect(after.sessionTree.propagations).toBe(1)
    expect(after.sessionTree.cancelledDescendants).toBe(1)
    // Both requests settled, so the live registry is empty again.
    expect(after.sessionTree.tracked).toBe(0)
  })

  it("cancels a subtree explicitly via POST /v1/sessions/:key/cancel", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app

    behaviors = ["hang", "hang"]
    const parentStarted = queryStarted()
    const parentResponse = app.fetch(messagesRequest({ sessionId: PARENT }))
    await parentStarted

    const childStarted = queryStarted()
    const childResponse = app.fetch(messagesRequest({ sessionId: CHILD, parentSessionId: PARENT }))
    await childStarted

    const cancelled = await app.fetch(new Request(
      `http://localhost/v1/sessions/${encodeURIComponent(PARENT)}/cancel`,
      { method: "POST" },
    ))
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({
      session: PARENT,
      cancelled: { sessions: 2, requests: 2 },
    })

    await settle()
    expect(calls[0]!.controller!.signal.aborted).toBe(true)
    expect(calls[1]!.controller!.signal.aborted).toBe(true)
    expect((await parentResponse).status).toBe(499)
    expect((await childResponse).status).toBe(499)
  })

  it("reports an idle session as nothing to cancel", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const cancelled = await app.fetch(new Request(
      "http://localhost/v1/sessions/never-seen/cancel",
      { method: "POST" },
    ))
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({
      cancelled: { sessions: 0, requests: 0 },
    })
  })
})
