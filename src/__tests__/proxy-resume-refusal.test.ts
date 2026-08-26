/**
 * A refused resume must not be mistaken for a lost session.
 *
 * The CLI refuses a --resume that lands while the previous subprocess for the
 * same session is still exiting; one of its wordings ("No conversation found
 * with session ID …") reads like the session is gone, although the session is
 * intact and the next attempt succeeds. Treating that as terminal evicts the
 * session and silently replays the whole conversation as a fresh one, throwing
 * away the context the SDK side holds.
 *
 * So the refusal is retried first, and only a session that refuses every
 * attempt is replayed fresh. A refusal that names a lost message inside the
 * session is different — an identical attempt fails identically — and stays
 * one-shot.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setSessionStoreDir } from "../proxy/sessionStore"

let isolatedSessionDir = ""
beforeEach(() => {
  isolatedSessionDir = mkdtempSync(join(tmpdir(), "meridian-http-test-"))
  setSessionStoreDir(isolatedSessionDir)
})
afterEach(async () => {
  // Request completion releases the cross-process lease asynchronously.
  await Bun.sleep(25)
  rmSync(isolatedSessionDir, { recursive: true, force: true })
})
import { messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop, resolveMockSdkSessionId } from "./helpers"

// Linear backoff is real time; the retry path is what is under test, not the wait.
process.env.MERIDIAN_BUSY_RETRY_DELAY_MS = "5"

let queryCalls: Array<Record<string, any>> = []
let queryCallCount = 0
/** How many leading attempts the CLI refuses with the missing-conversation wording. */
let refuseAttempts = 1
/** Refuse instead with a lost message inside the session. */
let missingMessage = false
/** Per-attempt wordings, when the refusal is not the same one every time. */
let refusalScript: Array<"unresumable" | "busy"> = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    queryCallCount++
    const callIndex = queryCallCount
    queryCalls.push(opts.options || {})
    const isStreaming = opts.options?.includePartialMessages === true
    const returnedSessionId = resolveMockSdkSessionId(opts.options)
    const withReturnedSessionId = (message: any) => returnedSessionId
      ? { ...message, session_id: returnedSessionId }
      : message
    return (async function* () {
      // The CLI refuses the resume while the previous subprocess for this
      // session is still exiting. The session itself is intact.
      const scripted = refusalScript[callIndex - 1]
      if (scripted && opts.options?.resume) {
        throw new Error(
          scripted === "busy"
            ? `Error: Session ${opts.options?.resume} is currently running as a background agent (bg). Use \`claude agents\` to find and attach to it, or add --fork-session to branch off a copy.`
            : `No conversation found with session ID: ${opts.options?.resume}`
        )
      }
      if (!scripted && callIndex <= refuseAttempts && opts.options?.resume) {
        throw new Error(
          missingMessage
            ? "No message found with message.uuid of: 6f1c0f4e-0a1e-4d61-9a2f-7b0c1d2e3f40"
            : `No conversation found with session ID: ${opts.options?.resume}`
        )
      }
      if (isStreaming) {
        yield withReturnedSessionId(messageStart(`msg-${callIndex}`))
        yield withReturnedSessionId(textBlockStart(0))
        yield withReturnedSessionId(textDelta(0, `response-${callIndex}`))
        yield withReturnedSessionId(blockStop(0))
        yield withReturnedSessionId(messageDelta("end_turn"))
        yield withReturnedSessionId(messageStop())
      }
      yield {
        type: "assistant",
        uuid: `uuid-${callIndex}`,
        message: {
          id: `msg-${callIndex}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `response-${callIndex}` }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: resolveMockSdkSessionId(opts.options, "sdk-original"),
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { storeSession } = await import("../proxy/session/cache")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

const priorMessages = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi there" },
  { role: "user", content: "do something" },
  { role: "assistant", content: "done" },
]
const continuation = [...priorMessages, { role: "user", content: "and now continue" }]

describe("Resume refusal", () => {
  beforeEach(() => {
    clearSessionCache()
    queryCalls = []
    queryCallCount = 0
    refuseAttempts = 1
    missingMessage = false
    refusalScript = []
  })

  it("retries the same resume instead of evicting the session (non-streaming)", async () => {
    const app = createTestApp()
    const sessionId = "sess-transient-refusal"
    storeSession(sessionId, priorMessages, "sdk-original", "/tmp/test")

    const response = await post(app, { model: "sonnet", stream: false, messages: continuation }, { "x-opencode-session": sessionId })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.content.some((b: any) => b.type === "text")).toBe(true)

    // The first call was the refused resume.
    expect(queryCalls[0]!.resume).toBe("sdk-original")
    // The refusal must be retried with the same session — not answered by a
    // fresh full-history replay that abandons the session.
    expect(queryCalls[1]!.resume).toBe("sdk-original")
  })

  it("retries the same resume instead of evicting the session (streaming)", async () => {
    const app = createTestApp()
    const sessionId = "sess-transient-refusal-stream"
    storeSession(sessionId, priorMessages, "sdk-original", "/tmp/test")

    const response = await post(app, { model: "sonnet", stream: true, messages: continuation }, { "x-opencode-session": sessionId })
    expect(response.status).toBe(200)
    await response.text()

    expect(queryCalls[0]!.resume).toBe("sdk-original")
    expect(queryCalls[1]!.resume).toBe("sdk-original")
  })

  it("falls back to a fresh replay when every resume attempt is refused", async () => {
    const app = createTestApp()
    const sessionId = "sess-gone-for-good"
    refuseAttempts = Number.MAX_SAFE_INTEGER
    storeSession(sessionId, priorMessages, "sdk-original", "/tmp/test")

    const response = await post(app, { model: "sonnet", stream: false, messages: continuation }, { "x-opencode-session": sessionId })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.content.some((b: any) => b.type === "text")).toBe(true)

    // Every attempt that carried a resume was refused, so the session cannot
    // serve this turn and the last attempt must be a fresh full-history query.
    // The resume is attempted once plus every retry, and never beyond that.
    const last = queryCalls[queryCalls.length - 1]!
    expect(last.resume).toBeUndefined()
    expect(queryCalls.filter(c => c.resume === "sdk-original").length).toBe(4)
    expect(queryCalls.length).toBe(5)
  })

  it("replays fresh when the refusal wording changes between attempts", async () => {
    const app = createTestApp()
    const sessionId = "sess-mixed-refusals"
    // The exit window produces either wording, so one request can see both. The
    // spent retry budget must still reach the replay — the alternation cannot
    // hand the client a refusal the same session would have recovered from.
    refusalScript = ["unresumable", "unresumable", "unresumable", "busy", "busy"]
    storeSession(sessionId, priorMessages, "sdk-original", "/tmp/test")

    const response = await post(app, { model: "sonnet", stream: false, messages: continuation }, { "x-opencode-session": sessionId })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.content.some((b: any) => b.type === "text")).toBe(true)

    const last = queryCalls[queryCalls.length - 1]!
    expect(last.resume).toBeUndefined()
  })

  it("does not retry a refusal that names a lost message inside the session", async () => {
    const app = createTestApp()
    const sessionId = "sess-missing-message"
    missingMessage = true
    storeSession(sessionId, priorMessages, "sdk-original", "/tmp/test")

    const response = await post(app, { model: "sonnet", stream: false, messages: continuation }, { "x-opencode-session": sessionId })
    expect(response.status).toBe(200)
    await response.json()

    // The session provably no longer holds a message the resume needs, so the
    // refusal is answered by one fresh replay — not by repeating the attempt.
    expect(queryCalls[0]!.resume).toBe("sdk-original")
    expect(queryCalls.length).toBe(2)
    expect(queryCalls[1]!.resume).toBeUndefined()
  })
})
