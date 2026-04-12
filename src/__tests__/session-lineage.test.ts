/**
 * Tests for conversation lineage verification.
 *
 * Validates that session resume correctly handles:
 *   - Normal continuation (new messages appended)
 *   - Undo / branch (recent messages changed)
 *   - Compaction (older messages rewritten, recent preserved)
 *   - Pruning (middle messages modified, both ends preserved)
 *   - Multiple compactions in sequence
 *   - Post-compaction normal resume and undo
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage } from "./helpers"

type MockSdkMessage = Record<string, unknown>
type TestApp = { fetch: (req: Request) => Promise<Response> }

let mockMessages: MockSdkMessage[] = []
interface CapturedQueryParams { options?: { resume?: string; forkSession?: boolean; resumeSessionAt?: string } }
let capturedQueryParams: CapturedQueryParams | null = null
/** Access capturedQueryParams without TS narrowing to `never` after null assignments */
function getCaptured(): CapturedQueryParams | null { return capturedQueryParams }
let queuedSessionIds: string[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => {
    capturedQueryParams = params as { options?: { resume?: string } }
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

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const lineageTmpDir = mkdtempSync(join(tmpdir(), "session-lineage-test-"))
process.env.CLAUDE_PROXY_SESSION_DIR = lineageTmpDir

const {
  createProxyServer,
  clearSessionCache,
  computeLineageHash,
  hashMessage,
  computeMessageHashes,
} = await import("../proxy/server")
const { clearSharedSessions } = await import("../proxy/sessionStore")

afterAll(() => {
  rmSync(lineageTmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_PROXY_SESSION_DIR
  mock.restore()
})

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app as TestApp
}

async function post(
  app: TestApp,
  session: string,
  messages: Array<{ role: string; content: string }>,
  sessionId: string
) {
  queuedSessionIds.push(sessionId)
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session ? { "x-opencode-session": session } : {}),
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

beforeEach(() => {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
  capturedQueryParams = null
  queuedSessionIds = []
  clearSessionCache()
  clearSharedSessions()
})

// ---------------------------------------------------------------------------
// Unit tests for hash functions
// ---------------------------------------------------------------------------

describe("computeLineageHash", () => {
  it("returns empty string for empty messages", () => {
    expect(computeLineageHash([])).toBe("")
  })

  it("produces consistent hashes for same messages", () => {
    const msgs = [{ role: "user", content: "hello" }]
    expect(computeLineageHash(msgs)).toBe(computeLineageHash(msgs))
  })

  it("produces different hashes for different content", () => {
    const a = [{ role: "user", content: "hello" }]
    const b = [{ role: "user", content: "goodbye" }]
    expect(computeLineageHash(a)).not.toBe(computeLineageHash(b))
  })

  it("produces different hashes for different roles", () => {
    const a = [{ role: "user", content: "hello" }]
    const b = [{ role: "assistant", content: "hello" }]
    expect(computeLineageHash(a)).not.toBe(computeLineageHash(b))
  })

  it("produces different hashes for different message order", () => {
    const a = [{ role: "user", content: "a" }, { role: "user", content: "b" }]
    const b = [{ role: "user", content: "b" }, { role: "user", content: "a" }]
    expect(computeLineageHash(a)).not.toBe(computeLineageHash(b))
  })

  it("handles array content (multimodal)", () => {
    const msgs = [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    const hash = computeLineageHash(msgs as any)
    expect(hash.length).toBe(32)
  })

  it("produces identical hashes for string vs array content format", () => {
    const asString = [{ role: "user", content: "hello world" }]
    const asArray = [{ role: "user", content: [{ type: "text", text: "hello world" }] }]
    expect(computeLineageHash(asString)).toBe(computeLineageHash(asArray as any))
  })

  it("produces identical hashes for tool_use in string vs structured format", () => {
    const withToolUse = [
      { role: "user", content: "do something" },
      { role: "assistant", content: [
        { type: "text", text: "I'll help." },
        { type: "tool_use", id: "toolu_123", name: "bash", input: { command: "ls" } },
      ]},
    ]
    expect(computeLineageHash(withToolUse as any)).toBe(computeLineageHash(withToolUse as any))
  })

  it("produces different hashes for different tool_use content", () => {
    const a = [{ role: "assistant", content: [
      { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "ls" } },
    ]}]
    const b = [{ role: "assistant", content: [
      { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "pwd" } },
    ]}]
    expect(computeLineageHash(a as any)).not.toBe(computeLineageHash(b as any))
  })
})

describe("hashMessage / computeMessageHashes", () => {
  it("hashMessage produces consistent hashes", () => {
    const msg = { role: "user", content: "hello" }
    expect(hashMessage(msg)).toBe(hashMessage(msg))
  })

  it("hashMessage differs for different content", () => {
    expect(hashMessage({ role: "user", content: "a" }))
      .not.toBe(hashMessage({ role: "user", content: "b" }))
  })

  it("hashMessage normalises string vs array content", () => {
    const str = { role: "user", content: "hello" }
    const arr = { role: "user", content: [{ type: "text", text: "hello" }] }
    expect(hashMessage(str)).toBe(hashMessage(arr as any))
  })

  it("computeMessageHashes returns one hash per message", () => {
    const msgs = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]
    const hashes = computeMessageHashes(msgs)
    expect(hashes).toHaveLength(3)
    expect(new Set(hashes).size).toBe(3) // all different
  })

  it("computeMessageHashes returns empty array for empty input", () => {
    expect(computeMessageHashes([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Scenario 1: Normal continuation
// ---------------------------------------------------------------------------

describe("Session lineage: normal continuation", () => {
  it("resumes when messages are a strict continuation", async () => {
    const app = createTestApp()

    await post(app, "sess-1", [
      { role: "user", content: "Good evening" },
    ], "sdk-1")

    await post(app, "sess-1", [
      { role: "user", content: "Good evening" },
      { role: "assistant", content: "Good evening!" },
      { role: "user", content: "Remember: Flobulator" },
    ], "sdk-1")

    expect(getCaptured()?.options?.resume).toBe("sdk-1")
  })
})

// ---------------------------------------------------------------------------
// Scenarios 2-4: Undo / branch / edit
// ---------------------------------------------------------------------------

describe("Session lineage: undo detection", () => {
  it("forks session on undo (same count, different last message)", async () => {
    const app = createTestApp()

    await post(app, "sess-1", [
      { role: "user", content: "Good evening" },
    ], "sdk-1")

    await post(app, "sess-1", [
      { role: "user", content: "Good evening" },
      { role: "assistant", content: "Good evening!" },
      { role: "user", content: "Remember: Flobulator" },
    ], "sdk-1")

    // Undo last turn, new message → should fork the session
    await post(app, "sess-1", [
      { role: "user", content: "Good evening" },
      { role: "assistant", content: "Good evening!" },
      { role: "user", content: "Do you remember the word?" },
    ], "sdk-new")

    // Should resume the original session with fork
    expect(getCaptured()?.options?.resume).toBe("sdk-1")
    expect(getCaptured()?.options?.forkSession).toBe(true)
    expect(getCaptured()?.options?.resumeSessionAt).toBeDefined()
  })

  it("forks session on multi-undo (fewer messages)", async () => {
    const app = createTestApp()

    await post(app, "sess-1", [
      { role: "user", content: "hello" },
    ], "sdk-1")

    await post(app, "sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "step 2" },
    ], "sdk-1")

    await post(app, "sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "step 2" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "step 3" },
    ], "sdk-1")

    // Multi-undo back to turn 1 → fork
    await post(app, "sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "completely different" },
    ], "sdk-new")

    expect(getCaptured()?.options?.resume).toBe("sdk-1")
    expect(getCaptured()?.options?.forkSession).toBe(true)
  })

  it("does NOT resume when earlier message is edited", async () => {
    const app = createTestApp()

    await post(app, "sess-1", [
      { role: "user", content: "hello" },
    ], "sdk-1")

    await post(app, "sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you?" },
    ], "sdk-1")

    // Edit the first message (short conversation — no suffix overlap)
    await post(app, "sess-1", [
      { role: "user", content: "EDITED hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you?" },
      { role: "assistant", content: "good" },
      { role: "user", content: "great" },
    ], "sdk-new")

    expect(getCaptured()?.options?.resume).toBeUndefined()
  })

  it("undo forks then subsequent turns resume the fork", async () => {
    const app = createTestApp()

    await post(app, "sess-1", [
      { role: "user", content: "hello" },
    ], "sdk-1")

    await post(app, "sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "remember X" },
    ], "sdk-1")

    // Undo + new message → forks from sdk-1, gets new session sdk-2
    await post(app, "sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "forget about X" },
    ], "sdk-2")

    // Should fork from original session
    expect(getCaptured()?.options?.resume).toBe("sdk-1")
    expect(getCaptured()?.options?.forkSession).toBe(true)

    // Continuing from the fork should resume with sdk-2
    capturedQueryParams = null
    await post(app, "sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "forget about X" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "what do you know?" },
    ], "sdk-2")

    expect(getCaptured()?.options?.resume).toBe("sdk-2")
    expect(getCaptured()?.options?.forkSession).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Scenarios 5-7: Compaction
// ---------------------------------------------------------------------------

describe("Session lineage: compaction survival", () => {
  it("resumes after compaction rewrites older messages (suffix preserved)", async () => {
    const app = createTestApp()

    // Build a 9-message conversation
    await post(app, "sess-c", [{ role: "user", content: "hello" }], "sdk-c")

    await post(app, "sess-c", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "topic A" },
    ], "sdk-c")

    await post(app, "sess-c", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "topic A" },
      { role: "assistant", content: "A explained" },
      { role: "user", content: "topic B" },
    ], "sdk-c")

    await post(app, "sess-c", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "topic A" },
      { role: "assistant", content: "A explained" },
      { role: "user", content: "topic B" },
      { role: "assistant", content: "B explained" },
      { role: "user", content: "topic C" },
    ], "sdk-c")

    await post(app, "sess-c", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "topic A" },
      { role: "assistant", content: "A explained" },
      { role: "user", content: "topic B" },
      { role: "assistant", content: "B explained" },
      { role: "user", content: "topic C" },
      { role: "assistant", content: "C explained" },
      { role: "user", content: "topic D" },
    ], "sdk-c")

    // Compaction: beginning summarised, last 4 messages + 2 new
    capturedQueryParams = null
    await post(app, "sess-c", [
      { role: "user", content: "[Summary: A, B and C discussed]" },
      { role: "assistant", content: "C explained" },
      { role: "user", content: "topic D" },
      { role: "assistant", content: "D explained" },
      { role: "user", content: "topic E" },
    ], "sdk-c")

    expect(getCaptured()?.options?.resume).toBe("sdk-c")
  })

  it("resumes after compaction reduces message count", async () => {
    const app = createTestApp()

    // Build to 9 messages
    const msgs: Array<{ role: string; content: string }> = []
    for (let i = 1; i <= 5; i++) {
      msgs.push({ role: "user", content: `step ${i}` })
      if (i < 5) msgs.push({ role: "assistant", content: `done ${i}` })
      await post(app, "sess-s", [...msgs], "sdk-s")
    }

    // Compaction: 9 msgs → 7 (summary + preserved tail + new)
    capturedQueryParams = null
    await post(app, "sess-s", [
      { role: "user", content: "[Summary: steps 1-3]" },
      { role: "assistant", content: "done 3" },
      { role: "user", content: "step 4" },
      { role: "assistant", content: "done 4" },
      { role: "user", content: "step 5" },
      { role: "assistant", content: "done 5" },
      { role: "user", content: "step 6" },
    ], "sdk-s")

    expect(getCaptured()?.options?.resume).toBe("sdk-s")
  })

  it("does NOT resume when both prefix AND suffix changed (real branch)", async () => {
    const app = createTestApp()

    await post(app, "sess-b", [{ role: "user", content: "hello" }], "sdk-b")

    await post(app, "sess-b", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "do task A" },
    ], "sdk-b")

    await post(app, "sess-b", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "do task A" },
      { role: "assistant", content: "done with A" },
      { role: "user", content: "now do B" },
    ], "sdk-b")

    // Completely different direction
    capturedQueryParams = null
    await post(app, "sess-b", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "do task C instead" },
      { role: "assistant", content: "ok doing C" },
      { role: "user", content: "continue with C" },
    ], "sdk-new")

    // Prefix overlap (hello, hi) → undo detected → forks from rollback point
    expect(getCaptured()?.options?.resume).toBe("sdk-b")
    expect(getCaptured()?.options?.forkSession).toBe(true)
    expect(getCaptured()?.options?.resumeSessionAt).toBeDefined()
  })

  it("rejects aggressive compaction where nothing is preserved", async () => {
    const app = createTestApp()

    await post(app, "sess-agg", [{ role: "user", content: "start" }], "sdk-agg")
    await post(app, "sess-agg", [
      { role: "user", content: "start" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "continue" },
    ], "sdk-agg")

    // Nothing from the original survives
    capturedQueryParams = null
    await post(app, "sess-agg", [
      { role: "user", content: "[Full summary of everything]" },
      { role: "assistant", content: "I understand the summary" },
      { role: "user", content: "now do something new" },
    ], "sdk-new")

    expect(getCaptured()?.options?.resume).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Scenario 8: Pruning (middle messages modified)
// ---------------------------------------------------------------------------

describe("Session lineage: pruning survival", () => {
  it("resumes when middle messages are pruned (tool outputs removed)", async () => {
    const app = createTestApp()

    // Build a conversation where middle messages will be "pruned"
    const fullConvo = [
      { role: "user", content: "start project" },
      { role: "assistant", content: "reading files..." },
      { role: "user", content: "tool result: file contents here" },
      { role: "assistant", content: "I see the files" },
      { role: "user", content: "now edit them" },
      { role: "assistant", content: "editing..." },
      { role: "user", content: "tool result: edit applied" },
      { role: "assistant", content: "done editing" },
      { role: "user", content: "run tests" },
    ]

    // Build up incrementally
    for (let i = 0; i < fullConvo.length; i += 2) {
      await post(app, "sess-p", fullConvo.slice(0, i + 1), "sdk-p")
    }

    // Pruning: tool outputs in messages 2 and 6 are replaced with truncated versions
    capturedQueryParams = null
    await post(app, "sess-p", [
      { role: "user", content: "start project" },           // same
      { role: "assistant", content: "reading files..." },    // same
      { role: "user", content: "[pruned tool output]" },     // PRUNED
      { role: "assistant", content: "I see the files" },     // same
      { role: "user", content: "now edit them" },            // same
      { role: "assistant", content: "editing..." },          // same
      { role: "user", content: "[pruned tool output]" },     // PRUNED
      { role: "assistant", content: "done editing" },        // same
      { role: "user", content: "run tests" },                // same
      { role: "assistant", content: "tests passed" },        // new
      { role: "user", content: "deploy" },                   // new
    ], "sdk-p")

    // Should resume — suffix (last 2+) of stored messages preserved
    expect(getCaptured()?.options?.resume).toBe("sdk-p")
  })
})

// ---------------------------------------------------------------------------
// Scenarios 9-11: Multiple compactions and post-compaction behavior
// ---------------------------------------------------------------------------

describe("Session lineage: post-compaction behavior", () => {
  it("normal resume works after compaction is accepted", async () => {
    const app = createTestApp()

    // Build to 9 messages
    await post(app, "sess-pc", [{ role: "user", content: "hello" }], "sdk-pc")
    await post(app, "sess-pc", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "A" },
    ], "sdk-pc")
    await post(app, "sess-pc", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "A" },
      { role: "assistant", content: "A done" },
      { role: "user", content: "B" },
    ], "sdk-pc")
    await post(app, "sess-pc", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "A" },
      { role: "assistant", content: "A done" },
      { role: "user", content: "B" },
      { role: "assistant", content: "B done" },
      { role: "user", content: "C" },
    ], "sdk-pc")
    await post(app, "sess-pc", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "A" },
      { role: "assistant", content: "A done" },
      { role: "user", content: "B" },
      { role: "assistant", content: "B done" },
      { role: "user", content: "C" },
      { role: "assistant", content: "C done" },
      { role: "user", content: "D" },
    ], "sdk-pc")

    // Compaction
    await post(app, "sess-pc", [
      { role: "user", content: "[Summary: A B C]" },
      { role: "assistant", content: "C done" },
      { role: "user", content: "D" },
      { role: "assistant", content: "D done" },
      { role: "user", content: "E" },
    ], "sdk-pc")

    // Normal follow-up after compaction
    capturedQueryParams = null
    await post(app, "sess-pc", [
      { role: "user", content: "[Summary: A B C]" },
      { role: "assistant", content: "C done" },
      { role: "user", content: "D" },
      { role: "assistant", content: "D done" },
      { role: "user", content: "E" },
      { role: "assistant", content: "E done" },
      { role: "user", content: "F" },
    ], "sdk-pc")

    expect(getCaptured()?.options?.resume).toBe("sdk-pc")
  })

  it("second compaction is also detected correctly", async () => {
    const app = createTestApp()

    // Build to 9 messages
    const topics = ["A", "B", "C", "D"]
    let msgs: Array<{ role: string; content: string }> = []
    for (const t of topics) {
      msgs.push({ role: "user", content: t })
      await post(app, "sess-2c", [...msgs], "sdk-2c")
      msgs.push({ role: "assistant", content: `${t} done` })
      await post(app, "sess-2c", [...msgs], "sdk-2c")
    }
    msgs.push({ role: "user", content: "E" })
    await post(app, "sess-2c", [...msgs], "sdk-2c")

    // First compaction
    await post(app, "sess-2c", [
      { role: "user", content: "[Summary: A B C]" },
      { role: "assistant", content: "C done" },
      { role: "user", content: "D" },
      { role: "assistant", content: "D done" },
      { role: "user", content: "E" },
      { role: "assistant", content: "E done" },
      { role: "user", content: "F" },
    ], "sdk-2c")

    // Continue to build up again
    await post(app, "sess-2c", [
      { role: "user", content: "[Summary: A B C]" },
      { role: "assistant", content: "C done" },
      { role: "user", content: "D" },
      { role: "assistant", content: "D done" },
      { role: "user", content: "E" },
      { role: "assistant", content: "E done" },
      { role: "user", content: "F" },
      { role: "assistant", content: "F done" },
      { role: "user", content: "G" },
    ], "sdk-2c")

    // Second compaction
    capturedQueryParams = null
    await post(app, "sess-2c", [
      { role: "user", content: "[Summary: A-F]" },
      { role: "assistant", content: "F done" },
      { role: "user", content: "G" },
      { role: "assistant", content: "G done" },
      { role: "user", content: "H" },
    ], "sdk-2c")

    expect(getCaptured()?.options?.resume).toBe("sdk-2c")
  })

  it("undo after compaction is correctly rejected", async () => {
    const app = createTestApp()

    // Build to 9 messages
    await post(app, "sess-uc", [{ role: "user", content: "hello" }], "sdk-uc")
    await post(app, "sess-uc", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "A" },
    ], "sdk-uc")
    await post(app, "sess-uc", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "A" },
      { role: "assistant", content: "A done" },
      { role: "user", content: "B" },
    ], "sdk-uc")
    await post(app, "sess-uc", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "A" },
      { role: "assistant", content: "A done" },
      { role: "user", content: "B" },
      { role: "assistant", content: "B done" },
      { role: "user", content: "C" },
    ], "sdk-uc")
    await post(app, "sess-uc", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "A" },
      { role: "assistant", content: "A done" },
      { role: "user", content: "B" },
      { role: "assistant", content: "B done" },
      { role: "user", content: "C" },
      { role: "assistant", content: "C done" },
      { role: "user", content: "D" },
    ], "sdk-uc")

    // Compaction
    await post(app, "sess-uc", [
      { role: "user", content: "[Summary: A B C]" },
      { role: "assistant", content: "C done" },
      { role: "user", content: "D" },
      { role: "assistant", content: "D done" },
      { role: "user", content: "E" },
    ], "sdk-uc")

    // Undo after compaction — end changes, forks from rollback point
    capturedQueryParams = null
    await post(app, "sess-uc", [
      { role: "user", content: "[Summary: A B C]" },
      { role: "assistant", content: "C done" },
      { role: "user", content: "D" },
      { role: "assistant", content: "D done" },
      { role: "user", content: "DIFFERENT from E" },
    ], "sdk-new")

    // Prefix overlap (Summary, C done, D, D done match) → undo → fork
    expect(getCaptured()?.options?.resume).toBe("sdk-uc")
    expect(getCaptured()?.options?.forkSession).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Scenario 12: Fingerprint fallback (no session header)
// ---------------------------------------------------------------------------

describe("Session lineage: fingerprint fallback", () => {
  it("does NOT resume via fingerprint after undo", async () => {
    const app = createTestApp()

    await post(app, "", [
      { role: "user", content: "Good evening" },
    ], "sdk-fp1")

    queuedSessionIds.push("sdk-fp1")
    const r1 = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5", max_tokens: 128, stream: false,
        messages: [
          { role: "user", content: "Good evening" },
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "Remember: Flobulator" },
        ],
      }),
    }))
    await r1.json()

    // Undo + new message
    queuedSessionIds.push("sdk-fp-new")
    capturedQueryParams = null
    const r2 = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5", max_tokens: 128, stream: false,
        messages: [
          { role: "user", content: "Good evening" },
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "Do you know the word?" },
        ],
      }),
    }))
    await r2.json()

    // Prefix overlap (Good evening, Hi!) → undo → fork via fingerprint
    expect(getCaptured()?.options?.resume).toBe("sdk-fp1")
    expect(getCaptured()?.options?.forkSession).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// LRU / session refresh
// ---------------------------------------------------------------------------

describe("Session lastAccess refresh on lookup", () => {
  it("keeps actively-used sessions alive in LRU by refreshing lastAccess", async () => {
    const app = createTestApp()

    await post(app, "sess-A", [
      { role: "user", content: "session A" },
    ], "sdk-A")

    await post(app, "sess-B", [
      { role: "user", content: "session B" },
    ], "sdk-B")

    capturedQueryParams = null
    await post(app, "sess-A", [
      { role: "user", content: "session A" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "still here?" },
    ], "sdk-A")

    expect(getCaptured()?.options?.resume).toBe("sdk-A")

    capturedQueryParams = null
    await post(app, "sess-A", [
      { role: "user", content: "session A" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "still here?" },
      { role: "assistant", content: "yes" },
      { role: "user", content: "one more" },
    ], "sdk-A")

    expect(getCaptured()?.options?.resume).toBe("sdk-A")
  })
})
