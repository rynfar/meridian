/**
 * ChatGPT gateway parity features through the real HTTP stack.
 *
 * A proxy follows a synthetic oc-codex-multi-auth store, and chatgpt.com is
 * replaced by an in-process fake at the fetch boundary, so every request
 * below crosses dispatch, the parity wrapper, the pass-through backend and
 * the stream tap exactly as a live one would.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"

let sdkQueries = 0
installSdkMock(() => ({
  query: () => {
    sdkQueries++
    return (async function* () {})()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "chatgpt-parity-http.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => Promise<Response> | Response) => fn(),
}))

const workDir = mkdtempSync(join(tmpdir(), "chatgpt-parity-http-"))
const poolPath = join(workDir, "oc-codex-multi-auth-accounts.json")
const FAR_FUTURE = Date.now() + 24 * 3_600_000
writeFileSync(poolPath, JSON.stringify({
  version: 3,
  activeIndex: 0,
  accounts: ["a", "b"].map(id => ({
    accountUserId: `user-${id}`,
    accountId: `acct-${id}`,
    email: `${id}@example.test`,
    accessToken: `synthetic-token-${id}`,
    expiresAt: FAR_FUTURE,
    enabled: true,
  })),
}))
process.env.MERIDIAN_CHATGPT_CREDENTIALS = "follow-external"
process.env.MERIDIAN_CODEX_POOL_PATH = poolPath

const { createProxyServer } = await import("../proxy/server")
const { telemetryStore } = await import("../telemetry")
const { setSetting } = await import("../settings")
const { resetChatGptFeatures, updateChatGptFeatures } = await import("../proxy/chatgpt/features")
const { setPricingOverride, deletePricingOverride } = await import("../telemetry/pricingStore")
const { adaptResponsesBody } = await import("../proxy/chatgpt/body")
const { CHATGPT_MODELS } = await import("../proxy/upstream/provider")
const { updateAdapterFeatures, resetAdapterFeatures } = await import("../proxy/sdkFeatures")

interface UpstreamCall { url: string; body: Record<string, unknown>; headers: Headers; signal?: AbortSignal | null }
type Upstream = (call: UpstreamCall) => Response | Promise<Response>

const originalFetch = globalThis.fetch
let upstream: Upstream = () => new Response("unset", { status: 500 })
let calls: UpstreamCall[] = []

beforeAll(() => {
  // No usage-window requests: this suite is about the turn path.
  setSetting("integrations", { codexUsage: false })
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.startsWith("https://chatgpt.com/")) return originalFetch(input, init)
      // The model catalog read is not a turn; unread, the built-in list is offered.
      if (url.startsWith("https://chatgpt.com/backend-api/codex/models?")) return new Response("{}", { status: 503 })
      const call = { url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, headers: new Headers(init?.headers), signal: init?.signal }
      calls.push(call)
      return upstream(call)
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterAll(() => {
  globalThis.fetch = originalFetch
  delete process.env.MERIDIAN_CHATGPT_CREDENTIALS
  delete process.env.MERIDIAN_CODEX_POOL_PATH
  rmSync(workDir, { recursive: true, force: true })
  mock.restore()
})

beforeEach(() => {
  calls = []
  sdkQueries = 0
  resetChatGptFeatures()
  telemetryStore.clear()
})

afterEach(() => {
  deletePricingOverride("gpt-5.6-sol")
  deletePricingOverride("gpt-5.4")
})

function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

const REASONING_ITEM = { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "**Weighing options**" }], encrypted_content: "gAAAA-opaque" }

function completedStream(model: string, text = "Hello"): string {
  return [
    sse("response.created", { response: { id: "resp_1", model, status: "in_progress", output: [] } }),
    sse("response.output_item.added", { output_index: 0, item: { ...REASONING_ITEM, summary: [] } }),
    sse("response.reasoning_summary_text.delta", { item_id: "rs_1", summary_index: 0, delta: "**Weighing options**" }),
    sse("response.output_item.done", { output_index: 0, item: REASONING_ITEM }),
    sse("response.output_text.delta", { output_index: 1, delta: text }),
    sse("response.completed", {
      response: {
        id: "resp_1", model, status: "completed", output: [REASONING_ITEM],
        usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 200, output_tokens_details: { reasoning_tokens: 50 } },
      },
    }),
  ].join("")
}

function streamResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "content-type": "text/event-stream" } })
}

/** A body the Codex backend already accepts, so the gateway adapts nothing. */
function codexBody(model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model,
    instructions: "SENTINEL-CLIENT-INSTRUCTIONS",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "SENTINEL-USER-TEXT" }] }],
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "high", summary: "auto" },
    prompt_cache_key: "conv-1",
    ...extra,
  }
}

const OPENCODE_HEADERS = { "user-agent": "opencode/1.18.32", "x-opencode-session": "sess-parity" }

function makeServer(options: Parameters<typeof createProxyServer>[0] = {}) {
  return createProxyServer({ port: 0, host: "127.0.0.1", silent: true, ...options })
}

async function post(app: { fetch: (req: Request) => Response | Promise<Response> }, body: unknown, headers: Record<string, string> = {}) {
  return app.fetch(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...OPENCODE_HEADERS, ...headers },
    body: JSON.stringify(body),
  }))
}

describe("no Claude feature and no request plugin touches a ChatGPT request", () => {
  it("sends the client's body unchanged with every Claude feature on and a mutating plugin loaded", async () => {
    updateAdapterFeatures("opencode", {
      codeSystemPrompt: true, clientSystemPrompt: true, claudeMd: "full", memory: true, dreaming: true,
      thinking: "enabled", thinkingPassthrough: false, sharedMemory: true, claudeAiConnectors: true,
      maxBudgetUsd: 0.000001, fallbackModel: "sonnet", additionalDirectories: "/tmp",
    })
    const pluginDir = mkdtempSync(join(workDir, "plugins-"))
    const pluginPath = join(pluginDir, "scrub-like.js")
    writeFileSync(pluginPath, `
      globalThis.__chatgptParityPluginCalls = 0
      export default {
        name: "scrub-like",
        version: "1.0.0",
        adapters: ["opencode"],
        onRequest(ctx) {
          globalThis.__chatgptParityPluginCalls++
          return { ...ctx, systemContext: "[SCRUBBED] " + (ctx.systemContext || "") }
        },
        onResponse(ctx) {
          globalThis.__chatgptParityPluginCalls++
          return ctx
        },
      }
    `)
    const pluginConfigPath = join(pluginDir, "plugins.json")
    writeFileSync(pluginConfigPath, JSON.stringify({ plugins: [{ path: pluginPath, enabled: true }] }))
    try {
      const { app, initPlugins } = makeServer({ pluginDir: join(pluginDir, "auto"), pluginConfigPath })
      if (initPlugins) await initPlugins()
      upstream = () => streamResponse(completedStream("gpt-5.6-sol"))

      const body = codexBody("gpt-5.6-sol")
      const res = await post(app, body)
      expect(res.status).toBe(200)
      await res.text()

      expect(calls).toHaveLength(1)
      const adapted = adaptResponsesBody(body)
      expect(adapted.applied).toEqual([])
      expect(calls[0]!.body).toEqual(body)
      expect(JSON.stringify(calls[0]!.body)).not.toContain("SCRUBBED")
      expect((globalThis as { __chatgptParityPluginCalls?: number }).__chatgptParityPluginCalls).toBe(0)
      expect(sdkQueries).toBe(0)
    } finally {
      resetAdapterFeatures("opencode")
    }
  })
})

describe("Thinking Passthrough", () => {
  it("is on by default: the stream reaches the client byte for byte", async () => {
    const { app } = makeServer()
    const upstreamText = completedStream("gpt-5.6-sol")
    upstream = () => streamResponse(upstreamText)
    const res = await post(app, codexBody("gpt-5.6-sol"))
    expect(await res.text()).toBe(upstreamText)
  })

  it("off: summaries are removed, the encrypted reasoning stays", async () => {
    updateChatGptFeatures({ thinkingPassthrough: false })
    const { app } = makeServer()
    upstream = () => streamResponse(completedStream("gpt-5.6-sol"))
    const text = await (await post(app, codexBody("gpt-5.6-sol"))).text()
    expect(text).not.toContain("Weighing options")
    expect(text).not.toContain("reasoning_summary")
    expect(text).toContain("gAAAA-opaque")
    expect(text).toContain("response.completed")
  })

  it("off: a non-streaming client gets the aggregated response without summaries", async () => {
    updateChatGptFeatures({ thinkingPassthrough: false })
    const { app } = makeServer()
    upstream = () => streamResponse(completedStream("gpt-5.6-sol"))
    const res = await post(app, codexBody("gpt-5.6-sol", { stream: false }))
    const json = await res.json() as { output: Array<Record<string, unknown>> }
    expect(json.output[0]).toEqual({ ...REASONING_ITEM, summary: [] })
  })
})

describe("telemetry", () => {
  it("attributes an OpenCode subagent request to its unscoped client conversation", async () => {
    const { app } = makeServer()
    upstream = () => streamResponse(completedStream("gpt-5.6-sol"))

    const turn = await post(app, codexBody("gpt-5.6-sol"), {
      "x-opencode-agent-mode": "subagent",
      "x-opencode-agent-name": "explore",
    })
    expect(turn.status).toBe(200)
    await turn.text()

    const history = await app.fetch(new Request("http://localhost/telemetry/requests?limit=1"))
    expect(await history.json()).toMatchObject([{ adapter: "chatgpt", clientSessionId: "sess-parity" }])
  })

  it("attributes native Codex turns and side requests to the same thread, not their inherited cache key", async () => {
    const { app } = makeServer()
    upstream = () => streamResponse(completedStream("gpt-5.6-sol"))

    for (const requestKind of ["turn", "compact"]) {
      const turn = await post(app, codexBody("gpt-5.6-sol"), {
        "user-agent": "codex_cli_rs/0.150.0",
        "x-opencode-session": "",
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "child-thread", request_kind: requestKind }),
      })
      expect(turn.status).toBe(200)
      await turn.text()
    }

    const history = await app.fetch(new Request("http://localhost/telemetry/requests?limit=2"))
    expect(await history.json()).toMatchObject([
      { adapter: "chatgpt", clientSessionId: "child-thread" },
      { adapter: "chatgpt", clientSessionId: "child-thread" },
    ])
  })

  it("omits client attribution when no key other than the prompt cache key is sent", async () => {
    const { app } = makeServer()
    upstream = () => streamResponse(completedStream("gpt-5.6-sol"))

    const turn = await post(app, codexBody("gpt-5.6-sol"), { "user-agent": "generic-client", "x-opencode-session": "" })
    expect(turn.status).toBe(200)
    await turn.text()

    const history = await app.fetch(new Request("http://localhost/telemetry/requests?limit=1"))
    const rows: unknown = await history.json()
    if (!Array.isArray(rows)) throw new TypeError("Expected telemetry request rows")
    expect(rows[0]).toMatchObject({ adapter: "chatgpt" })
    expect(rows[0]).not.toHaveProperty("clientSessionId")
  })

  it("records provider tokens with cached and reasoning tokens counted once, and values them at the built-in OpenAI rate", async () => {
    const { app } = makeServer()
    upstream = () => streamResponse(completedStream("gpt-5.6-sol"))
    await (await post(app, codexBody("gpt-5.6-sol"))).text()
    const [row] = telemetryStore.getRecent({ limit: 5 })
    expect(row?.adapter).toBe("chatgpt")
    expect(row?.model).toBe("gpt-5.6-sol")
    expect(row?.requestModel).toBe("gpt-5.6-sol")
    expect(row?.inputTokens).toBe(600)
    expect(row?.cacheReadInputTokens).toBe(400)
    expect(row?.outputTokens).toBe(200)
    expect(row?.reasoningOutputTokens).toBe(50)
    expect(row?.profileId).toBe("a-user-a")
    const summary = telemetryStore.summarize(3_600_000)
    // gpt-5.6-sol list price: $4 input, $0.40 cached input, $20 output per 1M.
    expect(summary.costEstimate?.totalUsd).toBeCloseTo((600 * 4 + 400 * 0.4 + 200 * 20) / 1e6, 9)
    expect(summary.costEstimate?.unpricedRequestCount).toBe(0)
  })
})

describe("Max Budget", () => {
  it("refuses a turn whose input is over budget without contacting ChatGPT", async () => {
    setPricingOverride("gpt-5.6-sol", { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.4, cacheWritePerMTok: 0 })
    updateChatGptFeatures({ maxBudgetUsd: 0.0000001 })
    const { app } = makeServer()
    upstream = () => streamResponse(completedStream("gpt-5.6-sol"))
    const res = await post(app, codexBody("gpt-5.6-sol"))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("max_budget_exceeded")
    expect(calls).toHaveLength(0)
    expect(telemetryStore.getRecent({ limit: 5 })[0]?.error).toBe("refused_by_admission")
  })

  it("stops a stream whose output passes the budget and records it", async () => {
    setPricingOverride("gpt-5.6-sol", { inputPerMTok: 0, outputPerMTok: 10, cacheReadPerMTok: 0, cacheWritePerMTok: 0 })
    updateChatGptFeatures({ maxBudgetUsd: 0.02 })
    const { app } = makeServer()
    const deltas = Array.from({ length: 20 }, () => sse("response.output_text.delta", { delta: "x".repeat(4000) })).join("")
    upstream = () => streamResponse(sse("response.created", { response: { id: "resp_b", output: [] } }) + deltas + completedStream("gpt-5.6-sol"))
    const text = await (await post(app, codexBody("gpt-5.6-sol"))).text()
    expect(text).toContain("max_budget_exceeded")
    expect(text).not.toContain("response.completed")
    await Bun.sleep(10)
    expect(telemetryStore.getRecent({ limit: 5 })[0]?.error).toBe("max_budget_exceeded")
  })
})

describe("Fallback Model", () => {
  it("retries once on the configured ChatGPT model after a provider error, changing only `model`", async () => {
    updateChatGptFeatures({ fallbackModel: "gpt-5.4" })
    const { app } = makeServer()
    upstream = (call) => call.body.model === "gpt-5.4"
      ? streamResponse(completedStream("gpt-5.4"))
      : new Response(JSON.stringify({ error: { message: "upstream exploded" } }), { status: 503, headers: { "content-type": "application/json" } })
    const res = await post(app, codexBody("gpt-5.6-sol"))
    expect(res.status).toBe(200)
    expect(res.headers.get("x-meridian-fallback-model")).toBe("gpt-5.4")
    await res.text()
    expect(calls.map(call => call.body.model)).toEqual(["gpt-5.6-sol", "gpt-5.4"])
    const retried: Record<string, unknown> = { ...calls[1]!.body, model: "gpt-5.6-sol" }
    expect(retried).toEqual(calls[0]!.body)
    const rows = telemetryStore.getRecent({ limit: 5 })
    const served = rows.find(row => row.fallbackFromModel !== undefined)
    expect(served?.model).toBe("gpt-5.4")
    expect(served?.requestModel).toBe("gpt-5.6-sol")
    expect(served?.fallbackFromModel).toBe("gpt-5.6-sol")
    // Valued at the model that did the work: gpt-5.4 is $2.50 / $0.25 / $15 per 1M.
    const summary = telemetryStore.summarize(3_600_000)
    expect(summary.costEstimate?.totalUsd).toBeCloseTo((600 * 2.5 + 400 * 0.25 + 200 * 15) / 1e6, 9)
  })

  it("retries after the model is refused, but not after an unrelated 400", async () => {
    updateChatGptFeatures({ fallbackModel: "gpt-5.4" })
    const { app } = makeServer()
    upstream = (call) => call.body.model === "gpt-5.4"
      ? streamResponse(completedStream("gpt-5.4"))
      : new Response(JSON.stringify({ detail: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account." }), { status: 400 })
    expect((await post(app, codexBody("gpt-5.6-sol"))).status).toBe(200)

    calls = []
    upstream = () => new Response(JSON.stringify({ error: { message: "Invalid value for 'input'." } }), { status: 400 })
    const res = await post(app, codexBody("gpt-5.6-sol"))
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(1)
  })

  it("does not retry once output reached the client", async () => {
    updateChatGptFeatures({ fallbackModel: "gpt-5.4" })
    const { app } = makeServer()
    upstream = () => streamResponse(
      sse("response.created", { response: { id: "r", output: [] } })
      + sse("response.output_text.delta", { delta: "partial" })
      + sse("response.failed", { response: { id: "r", status: "failed", error: { code: "server_error" } } }),
    )
    const text = await (await post(app, codexBody("gpt-5.6-sol"))).text()
    expect(text).toContain("partial")
    expect(calls).toHaveLength(1)
  })

  it("is off by default", async () => {
    const { app } = makeServer()
    upstream = () => new Response("{}", { status: 503 })
    expect((await post(app, codexBody("gpt-5.6-sol"))).status).toBe(503)
    expect(calls).toHaveLength(1)
  })
})

describe("rate limits", () => {
  it("rotates to the next seat, then answers a spent pool with a Retry-After from the benches", async () => {
    const { app } = makeServer()
    upstream = () => new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), { status: 429, headers: { "content-type": "application/json" } })
    const res = await post(app, codexBody("gpt-5.6-sol"))
    expect(res.status).toBe(429)
    expect(calls.map(call => call.headers.get("chatgpt-account-id"))).toEqual(["acct-a", "acct-b"])
    const retryAfter = Number(res.headers.get("retry-after"))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(600)

    calls = []
    const again = await post(app, codexBody("gpt-5.6-sol"))
    expect(again.status).toBe(429)
    expect(calls).toHaveLength(0)
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(0)
  })

  it("keeps the provider's own Retry-After", async () => {
    const { app } = makeServer()
    upstream = () => new Response("{}", { status: 429, headers: { "retry-after": "42" } })
    expect((await post(app, codexBody("gpt-5.6-sol"))).headers.get("retry-after")).toBe("42")
  })
})

describe("sessions", () => {
  it("/v1/sessions/:key/cancel stops a running ChatGPT turn of that session", async () => {
    const { app } = makeServer()
    let upstreamSignal: AbortSignal | null | undefined
    upstream = (call) => {
      upstreamSignal = call.signal
      const encoder = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sse("response.created", { response: { id: "r", output: [] } }) + sse("response.output_text.delta", { delta: "working" })))
        },
      }), { headers: { "content-type": "text/event-stream" } })
    }
    const res = await post(app, codexBody("gpt-5.6-sol"), { "x-opencode-session": "sess-cancel" })
    const reader = res.body!.getReader()
    await reader.read()
    const cancel = await app.fetch(new Request("http://localhost/v1/sessions/sess-cancel/cancel", { method: "POST" }))
    expect(((await cancel.json()) as { cancelled: { requests: number } }).cancelled.requests).toBe(1)
    expect(upstreamSignal?.aborted).toBe(true)
    await reader.cancel().catch(() => {})
  })
})

describe("Reasoning Summary", () => {
  it("sends the client's reasoning untouched by default, including none at all", async () => {
    const { app } = makeServer()
    upstream = () => streamResponse(completedStream("gpt-5.6-sol"))
    const { reasoning: _omitted, ...withoutReasoning } = codexBody("gpt-5.6-sol")
    await (await post(app, withoutReasoning)).text()
    await (await post(app, codexBody("gpt-5.6-sol"))).text()
    expect(calls).toHaveLength(2)
    expect(calls[0]!.body).toEqual(withoutReasoning)
    expect(calls[1]!.body.reasoning).toEqual({ effort: "high", summary: "auto" })
  })

  it("forces the configured level on every request, keeping the client's effort", async () => {
    updateChatGptFeatures({ reasoningSummary: "detailed" })
    const { app } = makeServer()
    upstream = () => streamResponse(completedStream("gpt-5.6-sol"))
    const { reasoning: _omitted, ...withoutReasoning } = codexBody("gpt-5.6-sol")
    await (await post(app, withoutReasoning)).text()
    await (await post(app, codexBody("gpt-5.6-sol"))).text()
    expect(calls.map(call => call.body.reasoning)).toEqual([{ summary: "detailed" }, { effort: "high", summary: "detailed" }])
    const { reasoning: _sent, ...rest } = calls[1]!.body
    const { reasoning: _client, ...clientRest } = codexBody("gpt-5.6-sol")
    expect(rest).toEqual(clientRest)
  })

  it("is carried by a Fallback Model retry", async () => {
    updateChatGptFeatures({ reasoningSummary: "detailed", fallbackModel: "gpt-5.4" })
    const { app } = makeServer()
    upstream = (call) => call.body.model === "gpt-5.4"
      ? streamResponse(completedStream("gpt-5.4"))
      : new Response(JSON.stringify({ error: { message: "upstream exploded" } }), { status: 503, headers: { "content-type": "application/json" } })
    const res = await post(app, codexBody("gpt-5.6-sol"))
    expect(res.headers.get("x-meridian-fallback-model")).toBe("gpt-5.4")
    await res.text()
    expect(calls.map(call => [call.body.model, call.body.reasoning])).toEqual([
      ["gpt-5.6-sol", { effort: "high", summary: "detailed" }],
      ["gpt-5.4", { effort: "high", summary: "detailed" }],
    ])
  })
})

describe("status surfaces", () => {
  it("/providers/status shows the ChatGPT seats and the feature settings", async () => {
    updateChatGptFeatures({ maxBudgetUsd: 2, fallbackModel: "gpt-5.4" })
    const { app } = makeServer()
    const data = await (await app.fetch(new Request("http://localhost/providers/status"))).json() as {
      providers: Array<{ id: string; accounts: Array<{ id: string; label?: string }>; capabilities?: Array<{ name: string; status: string }> }>
    }
    const chatgpt = data.providers.find(provider => provider.id === "chatgpt")!
    expect(chatgpt.accounts.map(account => account.id)).toEqual(["user-a", "user-b"])
    expect(chatgpt.accounts.map(account => account.label)).toEqual(["a@example.test · id:user-a", "b@example.test · id:user-b"])
    const capabilities = Object.fromEntries((chatgpt.capabilities ?? []).map(row => [row.name, row.status]))
    expect(capabilities).toMatchObject({ Thinking: "summaries", "Reasoning Summary": "client", "Max Budget": "$2", "Fallback Model": "gpt-5.4" })
    expect(JSON.stringify(data)).not.toContain("synthetic-token")
  })

  it("/settings/api/chatgpt reads, validates and resets the ChatGPT settings", async () => {
    const { app } = makeServer()
    const patch = (body: unknown) => app.fetch(new Request("http://localhost/settings/api/chatgpt", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }))
    expect((await patch({ fallbackModel: "sonnet" })).status).toBe(400)
    expect((await patch({ fallbackModel: "gpt-5.4" })).status).toBe(400)
    expect((await patch({ fallbackModel: "gpt-6-luna" })).status).toBe(200)
    expect((await patch({ thinkingPassthrough: false })).status).toBe(200)
    expect((await patch({ reasoningSummary: "verbose" })).status).toBe(400)
    expect((await patch({ reasoningSummary: true })).status).toBe(400)
    expect((await patch({ reasoningSummary: "detailed" })).status).toBe(200)
    const read = await (await app.fetch(new Request("http://localhost/settings/api/chatgpt"))).json() as { enabled: boolean; features: { thinkingPassthrough: boolean; reasoningSummary: string }; models: string[] }
    expect(read.models).toEqual([...CHATGPT_MODELS])
    expect(read.enabled).toBe(true)
    expect(read.features.thinkingPassthrough).toBe(false)
    expect(read.features.reasoningSummary).toBe("detailed")
    const reset = await (await app.fetch(new Request("http://localhost/settings/api/chatgpt", { method: "DELETE" }))).json() as { features: { thinkingPassthrough: boolean; reasoningSummary: string } }
    expect(reset.features.thinkingPassthrough).toBe(true)
    expect(reset.features.reasoningSummary).toBe("client")
  })
})
