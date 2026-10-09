import { describe, expect, it } from "bun:test"
import { PassthroughCheckpointStop, PassthroughCheckpointStopError } from "../proxy/passthroughCheckpointStop"
import { PASSTHROUGH_DENY_REASON } from "../proxy/passthroughDenial"

const denied = { decision: "block", reason: PASSTHROUGH_DENY_REASON }
const hook = (tool: string, input: unknown = { ordinal: tool }) => ({
  hook_event_name: "PreToolUse", tool_use_id: tool, tool_name: "mcp__oc__read", tool_input: input,
})
const stream = (event: unknown) => ({ type: "stream_event", session_id: "owned-session", event })
const result = (overrides: Record<string, unknown> = {}) => ({
  type: "result", session_id: "owned-session", subtype: "error_during_execution",
  is_error: true, terminal_reason: "aborted_tools", num_turns: 4,
  errors: ["fixture owned interruption"], ...overrides,
})
const nativeError = () => new Error("Claude Code returned an error result: fixture owned interruption")
const receipt = (tool: string) => ({ type: "user", session_id: "owned-session", message: {
  content: [{ type: "tool_result", tool_use_id: tool, is_error: true, content: "fixture denial" }],
} })

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup(options: { maxTurns?: number; acknowledgementMs?: number } = {}) {
  const controller = new AbortController(), ack = deferred()
  let interrupts = 0
  const stop = new PassthroughCheckpointStop({ signal: controller.signal, clientToolPrefix: "mcp__oc__", maxTurns: 4, ...options })
  stop.attach(() => { interrupts++; return ack.promise })
  stop.observe({ type: "system", subtype: "init", session_id: "owned-session" })
  return { stop, controller, ack, interrupts: () => interrupts }
}

function generation(stop: PassthroughCheckpointStop, options: {
  omitLastClose?: boolean; omitLastMetadata?: boolean; omitUuid?: boolean;
  mixedInternal?: boolean; input?: unknown; generationId?: string;
} = {}) {
  const generationId = options.generationId ?? "generation-1"
  stop.observe(stream({ type: "message_start", message: { id: generationId } }))
  for (const [index, tool] of ["tool-a", "tool-b"].entries()) {
    stop.observe(stream({ type: "content_block_start", index,
      content_block: { type: "tool_use", id: tool, name: "mcp__oc__read", input: {} } }))
    if (!options.omitLastClose || index === 0) stop.observe(stream({ type: "content_block_stop", index }))
    if (!options.omitLastMetadata || index === 0) stop.observe({ type: "assistant", session_id: "owned-session",
      uuid: options.omitUuid ? undefined : `uuid-${index}`, message: { id: generationId,
        content: [{ type: "tool_use", id: tool, name: "mcp__oc__read", input: options.input ?? { ordinal: tool } }] } })
  }
  if (options.mixedInternal) {
    stop.observe(stream({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "internal", name: "ToolSearch" } }))
    stop.observe(stream({ type: "content_block_stop", index: 2 }))
  }
  stop.observe(stream({ type: "message_delta", delta: { stop_reason: "tool_use" } }))
  stop.observe(stream({ type: "message_stop" }))
}

async function ownedIntent(options: { maxTurns?: number; acknowledgementMs?: number; input?: unknown } = {}) {
  const state = setup(options)
  generation(state.stop, options)
  await state.stop.holdDeniedHook(hook("tool-a", options.input), denied)
  state.stop.observe(receipt("tool-a"))
  const terminalHook = state.stop.holdDeniedHook(hook("tool-b", options.input), denied)
  return { ...state, terminalHook }
}

async function acknowledged(options: { maxTurns?: number; input?: unknown } = {}) {
  const state = await ownedIntent(options)
  state.ack.resolve()
  await state.terminalHook
  state.stop.observe(receipt("tool-b"))
  return state
}

describe("attempt-owned passthrough checkpoint stop", () => {
  it("releases the complete serial prefix, retaining the final hook through acknowledgement", async () => {
    const state = await ownedIntent()
    let released = false
    void state.terminalHook.then(() => { released = true })
    await Promise.resolve()
    expect(state.interrupts()).toBe(1)
    expect(released).toBe(false)
    state.ack.resolve(); await state.terminalHook
    expect(released).toBe(true)
    state.stop.observe(receipt("tool-b")); state.stop.observe(result())
    expect(state.stop.acceptsIteratorError(nativeError())).toBe(true)
    await state.stop.retire()
    expect(state.stop.controlJoined).toBe(true)
    expect(state.stop.failed).toBe(false)
    expect(state.stop.receipt).toEqual({ acknowledged: true, qualified: true, generations: 1, tools: 2 })
  })

  it("retains concurrently dispatched hooks without assuming their order", async () => {
    const state = setup()
    // Full metadata must arrive before the generation-stop signal; hooks can
    // arrive together and in reverse order while that last signal is delayed.
    generation(state.stop, { omitLastClose: true })
    const second = state.stop.holdDeniedHook(hook("tool-b"), denied)
    const first = state.stop.holdDeniedHook(hook("tool-a"), denied)
    expect(state.interrupts()).toBe(0)
    state.stop.observe(stream({ type: "content_block_stop", index: 1 }))
    expect(state.interrupts()).toBe(1)
    state.ack.resolve(); await Promise.all([first, second])
    state.stop.observe(receipt("tool-a")); state.stop.observe(receipt("tool-b")); state.stop.observe(result())
    expect(state.stop.acceptsIteratorError(nativeError())).toBe(true)
    await state.stop.retire()
  })

  for (const option of ["omitLastClose", "omitLastMetadata", "omitUuid"] as const) {
    it(`never interrupts with ${option}`, async () => {
      const state = setup()
      generation(state.stop, { [option]: true })
      const hooks = [state.stop.holdDeniedHook(hook("tool-a"), denied), state.stop.holdDeniedHook(hook("tool-b"), denied)]
      expect(state.interrupts()).toBe(0)
      await state.stop.retire(); await Promise.all(hooks)
      expect(state.stop.acceptsIteratorError(nativeError())).toBe(false)
    })
  }

  it("does not interrupt mixed SDK-owned work or hold its client hook", async () => {
    const state = setup(); generation(state.stop, { mixedInternal: true })
    await state.stop.holdDeniedHook(hook("tool-a"), denied)
    expect(state.interrupts()).toBe(0)
    await state.stop.retire()
  })

  it("does not count discovery-only work as a client checkpoint", async () => {
    const state = setup()
    state.stop.observe(stream({ type: "message_start", message: { id: "discovery" } }))
    state.stop.observe(stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "search", name: "ToolSearch" } }))
    state.stop.observe(stream({ type: "content_block_stop", index: 0 }))
    state.stop.observe(stream({ type: "message_delta", delta: { stop_reason: "tool_use" } }))
    state.stop.observe(stream({ type: "message_stop" }))
    expect(state.interrupts()).toBe(0)
    generation(state.stop, { generationId: "client-generation" })
    await state.stop.holdDeniedHook(hook("tool-a"), denied)
    const last = state.stop.holdDeniedHook(hook("tool-b"), denied)
    expect(state.interrupts()).toBe(1)
    state.ack.resolve(); await last
    state.stop.observe(receipt("tool-a")); state.stop.observe(receipt("tool-b")); state.stop.observe(result())
    expect(state.stop.acceptsIteratorError(nativeError())).toBe(true)
    expect(state.stop.receipt.generations).toBe(2)
    await state.stop.retire()
  })

  it("does not hold duplicate/drop denials or a disabled control", async () => {
    const state = setup(); generation(state.stop)
    await state.stop.holdDeniedHook(hook("tool-a"), { decision: "block", reason: "already handled" })
    expect(state.interrupts()).toBe(0)
    state.stop.attach(undefined)
    await state.stop.holdDeniedHook(hook("tool-b"), denied)
    expect(state.interrupts()).toBe(0)
    await state.stop.retire()
  })

  it("compares object keys semantically while preserving long array order", async () => {
    const array = Array.from({ length: 12 }, (_, i) => i)
    const state = setup(); generation(state.stop, { input: { a: 1, b: array } })
    await state.stop.holdDeniedHook(hook("tool-a", { b: array, a: 1 }), denied)
    const last = state.stop.holdDeniedHook(hook("tool-b", { b: array, a: 1 }), denied)
    expect(state.interrupts()).toBe(1); state.ack.resolve(); await last
    state.stop.observe(receipt("tool-a")); state.stop.observe(receipt("tool-b")); state.stop.observe(result())
    expect(state.stop.acceptsIteratorError(nativeError())).toBe(true); await state.stop.retire()
  })

  it("rejects a changed input instead of interrupting unrelated work", async () => {
    const state = setup(); generation(state.stop)
    await state.stop.holdDeniedHook(hook("tool-a"), denied)
    await state.stop.holdDeniedHook(hook("tool-b", { ordinal: "changed" }), denied)
    expect(state.interrupts()).toBe(0); expect(state.stop.failed).toBe(true)
    await state.stop.retire()
  })

  it("permits an identical complete assistant snapshot without replacing its boundary", async () => {
    const state = setup(); generation(state.stop)
    state.stop.observe({ type: "assistant", session_id: "owned-session", uuid: "snapshot-uuid", message: {
      id: "generation-1", content: ["tool-a", "tool-b"].map(tool => ({ type: "tool_use", id: tool, name: "mcp__oc__read", input: { ordinal: tool } })),
    } })
    await state.stop.holdDeniedHook(hook("tool-a"), denied)
    const last = state.stop.holdDeniedHook(hook("tool-b"), denied)
    state.ack.resolve(); await last
    state.stop.observe(receipt("tool-a")); state.stop.observe(receipt("tool-b")); state.stop.observe(result())
    expect(state.stop.acceptsIteratorError(nativeError())).toBe(true); await state.stop.retire()
  })

  it("rejects conflicting repeated metadata", async () => {
    const state = setup(); generation(state.stop)
    expect(() => state.stop.observe({ type: "assistant", session_id: "owned-session", uuid: "snapshot-uuid", message: {
      id: "generation-1", content: [{ type: "tool_use", id: "tool-a", name: "mcp__oc__read", input: { ordinal: "changed" } }],
    } })).toThrow(PassthroughCheckpointStopError)
    expect(state.interrupts()).toBe(0); await state.stop.retire()
  })

  it("does not claim an extra API generation with a reused public identity", async () => {
    const state = setup(); generation(state.stop)
    expect(() => generation(state.stop)).toThrow(PassthroughCheckpointStopError)
    expect(state.interrupts()).toBe(0); await state.stop.retire()
  })

  it("retains a synchronous public-control failure without claiming pending control custody", async () => {
    const state = setup(), error = new Error("fixture synchronous control failure")
    state.stop.attach(() => { throw error }); generation(state.stop)
    await state.stop.holdDeniedHook(hook("tool-a"), denied)
    await state.stop.holdDeniedHook(hook("tool-b"), denied)
    await state.stop.retire()
    expect(state.stop.failure).toBe(error); expect(state.stop.failed).toBe(true); expect(state.stop.controlJoined).toBe(true)
  })

  for (const [name, change] of Object.entries({
    subtype: { subtype: "success" }, errorFlag: { is_error: false }, reason: { terminal_reason: "aborted_streaming" },
    session: { session_id: "other-session" }, missingErrors: { errors: [] }, counter: { num_turns: 5 },
  })) {
    it(`rejects the wrong terminal ${name}`, async () => {
      const state = await acknowledged()
      try { state.stop.observe(result(change)) } catch (error) { expect(error).toBeInstanceOf(PassthroughCheckpointStopError) }
      expect(state.stop.acceptsIteratorError(nativeError())).toBe(false)
      await state.stop.retire(); expect(state.stop.failed).toBe(true)
    })
  }

  it("does not swallow an unrelated iterator failure or a bare process exit", async () => {
    for (const message of ["unrelated transport failure", "Claude Code process exited with code 1"]) {
      const state = await acknowledged(); state.stop.observe(result())
      expect(state.stop.acceptsIteratorError(new Error(message))).toBe(false)
      await state.stop.retire(); expect(state.stop.failed).toBe(true)
    }
  })

  it("rejects a terminal before acknowledgement", async () => {
    const state = await ownedIntent()
    state.stop.observe(result()); state.ack.resolve(); await state.terminalHook
    expect(state.stop.acceptsIteratorError(nativeError())).toBe(false)
    await state.stop.retire(); expect(state.stop.failed).toBe(true)
  })

  it("requires the whole owned result set", async () => {
    const state = await ownedIntent(); state.ack.resolve(); await state.terminalHook
    state.stop.observe(result())
    expect(state.stop.acceptsIteratorError(nativeError())).toBe(false)
    await state.stop.retire()
  })

  it("rejects repeated or executed results", async () => {
    for (const value of [receipt("tool-a"), { ...receipt("tool-b"), message: { content: [{ type: "tool_result", tool_use_id: "tool-b", is_error: false }] } }]) {
      const state = await ownedIntent(); state.ack.resolve(); await state.terminalHook
      expect(() => state.stop.observe(value)).toThrow(PassthroughCheckpointStopError)
      expect(state.stop.acceptsIteratorError(nativeError())).toBe(false); await state.stop.retire()
    }
  })

  it("retains acknowledgement failure identity and releases the owned hook", async () => {
    const state = await ownedIntent(), error = new Error("fixture control transport failure")
    state.ack.reject(error); await state.terminalHook; await state.stop.retire()
    expect(state.stop.failure).toBe(error); expect(state.stop.failed).toBe(true); expect(state.stop.controlJoined).toBe(true)
  })

  it("does not claim a timed-out public control is joined", async () => {
    const state = await ownedIntent({ acknowledgementMs: 5 })
    await state.terminalHook; await state.stop.retire()
    expect(state.stop.failed).toBe(true); expect(state.stop.controlJoined).toBe(false)
    state.ack.resolve(); await Promise.resolve(); expect(state.stop.controlJoined).toBe(true)
  })

  it("does not qualify caller abort during acknowledgement", async () => {
    const state = await ownedIntent(); state.controller.abort(); await state.terminalHook
    state.ack.resolve(); await state.stop.retire()
    expect(state.stop.acceptsIteratorError(nativeError())).toBe(false)
    expect(state.stop.receipt.qualified).toBe(false)
  })

  it("an old callback and attach cannot act on a replacement attempt", async () => {
    const old = setup(); generation(old.stop)
    await old.stop.holdDeniedHook(hook("tool-a"), denied); await old.stop.retire()
    const replacement = await ownedIntent()
    old.stop.attach(() => replacement.ack.promise)
    await old.stop.holdDeniedHook(hook("tool-b"), denied)
    expect(old.interrupts()).toBe(0); expect(replacement.interrupts()).toBe(1)
    replacement.ack.resolve(); await replacement.terminalHook; await replacement.stop.retire()
  })

  it("retains the operator cap and rejects another complete generation beyond it", async () => {
    const state = setup({ maxTurns: 1 }); generation(state.stop)
    expect(() => generation(state.stop, { generationId: "over-budget" })).toThrow(PassthroughCheckpointStopError)
    expect(state.interrupts()).toBe(0); await state.stop.retire()
  })

  it("preserves pre-intent SDK error classification instead of replacing the error", async () => {
    const state = setup()
    state.stop.observe({ type: "assistant", session_id: "owned-session", error: "rate_limit" })
    await state.stop.holdDeniedHook(hook("tool-a"), denied)
    expect(state.interrupts()).toBe(0); expect(state.stop.failed).toBe(false)
    expect(state.stop.acceptsIteratorError(new Error("native quota refusal"))).toBe(false)
    await state.stop.retire()
  })
})
