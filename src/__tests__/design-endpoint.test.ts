/**
 * /v1/design/* and /design-login integration — #543.
 *
 * Through the HTTP layer with the upstream fetch mocked: asserts the POST
 * proxy forwards auth + identity encoding, maps the Design API's
 * 404-for-missing-scopes to a 401 auth_error, strips hop-by-hop response
 * headers, serves the local GET keepalive stream, and that /design-login
 * exchanges a code and persists the token file. From #543 by @sittitep.
 */
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

installSdkMock(() => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "design-endpoint.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const tokenDir = mkdtempSync(join(tmpdir(), "design-test-"))
const tokenPath = join(tokenDir, "design-token.json")
process.env.MERIDIAN_DESIGN_TOKEN_PATH = tokenPath

const { createProxyServer } = await import("../proxy/server")

// Upstream mock: captures design-API requests, delegates everything else.
const realFetch = globalThis.fetch
let upstreamCalls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
let upstreamResponse: () => Response = () => new Response("{}", { status: 200 })
let tokenExchangeResponse: () => Response = () =>
  new Response(JSON.stringify({ access_token: "designtok", refresh_token: "designref", expires_in: 28800, scope: "user:design:read user:design:write" }), { status: 200 })

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url
  if (url.startsWith("https://api.anthropic.com/v1/design/")) {
    const headers: Record<string, string> = {}
    for (const [k, v] of new Headers(init?.headers ?? {}).entries()) headers[k] = v
    upstreamCalls.push({ url, headers, body: init?.body ? Buffer.from(init.body).toString() : "" })
    return upstreamResponse()
  }
  if (url === "https://platform.claude.com/v1/oauth/token") {
    return tokenExchangeResponse()
  }
  return realFetch(input, init)
}) as typeof fetch

afterAll(() => {
  globalThis.fetch = realFetch
  rmSync(tokenDir, { recursive: true, force: true })
  delete process.env.MERIDIAN_DESIGN_TOKEN_PATH
})

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

describe("/design-login (#543)", () => {
  beforeEach(() => {
    upstreamCalls = []
    rmSync(tokenPath, { force: true })
  })

  it("GET returns an authorize URL carrying the design scopes", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/design-login"))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.authorizeUrl).toContain("user%3Adesign%3Aread")
    expect(body.authorizeUrl).toContain("user%3Adesign%3Awrite")
  })

  it("POST exchanges the code and writes the token file with mode 0600", async () => {
    const app = createTestApp()
    const startRes = await app.fetch(new Request("http://localhost/design-login"))
    const { authorizeUrl } = await startRes.json() as any
    const state = new URL(authorizeUrl).searchParams.get("state")!

    const res = await app.fetch(
      new Request("http://localhost/design-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: `the-code#${state}` }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.success).toBe(true)

    const stored = JSON.parse(readFileSync(tokenPath, "utf-8"))
    expect(stored.accessToken).toBe("designtok")
    expect(stored.refreshToken).toBe("designref")
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
  })

  it("POST with garbage body is a 400, not a crash", async () => {
    const app = createTestApp()
    const res = await app.fetch(
      new Request("http://localhost/design-login", { method: "POST", body: "not json" }),
    )
    expect(res.status).toBe(400)
  })
})

describe("/v1/design proxy (#543)", () => {
  beforeEach(() => {
    upstreamCalls = []
    rmSync(tokenPath, { force: true })
    upstreamResponse = () => new Response("{}", { status: 200 })
  })

  it("GET serves a local SSE keepalive stream without touching upstream", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/design/mcp"))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    expect(Buffer.from(value!).toString()).toContain(": keepalive")
    await reader.cancel()
    expect(upstreamCalls).toHaveLength(0)
  })

  it("POST proxies to upstream with identity encoding and forwards mcp-session-id both ways", async () => {
    upstreamResponse = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "up-sess", "transfer-encoding": "chunked" },
      })
    const app = createTestApp()
    const res = await app.fetch(
      new Request("http://localhost/v1/design/mcp?x=1", {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-session-id": "client-sess", "anthropic-beta": "mcp-beta" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("mcp-session-id")).toBe("up-sess")
    expect(await res.json()).toEqual({ ok: true })

    expect(upstreamCalls).toHaveLength(1)
    const call = upstreamCalls[0]!
    expect(call.url).toBe("https://api.anthropic.com/v1/design/mcp?x=1")
    expect(call.headers["accept-encoding"]).toBe("identity")
    expect(call.headers["mcp-session-id"]).toBe("client-sess")
    expect(call.headers["anthropic-beta"]).toBe("mcp-beta")
    expect(call.body).toContain("tools/list")
  })

  it("uses a fresh stored design token as Bearer auth", async () => {
    const app = createTestApp()
    // Store a token via the login flow so the file is written the same way
    const startRes = await app.fetch(new Request("http://localhost/design-login"))
    const state = new URL(((await startRes.json()) as any).authorizeUrl).searchParams.get("state")!
    await app.fetch(
      new Request("http://localhost/design-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: `code#${state}` }),
      }),
    )

    await app.fetch(new Request("http://localhost/v1/design/mcp", { method: "POST", body: "{}" }))
    expect(upstreamCalls[0]!.headers["authorization"]).toBe("Bearer designtok")
  })

  it("maps upstream 404 (missing design scopes) to a 401 auth_error pointing at /design-login", async () => {
    upstreamResponse = () => new Response("not found", { status: 404 })
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/design/mcp", { method: "POST", body: "{}" }))
    expect(res.status).toBe(401)
    const body = await res.json() as any
    expect(body.error.type).toBe("auth_error")
    expect(body.error.message).toContain("/design-login")
  })

  it("passes non-auth upstream errors through untouched", async () => {
    upstreamResponse = () => new Response(JSON.stringify({ boom: true }), { status: 500 })
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/design/mcp", { method: "POST", body: "{}" }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ boom: true })
  })

  it("does not write a token file as a side effect of proxying", async () => {
    const app = createTestApp()
    await app.fetch(new Request("http://localhost/v1/design/mcp", { method: "POST", body: "{}" }))
    expect(existsSync(tokenPath)).toBe(false)
  })
})
