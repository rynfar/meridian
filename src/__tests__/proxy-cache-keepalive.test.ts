/**
 * Prompt-cache keepalive through the HTTP layer with a mocked SDK.
 *
 * A keyed passthrough turn that sends `x-meridian-cache-keepalive` is kept
 * warm: once its prefix nears expiry, the proxy resumes the published SDK
 * session with a short prompt, without persisting a transcript or changing
 * the mapping the next turn resumes. Sessions that did not opt in are left alone.
 */
import { describe, it, expect, beforeEach, afterEach, setSystemTime } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { makeRequest, resolveMockSdkSessionId, streamEvent } from "./helpers"
import { setSessionStoreDir, lookupSharedSession } from "../proxy/sessionStore"

let isolatedSessionDir = ""
beforeEach(() => {
  isolatedSessionDir = mkdtempSync(join(tmpdir(), "meridian-keepalive-test-"))
  setSessionStoreDir(isolatedSessionDir)
})
afterEach(async () => {
  setSystemTime()
  // Request completion releases the cross-process lease asynchronously.
  await Bun.sleep(25)
  rmSync(isolatedSessionDir, { recursive: true, force: true })
})

let queryCalls: Array<{ prompt: unknown; options: Record<string, any> }> = []
let mcpServersCreated = 0

installSdkMock(() => ({
  query: (opts: any) => {
    queryCalls.push({ prompt: opts.prompt, options: opts.options ?? {} })
    const sessionId = resolveMockSdkSessionId(opts.options, `sdk-${queryCalls.length}`)
    const keepalive = opts.options?.persistSession === false
    return (async function* () {
      yield {
        ...streamEvent({
          type: "message_start",
          message: {
            id: `msg-${queryCalls.length}`,
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-sonnet-4-5",
            stop_reason: null,
            usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: keepalive ? 20_000 : 0 },
          },
        }),
        session_id: sessionId,
      }
      yield {
        type: "assistant",
        uuid: `uuid-${queryCalls.length}`,
        message: {
          id: `msg-${queryCalls.length}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 1 },
        },
        session_id: sessionId,
      }
      yield { type: "result", subtype: "success", result: "done", session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => {
    mcpServersCreated++
    return { type: "sdk", name: "oc", instance: { tool: () => {}, registerTool: () => ({}) } }
  },
  tool: () => ({}),
}), "proxy-cache-keepalive.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

const tool = {
  name: "read",
  description: "read a file",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
}

async function turn(proxy: ReturnType<typeof createProxyServer>, headers: Record<string, string>) {
  const response = await proxy.app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(makeRequest({ stream: false, tools: [tool] })),
  }))
  expect(response.status).toBe(200)
  await response.json()
}

async function tickAt(proxy: ReturnType<typeof createProxyServer>, at: number): Promise<void> {
  setSystemTime(new Date(at))
  proxy.tickCacheKeepalive?.()
  await Bun.sleep(25)
}

describe("cache keepalive", () => {
  beforeEach(() => {
    clearSessionCache()
    queryCalls = []
    mcpServersCreated = 0
  })

  it("resumes the published session shortly before its prefix expires", async () => {
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_keep", "x-meridian-cache-keepalive": "1800" })
    const published = lookupSharedSession("ses_keep")
    expect(published).toBeDefined()
    const serversAfterTurn = mcpServersCreated

    await tickAt(proxy, start + 3 * 60_000)
    expect(queryCalls).toHaveLength(1)

    await tickAt(proxy, start + 4.5 * 60_000)
    expect(queryCalls).toHaveLength(2)
    const keepalive = queryCalls[1]!
    expect(keepalive.prompt).toBe("Reply with OK.")
    expect(keepalive.options.resume).toBe(published!.claudeSessionId)
    expect(keepalive.options.forkSession).toBe(true)
    expect(keepalive.options.persistSession).toBe(false)
    expect(keepalive.options.maxTurns).toBe(1)
    // Same request shape as the turn, with a private MCP server instance.
    expect(keepalive.options.systemPrompt).toEqual(queryCalls[0]!.options.systemPrompt)
    expect(keepalive.options.model).toBe(queryCalls[0]!.options.model)
    expect(Object.keys(keepalive.options.mcpServers)).toEqual(Object.keys(queryCalls[0]!.options.mcpServers))
    expect(mcpServersCreated).toBe(serversAfterTurn + 1)
    expect(keepalive.options.hooks).toBeUndefined()

    // The next turn still resumes the session the client's turn published.
    expect(lookupSharedSession("ses_keep")?.claudeSessionId).toBe(published!.claudeSessionId)
  })

  it("stops once the window since the latest turn has passed", async () => {
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_window", "x-meridian-cache-keepalive": "300" })
    await tickAt(proxy, start + 4.5 * 60_000)
    expect(queryCalls).toHaveLength(2)
    await tickAt(proxy, start + 8.5 * 60_000)
    expect(queryCalls).toHaveLength(2)
  })

  it("stops when a later turn on the session no longer sends the header", async () => {
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_optout", "x-meridian-cache-keepalive": "1800" })
    await turn(proxy, { "x-opencode-session": "ses_optout" })
    await tickAt(proxy, start + 4.5 * 60_000)
    expect(queryCalls).toHaveLength(2)
  })

  it("leaves sessions that did not opt in alone", async () => {
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
    const start = Date.now()
    await turn(proxy, { "x-opencode-session": "ses_plain" })
    await turn(proxy, { "x-meridian-cache-keepalive": "1800" })
    await tickAt(proxy, start + 4.5 * 60_000)
    expect(queryCalls).toHaveLength(2)
  })
})
