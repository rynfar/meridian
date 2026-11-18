/**
 * Copilot backend (preview): OpenAI Chat Completions served by models on the
 * operator's GitHub Copilot subscription, through the official Copilot SDK.
 *
 * The client keeps its own system prompt and tools. Copilot's built-in tools,
 * repository instructions, hooks and permissions are off; every tool call is
 * handed back to the client, which executes it with its own approvals.
 * Mounted under /copilot. Never imports Claude session or cache modules.
 */
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProviderUsage } from "../../telemetry/providerView"
import { loadCopilotSdk, VERIFIED_COPILOT_SDK_VERSION, type CopilotClientHandle, type CopilotModel, type CopilotSdk } from "./copilotSdk"
import { CopilotError, openingPrompt, parseCopilotAnthropicRequest, parseCopilotRequest, planContinuation, type ChatToolCall, type CopilotContinuation, type CopilotRequest, type CopilotSessionView } from "./copilotProtocol"
import type { CopilotSessionHandle } from "./copilotSdk"
import type { CopilotOptions } from "../types"

export interface CopilotUsage { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; finishReason?: string }
export interface CopilotRound { text: string; calls: ChatToolCall[]; waiting: Map<string, string>; usage: CopilotUsage; finishReason: string; path: string }
interface RoundSink { content(text: string): void; reasoning(text: string): void }
interface LiveSession extends CopilotSessionView { session: CopilotSessionHandle; expiry?: ReturnType<typeof setTimeout>; lastUsed: number }
interface Started { sdk: CopilotSdk; client: CopilotClientHandle; home: string; workspace: string }

const HOUR = 3_600_000
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export class CopilotRuntime {
  draining = false
  readonly sessions = new Map<string, LiveSession>()
  private readonly busy = new Set<string>()
  private readonly rounds = new Set<AbortController>()
  private readonly recent: Array<{ at: number; error: boolean; input: number; output: number; cached: number }> = []
  private readonly quota = new Map<string, { type: string; group?: string; utilization: number; resetsAt: number; fetchedAt: number }>()
  private starting?: Promise<Started>
  private refreshing?: Promise<{ login?: string; models: CopilotModel[] }>
  private account?: { login?: string; models: CopilotModel[]; checkedAt: number }
  error?: string

  constructor(readonly options: CopilotOptions = {}, private readonly loadSdk: (path?: string) => Promise<CopilotSdk> = loadCopilotSdk) {}

  /** The loaded SDK's version, once started. */
  sdkVersion?: string
  get activeRounds(): number { return this.rounds.size }

  private start(): Promise<Started> {
    this.starting ??= (async () => {
      const sdk = await this.loadSdk(this.options.sdkPath)
      // A private COPILOT_HOME: no session state lands in the user's ~/.copilot.
      const home = await mkdtemp(join(tmpdir(), "meridian-copilot-"))
      const workspace = join(home, "workspace")
      await mkdir(workspace)
      const client = sdk.createClient({ baseDirectory: home })
      try { await client.start() } catch (error) { await rm(home, { recursive: true, force: true }); throw error }
      this.sdkVersion = sdk.version
      return { sdk, client, home, workspace }
    })().catch(error => { this.starting = undefined; this.error = message(error); throw error })
    return this.starting
  }

  /** Account and model catalog, cached for a minute. */
  refresh(force = false): Promise<{ login?: string; models: CopilotModel[] }> {
    if (!force && this.account && Date.now() - this.account.checkedAt < 60_000) return Promise.resolve(this.account)
    this.refreshing ??= (async () => {
      const { client } = await this.start()
      const auth = await client.getAuthStatus()
      if (!auth.isAuthenticated) throw new CopilotError(`Copilot is not signed in. Sign in with the Copilot CLI (copilot, then /login). ${auth.statusMessage ?? ""}`.trim(), 503, "authentication_error")
      this.account = { login: auth.login, models: await client.listModels(), checkedAt: Date.now() }
      this.error = undefined
      return this.account
    })().catch(error => { this.error = message(error); throw error }).finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  /** Models this instance serves: enabled on the account, concrete, allowlisted. */
  async models(): Promise<CopilotModel[]> {
    const { models } = await this.refresh()
    const allow = this.options.models
    return models.filter(model => model.id !== "auto" && model.policy?.state !== "disabled" && (!allow?.length || allow.includes(model.id)))
  }

  /** Reject before any stream opens, so request errors keep their HTTP status. */
  async check(request: CopilotRequest): Promise<void> {
    if (this.draining) throw new CopilotError("Meridian is shutting down.", 503, "overloaded_error")
    const model = (await this.models()).find(candidate => candidate.id === request.model)
    if (!model) throw new CopilotError(`Model ${request.model} is not available on this Copilot account${this.options.models?.length ? " or is not in MERIDIAN_COPILOT_MODELS" : ""}.`, 404, "not_found_error")
    if (request.effort !== undefined && !model.supportedReasoningEfforts?.includes(request.effort)) throw new CopilotError(`${request.model} does not support reasoning_effort "${request.effort}". Supported: ${model.supportedReasoningEfforts?.join(", ") || "none"}.`)
  }

  async complete(request: CopilotRequest, sink: RoundSink, signal: AbortSignal): Promise<CopilotRound> {
    // Counted as in flight from the first moment, including SDK start-up, so
    // drain and shutdown never miss a request that has not reached Copilot yet.
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal.reason)
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true })
    this.rounds.add(controller)
    let key: string | undefined
    let live: LiveSession | undefined
    try {
      await this.check(request)
      const { client, workspace } = await this.start()
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Request cancelled.")
      // One round per conversation at a time; a concurrent request runs statelessly.
      key = request.key && !this.busy.has(request.key) ? request.key : undefined
      if (key) this.busy.add(key)
      live = key ? this.sessions.get(key) : undefined
      let plan: CopilotContinuation | null = live ? planContinuation(live, request) : null
      let path = plan ? `native-${plan.kind}` : ""
      if (!live || !plan) {
        if (live) await this.drop(key, live)
        live = await this.open(client, workspace, request)
        if (key) { this.sessions.set(key, live); this.evict() }
        const opening = openingPrompt(request.history)
        plan = { kind: "user", prompt: opening.prompt, ...(opening.attachments ? { attachments: opening.attachments } : {}) }
        path = !key ? "stateless" : opening.replayed ? "replayed" : "new"
      }
      const current: LiveSession = live, continuation: CopilotContinuation = plan
      clearTimeout(current.expiry)
      const round = await this.round(current, sink, controller.signal, () => this.release(current, continuation))
      Object.assign(current, { history: request.history, previous: { text: round.text, callIds: round.calls.map(call => call.id) }, waiting: round.waiting, lastUsed: Date.now() })
      this.record(round.usage, false)
      if (!key) await this.closeSession(current)
      else if (round.waiting.size) current.expiry = setTimeout(() => void this.drop(key, current), this.options.pendingToolTimeoutMs ?? HOUR)
      return { ...round, path }
    } catch (error) {
      if (!(error instanceof CopilotError && error.status < 500)) this.record(undefined, true)
      if (live) await this.drop(key, live)
      throw error
    } finally {
      signal.removeEventListener("abort", onAbort)
      this.rounds.delete(controller)
      if (key) this.busy.delete(key)
    }
  }

  private async open(client: CopilotClientHandle, workspace: string, request: CopilotRequest): Promise<LiveSession> {
    const session = await client.createSession({
      model: request.model,
      ...(request.effort ? { inference: { reasoningEffort: request.effort } } : {}),
      systemMessage: { mode: "replace", content: request.system },
      filesystem: { workingDirectory: workspace },
      // Only the client's declared tools; none of Copilot's built-ins.
      tools: { definitions: request.definitions, availableTools: request.definitions.map(tool => `custom:${tool.name}`) },
      instructions: { skipCustomInstructions: true },
      hooks: { enableRepositoryHooks: false },
      permissions: { onRequest: () => ({ kind: "denied-interactively-by-user" }) },
      events: { streaming: true },
    })
    return { session, model: request.model, effort: request.effort, system: request.system, definitions: request.definitions, history: [], waiting: new Map(), lastUsed: Date.now() }
  }

  private async release(live: LiveSession, plan: CopilotContinuation): Promise<void> {
    if (plan.kind === "user") { await live.session.send({ prompt: plan.prompt, ...(plan.attachments ? { attachments: plan.attachments } : {}) }); return }
    await Promise.all(plan.results.map(async result => {
      const handled = await live.session.rpc.tools.handlePendingToolCall({ requestId: result.requestId, result: result.content })
      if (!handled.success) throw new Error("Copilot rejected a pending tool result.")
    }))
  }

  /**
   * One model round. It ends when Copilot goes idle with a final answer, or
   * once usage is reported and every tool call it made is pending for the
   * client. Subscribes before `start` so no event of the round is missed.
   */
  private round(live: LiveSession, sink: RoundSink, signal: AbortSignal, start: () => Promise<void>): Promise<Omit<CopilotRound, "path">> {
    const allowed = new Set(live.definitions.map(tool => tool.name))
    const calls = new Map<string, ChatToolCall>(), waiting = new Map<string, string>()
    const streamedText = new Set<string>(), streamedReasoning = new Set<string>()
    let usage: CopilotUsage | undefined
    let text = ""
    return new Promise((resolve, reject) => {
      let settled = false
      let unsubscribe = () => {}
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribe()
        signal.removeEventListener("abort", onAbort)
        if (error) return reject(error)
        if (!usage) return reject(new Error(`Copilot did not report ${live.model} usage for the round.`))
        const toolCalls = [...calls.values()]
        resolve({ text, calls: toolCalls, waiting, usage, finishReason: toolCalls.length ? "tool_calls" : usage.finishReason === "length" ? "length" : "stop" })
      }
      const onAbort = () => finish(signal.reason ?? new Error("Request cancelled."))
      const timer = setTimeout(() => finish(new CopilotError("Copilot round timed out.", 504, "timeout_error")), this.options.turnTimeoutMs ?? 10 * 60_000)
      if (signal.aborted) return onAbort()
      signal.addEventListener("abort", onAbort, { once: true })
      unsubscribe = live.session.on(({ type, data }) => {
        if (type === "session.quota_observation") this.observeQuota(data.observation)
        if (settled) return
        try {
          if (type === "assistant.usage") {
            if (data.interactionType === "conversation-background") return
            // Never let Copilot substitute another model, or a BYOK provider.
            if (data.model !== live.model || data.isByok === true) throw new Error(`Copilot used ${data.model ?? "an unknown model"} instead of ${live.model}.`)
            usage = { inputTokens: data.inputTokens, outputTokens: data.outputTokens, cacheReadTokens: data.cacheReadTokens, finishReason: data.finishReason }
          } else if (type === "assistant.reasoning_delta") {
            streamedReasoning.add(data.reasoningId)
            if (data.deltaContent) sink.reasoning(data.deltaContent)
          } else if (type === "assistant.reasoning") {
            if (data.content && !streamedReasoning.has(data.reasoningId)) sink.reasoning(data.content)
          } else if (type === "assistant.message_delta") {
            streamedText.add(data.messageId)
            if (data.deltaContent) { text += data.deltaContent; sink.content(data.deltaContent) }
          } else if (type === "assistant.message") {
            if (data.content && !streamedText.has(data.messageId)) { text += data.content; sink.content(data.content) }
            for (const call of data.toolRequests ?? []) {
              if (!allowed.has(call.name)) throw new Error(`Copilot requested undeclared tool ${call.name}.`)
              calls.set(call.toolCallId, { id: call.toolCallId, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } })
            }
          } else if (type === "external_tool.requested") {
            if (!allowed.has(data.toolName)) throw new Error(`Copilot requested undeclared tool ${data.toolName}.`)
            waiting.set(data.toolCallId, data.requestId)
          } else if (type === "session.idle") {
            if (calls.size || waiting.size) throw new Error("Copilot went idle before handing off its tool calls.")
            return finish()
          } else if (type === "session.error") {
            throw new Error(`Copilot session error: ${data.message ?? "unknown"}`)
          }
          if (usage && calls.size && calls.size === waiting.size && [...calls.keys()].every(id => waiting.has(id))) finish()
        } catch (error) { finish(error) }
      })
      start().catch(finish)
    })
  }

  private observeQuota(value: unknown) {
    if (!value || typeof value !== "object") return
    const state = value as Record<string, any>, budget = state.budgetMetadata
    const reset = Number(budget?.resetAtEpochMs), remaining = Number(budget?.remainingPercentage)
    if (typeof state.quotaId !== "string" || !Number.isFinite(reset) || !Number.isFinite(remaining) || budget?.unlimited) return
    this.quota.set(state.quotaId, { type: String(state.service || state.quotaId), ...(state.source ? { group: String(state.source) } : {}), utilization: Math.min(1, Math.max(0, 1 - remaining / 100)), resetsAt: reset, fetchedAt: state.observedAt ? Date.parse(state.observedAt) || Date.now() : Date.now() })
  }

  quotaFacts() {
    const windows = [...this.quota.values()]
    return { ...(windows.length ? { fetchedAt: Math.max(...windows.map(window => window.fetchedAt)) } : {}), windows: windows.map(({ type, group, utilization, resetsAt }) => ({ type, group, utilization, resetsAt })) }
  }

  private record(usage: CopilotUsage | undefined, error: boolean) {
    const now = Date.now()
    this.recent.push({ at: now, error, input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0, cached: usage?.cacheReadTokens ?? 0 })
    while (this.recent.length && now - this.recent[0]!.at > HOUR) this.recent.shift()
  }

  activity(): NonNullable<ProviderUsage["activity"]> {
    const since = Date.now() - HOUR
    const recent = this.recent.filter(entry => entry.at >= since)
    return { requests: recent.length, errors: recent.filter(entry => entry.error).length, inputTokens: recent.reduce((sum, entry) => sum + entry.input, 0), outputTokens: recent.reduce((sum, entry) => sum + entry.output, 0), cacheReadTokens: recent.reduce((sum, entry) => sum + entry.cached, 0) }
  }

  /** Non-blocking: a first call starts the SDK and reports loading. */
  facts(): { login?: string; models?: string[]; error?: string; loading: boolean } {
    if (!this.account && !this.error) void this.refresh().catch(() => {})
    else if (this.account && Date.now() - this.account.checkedAt >= 60_000) void this.refresh().catch(() => {})
    const allow = this.options.models
    return { login: this.account?.login, models: this.account?.models.filter(model => model.id !== "auto" && model.policy?.state !== "disabled" && (!allow?.length || allow.includes(model.id))).map(model => model.id), error: this.error, loading: !this.account && !this.error }
  }

  private evict() {
    const idle = [...this.sessions].filter(([key]) => !this.busy.has(key)).sort(([, a], [, b]) => a.lastUsed - b.lastUsed)
    while (this.sessions.size > (this.options.maxSessions ?? 8) && idle.length) {
      const [key, live] = idle.shift()!
      void this.drop(key, live)
    }
  }

  private async drop(key: string | undefined, live: LiveSession) {
    if (key && this.sessions.get(key) === live) this.sessions.delete(key)
    await this.closeSession(live).catch(() => {})
  }

  private async closeSession(live: LiveSession) {
    clearTimeout(live.expiry)
    // An idle session may have nothing to abort; disconnect regardless.
    try { await live.session.abort() } catch {}
    await live.session.disconnect()
  }

  abortAll(reason: Error) { for (const controller of this.rounds) controller.abort(reason) }

  async close(): Promise<void> {
    this.draining = true
    this.abortAll(new Error("Backend shutting down"))
    const started = this.starting
    this.starting = undefined
    await Promise.allSettled([...this.sessions.values()].map(live => this.closeSession(live)))
    this.sessions.clear()
    if (!started) return
    const { client, home } = await started.catch(() => ({ client: undefined, home: undefined }))
    try { await client?.stop() } finally { if (home) await rm(home, { recursive: true, force: true }) }
  }
}

export interface CopilotServer {
  app: { fetch(request: Request): Promise<Response> }
  providerStatus(): ProviderUsage
  beginDrain(): void
  forceAbortInFlight(): void
  getInFlightCount(): number
  closeBackend(): Promise<void>
}

function errorResponse(error: unknown): Response {
  const known = error instanceof CopilotError
  return Response.json({ error: { message: known ? error.message : `Copilot request failed: ${message(error)}`, type: known ? error.type : "api_error" } }, { status: known ? error.status : 502, headers: { "cache-control": "no-store" } })
}

function openAiUsage(usage: CopilotUsage) {
  if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) return undefined
  return { prompt_tokens: usage.inputTokens!, completion_tokens: usage.outputTokens!, total_tokens: usage.inputTokens! + usage.outputTokens!, ...(Number.isFinite(usage.cacheReadTokens) ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens! } } : {}) }
}

/** Routes arrive with the /copilot prefix already stripped by the host server. */
export function createCopilotServer(config: { copilot?: CopilotOptions }, runtime = new CopilotRuntime(config.copilot)): CopilotServer {
  async function chat(request: Request): Promise<Response> {
    let body: unknown
    try { body = await request.json() } catch { throw new CopilotError("Request body must be JSON.") }
    const parsed = parseCopilotRequest(body, request.headers)
    await runtime.check(parsed)
    const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000)
    if (!parsed.stream) {
      let content = "", reasoning = ""
      const round = await runtime.complete(parsed, { content: text => { content += text }, reasoning: text => { reasoning += text } }, request.signal)
      const usage = openAiUsage(round.usage)
      return Response.json({ id, object: "chat.completion", created, model: parsed.model,
        choices: [{ index: 0, message: { role: "assistant", content: content || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(round.calls.length ? { tool_calls: round.calls } : {}) }, finish_reason: round.finishReason }],
        ...(usage ? { usage } : {}) }, { headers: { "x-meridian-copilot-session": round.path } })
    }
    const encoder = new TextEncoder()
    const abort = new AbortController()
    const cancel = () => abort.abort(new Error("Client disconnected."))
    request.signal.addEventListener("abort", cancel, { once: true })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (value: unknown) => { try { controller.enqueue(encoder.encode(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`)) } catch {} }
        const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => write({ id, object: "chat.completion.chunk", created, model: parsed.model, choices: [{ index: 0, delta, finish_reason }] })
        chunk({ role: "assistant" })
        runtime.complete(parsed, { content: text => chunk({ content: text }), reasoning: text => chunk({ reasoning_content: text }) }, abort.signal).then(round => {
          if (round.calls.length) chunk({ tool_calls: round.calls.map((call, index) => ({ index, ...call })) })
          chunk({}, round.finishReason)
          const usage = openAiUsage(round.usage)
          if (parsed.includeUsage && usage) write({ id, object: "chat.completion.chunk", created, model: parsed.model, choices: [], usage })
          write("[DONE]")
        }, error => {
          if (!abort.signal.aborted) write({ error: { message: error instanceof CopilotError ? error.message : `Copilot request failed: ${message(error)}`, type: error instanceof CopilotError ? error.type : "api_error" } })
        }).finally(() => {
          request.signal.removeEventListener("abort", cancel)
          try { controller.close() } catch {}
        })
      },
      cancel,
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } })
  }

  async function messages(request: Request): Promise<Response> {
    let body: unknown
    try { body = await request.json() } catch { throw new CopilotError("Request body must be JSON.") }
    const parsed = parseCopilotAnthropicRequest(body, request.headers)
    await runtime.check(parsed)
    const id = `msg_${randomUUID()}`
    const usage = (value: CopilotUsage) => ({ input_tokens: value.inputTokens ?? 0, output_tokens: value.outputTokens ?? 0, ...(value.cacheReadTokens !== undefined ? { cache_read_input_tokens: value.cacheReadTokens } : {}) })
    const stop = (round: CopilotRound) => round.calls.length ? "tool_use" : round.finishReason === "length" ? "max_tokens" : "end_turn"
    const content = (round: CopilotRound, text: string, reasoning: string) => [
      ...(reasoning ? [{ type: "thinking", thinking: reasoning }] : []),
      ...(text ? [{ type: "text", text }] : []),
      ...round.calls.map(call => ({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })),
    ]
    if (!parsed.stream) {
      let text = "", reasoning = ""
      const round = await runtime.complete(parsed, { content: delta => { text += delta }, reasoning: delta => { reasoning += delta } }, request.signal)
      return Response.json({ id, type: "message", role: "assistant", model: parsed.model, content: content(round, text, reasoning), stop_reason: stop(round), stop_sequence: null, usage: usage(round.usage) }, { headers: { "x-meridian-copilot-session": round.path } })
    }
    const encoder = new TextEncoder(), abort = new AbortController()
    const cancel = () => abort.abort(new Error("Client disconnected."))
    request.signal.addEventListener("abort", cancel, { once: true })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (event: string, data: unknown) => { try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) } catch {} }
        let nextIndex = 0, reasoningIndex = -1, textIndex = -1
        write("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
        runtime.complete(parsed, {
          reasoning: delta => { if (reasoningIndex < 0) { reasoningIndex = nextIndex++; write("content_block_start", { type: "content_block_start", index: reasoningIndex, content_block: { type: "thinking", thinking: "" } }); } write("content_block_delta", { type: "content_block_delta", index: reasoningIndex, delta: { type: "thinking_delta", thinking: delta } }) },
          content: delta => { if (textIndex < 0) { textIndex = nextIndex++; write("content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } }); } write("content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: delta } }) },
        }, abort.signal).then(round => {
          if (reasoningIndex >= 0) write("content_block_stop", { type: "content_block_stop", index: reasoningIndex })
          if (textIndex >= 0) write("content_block_stop", { type: "content_block_stop", index: textIndex })
          round.calls.forEach(call => { const callIndex = nextIndex++; write("content_block_start", { type: "content_block_start", index: callIndex, content_block: { type: "tool_use", id: call.id, name: call.function.name, input: {} } }); write("content_block_delta", { type: "content_block_delta", index: callIndex, delta: { type: "input_json_delta", partial_json: call.function.arguments } }); write("content_block_stop", { type: "content_block_stop", index: callIndex }) })
          write("message_delta", { type: "message_delta", delta: { stop_reason: stop(round), stop_sequence: null }, usage: usage(round.usage) })
          write("message_stop", { type: "message_stop" })
        }, error => { if (!abort.signal.aborted) write("error", { type: "error", error: { type: error instanceof CopilotError ? error.type : "api_error", message: message(error) } }) }).finally(() => { request.signal.removeEventListener("abort", cancel); try { controller.close() } catch {} })
      }, cancel,
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } })
  }

  async function health(): Promise<Response> {
    const base = () => ({ backend: "copilot", preview: true, sdk: { package: "@microsoft/copilot-sdk", version: runtime.sdkVersion, verifiedVersion: VERIFIED_COPILOT_SDK_VERSION }, sessions: runtime.sessions.size, activeRounds: runtime.activeRounds,
      capabilities: { openai: ["chat-completions"], anthropic: ["messages"], text: true, clientTools: true, parallelTools: true, reasoning: "streamed-reasoning-content", images: "base64", documents: false, structuredOutput: false, forcedToolChoice: false, copilotBuiltInTools: false, byok: false, maxTokens: "ignored", temperature: "ignored", tokenCounting: "provider-reported", conversationReuse: "live-session", quota: "sdk-observed" } })
    if (runtime.draining) return Response.json({ status: "draining", ...base() }, { status: 503, headers: { "cache-control": "no-store" } })
    try {
      const account = await runtime.refresh()
      return Response.json({ status: "healthy", ...base(), account: { login: account.login } }, { headers: { "cache-control": "no-store" } })
    } catch (error) {
      return Response.json({ status: "unavailable", ...base(), error: message(error) }, { status: 503, headers: { "cache-control": "no-store" } })
    }
  }

  const fetch = async (request: Request): Promise<Response> => {
    try {
      const path = new URL(request.url).pathname
      if (request.method === "GET" && path === "/health") return await health()
      if (request.method === "GET" && path === "/v1/models") {
        const models = await runtime.models()
        return Response.json({ object: "list", data: models.map(model => ({ id: model.id, object: "model", owned_by: "github-copilot", ...(model.name ? { display_name: model.name } : {}) })) })
      }
      if (request.method === "POST" && path === "/v1/chat/completions") return await chat(request)
      if (request.method === "POST" && path === "/v1/messages") return await messages(request)
      throw new CopilotError("Endpoint unavailable on the Copilot backend. Use /copilot/v1/chat/completions.", 404, "not_found_error")
    } catch (error) { return errorResponse(error) }
  }

  return {
    app: { fetch },
    providerStatus(): ProviderUsage {
      const facts = runtime.facts()
      return { id: "copilot", name: "Copilot", enabled: true, status: runtime.draining ? "draining" : facts.error ? "unavailable" : facts.loading ? "loading" : "healthy", endpoint: "/copilot/v1/chat/completions", error: facts.error, models: facts.models,
        capabilities: [
          { name: "Preview", status: "Opt-in", detail: "Official @microsoft/copilot-sdk with the Copilot CLI sign-in. Copilot bills premium requests by its own rules and each model's multiplier; Meridian does not meter or cap them." },
          { name: "Client tools", status: "Available", detail: "Copilot built-in tools, repository instructions and hooks are off. Every tool call returns to the client, which runs it with its own approvals." },
          { name: "OpenAI clients", status: "Chat Completions", detail: "Text, client tools, base64 images and streamed reasoning. Documents, forced tool choice and structured output are rejected; max_tokens and temperature are ignored." },
          { name: "Anthropic clients", status: "Messages", detail: "Streaming and non-streaming /v1/messages compatibility, including client tools and base64 images." },
          { name: "Conversation reuse", status: "Live session", detail: "Exact continuations reuse a live Copilot session. Edits, prompt or tool changes and restarts replay history as text." },
        ],
        activity: runtime.activity(), accounts: [{ id: facts.login ? `@${facts.login}` : "Copilot account", active: true, ...runtime.quotaFacts() }] }
    },
    beginDrain: () => { runtime.draining = true },
    forceAbortInFlight: () => runtime.abortAll(new Error("Backend shutting down")),
    getInFlightCount: () => runtime.activeRounds,
    closeBackend: () => runtime.close(),
  }
}
