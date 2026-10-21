import { describe, expect, it } from "bun:test"
import { AG_MAX_PROMPT_BYTES, AntigravityError, agPromptByteLimit, parseAgRequest, renderAgPrompt, renderAgPromptWithinLimit } from "../proxy/backends/antigravityProtocol"

// agy keeps only about 192,000 bytes of one user input step and silently drops the rest, which is the end of the history:
// the newest messages and tool results. Past the limit Meridian shrinks the oldest large content itself instead.
const tools = [{ name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }]
type Hist = { role: string; content: any }[]
const historyOf = (prompt: string) => JSON.parse(prompt.split("Client conversation:\n").at(-1)!) as Hist
const tooLong = (run: () => unknown) => { try { run() } catch (error) { return error } }
/** A finished tool session followed by a new typed question. */
const session = (pairs: number, size: number, fill = "r", question: unknown = "Now summarize everything.") => {
  const messages: unknown[] = [{ role: "user", content: "Inspect the repo." }]
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `call_${i}`, name: "bash", input: { command: `cat part${i}.txt` } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `call_${i}`, content: `RESULT${i}-` + fill.repeat(size) + `-END${i}` }] })
  }
  messages.push({ role: "assistant", content: [{ type: "text", text: "Looked at everything." }] }, { role: "user", content: question })
  return parseAgRequest({ model: "fixture-model", messages, tools })
}
/** One typed request followed by a long tool loop that is still running. */
const agentic = (rounds: number, size: number, lastSize = size) => {
  const messages: unknown[] = [{ role: "user", content: "Read all parts and report." }]
  for (let i = 0; i < rounds; i++) messages.push({ role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "bash", input: { command: `cat part${i}` } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: `RESULT${i}-` + "r".repeat(i === rounds - 1 ? lastSize : size) + `-END${i}` }] })
  return parseAgRequest({ model: "fixture-model", messages, tools })
}
const resultAt = (history: Hist, round: number) => String(history[2 + 2 * round]!.content[0].content)

describe("Antigravity prompt byte limit", () => {
  it("leaves a prompt that fits byte-for-byte unchanged", () => {
    const request = session(3, 1000)
    expect(renderAgPromptWithinLimit(request, [], "\nsuffix")).toBe(renderAgPrompt(request, []) + "\nsuffix")
    expect(renderAgPromptWithinLimit(request, [])).not.toContain("omitted by Meridian")
  })

  it("shrinks the oldest big tool results first, keeps the newest intact and says so before the history", () => {
    const request = session(12, 30_000)
    expect(Buffer.byteLength(renderAgPrompt(request, []))).toBeGreaterThan(AG_MAX_PROMPT_BYTES)
    const prompt = renderAgPromptWithinLimit(request, [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(AG_MAX_PROMPT_BYTES)
    const history = historyOf(prompt)
    expect(resultAt(history, 0)).toMatch(/^RESULT0-[^]*\[\.\.\. \d+ chars omitted by Meridian: Antigravity input limit; re-read if needed \.\.\.\][^]*-END0$/)
    expect(resultAt(history, 11)).toBe(resultAt(request.messages as Hist, 11))
    expect(history.at(-1)!.content).toBe("Now summarize everything.")
    expect(history.map(m => Array.isArray(m.content) ? m.content[0].type : "text")).toEqual(request.messages.map(m => Array.isArray(m.content) ? m.content[0]!.type : "text"))
    expect(prompt.slice(0, prompt.indexOf("Client conversation:"))).toMatch(/omitted the middle .* Re-read anything you still need/)
    const omitted = Array.from({ length: 12 }, (_, i) => i).filter(i => /omitted by Meridian/.test(resultAt(history, i)))
    expect(omitted).toEqual(omitted.map((_, i) => i))
    expect(omitted.length).toBeLessThan(12)
  })

  it("counts UTF-8 bytes, not characters", () => {
    const request = session(10, 7_000, "中")
    expect(renderAgPrompt(request, []).length).toBeLessThan(AG_MAX_PROMPT_BYTES)
    const prompt = renderAgPromptWithinLimit(request, [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(AG_MAX_PROMPT_BYTES)
    expect(prompt).toContain("omitted by Meridian")
  })

  it("takes the limit as an argument, counts the suffix and treats 0 as off", () => {
    const request = session(12, 30_000)
    expect(Buffer.byteLength(renderAgPromptWithinLimit(request, [], "z".repeat(5000), 100_000))).toBeLessThanOrEqual(100_000)
    expect(renderAgPromptWithinLimit(request, [], "", 0)).toBe(renderAgPrompt(request, []))
  })

  it("reads MERIDIAN_AGY_MAX_PROMPT_BYTES and ignores invalid values", () => {
    expect(agPromptByteLimit({})).toBe(AG_MAX_PROMPT_BYTES)
    expect(agPromptByteLimit({ MERIDIAN_AGY_MAX_PROMPT_BYTES: "400000" })).toBe(400_000)
    expect(agPromptByteLimit({ MERIDIAN_AGY_MAX_PROMPT_BYTES: "0" })).toBe(0)
    for (const bad of ["-1", "1.5", "lots", "1e400"]) expect(agPromptByteLimit({ MERIDIAN_AGY_MAX_PROMPT_BYTES: bad })).toBe(AG_MAX_PROMPT_BYTES)
  })

  it("shrinks old tool_use arguments and old long text as well as tool results", () => {
    const messages: unknown[] = [{ role: "user", content: "P".repeat(120_000) }, { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "C".repeat(120_000) } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] }, { role: "assistant", content: [{ type: "text", text: "done" }] }, { role: "user", content: "next question" }]
    const prompt = renderAgPromptWithinLimit(parseAgRequest({ model: "fixture-model", messages, tools }), [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(AG_MAX_PROMPT_BYTES)
    const history = historyOf(prompt)
    expect(history.at(-1)!.content).toBe("next question")
    expect(history[1]!.content[0]).toMatchObject({ type: "tool_use", id: "c1", name: "bash" })
    expect(history[1]!.content[0].input.command).toMatch(/omitted by Meridian/)
  })

  it("in a running tool loop shrinks the oldest rounds and keeps the newest round and the request verbatim", () => {
    const request = agentic(12, 30_000)
    const prompt = renderAgPromptWithinLimit(request, [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(AG_MAX_PROMPT_BYTES)
    const history = historyOf(prompt)
    expect(history[0]!.content).toBe("Read all parts and report.")
    expect(resultAt(history, 0)).toMatch(/omitted by Meridian/)
    expect(resultAt(history, 11)).toBe(resultAt(request.messages as Hist, 11))
    expect(history.at(-2)).toEqual(request.messages.at(-2) as never)
  })

  it("shrinks the newest tool result last, keeping a larger head and tail, instead of failing the turn", () => {
    const request = agentic(3, 100, 260_000)
    const prompt = renderAgPromptWithinLimit(request, [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(AG_MAX_PROMPT_BYTES)
    const newest = resultAt(historyOf(prompt), 2)
    expect(newest).toMatch(/^RESULT2-r{3990}[^]*omitted by Meridian[^]*r{3990}-END2$/)
    expect(historyOf(prompt)[0]!.content).toBe("Read all parts and report.")
  })

  it("shrinks a huge tool result that is the whole continuation", () => {
    // A live process receives only the new messages, as the runtime does for a continuation.
    const full = agentic(1, 300_000)
    const prompt = renderAgPromptWithinLimit({ ...full, messages: full.messages.slice(-1) }, [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(AG_MAX_PROMPT_BYTES)
    expect(historyOf(prompt)[0]!.content[0].content).toMatch(/omitted by Meridian/)
  })

  it("shrinks a huge tool result sent together with the request's text, never the text", () => {
    const messages: unknown[] = [{ role: "user", content: "Read the log." }, { role: "assistant", content: [{ type: "tool_use", id: "log", name: "bash", input: { command: "cat app.log" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "log", content: "L".repeat(260_000) }, { type: "text", text: "Which line failed first?" }] }]
    const prompt = renderAgPromptWithinLimit(parseAgRequest({ model: "fixture-model", messages, tools }), [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(AG_MAX_PROMPT_BYTES)
    const last = historyOf(prompt).at(-1)!.content
    expect(last[0].content).toMatch(/^L{3990}[^]*omitted by Meridian[^]*L{3990}$/)
    expect(last[1]).toEqual({ type: "text", text: "Which line failed first?" })
  })

  it("fails with the 400 prompt-too-long error when the current request alone does not fit", () => {
    const error = tooLong(() => renderAgPromptWithinLimit(session(2, 100, "r", "Q".repeat(300_000)), []))
    expect(error).toBeInstanceOf(AntigravityError)
    expect(error).toMatchObject({ status: 400, type: "invalid_request_error" })
    expect((error as Error).message).toMatch(/prompt is too long: \d+ bytes > 190000/)
  })

  it("shrinks big strings nested in tool_use arguments and keeps keys, shape and other values", () => {
    const input = { path: "a.txt", edits: [{ old: "O".repeat(30_000), new: "N".repeat(30_000), count: 2, flags: { all: true, none: null } }, "short"], meta: { deep: { blob: "B".repeat(30_000) } } }
    const messages: unknown[] = [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "tool_use", id: "x", name: "t", input }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] }, { role: "assistant", content: "done" }, { role: "user", content: "next" }]
    const prompt = renderAgPromptWithinLimit(parseAgRequest({ model: "fixture-model", messages }), [], "", 20_000)
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(20_000)
    const shrunk = historyOf(prompt)[1]!.content[0].input
    expect(shrunk.path).toBe("a.txt")
    expect(shrunk.edits[0].old).toMatch(/omitted by Meridian/)
    expect(shrunk.edits[0]).toMatchObject({ count: 2, flags: { all: true, none: null } })
    expect(shrunk.edits[1]).toBe("short")
    expect(shrunk.meta.deep.blob).toMatch(/omitted by Meridian/)
    expect(Object.keys(shrunk)).toEqual(["path", "edits", "meta"])
  })

  it("never cuts a surrogate pair in half", () => {
    // "x" + 1001 emoji: an odd UTF-16 length puts both 300-unit cut points inside a pair.
    const messages: unknown[] = [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "tool_use", id: "x", name: "t", input: { a: "1" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "x" + "😀".repeat(1001) }] }, { role: "assistant", content: "done" }, { role: "user", content: "next" }]
    const request = parseAgRequest({ model: "fixture-model", messages })
    const prompt = renderAgPromptWithinLimit(request, [], "", Buffer.byteLength(renderAgPrompt(request, [])) - 1500)
    const kept = String(historyOf(prompt)[2]!.content[0].content)
    expect(kept).toMatch(/omitted by Meridian/)
    expect(prompt.isWellFormed()).toBe(true)
    const [head, tail] = kept.split(/\n\[\.\.\. \d+ chars omitted[^\n]*\n/)
    expect(head).toMatch(/^x(😀)+$/u)
    expect(tail).toMatch(/^(😀)+$/u)
  })

  it("leaves images and result flags alone while shrinking the text next to them", () => {
    const image = { type: "image", source: { type: "url", url: "https://example.test/a.png" } }
    const messages: unknown[] = [{ role: "user", content: [{ type: "text", text: "see this" }, image] }, { role: "assistant", content: [{ type: "tool_use", id: "x", name: "t", input: { a: "1" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", is_error: true, content: [image, { type: "text", text: "T".repeat(40_000) }] }] }, { role: "assistant", content: "done" }, { role: "user", content: "next" }]
    const prompt = renderAgPromptWithinLimit(parseAgRequest({ model: "fixture-model", messages }), [], "", 20_000)
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(20_000)
    const history = historyOf(prompt)
    expect(history[0]!.content[1]).toEqual(image)
    expect(history[2]!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "x", is_error: true })
    expect(history[2]!.content[0].content[0]).toEqual(image)
    expect(history[2]!.content[0].content[1].text).toMatch(/omitted by Meridian/)
  })

  it("does not mutate the request", () => {
    const request = session(12, 30_000), before = JSON.stringify(request.messages)
    renderAgPromptWithinLimit(request, [])
    expect(JSON.stringify(request.messages)).toBe(before)
  })
})


for (const kind of ["string", "block"] as const) {
  it(`shrinks older assistant ${kind} text inside the active request before rejecting its completed-result replay`, () => {
    const text = "prior assistant detail ".repeat(10000)
    const messages: unknown[] = [
      { role: "user", content: "Read the sources and write the report." },
      { role: "assistant", content: kind === "string" ? text : [{ type: "text", text }] },
      { role: "assistant", content: [{ type: "tool_use", id: "seed", name: "bash", input: { command: "read the sources" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "seed", content: "sources read" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "latest", name: "bash", input: { command: "write report.md" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "latest", content: "report written" }] },
    ]
    const request = parseAgRequest({ model: "fixture-model", messages, tools })
    const before = JSON.stringify(request.messages)
    const rendered = renderAgPromptWithinLimit(request)
    const history = historyOf(rendered)
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(AG_MAX_PROMPT_BYTES)
    expect(history[0]).toEqual(request.messages[0])
    expect(history.at(-2)).toEqual(request.messages.at(-2))
    expect(history.at(-1)).toEqual(request.messages.at(-1))
    expect(JSON.stringify(history[1])).toContain("omitted by Meridian")
    expect(JSON.stringify(request.messages)).toBe(before)
  })
}
