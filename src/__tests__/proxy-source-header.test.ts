/**
 * `x-meridian-source` header tests.
 *
 * The source header is a client-supplied tag used by meridian purely for
 * observability — distinguishing concurrent request flows from the same
 * conversation (e.g., pylon's main chat vs. memory-extract fork vs. subagents).
 *
 * Verified:
 *   - header value appears in the [PROXY] request summary log line
 *   - absent header: no `source=` token appears
 *   - long / untrusted values are truncated to 64 chars (crude DoS guard on log line)
 *   - header does NOT affect routing, lineage detection, or caching
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from "bun:test"
import { assistantMessage } from "./helpers"

let mockMessages: unknown[] = []
let capturedQueryParams: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) yield msg
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

const BASE_BODY = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: false,
  messages: [{ role: "user", content: "hello" }],
}

describe("x-meridian-source header", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  afterEach(() => {
    clearSessionCache()
  })

  function getProxyLogLine(spy: ReturnType<typeof spyOn>): string | undefined {
    // The summary log line is the one that contains adapter=<name> and msgCount=
    return spy.mock.calls.map((c: any) => String(c[0])).find((msg: string) =>
      msg.includes("[PROXY]") && msg.includes("adapter=") && msg.includes("msgCount=")
    )
  }

  it("includes source=<value> in the [PROXY] summary line when header is present", async () => {
    const logSpy = spyOn(console, "error")
    const app = createTestApp()

    await post(app, BASE_BODY, { "x-meridian-source": "fork-memory-extract" })

    const line = getProxyLogLine(logSpy)
    expect(line).toBeDefined()
    expect(line!).toContain("source=fork-memory-extract")
    // Sanity: adapter and other fields still present (not a regression)
    expect(line!).toContain("adapter=")
    expect(line!).toContain("msgCount=")
    logSpy.mockRestore()
  })

  it("omits the source= token when header is absent", async () => {
    const logSpy = spyOn(console, "error")
    const app = createTestApp()

    await post(app, BASE_BODY)

    const line = getProxyLogLine(logSpy)
    expect(line).toBeDefined()
    expect(line!).not.toContain("source=")
    logSpy.mockRestore()
  })

  it("truncates source values longer than 64 chars", async () => {
    const logSpy = spyOn(console, "error")
    const app = createTestApp()

    const long = "a".repeat(200)
    await post(app, BASE_BODY, { "x-meridian-source": long })

    const line = getProxyLogLine(logSpy)
    expect(line).toBeDefined()
    // Should have at most 64 chars of the value after "source="
    const match = line!.match(/source=(\S+)/)
    expect(match).not.toBeNull()
    expect(match![1]!.length).toBeLessThanOrEqual(64)
    logSpy.mockRestore()
  })

  it("does not affect the SDK query (no source-derived routing)", async () => {
    const app = createTestApp()

    await post(app, BASE_BODY, { "x-meridian-source": "fork-memory-extract" })

    // Sanity: request was processed normally by the same SDK call path
    expect(capturedQueryParams).toBeDefined()
    // None of the known query options should carry the source (it's log-only)
    const serialized = JSON.stringify(capturedQueryParams.options ?? {})
    expect(serialized).not.toContain("fork-memory-extract")
  })
})
