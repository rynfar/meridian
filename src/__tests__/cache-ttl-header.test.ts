/**
 * x-meridian-cache-ttl: a request may pin the CLI to the five-minute cache tier.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import type { Options } from "@anthropic-ai/claude-agent-sdk"

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
    expect(cacheTtlFromHeader("1h")).toEqual({ ok: false })
    expect(cacheTtlFromHeader("300")).toEqual({ ok: false })
    expect(cacheTtlFromHeader("5m, 5m")).toEqual({ ok: false })
  })
})

let queryEnvs: Array<Record<string, string | undefined>> = []
let invalidTtlLogs: unknown[] = []

installSdkMock(() => ({
  query: (opts: { options?: Options }) => {
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
  claudeLog: (event: string, data: unknown) => {
    if (event === "cache_ttl.invalid") invalidTtlLogs.push(data)
  },
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

function post(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  proxyApp = app(),
) {
  return proxyApp.fetch(new Request(`http://localhost${path}`, {
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
    invalidTtlLogs = []
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
    const proxyApp = app()
    const res = await post("/v1/messages", message(), { [CACHE_TTL_HEADER]: "5m" }, proxyApp)
    expect(res.status).toBe(200)
    expect(queryEnvs[0]!.FORCE_PROMPT_CACHING_5M).toBe("1")

    const followup = await post("/v1/messages", {
      ...message(),
      messages: [{ role: "user", content: "A separate request" }],
    }, {}, proxyApp)
    expect(followup.status).toBe(200)
    expect(queryEnvs[1]!.FORCE_PROMPT_CACHING_5M).toBeUndefined()
  })

  it("keeps an explicit model pin next to it", async () => {
    const res = await post("/v1/messages", message("claude-opus-4-7"), { [CACHE_TTL_HEADER]: "5m" })
    expect(res.status).toBe(200)
    expect(queryEnvs[0]!.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-7")
    expect(queryEnvs[0]!.FORCE_PROMPT_CACHING_5M).toBe("1")
  })

  it("rejects invalid values without starting the CLI or recording the input", async () => {
    const invalid = "invalid-header-content"
    const res = await post("/v1/messages", message(), { [CACHE_TTL_HEADER]: invalid })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain(CACHE_TTL_HEADER)
    expect(body.error.message).not.toContain(invalid)
    expect(invalidTtlLogs).toEqual([{ requestId: expect.any(String) }])
    expect(queryEnvs).toHaveLength(0)
  })

  it("carries the header through the chat completions hop", async () => {
    const res = await post("/v1/chat/completions", message(), { [CACHE_TTL_HEADER]: "5m" })
    expect(res.status).toBe(200)
    expect(queryEnvs[0]!.FORCE_PROMPT_CACHING_5M).toBe("1")
  })

  it("carries the header through the Responses hop", async () => {
    const res = await post("/v1/responses", { model: "sonnet", input: "hi", stream: false }, { [CACHE_TTL_HEADER]: "5m" })
    expect(res.status).toBe(200)
    expect(queryEnvs[0]!.FORCE_PROMPT_CACHING_5M).toBe("1")
  })

  it("returns an OpenAI error for an invalid Responses header", async () => {
    const res = await post("/v1/responses", { model: "sonnet", input: "hi", stream: false }, { [CACHE_TTL_HEADER]: "1h" })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { type: "invalid_request_error", code: null } })
    expect(queryEnvs).toHaveLength(0)
  })
})
