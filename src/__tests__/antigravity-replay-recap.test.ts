import { expect, test } from "bun:test"
import { parseAgRequest, renderAgPrompt } from "../proxy/backends/antigravityProtocol"

function completedWrites() {
  const parent = "/isolated/public-fixture/" + "shared-parent/".repeat(12)
  const paths = [parent + "already-completed.txt", parent + "latest-target.txt"]
  const messages: unknown[] = [{ role: "user", content: "Write latest-target.txt exactly once, then read it." }]
  for (const [index, path] of paths.entries()) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `write-${index}`, name: "write", input: { content: "receipt", path } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `write-${index}`, is_error: false, content: "Write succeeded" }] })
  }
  return { paths, request: parseAgRequest({ model: "fixture-model", messages }) }
}

test("completed writes under a long shared parent retain distinct filenames in the bounded recap", () => {
  const { paths, request } = completedWrites()
  const prompt = renderAgPrompt(request)
  const line = prompt.split("Since this request:\n")[1]!.split("\n")[0]!
  const recap: Array<{ content: Array<{ type: string; target?: string }> }> = JSON.parse(line)
  const targets = recap.flatMap(message => message.content).filter(block => block.type === "tool_use").map(block => block.target)
  expect(targets).toHaveLength(2)
  expect(targets[0]).not.toBe(targets[1])
  expect(targets[0]).toEndWith("already-completed.txt")
  expect(targets[1]).toEndWith("latest-target.txt")
  for (const target of targets) {
    expect(target).toStartWith("/isolated/public-fixture/")
    expect(target!.length).toBeLessThanOrEqual(80)
  }
  expect(prompt.endsWith("Client conversation:\n" + JSON.stringify(request.messages))).toBe(true)
  for (const path of paths) expect(prompt).toContain(path)
})

test("result-tail replay presents completed work after the restated action and ends with continuation guidance", () => {
  const { request } = completedWrites()
  const prompt = renderAgPrompt(request)
  const prefix = prompt.slice(0, prompt.lastIndexOf("Client conversation:\n"))
  expect(prefix.lastIndexOf("Write latest-target.txt exactly once, then read it.")).toBeLessThan(prefix.indexOf("Since this request:\n"))
  expect(prefix.lastIndexOf("Continue from these recorded results")).toBeGreaterThan(prefix.indexOf("Since this request:\n"))
  expect(prefix).toContain("restating the request does not ask you to execute successful actions again")
  expect(prefix.match(/Write latest-target.txt exactly once, then read it\./g)).toHaveLength(2)
})
