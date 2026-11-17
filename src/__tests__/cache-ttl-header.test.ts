/**
 * x-meridian-cache-ttl: a request may pin the CLI to the five-minute cache tier.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"

import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

const { cacheTtlFromHeader, CACHE_TTL_HEADER } = await import("../proxy/cacheTtl")

describe("cacheTtlFromHeader", () => {
  it("adds nothing without a value", () => {
    expect(cacheTtlFromHeader(undefined)).toEqual({ ok: true, env: undefined })
    expect(cacheTtlFromHeader("  ")).toEqual({ ok: true, env: undefined })
  })

  it("pins five minutes for 5m, whatever the case and spacing", () => {
    expect(cacheTtlFromHeader("5m")).toEqual({ ok: true, env: { FORCE_PROMPT_CACHING_5M: "1" } })
    expect(cacheTtlFromHeader(" 5M ")).toEqual({ ok: true, env: { FORCE_PROMPT_CACHING_5M: "1" } })
  })

  it("refuses any other lifetime", () => {
    expect(cacheTtlFromHeader("1h")).toEqual({ ok: false, value: "1h" })
    expect(cacheTtlFromHeader("300")).toEqual({ ok: false, value: "300" })
  })
})

let queryEnvs: Array<Record<string, string | undefined>> = []

installSdkMock(() => ({
  query: (opts: any) => {
    queryEnvs.push(opts.options?.env || {})
    const sessionId = resolveMockSdkSessionId(opts.options, "sdk-1")
    return (async function* () {
      yield { ...assistantMessage([{ type: "text", text: "ok" }]), session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "cache-ttl-header.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

const proxies: ReturnType<typeof createProxyServer>[] = []
function app() {
  const proxy = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
  proxies.push(proxy)
  return proxy.app
}

function post(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app().fetch(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

const message = (model = "sonnet") => ({ model, max_tokens: 50, stream: false, messages: [{ role: "user", content: "hi" }] })

describe("x-meridian-cache-ttl reaches the subprocess env", () => {
  beforeEach(async () => {
    await clearSessionCache()
    queryEnvs = []
  })

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) await proxy.closeBackend?.()
  })

  it("leaves the CLI's choice alone without the header", async () => {
    const res = await post("/v1/messages", message())
    expect(res.status).toBe(200)
    expect(queryEnvs[0]!.FORCE_PROMPT_CACHING_5M).toBeUndefined()
  })

  it("pins five minutes on a working request", async () => {
    const res = await post("/v1/messages", message(), { [CACHE_TTL_HEADER]: "5m" })
    expect(res.status).toBe(200)
    expect(queryEnvs[0]!.FORCE_PROMPT_CACHING_5M).toBe("1")
  })

  it("keeps an explicit model pin next to it", async () => {
    const res = await post("/v1/messages", message("claude-opus-4-7"), { [CACHE_TTL_HEADER]: "5m" })
    expect(res.status).toBe(200)
    expect(queryEnvs[0]!.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-7")
    expect(queryEnvs[0]!.FORCE_PROMPT_CACHING_5M).toBe("1")
  })

  it("answers 400 to another lifetime and never starts the CLI", async () => {
    const res = await post("/v1/messages", message(), { [CACHE_TTL_HEADER]: "1h" })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain(CACHE_TTL_HEADER)
    expect(queryEnvs).toHaveLength(0)
  })

  it("carries the header through the chat completions hop", async () => {
    const res = await post("/v1/chat/completions", message(), { [CACHE_TTL_HEADER]: "5m" })
    expect(res.status).toBe(200)
    expect(queryEnvs[0]!.FORCE_PROMPT_CACHING_5M).toBe("1")
  })
})
