/**
 * Tests for tool blocking consistency across all code paths.
 *
 * The proxy has 4 SDK query() call sites that must all block the same tools:
 *   1. Non-stream, normal mode
 *   2. Non-stream, passthrough mode
 *   3. Stream, normal mode
 *   4. Stream, passthrough mode
 *
 * Both BLOCKED_BUILTIN_TOOLS and CLAUDE_CODE_ONLY_TOOLS must be in
 * disallowedTools for ALL paths. Regressions here cause tool calls to
 * leak as raw text instead of being executed by OpenCode (#111, #94).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage } from "./helpers"

let capturedQueryParams: any = null
let mockMessages: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) {
        yield { ...msg, session_id: "sdk-test" }
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

const toolBlockingTmpDir = mkdtempSync(join(tmpdir(), "tool-blocking-test-"))
process.env.CLAUDE_PROXY_SESSION_DIR = toolBlockingTmpDir

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { clearSharedSessions } = await import("../proxy/sessionStore")

afterEach(() => {
  delete process.env.CLAUDE_PROXY_PASSTHROUGH
})

import { afterAll } from "bun:test"
afterAll(() => {
  rmSync(toolBlockingTmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_PROXY_SESSION_DIR
  mock.restore()
})

// The complete set of tools that must ALWAYS be blocked
const BLOCKED_BUILTIN_TOOLS = [
  "Read", "Write", "Edit",
  "Bash", "Glob", "Grep", "NotebookEdit",
  "WebFetch", "WebSearch", "TodoWrite"
]

const CLAUDE_CODE_ONLY_TOOLS = [
  "CronCreate", "CronDelete", "CronList",
  "EnterPlanMode", "ExitPlanMode",
  "EnterWorktree", "ExitWorktree",
  "Monitor",
  "NotebookEdit",
  "PushNotification",
  "RemoteTrigger",
  "ScheduleWakeup",
  "TodoWrite",
  "AskUserQuestion",
  "Skill",
  "Agent",
  "TaskOutput",
  "TaskStop",
  "WebSearch",
]

const ALL_BLOCKED = [...new Set([...BLOCKED_BUILTIN_TOOLS, ...CLAUDE_CODE_ONLY_TOOLS])]

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function sendRequest(app: any, stream: boolean, headers: Record<string, string> = {}) {
  capturedQueryParams = null
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream,
      messages: [{ role: "user", content: "hello" }],
    }),
  }))

  if (stream) {
    const reader = response.body?.getReader()
    if (reader) {
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
    }
  } else {
    await response.json()
  }

  return capturedQueryParams
}

function assertAllToolsBlocked(params: any, label: string) {
  const disallowed = params?.options?.disallowedTools || []
  for (const tool of ALL_BLOCKED) {
    expect(disallowed).toContain(tool)
  }
}

beforeEach(() => {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
  capturedQueryParams = null
  clearSessionCache()
  clearSharedSessions()
})

describe("Tool blocking: normal mode (non-passthrough)", () => {
  beforeEach(() => {
    delete process.env.CLAUDE_PROXY_PASSTHROUGH
  })

  it("blocks all builtin + claude-code-only tools in non-stream mode", async () => {
    const app = createTestApp()
    const params = await sendRequest(app, false)
    assertAllToolsBlocked(params, "normal/non-stream")
  })

  it("blocks all builtin + claude-code-only tools in stream mode", async () => {
    const app = createTestApp()
    const params = await sendRequest(app, true)
    assertAllToolsBlocked(params, "normal/stream")
  })
})

// A Claude Code CLI client drives its own tool loop. server.ts resolves tool
// config and passthrough from `pipelineCtx.*` — never from the adapter methods
// — so with no registry entry for "claude-code" the request kept the
// createRequestContext defaults: `blockedTools: []` and `passthrough:
// undefined`. The SDK subprocess then had its own Read/Write/Bash available
// while the client executed the same tool_use blocks locally, so a side effect
// could happen twice (#735).
//
// These go through the HTTP layer on purpose: transform-parity tests assert the
// transform's VALUES, and every one of them passed while this was broken. The
// defect was the wiring between the registry and the request, which only a
// server-level assertion can see.
// #744: claudeCodeAdapter returns undefined from extractWorkingDirectory (so the
// subprocess never chdirs into a layout that may not exist here), and surfaces
// the client's real path via extractClientWorkingDirectory. When that path DOES
// exist on the proxy host it should become the SDK's cwd — otherwise the SDK
// advertises the proxy's own directory and the model composes absolute paths
// against the wrong tree, writing to the proxy host while reporting success.
//
// Asserted through the HTTP layer on purpose: the resolver can be exercised
// directly, but that only re-tests a copy of the call-site expression (#707).
describe("SDK cwd for a claude-code client (#744)", () => {
  let clientDir: string
  let savedAgent: string | undefined

  beforeEach(() => {
    clientDir = mkdtempSync(join(tmpdir(), "meridian-client-cwd-"))
    savedAgent = process.env.MERIDIAN_DEFAULT_AGENT
    delete process.env.MERIDIAN_DEFAULT_AGENT
  })
  afterEach(() => {
    rmSync(clientDir, { recursive: true, force: true })
    if (savedAgent !== undefined) process.env.MERIDIAN_DEFAULT_AGENT = savedAgent
    else delete process.env.MERIDIAN_DEFAULT_AGENT
  })

  /** The system-prompt shape a real Claude Code CLI sends. */
  const systemFor = (cwd: string) => [
    { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
    { type: "text", text: `# Environment\nYou have been invoked in the following environment:\n - Primary working directory: ${cwd}\n - Platform: darwin\n` },
  ]

  async function postAs(system: any) {
    capturedQueryParams = null
    const res = await createTestApp().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "user-agent": "claude-cli/1.0.60 (external)" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5", max_tokens: 64, stream: false,
        system, messages: [{ role: "user", content: "hi" }],
      }),
    }))
    await res.json()
    return capturedQueryParams
  }

  it("uses the client's directory as the SDK cwd when it exists here", () => {
    return postAs(systemFor(clientDir)).then((params) => {
      expect(params?.options?.cwd).toBe(clientDir)
    })
  })

  it("falls back to a valid server path when the client directory does not exist (#381)", () => {
    // Remote client: its filesystem layout is absent here, and chdiring into it
    // would fail the SDK spawn with a misleading error.
    return postAs(systemFor("/definitely/not/here/meridian-744")).then((params) => {
      expect(params?.options?.cwd).not.toBe("/definitely/not/here/meridian-744")
      expect(params?.options?.cwd).toBe(process.cwd())
    })
  })
})

describe("Tool blocking: claude-code adapter (#735)", () => {
  let savedAgent: string | undefined
  beforeEach(() => {
    // Default install: no passthrough opt-in, and no default-agent override
    // (which would reroute the ambiguous claude-cli User-Agent elsewhere).
    delete process.env.CLAUDE_PROXY_PASSTHROUGH
    delete process.env.MERIDIAN_PASSTHROUGH
    savedAgent = process.env.MERIDIAN_DEFAULT_AGENT
    delete process.env.MERIDIAN_DEFAULT_AGENT
  })
  afterEach(() => {
    if (savedAgent !== undefined) process.env.MERIDIAN_DEFAULT_AGENT = savedAgent
    else delete process.env.MERIDIAN_DEFAULT_AGENT
  })

  const CLAUDE_CLI_UA = { "user-agent": "claude-cli/1.0.60 (external)" }

  it("blocks the SDK's built-in tools for a claude-cli client (non-stream)", async () => {
    const app = createTestApp()
    const params = await sendRequest(app, false, CLAUDE_CLI_UA)
    assertAllToolsBlocked(params, "claude-code/non-stream")
  })

  it("blocks the SDK's built-in tools for a claude-cli client (stream)", async () => {
    const app = createTestApp()
    const params = await sendRequest(app, true, CLAUDE_CLI_UA)
    assertAllToolsBlocked(params, "claude-code/stream")
  })

  it("does not leave disallowedTools empty, which is the actual regression", async () => {
    // Stated separately from assertAllToolsBlocked: an empty list is the exact
    // broken state, and a future change that empties it should fail on a test
    // whose name says so.
    const app = createTestApp()
    const params = await sendRequest(app, false, CLAUDE_CLI_UA)
    expect((params?.options?.disallowedTools || []).length).toBeGreaterThan(0)
  })
})

describe("Tool blocking: passthrough mode", () => {
  beforeEach(() => {
    process.env.CLAUDE_PROXY_PASSTHROUGH = "1"
  })

  it("blocks all builtin + claude-code-only tools in non-stream mode", async () => {
    const app = createTestApp()
    const params = await sendRequest(app, false)
    assertAllToolsBlocked(params, "passthrough/non-stream")
  })

  it("blocks all builtin + claude-code-only tools in stream mode", async () => {
    const app = createTestApp()
    const params = await sendRequest(app, true)
    assertAllToolsBlocked(params, "passthrough/stream")
  })
})

describe("Tool blocking: consistency across all paths", () => {
  it("all 4 paths produce identical disallowedTools lists", async () => {
    const results: { mode: string; tools: string[] }[] = []

    // Normal non-stream
    delete process.env.CLAUDE_PROXY_PASSTHROUGH
    let app = createTestApp()
    let params = await sendRequest(app, false)
    results.push({ mode: "normal/non-stream", tools: [...params.options.disallowedTools].sort() })

    // Normal stream
    clearSessionCache()
    app = createTestApp()
    params = await sendRequest(app, true)
    results.push({ mode: "normal/stream", tools: [...params.options.disallowedTools].sort() })

    // Passthrough non-stream
    process.env.CLAUDE_PROXY_PASSTHROUGH = "1"
    clearSessionCache()
    app = createTestApp()
    params = await sendRequest(app, false)
    results.push({ mode: "passthrough/non-stream", tools: [...params.options.disallowedTools].sort() })

    // Passthrough stream
    clearSessionCache()
    app = createTestApp()
    params = await sendRequest(app, true)
    results.push({ mode: "passthrough/stream", tools: [...params.options.disallowedTools].sort() })

    // All 4 must be identical
    const baseline = results[0]!.tools
    for (const result of results.slice(1)) {
      expect(result.tools).toEqual(baseline)
    }
  })
})
