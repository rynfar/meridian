import { expect, it } from "bun:test"
import { parseAgRequest, renderAgPrompt } from "../proxy/backends/antigravityProtocol"

function prefix(prompt: string): string {
  return prompt.slice(0, prompt.lastIndexOf("Client conversation:\n"))
}

for (const structured of [false, true]) {
  it(`keeps the added work recap bounded when an assistant reply is large (structured=${structured})`, () => {
    const messages = [
      { role: "user", content: "Continue the requested analysis." },
      { role: "assistant", content: structured ? [{ type: "text", text: "a".repeat(200_000) }] : "a".repeat(200_000) },
      { role: "assistant", content: [{ type: "tool_use", id: "read1", name: "read", input: { path: "report.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read1", content: "ready" }] },
    ]
    const request = parseAgRequest({ model: "fixture-model", messages })
    const prompt = renderAgPrompt(request)
    expect(JSON.parse(prompt.split("Client conversation:\n").at(-1)!)).toEqual(request.messages)
    // A single call/result plus one large answer should not copy that answer
    // into a second unbounded history; the complete history is already intact.
    expect(prefix(prompt).length).toBeLessThan(16_000)
  })
}

it("retains the current tool target when a large content argument precedes the path", () => {
  const request = parseAgRequest({ model: "fixture-model", messages: [
    { role: "user", content: "Apply the proposed edit." },
    { role: "assistant", content: [{ type: "tool_use", id: "write1", name: "write", input: { content: "x".repeat(100_000), file_path: "/fixture/actual-target.txt" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "write1", content: "done" }] },
  ] })
  const prompt = renderAgPrompt(request)
  const added = prefix(prompt).split("Since this request:\n")[1]!
  expect(added).toContain("/fixture/actual-target.txt")
  expect(JSON.parse(prompt.split("Client conversation:\n").at(-1)!)).toEqual(request.messages)
})

function recap(prompt: string): { line: string; messages: Array<{ role: string; content: unknown }> } {
  const line = prefix(prompt).split("Since this request:\n")[1]?.split("\n")[0]
  if (!line) throw new Error("fixture recap missing")
  return { line, messages: JSON.parse(line) }
}

function recapBlocks(messages: Array<{ content: unknown }>): Array<Record<string, unknown>> {
  return messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
}

it("bounds total recent work by selecting complete latest call/result batches", () => {
  const messages: unknown[] = [{ role: "user", content: "Continue the report." }]
  for (let index = 0; index < 120; index++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `recent-${index}`, name: "read", input: { path: `file-${index}.txt` } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: `recent-${index}`, content: "r".repeat(150) }] })
  }
  const request = parseAgRequest({ model: "fixture-model", messages })
  const prompt = renderAgPrompt(request)
  const projected = recap(prompt)
  expect(projected.line.length).toBeLessThanOrEqual(4000)
  expect(prefix(prompt)).toContain("recap omits")
  expect(prefix(prompt)).not.toContain("prior tool work is done")
  const blocks = recapBlocks(projected.messages)
  const calls = blocks.filter(block => block.type === "tool_use")
  const results = blocks.filter(block => block.type === "tool_result")
  expect(calls.at(-1)?.id).toBe("recent-119")
  expect(JSON.stringify(calls.at(-1))).toContain("file-119.txt")
  expect(results.map(result => result.tool_use_id)).toEqual(calls.map(call => call.id))
  expect(prompt.split("Client conversation:\n").at(-1)).toBe(JSON.stringify(request.messages))
})

it("keeps parallel call/result identity and error flags when falling back to a compact batch", () => {
  const calls = Array.from({ length: 8 }, (_, index) => ({ type: "tool_use", id: `parallel-${index}`, name: "write", input: { content: "c".repeat(10000), file_path: `/fixture/target-${index}.txt` } }))
  const results = calls.map((call, index) => ({ type: "tool_result", tool_use_id: call.id, is_error: index === 3, content: "r".repeat(2000) }))
  const request = parseAgRequest({ model: "fixture-model", messages: [{ role: "user", content: "Apply these edits." }, { role: "assistant", content: calls }, { role: "user", content: results }] })
  const prompt = renderAgPrompt(request)
  const projected = recap(prompt)
  expect(projected.line.length).toBeLessThanOrEqual(4000)
  const projectedBlocks = recapBlocks(projected.messages)
  expect(projectedBlocks.filter(block => block.type === "tool_use").map(block => block.id)).toEqual(calls.map(call => call.id))
  expect(projectedBlocks.filter(block => block.type === "tool_result").map(block => block.tool_use_id)).toEqual(calls.map(call => call.id))
  expect(projectedBlocks.find(block => block.tool_use_id === "parallel-3")?.is_error).toBe(true)
  for (let index = 0; index < 8; index++) expect(projected.line).toContain(`/fixture/target-${index}.txt`)
  expect(prefix(prompt)).not.toContain("prior tool work is done")
  expect(prompt.split("Client conversation:\n").at(-1)).toBe(JSON.stringify(request.messages))
})

it("omits oversized identities as whole batches instead of clipping IDs into false pairings", () => {
  const ids = ["i".repeat(10000) + "A", "i".repeat(10000) + "B"]
  const messages: unknown[] = [{ role: "user", content: "Continue." }]
  for (const id of ids) messages.push({ role: "assistant", content: [{ type: "tool_use", id, name: "read", input: { path: "fixture.txt" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] })
  const request = parseAgRequest({ model: "fixture-model", messages })
  const prompt = renderAgPrompt(request)
  expect(recap(prompt).line.length).toBeLessThanOrEqual(4000)
  expect(recapBlocks(recap(prompt).messages)).toHaveLength(0)
  expect(prefix(prompt)).toContain("recap omits")
  expect(prefix(prompt)).not.toContain("prior tool work is done")
  expect(prompt.split("Client conversation:\n").at(-1)).toBe(JSON.stringify(request.messages))
})

it("does not advertise an unmatched tool call as completed in a defensive renderer-only control", () => {
  const request = parseAgRequest({ model: "fixture-model", messages: [{ role: "user", content: "Continue." }] })
  // The public parser rejects this incomplete history. This control exercises
  // only the pure renderer's wording if an internal caller supplies it.
  request.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "pending-1", name: "read", input: { path: "fixture.txt" } }] })
  const prompt = renderAgPrompt(request)
  expect(prefix(prompt)).toContain("pending")
  expect(prefix(prompt)).not.toContain("prior tool work is done")
  expect(recapBlocks(recap(prompt).messages).at(-1)?.id).toBe("pending-1")
})

it("retains ordinary unsuccessful tool results without implying the action succeeded", () => {
  const request = parseAgRequest({ model: "fixture-model", messages: [{ role: "user", content: "Write the file." }, { role: "assistant", content: [{ type: "tool_use", id: "failed-write", name: "write", input: { path: "file.txt", content: "safe fixture" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "failed-write", is_error: true, content: "permission denied" }] }] })
  const prompt = renderAgPrompt(request)
  const blocks = recapBlocks(recap(prompt).messages)
  expect(blocks.find(block => block.tool_use_id === "failed-write")).toMatchObject({ is_error: true })
  expect(prefix(prompt)).toContain("errors")
  expect(prefix(prompt)).not.toContain("prior tool work is done")
})

it("bounds raw media representations without changing full history (pure defense, not runtime attachment selection)", () => {
  const request = parseAgRequest({ model: "fixture-model", messages: [{ role: "user", content: "Continue." }, { role: "assistant", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "a".repeat(200000) } }] }, { role: "user", content: [{ type: "text", text: "" }] }] })
  const prompt = renderAgPrompt(request)
  expect(recap(prompt).line.length).toBeLessThanOrEqual(4000)
  expect(prefix(prompt)).not.toContain("a".repeat(500))
  expect(prompt.split("Client conversation:\n").at(-1)).toBe(JSON.stringify(request.messages))
})
