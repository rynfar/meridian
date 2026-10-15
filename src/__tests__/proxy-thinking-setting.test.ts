/**
 * The per-adapter `thinking` setting (sdk-features.json / settings UI) must be
 * respected at the SDK boundary.
 *
 * Bug: an explicit "disabled" choice was ignored. The setting was only ever
 * consulted as a fallback default (inside `if (!thinking)`), and "disabled" had
 * no branch — so a client sending its own `thinking` (body or x-opencode-thinking
 * header) overrode it, and `effort` (which only tunes thinking depth) still flowed
 * through. An explicit "disabled" must now hard-disable thinking and drop effort,
 * while the *default* "disabled" stays a no-op so clients can request thinking
 * per-request.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, withMockSdkSessionId } from "./helpers"

// ─── controllable sdk-features state ──────────────────────────────────────────
// `explicitThinking` = the raw, user-configured value (undefined = unset/default).
// `defaultThinking`  = the merged value getFeaturesForAdapter() returns.
let explicitThinking: "adaptive" | "enabled" | "disabled" | undefined = undefined
let defaultThinking: "adaptive" | "enabled" | "disabled" = "disabled"

// Self-contained feature object (no delegation to the real module — once mocked,
// the namespace IS the mock, so delegating would recurse infinitely).
const FEATURES = {
  codeSystemPrompt: true,
  clientSystemPrompt: true,
  claudeMd: "off" as const,
  memory: false,
  dreaming: false,
  thinking: "disabled" as const,
  thinkingPassthrough: false,
  sharedMemory: false,
  maxBudgetUsd: 0,
  fallbackModel: "",
  sdkDebug: false,
  additionalDirectories: "",
}

mock.module("../proxy/sdkFeatures", () => ({
  getExplicitThinking: () => explicitThinking,
  getFeaturesForAdapter: () => ({ ...FEATURES, thinking: defaultThinking }),
}))

// ─── captured query params ────────────────────────────────────────────────────
let capturedOptions: Record<string, unknown> = {}
let mockMessages: unknown[] = []

installSdkMock(() => ({
  query: (params: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedOptions = params.options ?? {}
    return (async function* () {
      for (const msg of mockMessages) {
        yield withMockSdkSessionId(msg, params.options)
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-thinking-setting.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { telemetryStore } = await import("../telemetry")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(
  app: ReturnType<typeof createTestApp>,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

const BASE_BODY = {
  model: "claude-haiku-4-5-20251001",
  max_tokens: 50,
  stream: false,
  messages: [{ role: "user", content: "hi" }],
}

describe("per-adapter thinking setting — explicit \"disabled\" is authoritative", () => {
  beforeEach(async () => {
    capturedOptions = {}
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    explicitThinking = undefined
    defaultThinking = "disabled"
    await clearSessionCache()
  })

  it("overrides client body.thinking when explicitly disabled", async () => {
    explicitThinking = "disabled"
    const app = createTestApp()
    await post(app, { ...BASE_BODY, thinking: { type: "enabled", budgetTokens: 4096 } })
    expect(capturedOptions.thinking).toEqual({ type: "disabled" })
  })

  it("overrides x-opencode-thinking header when explicitly disabled", async () => {
    explicitThinking = "disabled"
    const app = createTestApp()
    await post(app, { ...BASE_BODY }, {
      "x-opencode-thinking": JSON.stringify({ type: "enabled", budgetTokens: 8192 }),
    })
    expect(capturedOptions.thinking).toEqual({ type: "disabled" })
  })

  it("drops effort when explicitly disabled (effort only tunes thinking depth)", async () => {
    explicitThinking = "disabled"
    const app = createTestApp()
    await post(app, { ...BASE_BODY, effort: "high", thinking: { type: "enabled" } })
    expect(capturedOptions.thinking).toEqual({ type: "disabled" })
    expect(capturedOptions.effort).toBeUndefined()
  })

  it("disables thinking even when the client sends nothing", async () => {
    explicitThinking = "disabled"
    const app = createTestApp()
    await post(app, BASE_BODY)
    expect(capturedOptions.thinking).toEqual({ type: "disabled" })
  })

  // ─── regression guard: the *default* "disabled" must NOT override ───────────
  it("default \"disabled\" (unset) leaves client body.thinking untouched", async () => {
    explicitThinking = undefined
    defaultThinking = "disabled"
    const thinking = { type: "enabled", budgetTokens: 2048 }
    const app = createTestApp()
    await post(app, { ...BASE_BODY, thinking })
    expect(capturedOptions.thinking).toEqual(thinking)
  })

  it("default \"disabled\" (unset) leaves client effort untouched", async () => {
    explicitThinking = undefined
    defaultThinking = "disabled"
    const app = createTestApp()
    await post(app, { ...BASE_BODY, effort: "high" })
    expect(capturedOptions.effort).toBe("high")
  })

  // ─── adaptive/enabled stay fallback-only (unchanged) ────────────────────────
  it("explicit \"enabled\" still defers to a client-supplied thinking value", async () => {
    explicitThinking = "enabled"
    defaultThinking = "enabled"
    const thinking = { type: "disabled" }
    const app = createTestApp()
    await post(app, { ...BASE_BODY, thinking })
    expect(capturedOptions.thinking).toEqual(thinking)
  })

  it("rejects Haiku 5.5 explicit off and omitted display before any SDK generation in both modes", async () => {
    for (const stream of [false, true]) {
      for (const thinking of [{ type: "disabled" }, { type: "adaptive", display: "omitted" }]) {
        const response = await post(createTestApp(), { ...BASE_BODY, model: "claude-haiku-5-5", stream, thinking })
        expect(response.status).toBe(400)
        expect(await response.text()).toContain("cannot reliably honor")
        expect(capturedOptions).toEqual({})
      }
    }
  })

  it("rejects Haiku 5.5 when an authoritative adapter setting disables thinking", async () => {
    explicitThinking = "disabled"
    const response = await post(createTestApp(), { ...BASE_BODY, model: "claude-haiku-5-5", thinking: { type: "adaptive" } })
    expect(response.status).toBe(400)
    expect(capturedOptions).toEqual({})
  })

  it("rejects Haiku 5.5 when beta stripping authoritatively disables thinking", async () => {
    const saved = process.env.MERIDIAN_BETA_POLICY
    try {
      process.env.MERIDIAN_BETA_POLICY = "strip-all"
      const response = await post(createTestApp(), { ...BASE_BODY, model: "claude-haiku-5-5", thinking: { type: "adaptive" } },
        { "anthropic-beta": "interleaved-thinking-2025-05-14" })
      expect(response.status).toBe(400)
      expect(capturedOptions).toEqual({})
    } finally {
      if (saved === undefined) delete process.env.MERIDIAN_BETA_POLICY
      else process.env.MERIDIAN_BETA_POLICY = saved
    }
  })

  it("permits default/adaptive Haiku 5.5 and leaves explicit legacy off usable", async () => {
    for (const request of [
      { ...BASE_BODY, model: "claude-haiku-5-5" },
      { ...BASE_BODY, model: "claude-haiku-5-5", thinking: { type: "adaptive", display: "summarized" } },
      { ...BASE_BODY, thinking: { type: "disabled" } },
    ]) {
      const response = await post(createTestApp(), request)
      expect(response.status).toBe(200)
      expect(Object.keys(capturedOptions).length).toBeGreaterThan(0)
    }
  })

  it("records effective Haiku pins without relabeling client aliases in both response modes", async () => {
    const saved = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    try {
      for (const stream of [false, true]) {
        for (const pin of ["claude-haiku-4-5", "claude-haiku-5-5"]) {
          process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = pin
          const response = await post(createTestApp(), { ...BASE_BODY, model: "haiku", stream })
          expect(response.status).toBe(200)
          await response.text()
          const row = telemetryStore.getRecent({ limit: 1 })[0]!
          expect(row.model).toBe("haiku")
          expect(row.requestModel).toBe("haiku")
          expect(row.resolvedModel).toBe(pin)
        }
      }
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
      else process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = saved
    }
  })

  it("\"adaptive\" applies as a default only when the client sent nothing", async () => {
    explicitThinking = "adaptive"
    defaultThinking = "adaptive"
    const app = createTestApp()
    await post(app, BASE_BODY)
    expect(capturedOptions.thinking).toEqual({ type: "adaptive" })
  })
})
