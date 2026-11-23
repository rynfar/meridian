import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { AntigravityError, parseAgRequest } from "../proxy/backends/antigravityProtocol"
import { DEFAULT_PROXY_CONFIG, type AntigravityOptions } from "../proxy/types"
const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0)) await close() })
const tool = { name: "lookup", input_schema: { type: "object" } }
function fixture(native = false, options: AntigravityOptions = {}) {
  const runtime = new AntigravityRuntime({ executable, allowToolBridge: true, allowNativeSubagents: native, ...options })
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
  closing.push(server.closeBackend)
  const send = (body: unknown) => server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body) }))
  return { send, runtime }
}

describe.skipIf(process.platform === "win32")("Antigravity completed-history recovery", () => {
  it("replays an exact completed-result continuation after CLI failure and still caches success", async () => {
    const { send, runtime } = fixture()
    const initial = { model: "fixture-model", messages: [{ role: "user", content: "FAIL_CONTINUATION" }], tools: [tool] }
    const first = await (await send(initial)).json() as { content: Array<{ id: string }> }
    const followup = { ...initial, messages: [...initial.messages,
      { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0]!.id, content: "completed receipt" }] },
    ] }
    const failed = await send({ ...followup, stream: true })
    expect(await failed.text()).toContain("event: error")
    const retry = await send(followup)
    expect(retry.status).toBe(200)
    expect(await retry.text()).toContain("completed receipt")
    const count = runtime.completed
    expect((await send(followup)).headers.get("x-meridian-response-replayed")).toBe("true")
    expect(runtime.completed).toBe(count)
  })

  for (const guard of ["native", "busy", "mixed"] as const) it(`preserves the ${guard} continuation guard`, async () => {
    const { send, runtime } = fixture(guard === "native")
    const initial = { model: "fixture-model", messages: [{ role: "user", content: "Original" }], tools: [tool] }
    const first = await (await send(initial)).json() as { content: Array<{ type: string; id: string }> }
    const old = [...runtime.runs.values()][0]!
    let calls = first.content
    if (guard === "busy") old.busy = true
    if (guard === "mixed") {
      const other = await (await send({ ...initial, messages: [{ role: "user", content: "Independent" }] })).json() as typeof first
      calls = [...calls, ...other.content]
    }
    const response = await send({ ...initial, messages: [
      { role: "user", content: "Changed" }, { role: "assistant", content: calls },
      { role: "user", content: calls.map(call => ({ type: "tool_result", tool_use_id: call.id, content: "receipt" })) },
    ] })
    expect(response.status).toBe(409)
    expect(await response.text()).toContain(guard === "busy" ? "active response" : "changed its delivered history or tool batch")
    expect(runtime.runs.has(old.id)).toBe(true)
    old.busy = false
  })

  for (const status of [401, 429, 503, 504]) it(`recovers an exact completed result after a ${status} failure`, async () => {
    const { send, runtime } = fixture(false, { turnTimeoutMs: 1500 })
    const initial = { model: "fixture-model", messages: [{ role: "user", content: `FAIL_CONTINUATION_${status}` }], tools: [tool] }
    const first = await (await send(initial)).json() as { content: Array<{ id: string }> }
    const body = { ...initial, messages: [...initial.messages, { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0]!.id, content: "receipt" }] }] }
    expect((await send(body)).status).toBe(status)
    expect(runtime.canRetryContinuation(parseAgRequest(body))).toBe(true)
    const retry = await send(body)
    expect(retry.status).toBe(200)
    expect(await retry.text()).toContain("receipt")
  })

  for (const stream of [false, true]) it(`preserves the original rate limit when recovery-state recording fails (${stream ? "SSE" : "JSON"})`, async () => {
    const { send, runtime } = fixture()
    const initial = { model: "fixture-model", messages: [{ role: "user", content: "FAIL_CONTINUATION_429" }], tools: [tool] }
    const first = await (await send(initial)).json() as { content: Array<{ id: string }> }
    const body = { ...initial, stream, messages: [...initial.messages, { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0]!.id, content: "receipt" }] }] }
    runtime.recordInterruptedAfterJoin = async (_request, settled) => { await settled; throw new Error("fixture recovery ledger write failed") }
    const logged: string[] = []
    const error = spyOn(console, "error").mockImplementation((...args) => { logged.push(args.map(String).join(" ")) })
    try {
      const response = await send(body)
      const text = await response.text()
      if (stream) {
        expect(text).toContain('"type":"rate_limit_error"')
        expect(text).toContain('"retry_after":1')
      } else {
        expect(response.status).toBe(429)
        expect(response.headers.get("retry-after")).toBe("1")
        expect(text).toContain("Quota exhausted")
      }
      expect(text).not.toContain("recovery ledger write failed")
      expect(runtime.requests[0]?.status).toBe(429)
      expect(logged.filter(line => line.includes("Interrupted-continuation recovery could not be recorded"))).toHaveLength(1)
      expect(logged.join("\n")).toContain("fixture recovery ledger write failed")
    } finally { error.mockRestore() }
  })

  for (const status of [400, 403, 404, 409, 422, 408, 500]) it(`applies the retryable-failure policy to status ${status}`, async () => {
    const { send, runtime } = fixture()
    const initial = { model: "fixture-model", messages: [{ role: "user", content: "Receipt" }], tools: [tool] }
    const first = await (await send(initial)).json() as { content: Array<{ id: string }> }
    const run = [...runtime.runs.values()][0]!
    const accept = run.accept.bind(run)
    run.accept = async (...args) => { await accept(...args); run.abort(new AntigravityError(`fixture response ${status}`, status, "api_error")) }
    const body = { ...initial, messages: [...initial.messages, { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0]!.id, content: "receipt" }] }] }
    expect((await send(body)).status).toBe(status)
    const eligible = status === 408 || status === 500
    expect(runtime.canRetryContinuation(parseAgRequest(body))).toBe(eligible)
    const retry = await send(body)
    expect(retry.status).toBe(eligible ? 200 : 409)
    if (!eligible) expect(await retry.text()).toContain("already consumed")
  })

  it("replaces the #1074 delivered-prefix rejection with joined replay of complete history and user steering", async () => {
    const { send, runtime } = fixture()
    const initial = { model: "fixture-model", messages: [{ role: "user", content: "Original" }], tools: [tool] }
    const first = await (await send(initial)).json() as { content: Array<{ id: string }> }
    const old = [...runtime.runs.values()][0]!
    const response = await send({ ...initial, messages: [{ role: "user", content: "Revised history" },
      { role: "assistant", content: first.content }, { role: "user", content: [
        { type: "tool_result", tool_use_id: first.content[0]!.id, content: "receipt" },
        { type: "text", text: "Do not write; explain the receipt instead." },
      ] },
    ] })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("receipt")
    await old.settled
    expect(runtime.runs.has(old.id)).toBe(false)
    expect(runtime.requests[0]?.continuation).toBe("history-replay")
    expect(JSON.stringify([...runtime.runs.values()][0]?.history)).toContain("Do not write; explain the receipt instead.")
  })

  it("waits for join and claims even the removed IDs of the old delivered batch", async () => {
    const { send, runtime } = fixture()
    const initial = { model: "fixture-model", messages: [{ role: "user", content: "PARALLEL2" }], tools: [tool] }
    const first = await (await send(initial)).json() as { content: Array<{ id: string }> }
    expect(first.content).toHaveLength(2)
    const old = [...runtime.runs.values()][0]!
    let release!: () => void, enter!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { enter = resolve })
    const originalSettled = old.settled
    Object.defineProperty(old, "settled", { value: originalSettled.then(() => hold) })
    const abort = old.abort.bind(old)
    old.abort = (...args) => { abort(...args); enter() }
    const create = runtime.create.bind(runtime)
    let created = 0
    runtime.create = (...args) => { created++; return create(...args) }
    const continuation = (index: number) => ({ ...initial, messages: [...initial.messages,
      { role: "assistant", content: [first.content[index]!] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[index]!.id, content: "receipt" }] },
    ] })
    const pending = send(continuation(0))
    try {
      await entered
      await originalSettled
      expect(created).toBe(0)
      expect(runtime.recoveringTools.has(first.content[1]!.id)).toBe(true)
      const competing = await send(continuation(1))
      expect(competing.status).toBe(409)
      expect(await competing.text()).toContain("already consumed")
      expect(created).toBe(0)
    } finally { release() }
    expect((await pending).status).toBe(200)
    expect(created).toBe(1)
    expect(runtime.recoveringTools.size).toBe(0)
  })

  it("does not retarget execution controls while replaying divergent history", async () => {
    const { send, runtime } = fixture()
    const initial = { model: "fixture-model", messages: [{ role: "user", content: "Original" }], tools: [tool] }
    const first = await (await send(initial)).json() as { content: Array<{ id: string }> }
    const body = { ...initial, messages: [{ role: "user", content: "Edited" },
      { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0]!.id, content: "receipt" }] },
    ] }
    const old = [...runtime.runs.values()][0]!
    for (const change of [{ model: "fixture-model-high" }, { meridian_session_key: "other" }, { max_tokens: 200 }]) {
      const rejected = await send({ ...body, ...change })
      expect(rejected.status).toBe(409)
      expect(await rejected.text()).toContain("changed its delivered history or tool batch")
      expect(runtime.runs.has(old.id)).toBe(true)
    }
  })

  it("keeps consumed-result protection after a new tool batch overflows a dropped stream", async () => {
    const { send, runtime } = fixture()
    const initial = { model: "fixture-model", messages: [{ role: "user", content: "LARGE_NEXT_TOOL" }], tools: [tool] }
    const first = await (await send(initial)).json() as { content: Array<{ id: string }> }
    const body = { ...initial, stream: true, messages: [...initial.messages,
      { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0]!.id, content: "receipt" }] },
    ] }
    const run = [...runtime.runs.values()][0]!
    const response = await send(body)
    // Let a two-call batch fill the bounded SSE queue without draining it.
    await run.settled
    await expect(response.text()).rejects.toThrow("buffer")
    expect(runtime.canRetryContinuation(parseAgRequest(body))).toBe(false)
    const retry = await send(body)
    expect(retry.status).toBe(409)
    expect(await retry.text()).toContain("already consumed")
  })

  for (const changeBatch of [false, true]) it(`joins a pending owner before replaying a changed ${changeBatch ? "batch" : "history"}`, async () => {
    const { send, runtime } = fixture()
    const initial = { model: "fixture-model", messages: [{ role: "user", content: "Original" }], tools: [tool] }
    const first = await (await send(initial)).json() as { content: Array<{ type: string; id: string; name: string; input: object }> }
    const old = [...runtime.runs.values()][0]!
    const calls = changeBatch ? [{ ...first.content[0]!, id: "completed-elsewhere" }, ...first.content] : first.content
    const response = await send({ ...initial, messages: [
      { role: "user", content: changeBatch ? "Original" : "Revised complete history" },
      { role: "assistant", content: calls },
      { role: "user", content: calls.map(call => ({ type: "tool_result", tool_use_id: call.id, content: "receipt" })) },
    ] })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("receipt")
    await old.settled
    expect(runtime.runs.has(old.id)).toBe(false)
    expect(runtime.requests[0]!.continuation).toBe("history-replay")
  })
})
