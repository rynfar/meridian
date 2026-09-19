import { z } from "zod"
import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { DEFAULT_PROXY_CONFIG } from "../proxy/types"
import { parseAgRequest, renderAgPrompt, historyKey, contractKey } from "../proxy/backends/antigravityProtocol"

interface TestReply {
  backend?: string
  stop_reason: string
  stop_sequence?: string
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number }
}
async function decode(response: Response): Promise<TestReply> { return await response.json() as TestReply }

const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
const closing: Array<() => Promise<void>> = []
function fixture(options = {}) {
  const runtime = new AntigravityRuntime({ executable, reuseConversations: false, allowToolBridge: true, turnTimeoutMs: 10000, ...options })
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
  closing.push(server.closeBackend)
  const send = (body: unknown, signal?: AbortSignal) => server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body), signal }))
  return { runtime, server, send }
}
const tool = { name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }
const initial = (content = "Get receipt") => ({ model: "fixture-model", max_tokens: 100, messages: [{ role: "user", content }], tools: [tool] })
afterEach(async () => { for (const close of closing.splice(0)) await close() })

describe("Antigravity request contract", () => {
  it("rejects images and unsupported controls before creating a process", () => {
    expect(() => parseAgRequest({ ...initial(), messages: [{ role: "user", content: [{ type: "image", source: {} }] }] })).toThrow("text")
    expect(() => parseAgRequest({ ...initial(), temperature: 0 })).toThrow("temperature")
    expect(() => parseAgRequest({ ...initial(), thinking: { type: "enabled", budget_tokens: 100 } })).toThrow()
    expect(() => parseAgRequest({ ...initial(), tool_choice: { type: "tool", name: "unknown" } })).toThrow()
  })
  it("supports native effort and binds it to a pending tool contract", () => {
    const base = parseAgRequest({ ...initial(), model: "fixture-model-high", thinking: { type: "adaptive" }, output_config: { effort: "high" } })
    expect(() => parseAgRequest({ ...initial(), model: "claude-sonnet-4-6", output_config: { effort: "high" } })).toThrow("model slug")
    expect(base.output_config?.effort).toBe("high")
    expect(contractKey(base)).not.toBe(contractKey({ ...base, output_config: { effort: "low" } }))
    expect(() => parseAgRequest({ ...initial(), output_config: { effort: "max" } })).toThrow()
    expect(parseAgRequest({ ...initial(), output_config: { format: { type: "json_schema", schema: {} } } }).output_config?.format?.type).toBe("json_schema")
  })
  it("includes exact client schemas without requiring private CLI metadata reads", () => {
    const prompt = renderAgPrompt(parseAgRequest({ ...initial(), tool_choice: { type: "tool", name: "lookup" } }))
    expect(prompt).toContain(JSON.stringify([tool]))
    const disabled = renderAgPrompt(parseAgRequest({ ...initial(), tool_choice: { type: "none" } }))
    expect(disabled).not.toContain(JSON.stringify(tool))
  })
  it("normalizes legacy structured output without ambiguous precedence", () => {
    const format = { type: "json_schema" as const, schema: { type: "object" } }
    const legacy = parseAgRequest({ ...initial(), output_format: format })
    expect(legacy.output_config?.format).toEqual(format)
    expect(contractKey(legacy)).toBe(contractKey(parseAgRequest({ ...initial(), output_config: { format } })))
    expect(() => parseAgRequest({ ...initial(), output_format: format, output_config: { format } })).toThrow("only one")
  })
  it("normalizes string/text messages and JSON key order for continuation", () => {
    expect(historyKey([{ role: "user", content: "hello" }])).toBe(historyKey([{ role: "user", content: [{ type: "text", text: "hello" }] }]))
  })
})

describe.skipIf(process.platform === "win32")("Antigravity HTTP/CLI integration", () => {
  it("returns model discovery, health, text and per-invocation usage", async () => {
    const { server, send } = fixture()
    const health = await server.app.fetch(new Request("http://local/health"))
    expect((await decode(health)).backend).toBe("antigravity")
    const response = await send({ ...initial("Hello"), tools: [] })
    expect(response.status).toBe(200)
    const body = await decode(response)
    expect(body.content).toEqual([{ type: "text", text: "READY" }])
    expect(body.usage.input_tokens).toBe(120) // CLI reports uncached input separately from cache reads.
    expect(body.usage.cache_read_input_tokens).toBe(20)
  })
  it("reuses an exact native conversation and replays edits without corrupting the original", async () => {
    const { send, runtime } = fixture({ reuseConversations: true })
    const request = { ...initial("NATIVE_FIRST"), tools: [] }
    const first = await decode(await send(request))
    const next = { ...request, messages: [...request.messages, { role: "assistant", content: first.content }, { role: "user", content: "NATIVE_SECOND" }] }
    const second = await decode(await send(next))
    expect(second.content[0]!.text).toBe("NATIVE_REUSED")
    expect(runtime.reused).toBe(1)
    expect(runtime.runs.size).toBe(1)
    const edited = await send({ ...request, messages: [{ role: "user", content: "edited" }] })
    expect(edited.status).toBe(200)
    expect(runtime.reused).toBe(1)
    expect(runtime.runs.size).toBe(2)
  })
  for (const path of ["/v1/chat/completions", "/v1/responses"]) {
    it(`translates JSON and incremental SSE on ${path}`, async () => {
      const { server } = fixture()
      const input = path.endsWith("responses") ? { input: "Hello" } : { messages: [{ role: "user", content: "Hello" }] }
      for (const stream of [false, true]) {
        const response = await server.app.fetch(new Request("http://local" + path, { method: "POST", body: JSON.stringify({ model: "fixture-model", ...input, stream }) }))
        expect(response.status).toBe(200)
        const text = await response.text()
        expect(text).toContain("READY")
        expect(text).toContain(stream ? path.endsWith("responses") ? "response.completed" : "[DONE]" : path.endsWith("responses") ? '"object":"response"' : '"object":"chat.completion"')
      }
    })
  }
  it('preserves literal thinking markup in OpenAI assistant history', async () => {
    const { server } = fixture()
    const response = await server.app.fetch(new Request('http://local/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'First' }, { role: 'assistant', content: '<think>literal client text</think>Answer' }, { role: 'user', content: 'Next' }] }) }))
    expect(response.status).toBe(200)
  })
  it("preserves forced tool calls and results through both OpenAI formats", async () => {
    const { server } = fixture()
    const post = async (path: string, body: unknown) => { const response = await server.app.fetch(new Request("http://local" + path, { method: "POST", body: JSON.stringify(body) })); expect(response.status, await response.clone().text()).toBe(200); return response }
    const chat = { model: "fixture-model", messages: [{ role: "user", content: "receipt" }], tools: [{ type: "function", function: { name: "lookup", parameters: tool.input_schema } }], tool_choice: "required" }
    const chatReply = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable(), tool_calls: z.array(z.object({ id: z.string() }).passthrough()).optional() }).passthrough() })) })
    const responsesReply = z.object({ output: z.array(z.object({ type: z.string(), call_id: z.string().optional() }).passthrough()) })
    const first = chatReply.parse(await (await post("/v1/chat/completions", chat)).json())
    const message = first.choices[0]!.message
    const answer = chatReply.parse(await (await post("/v1/chat/completions", { ...chat, tool_choice: "none", messages: [...chat.messages, message, { role: "tool", tool_call_id: message.tool_calls![0]!.id, content: "CHAT_RECEIPT" }] })).json())
    expect(answer.choices[0]!.message.content).toBe("CHAT_RECEIPT")
    const responses = { model: "fixture-model", input: [{ role: "user", content: "receipt" }], tools: [{ type: "function", name: "lookup", parameters: tool.input_schema }], tool_choice: "required" }
    const initialResponse = responsesReply.parse(await (await post("/v1/responses", responses)).json())
    const call = initialResponse.output.find((item: { type: string }) => item.type === "function_call")
    const result = responsesReply.parse(await (await post("/v1/responses", { ...responses, tool_choice: "none", input: [...responses.input, ...initialResponse.output, { type: "function_call_output", call_id: call!.call_id, output: "RESPONSES_RECEIPT" }] })).json())
    expect(JSON.stringify(result.output)).toContain("RESPONSES_RECEIPT")
  })
  it("counts tokens without starting a CLI and labels the estimate", async () => {
    const { server, runtime } = fixture()
    const response = await server.app.fetch(new Request("http://local/v1/messages/count_tokens", { method: "POST", body: JSON.stringify(initial()) }))
    expect(response.headers.get("x-meridian-token-count")).toBe("estimate")
    expect(z.object({ estimated: z.boolean() }).parse(await response.json()).estimated).toBe(true)
    expect(runtime.cliVersion).toBe("")
  })
  it("combines stops with forced tools and refuses to truncate valid schema output", async () => {
    const { send } = fixture()
    const request = { ...initial(), stop_sequences: ["READY"], tool_choice: { type: "any" } }
    expect((await decode(await send(request))).stop_reason).toBe("tool_use")
    const structured = { ...initial(), tools: [], stop_sequences: ["READY"], output_config: { format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } } } }
    expect((await send(structured)).status).toBe(422)
    expect((await send({ ...structured, stop_sequences: ["NEVER_MATCH"] })).status).toBe(200)
  })
  it("passes reasoning effort to the official CLI flag", async () => {
    const { send } = fixture()
    const response = await send({ ...initial("EFFORT_PROBE"), model: "fixture-model-high", tools: [], thinking: { type: "adaptive" }, output_config: { effort: "high" } })
    expect(response.status).toBe(200)
  })
  it("materializes only valid supplied image bytes and restricts the read hook", async () => {
    const { send } = fixture()
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=" } }
    const request = { ...initial(), tools: [], messages: [{ role: "user", content: [{ type: "text", text: "IMAGE_PROBE" }, image] }] }
    expect((await send(request)).status).toBe(200)
    expect((await send({ ...request, messages: [{ role: "user", content: [{ ...image, source: { ...image.source, data: "ZmFrZQ==" } }] }] })).status).toBe(400)
    const disabled = fixture({ allowToolBridge: false })
    expect((await disabled.send(request)).status).toBe(400)
  })
  it("stops text output, terminates the owned process, and reports the exact sequence", async () => {
    const { send, runtime } = fixture()
    const response = await send({ ...initial("LINGER"), tools: [], stop_sequences: ["AD"] })
    expect(response.status).toBe(200)
    const body = await decode(response)
    expect(body.content).toEqual([{ type: "text", text: "RE" }])
    expect(body.stop_reason).toBe("stop_sequence")
    expect(body.stop_sequence).toBe("AD")
    expect(runtime.runs.size).toBe(0)
    expect(runtime.completed).toBe(1)
    expect(runtime.failed).toBe(0)
  })
  it("uses native structured output and never leaks intermediate prose", async () => {
    const { send } = fixture()
    const format = { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } }
    const response = await send({ ...initial("Hello"), tools: [], output_config: { format } })
    expect(response.status).toBe(200)
    expect((await decode(response)).content).toEqual([{ type: "text", text: '{"answer":"READY"}' }])
    expect((await send({ ...initial("BAD_STRUCTURED"), tools: [], output_config: { format } })).status).toBe(502)
    expect((await send({ ...initial("MISSING_STRUCTURED"), tools: [], output_config: { format } })).status).toBe(502)
    expect((await send({ ...initial("BAD_EXIT"), tools: [], output_config: { format } })).status).toBe(502)
  })
  it("enforces forced tools, then accepts automatic selection on continuation", async () => {
    const { send } = fixture()
    const request = { ...initial(), tools: [{ ...tool, name: "excluded" }, tool], tool_choice: { type: "tool", name: "lookup" } }
    const first = await decode(await send(request))
    expect(first.content).toHaveLength(1)
    const call = first.content[0]!
    expect(call.name).toBe("lookup")
    const response = await send({ ...request, tool_choice: { type: "auto" }, messages: [...request.messages, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "receipt" }] }] })
    expect(response.status).toBe(200)
    expect((await decode(response)).stop_reason).toBe("end_turn")
    expect((await send({ ...initial("SKIP_TOOLS"), tool_choice: { type: "any" } })).status).toBe(502)
  })
  it("rejects invalid tool arguments before delivery and permits a corrected call", async () => {
    const { send } = fixture()
    const request = initial("INVALID_TOOL_ARGS")
    const first = await decode(await send(request))
    expect(first.content[0]?.input).toEqual({ key: "probe0" })
    const response = await send({ ...request, messages: [...request.messages, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0]?.id, content: "corrected" }] }] })
    expect((await decode(response)).content[0]?.text).toBe("corrected")
  })
  it("holds MCP until the matching HTTP tool result and preserves is_error", async () => {
    const { send, runtime } = fixture()
    const request = initial()
    const first = await decode(await send(request))
    expect(first.stop_reason).toBe("tool_use")
    expect(runtime.runs.size).toBe(1)
    const call = first.content.find((b: { type: string }) => b.type === "tool_use")!
    const followup = { ...request, messages: [...request.messages, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "client-secret", is_error: true }] }] }
    const changed = { ...followup, model: "other-model" }
    expect((await send(changed)).status).toBe(409)
    const answer = await decode(await send(followup))
    expect(answer.content[0]!.text).toBe("FAILED:client-secret")
    expect(answer.usage.input_tokens).toBe(120) // Not the earlier 100-token tool request.
    expect((await send(followup)).status).toBe(409) // No duplicate execution.
    expect((await send({ ...followup, tool_choice: { type: "none" }, messages: [...followup.messages, { role: "user", content: "A new user turn with completed context" }] })).status).toBe(200)
  })
  it("preserves UTF-8 tool arguments split across MCP network chunks", async () => {
    const { send } = fixture()
    const request = initial("UNICODE_CHUNKS")
    const first = await decode(await send(request))
    const call = first.content.find(b => b.type === "tool_use")!
    expect(call.input).toEqual({ key: "café/你好/🧪.txt" })
    const response = await send({ ...request, messages: [...request.messages, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "done" }] }] })
    expect((await decode(response)).content[0]?.text).toBe("UNICODE_OK")
  })
  for (const separateMessage of [false, true]) it(`preserves pending tools when steering arrives in ${separateMessage ? "a separate user message" : "the result message"}`, async () => {
    const { send, runtime } = fixture()
    const request = initial("STEERING")
    const first = await decode(await send(request))
    const call = first.content.find(b => b.type === "tool_use")!
    const result = { type: "tool_result", tool_use_id: call.id, content: "receipt" }
    const text = { type: "text", text: "Do not write a file; explain the receipt instead." }
    const suffix = separateMessage ? [{ role: "user", content: [result] }, { role: "user", content: [text] }] : [{ role: "user", content: [result, text] }]
    const followup = { ...request, messages: [...request.messages, { role: "assistant", content: first.content }, ...suffix] }
    const changed = { ...followup, messages: [{ role: "user", content: "changed" }, ...followup.messages.slice(1)] }
    expect((await send(changed)).status).toBe(409)
    expect(runtime.runs.size).toBe(1)
    const answer = await decode(await send(followup))
    expect(answer.stop_reason).toBe("end_turn")
    expect(JSON.parse(answer.content[0]!.text!)).toEqual([{ role: "user", content: [text] }])
    expect(runtime.completed).toBe(1)
  })
  it("serializes a parallel upstream batch into individually correlated client calls", async () => {
    const { send } = fixture()
    const request = { ...initial("PARALLEL2"), tool_choice: { type: "auto", disable_parallel_tool_use: true } }
    let messages: unknown[] = request.messages
    for (let i = 0; i < 2; i++) {
      const response = await decode(await send({ ...request, messages }))
      expect(response.stop_reason).toBe("tool_use")
      const call = response.content.find((b: { type: string }) => b.type === "tool_use")!
      messages = [...messages, { role: "assistant", content: response.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: `value${i}` }] }]
    }
    const answer = await decode(await send({ ...request, messages }))
    expect(answer.content[0]!.text).toBe("value0|value1")
  })
  it("delivers parallel calls together and accepts reverse-order results atomically", async () => {
    const { send, runtime } = fixture()
    const request = initial("PARALLEL2")
    const first = await decode(await send(request))
    const calls = first.content.filter(block => block.type === "tool_use")
    expect(calls).toHaveLength(2)
    const results = calls.map((call, index) => ({ type: "tool_result", tool_use_id: call.id, content: `value${index}` })).reverse()
    const next = { ...request, messages: [...request.messages, { role: "assistant", content: first.content }, { role: "user", content: results }] }
    const answer = await decode(await send(next))
    expect(answer.content[0]!.text).toBe("value0|value1")
    expect(runtime.completed).toBe(1)
    expect((await send(next)).status).toBe(409)
  })
  for (const mode of ['MCP_BATCH', 'MCP_SESSIONS']) it(`${mode}: atomically validates and independently correlates two actions`, async () => {
    const { send } = fixture()
    const request = initial(mode)
    const first = await decode(await send(request))
    const calls = first.content.filter(block => block.type === 'tool_use')
    expect(calls.map(call => call.input?.key).sort()).toEqual(['a', 'b'])
    const results = calls.map(call => ({ type: 'tool_result', tool_use_id: call.id, content: 'RESULT_' + call.input?.key })).reverse()
    const response = await send({ ...request, messages: [...request.messages, { role: 'assistant', content: first.content }, { role: 'user', content: results }] })
    expect(response.status).toBe(200)
    const answer = await decode(response)
    expect(answer.stop_reason).toBe('end_turn')
    expect(answer.content[0]?.text).toContain('RESULT_a')
    expect(answer.content[0]?.text).toContain('RESULT_b')
  })
  it("emits complete SSE blocks, usage, and stop events", async () => {
    const { send } = fixture()
    const response = await send({ ...initial(), tools: [], stream: true })
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))
    expect(events.map(e => e.type)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"])
    expect(events[2].delta.text).toBe("READY")
    expect(events[4].usage.output_tokens).toBe(10)
  })
  it("does not report denied actions as a successful response", async () => {
    const { send } = fixture()
    expect((await send({ ...initial("DENIED"), tools: [] })).status).toBe(502)
    const response = await send({ ...initial("DENIED"), tools: [], stream: true })
    const sse = await response.text()
    expect(sse).toContain("event: error")
    expect(sse).not.toContain("event: message_stop")
  })
  it("bounds pending tool lifetime and recovers completed history without repeating a call", async () => {
    const { send, runtime } = fixture({ pendingToolTimeoutMs: 40 })
    const request = initial()
    const first = await decode(await send(request))
    const run = [...runtime.runs.values()][0]!
    await run.settled
    expect(runtime.runs.size).toBe(0)
    const response = await send({ ...request, messages: [...request.messages, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0]!.id, content: "late" }] }] })
    expect(response.status).toBe(200)
    expect((await decode(response)).content).toEqual([{ type: "text", text: "late" }])
  })
  it("reclaims idle tools under pressure and replays their completed result", async () => {
    const { send, server, runtime } = fixture({ maxConcurrent: 1 })
    const request = initial()
    const first = await decode(await send(request))
    const idle = [...runtime.runs.values()][0]!
    expect((await send({ ...initial(), tools: [] })).status).toBe(200)
    await idle.settled
    expect(runtime.reclaimed).toBe(1)
    expect(runtime.failed).toBe(0)
    expect(runtime.toolOwners.size).toBe(0)
    const response = await send({ ...request, messages: [...request.messages, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0]!.id, content: "reclaimed" }] }] })
    expect((await decode(response)).content).toEqual([{ type: "text", text: "reclaimed" }])
    server.beginDrain?.()
    expect((await send(initial())).status).toBe(503)
    await runtime.close()
    expect(runtime.runs.size).toBe(0)
  })
  it("recovers a completed client tool after the original backend shuts down", async () => {
    const original = fixture()
    const request = initial()
    const first = await decode(await original.send(request))
    await original.server.closeBackend()
    const replacement = fixture()
    const continuation = { ...request, messages: [...request.messages, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0]!.id, content: "after-restart", is_error: true }] }] }
    const response = await replacement.send(continuation)
    expect(response.status).toBe(200)
    expect((await decode(response)).content).toEqual([{ type: "text", text: "FAILED:after-restart" }])
    expect((await replacement.send(continuation)).status).toBe(409)
    expect((await replacement.send({ ...request, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "unknown", content: "orphan" }] }] })).status).toBe(400)
  })
  it("claims a recovered result before preflight and releases the claim on refusal", async () => {
    const { send, runtime } = fixture()
    const request = { ...initial(), messages: [
      { role: "user", content: "Use the completed lookup" },
      { role: "assistant", content: [{ type: "tool_use", id: "previous-process", name: "lookup", input: { key: "probe" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "previous-process", content: "recovered" }] },
    ] }
    const first = send(request)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect((await send(request)).status).toBe(409)
    expect((await decode(await first)).content).toEqual([{ type: "text", text: "recovered" }])
    expect(runtime.recoveringTools.size).toBe(0)
    const failed = { ...request, model: "unknown", messages: request.messages.map(m => ({ ...m, content: typeof m.content === "string" ? m.content : m.content.map(b => ({ ...b, ...("id" in b ? { id: "unconsumed" } : { tool_use_id: "unconsumed" }) })) })) }
    expect((await send(failed)).status).toBe(400)
    expect(runtime.recoveringTools.size).toBe(0)
    expect(runtime.hasConsumedTool("unconsumed")).toBe(false)
    expect((await send({ ...failed, model: request.model })).status).toBe(200)
  })
  it("reserves reclaimed capacity before concurrent admission and never evicts active responses", async () => {
    const { send, runtime } = fixture({ maxConcurrent: 1 })
    await send(initial())
    const active = send({ ...initial("HANG"), tools: [] })
    await new Promise(resolve => setTimeout(resolve, 5))
    const refused = await send({ ...initial(), tools: [] })
    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).toBe("5")
    const deadline = Date.now() + 3000
    while (![...runtime.runs.values()].some(run => run.child?.pid)) {
      if (Date.now() > deadline) throw new Error("Active fixture process did not start")
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect((await send({ ...initial(), tools: [] })).status).toBe(429)
    expect(runtime.reclaimed).toBe(1)
    await runtime.close()
    expect([502, 503]).toContain((await active).status)
    expect(runtime.runs.size).toBe(0)
    expect(runtime.preparing).toBe(0)
  })
  it("times out a stalled CLI and releases its process", async () => {
    const { send, runtime } = fixture({ turnTimeoutMs: 100 })
    const response = await send({ ...initial("HANG"), tools: [] })
    expect(response.status).toBe(504)
    await Promise.all([...runtime.runs.values()].map(run => run.settled))
    expect(runtime.runs.size).toBe(0)
  })
  it("rejects malformed CLI output instead of emitting success", async () => {
    const { send } = fixture()
    expect((await send({ ...initial("MALFORMED"), tools: [] })).status).toBe(502)
  })
  it("requires the explicit tool-bridge opt-in", async () => {
    const { send, runtime } = fixture({ allowToolBridge: false })
    expect((await send(initial())).status).toBe(400)
    expect(runtime.runs.size).toBe(0)
  })
  it("refuses an API-key provider instead of silently bypassing the account", async () => {
    const { server, runtime } = fixture()
    runtime.childEnv.AGY_FIXTURE_API = "1"
    const response = await server.app.fetch(new Request("http://local/health"))
    expect(response.status).toBe(503)
    expect(await response.text()).toContain("default account authentication")
    expect(runtime.runs.size).toBe(0)
  })
  it("recovers an embedded server after account configuration is corrected", async () => {
    const { send, runtime } = fixture()
    runtime.childEnv.AGY_FIXTURE_API = "1"
    expect((await send({ ...initial(), tools: [] })).status).toBe(503)
    delete runtime.childEnv.AGY_FIXTURE_API
    expect((await send({ ...initial(), tools: [] })).status).toBe(200)
  })
  it("cancels the subprocess when a streaming reader disconnects", async () => {
    const { send, runtime } = fixture()
    const response = await send({ ...initial("HANG"), tools: [], stream: true })
    const run = [...runtime.runs.values()][0]!
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    await run.settled
    expect(runtime.runs.size).toBe(0)
  })
  it("sends long conversation history on stdin instead of exceeding argv limits", async () => {
    const { send } = fixture()
    expect((await send({ ...initial("a".repeat(200000)), tools: [] })).status).toBe(200)
  })
  it("honors Meridian API keys while keeping health probes public", async () => {
    const previous = process.env.MERIDIAN_API_KEY
    process.env.MERIDIAN_API_KEY = "fixture-access"
    try {
      const { server, send } = fixture()
      expect((await send(initial())).status).toBe(401)
      expect((await server.app.fetch(new Request("http://local/health"))).status).toBe(200)
      expect((await server.app.fetch(new Request("http://local/v1/models", { headers: { authorization: "Bearer fixture-access" } }))).status).toBe(200)
    } finally {
      if (previous === undefined) delete process.env.MERIDIAN_API_KEY
      else process.env.MERIDIAN_API_KEY = previous
    }
  })
  it("refuses unverified CLI upgrades and changed provider settings before a fresh process", async () => {
    const { send, runtime } = fixture()
    expect((await send({ ...initial(), tools: [] })).status).toBe(200)
    runtime.childEnv.AGY_FIXTURE_API = "1"
    expect((await send({ ...initial(), tools: [] })).status).toBe(503)
    delete runtime.childEnv.AGY_FIXTURE_API
    runtime.childEnv.AGY_FIXTURE_VERSION = "2.0.0"
    const response = await send({ ...initial(), tools: [] })
    expect(response.status).toBe(503)
    expect(await response.text()).toContain("Unsupported agy version")
  })
  it("classifies quota refusals consistently for JSON and SSE", async () => {
    const { send } = fixture()
    const response = await send({ ...initial("RATE_LIMIT"), tools: [] })
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("45")
    const stream = await (await send({ ...initial("RATE_LIMIT"), tools: [], stream: true })).text()
    expect(stream).toContain('"retry_after":45')
    expect(stream).not.toContain("event: message_stop")
  })
  it("does not commit success before a clean CLI exit", async () => {
    const { send } = fixture({ turnTimeoutMs: 200 })
    expect((await send({ ...initial("BAD_EXIT"), tools: [] })).status).toBe(502)
    expect((await send({ ...initial("LINGER"), tools: [] })).status).toBe(504)
  })
  it("bounds simultaneous preflight admission and cancels initialization on shutdown", async () => {
    const { send, runtime } = fixture({ maxConcurrent: 1 })
    const first = send({ ...initial("HANG"), tools: [] })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect((await send(initial())).status).toBe(429)
    await runtime.close()
    expect((await first).status).toBe(503)
    expect(runtime.preparing).toBe(0)
    expect(runtime.runs.size).toBe(0)
  })
  it("exposes real CLI quota groups separately from observed tokens", async () => {
    const { server, send, runtime } = fixture()
    await send({ ...initial(), tools: [] })
    await runtime.accountQuota()
    const response = await server.app.fetch(new Request("http://local/providers/status"))
    const body = await response.json() as { providers: Array<{ id: string; activity?: { requests: number }; accounts: Array<{ windows: Array<{ utilization: number; group: string }> }> }> }
    const provider = body.providers.find(p => p.id === "antigravity")!
    expect(provider.activity?.requests).toBe(1)
    expect(provider.accounts[0]!.windows[0]).toMatchObject({ group: "Gemini Models", utilization: 0.25 })
    const page = await server.app.fetch(new Request("http://local/providers/view?provider=antigravity"))
    expect(await page.text()).toContain('data-provider-card="antigravity"')
  })

  it("runs the generated policy and permits only declared client MCP calls", async () => {
    const { send } = fixture()
    const response = await send(initial("POLICY_PROBE"))
    expect(response.status).toBe(200)
    expect((await decode(response)).stop_reason).toBe("tool_use")
  })

  it("bounds activity to the past hour independently of the request-history ring", () => {
    const { runtime } = fixture()
    const base = { requestId: "activity", durationMs: 1, model: "fixture", status: 200, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0 }
    runtime.record({ ...base, timestamp: Date.now() - 7200000 })
    for (let n = 0; n < 600; n++) runtime.record({ ...base, timestamp: Date.now() })
    expect(runtime.requests.length).toBe(500)
    expect(runtime.activity()).toMatchObject({requests:600,inputTokens:1200,outputTokens:1800})
    expect(runtime.totals.requests).toBe(601)
  })

  it("does not deliver a second client tool when the CLI retries its MCP request", async () => {
    const { send } = fixture()
    const request = initial("RPC_RETRY")
    const first = await decode(await send(request))
    const call = first.content.find(b => b.type === 'tool_use')!
    const answer = await decode(await send({...request,messages:[...request.messages,{role:'assistant',content:first.content},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'once'}]}]}))
    expect(answer.stop_reason).toBe('end_turn')
    expect(answer.content[0]?.text).toBe('once|once')
  })

  it("returns provider navigation without waiting for CLI quota and joins its probes on close", async () => {
    const { server, runtime } = fixture()
    const before = Date.now()
    const response = await server.app.fetch(new Request('http://local/providers/status'))
    expect(response.status).toBe(200)
    expect(Date.now() - before).toBeLessThan(500)
    await runtime.close()
    expect(runtime.runs.size).toBe(0)
  })

})
