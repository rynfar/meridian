/**
 * Passthrough deny → SDK abort (supersedes the approach in PR #570)
 *
 * When the PreToolUse hook detects that the model has stopped making progress
 * against blocked passthrough tools (same tool re-called with new args, or a
 * forced-single tool exceeded), every distinct tool_use for this exchange is
 * already captured. Returning `interrupt: true` or `continue: false` from the
 * hook does NOT stop the nested session — both keys are absent from the CLI's
 * hook-output schema and are stripped by its Zod validation (verified
 * empirically against the real SDK + bundled CLI). The only reliable way to
 * end the nested session immediately is to abort the SDK query's
 * AbortController from the proxy side.
 *
 * These tests assert:
 *   1. Non-stream: the loop-detection deny aborts the SDK controller, and the
 *      response still recovers as a clean stop_reason:"tool_use" message.
 *   2. Stream: an abort-shaped SDK termination with captured tool_uses
 *      recovers to tool_use + message_stop (not an error event) — the stream
 *      gate must accept "aborted" like the non-stream gate does.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { makeRequest, parseSSE } from "./helpers"

const PASSTHROUGH_PREFIX = "mcp__oc__"

let mockTurns: any[] = []
let capturedController: AbortController | undefined
let capturedResume: string | undefined

function toolTurn(toolId: string, toolName: string, input: Record<string, unknown>) {
  return {
    type: "assistant",
    message: {
      id: `msg_${toolId}`,
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id: toolId, name: `${PASSTHROUGH_PREFIX}${toolName}`, input }],
      model: "claude-sonnet-4-5-20250929",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "test-session",
  }
}

function streamMessageStart() {
  return {
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        id: "msg_stream_1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-5-20250929",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "test-session",
  }
}

// Hook-aware, abort-aware SDK mock. Mirrors the real SDK: each assistant
// turn's PreToolUse hook fires after the turn is yielded, and an aborted
// controller terminates the query with an abort-shaped error (the real
// subprocess is SIGTERMed and surfaces "aborted by user").
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    capturedController = opts?.options?.abortController
    capturedResume = opts?.options?.resume
    return (async function* () {
      const preHook = opts?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
      for (const turn of mockTurns) {
        if (capturedController?.signal.aborted) {
          throw new Error("Claude Code process aborted by user")
        }
        yield turn
        if (preHook && turn.type === "assistant") {
          for (const block of turn.message.content) {
            if (block.type === "tool_use") {
              await preHook({ tool_name: block.name, tool_use_id: block.id, tool_input: block.input })
            }
          }
        }
        if (capturedController?.signal.aborted) {
          throw new Error("Claude Code process aborted by user")
        }
      }
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

const tool = (name: string) => ({
  name,
  description: `${name} tool`,
  input_schema: { type: "object", properties: {}, additionalProperties: true },
})

async function post(
  app: any,
  stream: boolean,
  messages: unknown[] = [{ role: "user", content: "Do the thing." }]
): Promise<Response> {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": "deny-abort-session" },
    body: JSON.stringify(
      makeRequest({
        stream,
        tools: [tool("get_weather"), tool("get_time")],
        messages,
      })
    ),
  })
  return app.fetch(req)
}

async function readSSE(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let result = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return parseSSE(result)
}

describe("Passthrough deny aborts the nested SDK session on loop detection", () => {
  let origEnv: string | undefined
  let origEarlyStop: string | undefined

  // These tests pin the LEGACY single-step semantics (#571): same-tool
  // repeats are dropped and abort the query mid-hook. With early stop
  // enabled (the default since the digest-turn elimination), same-tool
  // calls are captured as genuine parallelism instead — see the
  // "parallel same-tool calls" describe below. The legacy path remains
  // reachable via the MERIDIAN_PASSTHROUGH_EARLY_STOP=0 kill switch and
  // must keep working for operators who disable early stop.
  beforeEach(() => {
    origEnv = process.env.MERIDIAN_PASSTHROUGH
    origEarlyStop = process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    process.env.MERIDIAN_PASSTHROUGH = "1"
    process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = "0"
    mockTurns = []
    capturedController = undefined
    capturedResume = undefined
    clearSessionCache()
  })

  afterEach(() => {
    if (origEnv === undefined) delete process.env.MERIDIAN_PASSTHROUGH
    else process.env.MERIDIAN_PASSTHROUGH = origEnv
    if (origEarlyStop === undefined) delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    else process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = origEarlyStop
  })

  it("non-stream: aborts the SDK query when a same-tool repeat is detected and still returns the distinct tool_use", async () => {
    mockTurns = [
      toolTurn("toolu_1", "get_weather", { city: "SF" }),
      // Same tool, NEW args — the loop-continuation signal. The hook should
      // abort here; the mock then terminates with an abort-shaped error.
      toolTurn("toolu_2", "get_weather", { city: "LA" }),
      // Must never be reached once the abort fires.
      toolTurn("toolu_3", "get_weather", { city: "NYC" }),
    ]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await post(app, false)
    const body = await response.json() as any

    expect(capturedController).toBeDefined()
    expect(capturedController!.signal.aborted).toBe(true)
    expect(response.status).toBe(200)
    expect(body.stop_reason).toBe("tool_use")
    const toolUses = body.content.filter((b: any) => b.type === "tool_use")
    expect(toolUses.length).toBe(1)
    expect(toolUses[0].id).toBe("toolu_1")
  })

  it("stream: recovers an abort-shaped termination as tool_use + message_stop instead of an error event", async () => {
    mockTurns = [
      streamMessageStart(),
      toolTurn("toolu_s1", "get_weather", { city: "SF" }),
      toolTurn("toolu_s2", "get_weather", { city: "LA" }),
      toolTurn("toolu_s3", "get_weather", { city: "NYC" }),
    ]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await post(app, true)
    const events = await readSSE(response)
    const eventTypes = events.map((e: any) => e.event)

    expect(capturedController).toBeDefined()
    expect(capturedController!.signal.aborted).toBe(true)
    expect(eventTypes).not.toContain("error")
    expect(eventTypes).toContain("message_stop")
    const deltas = events.filter((e: any) => e.event === "message_delta")
    const stopReasons = deltas.map((e: any) => e.data?.delta?.stop_reason).filter(Boolean)
    expect(stopReasons).toContain("tool_use")
    // The distinct captured tool_use must reach the client exactly once.
    const toolStartIds = events
      .filter((e: any) => e.event === "content_block_start" && e.data?.content_block?.type === "tool_use")
      .map((e: any) => e.data.content_block.id)
    expect(toolStartIds).toEqual(["toolu_s1"])
  })

  it("closes a dangling tool_use content block before the recovery message_stop (#552 red reads)", async () => {
    // Real SDK sequence captured live: with two parallel same-tool calls in
    // one assistant turn, call 2's block_start + input deltas stream to the
    // client, then the same-tool-repeat deny aborts the subprocess BEFORE
    // call 2's content_block_stop arrives. Without an explicit close the
    // client is left with an unterminated tool_use block — OpenCode renders
    // it as an argument-less aborted ("red") tool call.
    const streamEvent = (event: any) => ({
      type: "stream_event",
      event,
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: "test-session",
    })
    const twoCallTurn = toolTurn("toolu_p1", "read", { filePath: "a.txt" })
    // Both tool calls live in ONE assistant message, mirroring the real SDK.
    ;(twoCallTurn as any).message.content = [
      { type: "tool_use", id: "toolu_p1", name: `${PASSTHROUGH_PREFIX}read`, input: { filePath: "a.txt" } },
      { type: "tool_use", id: "toolu_p2", name: `${PASSTHROUGH_PREFIX}read`, input: { filePath: "b.txt" } },
    ]
    mockTurns = [
      streamMessageStart(),
      streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_p1", name: `${PASSTHROUGH_PREFIX}read`, input: {} } }),
      streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"filePath":"a.txt"}' } }),
      streamEvent({ type: "content_block_stop", index: 1 }),
      streamEvent({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_p2", name: `${PASSTHROUGH_PREFIX}read`, input: {} } }),
      streamEvent({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"filePath":"b.txt"}' } }),
      // No content_block_stop for index 2 — the abort cuts it off here. The
      // assistant turn below fires the PreToolUse hooks: call 1 captured,
      // call 2 (same tool, new args) triggers the loop-break abort.
      twoCallTurn,
    ]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await post(app, true)
    const events = await readSSE(response)
    const eventTypes = events.map((e: any) => e.event)

    expect(capturedController!.signal.aborted).toBe(true)
    expect(eventTypes).not.toContain("error")

    // Every forwarded content_block_start must have a matching stop.
    const startIdxs = events
      .filter((e: any) => e.event === "content_block_start")
      .map((e: any) => e.data.index)
    const stopIdxs = events
      .filter((e: any) => e.event === "content_block_stop")
      .map((e: any) => e.data.index)
    for (const idx of startIdxs) {
      expect(stopIdxs).toContain(idx)
    }

    // And the dangling block's stop must precede message_stop.
    const lastStopPos = eventTypes.lastIndexOf("content_block_stop")
    const messageStopPos = eventTypes.indexOf("message_stop")
    expect(lastStopPos).toBeGreaterThan(-1)
    expect(lastStopPos).toBeLessThan(messageStopPos)
  })

  it("does not offer a single-step-aborted session for resume — the follow-up starts fresh (#552)", async () => {
    mockTurns = [
      toolTurn("toolu_1", "get_weather", { city: "SF" }),
      toolTurn("toolu_2", "get_weather", { city: "LA" }),
    ]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const first = await post(app, false)
    expect(first.status).toBe(200)
    expect(capturedController!.signal.aborted).toBe(true)

    // Follow-up turn: client executed the forwarded call and returns its
    // result. The aborted session's history contains a dangling dropped call
    // ("Stream closed") — resuming it hands the model diverged memory, the
    // source of the "read tool is returning the wrong file" confusion.
    mockTurns = [toolTurn("toolu_3", "get_time", { tz: "UTC" })]
    const second = await post(app, false, [
      { role: "user", content: "Do the thing." },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "72F" }] },
    ])
    expect(second.status).toBe(200)
    expect(capturedResume).toBeUndefined()
  })
})

describe("parallel same-tool calls are captured and forwarded (#552 kabo regression)", () => {
  // Root cause of kabo's v1.49.0 'read {} → Tool execution aborted' loop:
  // 'read multiple files' makes the model emit TWO parallel read calls in ONE
  // assistant message. The legacy #571 rule assumed genuine parallelism uses
  // DISTINCT tool names, so call 2 was dropped + the query SIGTERMed mid-hook
  // — cutting call 2's already-streamed block (red read), skipping the session
  // store, and forcing a fresh replay whose '[your read ...]: Tool execution
  // aborted' lines the model then disowns ("calls I did not make").
  //
  // With early stop, the fabricated-loop turns #571 guarded against never
  // generate (the query stops at deny-persistence), so same-tool-new-args
  // calls are genuine parallelism and must be captured and forwarded.
  let origEnv: string | undefined
  let origEarlyStop: string | undefined

  beforeEach(() => {
    origEnv = process.env.MERIDIAN_PASSTHROUGH
    origEarlyStop = process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    process.env.MERIDIAN_PASSTHROUGH = "1"
    delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP // early stop ON (default)
    mockTurns = []
    capturedController = undefined
    capturedResume = undefined
    clearSessionCache()
  })

  afterEach(() => {
    if (origEnv === undefined) delete process.env.MERIDIAN_PASSTHROUGH
    else process.env.MERIDIAN_PASSTHROUGH = origEnv
    if (origEarlyStop === undefined) delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    else process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = origEarlyStop
  })

  function parallelReadTurn() {
    const turn = toolTurn("toolu_pa", "read", { filePath: "a.txt" })
    ;(turn as any).message.content = [
      { type: "tool_use", id: "toolu_pa", name: `${PASSTHROUGH_PREFIX}read`, input: { filePath: "a.txt" } },
      { type: "tool_use", id: "toolu_pb", name: `${PASSTHROUGH_PREFIX}read`, input: { filePath: "b.txt" } },
    ]
    return turn
  }

  function denyUser(ids: string[]) {
    return {
      type: "user",
      message: {
        role: "user",
        content: ids.map((id) => ({
          type: "tool_result",
          tool_use_id: id,
          is_error: true,
          content: "This tool call has been forwarded to the client for execution.",
        })),
      },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: "test-session",
    }
  }

  it("non-stream: both parallel reads are captured with full inputs; digest turn never consumed", async () => {
    mockTurns = [
      parallelReadTurn(),
      denyUser(["toolu_pa", "toolu_pb"]),
      // Digest/fabrication turn — early stop must abort before this is consumed.
      toolTurn("toolu_garbage", "get_time", { tz: "UTC" }),
    ]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await post(app, false)
    const body = await response.json() as any

    expect(response.status).toBe(200)
    expect(body.stop_reason).toBe("tool_use")
    const toolUses = body.content.filter((b: any) => b.type === "tool_use")
    expect(toolUses.map((t: any) => t.id).sort()).toEqual(["toolu_pa", "toolu_pb"])
    // Full inputs — no argument-less 'red read'.
    expect(toolUses.find((t: any) => t.id === "toolu_pa").input).toEqual({ filePath: "a.txt" })
    expect(toolUses.find((t: any) => t.id === "toolu_pb").input).toEqual({ filePath: "b.txt" })
    // Early stop aborted the query after the denies were persisted.
    expect(capturedController!.signal.aborted).toBe(true)
  })

  it("the parallel-capture session is stored — the follow-up RESUMES instead of fresh-replaying", async () => {
    mockTurns = [parallelReadTurn(), denyUser(["toolu_pa", "toolu_pb"])]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
    const first = await post(app, false)
    expect(first.status).toBe(200)

    mockTurns = [
      {
        type: "assistant",
        message: {
          id: "msg_final", type: "message", role: "assistant",
          content: [{ type: "text", text: "Both files read successfully." }],
          model: "claude-sonnet-4-5-20250929", stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 10 },
        },
        parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: "test-session",
      },
    ]
    capturedResume = undefined
    const second = await post(app, false, [
      { role: "user", content: "Do the thing." },
      { role: "assistant", content: [
        { type: "tool_use", id: "toolu_pa", name: "read", input: { filePath: "a.txt" } },
        { type: "tool_use", id: "toolu_pb", name: "read", input: { filePath: "b.txt" } },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_pa", content: "contents of a" },
        { type: "tool_result", tool_use_id: "toolu_pb", content: "contents of b" },
      ]},
    ])
    expect(second.status).toBe(200)
    // The stored session is resumed — this is what kills the fresh-replay
    // '[your read ...]: Tool execution aborted' confusion loop.
    // (?? guard defeats TS narrowing from the `= undefined` reset above —
    // the mock closure reassigns it during the request.)
    expect(capturedResume ?? "(not resumed)").toBe("test-session")
  })

  it("stream: both parallel read blocks reach the client fully terminated, no error", async () => {
    const streamEvent = (event: any) => ({
      type: "stream_event", event, parent_tool_use_id: null,
      uuid: crypto.randomUUID(), session_id: "test-session",
    })
    mockTurns = [
      streamMessageStart(),
      streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_pa", name: `${PASSTHROUGH_PREFIX}read`, input: {} } }),
      streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"filePath":"a.txt"}' } }),
      streamEvent({ type: "content_block_stop", index: 1 }),
      streamEvent({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_pb", name: `${PASSTHROUGH_PREFIX}read`, input: {} } }),
      streamEvent({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"filePath":"b.txt"}' } }),
      streamEvent({ type: "content_block_stop", index: 2 }),
      parallelReadTurn(),
      denyUser(["toolu_pa", "toolu_pb"]),
    ]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await post(app, true)
    const events = await readSSE(response)
    const eventTypes = events.map((e: any) => e.event)

    expect(eventTypes).not.toContain("error")
    expect(eventTypes).toContain("message_stop")
    const toolStartIds = events
      .filter((e: any) => e.event === "content_block_start" && e.data?.content_block?.type === "tool_use")
      .map((e: any) => e.data.content_block.id)
    expect(toolStartIds.sort()).toEqual(["toolu_pa", "toolu_pb"])
    // Every started block terminates — no dangling 'red read'.
    const startIdxs = events.filter((e: any) => e.event === "content_block_start").map((e: any) => e.data.index)
    const stopIdxs = events.filter((e: any) => e.event === "content_block_stop").map((e: any) => e.data.index)
    for (const idx of startIdxs) expect(stopIdxs).toContain(idx)
    expect(capturedController!.signal.aborted).toBe(true)
  })

  it("kill switch restores the legacy semantics: mid-hook abort + session NOT stored", async () => {
    process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = "0"
    mockTurns = [parallelReadTurn(), denyUser(["toolu_pa", "toolu_pb"])]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const first = await post(app, false)
    expect(first.status).toBe(200)
    expect(capturedController!.signal.aborted).toBe(true)

    // Legacy: sawDuplicateToolUse skips the store — the follow-up must NOT resume.
    mockTurns = [toolTurn("toolu_next", "get_time", { tz: "UTC" })]
    capturedResume = undefined
    await post(app, false, [
      { role: "user", content: "Do the thing." },
      { role: "assistant", content: [
        { type: "tool_use", id: "toolu_pa", name: "read", input: { filePath: "a.txt" } },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_pa", content: "contents of a" },
      ]},
    ])
    expect(capturedResume).toBeUndefined()
  })
})

describe("dropped calls must not leak to the client (truth-divergence guard)", () => {
  // The hook can still DROP calls with early stop on: exact duplicates
  // ("do not repeat") and forced-single overflow (tool_choice:{type:"tool"} —
  // generateObject needs EXACTLY one call). The model is told those calls
  // were NOT forwarded — so the client must never see them. Before this
  // guard, the merge block only added/normalized captured blocks and never
  // removed dropped ones: a forced-single parallel emission returned BOTH
  // tool_use blocks (unparseable for generateObject), and the model/client
  // views diverged — the #552 misattribution seed.
  let origEnv: string | undefined
  let origEarlyStop: string | undefined

  beforeEach(() => {
    origEnv = process.env.MERIDIAN_PASSTHROUGH
    origEarlyStop = process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    process.env.MERIDIAN_PASSTHROUGH = "1"
    delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    mockTurns = []
    capturedController = undefined
    capturedResume = undefined
    clearSessionCache()
  })

  afterEach(() => {
    if (origEnv === undefined) delete process.env.MERIDIAN_PASSTHROUGH
    else process.env.MERIDIAN_PASSTHROUGH = origEnv
    if (origEarlyStop === undefined) delete process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP
    else process.env.MERIDIAN_PASSTHROUGH_EARLY_STOP = origEarlyStop
  })

  it("forced single: parallel emission in ONE message returns exactly one tool_use", async () => {
    const turn = toolTurn("toolu_j1", "json", { answer: "first" })
    ;(turn as any).message.content = [
      { type: "tool_use", id: "toolu_j1", name: `${PASSTHROUGH_PREFIX}json`, input: { answer: "first" } },
      { type: "tool_use", id: "toolu_j2", name: `${PASSTHROUGH_PREFIX}json`, input: { answer: "second" } },
    ]
    mockTurns = [turn]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-session": "forced-single-session" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools: [tool("json")],
        tool_choice: { type: "tool", name: "json", disable_parallel_tool_use: true },
        messages: [{ role: "user", content: "Give me the answer." }],
      })),
    })
    const body = await (await app.fetch(req)).json() as any

    const toolUses = body.content.filter((b: any) => b.type === "tool_use")
    expect(toolUses.length).toBe(1)
    expect(toolUses[0].id).toBe("toolu_j1")
    expect(toolUses[0].input).toEqual({ answer: "first" })
  })

  it("exact duplicate in ONE message is not delivered twice", async () => {
    const turn = toolTurn("toolu_d1", "read", { filePath: "a.txt" })
    ;(turn as any).message.content = [
      { type: "tool_use", id: "toolu_d1", name: `${PASSTHROUGH_PREFIX}read`, input: { filePath: "a.txt" } },
      // Same name + same input, fresh id — the hook drops it ("do not repeat").
      { type: "tool_use", id: "toolu_d2", name: `${PASSTHROUGH_PREFIX}read`, input: { filePath: "a.txt" } },
    ]
    mockTurns = [turn, {
      type: "user",
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_d1", is_error: true, content: "forwarded" },
        { type: "tool_result", tool_use_id: "toolu_d2", is_error: true, content: "already forwarded" },
      ]},
      parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: "test-session",
    }]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await post(app, false)
    const body = await response.json() as any
    const toolUses = body.content.filter((b: any) => b.type === "tool_use")
    expect(toolUses.map((t: any) => t.id)).toEqual(["toolu_d1"])
  })
})
