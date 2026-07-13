/**
 * Regression test for issue #386 — "New version still shows the Tools message in the context"
 *
 * The bug: in certain scenarios (proxy restart, cache eviction, new session header on rehydration),
 * meridian falls through to "diverged" lineage and replays the full conversation history. When that
 * history contains tool_use / tool_result blocks, they get flattened to `[Tool Use: name(...)]` and
 * `[Tool Result for toolu_...: ...]` strings in the text prompt sent to the SDK.
 *
 * This test reproduces the worst-case scenario that real users hit and verifies that the SDK
 * never receives a prompt containing those flattened tool strings.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage } from "./helpers"

type MockSdkMessage = Record<string, unknown>
type TestApp = { fetch: (req: Request) => Promise<Response> }

let mockMessages: MockSdkMessage[] = []
interface CapturedParams {
  prompt?: unknown
  options?: { resume?: string; forkSession?: boolean }
}
let capturedParams: CapturedParams | null = null
let queuedSessionIds: string[] = []
function getCaptured(): CapturedParams | null { return capturedParams }

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => {
    capturedParams = params as any
    const sessionId = queuedSessionIds.shift() || "sdk-session-default"
    return (async function* () {
      for (const msg of mockMessages) {
        yield { ...msg, session_id: sessionId }
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => Promise<Response> | Response) => fn(),
}))

const tmpDir = mkdtempSync(join(tmpdir(), "tool-flatten-regression-"))
process.env.CLAUDE_PROXY_SESSION_DIR = tmpDir

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { clearSharedSessions } = await import("../proxy/sessionStore")

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_PROXY_SESSION_DIR
  mock.restore()
})

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app as TestApp
}

async function postWithSession(
  app: TestApp,
  sessionHeader: string,
  messages: Array<{ role: string; content: any }>,
  sdkSessionId: string,
) {
  queuedSessionIds.push(sdkSessionId)
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-session": sessionHeader,
      "user-agent": "opencode/1.0.0",
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

function promptToString(prompt: unknown): string {
  if (typeof prompt === "string") return prompt
  return ""
}

/** Assert the SDK prompt contains no flattened tool-use strings */
function assertNoFlattenedToolBlocks(prompt: unknown) {
  const s = promptToString(prompt)
  expect(s).not.toContain("[Tool Use:")
  expect(s).not.toContain("[Tool Result")
  expect(s).not.toContain("[Tool Result for")
}

const history = [
  { role: "user", content: "write a hello.txt file" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "I'll write that file." },
      { type: "tool_use", id: "toolu_001", name: "write", input: { path: "hello.txt", content: "hello" } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_001", content: "File written successfully." },
    ],
  },
  { role: "assistant", content: "Done! hello.txt has been created." },
  { role: "user", content: "now read it back to me" },
]

beforeEach(() => {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
  capturedParams = null
  queuedSessionIds = []
  clearSessionCache()
  clearSharedSessions()
})

describe("Issue #386 — tool_use blocks must not leak into SDK prompt as text", () => {
  it("headered session: continuation with tool_use history sends delta only (no flatten)", async () => {
    const app = createTestApp()

    // Turn 1 — establish session
    await postWithSession(app, "sess-continue", [
      { role: "user", content: "write a hello.txt file" },
    ], "sdk-continue")

    // Turn 2 — continuation with full history including tool_use/tool_result blocks
    capturedParams = null
    await postWithSession(app, "sess-continue", history, "sdk-continue")

    // Must resume (lineage=continuation) and must not have flattened tool blocks into text
    expect(getCaptured()?.options?.resume).toBe("sdk-continue")
    assertNoFlattenedToolBlocks(getCaptured()?.prompt)
  })

  it("headered session: proxy restart (cache cleared) must still rehydrate without flattening", async () => {
    const app = createTestApp()

    // Turn 1 — establish session
    await postWithSession(app, "sess-rehydrate", [
      { role: "user", content: "write a hello.txt file" },
    ], "sdk-rehydrate")

    // Simulate proxy restart: wipe in-memory cache (shared store remains)
    clearSessionCache()

    // Turn 2 — same session header, full history with tool_use blocks
    capturedParams = null
    await postWithSession(app, "sess-rehydrate", history, "sdk-rehydrate")

    // After restart, shared-store lookup should find the session → continuation
    // (delta only). Critically, tool_use/tool_result must NOT leak as text.
    assertNoFlattenedToolBlocks(getCaptured()?.prompt)
  })

  it("headered session: new session header on rehydration (session lost) must not flatten", async () => {
    const app = createTestApp()

    // Turn 1 — original session header
    await postWithSession(app, "sess-original", [
      { role: "user", content: "write a hello.txt file" },
    ], "sdk-original")

    // Client restarts and generates a NEW session header, but sends full history
    capturedParams = null
    await postWithSession(app, "sess-brand-new", history, "sdk-brand-new")

    // This is where fingerprint fallback would have saved us in the old code.
    // Whatever the final lineage decision, tool_use blocks must not be flattened.
    assertNoFlattenedToolBlocks(getCaptured()?.prompt)
  })

  it("headerless session: full rehydration path must not flatten tool_use blocks", async () => {
    const app = createTestApp()

    // Turn 1 — headerless (pi-style flow)
    queuedSessionIds.push("sdk-headerless-1")
    await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: false,
        messages: [{ role: "user", content: "write a hello.txt file" }],
      }),
    })).then(r => r.json())

    // Turn 2 — headerless with full history (tool blocks)
    capturedParams = null
    queuedSessionIds.push("sdk-headerless-2")
    await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: false,
        messages: history,
      }),
    })).then(r => r.json())

    assertNoFlattenedToolBlocks(getCaptured()?.prompt)
  })
})

describe("tool-result attribution on full-history replay (#552)", () => {
  // Fresh replay drops assistant tool_use blocks (per #111/#386), so without
  // attribution the model sees raw tool outputs as bare user text and denies
  // having made the calls ("a file I never created"). Each replayed
  // tool_result must carry a compact [name target] attribution instead.
  const toolLoopHistory = [
    { role: "user", content: "create tmp/test2.txt then read tmp/test1.txt" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_w1", name: "write", input: { filePath: "tmp/test2.txt", content: "apple" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_w1", content: "Wrote file successfully" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_r1", name: "read", input: { filePath: "tmp/test1.txt" } }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_r1", content: "line one\nline two" },
        { type: "text", text: "what files did you create?" },
      ],
    },
  ]

  beforeEach(() => {
    clearSessionCache()
    clearSharedSessions()
    capturedParams = null
    mockMessages = [assistantMessage([{ type: "text", text: "You created tmp/test2.txt" }])]
  })

  it("attributes each replayed tool result to the call that produced it", async () => {
    const app = createTestApp()
    await postWithSession(app, "attribution-session-1", toolLoopHistory, "sdk-attr-1")

    const prompt = promptToString(getCaptured()?.prompt)
    // The write result must be attributed WITH its content — the model must be
    // able to recognize its own work product, not just an unexplained success
    // string (#552 gave it the target; the #496 follow-up adds the content, so
    // it stops re-deriving near-duplicate edits and blaming a phantom co-editor).
    expect(prompt).toContain('[your write tmp/test2.txt → "apple"]')
    expect(prompt).toContain("Wrote file successfully")
    // The read result must be attributed to the right file (no content summary
    // for non-mutating tools).
    expect(prompt).toContain("[your read tmp/test1.txt]")
    // And the banned verbose shapes must stay banned.
    assertNoFlattenedToolBlocks(getCaptured()?.prompt)
  })

  it("replays edit calls with a truncated summary of what changed (#496 follow-up)", async () => {
    const app = createTestApp()
    const editHistory = [
      { role: "user", content: "add ignore rules to dependabot config" },
      {
        role: "assistant",
        content: [{
          type: "tool_use", id: "toolu_e1", name: "edit",
          input: {
            filePath: ".github/dependabot.yml",
            oldString: "    open-pull-requests-limit: 10",
            newString: "    open-pull-requests-limit: 10\n    ignore:\n      # Major bumps need manual review\n      - dependency-name: \"*\"",
          },
        }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_e1", content: "Edit applied successfully." },
          { type: "text", text: "now validate the file" },
        ],
      },
    ]
    await postWithSession(app, "attribution-session-2", editHistory, "sdk-attr-2")

    const prompt = promptToString(getCaptured()?.prompt)
    // The model must see WHAT it inserted, whitespace-collapsed, so it can
    // recognize its own wording later instead of concluding "the first
    // variant of the comments isn't mine" (stefanpartheym's #496 transcript).
    expect(prompt).toContain('[your edit .github/dependabot.yml → "open-pull-requests-limit: 10 ignore: # Major bumps need manual review')
    expect(prompt).toContain("Edit applied successfully.")
    assertNoFlattenedToolBlocks(getCaptured()?.prompt)
  })
})

describe("transcript-format imitation (#496 self-talk regression)", () => {
  // 'Human:'/'Assistant:' transcript lines in the prompt teach the model the
  // transcript format — it then completes the pattern itself, emitting
  // 'Human: ...' turns and self-approving actions (duncanam's report). The
  // structured/multimodal path already uses the safe convention (user turns
  // plain, assistant turns as '[Assistant: ...]', resume deltas drop
  // assistant messages the SDK session already has). The text path must match.
  const transcriptMarker = /(^|\n)(Human|Assistant): /

  it("resume delta: no transcript markers, assistant delta dropped, results attributed", async () => {
    const app = createTestApp()
    // Turn 1 — establish the session
    await postWithSession(app, "sess-selftalk", [
      { role: "user", content: "edit the config file" },
    ], "sdk-selftalk")

    // Turn 2 — client returns the executed tool round-trip
    capturedParams = null
    await postWithSession(app, "sess-selftalk", [
      { role: "user", content: "edit the config file" },
      { role: "assistant", content: [
        { type: "text", text: "I'll edit that file now." },
        { type: "tool_use", id: "tu_st1", name: "edit", input: { filePath: "a.yml", oldString: "x", newString: "y" } },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_st1", content: "Edit applied successfully." },
      ]},
    ], "sdk-selftalk")

    expect(getCaptured()?.options?.resume).toBe("sdk-selftalk")
    const prompt = promptToString(getCaptured()?.prompt)
    expect(prompt).not.toMatch(transcriptMarker)
    // The assistant's delta text must NOT be replayed — the resumed SDK
    // session already contains that turn; re-sending it as user text is the
    // imitation seed.
    expect(prompt).not.toContain("I'll edit that file now.")
    // The tool result (the genuinely new information) must be present + attributed.
    expect(prompt).toContain("Edit applied successfully.")
    expect(prompt).toContain("[your edit a.yml")
  })

  it("fresh multi-turn replay: assistant turns bracketed, no transcript markers", async () => {
    const app = createTestApp()
    capturedParams = null
    // New session header + full history → fresh replay of a text conversation
    await postWithSession(app, "sess-selftalk-fresh", [
      { role: "user", content: "what is the capital of France?" },
      { role: "assistant", content: "Paris." },
      { role: "user", content: "and of Germany?" },
    ], "sdk-selftalk-fresh")

    const prompt = promptToString(getCaptured()?.prompt)
    expect(prompt).not.toMatch(transcriptMarker)
    // Assistant context survives in the bracketed, non-imitatable shape the
    // structured path has used since #553.
    expect(prompt).toContain("[Assistant: Paris.]")
    expect(prompt).toContain("what is the capital of France?")
    expect(prompt).toContain("and of Germany?")
  })
})
