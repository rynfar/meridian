import { describe, expect, it } from "bun:test"
import { flattenAssistantContent, normalizeStructuredUserContent, replayToolResultHeader, frameStructuredReplay } from "../proxy/replay"

const call = { type: "tool_use", id: "call-one", name: "write", input: { path: "a.txt", content: "complete\ncontents" } }
const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "pixels" } }

describe("faithful tool history rendering", () => {
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
    expect(source).toEqual(before)
    expect(JSON.stringify(frameStructuredReplay(source, false))).not.toContain("<conversation_history>")
    expect(frameStructuredReplay(source.slice(0, 1))).toEqual(source.slice(0, 1))
  })
})
