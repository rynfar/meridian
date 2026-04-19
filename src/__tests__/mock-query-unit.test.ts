import { describe, expect, it } from "bun:test"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

import { createMockQuery, pushUserMessage } from "./helpers/mockQuery"

const msg = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
})

describe("createMockQuery — event sequence", () => {
  it("emits system(init) then scripted events then synthesized result per turn", async () => {
    const { query } = createMockQuery({
      sessionId: "sess-1",
      turns: [{
        events: [
          { type: "assistant", message: { role: "assistant", content: "hi" } } as unknown as SDKMessage,
        ],
        result: { stopReason: "end_turn", cacheReadInputTokens: 100, cacheCreationInputTokens: 50 },
      }],
    })

    pushUserMessage(query, msg("hello"))
    const events: SDKMessage[] = []
    for await (const e of query) events.push(e)

    expect(events.map((e: any) => e.type)).toEqual(["system", "assistant", "result"])
    const system = events[0] as any
    expect(system.subtype).toBe("init")
    expect(system.session_id).toBe("sess-1")
    const result = events[2] as any
    expect(result.stop_reason).toBe("end_turn")
    expect(result.usage.cache_read_input_tokens).toBe(100)
    expect(result.usage.cache_creation_input_tokens).toBe(50)
    expect(result.session_id).toBe("sess-1")
  })

  it("runs multiple turns, each with its own system(init) and result, consuming one user message per turn", async () => {
    const { query, pushed } = createMockQuery({
      sessionId: "sess-2",
      turns: [
        { events: [{ type: "assistant" } as unknown as SDKMessage], result: { cacheReadInputTokens: 0, cacheCreationInputTokens: 344 } },
        { events: [{ type: "assistant" } as unknown as SDKMessage], result: { cacheReadInputTokens: 344, cacheCreationInputTokens: 20 } },
      ],
    })

    pushUserMessage(query, msg("turn 1"))
    pushUserMessage(query, msg("turn 2"))

    const events: SDKMessage[] = []
    for await (const e of query) events.push(e)

    const types = events.map((e: any) => e.type)
    expect(types).toEqual(["system", "assistant", "result", "system", "assistant", "result"])
    expect(pushed).toHaveLength(2)
    const results = events.filter((e: any) => e.type === "result") as any[]
    expect(results[0].usage.cache_read_input_tokens).toBe(0)
    expect(results[1].usage.cache_read_input_tokens).toBe(344)
  })

  it("honors suppressSystemInit per turn", async () => {
    const { query } = createMockQuery({
      turns: [{
        events: [{ type: "assistant" } as unknown as SDKMessage],
        suppressSystemInit: true,
      }],
    })
    pushUserMessage(query, msg("x"))
    const events: SDKMessage[] = []
    for await (const e of query) events.push(e)
    expect(events.map((e: any) => e.type)).toEqual(["assistant", "result"])
  })

  it("honors a script that already emits its own result (no duplicate synthesized)", async () => {
    const { query } = createMockQuery({
      turns: [{
        events: [
          { type: "assistant" } as unknown as SDKMessage,
          { type: "result", subtype: "success", usage: { cache_read_input_tokens: 9, cache_creation_input_tokens: 1 } } as unknown as SDKMessage,
        ],
      }],
    })
    pushUserMessage(query, msg("x"))
    const events: SDKMessage[] = []
    for await (const e of query) events.push(e)
    const resultEvents = events.filter((e: any) => e.type === "result")
    expect(resultEvents).toHaveLength(1)
    expect((resultEvents[0] as any).usage.cache_read_input_tokens).toBe(9)
  })

  it("forwards arbitrary mid-turn events (rate_limit_event, synthetic user, stream_event) unchanged", async () => {
    const { query } = createMockQuery({
      turns: [{
        events: [
          { type: "stream_event", event: { type: "message_start" } } as unknown as SDKMessage,
          { type: "rate_limit_event" } as unknown as SDKMessage,
          { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } } as unknown as SDKMessage,
          { type: "assistant" } as unknown as SDKMessage,
        ],
      }],
    })
    pushUserMessage(query, msg("x"))
    const events: SDKMessage[] = []
    for await (const e of query) events.push(e)
    expect(events.map((e: any) => e.type)).toEqual([
      "system", "stream_event", "rate_limit_event", "user", "assistant", "result",
    ])
  })
})

describe("createMockQuery — control method recording", () => {
  it("records setModel / applyFlagSettings calls in order", async () => {
    const { query, calls } = createMockQuery({
      turns: [{ events: [{ type: "assistant" } as unknown as SDKMessage] }],
    })
    await query.setModel("claude-sonnet-4-5")
    await query.applyFlagSettings({ effort: "high" } as any)
    await query.setModel("claude-opus-4-6")
    expect(calls.setModel).toEqual(["claude-sonnet-4-5", "claude-opus-4-6"])
    expect(calls.applyFlagSettings).toEqual([{ effort: "high" }])
  })

  it("records interrupt / close calls as counters", async () => {
    const { query, calls } = createMockQuery({
      turns: [{ events: [{ type: "assistant" } as unknown as SDKMessage] }],
    })
    await query.interrupt()
    await query.interrupt()
    query.close()
    expect(calls.interrupt).toBe(2)
    expect(calls.close).toBe(1)
  })

  it("records getContextUsage calls", async () => {
    const { query, calls } = createMockQuery({
      turns: [{ events: [{ type: "assistant" } as unknown as SDKMessage] }],
    })
    await query.getContextUsage()
    await query.getContextUsage()
    expect(calls.getContextUsage).toBe(2)
  })

  it("honors streamInput by pushing consumed messages into the queue", async () => {
    const { query, calls, pushed } = createMockQuery({
      turns: [
        { events: [{ type: "assistant" } as unknown as SDKMessage] },
        { events: [{ type: "assistant" } as unknown as SDKMessage] },
      ],
    })
    const input = (async function* () {
      yield msg("from stream 1")
      yield msg("from stream 2")
    })()
    await query.streamInput(input)
    expect(calls.streamInput).toBe(1)
    expect(pushed).toHaveLength(2)
    expect((pushed[0]!.message.content as string)).toBe("from stream 1")

    // Consume all events — mock produced both turns.
    const events: SDKMessage[] = []
    for await (const e of query) events.push(e)
    expect(events.filter((e: any) => e.type === "result")).toHaveLength(2)
  })
})

describe("createMockQuery — crash injection", () => {
  it("throws from the generator at the configured turn to simulate a mid-session crash", async () => {
    const { query } = createMockQuery({
      crashOnTurn: 1,
      crashError: new Error("simulated SDK crash"),
      turns: [
        { events: [{ type: "assistant" } as unknown as SDKMessage] },
        { events: [{ type: "assistant" } as unknown as SDKMessage] },
      ],
    })
    pushUserMessage(query, msg("t1"))
    pushUserMessage(query, msg("t2"))

    const events: SDKMessage[] = []
    let caught: unknown = null
    try {
      for await (const e of query) events.push(e)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe("simulated SDK crash")
    // Turn 1 completed; turn 2 errored before emitting any events.
    expect(events.filter((e: any) => e.type === "result")).toHaveLength(1)
  })
})

describe("createMockQuery — close semantics", () => {
  it("close() wakes pending waiters and terminates the generator", async () => {
    const { query } = createMockQuery({
      turns: [{ events: [{ type: "assistant" } as unknown as SDKMessage] }],
    })
    const events: SDKMessage[] = []
    const consumer = (async () => { for await (const e of query) events.push(e) })()
    // No push; generator is waiting on a user message. close() should unblock it.
    await new Promise((r) => setTimeout(r, 10))
    query.close()
    await consumer
    expect(events).toHaveLength(0)
  })
})
