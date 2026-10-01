import { describe, expect, it } from "bun:test"
import { contextWindowFor, estimateTokens, replayBudgetFor, replayReserveFor, trimReplayHistory } from "../proxy/replayBudget"

const user = (content: string) => ({ role: "user", content })
const assistant = (content: string) => ({ role: "assistant", content })
const text = (tokens: number) => "a".repeat(tokens * 7 / 2)

describe("replay budget", () => {
  it("returns the same array when it fits", () => {
    const messages = [user("hello")]
    expect(trimReplayHistory(messages, 100)).toEqual({ messages, omittedMessages: 0, omittedTokens: 0 })
    expect(trimReplayHistory(messages, 100).messages).toBe(messages)
  })
  it("keeps a small head, drops oldest groups, and reports exact omissions without mutation", () => {
    const messages = [user(text(2)), assistant(text(20)), user(text(40)), assistant(text(40)), user(text(20)), assistant(text(20)), user(text(10))]
    const before = JSON.stringify(messages)
    const result = trimReplayHistory(messages, 100)
    expect(result.omittedMessages).toBe(3)
    expect(result.omittedTokens).toBe(100)
    expect(result.messages).toEqual([messages[0]!, user("[Meridian: 3 earlier messages (~100 tokens) were omitted from this replay to fit the model's context window.]"), ...messages.slice(4)])
    expect(JSON.stringify(messages)).toBe(before)
  })
  it("drops a head over ten percent and never skips a non-fitting group", () => {
    const messages = [user(text(12)), user(text(2)), user(text(100)), user(text(10))]
    const result = trimReplayHistory(messages, 100)
    expect(result.omittedMessages).toBe(3)
    expect(result.messages.slice(1)).toEqual(messages.slice(3))
  })
  it("keeps the whole live tail even when it alone exceeds budget", () => {
    const messages = [user(text(2)), assistant(text(20)), user(text(120)), assistant(text(20))]
    const result = trimReplayHistory(messages, 100)
    expect(result.omittedMessages).toBe(2)
    expect(result.messages.slice(1)).toEqual(messages.slice(2))
  })
  it("omits a non-user prefix in the middle", () => {
    const result = trimReplayHistory([user(text(2)), assistant(text(200)), assistant("orphan"), user("live")], 100)
    expect(result.omittedMessages).toBe(2)
  })
  it("drops even a small head when the live tail leaves no room for it", () => {
    const messages = [user(text(8)), assistant(text(30)), user(text(96))]
    const result = trimReplayHistory(messages, 100)
    expect(result.omittedMessages).toBe(2)
    expect(result.messages.slice(1)).toEqual(messages.slice(2))
  })
  it("does not separate historical tool results from their originating request", () => {
    const messages = [user(text(2)), assistant(text(20)), user(text(80)),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] },
      assistant(text(20)), user(text(10))]
    const result = trimReplayHistory(messages, 100)
    expect(result.omittedMessages).toBe(5)
    expect(result.messages.slice(2)).toEqual(messages.slice(6))
  })
  it("keeps the originating request with a live result-only turn", () => {
    const messages = [user(text(2)), assistant(text(200)), user(text(80)),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: text(80) }] }]
    const result = trimReplayHistory(messages, 100)
    expect(result.omittedMessages).toBe(2)
    expect(result.messages.slice(1)).toEqual(messages.slice(2))
  })
  it("estimates Cyrillic higher than equal-length ASCII", () => {
    expect(estimateTokens("я".repeat(100))).toBeGreaterThan(estimateTokens("a".repeat(100)))
  })
  it("counts media, tool payloads and text but not replay-dropped thinking", () => {
    expect(estimateTokens([{ type: "image" }, { type: "document" }, { type: "file" }])).toBe(4800)
    expect(estimateTokens([{ type: "tool_result", content: [{ type: "text", text: "hello" }] }])).toBe(estimateTokens("hello"))
    expect(estimateTokens([{ type: "tool_use", name: "read", input: { path: "a" } }])).toBe(estimateTokens('read{"path":"a"}'))
    expect(estimateTokens([{ type: "thinking", thinking: text(100) }, { type: "redacted_thinking" }])).toBe(0)
    expect(estimateTokens(123)).toBe(estimateTokens("123"))
  })
  it("uses the resolved model's context variant", () => {
    expect(contextWindowFor("opus[1m]")).toBe(1_000_000)
    expect(contextWindowFor("sonnet")).toBe(200_000)
    expect(replayBudgetFor("opus[1m]")).toBe(836_000)
    // Was 116_000 under a flat 64k reserve. That reserve is 32% of a 200k
    // window, which put the budget at 58% of it and dropped history from about
    // 101k real English tokens; the cap lifts this to the same ~80% share the
    // 1M window already had. The extended-context budget is unchanged.
    expect(replayBudgetFor("sonnet")).toBe(160_000)
  })

  it("budgets plain sonnet at 1M when it resolves to Sonnet 5+ (#1212)", () => {
    expect(contextWindowFor("sonnet", "claude-sonnet-5-5")).toBe(1_000_000)
    expect(contextWindowFor("sonnet", "claude-sonnet-5")).toBe(1_000_000)
    expect(replayBudgetFor("sonnet", "claude-sonnet-5-5")).toBe(replayBudgetFor("opus[1m]"))
    expect(replayReserveFor("sonnet", "claude-sonnet-5-5")).toBe(64_000)
    // Sonnet 4.x keeps 200k unless the [1m] tier was selected.
    expect(contextWindowFor("sonnet", "claude-sonnet-4-6")).toBe(200_000)
    expect(replayBudgetFor("sonnet", "claude-sonnet-4-6")).toBe(160_000)
    expect(contextWindowFor("sonnet[1m]", "claude-sonnet-4-6")).toBe(1_000_000)
    // The resolved id only speaks for the sonnet tier.
    expect(contextWindowFor("opus", "claude-sonnet-5-5")).toBe(200_000)
    expect(contextWindowFor("haiku", "claude-sonnet-5-5")).toBe(200_000)
  })

  it("keeps the reserve proportionate to the window", () => {
    expect(replayReserveFor("opus[1m]")).toBe(64_000)
    expect(replayReserveFor("sonnet")).toBe(20_000)
    // The share of the window left for replay must not swing wildly by model.
    for (const model of ["sonnet", "opus[1m]"]) {
      const share = replayBudgetFor(model) / contextWindowFor(model)
      expect(share).toBeGreaterThan(0.75)
      expect(share).toBeLessThan(0.9)
    }
  })

  it("honours the budget override and ignores unusable values", () => {
    const saved = process.env.MERIDIAN_REPLAY_BUDGET_TOKENS
    try {
      process.env.MERIDIAN_REPLAY_BUDGET_TOKENS = "4096"
      expect(replayBudgetFor("sonnet")).toBe(4096)
      expect(replayBudgetFor("opus[1m]")).toBe(4096)
      for (const bad of ["0", "-1", "not-a-number", ""]) {
        process.env.MERIDIAN_REPLAY_BUDGET_TOKENS = bad
        expect(replayBudgetFor("sonnet")).toBe(160_000)
      }
    } finally {
      if (saved === undefined) delete process.env.MERIDIAN_REPLAY_BUDGET_TOKENS
      else process.env.MERIDIAN_REPLAY_BUDGET_TOKENS = saved
    }
  })
})
