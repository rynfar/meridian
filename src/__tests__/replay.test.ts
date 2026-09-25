import { describe, expect, it } from "bun:test"
import { flattenAssistantContent, normalizeStructuredUserContent, replayToolResultHeader, frameStructuredReplay, coalesceStructuredUserMessages } from "../proxy/replay"

const call = { type: "tool_use", id: "call-one", name: "write", input: { path: "a.txt", content: "complete\ncontents" } }
const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "pixels" } }
const textOf = (block: unknown): string =>
  block !== null && typeof block === "object" && "text" in block && typeof block.text === "string"
    ? block.text : ""

describe("faithful tool history rendering", () => {
  it("delivers a complete resume delta atomically without changing native results, media or input", () => {
    const result = { type: "tool_result", tool_use_id: "a", is_error: true, content: "actual failure" }
    const source: Array<{ message: { content: unknown } }> = [
      { message: { content: [result, image] } }, { message: { content: "final question" } },
    ]
    const before = structuredClone(source)
    expect(coalesceStructuredUserMessages(source)).toEqual([
      { message: { content: [result, image, { type: "text", text: "final question" }] } },
    ])
    expect(source).toEqual(before)
    expect(coalesceStructuredUserMessages([])).toEqual([])
    const single = source.slice(0, 1)
    expect(coalesceStructuredUserMessages(single)).toBe(single)
  })

  it("retains every call, argument and identity when an assistant turn has no text", () => {
    const second = { ...call, id: "call-two", input: { path: "b.txt", content: "x".repeat(1000) } }
    const rendered = flattenAssistantContent([{ type: "thinking", thinking: "private", signature: "opaque" }, call, second])
    for (const item of [call, second]) {
      expect(rendered).toContain(item.id)
      expect(rendered).toContain(item.name)
      expect(rendered).toContain(JSON.stringify(item.input))
    }
    expect(rendered).not.toContain("private")
    expect(rendered).not.toContain("opaque")
  })

  it("keeps assistant text and calls in their original order", () => {
    const rendered = flattenAssistantContent([{ type: "text", text: "before" }, call, { type: "text", text: "after" }])
    expect(rendered.indexOf("before")).toBeLessThan(rendered.indexOf(call.id))
    expect(rendered.indexOf(call.id)).toBeLessThan(rendered.indexOf("after"))
    expect(flattenAssistantContent("plain assistant answer")).toBe("plain assistant answer")
  })

  it("renders an earlier call with its registered SDK name only when requested", () => {
    const history = [call]
    expect(flattenAssistantContent(history)).toContain('"name":"write"')
    expect(flattenAssistantContent(history, name => `mcp__oc__${name}`)).toContain('"name":"mcp__oc__write"')
    expect(call.name).toBe("write")
  })

  it("distinguishes successful and failed results even if their payloads match", () => {
    expect(replayToolResultHeader({ tool_use_id: "a", is_error: true })).toContain('"is_error":true')
    expect(replayToolResultHeader({ tool_use_id: "a" })).toContain('"is_error":false')
  })

  it("renders fresh results without orphan wrappers and keeps nested media", () => {
    const content = [{ type: "tool_result", tool_use_id: call.id, is_error: true, content: [
      { type: "text", text: "failed output" }, image,
    ] }]
    const rendered = normalizeStructuredUserContent(content)
    expect(JSON.stringify(rendered)).toContain(call.id)
    expect(rendered).toContainEqual(image)
    expect(rendered).toContainEqual({ type: "text", text: "failed output" })
    expect(JSON.stringify(rendered)).not.toContain('"type":"tool_result"')
    expect(content[0]!.type).toBe("tool_result")
  })

  it("preserves exact native results at a real SDK tool checkpoint", () => {
    const content = [{ type: "tool_result", tool_use_id: call.id, is_error: false,
      content: [{ type: "text", text: "actual result" }, image] }]
    expect(normalizeStructuredUserContent(content, true)).toEqual(content)
  })

  it("keeps non-tool user blocks and strings unchanged", () => {
    expect(normalizeStructuredUserContent("hello")).toBe("hello")
    const content = [{ type: "text", text: "hello" }, image]
    expect(normalizeStructuredUserContent(content)).toEqual(content)
  })

  it("frames multimodal history before the live turn without changing images or the source", () => {
    const source = [{ message: { content: "earlier question" } }, { message: { content: [image, { type: "text", text: "live question" }] } }]
    const before = structuredClone(source)
    const framed = frameStructuredReplay(source)
    expect(framed).toHaveLength(1)
    expect(JSON.stringify(framed[0]!.message.content)).toContain("<conversation_history>")
    expect(JSON.stringify(framed[0]!.message.content)).toContain("</conversation_history>")
    expect(framed[0]!.message.content).toContainEqual(image)
    expect(JSON.stringify(framed)).not.toContain("attachment provenance")
    expect(source).toEqual(before)
    expect(JSON.stringify(frameStructuredReplay(source, false))).not.toContain("<conversation_history>")
    expect(JSON.stringify(frameStructuredReplay(source, false))).not.toContain("Historical image")
    expect(frameStructuredReplay(source.slice(0, 1))).toEqual(source.slice(0, 1))
  })

  it("attributes historical media without labelling the current user's attachment", () => {
    const document = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "prior" } }
    const file = { type: "file", source: { type: "base64", media_type: "text/plain", data: "prior" } }
    const currentImage = { ...image, source: { ...image.source, data: "current" } }
    const source = [
      { message: { content: [{ type: "text", text: "old screenshot" }, image, document, file] } },
      { message: { content: "[Assistant: I captured the screenshot]" } },
      { message: { content: [{ type: "text", text: "current request" }, currentImage] } },
    ]
    const before = structuredClone(source)
    const blocks = frameStructuredReplay(source)[0]!.message.content
    expect(Array.isArray(blocks)).toBe(true)
    if (!Array.isArray(blocks)) throw new Error("expected structured replay")
    for (const historical of [image, document, file]) {
      const index = blocks.indexOf(historical)
      expect(index).toBeGreaterThan(0)
      expect(textOf(blocks[index - 1])).toContain(`Historical ${historical.type}`)
      expect(textOf(blocks[index - 1])).toContain("not an attachment to the current user message")
    }
    const closeIndex = blocks.findIndex(block => textOf(block).includes("</conversation_history>"))
    const currentIndex = blocks.indexOf(currentImage)
    expect(closeIndex).toBeGreaterThan(blocks.indexOf(file))
    expect(textOf(blocks[closeIndex])).toContain("not attachments to the user's current message")
    expect(currentIndex).toBeGreaterThan(closeIndex)
    expect(blocks[currentIndex - 1]).toEqual({ type: "text", text: "current request" })
    expect(textOf(blocks.at(-1))).toContain("current client turn contains exactly 1 image, 0 documents, and 0 files")
    expect(textOf(blocks.at(-1))).toContain("Earlier replayed turns contain 1 image, 1 document, and 1 file")
    expect(source).toEqual(before)
  })
})
