/**
 * The session-keyed maps inside createProxyServer are never deleted from — a
 * key is added the first time a session is seen and stays for the life of the
 * process. Bounding them is only observable through eviction, so these tests
 * pin the limit at 2 and drive a third session past it.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { assistantMessage, makeRequest } from "./helpers"

const originalMaxSessions = process.env.CLAUDE_PROXY_MAX_SESSIONS
process.env.CLAUDE_PROXY_MAX_SESSIONS = "2"

type QueryOptions = { mcpServers?: Record<string, unknown> }
type TestApp = { fetch: (req: Request) => Promise<Response> }

let capturedQueryParams: { options?: QueryOptions } | null = null
let mockMessages: Record<string, unknown>[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => {
    capturedQueryParams = params as { options?: QueryOptions }
    return (async function* () {
      for (const msg of mockMessages) yield msg
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (
    _ctx: unknown,
    fn: () => Promise<Response> | Response,
  ) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({
    type: "sdk",
    name: "opencode",
    instance: {},
  }),
}))

const { createProxyServer, clearSessionCache } = await import(
  "../proxy/server"
)

const TOOL = {
  name: "read_file",
  description: "Read a file",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
}

function createTestApp(): TestApp {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app as TestApp
}

async function post(
  app: TestApp,
  body: Record<string, unknown>,
  sessionId: string,
) {
  const res = await app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-session": sessionId,
      },
      body: JSON.stringify(body),
    }),
  )
  await res.text()
}

/** Seed a session's tool cache by sending a tool set on a first turn. */
async function sendWithTools(app: TestApp, sessionId: string) {
  await post(
    app,
    makeRequest({
      stream: false,
      tools: [TOOL],
      messages: [{ role: "user", content: `hello ${sessionId}` }],
    }),
    sessionId,
  )
}

/** Continue a session while omitting tools — the case the cache exists for. */
async function sendWithoutTools(app: TestApp, sessionId: string) {
  capturedQueryParams = null
  await post(
    app,
    makeRequest({
      stream: false,
      tools: [],
      messages: [
        { role: "user", content: `hello ${sessionId}` },
        { role: "assistant", content: "Done." },
        { role: "user", content: "continue" },
      ],
    }),
    sessionId,
  )
}

/** A restored tool set is visible as a passthrough MCP server on the SDK call. */
function toolsWereRestored(): boolean {
  const servers = capturedQueryParams?.options?.mcpServers
  if (!servers) return false
  return Object.keys(servers).some(
    (k) => k.includes("passthrough") || k === "oc",
  )
}

beforeEach(() => {
  clearSessionCache()
  capturedQueryParams = null
  mockMessages = [assistantMessage([{ type: "text", text: "Done." }])]
})

afterAll(() => {
  if (originalMaxSessions === undefined)
    delete process.env.CLAUDE_PROXY_MAX_SESSIONS
  else process.env.CLAUDE_PROXY_MAX_SESSIONS = originalMaxSessions
})

describe("Session tool cache is bounded", () => {
  it("evicts the least-recently-used session once the limit is passed", async () => {
    const app = createTestApp()

    await sendWithTools(app, "bound-a")
    await sendWithTools(app, "bound-b")
    await sendWithTools(app, "bound-c") // limit is 2, so this evicts bound-a

    await sendWithoutTools(app, "bound-a")
    expect(toolsWereRestored()).toBe(false)
  })

  it("still restores tools for a session inside the limit", async () => {
    const app = createTestApp()

    await sendWithTools(app, "bound-a")
    await sendWithTools(app, "bound-b")
    await sendWithTools(app, "bound-c")

    // bound-c is the most recent of the two survivors — eviction must not cost
    // the cache its actual purpose.
    await sendWithoutTools(app, "bound-c")
    expect(toolsWereRestored()).toBe(true)
  })

  it("keeps a session alive when it is the one being used", async () => {
    const app = createTestApp()

    await sendWithTools(app, "bound-a")
    await sendWithTools(app, "bound-b")

    // Reading bound-a refreshes its recency, so bound-b becomes the eviction
    // candidate instead.
    await sendWithoutTools(app, "bound-a")
    expect(toolsWereRestored()).toBe(true)

    await sendWithTools(app, "bound-c")

    await sendWithoutTools(app, "bound-b")
    expect(toolsWereRestored()).toBe(false)
  })
})
