/**
 * Copilot backend against a scripted fake of @microsoft/copilot-sdk: request
 * validation, the native tool hand-off, replay, and the safety checks.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { CopilotRuntime, createCopilotServer } from "../proxy/backends/copilot"
import { parseCopilotRequest, planContinuation, openingPrompt } from "../proxy/backends/copilotProtocol"
import { copilotRuntimeEnv, loadCopilotSdk, type CopilotModel, type CopilotSessionConfig, type CopilotSdk } from "../proxy/backends/copilotSdk"
import { resolveBackendConfig } from "../proxy/types"

type Input = { prompt: string } | { results: Array<{ requestId: string; result: string }> }
type Script = (session: FakeSession, input: Input) => void

class FakeSession {
  private handlers = new Set<(event: { type: string; data: Record<string, any> }) => void>()
  readonly prompts: string[] = []
  readonly results: Array<{ requestId: string; result: string }> = []
  private batch: Array<{ requestId: string; result: string }> = []
  expectedResults = 0
  disconnected = false
  constructor(readonly config: CopilotSessionConfig, private readonly script: Script) {}
  on(handler: (event: { type: string; data: Record<string, any> }) => void) { this.handlers.add(handler); return () => { this.handlers.delete(handler) } }
  emit(type: string, data: Record<string, any> = {}) { for (const handler of [...this.handlers]) handler({ type, data }) }
  async send({ prompt }: { prompt: string }) { this.prompts.push(prompt); queueMicrotask(() => this.script(this, { prompt })) }
  async abort() {}
  async disconnect() { this.disconnected = true }
  rpc = { tools: { handlePendingToolCall: async (input: { requestId: string; result: string }) => {
    this.results.push(input); this.batch.push(input)
    if (this.batch.length === this.expectedResults) { const results = this.batch; this.batch = []; queueMicrotask(() => this.script(this, { results })) }
    return { success: true }
  } } }
  answer(text: string, model = this.config.model) {
    this.emit("assistant.reasoning_delta", { reasoningId: "r1", deltaContent: "thinking" })
    this.emit("assistant.message_delta", { messageId: "m1", deltaContent: text })
    this.emit("assistant.message", { messageId: "m1", content: text, toolRequests: [] })
    this.emit("assistant.usage", { model, inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 })
    this.emit("session.idle")
  }
  callTools(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
    this.expectedResults = calls.length
    this.emit("assistant.message", { messageId: "m2", content: "", toolRequests: calls.map(call => ({ toolCallId: call.id, name: call.name, arguments: call.arguments })) })
    this.emit("assistant.usage", { model: this.config.model, inputTokens: 20, outputTokens: 5 })
    for (const call of calls) this.emit("external_tool.requested", { requestId: `req-${call.id}`, toolCallId: call.id, toolName: call.name })
  }
}

const MODELS: CopilotModel[] = [
  { id: "mai-code-2", supportedReasoningEfforts: ["low", "high"] },
  { id: "plain-model" },
  { id: "auto" },
  { id: "blocked", policy: { state: "disabled" } },
]

function fakeSdk(script: Script, models = MODELS) {
  const sessions: FakeSession[] = []
  const state = { started: 0, stopped: 0, signedIn: true }
  const sdk: CopilotSdk = { version: "2.0.1", createClient: () => ({
    start: async () => { state.started++ },
    stop: async () => { state.stopped++ },
    listModels: async () => models,
    getAuthStatus: async () => ({ isAuthenticated: state.signedIn, login: "octocat", statusMessage: state.signedIn ? undefined : "Not logged in" }),
    createSession: async (config: CopilotSessionConfig) => { const session = new FakeSession(config, script); sessions.push(session); return session },
  }) }
  return { sessions, state, load: async () => sdk }
}

const readFiles: Script = (session, input) => {
  if ("prompt" in input) return session.callTools([{ id: "call_a", name: "read_file", arguments: { path: "a" } }, { id: "call_b", name: "read_file", arguments: { path: "b" } }])
  session.answer(`done ${input.results.map(result => result.result).join(",")}`)
}

const tools = [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } } }]
const servers: Array<{ closeBackend(): Promise<void> }> = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.closeBackend())) })

function serve(script: Script, options = {}, models?: CopilotModel[]) {
  const fake = fakeSdk(script, models)
  const server = createCopilotServer({ copilot: options }, new CopilotRuntime(options, fake.load))
  servers.push(server)
  const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) => server.app.fetch(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }))
  return { ...fake, server, post }
}

async function sse(response: Response) {
  const text = await response.text()
  return text.split("\n\n").filter(Boolean).map(line => line.slice("data: ".length)).filter(data => data !== "[DONE]").map(data => JSON.parse(data))
}

describe("Copilot request validation", () => {
  const headers = new Headers()
  const base = { model: "mai-code-2", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }] }
  it("rejects controls it cannot honour instead of dropping them", () => {
    expect(() => parseCopilotRequest({ ...base, response_format: { type: "json_object" } }, headers)).toThrow("Unsupported request options: response_format")
    expect(() => parseCopilotRequest({ ...base, tool_choice: "required" }, headers)).toThrow("tool_choice")
    expect(() => parseCopilotRequest({ ...base, parallel_tool_calls: false }, headers)).toThrow("parallel_tool_calls")
    expect(() => parseCopilotRequest({ ...base, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }, headers)).toThrow("text content only")
    expect(() => parseCopilotRequest({ ...base, messages: [{ role: "user", content: "a" }, { role: "system", content: "late" }] }, headers)).toThrow("start of the conversation")
    expect(() => parseCopilotRequest({ ...base, tools: [...tools, ...tools] }, headers)).toThrow("unique")
  })
  it("declares client tools only, overriding same-named Copilot built-ins", () => {
    const request = parseCopilotRequest({ ...base, tools }, headers)
    expect(request.definitions).toEqual([{ name: "read_file", description: "Read", parameters: tools[0]!.function.parameters, defer: "never", skipPermission: true, overridesBuiltInTool: true }])
    expect(request.system).toBe("sys")
  })
  it("keys conversations by a client session header, or by their opening", () => {
    const keyed = parseCopilotRequest({ ...base, tools }, new Headers({ "x-session-affinity": "chat-1" }))
    expect(keyed.key).toBe("header:x-session-affinity:chat-1")
    const a = parseCopilotRequest({ ...base, tools }, headers), b = parseCopilotRequest({ ...base, tools, messages: [...base.messages, { role: "assistant", content: "x" }, { role: "user", content: "y" }] }, headers)
    expect(a.key).toStartWith("opening:")
    expect(a.key).toBe(b.key)
    expect(parseCopilotRequest(base, headers).key).toBeUndefined()
  })
  it("replays history only when the session cannot continue natively", () => {
    const request = parseCopilotRequest({ ...base, tools }, headers)
    const view = { model: "mai-code-2", system: "sys", definitions: request.definitions, history: [], waiting: new Map() }
    expect(planContinuation(view, request)).toEqual({ kind: "user", prompt: "hi" })
    expect(planContinuation({ ...view, system: "other" }, request)).toBeNull()
    expect(planContinuation({ ...view, effort: "high" }, request)).toBeNull()
    expect(openingPrompt(request.history)).toEqual({ prompt: "hi", replayed: false })
  })
})

describe("Copilot backend", () => {
  it("runs a parallel client-tool round natively, then continues the same session with the results", async () => {
    const { post, sessions } = serve(readFiles)
    const messages: Array<Record<string, unknown>> = [{ role: "system", content: "You are the client." }, { role: "user", content: "read a and b" }]
    const first = await sse(await post({ model: "mai-code-2", stream: true, stream_options: { include_usage: true }, tools, messages }, { "x-session-affinity": "s1" }))
    const calls = first.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? [])
    expect(calls.map((call: any) => [call.id, call.function.name, call.function.arguments])).toEqual([["call_a", "read_file", "{\"path\":\"a\"}"], ["call_b", "read_file", "{\"path\":\"b\"}"]])
    expect(first.find(chunk => chunk.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe("tool_calls")
    expect(first.at(-1).usage).toEqual({ prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 })

    messages.push({ role: "assistant", content: null, tool_calls: calls.map(({ index, ...call }: any) => call) }, { role: "tool", tool_call_id: "call_a", content: "A" }, { role: "tool", tool_call_id: "call_b", content: "B" })
    const second = await sse(await post({ model: "mai-code-2", stream: true, tools, messages }, { "x-session-affinity": "s1" }))
    expect(second.map(chunk => chunk.choices?.[0]?.delta?.content ?? "").join("")).toBe("done A,B")
    expect(second.map(chunk => chunk.choices?.[0]?.delta?.reasoning_content ?? "").join("")).toBe("thinking")
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.results).toEqual([{ requestId: "req-call_a", result: "A" }, { requestId: "req-call_b", result: "B" }])
    expect(sessions[0]!.config).toMatchObject({ systemMessage: { mode: "replace", content: "You are the client." }, tools: { availableTools: ["custom:read_file"] }, instructions: { skipCustomInstructions: true }, hooks: { enableRepositoryHooks: false } })
    expect(sessions[0]!.config.permissions.onRequest()).toEqual({ kind: "denied-interactively-by-user" })
  })

  it("opens a new session and replays history when the system prompt changes", async () => {
    const { post, sessions } = serve((session, input) => session.answer("prompt" in input ? "ok" : "unexpected"))
    const messages = [{ role: "system", content: "mode A" }, { role: "user", content: "first" }]
    await post({ model: "mai-code-2", tools, messages }, { "x-session-affinity": "s2" })
    const replayed = await post({ model: "mai-code-2", tools, messages: [{ role: "system", content: "mode B" }, { role: "user", content: "first" }, { role: "assistant", content: "ok" }, { role: "user", content: "second" }] }, { "x-session-affinity": "s2" })
    expect(replayed.headers.get("x-meridian-copilot-session")).toBe("replayed")
    expect(sessions).toHaveLength(2)
    expect(sessions[0]!.disconnected).toBe(true)
    expect(sessions[1]!.prompts[0]).toContain("## User\nfirst\n\n## Assistant\nok\n\n## User\nsecond")
  })

  it("answers tool-less side requests from a short-lived session", async () => {
    const { post, sessions } = serve(session => session.answer("A title"))
    const response = await post({ model: "mai-code-2", messages: [{ role: "user", content: "title this" }] }, { "x-session-affinity": "s3" })
    expect(await response.json()).toMatchObject({ object: "chat.completion", choices: [{ message: { role: "assistant", content: "A title", reasoning_content: "thinking" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 4 } } })
    expect(response.headers.get("x-meridian-copilot-session")).toBe("stateless")
    expect(sessions[0]!.disconnected).toBe(true)
  })

  it("rejects unknown models and reasoning efforts before opening a stream", async () => {
    const { post, sessions } = serve(readFiles, { models: ["mai-code-2", "plain-model"] })
    for (const model of ["auto", "blocked", "not-listed"]) {
      const response = await post({ model, stream: true, messages: [{ role: "user", content: "hi" }] })
      expect(response.status).toBe(404)
    }
    expect((await post({ model: "mai-code-2", reasoning_effort: "max", messages: [{ role: "user", content: "hi" }] })).status).toBe(400)
    expect((await post({ model: "plain-model", reasoning_effort: "low", messages: [{ role: "user", content: "hi" }] })).status).toBe(400)
    expect(sessions).toHaveLength(0)
  })

  it("fails a round rather than accept another model, a BYOK model or an undeclared tool", async () => {
    const substituted = serve(session => session.answer("hi", "some-other-model"))
    const error = await substituted.post({ model: "mai-code-2", messages: [{ role: "user", content: "hi" }] })
    expect(error.status).toBe(502)
    expect(((await error.json()) as any).error.message).toContain("instead of mai-code-2")

    const undeclared = serve(session => session.callTools([{ id: "c", name: "bash", arguments: {} }]))
    const chunks = await sse(await undeclared.post({ model: "mai-code-2", stream: true, tools, messages: [{ role: "user", content: "hi" }] }, { "x-session-affinity": "s4" }))
    expect(chunks.at(-1).error.message).toContain("undeclared tool bash")
    expect(undeclared.sessions[0]!.disconnected).toBe(true)
  })

  it("reports a missing sign-in as unavailable", async () => {
    const { server, state } = serve(readFiles)
    state.signedIn = false
    const health = await server.app.fetch(new Request("http://localhost/health"))
    expect(health.status).toBe(503)
    expect(await health.json()).toMatchObject({ status: "unavailable", backend: "copilot", error: expect.stringContaining("not signed in") })
  })

  it("serves health, models and provider status, and refuses new work while draining", async () => {
    const { server, post, state } = serve(readFiles)
    const health = await (await server.app.fetch(new Request("http://localhost/health"))).json() as Record<string, any>
    expect(health).toMatchObject({ status: "healthy", preview: true, account: { login: "octocat" }, sdk: { version: "2.0.1" }, capabilities: { copilotBuiltInTools: false, byok: false, images: false } })
    const models = await (await server.app.fetch(new Request("http://localhost/v1/models"))).json() as { data: Array<{ id: string }> }
    expect(models.data.map(model => model.id)).toEqual(["mai-code-2", "plain-model"])
    expect(server.providerStatus()).toMatchObject({ id: "copilot", enabled: true, status: "healthy", endpoint: "/copilot/v1/chat/completions", models: ["mai-code-2", "plain-model"], accounts: [{ id: "@octocat" }] })
    server.beginDrain()
    expect((await post({ model: "mai-code-2", messages: [{ role: "user", content: "hi" }] })).status).toBe(503)
    await server.closeBackend()
    expect(state.stopped).toBe(1)
  })

  it("abandons the round and the session when the client disconnects", async () => {
    const { sessions, server } = serve(() => {})
    const abort = new AbortController()
    const response = await server.app.fetch(new Request("http://localhost/v1/chat/completions", { method: "POST", signal: abort.signal, headers: { "content-type": "application/json", "x-session-affinity": "s5" }, body: JSON.stringify({ model: "mai-code-2", stream: true, tools, messages: [{ role: "user", content: "hi" }] }) }))
    const reader = response.body!.getReader()
    await reader.read()
    expect(server.getInFlightCount()).toBe(1)
    for (let i = 0; i < 200 && !sessions[0]?.prompts.length; i++) await Bun.sleep(1)
    expect(sessions[0]!.prompts).toEqual(["hi"])
    await reader.cancel()
    await Bun.sleep(5)
    expect(server.getInFlightCount()).toBe(0)
    expect(sessions[0]!.disconnected).toBe(true)
  })
})

describe("Copilot configuration", () => {
  const keys = ["MERIDIAN_COPILOT", "MERIDIAN_COPILOT_MODELS", "MERIDIAN_COPILOT_MAX_SESSIONS", "MERIDIAN_BACKEND"]
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  afterEach(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] } })

  it("is off unless MERIDIAN_COPILOT=1, and parses its options", () => {
    delete process.env.MERIDIAN_COPILOT
    expect(resolveBackendConfig({}).copilot).toBeUndefined()
    process.env.MERIDIAN_COPILOT = "1"
    process.env.MERIDIAN_COPILOT_MODELS = "mai-code-2, mai-code-2-flash"
    process.env.MERIDIAN_COPILOT_MAX_SESSIONS = "3"
    expect(resolveBackendConfig({}).copilot).toMatchObject({ models: ["mai-code-2", "mai-code-2-flash"], maxSessions: 3 })
    process.env.MERIDIAN_COPILOT_MAX_SESSIONS = "0"
    expect(() => resolveBackendConfig({})).toThrow("MERIDIAN_COPILOT_MAX_SESSIONS")
  })

  it("refuses the standalone Antigravity backend instead of ignoring the flag", () => {
    process.env.MERIDIAN_COPILOT = "1"
    expect(() => resolveBackendConfig({ backend: "antigravity" })).toThrow("MERIDIAN_COPILOT needs")
  })

  it("keeps Meridian and Claude secrets out of the Copilot runtime", () => {
    expect(copilotRuntimeEnv({ PATH: "/bin", HOME: "/h", MERIDIAN_API_KEY: "k", ANTHROPIC_API_KEY: "a", CLAUDE_CONFIG_DIR: "c" })).toEqual({ PATH: "/bin", HOME: "/h" })
  })

  it("explains how to install the SDK when it cannot be found", async () => {
    await expect(loadCopilotSdk("/nonexistent/copilot-sdk")).rejects.toThrow("npm install -g @microsoft/copilot-sdk")
    await expect(loadCopilotSdk("relative/path")).rejects.toThrow("absolute path")
  })
})
