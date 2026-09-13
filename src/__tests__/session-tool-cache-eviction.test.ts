/**
 * The per-session passthrough tool cache must be bounded.
 *
 * `sessionToolCache` exists so a client that intermittently omits `tools` on a
 * continuation request keeps its cached set instead of re-rendering the prompt
 * without it. That cache holds every session's full tool array — names,
 * descriptions and JSON schemas — so an unbounded map grows for the life of the
 * process. The neighbouring `sessionMcpCache` is already an LRU for exactly
 * this reason; this one was a plain Map.
 *
 * That matters for cost, not just memory: the eventual OOM restart drops the
 * in-memory session caches, and every live conversation then replays against a
 * cold prompt cache.
 *
 * Eviction is asserted through observable behaviour rather than by reaching
 * into the map — an evicted session simply stops having its tools restored.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, makeRequest, withMockSdkSessionId } from "./helpers"

let mockMessages: any[] = []
let capturedQueryParams: any = {}

installSdkMock(() => ({
  query: (opts: any) => {
    capturedQueryParams = opts
    return (async function* () {
      for (const msg of mockMessages) {
        yield withMockSdkSessionId(msg, opts.options)
      }
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "oc",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
  tool: () => ({}),
}), "session-tool-cache-eviction.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

const READ_TOOL = {
  name: "read",
  description: "Read a file",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

async function post(app: any, session: string, tools: any[]) {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-session": `${session}-${RUN}`,
      "user-agent": "opencode/1.0.0",
    },
    body: JSON.stringify(makeRequest({
      stream: false,
      tools,
      messages: tools.length > 0 ? [{ role: "user", content: "hi" }] : [
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue" },
      ],
    })),
  }))
}

/** Passthrough registers the client's tools on an MCP server named `oc`;
 *  with no tools (and none restored) there is no such server at all. */
function toolsReachedTheSdk(): boolean {
  return Boolean(capturedQueryParams?.options?.mcpServers?.oc)
}

describe("session tool cache is bounded", () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved.passthrough = process.env.MERIDIAN_PASSTHROUGH
    saved.maxSessions = process.env.MERIDIAN_MAX_SESSIONS
    process.env.MERIDIAN_PASSTHROUGH = "1"
    // Small enough that a third session must evict the first.
    process.env.MERIDIAN_MAX_SESSIONS = "2"
    clearSessionCache()
    capturedQueryParams = {}
  })

  afterEach(() => {
    if (saved.passthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = saved.passthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
    if (saved.maxSessions !== undefined) process.env.MERIDIAN_MAX_SESSIONS = saved.maxSessions
    else delete process.env.MERIDIAN_MAX_SESSIONS
    clearSessionCache()
  })

  it("restores a still-cached session's tools when the client omits them", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    await post(app, "keeps-a", [READ_TOOL])
    await post(app, "keeps-a", [])
    // The control for the eviction test below: without eviction the cached set
    // is restored, so the tools still reach the SDK.
    expect(toolsReachedTheSdk()).toBe(true)
  })

  it("stops restoring tools for a session evicted past the cache limit", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    await post(app, "evicted", [READ_TOOL])
    await post(app, "second", [READ_TOOL])
    await post(app, "third", [READ_TOOL])

    // "evicted" is now the least-recently-used of three entries in a cache of
    // two. An unbounded Map keeps it forever and restores its tools here.
    await post(app, "evicted", [])
    expect(toolsReachedTheSdk()).toBe(false)
  })
})
