/**
 * A ChatGPT turn is restart work like a Claude one: `POST /drain` holds a new
 * one at the door, and `GET /inflight` counts a running one under `chatgpt`
 * until its body is finished or the client goes away.
 *
 * Without this a supervisor draining a ChatGPT-only instance read `total: 0`
 * while responses were still streaming, and restarted through them.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

installSdkMock(() => ({
  query: (params: unknown) => (async function* () {
    yield { ...assistantMessage([{ type: "text", text: "claude-ok" }]), session_id: resolveMockSdkSessionId((params as { options?: unknown }).options, "sdk-chatgpt-drain") }
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "chatgpt-drain-inflight.test.ts")
installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => Promise<Response> | Response) => fn(),
}))

const sessionDir = mkdtempSync(join(tmpdir(), "chatgpt-drain-sess-"))
process.env.CLAUDE_PROXY_SESSION_DIR = sessionDir
delete process.env.MERIDIAN_API_KEY

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { saveSettings } = await import("../settings")
const { __setFetchOAuthUsageOverride, resetOAuthUsageCache } = await import("../proxy/oauthUsage")
const { processSessionTree } = await import("../proxy/sessionTree")
const { openCodeAdapter } = await import("../proxy/adapters/opencode")

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"
const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } }
const realFetch = globalThis.fetch

const sse = (event: Record<string, unknown>) => new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)

/** One upstream stream per call: it opens at once and finishes on `release()`. */
interface HeldStream { release: () => void }
let streams: HeldStream[] = []

function heldResponse(): Response {
  let release = () => {}
  const finished = new Promise<void>(resolve => { release = resolve })
  streams.push({ release })
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sse({ type: "response.created", response: { id: "r1", output: [] } }))
      controller.enqueue(sse({ type: "response.output_item.added", output_index: 0, item: { type: "message" } }))
      controller.enqueue(sse({ type: "response.output_text.delta", delta: "po" }))
      await finished
      controller.enqueue(sse({ type: "response.output_text.delta", delta: "ng" }))
      controller.enqueue(sse({ type: "response.completed", response: { id: "r1", model: "gpt-6-luna", output: [], usage: { input_tokens: 5, output_tokens: 1 } } }))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function mockFetch(input: string | URL | Request): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  if (url === CODEX_URL) return Promise.resolve(heldResponse())
  if (url.startsWith("https://chatgpt.com/") || url.startsWith("https://auth.openai.com/")) return Promise.resolve(new Response("{}", { status: 503 }))
  return Promise.reject(new Error(`unexpected network call in test: ${url}`))
}

function responses(signal?: AbortSignal): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer any-client-key" },
    body: JSON.stringify({ model: "gpt-6-luna", stream: true, input: [{ role: "user", content: "hi" }], prompt_cache_key: "conversation-drain" }),
    signal,
  })
}

const drain = (method: "POST" | "DELETE") => new Request("http://localhost/drain", { method })

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(2)
  }
}

interface InflightBody {
  total: number
  draining: boolean
  upstreams: Record<string, { streams: number; requests: number; queued: number }>
  drain: { held: number }
}

let dir: string
const proxies: ReturnType<typeof createProxyServer>[] = []

async function server() {
  const pool = join(dir, "opencode", "oc-codex-multi-auth-accounts.json")
  writeFileSync(pool, JSON.stringify({
    version: 3,
    activeIndex: 0,
    accounts: [{
      accountId: "workspace-0", accountUserId: "user-0__workspace-0", email: "seat0@example.test",
      refreshToken: "rt-0", accessToken: "at-0", expiresAt: Date.now() + 3_600_000, addedAt: 1, lastUsed: 1,
    }],
  }))
  process.env.MERIDIAN_CODEX_POOL_PATH = pool
  process.env.MERIDIAN_CHATGPT_CREDENTIALS = "follow-external"
  const pluginConfigPath = join(dir, "plugins.json")
  writeFileSync(pluginConfigPath, JSON.stringify({ plugins: [] }))
  const proxy = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, pluginDir: join(dir, "no-plugins"), pluginConfigPath })
  proxies.push(proxy)
  if (!proxy.getInFlightCount || !proxy.closeBackend) throw new Error("Fixture requires admission counts and joined backend cleanup")
  const inFlightCount = proxy.getInFlightCount
  await proxy.initPlugins?.()
  const inflight = async () => (await (await proxy.app.fetch(new Request("http://localhost/inflight"), LOOPBACK)).json()) as InflightBody
  return { app: proxy.app, inflight, inFlightCount }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "chatgpt-drain-"))
  mkdirSync(join(dir, "opencode"))
  streams = []
  globalThis.fetch = mockFetch as typeof fetch
  await clearSessionCache()
  __setFetchOAuthUsageOverride(async () => null)
  resetOAuthUsageCache()
  saveSettings({ integrations: undefined })
})
afterEach(async () => {
  for (const stream of streams) stream.release()
  await Bun.sleep(10)
  for (const proxy of proxies.splice(0)) {
    if (!proxy.closeBackend) throw new Error("Fixture lost joined backend cleanup")
    await proxy.closeBackend()
  }
  __setFetchOAuthUsageOverride(null)
  saveSettings({ chatGptActiveSeat: undefined, chatgpt: undefined })
  globalThis.fetch = realFetch
  delete process.env.MERIDIAN_CHATGPT_CREDENTIALS
  delete process.env.MERIDIAN_CODEX_POOL_PATH
  rmSync(dir, { recursive: true, force: true })
})
afterAll(() => {
  rmSync(sessionDir, { recursive: true, force: true })
  delete process.env.CLAUDE_PROXY_SESSION_DIR
  mock.restore()
})

describe("GET /inflight counts ChatGPT turns", () => {
  it("reports chatgpt with zeros when idle", async () => {
    const { inflight } = await server()
    expect(await inflight()).toMatchObject({ total: 0, upstreams: { claude: { streams: 0 }, chatgpt: { streams: 0, requests: 0, queued: 0 } } })
  })

  it("counts a running ChatGPT stream and drops it when the body finishes", async () => {
    const { app, inflight } = await server()
    const running = await app.fetch(responses())
    expect(running.status).toBe(200)
    expect(await inflight()).toMatchObject({ total: 1, upstreams: { chatgpt: { streams: 1 } } })

    streams[0]!.release()
    expect(await running.text()).toContain('"delta":"ng"')
    await waitFor(async () => (await inflight()).total === 0, "the finished stream to leave /inflight")
    expect((await inflight()).upstreams.chatgpt).toEqual({ streams: 0, requests: 0, queued: 0 })
  })

  it("counts a streamed turn as a stream while it reasons, before the backend's first output", async () => {
    const { app, inflight } = await server()
    let answer = (_response: Response) => {}
    const answered = new Promise<Response>(resolve => { answer = resolve })
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      return url === CODEX_URL ? answered : mockFetch(input)
    }) as typeof fetch
    const running = Promise.resolve(app.fetch(responses()))
    await waitFor(async () => (await inflight()).total === 1, "the reasoning turn to be counted")
    expect((await inflight()).upstreams.chatgpt).toEqual({ streams: 1, requests: 0, queued: 0 })
    answer(heldResponse())
    streams[0]!.release()
    await (await running).text()
    await waitFor(async () => (await inflight()).total === 0, "the turn to finish")
  })

  it("drops a running ChatGPT stream when the client goes away", async () => {
    const { app, inflight } = await server()
    const client = new AbortController()
    const running = await app.fetch(responses(client.signal))
    expect(running.status).toBe(200)
    expect((await inflight()).total).toBe(1)

    client.abort()
    await waitFor(async () => (await inflight()).total === 0, "the aborted stream to leave /inflight")
    await running.body?.cancel().catch(() => {})
  })

  it("drops a turn whose upstream failed", async () => {
    const { app, inflight } = await server()
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === CODEX_URL) return Promise.reject(new Error("socket hang up"))
      return mockFetch(input)
    }) as typeof fetch
    const failed = await Promise.resolve(app.fetch(responses())).catch((error: unknown) => error)
    if (failed instanceof Response) await failed.text()
    expect((await inflight()).total).toBe(0)
  })

  for (const boundary of ["session-key", "session-tree"] as const) it(`drops a turn whose ${boundary} setup fails before the backend`, async () => {
    const { app, inflight, inFlightCount } = await server()
    const fail = () => { throw new Error("owned setup failure") }
    const failure = boundary === "session-key"
      ? spyOn(openCodeAdapter, "getSessionId").mockImplementation(fail)
      : spyOn(processSessionTree, "register").mockImplementation(fail)
    const request = responses()
    request.headers.set("x-meridian-agent", "opencode")
    const add = spyOn(request.signal, "addEventListener")
    const remove = spyOn(request.signal, "removeEventListener")
    try {
      const failed = await Promise.resolve(app.fetch(request)).catch((error: unknown) => error)
      if (failed instanceof Response) await failed.text()
      expect(failure).toHaveBeenCalledTimes(1)
      expect(add).toHaveBeenCalledTimes(1)
      expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1])
    } finally {
      failure.mockRestore()
      add.mockRestore()
      remove.mockRestore()
    }
    expect(streams).toHaveLength(0)
    expect((await inflight()).total).toBe(0)
    expect(inFlightCount()).toBe(0)
  })
})

describe("POST /drain holds ChatGPT turns", () => {
  it("holds a new ChatGPT turn while the running one finishes, then admits it on DELETE", async () => {
    const { app, inflight } = await server()
    const running = await app.fetch(responses())
    expect(streams).toHaveLength(1)

    expect((await app.fetch(drain("POST"), LOOPBACK)).status).toBe(200)
    let heldSettled = false
    const held = Promise.resolve(app.fetch(responses())).finally(() => { heldSettled = true })
    await waitFor(async () => (await inflight()).drain.held === 1, "the new ChatGPT turn to be held")
    expect(await inflight()).toMatchObject({ total: 1, draining: true, upstreams: { chatgpt: { streams: 1 } } })
    expect(streams).toHaveLength(1)

    streams[0]!.release()
    await running.text()
    await waitFor(async () => (await inflight()).total === 0, "the running ChatGPT stream to finish")
    expect(heldSettled).toBe(false)
    expect(streams).toHaveLength(1)

    await app.fetch(drain("DELETE"), LOOPBACK)
    const admitted = await held
    expect(admitted.status).toBe(200)
    expect(streams).toHaveLength(2)
    expect((await inflight()).upstreams.chatgpt!.streams).toBe(1)
    streams[1]!.release()
    await admitted.text()
    await waitFor(async () => (await inflight()).total === 0, "the admitted turn to finish")
  }, 20_000)
})
