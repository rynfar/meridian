/**
 * Unit tests for message parsing utilities.
 */
import { describe, it, expect } from "bun:test"
import { normalizeContent, getLastUserMessage, extractAdvisorModel, stripAdvisorTools, stripNonStandardStreamFields, consolidateMultimodalOntoLastUser } from "../proxy/messages"

const img = (id: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: id } })
function userMsg(content: unknown) {
  return { type: "user" as const, message: { role: "user" as const, content }, parent_tool_use_id: null }
}

describe("normalizeContent", () => {
  it("returns string content as-is", () => {
    expect(normalizeContent("hello")).toBe("hello")
  })

  it("extracts text from text content blocks", () => {
    const content = [{ type: "text", text: "hello world" }]
    expect(normalizeContent(content)).toBe("hello world")
  })

  it("handles tool_use blocks", () => {
    const content = [{ type: "tool_use", id: "tu_1", name: "Read", input: { file: "a.ts" } }]
    const result = normalizeContent(content)
    expect(result).toContain("tool_use:tu_1:Read:")
    expect(result).toContain('"file":"a.ts"')
  })

  it("handles tool_result blocks with string content", () => {
    const content = [{ type: "tool_result", tool_use_id: "tu_1", content: "file contents" }]
    const result = normalizeContent(content)
    expect(result).toBe("tool_result:tu_1:file contents")
  })

  it("handles tool_result blocks with object content", () => {
    const content = [{ type: "tool_result", tool_use_id: "tu_1", content: { key: "val" } }]
    const result = normalizeContent(content)
    expect(result).toContain("tool_result:tu_1:")
    expect(result).toContain('"key":"val"')
  })

  it("handles mixed content blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]
    expect(normalizeContent(content)).toBe("hello\nworld")
  })

  it("JSON stringifies unknown block types", () => {
    const content = [{ type: "image", data: "base64" }]
    const result = normalizeContent(content)
    expect(result).toContain('"type":"image"')
  })

  it("produces stable hashes when cache_control is added to text blocks", () => {
    const without = [{ type: "text", text: "hello" }]
    const withCC = [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]
    // text blocks extract only .text, so cache_control is already ignored
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("produces stable hashes when cache_control is added to tool_result content blocks", () => {
    const without = [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "result" }] }]
    const withCC = [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "result", cache_control: { type: "ephemeral" } }] }]
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("produces stable hashes when cache_control is added to unknown block types", () => {
    const without = [{ type: "image", data: "base64" }]
    const withCC = [{ type: "image", data: "base64", cache_control: { type: "ephemeral" } }]
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("converts non-string non-array to string", () => {
    expect(normalizeContent(42)).toBe("42")
    expect(normalizeContent(null)).toBe("null")
    expect(normalizeContent(true)).toBe("true")
  })
})

describe("getLastUserMessage", () => {
  it("returns the last user message", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("second")
  })

  it("returns last message as fallback when no user messages", () => {
    const messages = [
      { role: "assistant", content: "reply" },
    ]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("reply")
  })

  it("handles empty array", () => {
    const result = getLastUserMessage([])
    expect(result).toHaveLength(0)
  })

  it("returns single user message from single-message array", () => {
    const messages = [{ role: "user", content: "only" }]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("only")
  })
})

describe("extractAdvisorModel", () => {
  it("extracts model from advisor tool definition", () => {
    const tools = [
      { name: "Read", description: "Read a file" },
      { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-7" },
    ]
    expect(extractAdvisorModel(tools)).toBe("claude-opus-4-7")
  })

  it("returns undefined when no advisor tool is present", () => {
    const tools = [{ name: "Read" }, { name: "Write" }]
    expect(extractAdvisorModel(tools)).toBeUndefined()
  })

  it("returns undefined for non-array input", () => {
    expect(extractAdvisorModel(undefined)).toBeUndefined()
    expect(extractAdvisorModel(null)).toBeUndefined()
    expect(extractAdvisorModel("not-array")).toBeUndefined()
  })

  it("returns undefined when model is missing or empty", () => {
    expect(extractAdvisorModel([{ type: "advisor_20260301", name: "advisor" }])).toBeUndefined()
    expect(extractAdvisorModel([{ type: "advisor_20260301", name: "advisor", model: "" }])).toBeUndefined()
  })

  it("matches any advisor_ type prefix", () => {
    expect(extractAdvisorModel([{ type: "advisor_20270101", name: "advisor", model: "claude-opus-5" }])).toBe("claude-opus-5")
  })
})

describe("stripAdvisorTools", () => {
  it("removes advisor tool definitions from array", () => {
    const tools = [
      { name: "Read", description: "Read a file" },
      { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-7" },
      { name: "Write", description: "Write a file" },
    ]
    const result = stripAdvisorTools(tools)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ name: "Read", description: "Read a file" })
    expect(result[1]).toEqual({ name: "Write", description: "Write a file" })
  })

  it("returns all tools when no advisor tool is present", () => {
    const tools = [{ name: "Read" }, { name: "Write" }]
    expect(stripAdvisorTools(tools)).toHaveLength(2)
  })

  it("handles empty array", () => {
    expect(stripAdvisorTools([])).toHaveLength(0)
  })
})

describe("stripNonStandardStreamFields (#525)", () => {
  it("removes context_management from a message_delta event", () => {
    const event = {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 12 },
      context_management: { applied_edits: [{ type: "clear_tool_uses_20250919" }] },
    }
    const out = stripNonStandardStreamFields(event) as Record<string, unknown>
    expect(out).not.toHaveProperty("context_management")
    // Everything else must survive untouched.
    expect(out.delta).toEqual({ stop_reason: "end_turn", stop_sequence: null })
    expect(out.usage).toEqual({ output_tokens: 12 })
  })

  it("removes context_management nested inside delta", () => {
    const event = {
      type: "message_delta",
      delta: { stop_reason: "end_turn", context_management: { foo: 1 } },
    }
    const out = stripNonStandardStreamFields(event) as { delta: Record<string, unknown> }
    expect(out.delta).not.toHaveProperty("context_management")
    expect(out.delta.stop_reason).toBe("end_turn")
  })

  it("is a no-op on events without the field (content_block_delta)", () => {
    const event = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }
    const out = stripNonStandardStreamFields(event)
    expect(out).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })
  })

  it("returns non-object inputs unchanged", () => {
    expect(stripNonStandardStreamFields(null)).toBeNull()
    expect(stripNonStandardStreamFields("x" as unknown)).toBe("x")
  })

  it("mutates and returns the same reference (for inline use)", () => {
    const event = { type: "message_delta", context_management: {} }
    expect(stripNonStandardStreamFields(event)).toBe(event)
    expect(event).not.toHaveProperty("context_management")
  })
})

describe("consolidateMultimodalOntoLastUser (#553)", () => {
  it("moves an image from an earlier user turn onto the last user turn", () => {
    const out = consolidateMultimodalOntoLastUser([
      userMsg([{ type: "text", text: "here is the file" }, img("A")]),
      userMsg([{ type: "text", text: "describe it" }]),
    ])
    // Earlier turn keeps its text, loses the image.
    expect(out[0]!.message.content).toEqual([{ type: "text", text: "here is the file" }])
    // Last turn gains the image, keeps its text.
    expect(out[1]!.message.content).toEqual([{ type: "text", text: "describe it" }, img("A")])
  })

  it("targets the last ARRAY-content user turn, not a flattened assistant string", () => {
    const out = consolidateMultimodalOntoLastUser([
      userMsg([img("A")]),
      userMsg([{ type: "text", text: "look" }]),
      userMsg("[Assistant: sure]"), // flattened assistant turn — string content
    ])
    // Image must land on the real user turn (index 1), never appended to a string.
    expect(out[1]!.message.content).toContainEqual(img("A"))
    expect(out[2]!.message.content).toBe("[Assistant: sure]")
    expect(out[0]!.message.content).toEqual([])
  })

  it("does not duplicate an image already present on the last user turn", () => {
    const out = consolidateMultimodalOntoLastUser([
      userMsg([img("A")]),
      userMsg([{ type: "text", text: "again" }, img("A")]),
    ])
    const imgs = (out[1]!.message.content as any[]).filter((b) => b.type === "image")
    expect(imgs).toHaveLength(1)
  })

  it("preserves the order of multiple carried images", () => {
    const out = consolidateMultimodalOntoLastUser([
      userMsg([img("A")]),
      userMsg([img("B")]),
      userMsg([{ type: "text", text: "compare" }]),
    ])
    const imgs = (out[2]!.message.content as any[]).filter((b) => b.type === "image").map((b) => b.source.data)
    expect(imgs).toEqual(["A", "B"])
  })

  it("is a no-op with fewer than two array-content user turns", () => {
    const input = [userMsg([{ type: "text", text: "hi" }, img("A")])]
    expect(consolidateMultimodalOntoLastUser(input)).toEqual(input)
  })

  it("does not mutate the input array or its messages", () => {
    const input = [userMsg([img("A")]), userMsg([{ type: "text", text: "x" }])]
    const snapshot = JSON.parse(JSON.stringify(input))
    consolidateMultimodalOntoLastUser(input)
    expect(input).toEqual(snapshot)
  })
})
