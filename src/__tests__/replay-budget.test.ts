import { describe, expect, it } from "bun:test"
import { contextWindowFor, estimateTokens, replayBudgetFor, trimReplayHistory } from "../proxy/replayBudget"

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
    expect(replayBudgetFor("sonnet")).toBe(116_000)
  })
})
