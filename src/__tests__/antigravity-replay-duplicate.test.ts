import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { completedToolTail, parseAgRequest, replayNotice, stable } from "../proxy/backends/antigravityProtocol"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { DEFAULT_PROXY_CONFIG } from "../proxy/types"

// A request that reaches a new run ending in tool results is a history replay: the live turn is gone (backend
// replaced, process reclaimed, other account). Gemini then often requests the call that just completed again; a
// second write, append or deploy must not run in the client by accident. Name and arguments still do not identify an
// operation (a status poll repeats both), so the old result must never come back as if it were fresh.
const tool = { name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }
const read = { name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }
const replay = (prompt: string, result: { content: string; is_error?: boolean }, call = { name: "lookup", input: { key: "probe0" } as Record<string, unknown> }) => ({
  model: "fixture-model", max_tokens: 100, tools: [tool, read],
  messages: [
    { role: "user", content: prompt },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_done", ...call }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_done", ...result }] },
  ],
})

describe("completedToolTail", () => {
  const request = (calls: unknown[], results: unknown[]) => parseAgRequest({ model: "fixture-model", messages: [
    { role: "user", content: "go" }, { role: "assistant", content: calls }, { role: "user", content: results },
  ] })
  const use = (id: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name: "write", input })
  const result = (id: string, extra: Record<string, unknown> = {}) => ({ type: "tool_result", tool_use_id: id, content: "ok " + id, ...extra })

  it("keys successful calls of the completed batch by name and input, independent of argument order", () => {
    const tail = completedToolTail(request([use("a", { content: "x", file_path: "/f" }), use("b", { file_path: "/g" })], [result("a"), result("b")]).messages)
    expect([...tail.keys()]).toEqual([stable({ name: "write", input: { file_path: "/f", content: "x" } }), stable({ name: "write", input: { file_path: "/g" } })])
    expect(tail.get(stable({ name: "write", input: { file_path: "/f", content: "x" } }))).toBe("a")
  })

  it("leaves out failed calls and identities repeated within the batch", () => {
    const tail = completedToolTail(request([use("a", { file_path: "/f" }), use("b", { file_path: "/f" }), use("c", { file_path: "/e" })], [result("a"), result("b"), result("c", { is_error: true })]).messages)
    expect(tail.size).toBe(0)
  })

  it("is empty unless the request ends in tool results only", () => {
    const typed = request([use("a", { file_path: "/f" })], [result("a"), { type: "text", text: "now do something else" }])
    expect(completedToolTail(typed.messages).size).toBe(0)
    expect(completedToolTail(parseAgRequest({ model: "fixture-model", messages: [{ role: "user", content: "hi" }] }).messages).size).toBe(0)
  })
})

const executable = fileURLToPath(new URL("./fixtures/agy-replay-repeat-cli.cjs", import.meta.url))
const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0)) await close() })
type Reply = { stop_reason: string; content: Array<{ type: string; id?: string; text?: string; name?: string; input?: unknown }> }

describe.skipIf(process.platform === "win32")("Antigravity history replay does not execute a completed call twice", () => {
  const server = () => {
    const runtime = new AntigravityRuntime({ executable, allowToolBridge: true, turnTimeoutMs: 10000 })
    const app = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
    closing.push(app.closeBackend)
    const send = async (body: unknown) => {
      const response = await app.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body) }))
      expect(response.status, await response.clone().text()).toBe(200)
      return await response.json() as Reply
    }
    return { runtime, send }
  }

  it("does not run an identical repeat of the completed call, and does not return its old result", async () => {
    const { runtime, send } = server()
    const reply = await send(replay("REPEAT_COMPLETED write the receipt", { content: "receipt" }))
    expect(reply.stop_reason).toBe("end_turn")
    expect(reply.content.filter(block => block.type === "tool_use")).toEqual([])
    const text = reply.content.map(block => block.text).join("")
    expect(text).toBe("REPLAYED:" + replayNotice("toolu_done"))
    expect(text).not.toContain("receipt")
    expect(runtime.replayDuplicates).toBe(1)
  })

  it("dispatches a repeated identical call after the notice; a polled status is read fresh, never answered stale", async () => {
    // Maintainer negative control: polling read({path:"/owned/status"}) returned "running" before the backend was
    // replaced; the next identical read is legitimate and must reach the client, and "running" must not be reused.
    const { runtime, send } = server()
    const first = replay("REPEAT_COMPLETED REPEAT_TWICE poll until done", { content: "running" }, { name: "read", input: { path: "/owned/status" } })
    const reply = await send(first)
    expect(reply.stop_reason).toBe("tool_use")
    const fresh = reply.content.filter(block => block.type === "tool_use")
    expect(fresh.map(block => [block.name, block.input])).toEqual([["read", { path: "/owned/status" }]])
    expect(fresh[0]!.id).not.toBe("toolu_done")
    const done = await send({ ...first, messages: [...first.messages, { role: "assistant", content: reply.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: fresh[0]!.id, content: "done" }] }] })
    const text = done.content.map(block => block.text).join("")
    expect(text).toBe("REPLAYED:" + replayNotice("toolu_done") + "|done")
    expect(text).not.toContain("running")
    expect(runtime.replayDuplicates).toBe(1)
  })

  it("dispatches both batch calls after the first fresh client operation", async () => {
    const { runtime, send } = server()
    const reply = await send(replay("REPLAY_AFTER_DISPATCH", { content: "receipt" }))
    expect(reply.stop_reason).toBe("tool_use")
    expect(reply.content.filter(block => block.type === "tool_use").map(block => [block.name, block.input]))
      .toEqual([["lookup", { key: "fresh" }], ["lookup", { key: "probe0" }]])
    expect(runtime.replayDuplicates).toBe(0)
  })

  it("clears an unused replay match before a fresh turn on the same native run", async () => {
    const { runtime, send } = server()
    const first = replay("SKIP_TOOLS idle first", { content: "receipt" })
    const answer = await send(first)
    expect(answer.stop_reason).toBe("end_turn")
    expect(runtime.replayDuplicates).toBe(0)
    const next = await send({ ...first, messages: [
      ...first.messages,
      { role: "assistant", content: answer.content },
      { role: "user", content: "FRESH_REPEAT_AFTER_IDLE deliberately request the same lookup" },
    ] })
    expect(runtime.reused).toBe(1)
    expect(next.stop_reason).toBe("tool_use")
    expect(next.content.filter(block => block.type === "tool_use").map(block => [block.name, block.input]))
      .toEqual([["lookup", { key: "probe0" }]])
    expect(runtime.replayDuplicates).toBe(0)
  })

  it("marks the unexecuted replay notice as an MCP error rather than a successful tool result", async () => {
    const { runtime, send } = server()
    const reply = await send(replay("REPEAT_COMPLETED REQUIRE_REPLAY_ERROR", { content: "receipt" }))
    expect(reply.stop_reason).toBe("end_turn")
    expect(reply.content.map(block => block.text).join("")).toBe("REPLAYED:ERROR:true|" + replayNotice("toolu_done"))
    expect(runtime.replayDuplicates).toBe(1)
  })

  it("sends a retry of a failed call to the client", async () => {
    const { runtime, send } = server()
    const reply = await send(replay("REPEAT_COMPLETED", { content: "disk full", is_error: true }))
    expect(reply.content.filter(block => block.type === "tool_use").map(block => block.input)).toEqual([{ key: "probe0" }])
    expect(runtime.replayDuplicates).toBe(0)
  })
})
