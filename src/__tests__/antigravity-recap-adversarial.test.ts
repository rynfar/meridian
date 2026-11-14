import { expect, it } from "bun:test"
import { parseAgRequest, renderAgPrompt } from "../proxy/backends/antigravityProtocol"

function inspect(messages: unknown[]) {
  const request = parseAgRequest({ model: "fixture-model", messages })
  const prompt = renderAgPrompt(request)
  const marker = "Client conversation:\n"
  const at = prompt.lastIndexOf(marker)
  expect(prompt.slice(at + marker.length)).toBe(JSON.stringify(request.messages))
  expect(JSON.parse(prompt.slice(at + marker.length))).toEqual(request.messages)
  return prompt.slice(0, at)
}

it("bounds an assistant explanation while retaining the complete authoritative history", () => {
  const prefix = inspect([
    { role: "user", content: "Inspect the report and summarize." },
    { role: "assistant", content: [{ type: "text", text: "x".repeat(200000) }, { type: "tool_use", id: "read-1", name: "read", input: { file_path: "/work/report.md" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "report bytes" }] },
  ])
  expect(prefix.length).toBeLessThan(15000)
})

it("retains a completed write target when the large content argument precedes its path", () => {
  const prefix = inspect([
    { role: "user", content: "Write the final report." },
    { role: "assistant", content: [{ type: "tool_use", id: "write-1", name: "write", input: { content: "x".repeat(100000), file_path: "/work/final-report.md" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "write-1", content: "created" }] },
  ])
  expect(prefix.split("Since this request:\n")[1]).toContain("/work/final-report.md")
})

it("bounds many completed call/result batches and retains the latest paired identities", () => {
  const messages: unknown[] = [{ role: "user", content: "Update these reports, then summarize." }]
  for (let i = 0; i < 80; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `call-${i}`, name: "write", input: { file_path: `/work/report-${i}.md`, content: "x".repeat(1000) } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `call-${i}`, content: "created" }] })
  }
  const prefix = inspect(messages)
  expect(prefix.length).toBeLessThan(15000)
  const work = prefix.split("Since this request:\n")[1]!
  expect(work).toContain('"id":"call-79"')
  expect(work).toContain('"tool_use_id":"call-79"')
})

it("distinguishes long common-parent targets by preserving their file names", () => {
  const parent = "/work/" + "common-parent/".repeat(12)
  const messages: unknown[] = [{ role: "user", content: "Create both reports." }]
  for (const [i, name] of ["first-report.md", "second-report.md"].entries()) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `w-${i}`, name: "write", input: { file_path: parent + name, content: "ok" } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `w-${i}`, content: "created" }] })
  }
  messages.push({ role: "user", content: "Which files did you create?" })
  const prefix = inspect(messages)
  const earlier = prefix.split("Tool calls before this request, oldest first: ")[1]!
  expect(earlier).toContain("first-report.md")
  expect(earlier).toContain("second-report.md")
})


it("keeps an entire latest parallel batch with reverse-order results under the recap budget", () => {
  const messages: unknown[] = [{ role: "user", content: "Update the reports, then summarize." }]
  for (let i = 0; i < 40; i++) {
    messages.push({ role: "assistant", content: [
      { type: "tool_use", id: `a-${i}`, name: "write", input: { file_path: `/work/a-${i}.md`, content: "x".repeat(1000) } },
      { type: "tool_use", id: `b-${i}`, name: "write", input: { file_path: `/work/b-${i}.md`, content: "y".repeat(1000) } },
    ] })
    messages.push({ role: "user", content: [
      { type: "tool_result", tool_use_id: `b-${i}`, content: "created b" },
      { type: "tool_result", tool_use_id: `a-${i}`, content: "created a" },
    ] })
  }
  const prefix = inspect(messages)
  const recap = prefix.split("Since this request:\n")[1]!
  const rows = JSON.parse(recap.split("\n")[0]!)
  expect(recap.length).toBeLessThanOrEqual(4000 + "\nUpdate the reports, then summarize.\n\n".length)
  const calls = rows.at(-2).content.map((block: { id: string }) => block.id)
  const results = rows.at(-1).content.map((block: { tool_use_id: string }) => block.tool_use_id)
  expect(calls).toEqual(["a-39", "b-39"])
  expect(results).toEqual(["b-39", "a-39"])
  expect(prefix).toContain("omitted")
  expect(prefix).not.toContain("prior tool work is done")
})

it("preserves a failed tool result without announcing that its work is done", () => {
  const prefix = inspect([
    { role: "user", content: "Write the report." },
    { role: "assistant", content: [{ type: "tool_use", id: "w-error", name: "write", input: { file_path: "/work/report.md", content: "report" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "w-error", is_error: true, content: "permission denied" }] },
  ])
  expect(prefix).toContain('"is_error":true')
  expect(prefix).toContain("permission denied")
  expect(prefix).not.toContain("prior tool work is done")
})

it("omits an oversized identity as a whole batch and preserves its authoritative bytes", () => {
  const id = "call-" + "z".repeat(5000)
  const prefix = inspect([
    { role: "user", content: "Inspect the report." },
    { role: "assistant", content: [{ type: "tool_use", id, name: "read", input: { file_path: "/work/report.md" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "report" }] },
  ])
  const recap = prefix.split("Since this request:\n")[1]!
  expect(recap).toStartWith("[]\n[")
  expect(prefix).toContain("omitted")
  expect(prefix).not.toContain('"id":"call-')
  expect(prefix).not.toContain('"tool_use_id":"call-')
  expect(prefix).not.toContain("prior tool work is done")
})


it("keeps well-formed Unicode in long target projections", () => {
  const target = "a".repeat(37) + "😀" + "b".repeat(100) + "😀" + "c".repeat(40)
  const prefix = inspect([
    { role: "user", content: "Read the file." },
    { role: "assistant", content: [{ type: "tool_use", id: "unicode-path", name: "read", input: { file_path: target } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "unicode-path", content: "ok" }] },
    { role: "user", content: "Which file did you read?" },
  ])
  expect(prefix.isWellFormed()).toBe(true)
})

it("keeps well-formed Unicode in bounded assistant text", () => {
  const text = "a".repeat(198) + "😀" + "b".repeat(300)
  const prefix = inspect([
    { role: "user", content: "Read the file." },
    { role: "assistant", content: [{ type: "text", text }, { type: "tool_use", id: "unicode-text", name: "read", input: { file_path: "/work/report.md" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "unicode-text", content: "ok" }] },
  ])
  const rows = JSON.parse(prefix.split("Since this request:\n")[1]!.split("\n")[0]!)
  expect(rows[0].content[0].text.isWellFormed()).toBe(true)
})
