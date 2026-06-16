/**
 * Silent-mode logging.
 *
 * When Meridian runs embedded under an interactive TUI host (e.g.
 * opencode-with-claude), its routine `[PROXY]` operational stderr pollutes the
 * host's input line — the same class of issue as the token_refresh line (#517).
 * `config.silent` (settable via MERIDIAN_SILENT) suppresses that routine output
 * while leaving the structured telemetry (claudeLog) and HTTP responses intact.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test"
import { assistantMessage } from "./helpers"

let mockMessages: unknown[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => (async function* () { for (const msg of mockMessages) yield msg })(),
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

const BASE_BODY = {
  model: "claude-haiku-4-5-20251001",
  max_tokens: 50,
  stream: false,
  messages: [{ role: "user", content: "hi" }],
}

function post(app: { fetch: (r: Request) => Response | Promise<Response> }) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(BASE_BODY),
  }))
}

async function captureStderr(run: () => unknown): Promise<string[]> {
  const original = console.error
  const lines: string[] = []
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")) }
  try {
    await run()
  } finally {
    console.error = original
  }
  return lines
}

describe("silent-mode [PROXY] logging", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    clearSessionCache()
  })

  it("suppresses [PROXY] operational stderr when config.silent is true", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const stderr = await captureStderr(() => post(app))
    expect(stderr.filter(l => l.includes("[PROXY]"))).toHaveLength(0)
  })

  it("still emits [PROXY] operational stderr by default (not silent)", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const stderr = await captureStderr(() => post(app))
    expect(stderr.some(l => l.includes("[PROXY]"))).toBe(true)
  })
})
