import { describe, expect, it } from "bun:test"
import { parseAgRequest, renderAgPrompt } from "../proxy/backends/antigravityProtocol"

// Long, tool-heavy histories drowned the newest user message at the end of one huge JSON blob: Gemini kept running the
// earlier task instead of answering. The latest request is now stated before the history and repeated right before it.
const longHistory = (question: unknown, endWithToolCall = false, newTask?: string) => {
  const messages: unknown[] = [{ role: "user", content: "Inspect the router and list its inbounds." }]
  for (let i = 0; i < 40; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `call_${i}`, name: "bash", input: { command: `cat part${i}.json` } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `call_${i}`, content: "x".repeat(2000) }] })
  }
  if (newTask) messages.push({ role: "assistant", content: [{ type: "text", text: "Done: 20 shadowsocks and 55 socks inbounds." }] }, { role: "user", content: newTask })
  messages.push(endWithToolCall
    ? { role: "assistant", content: [{ type: "tool_use", id: "call_last", name: "bash", input: { command: "cat summary.json" } }] }
    : { role: "assistant", content: [{ type: "text", text: "Done: 20 shadowsocks and 55 socks inbounds." }] })
  messages.push({ role: "user", content: question })
  return parseAgRequest({ model: "fixture-model", messages, tools: [{ name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }] })
}

describe("Antigravity prompt keeps the latest user request in focus", () => {
  it("states the latest user text at the top and again right before the history, which stays last", () => {
    const prompt = renderAgPrompt(longHistory("New question: what is 17 times 3?"))
    const history = prompt.indexOf("Client conversation:")
    const preamble = prompt.slice(0, history)
    expect(history).toBeGreaterThan(0)
    // Stated at the top, and again in the reminder that sits right before the history.
    expect(preamble.indexOf("Current request:")).toBeLessThan(preamble.indexOf("The JSON below"))
    expect(preamble.match(/New question: what is 17 times 3\?/g)).toHaveLength(2)
    expect(preamble.lastIndexOf("Answer this; prior tool work is done")).toBeGreaterThan(preamble.indexOf("Client system instructions:"))
    // The history is still the last, intact JSON value.
    expect(JSON.parse(prompt.split("Client conversation:\n").at(-1)!)).toHaveLength(83)
  })

  it("collects text blocks of the latest user message, including steering text sent next to tool results", () => {
    const request = longHistory([{ type: "tool_result", tool_use_id: "call_last", content: "ok" }, { type: "text", text: "Stop that. Answer: 2+2?" }], true)
    const prompt = renderAgPrompt(request)
    expect(prompt.indexOf("Stop that. Answer: 2+2?")).toBeLessThan(prompt.indexOf("Client conversation:"))
  })

  it("keeps the newest typed request in focus when the history is replayed with a pure tool-result tail", () => {
    // A new user turn that started a tool call; its result comes back as a stateless replay of the whole history.
    const request = longHistory([{ type: "tool_result", tool_use_id: "call_last", content: "ok" }], true, "Create done.txt containing ok.")
    const prompt = renderAgPrompt(request)
    const preamble = prompt.slice(0, prompt.indexOf("Client conversation:"))
    expect(preamble.match(/Create done\.txt containing ok\./g)).toHaveLength(2)
    // The work already done for that request is quoted next to it, so the model continues instead of redoing it.
    const since = JSON.parse(preamble.split("Since this request:\n")[1]!.split("\n")[0]!)
    expect(since.map((m: { role: string }) => m.role)).toEqual(["assistant", "user"])
    expect(since[0].content[0]).toMatchObject({ type: "tool_use", id: "call_last" })
    expect(since[1].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_last" })
    expect(JSON.parse(prompt.split("Client conversation:\n").at(-1)!)).toEqual(request.messages)
  })

  it("caps quoted tool results so restating the current work stays cheap", () => {
    const request = longHistory([{ type: "tool_result", tool_use_id: "call_last", content: "y".repeat(50_000) }], true, "Summarize the file.")
    const added = renderAgPrompt(request).split("Answer this; prior tool work is done")[1]!.split("Client conversation:")[0]!
    expect(added.length).toBeLessThan(600)
  })

  it("restates a large pasted request as head and tail only, so the prompt does not triple it", () => {
    const paste = "LOGSTART " + "z".repeat(200_000) + " Question at the end: why did it fail?"
    const request = longHistory(paste)
    const prompt = renderAgPrompt(request)
    const preamble = prompt.slice(0, prompt.indexOf("Client conversation:"))
    expect(preamble.length).toBeLessThan(prompt.length - 200_000)
    expect(preamble.match(/LOGSTART/g)).toHaveLength(2)
    expect(preamble.match(/Question at the end: why did it fail\?/g)).toHaveLength(2)
    expect(preamble).toContain("chars omitted; full text is in the client conversation below")
    expect(JSON.parse(prompt.split("Client conversation:\n").at(-1)!)).toEqual(request.messages)
  })

  it("caps tool inputs already sent for the current request, such as a large file write", () => {
    const messages = [
      { role: "user", content: "Write the report." },
      { role: "assistant", content: [{ type: "tool_use", id: "w1", name: "write", input: { path: "report.md", content: "r".repeat(100_000) } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: "ok" }] },
    ]
    const request = parseAgRequest({ model: "fixture-model", messages, tools: [{ name: "write", input_schema: { type: "object" } }] })
    const added = renderAgPrompt(request).split("Answer this; prior tool work is done")[1]!.split("Client conversation:")[0]!
    expect(added).toContain("report.md")
    expect(added.length).toBeLessThan(800)
  })

  it("lists earlier tool calls as name and target only, capped, so the model can recall what it did", () => {
    const prompt = renderAgPrompt(longHistory("Which files did you read?"))
    const log = prompt.split("Tool calls before this request, oldest first: ")[1]!.split("\n\n")[0]!
    expect(log).toStartWith("bash cat part0.json; bash cat part1.json")
    expect(log).toContain("bash cat part39.json")
    expect(log).not.toContain("xxxx")
    expect(log.length).toBeLessThanOrEqual(4000)
  })

  it("logs the target of a tool call, not its first argument, when content comes first", () => {
    // Captured from DeepSeek Harness + Gemini: write arrives as {content, file_path}. Logging the first value recorded
    // "write ok", and the model then claimed it had created a file named "ok".
    const messages = [
      { role: "user", content: "Create done.txt containing ok." },
      { role: "assistant", content: [{ type: "tool_use", id: "w1", name: "write", input: { content: "ok", file_path: "/w/done.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: "created" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "bash", input: { description: "Delete it", command: "rm /w/done.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "x1", name: "lookup", input: { key: "receipt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "user", content: "Which files did you create or delete?" },
    ]
    const prompt = renderAgPrompt(parseAgRequest({ model: "fixture-model", messages }))
    const log = prompt.split("Tool calls before this request, oldest first: ")[1]!.split("\n\n")[0]!
    expect(log).toBe("write /w/done.txt; bash rm /w/done.txt; lookup receipt")
  })

  it("leaves a short first-turn prompt unchanged apart from the request header", () => {
    const request = parseAgRequest({ model: "fixture-model", messages: [{ role: "user", content: "hello" }] })
    const prompt = renderAgPrompt(request)
    expect(prompt).toContain(JSON.stringify(request.messages))
    expect(prompt.match(/hello/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
