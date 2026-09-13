/**
 * Tests for busy-session (bg-agent) resume retry behavior — #630.
 *
 * CLAUDE_CODE_SESSION_KIND=bg (#628 scratchpad suppression) registers every
 * SDK session as a running background agent. A fast follow-up can spawn a
 * --resume while the previous subprocess for that session is still exiting;
 * the CLI then refuses with exit 1 and "Session X is currently running as a
 * background agent (bg)" on stderr. The proxy must wait briefly and retry
 * the SAME resume (the stale process exits within ~a second), and fall back
 * to forkSession if the session stays busy — never surface a deterministic
 * failure the client will blindly re-trigger.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
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
import {
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
  resolveMockSdkSessionId,
} from "./helpers"

// Shrink retry backoff so tests run fast (read at server.ts import time)
process.env.MERIDIAN_BUSY_RETRY_DELAY_MS = "5"

const BUSY_LINE =
  "Error: Session 3cff857d-114e-4be3-8a12-99842ad2326e is currently running as a background agent (bg). Use `claude agents` to find and attach to it, or add --fork-session to branch off a copy."

// Per-test knobs
let queryCalls: Array<Record<string, any>> = []
let queryCallCount = 0
/** Number of leading resume attempts that fail busy (0 = never busy). */
let busyFailCount = 0

installSdkMock(() => ({
  query: (opts: any) => {
    queryCallCount++
    const callIndex = queryCallCount
    queryCalls.push(opts.options || {})
    const isStreaming = opts.options?.includePartialMessages === true

    return (async function* () {
      if (callIndex <= busyFailCount && opts.options?.resume) {
        // Mirror production: bg-agent refusal arrives on stderr, the SDK
        // error itself only carries the exit code.
        opts.options?.stderr?.(BUSY_LINE)
        throw new Error("Claude Code process exited with code 1")
      }
      const returnedSessionId = resolveMockSdkSessionId(opts.options, `sdk-after-${callIndex}`)
      if (isStreaming) {
        yield { ...messageStart(`msg-${callIndex}`), session_id: returnedSessionId }
        yield { ...textBlockStart(0), session_id: returnedSessionId }
        yield { ...textDelta(0, `response-${callIndex}`), session_id: returnedSessionId }
        yield { ...blockStop(0), session_id: returnedSessionId }
        yield { ...messageDelta("end_turn"), session_id: returnedSessionId }
        yield { ...messageStop(), session_id: returnedSessionId }
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
        session_id: returnedSessionId,
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-busy-session-retry.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { storeSession } = await import("../proxy/session/cache")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  )
}

const priorMessages = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi there" },
]

function seed(sessionId: string) {
  storeSession(sessionId, priorMessages, "sdk-original", "/tmp/test", [null, "uuid-1"])
}

function continuation() {
  return [...priorMessages, { role: "user", content: "follow up" }]
}

describe("Busy-session resume retry (#630)", () => {
  beforeEach(() => {
    clearSessionCache()
    queryCalls = []
    queryCallCount = 0
    busyFailCount = 0
  })

  it("retries the same resume after a transient busy refusal (non-streaming)", async () => {
    const app = createTestApp()
    seed("sess-busy-1")
    busyFailCount = 1

    const response = await post(
      app,
      { model: "sonnet", stream: false, messages: continuation() },
      { "x-opencode-session": "sess-busy-1" }
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.content.some((b: any) => b.type === "text")).toBe(true)

    // Attempt 1 and the retry use the same preallocated isolated fork.
    expect(queryCalls.length).toBe(2)
    expect(queryCalls[0]!.resume).toBe("sdk-original")
    expect(queryCalls[1]!.resume).toBe("sdk-original")
    expect(queryCalls[0]!.forkSession).toBe(true)
    expect(queryCalls[1]!.forkSession).toBe(true)
    expect(queryCalls[1]!.sessionId).not.toBe(queryCalls[0]!.sessionId)
  })

  it("falls back to forkSession when the session stays busy (non-streaming)", async () => {
    const app = createTestApp()
    seed("sess-busy-2")
    // Every resume is already isolated; retries retain one preallocated fork.
    busyFailCount = 4

    const response = await post(
      app,
      { model: "sonnet", stream: false, messages: continuation() },
      { "x-opencode-session": "sess-busy-2" }
    )

    expect(response.status).toBe(200)
    expect(queryCalls.length).toBe(5)
    for (let i = 0; i < 4; i++) {
      expect(queryCalls[i]!.resume).toBe("sdk-original")
      expect(queryCalls[i]!.forkSession).toBe(true)
    }
    expect(new Set(queryCalls.map((call) => call.sessionId)).size).toBe(5)
    expect(queryCalls[4]!.resume).toBe("sdk-original")
    expect(queryCalls[4]!.forkSession).toBe(true)
  })

  it("retries the same resume after a transient busy refusal (streaming)", async () => {
    const app = createTestApp()
    seed("sess-busy-3")
    busyFailCount = 1

    const response = await post(
      app,
      { model: "sonnet", stream: true, messages: continuation() },
      { "x-opencode-session": "sess-busy-3" }
    )

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("event: message_start")
    expect(text).not.toContain("process exited with code 1")

    expect(queryCalls.length).toBe(2)
    expect(queryCalls[0]!.resume).toBe("sdk-original")
    expect(queryCalls[1]!.resume).toBe("sdk-original")
    expect(queryCalls[0]!.forkSession).toBe(true)
    expect(queryCalls[1]!.forkSession).toBe(true)
    expect(queryCalls[1]!.sessionId).not.toBe(queryCalls[0]!.sessionId)
  })

  it("falls back to forkSession when the session stays busy (streaming)", async () => {
    const app = createTestApp()
    seed("sess-busy-4")
    busyFailCount = 4

    const response = await post(
      app,
      { model: "sonnet", stream: true, messages: continuation() },
      { "x-opencode-session": "sess-busy-4" }
    )

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("event: message_start")

    expect(queryCalls.length).toBe(5)
    expect(queryCalls[4]!.resume).toBe("sdk-original")
    expect(queryCalls[4]!.forkSession).toBe(true)
  })

  it("does not retry busy-shaped failures on fresh (non-resume) requests", async () => {
    const app = createTestApp()
    // No seeded session: first call has no resume, so the mock succeeds —
    // but force the stderr line anyway via a resume-less busy simulation
    // by seeding busyFailCount without a resume (mock only throws on resume,
    // so this asserts the fresh path never even enters the retry loop).
    busyFailCount = 99

    const response = await post(app, {
      model: "sonnet",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    })

    expect(response.status).toBe(200)
    expect(queryCalls.length).toBe(1)
    expect(queryCalls[0]!.resume).toBeUndefined()
  })
})
