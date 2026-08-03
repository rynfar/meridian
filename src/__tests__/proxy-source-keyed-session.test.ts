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


/**
 * #734: Oh My Pi carries a stable per-agent session id in `metadata.user_id`
 * rather than a header. Meridian's Pi adapter read only the header, so every
 * OMP request ending in `user[tool_result]` fell into the headerless
 * `isClientDrivenLoop` bypass — an independent request that skips lineage
 * lookup and starts a fresh SDK session on every tool round.
 *
 * The tool_result shape is the point: a plain `user[text]` follow-up already
 * resumed, which is why the reporter's telemetry showed 14 continuations for
 * text turns and 0 for 40 tool-result turns.
 */
describe("OMP body session identity survives the tool-result bypass (#734)", () => {
  const OMP = (sessionId: string) => ({
    metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
  })

  const TOOL_TURN_1 = {
    ...TURN_1,
    ...OMP("omp-main-734"),
  }
  /** Ends in user[tool_result] — the shape that triggered the bypass. */
  const TOOL_TURN_2 = {
    ...TURN_1,
    ...OMP("omp-main-734"),
    messages: [
      ...TURN_1.messages,
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "read", input: { p: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file contents" }] },
    ],
  }

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    capturedOptions = []
    clearSessionCache()
  })
  afterEach(() => {
    clearSessionCache()
  })

  it("resumes a tool-result turn when the body carries an OMP session id", async () => {
    const app = createTestApp()
    const headers = { "x-meridian-agent": "pi" }
    expect((await post(app, TOOL_TURN_1, headers)).status).toBe(200)
    expect((await post(app, TOOL_TURN_2, headers)).status).toBe(200)
    expect(capturedOptions).toHaveLength(2)
    expect(capturedOptions[0].resume).toBeUndefined()
    expect(capturedOptions[1].resume).toBe("test-session")
  })

  it("still refuses to resume a tool-result turn with no identity at all", async () => {
    // The bypass must stay intact for genuinely headerless concurrent loops,
    // where every request would otherwise share one key and collide.
    const app = createTestApp()
    const headers = { "x-meridian-agent": "pi" }
    const { metadata: _1, ...t1 } = TOOL_TURN_1 as any
    const { metadata: _2, ...t2 } = TOOL_TURN_2 as any
    await post(app, t1, headers)
    await post(app, t2, headers)
    expect(capturedOptions).toHaveLength(2)
    expect(capturedOptions[1].resume).toBeUndefined()
  })

  it("keeps distinct OMP agents on distinct sessions", async () => {
    // Main / Advisor / subagents each get their own id; adopting the key is
    // only safe because those ids differ.
    const app = createTestApp()
    const headers = { "x-meridian-agent": "pi" }
    await post(app, TOOL_TURN_1, headers)
    await post(app, { ...TOOL_TURN_2, ...OMP("omp-advisor-734") }, headers)
    expect(capturedOptions).toHaveLength(2)
    expect(capturedOptions[1].resume).toBeUndefined()
  })

  it("x-session-affinity still wins over the body id", async () => {
    const app = createTestApp()
    const headers = { "x-meridian-agent": "pi", "x-session-affinity": "hdr-734" }
    await post(app, TOOL_TURN_1, headers)
    await post(app, { ...TOOL_TURN_2, ...OMP("a-different-body-id") }, headers)
    expect(capturedOptions).toHaveLength(2)
    // Same header across both turns, so it resumes despite the body id changing.
    expect(capturedOptions[1].resume).toBe("test-session")
  })
})
