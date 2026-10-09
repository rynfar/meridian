import { describe, expect, it } from "bun:test"
import { PassthroughCheckpointStop, PassthroughCheckpointStopError } from "../proxy/passthroughCheckpointStop"
import { PASSTHROUGH_DENY_REASON } from "../proxy/passthroughDenial"

function setup(cap = 4) {
  const stop = new PassthroughCheckpointStop({ signal: new AbortController().signal, clientToolPrefix: "mcp__oc__", maxTurns: cap })
  let interrupts = 0
  stop.attach(async () => { interrupts++ })
  stop.observe({ type: "system", subtype: "init", session_id: "fixture" })
  const stream = (event: unknown) => stop.observe({ type: "stream_event", session_id: "fixture", event })
  return { stop, stream, interrupts: () => interrupts }
}
const hook = (id: string) => ({ hook_event_name: "PreToolUse", session_id: "fixture", tool_use_id: id, tool_name: "mcp__oc__read", tool_input: { ordinal: id } })
const denial = { decision: "block", reason: PASSTHROUGH_DENY_REASON }

function clientGeneration(state: ReturnType<typeof setup>, generation = "client") {
  state.stream({ type: "message_start", message: { id: generation } })
  for (const [index, id] of ["a", "b"].entries()) {
    state.stream({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "mcp__oc__read" } })
    state.stream({ type: "content_block_stop", index })
    state.stop.observe({ type: "assistant", session_id: "fixture", uuid: `uuid-${id}`, message: { id: generation, content: [{ type: "tool_use", id, name: "mcp__oc__read", input: { ordinal: id } }] } })
  }
  state.stream({ type: "message_delta", delta: { stop_reason: "tool_use" } })
  state.stream({ type: "message_stop" })
}

describe("checkpoint control fallback and native cap-one regressions", () => {
  it("drains mixed SDK-owned work and permits the next root generation", async () => {
    const state = setup()
    state.stream({ type: "message_start", message: { id: "mixed" } })
    state.stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "search", name: "ToolSearch" } })
    await state.stop.holdDeniedHook(hook("mixed-call"), denial)
    expect(() => state.stream({ type: "content_block_stop", index: 0 })).not.toThrow()
    state.stream({ type: "message_delta", delta: { stop_reason: "tool_use" } }); state.stream({ type: "message_stop" })
    expect(state.stop.failed).toBe(false); expect(state.interrupts()).toBe(0)
    clientGeneration(state)
    await state.stop.holdDeniedHook(hook("a"), denial); await state.stop.holdDeniedHook(hook("b"), denial)
    expect(state.interrupts()).toBe(1)
    await state.stop.retire()
  })

  it("keeps pre-intent nested SDK work on its existing drain path", async () => {
    const state = setup()
    state.stream({ type: "message_start", message: { id: "internal" } })
    expect(() => state.stop.observe({ type: "assistant", parent_tool_use_id: "native-child", session_id: "child-session", message: { content: [] } })).not.toThrow()
    state.stream({ type: "message_delta", delta: { stop_reason: "end_turn" } }); state.stream({ type: "message_stop" })
    expect(state.stop.failed).toBe(false); expect(state.interrupts()).toBe(0)
    clientGeneration(state)
    await state.stop.holdDeniedHook(hook("a"), denial); await state.stop.holdDeniedHook(hook("b"), denial)
    expect(state.interrupts()).toBe(1)
    expect(() => state.stop.observe({ type: "assistant", parent_tool_use_id: "late-child", message: { content: [] } })).toThrow(PassthroughCheckpointStopError)
    await state.stop.retire()
  })

  for (const reason of ["aborted_tools", "max_turns"] as const) {
    it(`cap-one terminal reason ${reason} requires owned aborted-tool qualification`, async () => {
      const state = setup(1); clientGeneration(state)
      await state.stop.holdDeniedHook(hook("a"), denial); await state.stop.holdDeniedHook(hook("b"), denial)
      for (const id of ["a", "b"]) state.stop.observe({ type: "user", session_id: "fixture", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true }] } })
      state.stop.observe({ type: "result", session_id: "fixture", subtype: "error_max_turns", is_error: true, num_turns: 2, terminal_reason: reason, errors: ["fixture interruption"] })
      expect(state.stop.acceptsIteratorError(new Error("Claude Code returned an error result: fixture interruption"))).toBe(reason === "aborted_tools")
      await state.stop.retire()
    })
  }
})
