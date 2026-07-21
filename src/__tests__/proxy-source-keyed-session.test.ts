/**
 * Explicit session keys override the fork/subagent independence guard.
 *
 * The x-meridian-source independence guard exists to stop HEADERLESS
 * concurrent flows from colliding on the shared (firstUserMessage, cwd)
 * fingerprint. Pylon's long-lived subagent workers were swept up by it:
 * every turn of a worker conversation fresh-replayed (lineage=new, no
 * store), so prompt-cache efficiency decayed to the static-prefix floor
 * (97% → 31%) and turn latency grew with conversation length.
 *
 * Keyed sessions cannot collide — distinct workers carry distinct keys —
 * so an explicit session id disables the guard while headerless forks
 * keep today's behavior. The pi adapter (pylon's runtime) gains
 * x-session-affinity support so its flows can carry a key at all.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { assistantMessage } from "./helpers"

let mockMessages: unknown[] = []
let capturedOptions: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedOptions.push(params.options || {})
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

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

const TURN_1 = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: false,
  messages: [{ role: "user", content: "subagent worker task prompt" }],
}

const TURN_2 = {
  ...TURN_1,
  messages: [
    ...TURN_1.messages,
    { role: "assistant", content: "ok" },
    { role: "user", content: "keep going" },
  ],
}

describe("explicit session keys override the independence guard", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    capturedOptions = []
    clearSessionCache()
  })

  afterEach(() => {
    clearSessionCache()
  })

  it("pi subagent-worker WITH x-session-affinity resumes across turns", async () => {
    const app = createTestApp()
    const headers = {
      "x-meridian-agent": "pi",
      "x-meridian-source": "subagent-worker",
      "x-session-affinity": "worker-run-abc123",
    }
    expect((await post(app, TURN_1, headers)).status).toBe(200)
    expect((await post(app, TURN_2, headers)).status).toBe(200)
    expect(capturedOptions).toHaveLength(2)
    expect(capturedOptions[0].resume).toBeUndefined()
    expect(capturedOptions[1].resume).toBe("test-session")
  })

  it("pi subagent-worker WITHOUT a session key keeps the independence guard (no resume)", async () => {
    const app = createTestApp()
    const headers = { "x-meridian-agent": "pi", "x-meridian-source": "subagent-worker" }
    await post(app, TURN_1, headers)
    await post(app, TURN_2, headers)
    expect(capturedOptions).toHaveLength(2)
    expect(capturedOptions[1].resume).toBeUndefined()
  })

  it("distinct affinity keys stay isolated (no cross-worker resume)", async () => {
    const app = createTestApp()
    const base = { "x-meridian-agent": "pi", "x-meridian-source": "subagent-worker" }
    await post(app, TURN_1, { ...base, "x-session-affinity": "worker-a" })
    await post(app, TURN_2, { ...base, "x-session-affinity": "worker-b" })
    expect(capturedOptions).toHaveLength(2)
    expect(capturedOptions[1].resume).toBeUndefined()
  })

  it("fork sources with an explicit key resume too (opencode header path)", async () => {
    const app = createTestApp()
    const headers = {
      "x-meridian-source": "fork-memory-extract",
      "x-opencode-session": "ses_fork_1",
    }
    await post(app, TURN_1, headers)
    await post(app, TURN_2, headers)
    expect(capturedOptions).toHaveLength(2)
    expect(capturedOptions[1].resume).toBe("test-session")
  })
})
