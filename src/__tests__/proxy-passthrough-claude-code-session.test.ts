/**
 * A gateway-fronted Claude Code session keeps the exemption it has directly
 * (#820).
 *
 * The headerless tool-result bypass exempts `adapterBase === "claude-code"`,
 * because Claude Code owns its tool loop but still expects Meridian to resume
 * the backing SDK session. Behind LiteLLM the passthrough heuristic claims the
 * request first, so that exemption was lost — and LiteLLM owns the
 * `x-litellm-*` namespace for its own Langfuse session tracking and does not
 * forward `x-litellm-session-id` upstream on the `anthropic/` provider route,
 * so there was no session key either. @StanChmielewski verified that with an
 * identical two-request probe down both paths: direct to Meridian logged
 * `Stale session detected`, through LiteLLM logged nothing.
 *
 * Every tool round of the whole agentic loop then took the bypass, at 35k-56k
 * cache-write tokens per turn with `cache_read` pinned at 30629, against 46-53
 * tokens on a direct connection; one 764-turn session accumulated 90M
 * cache-creation tokens.
 *
 * The exemption now follows the CLIENT rather than the adapter. Adapter
 * selection is untouched, and `x-claude-code-session-id` is deliberately NOT
 * adopted as a session key — see the collision case at the bottom.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

let mockMessages: unknown[] = []
let capturedOptions: any[] = []

installSdkMock(() => ({
  query: (params: any) => {
    const options = params.options || {}
    capturedOptions.push(options)
    const sessionId = resolveMockSdkSessionId(options, "cc-gateway-session")
    return (async function* () {
      for (const msg of mockMessages) yield { ...(msg as object), session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-passthrough-claude-code-session.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

/** The real header value shape: a CLI session UUID. */
const CC_SESSION = "b2004dfc-6042-48d9-9c23-b4475f64b6f5"

const TURN_1 = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: false,
  messages: [{ role: "user", content: "read alpha.txt and tell me what it says" }],
}

/** Ends in user[tool_result] — the shape that took the bypass. */
const TURN_2 = {
  ...TURN_1,
  messages: [
    ...TURN_1.messages,
    { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "alpha.txt" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ALPHA-VALUE" }] },
  ],
}

/** A plain follow-up after the tool round. */
const TURN_3 = {
  ...TURN_1,
  messages: [
    ...TURN_2.messages,
    { role: "assistant", content: "It says ALPHA-VALUE." },
    { role: "user", content: "thanks, now say FINISHED" },
  ],
}

describe("gateway-fronted Claude Code session identity", () => {
  const gateway = { "x-meridian-agent": "passthrough", "x-claude-code-session-id": CC_SESSION }

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    capturedOptions = []
    clearSessionCache()
  })

  afterEach(() => {
    clearSessionCache()
  })

  // THE REPORTED CASE. The tool round used to take the bypass, which skips the
  // lineage lookup AND the end-of-turn store.
  it("resumes a tool-result round instead of bypassing it", async () => {
    const app = createTestApp()
    expect((await post(app, TURN_1, gateway)).status).toBe(200)
    expect((await post(app, TURN_2, gateway)).status).toBe(200)
    expect(capturedOptions).toHaveLength(2)
    expect(capturedOptions[0].resume).toBeUndefined()
    expect(capturedOptions[1].resume).toBe(capturedOptions[0].sessionId)
  })

  it("keeps resuming across a following plain turn", async () => {
    const app = createTestApp()
    await post(app, TURN_1, gateway)
    await post(app, TURN_2, gateway)
    await post(app, TURN_3, gateway)
    expect(capturedOptions).toHaveLength(3)
    expect(capturedOptions[2].resume).toBeDefined()
  })

  // The bypass must stay intact for every client that is NOT Claude Code. This
  // is the guard the exemption could quietly remove.
  it("leaves the bypass in place for a client that does not send the header", async () => {
    const app = createTestApp()
    const headerless = { "x-meridian-agent": "passthrough" }
    await post(app, TURN_1, headerless)
    await post(app, TURN_2, headerless)
    expect(capturedOptions).toHaveLength(2)
    expect(capturedOptions[1].resume).toBeUndefined()
  })

  // An explicit LiteLLM key still wins, and still keys the conversation.
  it("resumes a keyed LiteLLM conversation as before", async () => {
    const app = createTestApp()
    const keyed = { "x-meridian-agent": "passthrough", "x-litellm-session-id": "litellm-forwarded" }
    await post(app, TURN_1, keyed)
    await post(app, TURN_2, keyed)
    expect(capturedOptions).toHaveLength(2)
    expect(capturedOptions[1].resume).toBe(capturedOptions[0].sessionId)
  })

  // WHY THE HEADER IS NOT THE KEY. The CLI reuses one session id across the
  // auxiliary requests it makes alongside a conversation. Keying on it put two
  // unrelated first messages under one key; live, that produced
  // `unrelated-history` and an HTTP 400 concurrent conflict — turning a silent
  // inefficiency into a hard client failure. Keyed by fingerprint the two
  // simply do not meet.
  it("does not conflate two different conversations under one CLI session id", async () => {
    const app = createTestApp()
    const AUXILIARY = {
      ...TURN_1,
      messages: [{ role: "user", content: "Summarise this conversation in five words." }],
    }
    expect((await post(app, TURN_1, gateway)).status).toBe(200)
    expect((await post(app, AUXILIARY, gateway)).status).toBe(200)
    expect(capturedOptions).toHaveLength(2)
    // A shared key would have classified this as unrelated-history and, once
    // the first turn had committed, refused it outright.
    expect(capturedOptions[1].resume).toBeUndefined()
  })
})
