/**
 * A client that stops a streaming turn after output reached it: the next
 * request resumes the kept session only when it adds nothing but user content.
 *
 * Every resume writes an isolated fork, so the mapped transcript still ends at
 * the last completed turn. A client that discards the partial output (Pi,
 * Prime Agent) can resume it with the prompt cache; one that keeps it
 * (OpenCode, Oh My Pi) would resume without the model seeing that output, so
 * its next request replays. See the session spec, *Interrupted turns*.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPriorityAttestation } from "../../plugin/priority-attestation"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import {
  inputJsonDelta,
  messageStart,
  resolveMockSdkSessionId,
  textBlockStart,
  textDelta,
  toolUseBlockStart,
  withMockSdkSessionId,
} from "./helpers"

type Behavior =
  | "complete"
  | "partial-then-hang"
  | "tool-call-then-hang"
  | "hang"
  /** The CLI cannot resume the session: Meridian evicts it and replays fresh. */
  | "refuse-resume"

interface SdkCall {
  readonly prompt: unknown
  readonly resume: string | undefined
  readonly sessionId: string | undefined
}

let behaviors: Behavior[] = []
let calls: SdkCall[] = []

function untilAborted(options: { abortController?: AbortController } | undefined): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    const signal = options?.abortController?.signal
    if (!signal) return reject(new Error("missing SDK abort controller"))
    if (signal.aborted) return reject(new Error("SDK query aborted"))
    signal.addEventListener("abort", () => reject(new Error("SDK query aborted")), { once: true })
  })
}

installSdkMock(() => ({
  query: (params: { prompt: unknown; options?: { abortController?: AbortController; resume?: string; sessionId?: string } }) => {
    const behavior = behaviors.shift() ?? "complete"
    const options = params.options
    calls.push({ prompt: params.prompt, resume: options?.resume, sessionId: options?.sessionId })
    return (async function* () {
      if (behavior === "refuse-resume") throw new Error("No message found with message.uuid of: mock-missing")
      if (behavior === "hang") {
        await untilAborted(options)
        return
      }
      if (behavior === "partial-then-hang" || behavior === "tool-call-then-hang") {
        yield withMockSdkSessionId(messageStart("msg_partial"), options)
        if (behavior === "partial-then-hang") {
          yield withMockSdkSessionId(textBlockStart(0), options)
          yield withMockSdkSessionId(textDelta(0, "partial answer"), options)
        } else {
          yield withMockSdkSessionId(toolUseBlockStart(0, "mcp__oc__read", "toolu_interrupted"), options)
          yield withMockSdkSessionId(inputJsonDelta(0, "{\"file_path\":"), options)
        }
        await untilAborted(options)
        return
      }
      yield {
        type: "assistant",
        message: {
          id: "msg_complete",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null,
        uuid: crypto.randomUUID(),
        session_id: resolveMockSdkSessionId(options, crypto.randomUUID()),
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "proxy-client-abort-resume.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { forgetInterruptedTurnsForTests } = await import("../proxy/session/cache")
const { resetActiveProfile } = await import("../proxy/profiles")
const { __setFetchOAuthUsageOverride } = await import("../proxy/oauthUsage")
const { rateLimitStore } = await import("../proxy/rateLimitStore")

type Message = { role: string; content: unknown }

const READ_TOOL = {
  name: "read",
  description: "Read a file",
  input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
}

function messagesRequest(
  sessionKey: string,
  messages: Message[],
  stream: boolean,
  signal?: AbortSignal,
  tools?: unknown[],
): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-meridian-agent": "prime", "x-session-affinity": sessionKey },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream, messages, ...(tools ? { tools } : {}) }),
    signal,
  })
}

function responsesRequest(sessionKey: string, messages: Message[], stream: boolean, signal?: AbortSignal): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-affinity": sessionKey },
    body: JSON.stringify({ model: "claude-sonnet-4-6", stream, input: messages }),
    signal,
  })
}

/** Read until `needle` reached the client, so the abort follows exposure. */
async function readUntil(response: Response, needle = "partial answer") {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let seen = ""
  while (!seen.includes(needle)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`stream ended before ${needle}: ${seen}`)
    seen += decoder.decode(value, { stream: true })
  }
  return reader
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1))
}

const FIRST_TURN: Message[] = [
  { role: "user", content: "first question" },
  { role: "assistant", content: [{ type: "text", text: "ok" }] },
]
const NEXT_USER: Message = { role: "user", content: "second question" }
const THIRD_USER: Message = { role: "user", content: "third question" }
const KEPT_PARTIAL: Message = { role: "assistant", content: [{ type: "text", text: "partial answer" }] }

const app = () => createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
type Proxy = ReturnType<typeof app>

let originalPassthrough: string | undefined

beforeEach(async () => {
  originalPassthrough = process.env.MERIDIAN_PASSTHROUGH
  process.env.MERIDIAN_PASSTHROUGH = "1"
  behaviors = []
  calls = []
  await clearSessionCache()
})

afterEach(() => {
  if (originalPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
  else process.env.MERIDIAN_PASSTHROUGH = originalPassthrough
})

describe.each([
  ["/v1/messages", messagesRequest],
  ["/v1/responses", responsesRequest],
] as const)("client stop on %s", (_route, request) => {
  async function completeFirstTurn(proxy: Proxy, key: string): Promise<void> {
    const response = await proxy.fetch(request(key, FIRST_TURN.slice(0, 1), false))
    expect(response.status).toBe(200)
    await response.json()
    expect(calls[0]!.sessionId).toBeDefined()
  }

  async function stopSecondTurn(proxy: Proxy, key: string): Promise<void> {
    behaviors = ["partial-then-hang"]
    const abort = new AbortController()
    const interrupted = await proxy.fetch(request(key, [...FIRST_TURN, NEXT_USER], true, abort.signal))
    const reader = await readUntil(interrupted)
    expect(calls[1]!.resume).toBe(calls[0]!.sessionId)
    abort.abort("user pressed stop")
    await reader.cancel().catch(() => {})
    await settle()
  }

  it("resumes the kept session when the client discarded the partial output", async () => {
    const proxy = app()
    const key = `stop-discard-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)
    await stopSecondTurn(proxy, key)

    const after = await proxy.fetch(request(key, [...FIRST_TURN, NEXT_USER, THIRD_USER], false))
    expect(after.status).toBe(200)
    await after.json()

    expect(calls[2]!.resume).toBe(calls[0]!.sessionId)
    const prompt = JSON.stringify(calls[2]!.prompt)
    expect(prompt).toContain("second question")
    expect(prompt).toContain("third question")
    expect(prompt).not.toContain("first question")
  })

  it("replays, carrying the partial, when the client kept the partial output", async () => {
    const proxy = app()
    const key = `stop-keep-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)
    await stopSecondTurn(proxy, key)

    const after = await proxy.fetch(request(key, [...FIRST_TURN, NEXT_USER, KEPT_PARTIAL, THIRD_USER], false))
    expect(after.status).toBe(200)
    await after.json()

    expect(calls[2]!.resume).toBeUndefined()
    const prompt = JSON.stringify(calls[2]!.prompt)
    expect(prompt).toContain("<conversation_history>")
    expect(prompt).toContain("first question")
    expect(prompt).toContain("partial answer")
    expect(prompt).toContain("third question")
  })

  it("resumes a retry of the stopped request after only the response body was cancelled", async () => {
    const proxy = app()
    const key = `stop-body-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)

    behaviors = ["partial-then-hang"]
    const interrupted = await proxy.fetch(request(key, [...FIRST_TURN, NEXT_USER], true))
    const reader = await readUntil(interrupted)
    await reader.cancel("user pressed stop")
    await settle()

    const after = await proxy.fetch(request(key, [...FIRST_TURN, NEXT_USER], false))
    expect(after.status).toBe(200)
    await after.json()

    expect(calls[2]!.resume).toBe(calls[0]!.sessionId)
  })
})

describe("client stop on /v1/messages", () => {
  async function completeFirstTurn(proxy: Proxy, key: string): Promise<void> {
    const response = await proxy.fetch(messagesRequest(key, FIRST_TURN.slice(0, 1), false, undefined, [READ_TOOL]))
    expect(response.status).toBe(200)
    await response.json()
    expect(calls[0]!.sessionId).toBeDefined()
  }

  async function stopSecondTurn(proxy: Proxy, key: string): Promise<void> {
    behaviors = ["partial-then-hang"]
    const abort = new AbortController()
    const interrupted = await proxy.fetch(messagesRequest(key, [...FIRST_TURN, NEXT_USER], true, abort.signal, [READ_TOOL]))
    const reader = await readUntil(interrupted)
    abort.abort("user pressed stop")
    await reader.cancel().catch(() => {})
    await settle()
  }

  const next = (key: string, messages: Message[], signal?: AbortSignal) =>
    messagesRequest(key, messages, false, signal, [READ_TOOL])

  it("replays after a turn that already streamed a tool call", async () => {
    const proxy = app()
    const key = `stop-tool-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)

    behaviors = ["tool-call-then-hang"]
    const abort = new AbortController()
    const interrupted = await proxy.fetch(messagesRequest(key, [...FIRST_TURN, NEXT_USER], true, abort.signal, [READ_TOOL]))
    const reader = await readUntil(interrupted, "toolu_interrupted")
    abort.abort("user pressed stop")
    await reader.cancel().catch(() => {})
    await settle()

    const after = await proxy.fetch(next(key, [...FIRST_TURN, NEXT_USER, THIRD_USER]))
    expect(after.status).toBe(200)
    await after.json()

    expect(calls[2]!.resume).toBeUndefined()
    expect(JSON.stringify(calls[2]!.prompt)).toContain("first question")
  })

  it("replays after POST /v1/sessions/:key/cancel", async () => {
    const proxy = app()
    const key = `stop-cancel-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)

    behaviors = ["partial-then-hang"]
    const interrupted = await proxy.fetch(messagesRequest(key, [...FIRST_TURN, NEXT_USER], true, undefined, [READ_TOOL]))
    const reader = await readUntil(interrupted)
    const cancel = await proxy.fetch(new Request(`http://localhost/v1/sessions/${encodeURIComponent(key)}/cancel`, { method: "POST" }))
    const cancelled = await cancel.json() as { cancelled: { requests: number } }
    expect(cancelled.cancelled.requests).toBe(1)
    // Drain rather than cancel the body, so only the explicit cancel aborts.
    while (!(await reader.read()).done) { /* drain */ }
    await settle()

    const after = await proxy.fetch(next(key, [...FIRST_TURN, NEXT_USER, THIRD_USER]))
    expect(after.status).toBe(200)
    await after.json()

    expect(calls[2]!.resume).toBeUndefined()
  })

  it("replays when a restart lost the interrupted-turn record", async () => {
    const proxy = app()
    const key = `stop-restart-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)
    await stopSecondTurn(proxy, key)
    forgetInterruptedTurnsForTests()

    // A proxy that logs its request lines, which name why the turn replays.
    const logged = spyOn(console, "error")
    let requestLine: string | undefined
    try {
      const restarted = createProxyServer({ port: 0, host: "127.0.0.1" }).app
      const after = await restarted.fetch(next(key, [...FIRST_TURN, NEXT_USER, THIRD_USER]))
      expect(after.status).toBe(200)
      await after.json()
      requestLine = logged.mock.calls.map((call) => String(call[0]))
        .filter((line) => line.includes("[PROXY]") && line.includes("adapter=") && line.includes("msgCount="))
        .at(-1)
    } finally {
      logged.mockRestore()
    }

    expect(calls[2]!.resume).toBeUndefined()
    expect(JSON.stringify(calls[2]!.prompt)).toContain("<conversation_history>")
    expect(requestLine).toContain("lineage=continuation session=new replay=unproved-sdk-prefix")
  })

  it("resumes normally once the interrupted turn is decided", async () => {
    const proxy = app()
    const key = `stop-then-turn-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)
    await stopSecondTurn(proxy, key)

    const third = await proxy.fetch(next(key, [...FIRST_TURN, NEXT_USER, THIRD_USER]))
    expect(third.status).toBe(200)
    const thirdBody = await third.json() as { content: unknown }
    const fourth = await proxy.fetch(next(key, [
      ...FIRST_TURN, NEXT_USER, THIRD_USER,
      { role: "assistant", content: thirdBody.content },
      { role: "user", content: "fourth question" },
    ]))
    expect(fourth.status).toBe(200)
    await fourth.json()

    expect(calls[2]!.resume).toBe(calls[0]!.sessionId)
    expect(calls[3]!.resume).toBe(calls[2]!.sessionId)
  })

  it.each([
    ["discarded", [...FIRST_TURN, NEXT_USER, THIRD_USER], true],
    ["kept", [...FIRST_TURN, NEXT_USER, KEPT_PARTIAL, THIRD_USER], false],
  ] as const)("decides a reconnect that waited out the stopped turn's cleanup (partial %s)", async (_shape, history, resumes) => {
    const proxy = app()
    const key = `stop-race-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)

    behaviors = ["partial-then-hang"]
    const abort = new AbortController()
    const interrupted = await proxy.fetch(messagesRequest(key, [...FIRST_TURN, NEXT_USER], true, abort.signal, [READ_TOOL]))
    const reader = await readUntil(interrupted)
    // Arrives while the stopped turn still holds the session: it reads the
    // mapping only after that turn's cleanup marked it.
    const reconnect = Promise.resolve(proxy.fetch(next(key, [...history])))
    await settle()
    abort.abort("user pressed stop")
    await reader.cancel().catch(() => {})

    const after = await reconnect
    expect(after.status).toBe(200)
    await after.json()

    expect(calls).toHaveLength(3)
    expect(calls[2]!.resume).toBe(resumes ? calls[0]!.sessionId : undefined)
    if (!resumes) expect(JSON.stringify(calls[2]!.prompt)).toContain("partial answer")
  })

  it("lets only one of two parallel requests decide the interrupted turn", async () => {
    const proxy = app()
    const key = `stop-parallel-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)
    await stopSecondTurn(proxy, key)

    const responses = await Promise.all([
      proxy.fetch(next(key, [...FIRST_TURN, NEXT_USER, THIRD_USER])),
      proxy.fetch(next(key, [...FIRST_TURN, NEXT_USER, { role: "user", content: "another third question" }])),
    ])
    await Promise.all(responses.map((response) => response.text()))

    const resumedSource = calls.slice(2).filter((call) => call.resume === calls[0]!.sessionId)
    expect(resumedSource).toHaveLength(1)
    expect(responses.some((response) => response.status === 200)).toBe(true)
  })

  it("replays after a turn that retried onto a fresh session before it was stopped", async () => {
    const proxy = app()
    const key = `stop-fresh-retry-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)

    // The CLI refuses the resume, so the turn evicts the session and replays
    // into a fresh one, whose output the client then stops.
    behaviors = ["refuse-resume", "partial-then-hang"]
    const abort = new AbortController()
    const interrupted = await proxy.fetch(messagesRequest(key, [...FIRST_TURN, NEXT_USER], true, abort.signal, [READ_TOOL]))
    const reader = await readUntil(interrupted)
    expect(calls[1]!.resume).toBe(calls[0]!.sessionId)
    expect(calls[2]!.resume).toBeUndefined()
    abort.abort("user pressed stop")
    await reader.cancel().catch(() => {})
    await settle()

    const after = await proxy.fetch(next(key, [...FIRST_TURN, NEXT_USER, THIRD_USER]))
    expect(after.status).toBe(200)
    await after.json()

    expect(calls[3]!.resume).toBeUndefined()
    expect(JSON.stringify(calls[3]!.prompt)).toContain("first question")
  })

  it("replays after a stopped non-stream turn, as before", async () => {
    const proxy = app()
    const key = `stop-nonstream-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)

    behaviors = ["hang"]
    const abort = new AbortController()
    const pending = Promise.resolve(proxy.fetch(next(key, [...FIRST_TURN, NEXT_USER], abort.signal)))
    for (let i = 0; i < 200 && calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(calls).toHaveLength(2)
    abort.abort("user pressed stop")
    await pending.then((response) => response.text()).catch(() => {})
    await settle()

    const after = await proxy.fetch(next(key, [...FIRST_TURN, NEXT_USER, THIRD_USER]))
    expect(after.status).toBe(200)
    await after.json()

    expect(calls[2]!.resume).toBeUndefined()
  })
})

describe("client stop, more paths", () => {
  const strict = (key: string, messages: Message[], stream: boolean, signal?: AbortSignal) =>
    messagesRequest(key, messages, stream, signal, [READ_TOOL])

  async function completeFirstTurn(proxy: Proxy, request: (messages: Message[], stream: boolean, signal?: AbortSignal) => Request) {
    const response = await proxy.fetch(request(FIRST_TURN.slice(0, 1), false))
    expect(response.status).toBe(200)
    await response.json()
    expect(calls[0]!.sessionId).toBeDefined()
  }

  async function stopTurn(proxy: Proxy, request: (messages: Message[], stream: boolean, signal?: AbortSignal) => Request, history: Message[]) {
    behaviors.push("partial-then-hang")
    const abort = new AbortController()
    const interrupted = await proxy.fetch(request(history, true, abort.signal))
    const reader = await readUntil(interrupted)
    abort.abort("user pressed stop")
    await reader.cancel().catch(() => {})
    await settle()
  }

  it("keeps consecutive stopped turns on the same session", async () => {
    const proxy = app()
    const key = `stop-twice-${crypto.randomUUID()}`
    const request = (messages: Message[], stream: boolean, signal?: AbortSignal) => strict(key, messages, stream, signal)
    await completeFirstTurn(proxy, request)
    await stopTurn(proxy, request, [...FIRST_TURN, NEXT_USER])
    // The retry resumes the kept session, and is stopped too.
    await stopTurn(proxy, request, [...FIRST_TURN, NEXT_USER, THIRD_USER])
    expect(calls[2]!.resume).toBe(calls[0]!.sessionId)

    const after = await proxy.fetch(request([...FIRST_TURN, NEXT_USER, THIRD_USER, { role: "user", content: "fourth question" }], false))
    expect(after.status).toBe(200)
    await after.json()
    expect(calls[3]!.resume).toBe(calls[0]!.sessionId)
  })

  it("does not let a side request sharing the key take the stopped turn's record", async () => {
    const proxy = app()
    const key = `stop-side-${crypto.randomUUID()}`
    const claudeCode = (messages: Message[], stream: boolean, signal?: AbortSignal, auxiliary = false) =>
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json", "x-meridian-agent": "claude-code",
          ...(auxiliary ? { "x-claude-code-request-class": "auxiliary" } : {}),
        },
        // Claude Code keys a conversation by its metadata session id.
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream, messages,
          metadata: { user_id: JSON.stringify({ session_id: key }) } }),
        signal,
      })
    await completeFirstTurn(proxy, claudeCode)
    await stopTurn(proxy, claudeCode, [...FIRST_TURN, NEXT_USER])

    const side = await proxy.fetch(claudeCode([{ role: "user", content: "summarize the session title" }], false, undefined, true))
    expect(side.status).toBe(200)
    await side.json()

    const after = await proxy.fetch(claudeCode([...FIRST_TURN, NEXT_USER, THIRD_USER], false))
    expect(after.status).toBe(200)
    await after.json()
    expect(calls.at(-1)!.resume).toBe(calls[0]!.sessionId)
  })

  it.each([
    ["discarded", [...FIRST_TURN, NEXT_USER, THIRD_USER], true],
    ["kept", [...FIRST_TURN, NEXT_USER, KEPT_PARTIAL, THIRD_USER], false],
  ] as const)("decides a headerless conversation by its fingerprint (partial %s)", async (_shape, history, resumes) => {
    const proxy = app()
    const opening: Message = { role: "user", content: `fingerprinted ${crypto.randomUUID()}` }
    const headerless = (messages: Message[], stream: boolean, signal?: AbortSignal) =>
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-meridian-agent": "prime" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream, messages: [opening, ...messages.slice(1)] }),
        signal,
      })
    await completeFirstTurn(proxy, headerless)
    await stopTurn(proxy, headerless, [...FIRST_TURN, NEXT_USER])

    const after = await proxy.fetch(headerless([...history], false))
    expect(after.status).toBe(200)
    await after.json()
    expect(calls[2]!.resume).toBe(resumes ? calls[0]!.sessionId : undefined)
    if (!resumes) expect(JSON.stringify(calls[2]!.prompt)).toContain("partial answer")
  })
})

describe("stops Meridian decides on still replay", () => {
  const strict = (key: string, messages: Message[], stream: boolean, signal?: AbortSignal) =>
    messagesRequest(key, messages, stream, signal, [READ_TOOL])
  let savedHold: string | undefined

  beforeEach(() => { savedHold = process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS })
  afterEach(() => {
    if (savedHold === undefined) delete process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS
    else process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS = savedHold
  })

  async function exposeSecondTurn(proxy: Proxy, key: string) {
    const first = await proxy.fetch(strict(key, FIRST_TURN.slice(0, 1), false))
    expect(first.status).toBe(200)
    await first.json()
    behaviors.push("partial-then-hang")
    const interrupted = await proxy.fetch(strict(key, [...FIRST_TURN, NEXT_USER], true))
    return readUntil(interrupted)
  }

  it("after the session-turn watchdog", async () => {
    process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS = "300"
    const proxy = app()
    const key = `stop-watchdog-${crypto.randomUUID()}`
    const reader = await exposeSecondTurn(proxy, key)
    while (!(await reader.read()).done) { /* the watchdog ends the stream */ }
    await settle()

    const after = await proxy.fetch(strict(key, [...FIRST_TURN, NEXT_USER, THIRD_USER], false))
    expect(after.status).toBe(200)
    await after.json()
    expect(calls[2]!.resume).toBeUndefined()
  })

  it("after a forced shutdown that lands right after the client's own stop", async () => {
    const server = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const key = `stop-then-shutdown-${crypto.randomUUID()}`
    const first = await server.app.fetch(strict(key, FIRST_TURN.slice(0, 1), false))
    expect(first.status).toBe(200)
    await first.json()
    behaviors.push("partial-then-hang")
    const abort = new AbortController()
    const interrupted = await server.app.fetch(strict(key, [...FIRST_TURN, NEXT_USER], true, abort.signal))
    const reader = await readUntil(interrupted)
    // The client's stop is the first cause, but shutdown revokes durable
    // writes before the turn settles: cleanup stays destructive.
    abort.abort("user pressed stop")
    server.forceAbortInFlight?.()
    while (!(await reader.read()).done) { /* the turn ends */ }
    await settle()

    const next = app()
    const after = await next.fetch(strict(key, [...FIRST_TURN, NEXT_USER, THIRD_USER], false))
    expect(after.status).toBe(200)
    await after.json()
    expect(calls[2]!.resume).toBeUndefined()
  })

  it("after a forced shutdown", async () => {
    const server = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const key = `stop-shutdown-${crypto.randomUUID()}`
    const reader = await exposeSecondTurn(server.app, key)
    server.forceAbortInFlight?.()
    while (!(await reader.read()).done) { /* shutdown ends the stream */ }
    await settle()

    // The next process finds the mapping evicted, not kept for a check.
    const next = app()
    const after = await next.fetch(strict(key, [...FIRST_TURN, NEXT_USER, THIRD_USER], false))
    expect(after.status).toBe(200)
    await after.json()
    expect(calls[2]!.resume).toBeUndefined()
  })
})

describe("a stopped turn routed by priority", () => {
  // A priority publication keeps its own abort handling: the routed mapping
  // stays exactly as the durable route recorded it (session spec, *Interrupted
  // turns*), so the conversation's next turn still goes through the route.
  const ATTESTATION_KEY = Buffer.alloc(32, 0x5a)
  const ENV = ["MERIDIAN_ROUTING", "MERIDIAN_PROFILE_ORDER", "MERIDIAN_PRIORITY_FAILBACK", "MERIDIAN_OPENCODE_ATTESTATION_KEY", "CLAUDE_CONFIG_DIR"]
  const saved: Record<string, string | undefined> = {}
  let root = ""

  beforeEach(() => {
    for (const name of ENV) saved[name] = process.env[name]
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
    process.env.MERIDIAN_PRIORITY_FAILBACK = "new-conversation"
    process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = ATTESTATION_KEY.toString("base64url")
    delete process.env.CLAUDE_CONFIG_DIR
    root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-stop-priority-")))
    resetActiveProfile()
    rateLimitStore.clear()
    __setFetchOAuthUsageOverride(async () => null)
  })

  afterEach(() => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    __setFetchOAuthUsageOverride(null)
    rateLimitStore.clear()
    resetActiveProfile()
    rmSync(root, { recursive: true, force: true })
  })

  /** A human turn of an OpenCode session, signed as its Meridian plugin signs it. */
  function openCodeTurn(session: string, humanMessageId: string, issuedAt: number, messages: Message[], stream: boolean, signal?: AbortSignal): Request {
    const token = createPriorityAttestation({ generation: "oc1", sessionId: session, agentId: "build", humanMessageId, issuedAt }, ATTESTATION_KEY)
    if (!token) throw new Error("test attestation failed")
    return new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-session": session,
        "x-opencode-request": humanMessageId,
        "x-opencode-agent-name": "build",
        "x-opencode-agent-mode": "primary",
        "x-meridian-opencode-turn": token,
      },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream, messages }),
      signal,
    })
  }

  it("resumes a discarding client's next turn through the durable route", async () => {
    const profiles = ["work", "personal"].map((id) => ({ id, claudeConfigDir: join(root, id) }))
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles, defaultProfile: "work" }).app
    const session = `stop-priority-${crypto.randomUUID()}`
    const issuedAt = Math.floor(Date.now() / 1000)
    const first = await proxy.fetch(openCodeTurn(session, "human-1", issuedAt, FIRST_TURN.slice(0, 1), false))
    expect(first.status).toBe(200)
    await first.json()

    behaviors = ["partial-then-hang"]
    const abort = new AbortController()
    const interrupted = await proxy.fetch(openCodeTurn(session, "human-2", issuedAt + 1, [...FIRST_TURN, NEXT_USER], true, abort.signal))
    const reader = await readUntil(interrupted)
    expect(calls[1]!.resume).toBe(calls[0]!.sessionId)
    abort.abort("user pressed stop")
    await reader.cancel().catch(() => {})
    await settle()

    const after = await proxy.fetch(openCodeTurn(session, "human-3", issuedAt + 2, [...FIRST_TURN, NEXT_USER, THIRD_USER], false))
    expect(after.status).toBe(200)
    await after.json()
    expect(calls[2]!.resume).toBe(calls[0]!.sessionId)
  })
})
