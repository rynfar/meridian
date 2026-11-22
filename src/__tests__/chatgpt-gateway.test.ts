/**
 * The ChatGPT gateway end to end over HTTP, with chatgpt.com mocked.
 *
 * Every guarantee here is paired with a control that proves the check can
 * fail: the never-refresh assertions against owned mode, where a refresh does
 * happen and the same spy sees it; the no-plugin assertions against the
 * Claude path, where the same plugin does run.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"
import { CHATGPT_MODELS } from "../proxy/upstream/provider"

let sdkCalls = 0
installSdkMock(() => ({
  query: (params: unknown) => {
    sdkCalls++
    return (async function* () {
      yield { ...assistantMessage([{ type: "text", text: "claude-ok" }]), session_id: resolveMockSdkSessionId((params as { options?: unknown }).options, "sdk-chatgpt-1") }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "chatgpt-gateway.test.ts")
installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => Promise<Response> | Response) => fn(),
}))

const sessionDir = mkdtempSync(join(tmpdir(), "chatgpt-gateway-sess-"))
process.env.CLAUDE_PROXY_SESSION_DIR = sessionDir
delete process.env.MERIDIAN_API_KEY

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { telemetryStore } = await import("../telemetry")
const { __setFetchOAuthUsageOverride, resetOAuthUsageCache } = await import("../proxy/oauthUsage")
const { getSetting, saveSettings } = await import("../settings")
const { resetCodexUsageCache } = await import("../proxy/codex/service")
const { __setChatGptLoginListenOverride } = await import("../proxy/chatgpt/login")

const NOW = Date.now()
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"
const IMAGES_PREFIX = "https://chatgpt.com/backend-api/codex/images/"
const TOKEN_URL = "https://auth.openai.com/oauth/token"

interface UpstreamCall { url: string; authorization: string | null; accountId: string | null; body: Record<string, unknown> }
let upstreamCalls: UpstreamCall[] = []
let tokenCalls = 0
let respond: (call: UpstreamCall, index: number) => Response | Promise<Response> = () => completed()
const CATALOG_URL = "https://chatgpt.com/backend-api/codex/models"
let catalogCalls: Array<{ authorization: string | null }> = []
let catalog: () => Response = () => new Response("{}", { status: 503 })
const WHAM_PREFIX = "https://chatgpt.com/backend-api/wham/"
let whamCalls: Array<{ url: string; method: string; authorization: string | null }> = []
let wham: (url: string, authorization: string | null) => Response | undefined = () => undefined
const realFetch = globalThis.fetch

function completed(text = "pong", extraHeaders: Record<string, string> = {}): Response {
  const events = [
    { type: "response.created", response: { id: "r1", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
    { type: "response.output_text.delta", delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } },
    { type: "response.completed", response: { id: "r1", model: "gpt-6-luna", output: [], usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 10 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } } } },
  ]
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream", "set-cookie": "must-not-leak=1", ...extraHeaders },
  })
}

/** `x-codex-*` window headers as the backend states them: width in minutes, reset in epoch seconds. */
function codexWindows(windows: Array<{ minutes: number; used: number; resetInS: number }>): Record<string, string> {
  const headers: Record<string, string> = {}
  windows.forEach((w, i) => {
    const position = i === 0 ? "primary" : "secondary"
    headers[`x-codex-${position}-window-minutes`] = String(w.minutes)
    headers[`x-codex-${position}-used-percent`] = String(w.used)
    headers[`x-codex-${position}-reset-at`] = String(Math.floor(Date.now() / 1000) + w.resetInS)
  })
  return headers
}
const refused = () => new Response(JSON.stringify({ detail: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } })

function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  if (url === TOKEN_URL) {
    tokenCalls++
    return Promise.resolve(new Response(JSON.stringify({ access_token: "at-refreshed", refresh_token: "rt-rotated", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } }))
  }
  if (url === CODEX_URL || url.startsWith(IMAGES_PREFIX)) {
    const headers = new Headers(init?.headers)
    const call = { url, authorization: headers.get("authorization"), accountId: headers.get("chatgpt-account-id"), body: JSON.parse(String(init?.body)) as Record<string, unknown> }
    upstreamCalls.push(call)
    return Promise.resolve(respond(call, upstreamCalls.length - 1))
  }
  if (url.startsWith(`${CATALOG_URL}?`)) {
    catalogCalls.push({ authorization: new Headers(init?.headers).get("authorization") })
    return Promise.resolve(catalog())
  }
  if (url.startsWith(WHAM_PREFIX)) {
    const authorization = new Headers(init?.headers).get("authorization")
    whamCalls.push({ url, method: init?.method ?? "GET", authorization })
    const answer = wham(url, authorization)
    if (answer) return Promise.resolve(answer)
  }
  if (url.startsWith("https://chatgpt.com/")) return Promise.resolve(new Response("{}", { status: 503 }))
  return Promise.reject(new Error(`unexpected network call in test: ${url}`))
}

function account(n: number, extra: Record<string, unknown> = {}) {
  return {
    accountId: `workspace-${n}`, accountUserId: `user-${n}__workspace-${n}`, email: `seat${n}@example.test`,
    refreshToken: `rt-${n}`, accessToken: `at-${n}`, expiresAt: NOW + 3_600_000, addedAt: 1, lastUsed: 1, ...extra,
  }
}

let dir: string
const priorConfigDir = process.env.MERIDIAN_CONFIG_DIR
let poolDir: string
let poolPath: string
function writePool(accounts: unknown[]) {
  writeFileSync(poolPath, JSON.stringify({ version: 3, accounts, activeIndex: 0 }))
}
function snapshotPoolDir() {
  return { bytes: readFileSync(poolPath), entries: readdirSync(poolDir).sort() }
}

async function server(mode: string | undefined, plugin?: string) {
  if (mode === undefined) delete process.env.MERIDIAN_CHATGPT_CREDENTIALS
  else process.env.MERIDIAN_CHATGPT_CREDENTIALS = mode
  const pluginConfigPath = join(dir, "plugins.json")
  writeFileSync(pluginConfigPath, JSON.stringify({ plugins: plugin ? [{ path: plugin, enabled: true }] : [] }))
  const proxy = createProxyServer({ port: 0, host: "127.0.0.1", pluginDir: join(dir, "no-plugins"), pluginConfigPath })
  await proxy.initPlugins?.()
  return proxy
}

function responses(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer any-client-key", ...headers },
    body: JSON.stringify(body),
  })
}

const LUNA = {
  model: "gpt-6-luna",
  stream: true,
  max_output_tokens: 32000,
  input: [{ role: "developer", content: "You are opencode." }, { role: "user", content: "hi" }],
  prompt_cache_key: "conversation-1", // gitleaks:allow - a conversation id, not a credential
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "chatgpt-gateway-"))
  process.env.MERIDIAN_CONFIG_DIR = join(dir, "meridian")
  poolDir = join(dir, "opencode")
  mkdirSync(poolDir)
  poolPath = join(poolDir, "oc-codex-multi-auth-accounts.json")
  process.env.MERIDIAN_CODEX_POOL_PATH = poolPath
  upstreamCalls = []
  tokenCalls = 0
  sdkCalls = 0
  respond = () => completed()
  catalogCalls = []
  catalog = () => new Response("{}", { status: 503 })
  whamCalls = []
  wham = () => undefined
  globalThis.fetch = mockFetch as typeof fetch
  telemetryStore.clear()
  await clearSessionCache()
  __setFetchOAuthUsageOverride(async () => null)
  // Another suite in the same process may have switched usage reads off, or
  // left a Claude `default` reading cached.
  resetOAuthUsageCache()
  saveSettings({ integrations: undefined })
})
afterEach(() => {
  __setFetchOAuthUsageOverride(null)
  saveSettings({
    chatGptActiveSeat: undefined, chatGptProfileNames: undefined, chatGptProfileAliases: undefined, profileOrder: undefined,
    chatgpt: undefined,
  })
  globalThis.fetch = realFetch
  delete process.env.MERIDIAN_CHATGPT_CREDENTIALS
  delete process.env.MERIDIAN_CODEX_POOL_PATH
  delete process.env.MERIDIAN_CHATGPT_STORE_PATH
  rmSync(dir, { recursive: true, force: true })
  if (priorConfigDir === undefined) delete process.env.MERIDIAN_CONFIG_DIR
  else process.env.MERIDIAN_CONFIG_DIR = priorConfigDir
})
afterAll(() => {
  rmSync(sessionDir, { recursive: true, force: true })
  delete process.env.CLAUDE_PROXY_SESSION_DIR
  mock.restore()
})

describe("ChatGPT gateway routing", () => {
  it("serves a GPT model from the seat's token, adapting only what the backend requires", async () => {
    writePool([account(0), account(1)])
    const { app } = await server("follow-external")
    const res = await app.fetch(responses(LUNA))
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie")).toBeNull()
    expect(await res.text()).toContain('"delta":"pong"')

    expect(upstreamCalls).toHaveLength(1)
    const [call] = upstreamCalls
    expect(call!.authorization).toBe("Bearer at-0")
    expect(call!.accountId).toBe("workspace-0")
    const { max_output_tokens: _dropped, ...client } = LUNA
    expect(call!.body).toEqual({ ...client, store: false, include: ["reasoning.encrypted_content"] })

    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric).toMatchObject({ adapter: "chatgpt", requestModel: "gpt-6-luna", status: 200, isPassthrough: true, inputTokens: 40, cacheReadInputTokens: 10, outputTokens: 5 })
  })

  it("aggregates the stream for a client that did not ask to stream", async () => {
    writePool([account(0)])
    const { app } = await server("follow-external")
    const res = await app.fetch(responses({ ...LUNA, stream: false }))
    expect(res.status).toBe(200)
    const body = await res.json() as { output: Array<{ content: Array<{ text: string }> }> }
    expect(body.output[0]!.content[0]!.text).toBe("pong")
  })

  it("keeps Claude models on Claude and refuses GPT models on the Messages surface", async () => {
    writePool([account(0)])
    const { app } = await server("follow-external")
    const claude = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] }),
    }))
    expect(claude.status).toBe(200)
    expect(sdkCalls).toBe(1)
    const gptOnMessages = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    }))
    expect(gptOnMessages.status).toBe(404)
    expect(upstreamCalls).toHaveLength(0)
  })

  it("serves an unlisted OpenAI model from ChatGPT, never from Claude", async () => {
    writePool([account(0)])
    const { app } = await server("follow-external")
    const res = await app.fetch(responses({ ...LUNA, model: "gpt-5.4-nano" }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('"delta":"pong"')
    expect(sdkCalls).toBe(0)
    expect(upstreamCalls.map(call => call.body.model)).toEqual(["gpt-5.4-nano"])
    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric).toMatchObject({ adapter: "chatgpt", requestModel: "gpt-5.4-nano" })
  })

  it("returns a model every seat refuses in OpenAI's error shape, asking each seat once and benching none", async () => {
    writePool([account(0), account(1)])
    const detail = "The 'gpt-5.4-nano' model is not supported when using Codex with a ChatGPT account."
    respond = () => new Response(JSON.stringify({ detail }), { status: 400, headers: { "content-type": "application/json" } })
    const { app } = await server("follow-external")
    for (const stream of [false, true]) {
      const res = await app.fetch(responses({ ...LUNA, model: "gpt-5.4-nano", stream }))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: { type: "invalid_request_error", message: detail, code: null } })
    }
    // The second turn finds both seats sitting the model out and asks one, for the backend's own answer.
    expect(upstreamCalls.map(call => call.accountId)).toEqual(["workspace-0", "workspace-1", "workspace-0"])
    expect(sdkCalls).toBe(0)
    expect(telemetryStore.getRecent({ limit: 2 }).map(m => [m.adapter, m.status, m.error])).toEqual([
      ["chatgpt", 400, "request_refused"], ["chatgpt", 400, "request_refused"],
    ])
  })

  it("serves a model one seat's plan refuses from the next seat, and stops asking that seat for it", async () => {
    writePool([account(0), account(1)])
    respond = call => call.accountId === "workspace-0" && call.body.model === "gpt-6.1-sol"
      ? new Response(JSON.stringify({ detail: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." }), { status: 400, headers: { "content-type": "application/json" } })
      : completed()
    const { app } = await server("follow-external")
    const { prompt_cache_key: _conversation, ...uncached } = LUNA
    for (let turn = 0; turn < 2; turn++) {
      expect((await app.fetch(responses({ ...uncached, model: "gpt-6.1-sol", stream: false }))).status).toBe(200)
    }
    // Not benched: the seat that refused gpt-6.1-sol still leads for every other model.
    expect((await app.fetch(responses({ ...uncached, stream: false }))).status).toBe(200)
    expect(upstreamCalls.map(call => [call.accountId, call.body.model])).toEqual([
      ["workspace-0", "gpt-6.1-sol"], ["workspace-1", "gpt-6.1-sol"], ["workspace-1", "gpt-6.1-sol"], ["workspace-0", "gpt-6-luna"],
    ])
  })

  it("passes a refusal already in OpenAI's shape through unchanged", async () => {
    writePool([account(0)])
    const body = JSON.stringify({ error: { type: "invalid_request_error", message: "bad field", code: "unknown_parameter" } })
    respond = () => new Response(body, { status: 400, headers: { "content-type": "application/json" } })
    const { app } = await server("follow-external")
    const res = await app.fetch(responses({ ...LUNA, stream: false }))
    expect(res.status).toBe(400)
    expect(await res.text()).toBe(body)
  })

  it("leaves GPT names on Claude when no ChatGPT source is configured", async () => {
    writePool([account(0)])
    const { app } = await server(undefined)
    const res = await app.fetch(responses({ ...LUNA, stream: false }))
    expect(res.status).toBe(200)
    expect(sdkCalls).toBe(1)
    expect(upstreamCalls).toHaveLength(0)
  })
})

describe("ChatGPT image generation", () => {
  const PNG_B64 = "iVBORw0KGgo="
  const image = (extra: Record<string, string> = {}) => new Response(JSON.stringify({ created: 1, data: [{ b64_json: PNG_B64 }] }), {
    status: 200, headers: { "content-type": "application/json", "set-cookie": "must-not-leak=1", ...extra },
  })
  const imagesRequest = (route: string, body: Record<string, unknown>) => new Request(`http://localhost${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer any-client-key" },
    body: JSON.stringify(body),
  })
  const GENERATE = { prompt: "a lighthouse at dusk", background: "opaque", model: "gpt-image-2", quality: "auto", size: "auto" }

  it("generates an image on a seat's plan, passing the body and the answer through untouched", async () => {
    writePool([account(0), account(1)])
    respond = () => image()
    const { app } = await server("follow-external")
    const res = await app.fetch(imagesRequest("/v1/images/generations", GENERATE))
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie")).toBeNull()
    expect(await res.json()).toEqual({ created: 1, data: [{ b64_json: PNG_B64 }] })

    expect(upstreamCalls).toHaveLength(1)
    const [call] = upstreamCalls
    expect(call!.url).toBe(`${IMAGES_PREFIX}generations`)
    expect(call!.authorization).toBe("Bearer at-0")
    expect(call!.accountId).toBe("workspace-0")
    expect(call!.body).toEqual(GENERATE)
    expect(sdkCalls).toBe(0)

    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric).toMatchObject({ adapter: "chatgpt", requestModel: "gpt-image-2", status: 200, mode: "non-stream" })
  })

  it("sends reference images to the edits endpoint", async () => {
    writePool([account(0)])
    respond = () => image()
    const { app } = await server("follow-external")
    const edit = { ...GENERATE, images: [{ image_url: `data:image/png;base64,${PNG_B64}` }] }
    const res = await app.fetch(imagesRequest("/v1/images/edits", edit))
    expect(res.status).toBe(200)
    expect(upstreamCalls.map(call => call.url)).toEqual([`${IMAGES_PREFIX}edits`])
    expect(upstreamCalls[0]!.body).toEqual(edit)
  })

  it("moves an image request past a seat whose plan is spent, and benches that seat", async () => {
    writePool([account(0), account(1)])
    respond = (_call, index) => index === 0
      ? new Response(JSON.stringify({ detail: "usage limit reached" }), { status: 429, headers: { "content-type": "application/json" } })
      : image()
    const { app } = await server("follow-external")
    const res = await app.fetch(imagesRequest("/v1/images/generations", GENERATE))
    expect(res.status).toBe(200)
    expect(upstreamCalls.map(call => call.accountId)).toEqual(["workspace-0", "workspace-1"])

    upstreamCalls = []
    respond = () => image()
    expect((await app.fetch(imagesRequest("/v1/images/generations", GENERATE))).status).toBe(200)
    expect(upstreamCalls.map(call => call.accountId)).toEqual(["workspace-1"])
  })

  it("sends an image request with no model to ChatGPT, never to Claude", async () => {
    writePool([account(0)])
    respond = () => image()
    const { app } = await server("follow-external")
    const { model: _model, ...unnamed } = GENERATE
    const res = await app.fetch(imagesRequest("/v1/images/generations", unnamed))
    expect(res.status).toBe(200)
    expect(sdkCalls).toBe(0)
    expect(upstreamCalls).toHaveLength(1)
  })

  it("answers in OpenAI's shape when no ChatGPT source is configured", async () => {
    const { app } = await server(undefined)
    const res = await app.fetch(imagesRequest("/v1/images/generations", GENERATE))
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe("not_found_error")
    expect(body.error.message).toContain("/v1/images/generations")
    expect(sdkCalls).toBe(0)
    expect(upstreamCalls).toHaveLength(0)
  })
})

describe("follow-external never refreshes and never writes", () => {
  it("answers expired tokens with an owner-must-refresh error, without a token call or a write", async () => {
    writePool([account(0, { expiresAt: NOW - 1 }), account(1, { expiresAt: NOW + 10_000 })])
    const before = snapshotPoolDir()
    const { app } = await server("follow-external")
    const res = await app.fetch(responses(LUNA))
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe("authentication_error")
    expect(body.error.message).toContain("never refreshes")
    expect(tokenCalls).toBe(0)
    expect(upstreamCalls).toHaveLength(0)
    expect(snapshotPoolDir()).toEqual(before)
  })

  it("fails over past a refused token without refreshing it", async () => {
    writePool([account(0), account(1)])
    const before = snapshotPoolDir()
    respond = call => call.authorization === "Bearer at-0" ? refused() : completed()
    const { app } = await server("follow-external")
    const res = await app.fetch(responses(LUNA))
    expect(res.status).toBe(200)
    expect(upstreamCalls.map(c => c.authorization)).toEqual(["Bearer at-0", "Bearer at-1"])
    expect(tokenCalls).toBe(0)
    expect(snapshotPoolDir()).toEqual(before)
  })

  it("re-reads once and retries the same seat when the owner rotated its token", async () => {
    writePool([account(0), account(1)])
    respond = (call, index) => {
      if (index > 0) return completed()
      writePool([account(0, { accessToken: "at-0-rotated-by-owner" }), account(1)])
      utimesSync(poolPath, new Date(), new Date(Date.now() + 5000))
      return refused()
    }
    const { app } = await server("follow-external")
    const res = await app.fetch(responses(LUNA))
    expect(res.status).toBe(200)
    expect(upstreamCalls.map(c => c.authorization)).toEqual(["Bearer at-0", "Bearer at-0-rotated-by-owner"])
    expect(tokenCalls).toBe(0)
  })

  it("returns the owner-must-refresh error when every seat refuses", async () => {
    writePool([account(0), account(1)])
    respond = () => refused()
    const { app } = await server("follow-external")
    const res = await app.fetch(responses(LUNA))
    expect(res.status).toBe(401)
    expect((await res.json() as { error: { message: string } }).error.message).toContain("owner must refresh")
    expect(tokenCalls).toBe(0)
  })

  it("control: owned mode DOES refresh an expired token, and the same spy sees it", async () => {
    const storePath = join(dir, "chatgpt-accounts.json")
    process.env.MERIDIAN_CHATGPT_STORE_PATH = storePath
    writeFileSync(storePath, JSON.stringify({ version: 1, accounts: [{
      accountUserId: "user-0__workspace-0", accountId: "workspace-0", email: null, refreshToken: "rt-0",
      accessToken: "at-0", expiresAt: NOW - 1, tokenRotatedAt: null, exchangeStartedAt: null,
    }] }))
    const proxy = await server("owned")
    await proxy.chatGpt!.acquire()
    try {
      const res = await proxy.app.fetch(responses(LUNA))
      expect(res.status).toBe(200)
      expect(tokenCalls).toBe(1)
      expect(upstreamCalls[0]!.authorization).toBe("Bearer at-refreshed")
    } finally {
      proxy.chatGpt!.release()
    }
  })
})

describe("plugins never touch ChatGPT requests", () => {
  function writeMarkerPlugin() {
    const marker = join(dir, "plugin-ran")
    const path = join(dir, "marker-plugin.mjs")
    writeFileSync(path, `
      import { appendFileSync } from "node:fs"
      export default {
        name: "marker", version: "1.0.0", description: "records every hook call",
        onRequest(ctx) { appendFileSync(${JSON.stringify(marker)}, "onRequest\\n"); return { ...ctx, systemContext: "[SCRUBBED] " + (ctx.systemContext || "") } },
        onResponse(ctx) { appendFileSync(${JSON.stringify(marker)}, "onResponse\\n"); return ctx },
      }
    `)
    return { path, marker }
  }

  it("runs no request plugin for an opencode client on the ChatGPT path", async () => {
    writePool([account(0)])
    const plugin = writeMarkerPlugin()
    const { app } = await server("follow-external", plugin.path)
    const res = await app.fetch(responses(LUNA, { "user-agent": "opencode/1.18.32", "x-opencode-session": "s1" }))
    expect(res.status).toBe(200)
    await res.text()
    expect(existsSync(plugin.marker)).toBe(false)
    expect(upstreamCalls[0]!.body.input).toEqual(LUNA.input)
  })

  it("control: the same plugin does run on the Claude path", async () => {
    writePool([account(0)])
    const plugin = writeMarkerPlugin()
    const { app } = await server("follow-external", plugin.path)
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "opencode/1.18.32" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 64, stream: false, system: "sys", messages: [{ role: "user", content: "hi" }] }),
    }))
    expect(res.status).toBe(200)
    expect(readFileSync(plugin.marker, "utf8")).toContain("onRequest")
  })
})

describe("/providers", () => {
  it("lists no ChatGPT provider on an instance that does not serve it", async () => {
    const { app } = await server("off")
    const data = await (await app.fetch(new Request("http://localhost/providers/status"))).json() as { providers: Array<{ id: string }> }
    expect(data.providers.map(p => p.id)).toEqual(["claude", "antigravity"])
  })

  it("shows ChatGPT seats and their state without exposing any token", async () => {
    writePool([account(0), account(1, { enabled: false })])
    const { app } = await server("follow-external")
    await (await app.fetch(responses(LUNA))).text()
    const res = await app.fetch(new Request("http://localhost/providers/status"))
    const text = await res.text()
    const data = JSON.parse(text) as { providers: Array<{ id: string; enabled: boolean; activity?: { requests: number }; accounts: Array<{ id: string; label?: string; error?: string }> }> }
    const chatgpt = data.providers.find(p => p.id === "chatgpt")!
    expect(chatgpt.enabled).toBe(true)
    expect(chatgpt.activity?.requests).toBe(1)
    expect(chatgpt.accounts.map(a => [a.id, a.label, a.error ?? null])).toEqual([
      ["user-0__workspace-0", "seat0@example.test · id:pace-0", null],
      ["user-1__workspace-1", "seat1@example.test · id:pace-1", "Disabled by its credential owner."],
    ])
    expect(text).not.toMatch(/at-0|at-1|rt-0|rt-1/)
    const view = await (await app.fetch(new Request("http://localhost/providers/view?provider=chatgpt"))).text()
    expect(view).toContain("OpenAI subscription")
  })

  it("tells apart one person's seats in different workspaces, on the page and in telemetry", async () => {
    const sameEmail = { email: "shared@example.test" }
    writePool([
      account(0, { ...sameEmail, accountId: "ws-aaaaaa", accountUserId: "user-shared__ws-aaaaaa", accessToken: "at-a" }),
      account(1, { ...sameEmail, accountId: "ws-bbbbbb", accountUserId: "user-shared__ws-bbbbbb", accessToken: "at-b" }),
    ])
    respond = call => call.authorization === "Bearer at-a" ? refused() : completed()
    const { app } = await server("follow-external")
    await (await app.fetch(responses(LUNA))).text()

    const text = await (await app.fetch(new Request("http://localhost/providers/status"))).text()
    const chatgpt = (JSON.parse(text) as { providers: Array<{ id: string; accounts: Array<{ id: string; label?: string }> }> })
      .providers.find(p => p.id === "chatgpt")!
    expect(chatgpt.accounts.map(a => a.id)).toEqual(["user-shared__ws-aaaaaa", "user-shared__ws-bbbbbb"])
    expect(chatgpt.accounts.map(a => a.label)).toEqual(["shared@example.test · id:aaaaaa", "shared@example.test · id:bbbbbb"])
    expect(text).not.toMatch(/at-a|at-b|rt-0|rt-1/)

    const view = await (await app.fetch(new Request("http://localhost/providers/view?provider=chatgpt"))).text()
    expect(view).toContain("shared@example.test · id:aaaaaa")
    expect(view).toContain("shared@example.test · id:bbbbbb")

    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric!.profileId).toBe("shared-bbbbbb")
  })
})

describe("offered models follow the backend's catalog", () => {
  const catalogBody = {
    models: [
      { slug: "gpt-6-luna", visibility: "list", display_name: "GPT-6-Luna", context_window: 272000, available_in_plans: ["pro"] },
      { slug: "gpt-daybreak-red-latest", visibility: "hide", available_in_plans: ["pro"] },
      { slug: "gpt-team-only", visibility: "list", available_in_plans: ["team"] },
    ],
  }
  const openAiIds = async (app: { fetch: (request: Request) => Response | Promise<Response> }) => {
    const res = await app.fetch(new Request("http://localhost/v1/models"))
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string; owned_by: string; context_window: number }> }
    expect(body.data.some(model => model.owned_by === "anthropic")).toBe(true)
    return body.data.filter(model => model.owned_by === "openai")
  }
  const providerModels = async (app: { fetch: (request: Request) => Response | Promise<Response> }) => {
    const data = await (await app.fetch(new Request("http://localhost/providers/status"))).json() as { providers: Array<{ id: string; models: string[]; capabilities?: Array<{ name: string; status: string }> }> }
    return data.providers.find(p => p.id === "chatgpt")!
  }

  it("offers the listed models of the seats' plans on /v1/models and /providers, and still routes the rest", async () => {
    writePool([account(0, { planType: "pro" })])
    catalog = () => new Response(JSON.stringify(catalogBody), { status: 200, headers: { "content-type": "application/json" } })
    const { app } = await server("follow-external")
    const offered = await openAiIds(app)
    expect(offered.map(model => [model.id, model.context_window])).toEqual([["gpt-6-luna", 272000]])
    expect(catalogCalls).toEqual([{ authorization: "Bearer at-0" }])
    const provider = await providerModels(app)
    expect(provider.models).toEqual(["gpt-6-luna"])
    expect(provider.capabilities?.find(row => row.name === "Models")?.status).toBe("catalog")

    const res = await app.fetch(responses({ ...LUNA, model: "gpt-team-only" }))
    expect(res.status).toBe(200)
    expect(upstreamCalls.map(call => call.body.model)).toEqual(["gpt-team-only"])
    expect(sdkCalls).toBe(0)
  })

  it("offers the built-in list while the catalog cannot be read", async () => {
    writePool([account(0, { planType: "pro" })])
    const { app } = await server("follow-external")
    expect((await openAiIds(app)).map(model => model.id)).toEqual([...CHATGPT_MODELS])
    expect((await providerModels(app)).capabilities?.find(row => row.name === "Models")?.status).toBe("built-in")
  })

  it("offers no ChatGPT model when the gateway is off", async () => {
    writePool([account(0)])
    const { app } = await server("off")
    expect(await openAiIds(app)).toEqual([])
    expect(catalogCalls).toEqual([])
  })

  it("control: owned mode never refreshes a token near expiry to read the catalog", async () => {
    const storePath = join(dir, "chatgpt-accounts.json")
    process.env.MERIDIAN_CHATGPT_STORE_PATH = storePath
    writeFileSync(storePath, JSON.stringify({ version: 1, accounts: [{
      accountUserId: "user-0__workspace-0", accountId: "workspace-0", email: null, refreshToken: "rt-0",
      accessToken: "at-0", expiresAt: Date.now() + 60_000, tokenRotatedAt: null, exchangeStartedAt: null,
    }] }))
    catalog = () => new Response(JSON.stringify(catalogBody), { status: 200, headers: { "content-type": "application/json" } })
    const proxy = await server("owned")
    await proxy.chatGpt!.acquire()
    try {
      expect((await openAiIds(proxy.app)).map(model => model.id)).toEqual([...CHATGPT_MODELS])
      expect(tokenCalls).toBe(0)
      expect(catalogCalls).toEqual([])
      const res = await proxy.app.fetch(responses(LUNA))
      expect(res.status).toBe(200)
      expect(tokenCalls).toBe(1)
    } finally {
      proxy.chatGpt!.release()
    }
  })
})

describe("ChatGPT seats on the profile surface", () => {
  type ListBody = { profiles: Array<Record<string, unknown>>; activeProfile: string | null; activeProfiles?: { claude: string | null; chatgpt: string | null } }
  type QuotaBody = { profiles: Array<{ id: string; type: string; isActive: boolean; windows: Array<{ type: string; utilization: number | null; resetsAt: number | null }>; windowsReported: string[] | null; windowSource: string | null; error: string | null; spent: unknown }>; activeProfile: string | null; activeProfiles?: { chatgpt: string | null } }
  type App = { fetch: (r: Request) => Response | Promise<Response> }
  const get = async <T>(app: App, path: string) => {
    const res = await app.fetch(new Request(`http://localhost${path}`))
    const text = await res.text()
    expect(text).not.toMatch(/"at-\d|"rt-\d/)
    return JSON.parse(text) as T
  }
  const post = (app: App, path: string, body?: unknown) =>
    app.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }))
  const rateLimited = (headers: Record<string, string>) =>
    new Response(JSON.stringify({ detail: "usage limit" }), { status: 429, headers: { "content-type": "application/json", ...headers } })

  it("lists each seat as a chatgpt profile with its plan weight, and no dead default", async () => {
    writePool([account(0, { planType: "pro" }), account(1, { planType: "self_serve_business_prolite" }), account(2, { expiresAt: NOW - 1 })])
    const { app } = await server("follow-external")
    const list = await get<ListBody>(app, "/profiles/list")
    expect(list.profiles.map(p => [p.id, p.type, p.provider, p.allowanceWeight, p.loggedIn, p.isActive])).toEqual([
      ["seat0-pace-0", "chatgpt", "chatgpt", 20, true, true],
      ["seat1-pace-1", "chatgpt", "chatgpt", 5, true, false],
      ["seat2-pace-2", "chatgpt", "chatgpt", null, false, false],
    ])
    expect(list.profiles[0]).toMatchObject({ subscriptionType: "pro", planLabel: "Personal Pro", seat: "user-0__workspace-0", label: "seat0@example.test · id:pace-0" })
    expect(list.activeProfile).toBe("seat0-pace-0")
    expect(list.activeProfiles).toEqual({ claude: null, chatgpt: "seat0-pace-0" })

    const quota = await get<QuotaBody>(app, "/v1/usage/quota/all")
    expect(quota.profiles.map(p => [p.id, p.type, p.windowsReported, p.error])).toEqual([
      ["seat0-pace-0", "chatgpt", null, "invalid_token"],
      ["seat1-pace-1", "chatgpt", null, "invalid_token"],
      ["seat2-pace-2", "chatgpt", null, "token_expired"],
    ])
    expect(quota.activeProfile).toBe("seat0-pace-0")
  })

  it("reports the windows each seat's backend states: weekly-only has no five_hour, a cold window has no reset", async () => {
    writePool([account(0), account(1)])
    respond = call => call.accountId === "workspace-0"
      ? completed("pong", codexWindows([{ minutes: 10080, used: 67, resetInS: 3 * 86400 }]))
      : completed("pong", codexWindows([{ minutes: 300, used: 0, resetInS: 18000 }, { minutes: 10080, used: 37, resetInS: 5 * 86400 }]))
    const { app } = await server("follow-external")
    await (await app.fetch(responses(LUNA, { "x-meridian-profile": "seat0-pace-0" }))).text()
    await (await app.fetch(responses(LUNA, { "x-meridian-profile": "seat1-pace-1" }))).text()
    expect(upstreamCalls.map(c => c.accountId)).toEqual(["workspace-0", "workspace-1"])

    const quota = await get<QuotaBody>(app, "/v1/usage/quota/all")
    const [weekly, both] = quota.profiles
    expect(weekly!.windowsReported).toEqual(["seven_day"])
    expect(weekly!.windows.map(w => w.type)).toEqual(["seven_day"])
    expect(weekly!.windows[0]!.utilization).toBe(0.67)
    expect(weekly!.windows[0]!.resetsAt).toBeGreaterThan(Date.now())
    expect(weekly!.windowSource).toBe("headers")
    expect(weekly!.error).toBeNull()
    expect(both!.windowsReported).toEqual(["five_hour", "seven_day"])
    expect(both!.windows[0]).toEqual({ type: "five_hour", utilization: 0, resetsAt: null })
    expect(both!.windows[1]!.utilization).toBe(0.37)
  })

  it("routes unpinned turns to the active seat, refuses an excluded one, persists the pointer", async () => {
    writePool([account(0), account(1), account(2)])
    const { app } = await server("follow-external")
    const switched = await post(app, "/profiles/active", { profile: "seat1-pace-1" })
    expect(switched.status).toBe(200)
    expect(await switched.json()).toEqual({ success: true, activeProfile: "seat1-pace-1", provider: "chatgpt" })
    await (await app.fetch(responses(LUNA))).text()
    expect(upstreamCalls.map(c => c.accountId)).toEqual(["workspace-1"])
    expect((await get<ListBody>(app, "/profiles/list")).activeProfile).toBe("seat1-pace-1")

    // The raw seat id is accepted too, and the pointer survives a new instance.
    expect((await post(app, "/profiles/active", { profile: "user-2__workspace-2" })).status).toBe(200)
    const { app: restarted } = await server("follow-external")
    expect((await get<QuotaBody>(restarted, "/v1/usage/quota/all")).activeProfiles?.chatgpt).toBe("seat2-pace-2")

    expect((await post(app, "/profiles/active", { profile: "nobody" })).status).toBe(400)
  })

  it("publishes refusals, failovers and pool exhaustion to the events ring and spent", async () => {
    writePool([account(0), account(1)])
    const before = snapshotPoolDir()
    respond = call => call.accountId === "workspace-0"
      ? rateLimited(codexWindows([{ minutes: 300, used: 40, resetInS: 3600 }, { minutes: 10080, used: 100, resetInS: 2 * 86400 }]))
      : completed()
    const { app } = await server("follow-external")
    expect((await app.fetch(responses(LUNA))).status).toBe(200)

    type Events = { events: Array<{ kind: string; profile: string; servedBy: string | null; reason: string; provider?: string; until: number | null; limit: { bucket: string | null; source: string; reported: boolean } | null }>; nextSince: number }
    const page = await get<Events>(app, "/profiles/events?since=0")
    expect(page.events.map(e => [e.kind, e.profile, e.servedBy, e.reason, e.provider])).toEqual([
      ["refused", "seat0-pace-0", null, "rate_limit_error", "chatgpt"],
      ["failover", "seat0-pace-0", "seat1-pace-1", "rate_limit_error", "chatgpt"],
    ])
    expect(page.events[0]!.limit).toMatchObject({ bucket: "seven_day", source: "response_headers", reported: true })
    expect(page.events[0]!.until).toBeGreaterThan(Date.now() + 86400_000)
    const quota = await get<QuotaBody>(app, "/v1/usage/quota/all")
    expect(quota.profiles.find(p => p.id === "seat0-pace-0")!.spent).toMatchObject({ profileId: "seat0-pace-0" })

    respond = () => refused()
    await (await app.fetch(responses(LUNA, { "x-meridian-profile": "seat1-pace-1" }))).text()
    const next = await get<Events>(app, `/profiles/events?since=${page.nextSince}`)
    expect(next.events.map(e => [e.kind, e.profile, e.reason])).toEqual([
      ["refused", "seat1-pace-1", "authentication_error"],
      ["pool_exhausted", "seat1-pace-1", "authentication_error"],
    ])
    expect(tokenCalls).toBe(0)
    expect(snapshotPoolDir()).toEqual(before)
  })

  /** An access token shaped like the real one, so the usage reader will use it. */
  const seatToken = (n: number, expSeconds = Math.floor(NOW / 1000) + 3600) => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
    return `${part({ alg: "RS256" })}.${part({
      exp: expSeconds,
      "https://api.openai.com/auth": {
        chatgpt_account_id: `workspace-${n}`, chatgpt_account_user_id: `user-${n}__workspace-${n}`,
        chatgpt_user_id: `user-${n}`, chatgpt_plan_type: "pro",
      },
    })}.sig`
  }

  it("states each seat's banked resets and workspace from what oc-codex-multi-auth reads, never refreshing a token to read them", async () => {
    resetCodexUsageCache()
    const live = seatToken(0)
    const expired = seatToken(1, Math.floor(NOW / 1000) - 60)
    writePool([account(0, { accessToken: live, planType: "pro" }), account(1, { accessToken: expired, expiresAt: NOW - 60_000 })])
    const soon = NOW + 3 * 86_400_000 + 3_600_000
    const later = NOW + 11 * 86_400_000 + 3_600_000
    wham = (url, authorization) => {
      if (authorization !== `Bearer ${live}`) return new Response("{}", { status: 401 })
      if (url.endsWith("/wham/usage")) {
        return Response.json({
          user_id: "user-0", account_id: "workspace-0", email: "seat0@example.test", plan_type: "pro",
          rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: Math.floor(NOW / 1000) + 3 * 86_400 }, secondary_window: null },
          rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
        })
      }
      if (url.endsWith("/wham/accounts/check")) {
        return Response.json({ accounts: [{ id: "workspace-0", structure: "workspace", name: "Acme Workspace" }] })
      }
      if (url.endsWith("/wham/rate-limit-reset-credits")) {
        return Response.json({
          available_count: 2,
          credits: [
            { id: "c-later", status: "available", expires_at: new Date(later).toISOString() },
            { id: "c-spent", status: "redeemed", expires_at: new Date(soon).toISOString() },
            { id: "c-soon", status: "available", expires_at: new Date(soon).toISOString() },
          ],
        })
      }
      return undefined
    }
    const before = snapshotPoolDir()
    const { app } = await server("follow-external")
    await get<QuotaBody>(app, "/v1/usage/quota/all")
    const list = await get<ListBody>(app, "/profiles/list")
    expect(JSON.stringify(list)).not.toContain(live)
    expect(JSON.stringify(list)).not.toContain(expired)
    expect(list.profiles[0]).toMatchObject({ id: "seat0-pace-0", loggedIn: true, tokenState: "ok", organizationName: "Acme Workspace", resets: { available: 2, expiresAt: [soon, later] } })
    // No valid token, so nothing was asked: the card says "unknown".
    expect(list.profiles[1]).toMatchObject({ id: "seat1-pace-1", loggedIn: false, tokenState: "expired", organizationName: null, resets: null })
    expect(whamCalls.map(c => c.url.slice(WHAM_PREFIX.length)).sort()).toEqual(["accounts/check", "rate-limit-reset-credits", "usage"])
    expect(whamCalls.every(c => c.method === "GET" && c.authorization === `Bearer ${live}`)).toBe(true)
    expect(tokenCalls).toBe(0)
    expect(snapshotPoolDir()).toEqual(before)
  })

  const stampedSeatWithCredits = () => {
    resetCodexUsageCache()
    const live = seatToken(0)
    writePool([account(0, { accessToken: live, quotaExhaustedUntil: NOW + 3 * 86_400_000 })])
    wham = (url) => url.endsWith("/wham/usage") ? Response.json({
      user_id: "user-0", account_id: "workspace-0", email: "seat0@example.test", plan_type: "pro",
      rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 100, limit_window_seconds: 604_800, reset_at: Math.floor(NOW / 1000) + 3 * 86_400 }, secondary_window: null },
      credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: "62500" },
    }) : undefined
    return live
  }
  type CreditsQuota = { profiles: Array<{ id: string; credits: { balance: number | null } | null; creditsPolicy: string | null; creditsPolicySource: string | null; planSpent: boolean; servingOnCredits: boolean }> }

  it("serves a seat the owner stamped as spent on its Codex credits under the reserve policy, and says so on its card", async () => {
    const live = stampedSeatWithCredits()
    saveSettings({ chatgpt: { creditsPolicy: "reserve" } })
    const before = snapshotPoolDir()
    const { app } = await server("follow-external")
    const response = await app.fetch(responses(LUNA))
    expect(response.status).toBe(200)
    await response.text()
    expect(upstreamCalls.map(call => call.authorization)).toEqual([`Bearer ${live}`])
    expect(whamCalls.some(call => call.url.endsWith("/wham/usage"))).toBe(true)
    expect(tokenCalls).toBe(0)
    expect(snapshotPoolDir()).toEqual(before)

    const quota = await (await app.fetch(new Request("http://localhost/v1/usage/quota/all"))).json() as CreditsQuota
    expect(quota.profiles[0]).toMatchObject({
      credits: { balance: 62_500 }, creditsPolicy: "reserve", creditsPolicySource: "default", planSpent: true, servingOnCredits: true,
    })
  })

  it("leaves a plan-exhausted seat idle by default, however many credits it holds", async () => {
    stampedSeatWithCredits()
    const { app } = await server("follow-external")
    const response = await app.fetch(responses(LUNA))
    expect(response.status).toBe(429)
    await response.text()
    expect(upstreamCalls).toEqual([])

    const quota = await (await app.fetch(new Request("http://localhost/v1/usage/quota/all"))).json() as CreditsQuota
    expect(quota.profiles[0]).toMatchObject({ creditsPolicy: "never", planSpent: true, servingOnCredits: false })
  })

  it("renames a seat the way a Claude profile is renamed: the old name keeps answering", async () => {
    writePool([account(0), account(1)])
    const before = snapshotPoolDir()
    const { app } = await server("follow-external")
    const renamed = await post(app, "/profiles/rename", { from: "seat0-pace-0", to: "enrique-pro" })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toEqual({ success: true, from: "seat0-pace-0", to: "enrique-pro", aliases: ["seat0-pace-0"], provider: "chatgpt" })
    const list = await get<ListBody>(app, "/profiles/list")
    expect(list.profiles.map(p => [p.id, p.aliases ?? null])).toEqual([["enrique-pro", ["seat0-pace-0"]], ["seat1-pace-1", null]])

    // The former id still selects the seat and pins a request to it.
    expect(await (await post(app, "/profiles/active", { profile: "seat0-pace-0" })).json()).toEqual({ success: true, activeProfile: "enrique-pro", provider: "chatgpt" })
    await (await app.fetch(responses(LUNA, { "x-meridian-profile": "seat0-pace-0" }))).text()
    expect(upstreamCalls.map(c => c.accountId)).toEqual(["workspace-0"])
    expect(telemetryStore.getRecent({ limit: 1 })[0]).toMatchObject({ adapter: "chatgpt", profileId: "enrique-pro" })

    expect((await post(app, "/profiles/rename", { from: "enrique-pro", to: "seat1-pace-1" })).status).toBe(400)
    expect((await post(app, "/profiles/rename", { from: "enrique-pro", to: "Enrique Pro" })).status).toBe(400)
    // A name is Meridian's setting: the owner's store is not touched.
    expect(snapshotPoolDir()).toEqual(before)
    expect(tokenCalls).toBe(0)
  })

  it("answers a remove of a followed seat with where to remove it, and removes nothing", async () => {
    writePool([account(0), account(1)])
    const before = snapshotPoolDir()
    const { app } = await server("follow-external")
    const res = await post(app, "/profiles/chatgpt/remove", { profile: "seat1-pace-1" })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; code: string; provider: string }
    expect(body).toMatchObject({ code: "owned_elsewhere", provider: "chatgpt" })
    expect(body.error).toContain("oc-codex-multi-auth owns")
    expect(body.error).toContain("codex-remove index=2 confirm=true")
    expect((await get<ListBody>(app, "/profiles/list")).profiles.map(p => p.id)).toEqual(["seat0-pace-0", "seat1-pace-1"])
    expect(snapshotPoolDir()).toEqual(before)
  })

  it("says who owns the seats' logins, and keeps a Claude profile off a seat's name", async () => {
    writePool([account(0)])
    const { app } = await server("follow-external")
    const list = await get<ListBody & { chatgpt?: { owner: Record<string, unknown> } }>(app, "/profiles/list")
    expect(list.chatgpt?.owner).toMatchObject({ name: "oc-codex-multi-auth", mode: "follow-external", login: "opencode auth login" })
    expect(list.profiles[0]).toMatchObject({ owner: { account: 1, remove: "codex-remove index=1 confirm=true" } })
    expect((await post(app, "/profiles/add/start", { profile: "seat0-pace-0" })).status).toBe(400)
  })

  it("fails over in the order saved on the Profiles page, after the active seat", async () => {
    writePool([account(0), account(1), account(2)])
    const { app } = await server("follow-external")
    const saved = await app.fetch(new Request("http://localhost/settings/api/routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileOrder: ["seat2-pace-2", "seat1-pace-1", "seat0-pace-0"] }),
    }))
    expect(saved.status).toBe(200)
    const routing = await get<{ profiles: string[]; profileOrder: string[] }>(app, "/settings/api/routing")
    expect(routing.profiles).toEqual(["seat0-pace-0", "seat1-pace-1", "seat2-pace-2"])
    expect(routing.profileOrder).toEqual(["seat2-pace-2", "seat1-pace-1", "seat0-pace-0"])

    respond = call => call.accountId === "workspace-0"
      ? rateLimited(codexWindows([{ minutes: 10080, used: 100, resetInS: 86400 }]))
      : completed()
    const res = await app.fetch(responses(LUNA))
    expect(res.status).toBe(200)
    await res.text()
    // The owner's pick (seat 0) leads; the saved order, not the store's, follows.
    expect(upstreamCalls.map(c => c.accountId)).toEqual(["workspace-0", "workspace-2"])
  })
})

describe("owned mode signs its own seats in", () => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const signedIn = `${part({ alg: "none" })}.${part({
    exp: Math.floor(NOW / 1000) + 3600,
    email: "fresh@example.test",
    "https://api.openai.com/auth": { chatgpt_account_id: "workspace-9", chatgpt_account_user_id: "user-9__workspace-9" },
  })}.sig`
  const post = (app: { fetch: (r: Request) => Response | Promise<Response> }, path: string, body: unknown) =>
    app.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))

  let storeDir: string
  let storePath: string
  let codeExchanges = 0
  let devicePolls = 0
  let deviceEntered = false
  beforeEach(() => {
    storeDir = join(dir, "meridian-gpt")
    storePath = join(storeDir, "chatgpt-accounts.json")
    process.env.MERIDIAN_CHATGPT_STORE_PATH = storePath
    codeExchanges = 0
    devicePolls = 0
    deviceEntered = false
    __setChatGptLoginListenOverride(async () => null)
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === TOKEN_URL && new URLSearchParams(String(init?.body)).get("grant_type") === "authorization_code") {
        codeExchanges++
        return new Response(JSON.stringify({ access_token: signedIn, refresh_token: "rt-signed-in", id_token: signedIn, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
        return Promise.resolve(Response.json({ device_auth_id: "dev-9", user_code: "WXYZ-0001", interval: "0" }))
      }
      if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
        devicePolls++
        return Promise.resolve(deviceEntered
          ? Response.json({ authorization_code: "auth-9", code_challenge: "c", code_verifier: "v" })
          : new Response("", { status: 403 }))
      }
      return mockFetch(input, init)
    }) as typeof fetch
  })
  afterEach(() => { __setChatGptLoginListenOverride(null) })

  it("starts with an empty store, takes the lease, and tells a GPT client to connect an account", async () => {
    const proxy = await server("owned")
    await proxy.chatGpt!.acquire()
    try {
      expect(existsSync(`${storePath}.lock`)).toBe(true)
      const res = await proxy.app.fetch(responses(LUNA))
      expect(res.status).toBe(401)
      const body = await res.json() as { error: { type: string; message: string } }
      expect(body.error.type).toBe("authentication_error")
      expect(body.error.message).toContain("No ChatGPT account is connected")
      expect(body.error.message).toContain("/profiles")
      expect(upstreamCalls).toHaveLength(0)
      expect(sdkCalls).toBe(0)
      expect(existsSync(storePath)).toBe(false)
    } finally {
      proxy.chatGpt!.release()
    }
  })

  it("signs a seat in from the web UI into a private store, then serves and renews it", async () => {
    const proxy = await server("owned")
    await proxy.chatGpt!.acquire()
    try {
      const list = await (await proxy.app.fetch(new Request("http://localhost/profiles/list"))).json() as { chatgpt: { owner: Record<string, unknown> } }
      expect(list.chatgpt.owner).toMatchObject({ name: "meridian", mode: "owned", webSignIn: true })

      const started = await (await post(proxy.app, "/profiles/chatgpt/connect/start", { returnTo: "https://meridian.example/profiles" })).json() as { connectId: string; authorizeUrl: string; loopback: boolean }
      expect(started.loopback).toBe(false)
      const state = new URL(started.authorizeUrl).searchParams.get("state")
      const done = await post(proxy.app, "/profiles/chatgpt/connect/complete", {
        connectId: started.connectId, url: `http://127.0.0.1:1455/auth/callback?code=one-time&state=${state}`,
      })
      const doneText = await done.text()
      expect(done.status).toBe(200)
      expect(doneText).not.toContain("rt-signed-in")
      expect(JSON.parse(doneText)).toEqual({ success: true, seat: "user-9__workspace-9", email: "fresh@example.test" })
      expect(codeExchanges).toBe(1)

      const status = await (await proxy.app.fetch(new Request(`http://localhost/profiles/chatgpt/connect/status?connectId=${started.connectId}`))).json()
      expect(status).toMatchObject({ status: "completed", accountUserId: "user-9__workspace-9" })

      expect(statSync(storeDir).mode & 0o777).toBe(0o700)
      expect(statSync(storePath).mode & 0o777).toBe(0o600)
      const stored = JSON.parse(readFileSync(storePath, "utf8")) as { accounts: Array<Record<string, unknown>> }
      expect(stored.accounts.map(a => [a.accountUserId, a.accountId, a.email, a.exchangeStartedAt])).toEqual([["user-9__workspace-9", "workspace-9", "fresh@example.test", null]])

      const served = await proxy.app.fetch(responses(LUNA))
      expect(served.status).toBe(200)
      await served.text()
      expect(upstreamCalls.at(-1)).toMatchObject({ authorization: `Bearer ${signedIn}`, accountId: "workspace-9" })
      expect(tokenCalls).toBe(0)

      const profiles = await (await proxy.app.fetch(new Request("http://localhost/profiles/list"))).json() as { profiles: Array<{ id: string; seat?: string }> }
      const seat = profiles.profiles.find(p => p.seat === "user-9__workspace-9")!
      const renewed = await post(proxy.app, "/profiles/chatgpt/refresh", { profile: seat.id })
      expect(renewed.status).toBe(200)
      expect(await renewed.json()).toMatchObject({ status: "refreshed", profile: seat.id })
      expect(tokenCalls).toBe(1)
      const rotated = JSON.parse(readFileSync(storePath, "utf8")) as { accounts: Array<Record<string, unknown>> }
      expect(rotated.accounts[0]).toMatchObject({ refreshToken: "rt-rotated", accessToken: "at-refreshed", exchangeStartedAt: null })
    } finally {
      proxy.chatGpt!.release()
    }
  })

  it("signs a seat in by device code under the name typed for it, keeping the derived id as an alias", async () => {
    const proxy = await server("owned")
    await proxy.chatGpt!.acquire()
    try {
      const refused = await post(proxy.app, "/profiles/chatgpt/connect/device", { name: "Not Valid!" })
      expect(refused.status).toBe(400)
      expect(await refused.json()).toMatchObject({ code: "invalid_profile_id" })

      const startedRes = await post(proxy.app, "/profiles/chatgpt/connect/device", { name: "work-pro" })
      expect(startedRes.status).toBe(200)
      const started = await startedRes.json() as { connectId: string; userCode: string; verificationUrl: string }
      expect(started).toMatchObject({ userCode: "WXYZ-0001", verificationUrl: "https://auth.openai.com/codex/device" })

      const deadline = Date.now() + 10_000
      while (devicePolls === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
      expect(devicePolls).toBeGreaterThan(0)
      expect(codeExchanges).toBe(0)
      deviceEntered = true
      let status: { status?: string } = {}
      while (status.status !== "completed" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
        status = await (await proxy.app.fetch(new Request(`http://localhost/profiles/chatgpt/connect/status?connectId=${started.connectId}`))).json() as { status?: string }
      }
      expect(status).toMatchObject({ status: "completed", accountUserId: "user-9__workspace-9" })
      expect(codeExchanges).toBe(1)

      const list = await (await proxy.app.fetch(new Request("http://localhost/profiles/list"))).json() as { profiles: Array<{ id: string; seat?: string; aliases?: string[] }> }
      const seat = list.profiles.find(p => p.seat === "user-9__workspace-9")!
      expect(seat.id).toBe("work-pro")
      expect(seat.aliases).toContain("fresh-pace-9")
    } finally {
      proxy.chatGpt!.release()
    }
  })

  it("signs a dead seat in again from its card under the same name, and refuses a sign-in as another seat", async () => {
    const proxy = await server("owned")
    await proxy.chatGpt!.acquire()
    const signIn = async (body: Record<string, unknown>) => {
      const started = await (await post(proxy.app, "/profiles/chatgpt/connect/start", body)).json() as { connectId: string; authorizeUrl: string }
      const state = new URL(started.authorizeUrl).searchParams.get("state")
      return post(proxy.app, "/profiles/chatgpt/connect/complete", { connectId: started.connectId, url: `?code=c&state=${state}` })
    }
    const listed = async () => (await (await proxy.app.fetch(new Request("http://localhost/profiles/list"))).json() as {
      profiles: Array<{ id: string; seat?: string; aliases?: string[]; unavailable?: string | null }>
    }).profiles
    try {
      expect((await signIn({ name: "work-pro" })).status).toBe(200)
      const stored = () => JSON.parse(readFileSync(storePath, "utf8")) as { version: number; accounts: Array<Record<string, unknown>> }
      const doc = stored()
      // A refresh that died mid-exchange leaves the seat needing a login, as on the live host.
      doc.accounts[0]!.exchangeStartedAt = 1
      doc.accounts.push({ ...doc.accounts[0], accountUserId: "user-1__ws-1", accountId: "ws-1", email: "other@example.test", refreshToken: "rt-other", exchangeStartedAt: null })
      writeFileSync(storePath, JSON.stringify(doc))
      expect((await listed()).find(p => p.id === "work-pro")?.unavailable).toBe("requires_reauth")
      const other = (await listed()).find(p => p.seat === "user-1__ws-1")!

      const unknown = await post(proxy.app, "/profiles/chatgpt/connect/start", { profile: "no-such-seat" })
      expect(unknown.status).toBe(404)
      expect(await unknown.json()).toMatchObject({ code: "unknown_profile" })

      const wrong = await signIn({ profile: other.id })
      expect(wrong.status).toBe(409)
      const refusal = await wrong.json() as { code: string; error: string }
      expect(refusal.code).toBe("wrong_account")
      expect(refusal.error).toContain("fresh@example.test")
      expect(refusal.error).toContain(other.id)
      expect(stored().accounts.find(a => a.accountUserId === "user-1__ws-1")).toMatchObject({ refreshToken: "rt-other", email: "other@example.test" })

      const again = await signIn({ profile: "work-pro" })
      expect(again.status).toBe(200)
      expect(await again.json()).toEqual({ success: true, seat: "user-9__workspace-9", email: "fresh@example.test" })
      expect(stored().accounts.map(a => [a.accountUserId, a.exchangeStartedAt])).toEqual([["user-9__workspace-9", null], ["user-1__ws-1", null]])
      const seat = (await listed()).find(p => p.seat === "user-9__workspace-9")!
      expect(seat).toMatchObject({ id: "work-pro", unavailable: null })
      expect(seat.aliases).toContain("fresh-pace-9")
    } finally {
      proxy.chatGpt!.release()
    }
  })

  it("removes an owned seat: credentials, name, order and credits override go; the active pointer moves on", async () => {
    mkdirSync(storeDir, { recursive: true, mode: 0o700 })
    const stored = (n: number, extra: Record<string, unknown> = {}) => ({
      accountUserId: `user-${n}__workspace-${n}`, accountId: `workspace-${n}`, email: `s${n}@example.test`,
      refreshToken: `rt-${n}`, accessToken: signedIn, expiresAt: NOW + 3_600_000, tokenRotatedAt: NOW, exchangeStartedAt: null, ...extra,
    })
    // Seat 1's refresh died mid-exchange: removing a seat that needs a login must work too.
    const freeToken = `${part({ alg: "none" })}.${part({
      exp: Math.floor(NOW / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "workspace-2", chatgpt_account_user_id: "user-2__workspace-2", chatgpt_plan_type: "free" },
    })}.sig`
    writeFileSync(storePath, JSON.stringify({ version: 1, accounts: [stored(0), stored(1, { exchangeStartedAt: 1 }), stored(2, { accessToken: freeToken })] }), { mode: 0o600 })
    saveSettings({
      chatGptProfileNames: { "user-0__workspace-0": "zero", "user-1__workspace-1": "dead-one" },
      chatGptProfileAliases: { "user-1__workspace-1": ["s1-kspace-1"] },
      profileOrder: ["dead-one", "two-x", "zero"],
      chatGptActiveSeat: "user-1__workspace-1",
      chatgpt: { seatCreditsPolicy: { "user-1__workspace-1": "immediately", "user-0__workspace-0": "reserve" } },
    })
    const proxy = await server("owned")
    await proxy.chatGpt!.acquire()
    try {
      const listed = async () => (await (await proxy.app.fetch(new Request("http://localhost/profiles/list"))).json() as {
        activeProfiles?: { chatgpt: string | null }; profiles: Array<{ id: string; seat?: string; planTier?: string | null }>
      })
      const seat2 = (await listed()).profiles.find(p => p.seat === "user-2__workspace-2")!.id
      saveSettings({ profileOrder: ["dead-one", seat2, "zero"] })

      const res = await post(proxy.app, "/profiles/chatgpt/remove", { profile: "s1-kspace-1" })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ success: true, profile: "dead-one", provider: "chatgpt", activeProfile: "zero" })

      const doc = JSON.parse(readFileSync(storePath, "utf8")) as { accounts: Array<{ accountUserId: string }> }
      expect(doc.accounts.map(a => a.accountUserId)).toEqual(["user-0__workspace-0", "user-2__workspace-2"])
      expect(getSetting("chatGptProfileNames")).toEqual({ "user-0__workspace-0": "zero" })
      expect(getSetting("chatGptProfileAliases")).toEqual({})
      expect(getSetting("profileOrder")).toEqual([seat2, "zero"])
      expect(getSetting("chatGptActiveSeat")).toBe("user-0__workspace-0")
      expect(getSetting("chatgpt")?.seatCreditsPolicy).toEqual({ "user-0__workspace-0": "reserve" })
      const after = await listed()
      expect(after.profiles.map(p => p.id)).toEqual(["zero", seat2])
      expect(after.activeProfiles?.chatgpt).toBe("zero")
      expect((await post(proxy.app, "/profiles/chatgpt/remove", { profile: "dead-one" })).status).toBe(404)

      expect(after.profiles.find(p => p.id === seat2)).toMatchObject({ planTier: "free" })
      // The paid successor goes too, so the pointer falls to the free seat, the only one left.
      expect((await post(proxy.app, "/profiles/chatgpt/remove", { profile: "zero" })).status).toBe(200)
      expect(getSetting("chatGptActiveSeat")).toBe("user-2__workspace-2")
      expect(getSetting("chatgpt")?.seatCreditsPolicy).toEqual({})
      expect(tokenCalls).toBe(0)

      const settings = async () => (await (await proxy.app.fetch(new Request("http://localhost/settings/api/chatgpt"))).json() as { features: { freeSeatOrder: string } }).features
      expect((await settings()).freeSeatOrder).toBe("before-credits")
      const patch = (body: unknown) => proxy.app.fetch(new Request("http://localhost/settings/api/chatgpt", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
      expect((await patch({ freeSeatOrder: "sometimes" })).status).toBe(400)
      expect((await patch({ freeSeatOrder: "after-credits" })).status).toBe(200)
      expect((await settings()).freeSeatOrder).toBe("after-credits")
      const entry = (await listed()).profiles[0] as Record<string, unknown>
      expect(entry).toHaveProperty("planTier")
      expect(entry).toHaveProperty("freeSeatDeferred")
    } finally {
      proxy.chatGpt!.release()
    }
  })

  it("renews a seat no work is sent to, so its token never runs out and it is never listed as logged out", async () => {
    mkdirSync(storeDir, { recursive: true, mode: 0o700 })
    const day = 24 * 3_600_000
    const token = (issuedAt: number) => `${part({ alg: "none" })}.${part({
      iat: Math.floor(issuedAt / 1000),
      exp: Math.floor((issuedAt + 10 * day) / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: "workspace-7", chatgpt_account_user_id: "user-7__workspace-7" },
    })}.sig`
    // Renewed ten days and two hours ago by a batch no request followed, as the four live seats were.
    const issuedAt = NOW - 10 * day - 2 * 3_600_000
    writeFileSync(storePath, JSON.stringify({ version: 1, accounts: [{
      accountUserId: "user-7__workspace-7", accountId: "workspace-7", email: "idle@example.test",
      refreshToken: "rt-idle", accessToken: token(issuedAt), expiresAt: issuedAt + 10 * day,
      tokenRotatedAt: issuedAt, exchangeStartedAt: null,
    }] }), { mode: 0o600 })
    let refreshes = 0
    const serve = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === TOKEN_URL && new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token") {
        refreshes++
        return Response.json({ access_token: token(Date.now()), refresh_token: "rt-renewed", expires_in: 10 * 86_400 })
      }
      return serve(input, init)
    }) as typeof fetch
    const proxy = await server("owned")
    await proxy.chatGpt!.acquire()
    try {
      // /v1/usage/quota/all waits for the usage read that /profiles/list only reports.
      const idle = async () => {
        await proxy.app.fetch(new Request("http://localhost/v1/usage/quota/all"))
        const list = await (await proxy.app.fetch(new Request("http://localhost/profiles/list"))).json() as {
          profiles: Array<{ seat?: string; loggedIn: boolean; tokenState?: string }>
        }
        return list.profiles.find(p => p.seat === "user-7__workspace-7")!
      }
      expect(await idle()).toMatchObject({ loggedIn: false, tokenState: "expired" })

      expect(await proxy.chatGpt!.renewDue()).toBe(true)
      expect(refreshes).toBe(1)
      const renewed = await idle()
      expect(renewed).toMatchObject({ loggedIn: true, tokenState: "ok" })
      const stored = JSON.parse(readFileSync(storePath, "utf8")).accounts[0]
      expect(stored).toMatchObject({ refreshToken: "rt-renewed", exchangeStartedAt: null })
      expect(stored.expiresAt).toBeGreaterThan(Date.now() + 9 * day)

      // Not due again for eight days.
      expect(await proxy.chatGpt!.renewDue()).toBe(false)
      expect(refreshes).toBe(1)
    } finally {
      proxy.chatGpt!.release()
    }
  })

  // Read while its renewal is out, a seat was listed as needing a sign-in for
  // as long as the exchange took, at every renewal.
  for (const ending of ["renewed", "refused"] as const) {
    it(`lists a seat as it was while its renewal is out, and as the exchange left it once it is done (${ending})`, async () => {
      mkdirSync(storeDir, { recursive: true, mode: 0o700 })
      const day = 24 * 3_600_000
      const seat = `user-8${ending}__workspace-8`
      const token = (issuedAt: number) => `${part({ alg: "none" })}.${part({
        iat: Math.floor(issuedAt / 1000),
        exp: Math.floor((issuedAt + 10 * day) / 1000),
        "https://api.openai.com/auth": { chatgpt_account_id: "workspace-8", chatgpt_account_user_id: seat },
      })}.sig`
      const issuedAt = NOW - 9 * day
      writeFileSync(storePath, JSON.stringify({ version: 1, accounts: [{
        accountUserId: seat, accountId: "workspace-8", email: "busy@example.test",
        refreshToken: "rt-busy", accessToken: token(issuedAt), expiresAt: issuedAt + 10 * day,
        tokenRotatedAt: issuedAt, exchangeStartedAt: null,
      }] }), { mode: 0o600 })
      let started = false
      let answer!: (response: Response) => void
      const serve = globalThis.fetch
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        if (url === TOKEN_URL && new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token") {
          started = true
          return new Promise<Response>(resolve => { answer = resolve })
        }
        return serve(input, init)
      }) as typeof fetch
      const proxy = await server("owned")
      await proxy.chatGpt!.acquire()
      try {
        const listed = async () => {
          await proxy.app.fetch(new Request("http://localhost/v1/usage/quota/all"))
          const list = await (await proxy.app.fetch(new Request("http://localhost/profiles/list"))).json() as {
            profiles: Array<{ seat?: string; loggedIn: boolean; tokenState?: string; firstUnauthedAt?: number | null }>
          }
          return list.profiles.find(p => p.seat === seat)!
        }
        expect(await listed()).toMatchObject({ loggedIn: true, tokenState: "ok" })

        const pass = proxy.chatGpt!.renewDue()
        while (!started) await new Promise(resolve => setTimeout(resolve, 5))
        expect(JSON.parse(readFileSync(storePath, "utf8")).accounts[0].exchangeStartedAt).not.toBeNull()
        expect(await listed()).toMatchObject({ loggedIn: true, tokenState: "ok" })

        if (ending === "renewed") {
          answer(Response.json({ access_token: token(Date.now()), refresh_token: "rt-renewed", expires_in: 10 * 86_400 }))
          expect(await pass).toBe(true)
          expect(await listed()).toMatchObject({ loggedIn: true, tokenState: "ok" })
        } else {
          answer(new Response(JSON.stringify({ error: { code: "refresh_token_reused" } }), { status: 401, headers: { "content-type": "application/json" } }))
          expect(await pass).toBe(false)
          expect(await listed()).toMatchObject({ loggedIn: false, tokenState: "requires_reauth" })
        }
      } finally {
        proxy.chatGpt!.release()
      }
    })
  }

  it("cancels a pending sign-in on request, so its code can no longer be spent", async () => {
    const proxy = await server("owned")
    await proxy.chatGpt!.acquire()
    try {
      const started = await (await post(proxy.app, "/profiles/chatgpt/connect/start", {})).json() as { connectId: string; authorizeUrl: string }
      const cancelled = await post(proxy.app, "/profiles/chatgpt/connect/cancel", { connectId: started.connectId })
      expect(await cancelled.json()).toEqual({ cancelled: true })
      const state = new URL(started.authorizeUrl).searchParams.get("state")
      const late = await post(proxy.app, "/profiles/chatgpt/connect/complete", {
        connectId: started.connectId, url: `http://127.0.0.1:1455/auth/callback?code=late&state=${state}`,
      })
      expect(late.status).not.toBe(200)
      expect(codeExchanges).toBe(0)
      expect(existsSync(storePath)).toBe(false)
    } finally {
      proxy.chatGpt!.release()
    }
  })

  it("refuses a ChatGPT change from a foreign page, and takes one from its own pages and the CLI", async () => {
    const proxy = await server("owned")
    await proxy.chatGpt!.acquire()
    try {
      const send = (method: string, path: string, origin?: string) => proxy.app.fetch(new Request(`http://localhost${path}`, {
        method, headers: { "content-type": "text/plain", ...(origin ? { origin } : {}) }, body: JSON.stringify({}),
      }))
      const changes: Array<[string, string]> = [
        ["POST", "/profiles/chatgpt/connect/start"], ["POST", "/profiles/chatgpt/connect/device"],
        ["POST", "/profiles/chatgpt/connect/cancel"], ["POST", "/profiles/chatgpt/connect/complete"],
        ["POST", "/profiles/chatgpt/refresh"], ["POST", "/profiles/chatgpt/remove"],
        ["PATCH", "/settings/api/chatgpt"], ["DELETE", "/settings/api/chatgpt"],
      ]
      for (const origin of ["https://evil.example", "null", "http://localhost:9999", "not a url"]) {
        for (const [method, path] of changes) expect([method, path, origin, (await send(method, path, origin)).status]).toEqual([method, path, origin, 403])
      }
      expect(codeExchanges).toBe(0)
      expect((await send("POST", "/profiles/chatgpt/connect/start", "http://localhost")).status).toBe(200)
      expect((await send("POST", "/profiles/chatgpt/connect/start")).status).toBe(200)
    } finally {
      proxy.chatGpt!.release()
    }
  })

  it("serves an owned store read-only under MERIDIAN_CREDENTIALS_READONLY: no lease, no renewal, no sign-in", async () => {
    mkdirSync(storeDir, { recursive: true, mode: 0o700 })
    const seat = (n: number, expiresAt: number) => ({
      accountUserId: `user-${n}__workspace-${n}`, accountId: `workspace-${n}`, email: `s${n}@example.test`,
      refreshToken: `rt-${n}`, accessToken: signedIn, expiresAt, tokenRotatedAt: NOW, exchangeStartedAt: null,
    })
    writeFileSync(storePath, JSON.stringify({ version: 1, accounts: [seat(0, Date.now() + 3_600_000)] }), { mode: 0o600 })
    const before = readFileSync(storePath, "utf8")
    let refreshes = 0
    const serve = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === TOKEN_URL) refreshes++
      return serve(input, init)
    }) as typeof fetch
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    try {
      const proxy = await server("owned")
      await proxy.chatGpt!.acquire()
      expect(existsSync(`${storePath}.lock`)).toBe(false)
      expect(proxy.chatGpt!.isServing()).toBe(true)
      expect((await proxy.app.fetch(responses(LUNA))).status).toBe(200)
      expect(upstreamCalls.map(c => c.accountId)).toEqual(["workspace-0"])

      for (const path of ["/profiles/chatgpt/connect/start", "/profiles/chatgpt/connect/device", "/profiles/chatgpt/refresh", "/profiles/chatgpt/remove"]) {
        const res = await post(proxy.app, path, { profile: "s0-kspace-0" })
        expect([path, res.status]).toEqual([path, 403])
      }
      expect(await proxy.chatGpt!.renewDue()).toBe(false)

      // A token the owner has not renewed is not renewed here either.
      writeFileSync(storePath, JSON.stringify({ version: 1, accounts: [seat(0, Date.now() - 1000)] }), { mode: 0o600 })
      expect((await proxy.app.fetch(responses(LUNA))).status).not.toBe(200)
      expect(refreshes).toBe(0)
      expect(upstreamCalls).toHaveLength(1)
      writeFileSync(storePath, before, { mode: 0o600 })
      proxy.chatGpt!.release()
    } finally {
      delete process.env.MERIDIAN_CREDENTIALS_READONLY
    }
  })

  it("refuses to sign a seat in where it follows another tool's store", async () => {
    writePool([account(0)])
    const proxy = await server("follow-external")
    const res = await post(proxy.app, "/profiles/chatgpt/connect/start", {})
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "chatgpt_signin_unavailable" })
    expect(codeExchanges).toBe(0)
  })
})
