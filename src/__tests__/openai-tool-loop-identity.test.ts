/**
 * A generic OpenAI client that runs its own tool loop sends no session header.
 * Every round it resends the whole growing conversation, ending in the `tool`
 * message it just produced, so `isClientDrivenLoop` holds and the request takes
 * the headerless-tool-result bypass: no session lookup, no cache write, a fresh
 * SDK session per round. Measured on a LiteLLM-fronted agent loop, #820 put
 * that at 35k-56k cache-write tokens per turn against 46-53 direct.
 *
 * The bypass exists for a reason. The conversation fingerprint is (first user
 * message, cwd), so two runs of one workflow started from the same prompt in
 * the same directory hash to a single key, and one would resume the other's
 * Claude session — premature end_turn, dropped tool calls. Letting the
 * fingerprint stand in for a key would reintroduce exactly that.
 *
 * The loop's own first tool-call id is the missing discriminator: issued per
 * generation so concurrent runs never share one, and retained in the history so
 * every later round of the same run derives the same key.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import type { Context } from "hono"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deriveToolLoopSessionId, openAiAdapter } from "../proxy/adapters/openai"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

// Only `req.header` is exercised; the cast narrows a partial fake to Hono's
// Context rather than re-declaring the framework type (same pattern as
// letta-adapter.test.ts).
function ctx(headers: Record<string, string | undefined>): Context {
  return { req: { header: (name: string) => headers[name.toLowerCase()] } } as unknown as Context
}

const PROMPT = "List the files in the repo and summarise the build setup."

/** Round 1: the client's opening request, before any tool has been called. */
const opening = [
  { role: "user", content: PROMPT },
]

/** Round 2: assistant asked for a tool, client sends the result back. */
function firstRound(callId: string) {
  return [
    ...opening,
    { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: callId, content: "README.md src/" },
  ]
}

/** Round 3: the same loop, one tool round later. */
function secondRound(callId: string, nextCallId: string) {
  return [
    ...firstRound(callId),
    { role: "assistant", content: null, tool_calls: [{ id: nextCallId, type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: nextCallId, content: "bun test" },
  ]
}

describe("deriveToolLoopSessionId", () => {
  it("derives nothing for an ordinary chat, so unkeyed chats are untouched", () => {
    expect(deriveToolLoopSessionId({ messages: opening })).toBeUndefined()
    expect(deriveToolLoopSessionId({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] }))
      .toBeUndefined()
  })

  it("derives nothing from a malformed or message-less body", () => {
    expect(deriveToolLoopSessionId(undefined)).toBeUndefined()
    expect(deriveToolLoopSessionId({})).toBeUndefined()
    expect(deriveToolLoopSessionId({ messages: "not an array" })).toBeUndefined()
  })

  it("derives a key once the loop has called a tool", () => {
    const key = deriveToolLoopSessionId({ messages: firstRound("call_abc123") })
    expect(key).toBeDefined()
    expect(key).toMatch(/^tool-loop:[0-9a-f]{16}$/)
  })

  it("holds the key steady as the same loop grows — the property that makes resume possible", () => {
    const round2 = deriveToolLoopSessionId({ messages: firstRound("call_abc123") })
    const round3 = deriveToolLoopSessionId({ messages: secondRound("call_abc123", "call_def456") })
    expect(round3).toBe(round2!)
  })

  it("anchors on the FIRST tool call, not the newest, so later rounds do not rekey", () => {
    const withLaterCalls = deriveToolLoopSessionId({ messages: secondRound("call_abc123", "call_def456") })
    const firstOnly = deriveToolLoopSessionId({ messages: firstRound("call_abc123") })
    expect(withLaterCalls).toBe(firstOnly!)
  })

  it("separates two concurrent runs of the same prompt — the collision the guard was written for", () => {
    const runA = deriveToolLoopSessionId({ messages: firstRound("call_run_a") })
    const runB = deriveToolLoopSessionId({ messages: firstRound("call_run_b") })
    expect(runA).toBeDefined()
    expect(runB).not.toBe(runA!)
  })

  it("separates two conversations that happen to share a tool-call id", () => {
    const a = deriveToolLoopSessionId({ messages: firstRound("call_same") })
    const b = deriveToolLoopSessionId({
      messages: [
        { role: "user", content: "A completely different opening question." },
        { role: "assistant", content: null, tool_calls: [{ id: "call_same", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_same", content: "README.md src/" },
      ],
    })
    expect(b).not.toBe(a!)
  })

  it("reads an orphaned tool result, for clients that omit the assistant turn", () => {
    const key = deriveToolLoopSessionId({
      messages: [
        { role: "user", content: PROMPT },
        { role: "tool", tool_call_id: "call_orphan", content: "README.md" },
      ],
    })
    expect(key).toMatch(/^tool-loop:[0-9a-f]{16}$/)
  })

  it("reads array-shaped user content", () => {
    const array = deriveToolLoopSessionId({
      messages: [
        { role: "user", content: [{ type: "text", text: PROMPT }] },
        ...firstRound("call_abc123").slice(1),
      ],
    })
    expect(array).toBe(deriveToolLoopSessionId({ messages: firstRound("call_abc123") })!)
  })

  it("ignores an empty tool-call id rather than keying every such client alike", () => {
    expect(deriveToolLoopSessionId({
      messages: [
        { role: "user", content: PROMPT },
        { role: "assistant", content: null, tool_calls: [{ id: "", type: "function", function: { name: "bash", arguments: "{}" } }] },
      ],
    })).toBeUndefined()
  })

  it("round-trips through the affinity header the inner hop already reads", () => {
    const key = deriveToolLoopSessionId({ messages: firstRound("call_abc123") })!
    expect(openAiAdapter.getSessionId(ctx({ "x-session-affinity": key }))).toBe(key)
  })

  it("yields to a key the client sent itself", () => {
    // The handler only derives when the adapter resolved nothing, so a client
    // key always wins. Asserted here so that precedence stays visible.
    expect(openAiAdapter.getSessionId(ctx({ "x-session-affinity": "client-key" }))).toBe("client-key")
    expect(openAiAdapter.getSessionId(ctx({}))).toBeUndefined()
  })
})

// ============================================================
// Checkpoint reconciliation on the derived identity
// ============================================================
//
// Deriving a key makes the loop classify as a continuation, but the client
// never agreed to echo the exact tool-call ids Meridian forwarded, so the
// passthrough checkpoint validator cannot settle the delta. That validator is
// Meridian's own inference; when it disagrees with a continuation the session
// store does confirm, the continuation must win. A client that supplies its
// own key keeps today's replay-on-mismatch behaviour.

let mockMessages: any[] = []
let capturedQueryParamsAll: any[] = []
let mockBaseSessionId = "test-session"

installSdkMock(() => ({
  query: (params: any) => {
    capturedQueryParamsAll.push(params)
    const preHook = params?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
    const sessionId = resolveMockSdkSessionId(params?.options, mockBaseSessionId)
    return (async function* () {
      let sawSyntheticDeny = false
      let sawResult = false
      for (const msg of mockMessages) {
        const { session_id: _ignored, ...rest } = msg
        const delivered = { ...rest, session_id: sessionId }
        if (delivered?.type === "user" && delivered?.message?.content?.some((b: any) => b?.type === "tool_result")) {
          sawSyntheticDeny = true
        }
        if (delivered?.type === "result") sawResult = true
        yield delivered
        if (preHook && delivered?.type === "assistant" && Array.isArray(delivered?.message?.content)) {
          for (const block of delivered.message.content) {
            if (block?.type !== "tool_use") continue
            await preHook({ tool_name: block.name, tool_use_id: block.id, tool_input: block.input })
          }
        }
      }
      // The real SDK terminates with a result, the boundary the checkpoint
      // persistence waits for; synthesize it after a deny fixture.
      if (sawSyntheticDeny && !sawResult) {
        yield { type: "result", subtype: "success", is_error: false, session_id: sessionId }
      }
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
  tool: () => ({}),
}), "openai-tool-loop-identity.test.ts")

let claudeEvents: Array<{ event: string; data?: any }> = []

installLoggerMock(() => ({
  claudeLog: (event: string, data?: any) => { claudeEvents.push({ event, data }) },
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer } = await import("../proxy/server")
const { clearSessionCache } = await import("../proxy/session/cache")
const { evictSharedSession, setSessionStoreDir } = await import("../proxy/sessionStore")

const TEST_RUN_ID = crypto.randomUUID()
const TEST_SESSION_DIR = mkdtempSync(join(tmpdir(), "meridian-tool-loop-identity-"))
const usedSessionKeys = new Set<string>()

const TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  },
}

function userTurn(text: string) {
  return { role: "user", content: text }
}

/** The client's own injected call. Its id is stable for the life of the loop
 *  and is what the derived identity anchors on. */
function clientCall(id: string) {
  return { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }] }
}

function clientResult(id: string, text: string) {
  return { role: "tool", tool_call_id: id, content: text }
}

/** The tool call Meridian forwarded — its id is NOT the client's id. */
function forwardedToolTurn(id: string) {
  return assistantMessage([{ type: "tool_use", id, name: "read", input: {} }])
}

function forwardedDeny(id: string) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "forwarded to client", is_error: true }],
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "test-session",
  }
}

describe("checkpoint reconciliation on a synthesized identity", () => {
  let app: any
  let savedPassthrough: string | undefined

  beforeAll(() => {
    setSessionStoreDir(TEST_SESSION_DIR)
    const { app: a } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    app = a
  })

  afterAll(() => {
    setSessionStoreDir(null)
    rmSync(TEST_SESSION_DIR, { recursive: true, force: true })
  })

  beforeEach(() => {
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    mockMessages = []
    capturedQueryParamsAll = []
    claudeEvents = []
    mockBaseSessionId = `test-session-${crypto.randomUUID()}`
    clearSessionCache()
  })

  afterEach(() => {
    for (const key of usedSessionKeys) evictSharedSession(key)
    usedSessionKeys.clear()
    clearSessionCache()
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  const postChat = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "dummy", ...headers },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 400, stream: false, tools: [TOOL], ...body }),
    }))

  const opening = [userTurn("read x"), clientCall("client-call-1"), clientResult("client-call-1", "step-1-ok")]

  it("resumes rather than replaying when a derived identity's checkpoint is unsettled", async () => {
    mockMessages = [forwardedToolTurn("tu1"), forwardedDeny("tu1")]
    const first = await postChat({ messages: opening })
    expect(first.status).toBe(200)
    const firstSessionId = capturedQueryParamsAll[0].options.sessionId
    expect(typeof firstSessionId).toBe("string")

    mockMessages = [assistantMessage([{ type: "text", text: "step two done" }])]
    const second = await postChat({
      messages: [...opening, clientCall("client-call-2"), clientResult("client-call-2", "step-2-ok")],
    })
    expect(second.status).toBe(200)

    // The checkpoint expected the id Meridian forwarded (`tu1`); the client
    // echoed its own `client-call-2`, so the validator cannot settle it. This
    // is a confirmed continuation on a key Meridian derived, so it resumes —
    // and without the rewind marker, which would have demanded that batch.
    expect(capturedQueryParamsAll[1].options.resume).toBe(firstSessionId)
    expect(capturedQueryParamsAll[1].options.resumeSessionAt).toBeUndefined()
    expect(claudeEvents.map((e) => e.event)).toContain("passthrough.checkpoint_resume_preferred")
    expect(claudeEvents.map((e) => e.event)).not.toContain("passthrough.checkpoint_replay")
  })

  it("keeps today's replay for a header-keyed client with the same shape", async () => {
    const sessionKey = `identity-keyed-${TEST_RUN_ID}`
    usedSessionKeys.add(sessionKey)
    const headers = { "x-opencode-session": sessionKey }

    mockMessages = [forwardedToolTurn("tu1"), forwardedDeny("tu1")]
    const first = await postChat({ messages: opening }, headers)
    expect(first.status).toBe(200)

    mockMessages = [assistantMessage([{ type: "text", text: "step two done" }])]
    const second = await postChat({
      messages: [...opening, clientCall("client-call-2"), clientResult("client-call-2", "step-2-ok")],
    }, headers)
    expect(second.status).toBe(200)

    // The client chose this key, so an unsettled checkpoint is a real mismatch
    // and the turn replays fresh rather than resuming the stored session.
    expect(capturedQueryParamsAll[1].options.resume).toBeUndefined()
    expect(claudeEvents.map((e) => e.event)).toContain("passthrough.checkpoint_replay")
    expect(claudeEvents.map((e) => e.event)).not.toContain("passthrough.checkpoint_resume_preferred")
  })
})
