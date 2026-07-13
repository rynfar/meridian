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
  createEarlyStopTracker,
  isClientForwardedToolUse,
  noteAssistantContent,
  noteUserContent,
  shouldEarlyStop,
} from "../proxy/passthroughEarlyStop"

import { PASSTHROUGH_MCP_PREFIX } from "../proxy/passthroughTools"

const toolUse = (id: string, name: string) => ({ type: "tool_use", id, name })
const toolResult = (id: string) => ({ type: "tool_result", tool_use_id: id, is_error: true })

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
    noteAssistantContent(t, [toolUse("t1", "mcp__oc__read")])
    expect(shouldEarlyStop(t)).toBe(false) // deny not yet persisted
    noteUserContent(t, [toolResult("t1")])
    expect(shouldEarlyStop(t)).toBe(true)
  })

  it("waits for ALL parallel tool calls' denies before stopping", () => {
    const t = createEarlyStopTracker()
    noteAssistantContent(t, [
      { type: "text", text: "reading both" },
      toolUse("t1", "mcp__oc__read"),
      toolUse("t2", "mcp__oc__grep"),
    ])
    noteUserContent(t, [toolResult("t1")])
    expect(shouldEarlyStop(t)).toBe(false) // t2's deny still pending — do NOT drop it
    noteUserContent(t, [toolResult("t2")])
    expect(shouldEarlyStop(t)).toBe(true)
  })

  it("fires only once (idempotent after stop)", () => {
    const t = createEarlyStopTracker()
    noteAssistantContent(t, [toolUse("t1", "read")])
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
    noteAssistantContent(t, [toolUse("t1", "mcp__oc__read")])
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
