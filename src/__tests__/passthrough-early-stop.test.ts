/**
 * Unit tests for the passthrough early-stop tracker — pure functions, no mocks.
 *
 * In passthrough, the model's tool calls are denied ("forwarded to client")
 * and the SDK then invokes the model AGAIN to digest the deny — a throwaway
 * turn that is fully billed (on always-thinking models it's a whole thinking
 * pass per tool step). The tracker watches the SDK stream: once every
 * client-forwarded tool_use has its deny tool_result persisted (observed as a
 * `user` message), the proxy can abort the query BEFORE the digest turn fires.
 * Verified SDK behavior: denied tool_results ARE emitted as user messages
 * between assistant turns.
 */
import { describe, it, expect } from "bun:test"
import {
  clientAbortDisposition,
  coalesceCompleteToolResultContinuation,
  findCompleteToolResultCheckpoint,
  createEarlyStopTracker,
  allForwardedCallsResolved,
  isClientForwardedToolUse,
  noteAssistantContent,
  noteAssistantMessage,
  noteUserContent,
  settledToolCallAssistantUuid,
  shouldEarlyStop,
  trackerCoversStreamedCalls,
} from "../proxy/passthroughEarlyStop"

import { PASSTHROUGH_MCP_PREFIX } from "../proxy/passthroughTools"

const toolUse = (id: string, name: string) => ({ type: "tool_use", id, name })
const toolResult = (id: string) => ({ type: "tool_result", tool_use_id: id, is_error: true })
const sdkAssistant = (uuid: unknown, content: unknown) => ({
  type: "assistant",
  uuid,
  message: { role: "assistant", content },
})

describe("prefix cross-check", () => {
  it("tracker's duplicated prefix matches the passthrough MCP prefix", () => {
    // The tracker duplicates the prefix to stay leaf-pure; this guards drift.
    expect(isClientForwardedToolUse(toolUse("t1", `${PASSTHROUGH_MCP_PREFIX}read`))).toBe(true)
  })
})

describe("isClientForwardedToolUse", () => {
  it("matches passthrough-prefixed MCP tools", () => {
    expect(isClientForwardedToolUse(toolUse("t1", "mcp__oc__read"))).toBe(true)
  })

  it("matches bare tool names (SDK sometimes strips the prefix in events)", () => {
    expect(isClientForwardedToolUse(toolUse("t1", "read"))).toBe(true)
    expect(isClientForwardedToolUse(toolUse("t2", "Bash"))).toBe(true)
  })

  it("excludes SDK StructuredOutput but preserves a client MCP tool with that name", () => {
    expect(isClientForwardedToolUse(toolUse("internal", "StructuredOutput"))).toBe(false)
    expect(isClientForwardedToolUse(toolUse("client", "mcp__oc__StructuredOutput"))).toBe(true)
  })

  it("excludes ToolSearch (internal, SDK-executed for deferred loading)", () => {
    expect(isClientForwardedToolUse(toolUse("t1", "ToolSearch"))).toBe(false)
  })

  it("excludes internal MCP tools from other servers", () => {
    expect(isClientForwardedToolUse(toolUse("t1", "mcp__opencode__read"))).toBe(false)
  })

  it("excludes non-tool_use blocks", () => {
    expect(isClientForwardedToolUse({ type: "text", text: "hi" })).toBe(false)
    expect(isClientForwardedToolUse({ type: "server_tool_use", id: "s1", name: "advisor" })).toBe(false)
  })

  it("excludes tool_use blocks with no id (can't be tracked)", () => {
    expect(isClientForwardedToolUse({ type: "tool_use", name: "read" })).toBe(false)
  })
})

describe("clientAbortDisposition", () => {
  const base = {
    isIndependentSession: false,
    profileSessionId: "s1",
    currentSessionId: "claude-1",
    sawDuplicateToolUse: false,
    toolCallAssistantUuid: "a1",
    passthrough: true,
  }

  it("evicts even when an assistant UUID was observed before the abort", () => {
    expect(clientAbortDisposition(base)).toEqual({ action: "evict" })
  })

  it("evicts when no assistant checkpoint exists — nothing is safe to resume from", () => {
    // The interrupted tail would make the SDK synthesize a continuation the
    // model answers with an empty turn, and every empty turn becomes the next
    // tail. A fresh replay is the cost of not wedging the conversation.
    expect(clientAbortDisposition({ ...base, toolCallAssistantUuid: undefined })).toEqual({ action: "evict" })
  })

  // A deny boundary is a passthrough concept. In internal mode the SDK runs the
  // tools itself, so a user message carrying tool_results is an ordinary turn —
  // persisting its uuid as a spent deny would make the next continuation fork
  // from a point that was never a boundary.
  it("never records a passthrough checkpoint for an internal-mode abort", () => {
    expect(clientAbortDisposition({ ...base, passthrough: false })).toEqual({ action: "evict" })
  })

  it("evicts when the SDK session id never arrived", () => {
    expect(clientAbortDisposition({ ...base, currentSessionId: undefined })).toEqual({ action: "evict" })
  })

  it("evicts on a duplicate-aborted history (#552) even with a boundary", () => {
    expect(clientAbortDisposition({ ...base, sawDuplicateToolUse: true })).toEqual({ action: "evict" })
  })

  it("does nothing for fork/subagent requests — they never write the cache", () => {
    expect(clientAbortDisposition({ ...base, isIndependentSession: true })).toEqual({ action: "none" })
  })

  it("does nothing without a session key", () => {
    expect(clientAbortDisposition({ ...base, profileSessionId: undefined })).toEqual({ action: "none" })
  })
})

describe("assistant resume checkpoint", () => {
  const assistantMsg = (uuid: unknown, content: unknown) => ({
    type: "assistant",
    uuid,
    message: { role: "assistant", content },
  })

  it("stores the UUID of an assistant message carrying a forwarded tool_use", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg("a1", [toolUse("t1", "read")]))
    expect(tracker.toolCallAssistantUuid).toBe("a1")
  })

  it("advances to the final assistant fragment for parallel tool calls", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg("a1", [toolUse("t1", "read")]))
    noteAssistantMessage(tracker, assistantMsg("a2", [toolUse("t2", "grep")]))
    noteUserContent(tracker, [toolResult("t1"), toolResult("t2")])
    expect(settledToolCallAssistantUuid(tracker)).toBe("a2")
  })

  it("never accepts a user/tool-result UUID as a resume checkpoint", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, {
      type: "user",
      uuid: "u1",
      message: { role: "user", content: [toolResult("t1")] },
    })
    expect(tracker.toolCallAssistantUuid).toBeUndefined()
  })

  it("does not expose a boundary until every forwarded call settled", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg("a1", [
      toolUse("t1", "read"),
      toolUse("t2", "grep"),
    ]))
    noteUserContent(tracker, [toolResult("t1")])
    expect(allForwardedCallsResolved(tracker)).toBe(false)
    expect(settledToolCallAssistantUuid(tracker)).toBeUndefined()
    noteUserContent(tracker, [toolResult("t2")])
    expect(allForwardedCallsResolved(tracker)).toBe(true)
    expect(settledToolCallAssistantUuid(tracker)).toBe("a1")
  })

  it("fails closed when the tool-bearing assistant message has no usable UUID", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg(undefined, [toolUse("t1", "read")]))
    noteUserContent(tracker, [toolResult("t1")])
    expect(settledToolCallAssistantUuid(tracker)).toBeUndefined()
    expect(shouldEarlyStop(tracker)).toBe(false)
  })

  it("invalidates an older checkpoint when a later tool-bearing message has no UUID", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistantMsg("a1", [toolUse("t1", "read")]))
    noteAssistantMessage(tracker, assistantMsg(undefined, [toolUse("t2", "grep")]))
    noteUserContent(tracker, [toolResult("t1"), toolResult("t2")])
    expect(settledToolCallAssistantUuid(tracker)).toBeUndefined()
    expect(shouldEarlyStop(tracker)).toBe(false)
  })
})

describe("trackerCoversStreamedCalls", () => {
  it("is false while an assistant fragment is still in flight", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, sdkAssistant("a1", [toolUse("t1", "read")]))
    // The wire carried two calls; only one has been armed so far.
    expect(trackerCoversStreamedCalls(tracker, new Set(["t1", "t2"]))).toBe(false)
  })

  it("is true once every streamed call is armed", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, sdkAssistant("a1", [toolUse("t1", "read")]))
    noteAssistantMessage(tracker, sdkAssistant("a2", [toolUse("t2", "read")]))
    expect(trackerCoversStreamedCalls(tracker, new Set(["t1", "t2"]))).toBe(true)
  })

  it("is false when nothing was streamed, so an empty turn cannot settle", () => {
    const tracker = createEarlyStopTracker()
    expect(trackerCoversStreamedCalls(tracker, new Set())).toBe(false)
  })

  it("is false when the sets are the same size but disagree", () => {
    // Equal sizes must not be mistaken for equal sets — a regenerated call
    // carries a fresh id, so a stale id would otherwise pass the count check.
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, sdkAssistant("a1", [toolUse("t1", "read")]))
    expect(trackerCoversStreamedCalls(tracker, new Set(["t-other"]))).toBe(false)
  })
})

describe("early-stop tracking", () => {
  it("does not stop before any tool calls are seen", () => {
    const t = createEarlyStopTracker()
    expect(shouldEarlyStop(t)).toBe(false)
  })

  it("does not stop on a text-only assistant turn", () => {
    const t = createEarlyStopTracker()
    noteAssistantContent(t, [{ type: "text", text: "final answer" }])
    expect(shouldEarlyStop(t)).toBe(false)
  })

  it("stops after the single tool call's deny is observed", () => {
    const t = createEarlyStopTracker()
    noteAssistantMessage(t, sdkAssistant("a-single", [toolUse("t1", "mcp__oc__read")]))
    expect(shouldEarlyStop(t)).toBe(false) // deny not yet persisted
    noteUserContent(t, [toolResult("t1")])
    expect(shouldEarlyStop(t)).toBe(true)
  })

  it("waits for ALL parallel tool calls' denies before stopping", () => {
    const t = createEarlyStopTracker()
    noteAssistantMessage(t, sdkAssistant("a-parallel", [
      { type: "text", text: "reading both" },
      toolUse("t1", "mcp__oc__read"),
      toolUse("t2", "mcp__oc__grep"),
    ]))
    noteUserContent(t, [toolResult("t1")])
    expect(shouldEarlyStop(t)).toBe(false) // t2's deny still pending — do NOT drop it
    noteUserContent(t, [toolResult("t2")])
    expect(shouldEarlyStop(t)).toBe(true)
  })

  it("fires only once (idempotent after stop)", () => {
    const t = createEarlyStopTracker()
    noteAssistantMessage(t, sdkAssistant("a-idempotent", [toolUse("t1", "read")]))
    noteUserContent(t, [toolResult("t1")])
    expect(shouldEarlyStop(t)).toBe(true)
    expect(shouldEarlyStop(t)).toBe(false)
  })

  it("ignores ToolSearch turns — waits for the real tool call (deferred flow)", () => {
    const t = createEarlyStopTracker()
    // Turn 1: ToolSearch (internal, executes for real)
    noteAssistantContent(t, [toolUse("ts1", "ToolSearch")])
    noteUserContent(t, [toolResult("ts1")]) // real ToolSearch result
    expect(shouldEarlyStop(t)).toBe(false)
    // Turn 2: the actual client tool call
    noteAssistantMessage(t, sdkAssistant("a-single", [toolUse("t1", "mcp__oc__read")]))
    noteUserContent(t, [toolResult("t1")])
    expect(shouldEarlyStop(t)).toBe(true)
  })

  it("ignores unrelated tool_results (defensive)", () => {
    const t = createEarlyStopTracker()
    noteAssistantContent(t, [toolUse("t1", "read")])
    noteUserContent(t, [toolResult("unknown-id")])
    expect(shouldEarlyStop(t)).toBe(false)
  })

  it("tolerates non-array and malformed content", () => {
    const t = createEarlyStopTracker()
    noteAssistantContent(t, "just a string" as unknown)
    noteAssistantContent(t, null as unknown)
    noteUserContent(t, undefined as unknown)
    noteUserContent(t, [{ type: "text", text: "hi" }])
    expect(shouldEarlyStop(t)).toBe(false)
  })
})


describe("coalesceCompleteToolResultContinuation", () => {
  const result = (id: string, content: unknown = "ok") => ({ type: "tool_result", tool_use_id: id, content })

  it("accepts one complete parallel result batch", () => {
    const results = [result("t1"), result("t2")]
    expect(coalesceCompleteToolResultContinuation([
      { role: "user", content: results },
    ], ["t1", "t2"])).toEqual([{ role: "user", content: results }])
  })

  it("accepts a parallel result batch in a different order", () => {
    // Anthropic protocol matches tool_result by tool_use_id, not by position.
    const results = [result("t2"), result("t1")]
    expect(coalesceCompleteToolResultContinuation([
      { role: "user", content: results },
    ], ["t1", "t2"])).toEqual([{ role: "user", content: results }])
  })

  it("rejects a partial batch and an unknown result id", () => {
    expect(coalesceCompleteToolResultContinuation([
      { role: "user", content: [result("t1")] },
    ], ["t1", "t2"])).toBeUndefined()
    expect(coalesceCompleteToolResultContinuation([
      { role: "user", content: [result("unknown")] },
    ], ["t1"])).toBeUndefined()
  })

  it("coalesces queued user messages so results stay on the final SDK input", () => {
    const toolResult = result("t1")
    const queuedText = { type: "text", text: "continue" }
    const queuedImage = { type: "image", source: { type: "base64", data: "abc" } }
    expect(coalesceCompleteToolResultContinuation([
      { role: "user", content: [toolResult] },
      { role: "user", content: "continue" },
      { role: "user", content: [queuedImage] },
    ], ["t1"])).toEqual([{ role: "user", content: [toolResult, queuedText, queuedImage] }])
  })

  it("requires tool results before ordinary user content", () => {
    expect(coalesceCompleteToolResultContinuation([
      { role: "user", content: [{ type: "text", text: "first" }, result("t1")] },
    ], ["t1"])).toBeUndefined()
    expect(coalesceCompleteToolResultContinuation([
      { role: "user", content: [result("t1"), { type: "text", text: "then continue" }] },
    ], ["t1"])).toBeDefined()
  })

  it("rejects a text-only assistant message before user results", () => {
    expect(coalesceCompleteToolResultContinuation([
      { role: "assistant", content: [{ type: "text", text: "intervening turn" }] },
      { role: "user", content: [result("t1")] },
    ], ["t1"])).toBeUndefined()
  })

  it("rejects an extra text-only assistant message after the complete echo", () => {
    expect(coalesceCompleteToolResultContinuation([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "assistant", content: [{ type: "text", text: "intervening turn" }] },
      { role: "user", content: [result("t1")] },
    ], ["t1"])).toBeUndefined()
  })

  it("rejects tool results in a turn after queued user text", () => {
    expect(coalesceCompleteToolResultContinuation([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "user", content: [result("t1")] },
    ], ["t1"])).toBeUndefined()
  })

  it("rejects results split across turns, duplicated, or sent after queued content", () => {
    expect(coalesceCompleteToolResultContinuation([
      { role: "user", content: [result("t1")] },
      { role: "user", content: [result("t2")] },
    ], ["t1", "t2"])).toBeUndefined()
    expect(coalesceCompleteToolResultContinuation([
      { role: "user", content: [result("t1"), result("t1")] },
    ], ["t1"])).toBeUndefined()
    expect(coalesceCompleteToolResultContinuation([
      { role: "user", content: [result("t1")] },
      { role: "user", content: [{ type: "text", text: "continue" }, result("t1")] },
    ], ["t1"])).toBeUndefined()
    expect(coalesceCompleteToolResultContinuation([
      { role: "user", content: [result("t1")] },
      { role: "assistant", content: [{ type: "text", text: "late" }] },
    ], ["t1"])).toBeUndefined()
  })
})

describe("findCompleteToolResultCheckpoint", () => {
  const assistant = { role: "assistant", content: [{ type: "tool_use", id: "a" }, { type: "tool_use", id: "b" }] }
  const result = (id: string) => ({ type: "tool_result", tool_use_id: id, content: id })

  it("accepts only the exact immediate assistant checkpoint batch", () => {
    expect(findCompleteToolResultCheckpoint([
      { role: "user", content: "volatile old envelope" },
      assistant,
      { role: "user", content: [result("a"), result("b")] },
    ], ["a", "b"])).toBeDefined()
  })

  it("rejects duplicate, extra, missing, and wrong-role result tails", () => {
    expect(findCompleteToolResultCheckpoint([assistant, { role: "user", content: [result("a"), result("a")] }], ["a", "b"])).toBeUndefined()
    expect(findCompleteToolResultCheckpoint([assistant, { role: "user", content: [result("a"), result("b"), result("extra")] }], ["a", "b"])).toBeUndefined()
    expect(findCompleteToolResultCheckpoint([assistant, { role: "user", content: [result("a")] }], ["a", "b"])).toBeUndefined()
    expect(findCompleteToolResultCheckpoint([assistant, { role: "assistant", content: [result("a"), result("b")] }], ["a", "b"])).toBeUndefined()
  })
})

describe("claude-code trailing system delta", () => {
  const result = (id: string, content: unknown = "ok") => ({ type: "tool_result", tool_use_id: id, content })
  const echo = (ids: string[]) => ({
    role: "assistant",
    content: ids.map((id) => ({ type: "tool_use", id, name: "read", input: {} })),
  })
  const reminder = (text: string, cacheControl = false) => ({
    role: "system",
    content: [{ type: "text", text, ...(cacheControl ? { cache_control: { type: "ephemeral" } } : {}) }],
  })
  const opts = { allowClaudeCodeSystemDelta: true }

  it("accepts the live delta: complete expected-ID echo, results, trailing reminder", () => {
    const results = [result("t1"), result("t2")]
    // String and text-block-with-cache_control reminder forms pass through
    // as-is; cache_control is stripped by the caller's existing strip path.
    const cases: Array<[{ role: string; content: unknown }, unknown]> = [
      [{ role: "system", content: "<total_tokens> 4151" }, { type: "text", text: "<total_tokens> 4151" }],
      [reminder("<total_tokens> 4151", true), { type: "text", text: "<total_tokens> 4151", cache_control: { type: "ephemeral" } }],
    ]
    for (const [tail, expectedBlock] of cases) {
      expect(coalesceCompleteToolResultContinuation(
        [echo(["t1", "t2"]), { role: "user", content: results }, tail],
        ["t1", "t2"],
        opts,
      )).toEqual([{ role: "user", content: [...results, expectedBlock] }])
    }
  })

  it("delivers the reminder after results and queued user content, in wire order", () => {
    const queuedText = { type: "text", text: "continue" }
    const queuedImage = { type: "image", source: { type: "base64", data: "abc" } }
    expect(coalesceCompleteToolResultContinuation(
      [echo(["t1"]), { role: "user", content: [result("t1")] }, { role: "user", content: [queuedText, queuedImage] }, reminder("reminder")],
      ["t1"],
      opts,
    )).toEqual([{ role: "user", content: [result("t1"), queuedText, queuedImage, { type: "text", text: "reminder" }] }])
  })

  it("rejects the reminder-bearing delta without the opt-in (generic default)", () => {
    expect(coalesceCompleteToolResultContinuation(
      [echo(["t1"]), { role: "user", content: [result("t1")], }, reminder("reminder")],
      ["t1"],
    )).toBeUndefined()
  })

  it("rejects leading, non-final, repeated, non-text, and empty reminders", () => {
    const delta = [echo(["t1"]), { role: "user", content: [result("t1")] }]
    for (const body of [
      [reminder("leading"), ...delta], // leading (undemonstrated form)
      [echo(["t1"]), reminder("non-final"), { role: "user", content: [result("t1")] }], // before results
      [...delta, reminder("one"), reminder("two")], // repeated
      [...delta, reminder("final"), { role: "user", content: "after" }], // message after reminder
      [...delta, { role: "system", content: [{ type: "image", source: { type: "base64", data: "x" } }] }], // non-text block
      [...delta, { role: "system", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] }], // tool_result block
      [...delta, { role: "system", content: [] }], // empty array
      [...delta, { role: "system", content: [{ type: "text", text: "" }] }], // empty text
      [...delta, { role: "system", content: "" }], // empty string
    ]) {
      expect(coalesceCompleteToolResultContinuation(body, ["t1"], opts)).toBeUndefined()
    }
  })

  it("fails on incomplete or split echoes even with a trailing reminder", () => {
    const cases: Array<[Array<{ role?: unknown; content?: unknown }>, string[]]> = [
      [[{ role: "user", content: [result("t1")], }, reminder("r")], ["t1"]], // missing echo
      [[echo(["t1", "t2"]), { role: "user", content: [result("t1")] }, reminder("r")], ["t1", "t2"]], // partial results
      // Split echo across assistant messages: find never binds it, and the
      // reminder-gated coalesce must reject it too.
      [[echo(["t1"]), echo(["t2"]), { role: "user", content: [result("t1"), result("t2")] }, reminder("r")], ["t1", "t2"]],
    ]
    for (const [messages, ids] of cases) {
      expect(coalesceCompleteToolResultContinuation(messages, ids, opts)).toBeUndefined()
    }
  })

  it("find accepts the actual suffix under the opt-in; default stays rejected", () => {
    const body = [
      { role: "user", content: "history" },
      echo(["a"]),
      { role: "user", content: [result("a")] },
      reminder("reminder", true),
    ]
    expect(findCompleteToolResultCheckpoint(body, ["a"], opts))
      .toEqual([{ role: "user", content: [result("a"), { type: "text", text: "reminder", cache_control: { type: "ephemeral" } }] }])
    // Without the opt-in the trailing reminder is a generic rejection — the
    // observed staging transition to a full fresh replay.
    expect(findCompleteToolResultCheckpoint(body, ["a"])).toBeUndefined()
  })
})
