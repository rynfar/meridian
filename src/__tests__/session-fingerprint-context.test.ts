/**
 * Tests for fingerprint-based session resume.
 *
 * The fingerprint hashes the first user message only (not systemContext).
 * OpenCode's system prompt contains dynamic content (file trees, diagnostics)
 * that changes every request, making systemContext-based hashing unstable.
 *
 * Cross-project safety is handled by lineage verification — different
 * projects will have different message content after turn 1, so the
 * lineage hash will mismatch and prevent incorrect resume.
 *
 * These tests cover:
 * - Resume works even when systemContext changes between requests
 * - Resume works across stream and non-stream
 * - Lineage catches cross-project collisions (same first message, different history)
 * - Different first messages produce different fingerprints
 * - Backward compat without systemContext
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

type MockSdkMessage = Record<string, unknown>
type TestApp = { fetch: (req: Request) => Promise<Response> }

let mockMessages: MockSdkMessage[] = []
interface CapturedFPQueryParams {
  prompt?: unknown
  options?: { resume?: string; forkSession?: boolean; sessionId?: string }
}
let capturedQueryParams: CapturedFPQueryParams | null = null
function getCaptured(): CapturedFPQueryParams | null { return capturedQueryParams }
let queuedSessionLabels: string[] = []
let callerSelectedSessionIds = new Map<string, string>()

function getCallerSelectedSessionId(label: string): string {
  const sessionId = callerSelectedSessionIds.get(label)
  if (!sessionId) throw new Error(`No caller-selected session ID captured for ${label}`)
  return sessionId
}

installSdkMock(() => ({
  query: (params: unknown) => {
    capturedQueryParams = params as CapturedFPQueryParams
    const sessionLabel = queuedSessionLabels.shift()
    const options = (params as CapturedFPQueryParams).options
    if (sessionLabel && options?.sessionId) {
      callerSelectedSessionIds.set(sessionLabel, options.sessionId)
    }
    const sessionId = resolveMockSdkSessionId(options)
    if (!sessionId) throw new Error("Expected Meridian to select or resume an SDK session")
    return (async function* () {
      for (const msg of mockMessages) {
        yield { ...msg, session_id: sessionId }
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "session-fingerprint-context.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => Promise<Response> | Response) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const fpTmpDir = mkdtempSync(join(tmpdir(), "session-fp-context-test-"))
process.env.CLAUDE_PROXY_SESSION_DIR = fpTmpDir

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { clearSharedSessions } = await import("../proxy/sessionStore")

afterAll(() => {
  rmSync(fpTmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_PROXY_SESSION_DIR
  mock.restore()
})

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app as TestApp
}

/** Send a request WITHOUT a session header (fingerprint fallback path) */
async function postNoSession(
  app: TestApp,
  messages: Array<{ role: string; content: string }>,
  sessionLabel: string,
  system?: string,
  stream = false
) {
  queuedSessionLabels.push(sessionLabel)
  const body: Record<string, unknown> = {
    model: "claude-sonnet-4-5",
    max_tokens: 128,
    stream,
    messages,
  }
  if (system) body.system = system

  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
}

beforeEach(() => {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
  capturedQueryParams = null
  queuedSessionLabels = []
  callerSelectedSessionIds = new Map()
  clearSessionCache()
  clearSharedSessions()
})

describe("Fingerprint resume: stable across dynamic systemContext", () => {
  it("resumes when systemContext changes between requests (non-stream)", async () => {
    const app = createTestApp()

    // Turn 1 — system prompt v1
    await postNoSession(app, [
      { role: "user", content: "hello" },
    ], "sdk-1", "System v1: file tree has 10 files")

    // Turn 2 — system prompt changed (dynamic content), same first user message
    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you?" },
    ], "sdk-1", "System v2: file tree has 15 files, 3 diagnostics")

    // MUST resume — fingerprint doesn't include systemContext
    expect(getCaptured()?.options?.resume).toBeDefined()
  })

  it("resumes when systemContext changes between requests (stream)", async () => {
    const app = createTestApp()

    await postNoSession(app, [
      { role: "user", content: "hello" },
    ], "sdk-stream-1", "System v1", true)

    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "what can you do?" },
    ], "sdk-stream-1", "System v2 with more context", true)

    expect(getCaptured()?.options?.resume).toBeDefined()
  })

  it("resumes when systemContext is added where there was none", async () => {
    const app = createTestApp()

    await postNoSession(app, [
      { role: "user", content: "hello" },
    ], "sdk-no-ctx")

    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "help me" },
    ], "sdk-no-ctx", "You are a helpful assistant.")

    // MUST resume — systemContext not in fingerprint
    expect(getCaptured()?.options?.resume).toBeDefined()
  })

  it("resumes when systemContext is removed", async () => {
    const app = createTestApp()

    await postNoSession(app, [
      { role: "user", content: "hello" },
    ], "sdk-ctx", "You are a helpful assistant.")

    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "thanks" },
    ], "sdk-ctx")

    expect(getCaptured()?.options?.resume).toBeDefined()
  })
})

describe("Fingerprint resume: cross-project safety via lineage", () => {
  it("does NOT resume wrong project when first message matches but history diverges", async () => {
    const app = createTestApp()

    // Project A: "hello" → assistant responds → user asks about project A files
    await postNoSession(app, [
      { role: "user", content: "hello" },
    ], "sdk-project-a")

    // Simulate project A continuing
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi, how can I help with project A?" },
      { role: "user", content: "list the project A files" },
    ], "sdk-project-a")

    // Project B: same "hello" start, but different assistant response (different project)
    // Lineage hash will mismatch because messages[1] differs
    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi, how can I help with project B?" },
      { role: "user", content: "list the project B files" },
    ], "sdk-project-b")

    // OpenCode without session header: undo is downgraded to diverged to
    // prevent cross-session fingerprint collisions (headerless requests
    // from category-dispatched or title-generation flows).
    expect(getCaptured()?.options?.resume).toBeUndefined()
  })

  it("resumes correctly after cross-project rejection creates new session", async () => {
    const app = createTestApp()

    // Project A
    await postNoSession(app, [
      { role: "user", content: "hello" },
    ], "sdk-project-a")
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "project A response" },
      { role: "user", content: "continue A" },
    ], "sdk-project-a")

    // Project B — different history, creates fresh session
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "project B response" },
      { role: "user", content: "continue B" },
    ], "sdk-project-b")

    // Project B continues — should resume sdk-project-b
    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "project B response" },
      { role: "user", content: "continue B" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "more B work" },
    ], "sdk-project-b")

    expect(getCaptured()?.options?.resume).toBeDefined()
  })
})

describe("Fingerprint resume: different first messages", () => {
  it("does NOT resume when first user message differs", async () => {
    const app = createTestApp()

    await postNoSession(app, [
      { role: "user", content: "hello" },
    ], "sdk-hello")

    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "goodbye" },
      { role: "assistant", content: "bye" },
      { role: "user", content: "wait" },
    ], "sdk-goodbye")

    expect(getCaptured()?.options?.resume).toBeUndefined()
  })
})

describe("Fingerprint resume: multi-turn with tool_use blocks", () => {
  it("resumes correctly when history contains tool_use and tool_result", async () => {
    const app = createTestApp()

    // Turn 1
    await postNoSession(app, [
      { role: "user", content: "create a file" },
    ], "sdk-tools", "System prompt v1")

    // Turn 2 — history has tool_use/tool_result (this is what OpenCode sends)
    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "create a file" },
      { role: "assistant", content: [
        { type: "text", text: "I'll create that file." },
        { type: "tool_use", id: "toolu_123", name: "write", input: { path: "test.txt", content: "hello" } },
      ] as any },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_123", content: "File written." },
      ] as any },
      { role: "assistant", content: "Done! File created." },
      { role: "user", content: "now read it back" },
    ], "sdk-tools", "System prompt v2 with updated file tree")

    // MUST resume even though system changed and history has tool blocks
    expect(getCaptured()?.options?.resume).toBeDefined()
  })

  it("does NOT resume after undo even with tool_use in history", async () => {
    const app = createTestApp()

    await postNoSession(app, [
      { role: "user", content: "create a file" },
    ], "sdk-tools-undo")

    await postNoSession(app, [
      { role: "user", content: "create a file" },
      { role: "assistant", content: "I'll create that file." },
      { role: "user", content: "use bash to list files" },
    ], "sdk-tools-undo")

    // /undo — different message 3
    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "create a file" },
      { role: "assistant", content: "I'll create that file." },
      { role: "user", content: "actually, delete that file instead" },
    ], "sdk-tools-undo-new")

    // OpenCode without session header: undo is downgraded to diverged
    expect(getCaptured()?.options?.resume).toBeUndefined()
  })
})

describe("Fingerprint isolation: headered sessions must not leak into fingerprint cache", () => {
  /** Send a request WITH a session header (header-tracked path) */
  async function postWithSession(
    app: TestApp,
    sessionHeader: string,
    messages: Array<{ role: string; content: string }>,
    sessionLabel: string,
  ) {
    queuedSessionLabels.push(sessionLabel)
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-session": sessionHeader,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: false,
        messages,
      }),
    }))
    await response.json()
  }

  it("headerless request does not resume a headered session with the same fingerprint", async () => {
    const app = createTestApp()

    // Session A: tracked by header, builds up a 3-message conversation
    await postWithSession(app, "sess-A", [
      { role: "user", content: "ping" },
    ], "sdk-A")
    await postWithSession(app, "sess-A", [
      { role: "user", content: "ping" },
      { role: "assistant", content: "pong" },
      { role: "user", content: "how are you?" },
    ], "sdk-A")

    // Session B: headerless (simulates OpenCode category-dispatched request),
    // same first message → same fingerprint. Must NOT resume session A.
    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "ping" },
    ], "sdk-B")

    expect(getCaptured()?.options?.resume).toBeUndefined()
  })
})

describe("Fingerprint resume: backward compat", () => {
  it("resumes correctly without systemContext", async () => {
    const app = createTestApp()

    await postNoSession(app, [
      { role: "user", content: "hello" },
    ], "sdk-no-ctx")

    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "thanks" },
    ], "sdk-no-ctx")

    expect(getCaptured()?.options?.resume).toBeDefined()
  })
})


describe("Fingerprint resume: OpenCode CWD-key transition", () => {
  it("moves once from the override key to the client key and keeps the new key across restart", async () => {
    const originalProxy = process.env.CLAUDE_PROXY_WORKDIR
    const originalMeridian = process.env.MERIDIAN_WORKDIR
    const proxyCwd = tmpdir()
    const clientCwd = "C:\\projects\\remote-app"
    process.env.CLAUDE_PROXY_WORKDIR = proxyCwd
    delete process.env.MERIDIAN_WORKDIR

    try {
      const firstApp = createTestApp()
      await postNoSession(firstApp, [
        { role: "user", content: "hello from the migration fixture" },
      ], "override-key", "OpenCode prompt without an environment block")
      const oldSession = getCallerSelectedSessionId("override-key")
      expect(getCaptured()?.options?.resume).toBeUndefined()

      capturedQueryParams = null
      await postNoSession(firstApp, [
        { role: "user", content: "hello from the migration fixture" },
      ], "client-key", `<env>\nWorking directory: ${clientCwd}\nIs directory a git repo: yes\n</env>`)
      const newSession = getCallerSelectedSessionId("client-key")
      expect(newSession).not.toBe(oldSession)
      expect(getCaptured()?.options?.resume).toBeUndefined()

      // Simulate a proxy restart: discard process-local cache but retain the
      // durable shared store written under the new client-path fingerprint.
      clearSessionCache()
      capturedQueryParams = null
      const restartedApp = createTestApp()
      await postNoSession(restartedApp, [
        { role: "user", content: "hello from the migration fixture" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue after restart" },
      ], "restart", `<env>\nWorking directory: ${clientCwd}\nIs directory a git repo: yes\n</env>`)

      expect(getCaptured()?.options?.resume).toBeDefined()
    } finally {
      if (originalProxy === undefined) delete process.env.CLAUDE_PROXY_WORKDIR
      else process.env.CLAUDE_PROXY_WORKDIR = originalProxy
      if (originalMeridian === undefined) delete process.env.MERIDIAN_WORKDIR
      else process.env.MERIDIAN_WORKDIR = originalMeridian
    }
  })
})
