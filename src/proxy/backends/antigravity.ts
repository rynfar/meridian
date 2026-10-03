import { AgCompletedAnswers, agRequestId, replayAgAnswer } from "./antigravityReplay"
import { AgResponseJobs, agEventStream, responseEvents } from "./antigravityJobs"
import { estimateAgTokens } from "./antigravityTokens"
import { agOpenai } from "./antigravityOpenai"
import { AgResponseStore, agResponseScope } from "./antigravityResponses"
import { AgTextStops } from "./antigravityStops"
import { providerPageHtml } from '../../telemetry/providerPage'
import { withSavedLayout } from '../../telemetry/pageLayout'
import { ICON_PATH, iconResponse } from '../../telemetry/icon'
import { providerOverview, type ProviderUsage } from '../../telemetry/providerView'
import { providerSnapshot, disabledProvider } from './providerStatus'
import { randomUUID } from "node:crypto"
import type { ProxyConfig, ProxyServer } from "../types"
import { buildRuntime } from "../buildRuntime"
import { hasValidApiKey } from "../auth"
import { AntigravityRuntime, type AntigravityRun } from "./antigravityRuntime"
import { AntigravityError, forcedAgTool, toolChoiceInstruction, blocks, contractKey, historyKey, sameAgExecutionContract, parseAgRequest, type AgBlock, type AgResult, type AgRequest } from "./antigravityProtocol"

function errorResponse(error: unknown): Response {
  const e = error instanceof AntigravityError ? error : new AntigravityError(error instanceof Error ? error.message : String(error), 503, "api_error")
  return Response.json({ type: "error", error: { type: e.type, message: e.message } }, { status: e.status, headers: e.retryAfter ? { "retry-after": String(e.retryAfter) } : {} })
}
async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new AntigravityError("Missing request body")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []; let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      length += value.length
      if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new AntigravityError("Request exceeds 8 MiB", 413) }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch (error) {
    if (error instanceof AntigravityError) throw error
    throw new AntigravityError("Invalid JSON request body")
  } finally { reader.releaseLock() }
}

export function createAntigravityServer(config: ProxyConfig, runtime = new AntigravityRuntime({ ...config.antigravity, maxConcurrent: config.antigravity?.maxConcurrent ?? config.maxConcurrent })): ProxyServer & { closeBackend(): Promise<void>; providerStatus(): Promise<ProviderUsage> } {
  if (config.profiles?.length || config.defaultProfile) throw new Error("Antigravity does not support Claude profile configuration")
  const responses = new AgResponseStore(undefined, undefined, runtime.state)
  const completedAnswers = new AgCompletedAnswers(runtime.state)
  const responseJobs = new AgResponseJobs(responses)
  async function recoverResults(body: AgRequest, signal: AbortSignal, results: AgResult[], previous?: AntigravityRun): Promise<AntigravityRun> {
    // Claim before retiring the old owner: simultaneous HTTP retries must not
    // start competing replays while shutdown or account preflight is pending.
    for (const result of results) runtime.recoveringTools.add(result.tool_use_id)
    try {
      if (previous) {
        previous.busy = true
        previous.abort(new AntigravityError("Client plugin context changed; replaying completed tool history", 409), "retired")
        await previous.settled
      }
      if (signal.aborted) throw new AntigravityError("Request cancelled", 499, "api_error")
      const run = await runtime.create(body, signal)
      if (previous) run.continuation = "client-context-replay"
      runtime.forgetInterruptedContinuation(body)
      for (const result of results) runtime.rememberConsumedTool(result.tool_use_id)
      run.busy = true
      return run
    } finally {
      for (const result of results) runtime.recoveringTools.delete(result.tool_use_id)
    }
  }
  async function selectRun(body: AgRequest, signal: AbortSignal): Promise<AntigravityRun> {
    await runtime.waitForInterruptedContinuation(body)
    // Clients may append steering as text in the result message or as another
    // user message. Match the delivered assistant prefix before accepting either.
    const suffixStart = body.messages.findLastIndex(message => message.role === "assistant") + 1
    const suffix = body.messages.slice(suffixStart)
    const results = suffix.flatMap(blocks).filter(b => b.type === "tool_result")
    const owners = results.map(result => runtime.toolOwners.get(result.tool_use_id)).filter(run => run !== undefined)
    // An explicitly appended user turn may replay completed context. Duplicate
    // protection applies to result continuations, not unrelated new user input.
    const continuationResults = owners.length || blocks(body.messages.at(-1)!).some(block => block.type === "tool_result") ? results : []
    if (continuationResults.some(result => runtime.recoveringTools.has(result.tool_use_id)) || (continuationResults.some(result => runtime.hasConsumedTool(result.tool_use_id)) && !runtime.canRetryContinuation(body))) throw new AntigravityError("Antigravity tool result was already consumed; append the subsequent assistant response before continuing", 409)
    // A validated complete history is also a stateless recovery request. Only
    // correlate against live processes; never re-execute a tool on the client's behalf.
    if (owners.length) {
      const result = results[0]!
      const run = runtime.toolOwners.get(result.tool_use_id)
      if (!run) throw new AntigravityError("Antigravity continuation contains an unknown live tool", 409)
      if (run.busy) throw new AntigravityError("Antigravity turn already has an active response", 409)
      if (results.length !== run.delivered.length || results.some(result => !run.delivered.some(call => call.id === result.tool_use_id)) || owners.some(owner => owner !== run) || historyKey(run.history) !== historyKey(body.messages.slice(0, suffixStart))) {
        throw new AntigravityError("Pending Antigravity tool continuation changed its delivered history or tool batch", 409)
      }
      if (run.contract !== contractKey(body)) {
        if (!sameAgExecutionContract(run.request, body)) throw new AntigravityError("Pending Antigravity tool continuation changed its model, session or execution controls", 409)
        // A fresh official process installs the new MCP catalog and deny hook.
        // The old pending call never receives a result under a changed context.
        return recoverResults(body, signal, continuationResults, run)
      }
      const followup = suffix.map(message => ({ ...message, content: blocks(message).filter(b => b.type === "text" || b.type === "image" || b.type === "document" || b.type === "audio" || b.type === "video") })).filter(message => message.content.length > 0)
      if (JSON.stringify(run.request.tool_choice) !== JSON.stringify(body.tool_choice)) {
        followup.push({ role: "user", content: [{ type: "text", text: toolChoiceInstruction(body) }] })
      }
      run.request.tool_choice = body.tool_choice
      run.busy = true
      run.history = body.messages
      try { await run.accept(results, followup) }
      catch (error) {
        run.busy = false
        run.abort(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
      return run
    }
    return recoverResults(body, signal, continuationResults)
  }

  async function messages(request: Request, saveCompletedAnswers = true): Promise<Response> {
    if (runtime.draining) throw new AntigravityError("Antigravity is shutting down", 503, "api_error")
    if (request.headers.has("x-meridian-profile")) throw new AntigravityError("Antigravity uses the current agy account; Claude profile routing is unavailable")
    const body = parseAgRequest(await runtime.plugins.request(await readBody(request), request.signal), runtime.options.adaptThinkingBudgets)
    if (request.signal.aborted) throw new AntigravityError("Request cancelled", 499, "api_error")
    const adaptationHeaders: Record<string, string> = runtime.options.adaptThinkingBudgets ? {
      "x-meridian-thinking-budgets": "approximate-effort",
      "x-meridian-effective-model": body.model,
      ...(body.output_config?.effort ? { "x-meridian-effective-effort": body.output_config.effort } : {}),
    } : {}
    const scope = agResponseScope(request.headers)
    const canSaveAnswer = saveCompletedAnswers && !runtime.options.allowNativeBrowser && !runtime.options.allowNativeSubagents
    const requestId = saveCompletedAnswers ? agRequestId(body, request.headers) : undefined
    const replayOnly = request.headers.get("x-meridian-replay-only")
    if (replayOnly !== null && (replayOnly !== "true" || !requestId || !canSaveAnswer)) throw new AntigravityError("Cache-only recovery requires an identified Anthropic request with native grants disabled")
    if (requestId && !canSaveAnswer) throw new AntigravityError("Identified retries require native browser/subagent grants to be disabled")
    await completedAnswers.wait(body, scope, requestId, request.signal)
    if (runtime.draining) throw new AntigravityError("Antigravity is shutting down", 503, "api_error")
    if (request.signal.aborted) throw new AntigravityError("Request cancelled", 499, "api_error")
    const saved = canSaveAnswer ? completedAnswers.get(body, scope, requestId) : undefined
    if (saved) {
      const calls = saved.content.filter(block => block.type === "tool_use")
      if (calls.some(call => runtime.hasConsumedTool(call.id) || runtime.recoveringTools.has(call.id) || runtime.toolOwners.get(call.id)?.busy)) throw new AntigravityError("Saved tool calls are already being answered or consumed; continue with their results", 409)
      return replayAgAnswer(saved, body.stream === true, adaptationHeaders)
    }
    if (replayOnly) throw new AntigravityError("No saved response is available for this request", 404, "not_found_error")
    const release = completedAnswers.claim(body, scope, requestId)
    let run: AntigravityRun
    try { run = await selectRun(body, request.signal) } catch (error) { release(); throw error }
    let completed = false, cancelledDuringResponse = false
    const cancel = () => { if (!completed) { cancelledDuringResponse = true; run.abort(new AntigravityError("Request cancelled", 499, "api_error")) } }
    request.signal.addEventListener("abort", cancel, { once: true })
    if (request.signal.aborted) cancel()
    const started = Date.now()
    const id = "msg_agy_" + randomUUID().replaceAll("-", "")
    async function consume(emit?: (event: string, value: unknown) => void) {
      const content: AgBlock[] = []
      const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      let status = 200
      let failure: string | undefined
      let textOpen = false
      let emittedTool = false
      let reason: "end_turn" | "tool_use" | "stop_sequence" = "end_turn"
      const stops = new AgTextStops(body.stop_sequences ?? [])
      const base = { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage } }
      function emitText(text: string) {
        if (!textOpen) {
          content.push({ type: "text", text: "" }); textOpen = true
          emit?.("content_block_start", { type: "content_block_start", index: content.length - 1, content_block: { type: "text", text: "" } })
        }
        const tail = content.at(-1)
        if (tail?.type === "text") tail.text += text
        emit?.("content_block_delta", { type: "content_block_delta", index: content.length - 1, delta: { type: "text_delta", text: text } })
      }
      emit?.("message_start", { type: "message_start", message: base })
      try {
        while (true) {
          const event = await run.queue.next()
          if (event.kind === "error") throw event.error
          if (event.kind === "usage") { usage.input_tokens += event.input; usage.output_tokens += event.output; usage.cache_read_input_tokens += event.cache; continue }
          if (event.kind === "text") {
            if (forcedAgTool(body)) continue
            if (body.output_config?.format && body.stop_sequences?.some(stop => event.text.includes(stop))) throw new AntigravityError("A stop sequence occurs inside the structured result; truncation would violate the requested JSON schema", 422)
            const text = stops.push(event.text)
            if (text) emitText(text)
            if (!stops.matched) continue
            reason = "stop_sequence"
            await run.stopAtSequence()
          } else {
            const tail = stops.flush()
            if (tail) emitText(tail)
          }
          if (textOpen) { emit?.("content_block_stop", { type: "content_block_stop", index: content.length - 1 }); textOpen = false }
          if (event.kind === "tool") {
            emittedTool = true
            const calls = await run.toolBatch(event.call)
            for (const call of calls) if (body.tool_choice?.type === "none" || (body.tool_choice?.type === "tool" && body.tool_choice.name !== call.name)) throw new AntigravityError("Antigravity requested a tool excluded by tool_choice", 502, "api_error")
            const firstIndex = content.length
            content.push(...calls)
            run.markDelivered(calls)
            run.history = [...run.history, { role: "assistant", content }]
            reason = "tool_use"
            // Save the whole validated batch before exposing any client action.
            // If transport loss kills its owner, completed results can use history replay.
            await runtime.plugins.observe("onResponse", { ...base, content, stop_reason: reason, usage }, request.signal)
            if (requestId) {
              const output = content.filter(block => block.type === "text" || block.type === "tool_use")
              completedAnswers.put(body, scope, { ...base, content: output, stop_reason: reason, stop_sequence: null, usage }, requestId)
            }
            for (const [offset, call] of calls.entries()) {
            const index = firstIndex + offset
            emit?.("content_block_start", { type: "content_block_start", index, content_block: { ...call, input: {} } })
            emit?.("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } })
            emit?.("content_block_stop", { type: "content_block_stop", index })
            }
          }
          break
        }
        if (forcedAgTool(body) && reason !== "tool_use") throw new AntigravityError("Antigravity completed without the required tool call", 502, "api_error")
        if (reason === "end_turn") { run.history = [...run.history, { role: "assistant", content }]; run.rememberCompleted() }
        if (!emittedTool) await runtime.plugins.observe("onResponse", { ...base, content, stop_reason: reason, usage }, request.signal)
        const answer = { ...base, content, stop_reason: reason, stop_sequence: stops.matched ?? null, usage }
        const textContent = content.filter(block => block.type === "text")
        if (canSaveAnswer && !emittedTool && textContent.length === content.length) completedAnswers.put(body, scope, { ...answer, content: textContent }, requestId)
        emit?.("message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: stops.matched ?? null }, usage })
        emit?.("message_stop", { type: "message_stop" })
        return answer
      } catch (error) {
        status = error instanceof AntigravityError ? error.status : 502
        failure = error instanceof Error ? error.message : String(error)
        run.abort(error instanceof Error ? error : new Error(String(error)))
        throw error
      } finally {
        try {
          // Only retry an exact completed-result continuation after joining its
          // cancelled process, before any new tool call could reach the client.
          // Native actions cannot be proven side-effect-free, so never replay them.
          const suffix = body.messages.slice(body.messages.findLastIndex(message => message.role === "assistant") + 1)
          if (status === 499 && !emittedTool && !runtime.options.allowNativeBrowser && !runtime.options.allowNativeSubagents && suffix.flatMap(blocks).some(block => block.type === "tool_result")) {
            await runtime.recordInterruptedAfterJoin(body, run.settled)
          }
          const metric = { conversationId: run.conversationId ?? run.id, continuation: run.continuation, requestId: id, timestamp: started, durationMs: Date.now() - started, model: body.model, status, error: failure, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadTokens: usage.cache_read_input_tokens }
          runtime.record(metric)
          await runtime.plugins.observe("onTelemetry", metric, request.signal)
        } finally {
          completed = true
          run.busy = false
          request.signal.removeEventListener("abort", cancel)
          if (requestId && (status !== 200 || cancelledDuringResponse)) await run.settled
          release()
        }
      }
    }
    if (!body.stream) return Response.json(await consume(), { headers: adaptationHeaders })
    let cancelled = false
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: string, value: unknown) => {
          if (cancelled) return
          if ((controller.desiredSize ?? 0) <= 0) {
            cancelled = true
            const error = new AntigravityError("Streaming client is not reading; response buffer exceeded 1 MiB", 499, "api_error")
            run.abort(error); controller.error(error); throw error
          }
          const frame = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
          if (frame.byteLength > (controller.desiredSize ?? 0)) {
            cancelled = true
            const error = new AntigravityError("Streaming response exceeded its buffer budget", 502, "api_error")
            run.abort(error); controller.error(error); throw error
          }
          controller.enqueue(frame)
        }
        const heartbeat = setInterval(() => { try { emit("ping", { type: "ping" }) } catch (error) { run.abort(error instanceof Error ? error : new Error(String(error))) } }, 10000)
        heartbeat.unref()
        void consume(emit).catch(error => {
          emit("error", { type: "error", error: { type: error instanceof AntigravityError ? error.type : "api_error", message: String(error instanceof Error ? error.message : error), retry_after: error instanceof AntigravityError ? error.retryAfter : undefined } })
        }).finally(() => { clearInterval(heartbeat); if (!cancelled) controller.close() })
      },
      cancel() { cancelled = true; cancel() },
    }, { highWaterMark: 1024 * 1024, size: chunk => chunk?.byteLength ?? 0 })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", ...adaptationHeaders } })
  }

  async function providerStatus(): Promise<ProviderUsage> {
    const { quota, models, error, loading } = runtime.providerFacts()
    return { id: 'antigravity', name: 'Antigravity', enabled: true, status: runtime.draining ? 'draining' : error ? 'unavailable' : loading ? 'loading' : 'healthy', endpoint: config.backend === 'combined' ? '/antigravity/v1/messages' : '/v1/messages', error, models,
      capabilities: [
        { name: 'Conversation reuse', status: runtime.options.reuseConversations === false ? 'Disabled' : 'Available', detail: 'Exact continuations reuse a live CLI conversation. ' + (runtime.nativeSessions ? 'Completed text and client-tool sessions can restore after restart. ' : 'Restarts replay history. ') + 'Edits, expired sessions and ineligible native contexts replay history; cache hits depend on the provider.' },
        { name: 'Client tools', status: runtime.options.allowToolBridge ? 'Available' : 'Disabled', detail: 'Parallel batches, exact result correlation and client-side approval. Native actions have separate operator controls.' },
        { name: 'Native browser', status: runtime.options.allowNativeBrowser ? 'Operator enabled' : 'Disabled', detail: 'Isolated Chrome via Chrome DevTools MCP 1.9.0; requires both installed locally. Native actions bypass client approval dialogs.' },
        { name: 'Native subagents', status: runtime.options.allowNativeSubagents ? 'Operator enabled' : 'Disabled', detail: 'Self/research agents inherit the guarded workspace and enabled client tools. Browser delegation requires its separate grant.' },
        { name: 'OpenAI clients', status: 'Available', detail: 'Chat Completions and Responses with adapted media, namespaced/custom tools, JSON and streaming. Background Responses support polling and cancellation. Response IDs can continue recent stored turns; storage is bounded to 30 minutes. ' + (runtime.state ? 'Snapshots survive restarts.' : 'Snapshots clear on restart; set MERIDIAN_AGY_STATE_PATH for persistence.') + '' },
        { name: 'Documents and media', status: 'Local dependencies', detail: 'PDF pages use Poppler. Audio uses local Whisper; video uses sampled frames and a transcript. These are adapted inputs, not native multimodal understanding.' },
        { name: 'Token controls', status: 'Limited', detail: 'Token counts are estimates; output budgets are advisory. Exact token caps, numeric thinking budgets, sampling controls and native reasoning blocks are unavailable.' },
      ],
      activity: runtime.activity(), accounts: [{ id: 'Antigravity account', active: true, ...quota }] }
  }
  const fetch = async (request: Request): Promise<Response> => {
    try {
      const path = new URL(request.url).pathname
      if (!["/health", "/readyz", "/livez"].includes(path) && !hasValidApiKey(request.headers)) throw new AntigravityError("Invalid or missing API key", 401, "authentication_error")
      if (request.method === "GET" && path === "/build-status") return buildRuntime.local ? Response.json(buildRuntime.status(), { headers: { "Cache-Control": "no-store" } }) : new Response("Not found", { status: 404 })
      if (request.method === 'GET' && ['/', '/providers'].includes(path)) return new Response(withSavedLayout(providerPageHtml), { headers: { 'content-type': 'text/html; charset=utf-8' } })
      if (request.method === 'GET' && path === ICON_PATH) { const icon = iconResponse(); if (icon) return icon }
      if (request.method === 'GET' && ['/providers/status', '/providers/view'].includes(path)) {
        const data = providerSnapshot([disabledProvider('claude'), await providerStatus()])
        const filter = new URL(request.url).searchParams.get('provider')
        return path.endsWith('/status') ? Response.json(data) : new Response(providerOverview(data, filter === 'claude' || filter === 'antigravity' ? filter : 'all'), { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (request.method === 'GET' && path === '/telemetry/native-tools') return Response.json(runtime.nativeActivity)
      if (request.method === 'GET' && path === '/telemetry/requests') return Response.json(runtime.requests.map(r => ({ ...r, provider: 'antigravity', totalDurationMs: r.durationMs, cacheReadInputTokens: r.cacheReadTokens, adapter: 'antigravity', profileId: 'agy-account', tokens: { input: r.inputTokens, output: r.outputTokens, cacheRead: r.cacheReadTokens } })))
      if (request.method === 'GET' && path === '/telemetry/summary') return Response.json({ totalRequests: runtime.totals.requests, errorCount: runtime.totals.errors, tokenUsage: { totalInputTokens: runtime.totals.inputTokens, totalOutputTokens: runtime.totals.outputTokens, totalCacheReadTokens: runtime.totals.cacheReadTokens } })
      if (request.method === 'GET' && path === '/v1/usage/quota/all') return Response.json({ profiles: [{ id: 'agy-account', ...runtime.providerFacts().quota }] })
      if (request.method === 'GET' && path === '/profiles/list') return Response.json({ profiles: [{ id: 'agy-account', type: 'Antigravity', isActive: true }], activeProfile: 'agy-account' })
      if (request.method === 'GET' && path === '/plugins/list') { await runtime.plugins.init(); return Response.json(runtime.plugins.list()) }
      if (request.method === 'GET' && path === '/telemetry/logs') return Response.json([])
      if (request.method === 'GET' && path === '/settings/api/features') return Response.json({})
      if (request.method === "GET" && path === "/livez") return Response.json({ status: "alive" })
      if (request.method === "GET" && ["/health", "/readyz"].includes(path)) {
        if (runtime.draining) return Response.json({ status: "draining" }, { status: 503 })
        await runtime.initialize()
        await runtime.verifyAccount()
        return Response.json({ status: "healthy", version: config.version ?? "unknown", build: buildRuntime.info(config.version ?? "unknown"), backend: "antigravity", experimental: process.platform !== "darwin", support: { tier: process.platform === "darwin" ? "supported" : "preview", cliVersion: runtime.cliVersion, verifiedCliVersion: "1.2.7" }, mode: "passthrough", auth: { provider: "agy-account", verification: "cli-configuration" }, capabilities: { text: true, tools: !!runtime.options.allowToolBridge, images: !!runtime.options.allowToolBridge, urlImages: !!runtime.options.allowToolBridge, documents: "local-poppler", audio: "local-whisper", video: "local-frames-and-transcript", nativeReasoning: false, nativeBrowser: !!runtime.options.allowNativeBrowser, nativeSubagents: !!runtime.options.allowNativeSubagents, structuredOutput: true, stopSequences: "text", forcedToolChoice: !!runtime.options.allowToolBridge, persistentResume: runtime.nativeSessions && runtime.options.reuseConversations !== false ? "completed-text-and-client-tools" : false, conversationReuse: runtime.options.reuseConversations !== false ? "live-process" : false, parallelTools: true, tokenCounting: "estimate", openai: ["chat-completions", "responses"], responseStorage: runtime.state ? "durable-30m-bounded" : "process-local-30m-bounded", toolResultRecovery: "history-replay", idleToolReclamation: true, maxTokens: "advisory", thinkingBudgets: runtime.options.adaptThinkingBudgets ? "approximate-gemini-effort" : false }, processes: runtime.runs.size, activeProcesses: [...runtime.runs.values()].filter(run => run.active).length, pendingToolProcesses: [...runtime.runs.values()].filter(run => run.delivered.length > 0).length, stateError: runtime.stateError, preparing: runtime.preparing, reclaimed: runtime.reclaimed, reused: runtime.reused, restored: runtime.restored, completed: runtime.completed, failed: runtime.failed })
      }
      if (request.method === "GET" && path === "/v1/models") {
        const models = await runtime.availableModels()
        return Response.json({ object: "list", data: models.map(id => ({ id, type: "model", object: "model", display_name: id, owned_by: "antigravity" })), has_more: false, first_id: models[0], last_id: models.at(-1) })
      }
      if (request.method === "POST" && path === "/v1/messages/count_tokens") return Response.json(estimateAgTokens(parseAgRequest(await readBody(request), runtime.options.adaptThinkingBudgets)), { headers: { "x-meridian-token-count": "estimate" } })
      if (request.method === "POST" && path === "/v1/responses/input_tokens") return await agOpenai(request, await readBody(request), true, request => messages(request, false), responses, responseJobs, { countTokens: true })
      const storedResponse = /^\/v1\/responses\/(resp_agy_[a-f0-9]{32})(?:\/(input_items|cancel))?$/.exec(path)
      if (storedResponse) {
        const id = storedResponse[1]!, operation = storedResponse[2]
        const scope = agResponseScope(request.headers)
        const params = new URL(request.url).searchParams
        if (request.method === 'POST' && operation === 'cancel') return Response.json(await responseJobs.cancel(id, scope))
        if (request.method === 'DELETE' && !operation) {
          const current = responses.get(id, scope)
          if (current.response.background === true) await responseJobs.cancel(id, scope)
          return Response.json(responses.delete(id, scope))
        }
        if (request.method === 'GET') {
          const current = responses.get(id, scope)
          if (operation === 'input_items') {
            if ([...params.keys()].some(key => !['limit', 'order', 'after', 'before'].includes(key))) throw new AntigravityError('Unsupported input_items query option')
            const limit = Number(params.get('limit') ?? 20), order = params.get('order') ?? 'desc'
            if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !['asc', 'desc'].includes(order)) throw new AntigravityError('Invalid input_items limit/order')
            let items = current.input.map((value, index) => ({ ...Object(value), id: typeof Object(value).id === 'string' ? String(Object(value).id) : `item_${id}_${index}`, type: Object(value).type ?? 'message' }))
            if (order === 'desc') items.reverse()
            for (const direction of ['after', 'before']) {
              const cursor = params.get(direction)
              if (cursor) { const index = items.findIndex(item => item.id === cursor); if (index < 0) throw new AntigravityError('Unknown input_items cursor'); items = direction === 'after' ? items.slice(index + 1) : items.slice(0, index) }
            }
            const data = items.slice(0, limit)
            return Response.json({ object: 'list', data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: items.length > limit }, { headers: { 'cache-control': 'no-store' } })
          }
          if (operation) throw new AntigravityError('Unsupported response operation')
          if ([...params.keys()].some(key => !['stream', 'starting_after'].includes(key))) throw new AntigravityError('Unsupported response query option')
          if (params.has('stream') && !['true', 'false'].includes(params.get('stream')!)) throw new AntigravityError('stream must be true or false')
          const after = Number(params.get('starting_after') ?? -1)
          if (!Number.isInteger(after) || after < -1 || (params.has('starting_after') && params.get('stream') !== 'true')) throw new AntigravityError('starting_after requires stream=true and an integer cursor')
          if (params.get('stream') === 'true') return current.response.background === true ? responseJobs.stream(id, scope, after, request.signal) : agEventStream(current.events ?? responseEvents(current.response), after)
          return Response.json(current.response, { headers: { 'cache-control': 'no-store' } })
        }
      }
      if (request.method === "POST" && ["/v1/chat/completions", "/v1/responses"].includes(path)) return await agOpenai(request, await readBody(request), path === "/v1/responses", request => messages(request, false), responses, responseJobs)
      if (request.method === "POST" && ["/v1/messages", "/messages"].includes(path)) return await messages(request)
      return errorResponse(new AntigravityError("Endpoint unavailable on the Antigravity backend", 404, "not_found_error"))
    } catch (error) { return errorResponse(error) }
  }
  return {
    app: { fetch }, config, providerStatus,
    initPlugins: () => runtime.initialize(),
    beginDrain: () => { runtime.draining = true },
    forceAbortInFlight: () => { for (const run of runtime.runs.values()) run.abort(new Error("Backend shutting down")) },
    getInFlightCount: () => [...runtime.runs.values()].filter(run => run.active).length,
    closeBackend: async () => { try { await responseJobs.close(); await runtime.close() } finally { await completedAnswers.drain(); responses.clear(); completedAnswers.clear(); runtime.state?.close() } },
  }
}
