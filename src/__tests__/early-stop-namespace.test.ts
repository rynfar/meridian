/**
 * The early-stop tracker must arm on the adapter's OWN client-tool namespace
 * (#996, a regression from #983).
 *
 * #983 gave each adapter its own passthrough namespace, so the LiteLLM adapter
 * registers client tools as `mcp__litellm__*`. `noteAssistantMessage` still
 * called `noteAssistantContent` with the default prefix, so on that adapter
 * nothing was ever added to `expected`: no checkpoint UUID was frozen, no
 * `passthroughToolCallIds` were stored, and every client-driven tool round
 * started a fresh SDK session.
 *
 * `isClientForwardedToolUse` is deliberately strict about foreign `mcp__*`
 * names — that is what made a missed prefix silent instead of noisy. Bisected
 * live: at `15529b12` (pre-#983) a passthrough tool loop resumed on every
 * round; at `96dc5605` it resumed on none.
 */

import { describe, it, expect } from "bun:test"
import {
  createEarlyStopTracker,
  noteAssistantMessage,
  noteAssistantContent,
  noteUserContent,
  allForwardedCallsResolved,
} from "../proxy/passthroughEarlyStop"
import { passthroughMcpPrefix } from "../proxy/passthroughTools"
import { passthroughAdapter } from "../proxy/adapters/passthrough"

const assistant = (name: string, id = "tu1") => ({
  type: "assistant",
  uuid: "uuid-1",
  message: { content: [{ type: "tool_use", id, name, input: {} }] },
})

describe("noteAssistantMessage honours the declared namespace", () => {
  it("arms on a tool in the adapter's own namespace", () => {
    const prefix = passthroughMcpPrefix(passthroughAdapter.getPassthroughMcpName!())
    expect(prefix).toBe("mcp__litellm__")
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistant("mcp__litellm__read"), prefix)
    expect([...tracker.expected]).toEqual(["tu1"])
    expect(tracker.toolCallAssistantUuid).toBe("uuid-1")
  })

  // THE REGRESSION. Before the fix this was the only behaviour available from
  // `noteAssistantMessage`, because it did not accept a prefix at all.
  it("does NOT arm on that tool under the default namespace", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistant("mcp__litellm__read"))
    expect(tracker.expected.size).toBe(0)
    expect(tracker.toolCallAssistantUuid).toBeUndefined()
  })

  it("still arms on the default namespace when no prefix is passed", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistant("mcp__oc__read"))
    expect([...tracker.expected]).toEqual(["tu1"])
  })

  it("still refuses a genuinely internal MCP tool", () => {
    const tracker = createEarlyStopTracker()
    noteAssistantMessage(tracker, assistant("mcp__opencode__read"), "mcp__litellm__")
    expect(tracker.expected.size).toBe(0)
  })

  it("keeps the same semantics as noteAssistantContent", () => {
    const viaMessage = createEarlyStopTracker()
    noteAssistantMessage(viaMessage, assistant("mcp__litellm__read"), "mcp__litellm__")
    const viaContent = createEarlyStopTracker()
    noteAssistantContent(viaContent, assistant("mcp__litellm__read").message.content, "mcp__litellm__")
    expect([...viaMessage.expected]).toEqual([...viaContent.expected])
  })

  // The whole point of arming: without it the turn never reaches the
  // early-stop condition, so no checkpoint is frozen and no round can resume.
  it("reaches the early-stop condition only once armed", () => {
    const armed = createEarlyStopTracker()
    noteAssistantMessage(armed, assistant("mcp__litellm__read"), "mcp__litellm__")
    noteUserContent(armed, [{ type: "tool_result", tool_use_id: "tu1", content: "x" }])
    expect(allForwardedCallsResolved(armed)).toBe(true)

    const unarmed = createEarlyStopTracker()
    noteAssistantMessage(unarmed, assistant("mcp__litellm__read"))
    noteUserContent(unarmed, [{ type: "tool_result", tool_use_id: "tu1", content: "x" }])
    expect(allForwardedCallsResolved(unarmed)).toBe(false)
  })
})
