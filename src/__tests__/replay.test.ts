import { describe, expect, it } from "bun:test"
import { flattenAssistantContent, normalizeStructuredUserContent, replayToolResultHeader, frameStructuredReplay, coalesceStructuredUserMessages, coalesceTrailingSystemReminders, layoutReplayBlocks, type ReplayPart } from "../proxy/replay"
import { frameReplayTurns } from "../proxy/messages"

describe("trailing system reminders in a live user turn", () => {
  it("keeps earlier history and combines multiple terminal reminders in order without editing input", () => {
    const messages = Object.freeze([
      Object.freeze({ role: "system", content: "EARLIER_METADATA" }),
      Object.freeze({ role: "user", content: "EARLIER_USER" }),
      Object.freeze({ role: "assistant", content: "EARLIER_ANSWER" }),
      Object.freeze({ role: "user", content: "CURRENT_USER" }),
      Object.freeze({ role: "system", content: "FIRST_REMINDER" }),
      Object.freeze({ role: "system", content: "SECOND_REMINDER" }),
    ])
    const before = JSON.stringify(messages)
    expect(coalesceTrailingSystemReminders(messages)).toEqual([
      ...messages.slice(0, 3), { role: "user", content: "CURRENT_USER\n\nFIRST_REMINDER\n\nSECOND_REMINDER" },
    ])
    expect(JSON.stringify(messages)).toBe(before)
  })

  it("keeps current media and a completed tool result in the current turn, ahead of reminder text", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } }
    const result = { type: "tool_result", tool_use_id: "current-call", content: "CURRENT_RESULT" }
    const messages = [
      { role: "user", content: [image, result] },
      { role: "system", content: "CURRENT_REMINDER" },
    ]
    const merged = coalesceTrailingSystemReminders(messages)
    expect(merged).toEqual([{ role: "user", content: [image, result, { type: "text", text: "CURRENT_REMINDER" }] }])
    const framed = frameStructuredReplay(merged.map(message => ({ message: { content: message.content } })))
    expect(framed).toHaveLength(1)
    expect(JSON.stringify(framed)).not.toContain("Historical image")
    expect(JSON.stringify(framed)).not.toContain("<conversation_history>")
    expect(messages[0]!.content).toEqual([image, result])
  })

  it("leaves assistant-ending history, system-only input, and middle reminders alone", () => {
    for (const messages of [
      [{ role: "user", content: "BEFORE" }, { role: "assistant", content: "ANSWER" }, { role: "system", content: "METADATA" }],
      [{ role: "system", content: "METADATA" }],
      [{ role: "user", content: "BEFORE" }, { role: "system", content: "METADATA" }, { role: "user", content: "CURRENT" }],
    ]) expect(coalesceTrailingSystemReminders(messages)).toEqual(messages)
  })
})

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

  it("renders client tool-change blocks as text, since user turns reject them", () => {
    const content = [
      { type: "tool_addition", name: "grep" },
      { type: "tool_removal", tool: { name: "bash" } },
    ]
    expect(normalizeStructuredUserContent(content)).toEqual([
      { type: "text", text: "[Client added tool: grep]" },
      { type: "text", text: "[Client removed tool: bash]" },
    ])
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

describe("cache-friendly replay layout", () => {
  const part = (text: string, clientMarked = false): ReplayPart => ({ text, clientMarked })
  const joined = (turns: Array<{ role: string; parts: ReplayPart[] }>) =>
    frameReplayTurns(turns.map(t => ({ role: t.role, text: t.parts.map(p => p.text).filter(Boolean).join("\n") })))
  const text = (blocks: ReturnType<typeof layoutReplayBlocks>) => blocks.map(b => b.text).join("")
  const marked = (blocks: ReturnType<typeof layoutReplayBlocks>) => blocks.flatMap((b, i) => b.cache_control ? [i] : [])
  // Working history whose last assistant turn the client marked, then a
  // caption appended to the tool result of the live turn.
  const caption = (steps: number, captionText: string) => {
    const turns: Array<{ role: string; parts: ReplayPart[] }> = [{ role: "user", parts: [part("Read the files.")] }]
    for (let i = 1; i <= steps; i++) {
      turns.push({ role: "assistant", parts: [part(`[Assistant: Read f${i}]`, i === steps)] })
      if (i < steps) turns.push({ role: "user", parts: [part(`result ${i}`)] })
    }
    turns.push({ role: "user", parts: [part(`result ${steps}`), part(captionText)] })
    return turns
  }

  it("renders exactly the text of the single-string replay", () => {
    const framed = caption(3, "Describe...")
    expect(text(layoutReplayBlocks(framed))).toBe(joined(framed))
    const single = [{ role: "user", parts: [part("<transcript>"), part("", true), part("step", true), part("action", true)] }]
    expect(text(layoutReplayBlocks(single))).toBe(joined(single))
    const assistantLast = [{ role: "user", parts: [part("q")] }, { role: "assistant", parts: [part("a")] }]
    expect(text(layoutReplayBlocks(assistantLast))).toBe(joined(assistantLast))
  })

  it("marks the client's history breakpoint and keeps that prefix when the tail changes or history grows", () => {
    const first = layoutReplayBlocks(caption(3, "Describe..."))
    const [at] = marked(first)
    expect(marked(first)).toHaveLength(1)
    expect(first[at!]!.text).toContain("Read f3")
    const strip = (bs: typeof first) => bs.map(({ cache_control: _cc, ...b }) => b)
    for (const next of [layoutReplayBlocks(caption(3, "Previous: changed")), layoutReplayBlocks(caption(6, "Previous: grown"))]) {
      expect(strip(next).slice(0, at! + 1)).toEqual(strip(first).slice(0, at! + 1))
    }
  })

  it("marks the boundary before the classifier's volatile action in the live turn", () => {
    const classifier = (steps: number) => [
      { role: "user", parts: [part("CLAUDE.md", true)] },
      { role: "user", parts: [part("<transcript>"), ...Array.from({ length: steps }, (_, i) => part(`step ${i}`, i === steps - 1)), part("new action", true), part("</transcript>"), part("Err on the side of blocking.")] },
    ]
    const blocks = layoutReplayBlocks(classifier(2))
    expect(marked(blocks)).toEqual([3])
    expect(blocks[3]!.text).toBe("\nstep 1")
    expect(blocks.slice(0, 4).map(b => b.text)).toEqual(layoutReplayBlocks(classifier(4)).slice(0, 4).map(b => b.text))
  })

  // Shaped like Claude Code's auto-mode classifier: an optional CLAUDE.md
  // message (marked), then the transcript. The last transcript entry and the
  // action under review are marked; the closing instruction is not. Default
  // mode sends transcript and instruction as one message; segmented mode sends
  // one message per transcript block and the instruction on its own. An action
  // reviewed in call N is a transcript entry in call N+1.
  const classifierCall = (entries: string[], action: string, segmented: boolean, claudeMd = true) => {
    const body = [part("<transcript>"), ...entries.map((e, i) => part(e, i === entries.length - 1)), part(action, true), part("</transcript>")]
    const user = (parts: ReplayPart[]) => ({ role: "user", parts })
    return [
      ...(claudeMd ? [user([part("CLAUDE.md", true)])] : []),
      ...(segmented
        ? [...body.map(p => user([p])), user([part("Err on the side of blocking.")])]
        : [user([...body, part("Err on the side of blocking.")])]),
    ]
  }
  const strip = (bs: ReturnType<typeof layoutReplayBlocks>) => bs.map(({ cache_control: _cc, ...b }) => b)

  for (const segmented of [false, true]) for (const claudeMd of [true, false]) {
    it(`marks the classifier's transcript end, not the action (${segmented ? "segmented" : "default"}, ${claudeMd ? "with" : "without"} CLAUDE.md)`, () => {
      const first = layoutReplayBlocks(classifierCall(["entry 1", "entry 2"], "action A", segmented, claudeMd))
      expect(marked(first)).toHaveLength(1)
      const at = marked(first)[0]!
      expect(first[at]!.text).toContain("entry 2")
      // Next call: action A is now a transcript entry, more work follows.
      const next = layoutReplayBlocks(classifierCall(["entry 1", "entry 2", "action A", "entry 3", "entry 4"], "action B", segmented, claudeMd))
      expect(strip(next).slice(0, at + 1)).toEqual(strip(first).slice(0, at + 1))
      expect(next[marked(next)[0]!]!.text).toContain("entry 4")
    })
  }

  it("keeps the prefix of a caption sent as its own user message after the marked assistant reply", () => {
    // The client marks the last block of the message before the caption.
    const history = (n: number) => Array.from({ length: n }, (_, i) => [
      { role: "user", parts: [part(`request ${i}`)] },
      { role: "assistant", parts: [part(`[Assistant: reply ${i}]`)] },
    ]).flat()
    const call = (n: number, captionText: string) => {
      const turns = history(n)
      turns[turns.length - 1] = { role: "assistant", parts: [part(`[Assistant: reply ${n - 1}]`, true)] }
      return [...turns, { role: "user", parts: [part(captionText)] }]
    }
    const first = layoutReplayBlocks(call(3, "Describe..."))
    const at = marked(first)[0]!
    expect(first[at]!.text).toContain("reply 2")
    for (const next of [call(3, "Previous: x"), call(6, "Previous: y")]) {
      expect(strip(layoutReplayBlocks(next)).slice(0, at + 1)).toEqual(strip(first).slice(0, at + 1))
    }
  })

  it("falls back to the end of the history without client markers, and to no marker without history", () => {
    const turns = [{ role: "user", parts: [part("q1")] }, { role: "assistant", parts: [part("a1")] }, { role: "user", parts: [part("caption")] }]
    expect(marked(layoutReplayBlocks(turns))).toEqual([1])
    expect(marked(layoutReplayBlocks([{ role: "user", parts: [part("only"), part("tail", true)] }]))).toEqual([])
  })
})
