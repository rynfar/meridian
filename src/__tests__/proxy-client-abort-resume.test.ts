/**
 * MERIDIAN_KEEP_SESSION_ON_CLIENT_ABORT keeps the resumable session of a client
 * that disconnects mid-stream.
 *
 * Every resume writes an isolated fork, so the mapped transcript still ends at
 * the last completed turn. Evicting it forces the next message into a full
 * replay, which misses the prompt cache for the whole conversation.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import {
  messageStart,
  resolveMockSdkSessionId,
  textBlockStart,
  textDelta,
  withMockSdkSessionId,
} from "./helpers"

type Behavior = "complete" | "partial-then-hang"

interface SdkCall {
  readonly prompt: unknown
  readonly resume: string | undefined
  readonly sessionId: string | undefined
}

let behaviors: Behavior[] = []
let calls: SdkCall[] = []

installSdkMock(() => ({
  query: (params: { prompt: unknown; options?: { abortController?: AbortController; resume?: string; sessionId?: string } }) => {
    const behavior = behaviors.shift() ?? "complete"
    const options = params.options
    calls.push({ prompt: params.prompt, resume: options?.resume, sessionId: options?.sessionId })
    return (async function* () {
      if (behavior === "partial-then-hang") {
        yield withMockSdkSessionId(messageStart("msg_partial"), options)
        yield withMockSdkSessionId(textBlockStart(0), options)
        yield withMockSdkSessionId(textDelta(0, "partial answer"), options)
        await new Promise<void>((_resolve, reject) => {
          const signal = options?.abortController?.signal
          if (!signal) return reject(new Error("missing SDK abort controller"))
          if (signal.aborted) return reject(new Error("SDK query aborted"))
          signal.addEventListener("abort", () => reject(new Error("SDK query aborted")), { once: true })
        })
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

type Message = { role: string; content: unknown }

function messagesRequest(sessionKey: string, messages: Message[], stream: boolean, signal?: AbortSignal): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-meridian-agent": "prime", "x-session-affinity": sessionKey },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream, messages }),
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

/** Read until the partial answer reached the client, so the abort follows exposure. */
async function readUntilPartialAnswer(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let seen = ""
  while (!seen.includes("partial answer")) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`stream ended before the partial answer: ${seen}`)
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

describe.each([
  ["/v1/messages", messagesRequest],
  ["/v1/responses", responsesRequest],
] as const)("client abort on %s", (_route, request) => {
  const app = () => createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app

  beforeEach(async () => {
    process.env.MERIDIAN_PASSTHROUGH = "1"
    process.env.MERIDIAN_KEEP_SESSION_ON_CLIENT_ABORT = "1"
    behaviors = []
    calls = []
    await clearSessionCache()
  })

  afterEach(() => {
    delete process.env.MERIDIAN_KEEP_SESSION_ON_CLIENT_ABORT
  })

  async function completeFirstTurn(proxy: ReturnType<typeof app>, key: string): Promise<void> {
    const response = await proxy.fetch(request(key, FIRST_TURN.slice(0, 1), false))
    expect(response.status).toBe(200)
    await response.json()
    expect(calls[0]!.sessionId).toBeDefined()
  }

  it("resumes the last completed turn when the client discards the partial output", async () => {
    const proxy = app()
    const key = `abort-discard-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)

    behaviors = ["partial-then-hang"]
    const abort = new AbortController()
    const interrupted = await proxy.fetch(request(key, [...FIRST_TURN, NEXT_USER], true, abort.signal))
    const reader = await readUntilPartialAnswer(interrupted)
    expect(calls[1]!.resume).toBe(calls[0]!.sessionId)
    abort.abort("user pressed stop")
    await reader.cancel().catch(() => {})
    await settle()

    const after = await proxy.fetch(request(key, [...FIRST_TURN, NEXT_USER, { role: "user", content: "third question" }], false))
    expect(after.status).toBe(200)
    await after.json()

    expect(calls[2]!.resume).toBe(calls[0]!.sessionId)
    const prompt = JSON.stringify(calls[2]!.prompt)
    expect(prompt).toContain("second question")
    expect(prompt).toContain("third question")
    expect(prompt).not.toContain("first question")
  })

  it("resumes when only the response body is cancelled", async () => {
    const proxy = app()
    const key = `abort-body-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)

    behaviors = ["partial-then-hang"]
    const interrupted = await proxy.fetch(request(key, [...FIRST_TURN, NEXT_USER], true))
    const reader = await readUntilPartialAnswer(interrupted)
    await reader.cancel("user pressed stop")
    await settle()

    const after = await proxy.fetch(request(key, [...FIRST_TURN, NEXT_USER], false))
    expect(after.status).toBe(200)
    await after.json()

    expect(calls[2]!.resume).toBe(calls[0]!.sessionId)
  })

  it("resumes with the user's side only when the client kept the partial output", async () => {
    const proxy = app()
    const key = `abort-keep-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)

    behaviors = ["partial-then-hang"]
    const abort = new AbortController()
    const interrupted = await proxy.fetch(request(key, [...FIRST_TURN, NEXT_USER], true, abort.signal))
    const reader = await readUntilPartialAnswer(interrupted)
    abort.abort("user pressed stop")
    await reader.cancel().catch(() => {})
    await settle()

    const after = await proxy.fetch(request(key, [
      ...FIRST_TURN,
      NEXT_USER,
      { role: "assistant", content: [{ type: "text", text: "partial answer" }] },
      { role: "user", content: "third question" },
    ], false))
    expect(after.status).toBe(200)
    await after.json()

    expect(calls[2]!.resume).toBe(calls[0]!.sessionId)
    const prompt = JSON.stringify(calls[2]!.prompt)
    expect(prompt).toContain("second question")
    expect(prompt).toContain("third question")
    expect(prompt).not.toContain("partial answer")
  })

  it("replays by default, because the switch is off", async () => {
    delete process.env.MERIDIAN_KEEP_SESSION_ON_CLIENT_ABORT
    const proxy = app()
    const key = `abort-default-${crypto.randomUUID()}`
    await completeFirstTurn(proxy, key)

    behaviors = ["partial-then-hang"]
    const abort = new AbortController()
    const interrupted = await proxy.fetch(request(key, [...FIRST_TURN, NEXT_USER], true, abort.signal))
    const reader = await readUntilPartialAnswer(interrupted)
    abort.abort("user pressed stop")
    await reader.cancel().catch(() => {})
    await settle()

    const after = await proxy.fetch(request(key, [...FIRST_TURN, NEXT_USER, { role: "user", content: "third question" }], false))
    expect(after.status).toBe(200)
    await after.json()

    expect(calls[2]!.resume).toBeUndefined()
  })
})
