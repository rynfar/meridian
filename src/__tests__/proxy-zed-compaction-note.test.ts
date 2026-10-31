/**
 * Compaction notice on the Zed path — full HTTP layer, mocked SDK.
 *
 * Claude Code compacts a long session on its own and reports it as a
 * system/compact_boundary message; nothing else tells the client. The proxy
 * turns that message into a `[meridian] Claude Code compacted …` line: the
 * first text block of a streamed answer when the compaction ran before the
 * model answered, a block of its own between turns when it happened mid-turn,
 * prepended on the non-streamed path. MERIDIAN_NO_COMPACTION_NOTE hides the
 * line; the compaction is still logged.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { assistantMessage, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop, resolveMockSdkSessionId } from "./helpers"

let mockMessages: any[] = []

installSdkMock(() => ({
  query: (params: any) => {
    const sessionId = resolveMockSdkSessionId(params?.options, "zed-compaction-session")
    return (async function* () {
      for (const msg of mockMessages) yield { ...msg, session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "proxy-zed-compaction-note.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer } = await import("../proxy/server")
const { clearSessionCache } = await import("../proxy/session/cache")
const { setSessionStoreDir } = await import("../proxy/sessionStore")
const { diagnosticLog } = await import("../telemetry")

const TEST_SESSION_DIR = mkdtempSync(join(tmpdir(), "meridian-zed-compaction-"))
const ZED_HEADERS = { "Content-Type": "application/json", "User-Agent": "Zed/1.25.3 (windows; x86_64)" }
const AGENT_SYSTEM = "You are the Zed agent.\n\nThe current project contains the following root directories:\n\n- `C:\\proj`"
const GREP_FUNCTION = {
  type: "function",
  function: {
    name: "grep",
    description: "Search file contents",
    parameters: { type: "object", properties: { regex: { type: "string" } }, required: ["regex"] },
  },
}
const CONVERSATION = [
  { role: "user", content: "tell me about the duplicates" },
  { role: "assistant", content: "There are three." },
  { role: "user", content: "and now?" },
]
const COMPACTION_NOTE =
  "[meridian] Claude Code compacted this conversation's context automatically: 180,000 tokens before, 42,000 tokens after. " +
  "The model now sees the earlier turns as a summary.\n\n"

const MANUAL_NOTE =
  "[meridian] Claude Code compacted this conversation's context on request: 1,757 tokens before, 903 tokens after. " +
  "The model now sees the earlier turns as a summary.\n\n"

/** The SDK `system` message Claude Code emits after compacting the session's context. */
function compactBoundary(preTokens: number, postTokens?: number, trigger: "auto" | "manual" = "auto") {
  return {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger, pre_tokens: preTokens, post_tokens: postTokens },
    uuid: randomUUID(),
  }
}

/** The canonical result that closes a turn which produced no assistant message. */
function resultMessage() {
  return { type: "result", subtype: "success", is_error: false, uuid: randomUUID() }
}

function zedRequest(app: any, messages: Array<Record<string, unknown>>, stream: boolean): Promise<Response> {
  return app.fetch(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: ZED_HEADERS,
    body: JSON.stringify({
      model: "claude-opus-5-5",
      stream,
      prompt_cache_key: `thread-${randomUUID()}`,
      messages: [{ role: "system", content: AGENT_SYSTEM }, ...messages],
      tools: [GREP_FUNCTION],
    }),
  }))
}

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

function streamChunks(sse: string): Array<{ choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> }> {
  return sse.split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)))
}

/** The assistant text an OpenAI stream carries, in order. */
function streamedText(sse: string): string {
  return streamChunks(sse).map((chunk) => chunk.choices?.[0]?.delta?.content ?? "").join("")
}

/** The finish_reason the stream ends with, if any chunk carried one. */
function finishReason(sse: string): string | undefined {
  return streamChunks(sse).map((chunk) => chunk.choices?.[0]?.finish_reason).find((reason) => Boolean(reason)) ?? undefined
}

describe("Zed: compaction notice", () => {
  let app: any
  let savedNote: string | undefined

  beforeAll(() => {
    setSessionStoreDir(TEST_SESSION_DIR)
    app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
  })

  afterAll(() => {
    setSessionStoreDir(null)
    rmSync(TEST_SESSION_DIR, { recursive: true, force: true })
  })

  beforeEach(() => {
    savedNote = process.env.MERIDIAN_NO_COMPACTION_NOTE
    delete process.env.MERIDIAN_NO_COMPACTION_NOTE
    mockMessages = []
  })

  afterEach(async () => {
    await clearSessionCache()
    if (savedNote !== undefined) process.env.MERIDIAN_NO_COMPACTION_NOTE = savedNote
    else delete process.env.MERIDIAN_NO_COMPACTION_NOTE
  })

  it("tells the person when Claude Code compacted the context before answering", async () => {
    // Auto-compact runs before the API call, so the boundary precedes message_start.
    mockMessages = [
      compactBoundary(180_000, 42_000),
      messageStart(), textBlockStart(0), textDelta(0, "ok"), blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const res = await zedRequest(app, CONVERSATION, true)
    expect(res.status).toBe(200)
    expect(streamedText(await readAll(res))).toBe(`${COMPACTION_NOTE}ok`)
  })

  it("places the note between blocks when the compaction happens mid-turn", async () => {
    mockMessages = [
      messageStart(), textBlockStart(0), textDelta(0, "before"), blockStop(0),
      compactBoundary(180_000, 42_000),
      messageStart("msg_2"), textBlockStart(0), textDelta(0, "after"), blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const res = await zedRequest(app, CONVERSATION, true)
    expect(res.status).toBe(200)
    expect(streamedText(await readAll(res))).toBe(`before${COMPACTION_NOTE}after`)
  })

  it("prepends the note on a non-streamed answer", async () => {
    mockMessages = [compactBoundary(180_000, 42_000), assistantMessage([{ type: "text", text: "done" }])]
    const res = await zedRequest(app, CONVERSATION, false)
    expect(res.status).toBe(200)
    const body = await res.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]!.message.content).toBe(`${COMPACTION_NOTE}done`)
  })

  it("answers with the note alone when a manual /compact produced no assistant turn (streamed)", async () => {
    // Observed live: `/compact` typed in Zed reaches Claude Code as its slash
    // command; the SDK compacts and ends the turn without a model message.
    mockMessages = [compactBoundary(1_757, 903, "manual"), resultMessage()]
    const res = await zedRequest(app, [...CONVERSATION.slice(0, 2), { role: "user", content: "/compact" }], true)
    expect(res.status).toBe(200)
    const sse = await readAll(res)
    expect(streamedText(sse)).toBe(MANUAL_NOTE)
    // No SDK message_delta exists for such a turn; the envelope still ends with a stop.
    expect(finishReason(sse)).toBe("stop")
  })

  it("answers with the note alone when a manual /compact produced no assistant turn (non-streamed)", async () => {
    mockMessages = [compactBoundary(1_757, 903, "manual"), resultMessage()]
    const res = await zedRequest(app, [...CONVERSATION.slice(0, 2), { role: "user", content: "/compact" }], false)
    expect(res.status).toBe(200)
    const body = await res.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]!.message.content).toBe(MANUAL_NOTE)
  })

  it("stays silent when MERIDIAN_NO_COMPACTION_NOTE is set, while the compaction is still logged", async () => {
    process.env.MERIDIAN_NO_COMPACTION_NOTE = "1"
    mockMessages = [
      compactBoundary(180_000, 42_000),
      messageStart(), textBlockStart(0), textDelta(0, "quiet"), blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const res = await zedRequest(app, CONVERSATION, true)
    expect(res.status).toBe(200)
    expect(streamedText(await readAll(res))).toBe("quiet")
    const logged = diagnosticLog.getRecent({ category: "token", limit: 50 })
      .some((entry) => entry.message.includes("context_compacted: auto compaction, 180,000 tokens before, 42,000 tokens after"))
    expect(logged).toBe(true)
  })
})
