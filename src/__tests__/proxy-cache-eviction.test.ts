import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

const originalMaxSessions = process.env.CLAUDE_PROXY_MAX_SESSIONS
process.env.CLAUDE_PROXY_MAX_SESSIONS = "2"

type MockSdkMessage = Record<string, unknown>
type TestApp = { fetch: (req: Request) => Promise<Response> }

let mockMessages: MockSdkMessage[] = []
let capturedQueryParams: { options?: { resume?: string; sessionId?: string } } | null = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => {
    const queryParams = params as { options?: { resume?: string; sessionId?: string } }
    capturedQueryParams = queryParams
    const sessionId = resolveMockSdkSessionId(queryParams.options)
    if (typeof sessionId !== "string") throw new Error("Expected Meridian to select or resume an SDK session ID")
    return (async function* () {
      for (const msg of mockMessages) {
        yield { ...msg, session_id: sessionId }
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => Promise<Response> | Response) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache, getMaxSessionsLimit } = await import("../proxy/server")
const { setSessionStoreDir } = await import("../proxy/sessionStore")
const testSessionDir = mkdtempSync(join(tmpdir(), "meridian-lru-test-"))
setSessionStoreDir(testSessionDir)

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app as TestApp
}

async function post(app: TestApp, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

async function send(app: TestApp, session: string | undefined, firstMessage: string): Promise<string> {
  const headers: Record<string, string> = session ? { "x-opencode-session": session } : {}
  const response = await post(app, {
    model: "claude-sonnet-4-5",
    max_tokens: 128,
    stream: false,
    messages: [{ role: "user", content: firstMessage }],
  }, headers)
  await response.json()
  const sessionId = capturedQueryParams?.options?.sessionId
  if (typeof sessionId !== "string") throw new Error("Expected a caller-selected fresh session ID")
  return sessionId
}

async function sendContinuation(app: TestApp, session: string, firstMessage: string, followUp: string) {
  const response = await post(app, {
    model: "claude-sonnet-4-5",
    max_tokens: 128,
    stream: false,
    messages: [
      { role: "user", content: firstMessage },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: followUp },
    ],
  }, { "x-opencode-session": session })
  await response.json()
}

beforeEach(() => {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
  capturedQueryParams = null
  clearSessionCache()
})

afterAll(() => {
  if (originalMaxSessions === undefined) delete process.env.CLAUDE_PROXY_MAX_SESSIONS
  else process.env.CLAUDE_PROXY_MAX_SESSIONS = originalMaxSessions
  rmSync(testSessionDir, { recursive: true, force: true })
})

describe("Session cache LRU eviction", () => {
  it("does not resume an exact replay after the least-recently-used entry leaves memory", async () => {
    const app = createTestApp()

    await send(app, "oc-A", "first-A")
    await send(app, "oc-B", "first-B")
    await send(app, "oc-C", "first-C")

    await send(app, "oc-A", "first-A")
    expect(capturedQueryParams?.options?.resume).toBeUndefined()
  })

  it("keeps durable resume after a key is accessed", async () => {
    const app = createTestApp()

    // Store two sessions (cache limit = 2)
    const sdkA = await send(app, "oc-A", "first-A")
    const sdkB = await send(app, "oc-B", "first-B")

    // Access A with a continuation (growing messages) to refresh its recency
    await sendContinuation(app, "oc-A", "first-A", "follow-up-A")
    expect(capturedQueryParams?.options?.resume).toBe(sdkA)

    // Store C — should evict B (not A, since A was accessed more recently)
    await send(app, "oc-C", "first-C")

    // B may leave the in-memory LRU, but the durable mapping must rehydrate it.
    await sendContinuation(app, "oc-B", "first-B", "follow-up-B")
    expect(capturedQueryParams?.options?.resume).toBe(sdkB)
  })

  it("coordinates eviction across session and fingerprint caches", async () => {
    const app = createTestApp()

    await send(app, "oc-A", "alpha")
    await send(app, "oc-B", "beta")
    await send(app, "oc-C", "gamma")

    await send(app, undefined, "alpha")
    expect(capturedQueryParams?.options?.resume).toBeUndefined()

    clearSessionCache()

    await send(app, "oc-A", "alpha")
    await send(app, undefined, "fp-X")
    await send(app, undefined, "fp-Y")

    await send(app, "oc-A", "alpha")
    expect(capturedQueryParams?.options?.resume).toBeUndefined()
  })
})

describe("Max session env parsing", () => {
  it("falls back to default and logs warning for invalid values", () => {
    const original = process.env.CLAUDE_PROXY_MAX_SESSIONS
    const originalWarn = console.warn
    const warnings: string[] = []

    process.env.CLAUDE_PROXY_MAX_SESSIONS = "not-a-number"
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "))
    }

    try {
      expect(getMaxSessionsLimit()).toBe(1000)
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain("MERIDIAN_MAX_SESSIONS")
      expect(warnings[0]).toContain("using default 1000")
    } finally {
      console.warn = originalWarn
      if (original === undefined) delete process.env.CLAUDE_PROXY_MAX_SESSIONS
      else process.env.CLAUDE_PROXY_MAX_SESSIONS = original
    }
  })
})
