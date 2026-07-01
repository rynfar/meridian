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
import { assistantMessage } from "./helpers"

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

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedOptions = params.options ?? {}
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
  beforeEach(() => {
    capturedOptions = {}
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    explicitThinking = undefined
    defaultThinking = "disabled"
    clearSessionCache()
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

  it("\"adaptive\" applies as a default only when the client sent nothing", async () => {
    explicitThinking = "adaptive"
    defaultThinking = "adaptive"
    const app = createTestApp()
    await post(app, BASE_BODY)
    expect(capturedOptions.thinking).toEqual({ type: "adaptive" })
  })
})
