import { describe, expect, it } from "bun:test"
import { unstreamedAssistantBlockFrames } from "../proxy/unstreamedAssistant"

describe("complete assistant blocks without SDK stream events", () => {
  it("frames text at the supplied client index", () => {
    const frames = unstreamedAssistantBlockFrames({ type: "text", text: "Ready." }, 3, false)
    expect(frames.map(frame => frame.event)).toEqual([
      "content_block_start", "content_block_delta", "content_block_stop",
    ])
    expect(frames.every(frame => frame.data.index === 3)).toBe(true)
    expect(frames[1]?.data.delta).toEqual({ type: "text_delta", text: "Ready." })
    expect(frames[1]?.textLength).toBe(6)
  })

  it("preserves thinking and its signature only for a client that supports it", () => {
    const block = { type: "thinking", thinking: "Check the input.", signature: "signed" }
    expect(unstreamedAssistantBlockFrames(block, 0, false)).toEqual([])
    const frames = unstreamedAssistantBlockFrames(block, 0, true)
    expect(frames[0]?.data.content_block).toEqual({ type: "thinking", thinking: "", signature: "" })
    expect(frames.slice(1, -1).map(frame => frame.data.delta)).toEqual([
      { type: "thinking_delta", thinking: "Check the input." },
      { type: "signature_delta", signature: "signed" },
    ])
  })

  it("preserves redacted thinking for supported clients and excludes tools", () => {
    const frames = unstreamedAssistantBlockFrames({ type: "redacted_thinking", data: "encrypted" }, 1, true)
    expect(frames.map(frame => frame.event)).toEqual(["content_block_start", "content_block_stop"])
    expect(frames[0]?.data.content_block).toEqual({ type: "redacted_thinking", data: "encrypted" })
    expect(unstreamedAssistantBlockFrames({ type: "tool_use", name: "Read" }, 2, true)).toEqual([])
  })
})
