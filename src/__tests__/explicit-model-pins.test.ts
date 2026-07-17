/**
 * Explicit model-id pinning — #631.
 *
 * All sonnet/opus/haiku/fable-family requests collapse to SDK tier aliases
 * resolved by ANTHROPIC_DEFAULT_{TIER}_MODEL pins. Before this fix the pins
 * were canonical-only, so an explicit `claude-sonnet-5` silently resolved to
 * the canonical sonnet (4.6) — and `claude-opus-4-7` to 4.8. A proxy must
 * never substitute models: fully-versioned ids now pin their tier for that
 * request, and the bare aliases mean "the current model of that tier".
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"

// ---------- unit: explicitModelPin + canonical bump ----------

const { explicitModelPin, CANONICAL_SONNET_MODEL } = await import("../proxy/models")

describe("explicitModelPin (#631)", () => {
  it("pins fully-versioned sonnet ids", () => {
    expect(explicitModelPin("claude-sonnet-5")).toEqual({ ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" })
    expect(explicitModelPin("claude-sonnet-4-6")).toEqual({ ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6" })
  })

  it("pins fully-versioned opus and date-suffixed haiku ids", () => {
    expect(explicitModelPin("claude-opus-4-7")).toEqual({ ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-7" })
    expect(explicitModelPin("claude-haiku-4-5-20251001")).toEqual({ ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001" })
  })

  it("routes mythos ids through the fable tier pin", () => {
    expect(explicitModelPin("claude-mythos-5")).toEqual({ ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-mythos-5" })
    expect(explicitModelPin("claude-fable-5")).toEqual({ ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5" })
  })

  it("strips the [1m] context suffix before pinning", () => {
    expect(explicitModelPin("claude-sonnet-5[1m]")).toEqual({ ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" })
  })

  it("leaves bare aliases and family names on the canonical pins", () => {
    expect(explicitModelPin("sonnet")).toBeUndefined()
    expect(explicitModelPin("sonnet[1m]")).toBeUndefined()
    expect(explicitModelPin("opus")).toBeUndefined()
    expect(explicitModelPin("claude-sonnet")).toBeUndefined()
    expect(explicitModelPin("gpt-4o")).toBeUndefined()
    expect(explicitModelPin("")).toBeUndefined()
  })
})

describe("canonical sonnet pin (#631)", () => {
  it("bare sonnet means the current Sonnet", () => {
    expect(CANONICAL_SONNET_MODEL).toBe("claude-sonnet-5")
  })
})

// ---------- integration: pins reach the SDK subprocess env ----------

let queryEnvs: Array<Record<string, string | undefined>> = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    queryEnvs.push(opts.options?.env || {})
    return (async function* () {
      yield {
        type: "assistant",
        uuid: "uuid-1",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 2 },
        },
        session_id: "sdk-1",
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function post(app: any, model: string) {
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
  )
}

describe("explicit model pins reach the subprocess env (#631)", () => {
  beforeEach(() => {
    clearSessionCache()
    queryEnvs = []
  })

  it("claude-sonnet-5 pins the sonnet tier for the request", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, "claude-sonnet-5")
    expect(res.status).toBe(200)
    expect(queryEnvs[0]!.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5")
  })

  it("claude-opus-4-7 pins the opus tier instead of canonical 4.8", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, "claude-opus-4-7")
    expect(res.status).toBe(200)
    expect(queryEnvs[0]!.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-7")
  })

  it("bare sonnet resolves via the canonical pin (now Sonnet 5)", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await post(app, "sonnet")
    expect(res.status).toBe(200)
    expect(queryEnvs[0]!.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5")
  })
})
