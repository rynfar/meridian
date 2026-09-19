import { agNativeTools, agNativeAllowed } from "./antigravityNative"
import { agHookCommand, signalAgProcess } from "./antigravityProcess"
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process"
import { promisify } from "node:util"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { z } from "zod"
import { AgEventQueue, AntigravityError, classifyAgFailure, availableAgTools, parallelAgTool, hasAgImages, renderAgPrompt, contractKey, historyKey, stable, type AgRequest, type AgMessage, type AgCall, type AgResult } from "./antigravityProtocol"

import { AgSchemaCompiler, agSchemaError, agUpstreamSchema } from "./antigravitySchema"
import type { ValidateFunction } from "ajv"
import { AgAttachments } from "./antigravityAttachments"
import type { AntigravityOptions } from "../types"
type AgToolReply = AgResult & { clientMessages?: AgMessage[] }

export interface AgExchange {
  requestId: string; timestamp: number; durationMs: number; model: string; status: number; error?: string;
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
}
const quotaSchema = z.object({ command: z.object({ data: z.object({ groups: z.array(z.object({
  name: z.string(), buckets: z.array(z.object({ id: z.string(), window: z.string(), remaining_fraction: z.number().min(0).max(1), reset_time: z.string() })),
})) }) }) })
export interface AgQuota { fetchedAt?: number; error?: string; windows: Array<{ type: string; group: string; utilization: number; resetsAt: number }> }
const exec = promisify(execFile)
const envelope = z.object({
  event: z.string(),
  step_update: z.object({ step_type: z.string().optional(), tool_name: z.string().optional(), state: z.string().optional(), text_delta: z.string().optional(), usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_tokens: z.number().optional() }).optional() }).optional(),
  result: z.object({ status: z.string(), error: z.string().optional(), denied_actions: z.array(z.unknown()).optional(), structured_output: z.unknown().optional() }).optional(),
})
const rpcSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() })
const toolParams = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) })

function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value))
}


export class AntigravityRun {
  readonly id = randomUUID()
  readonly queue = new AgEventQueue()
  readonly rpcSessions = new Set<string>()
  readonly contract: string
  history: AgMessage[]
  busy = false
  delivered: AgCall[] = []
  child?: ChildProcessWithoutNullStreams
  private workspace?: string
  private attachments?: AgAttachments
  private readonly attachmentAbort = new AbortController()
  private stopped = false
  private terminal = false
  private idle = false
  private outputBytes = 0
  readonly reusable: boolean
  private structuredText?: string
  private readonly toolValidators = new Map<string, ValidateFunction>()
  private readonly outputValidator?: ValidateFunction
  private exited = false
  private cleaning?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private pendingTimer?: ReturnType<typeof setTimeout>
  private killTimer?: ReturnType<typeof setTimeout>
  private readonly pending = new Map<string, { call: AgCall; resolve: (result: AgToolReply) => void; reject: (error: Error) => void }>()
  private toolCalls = 0
  private readonly rpcCalls = new Map<string, { identity: string; result: Promise<AgToolReply> }>()
  private settledResolve!: () => void
  readonly settled = new Promise<void>(resolve => { this.settledResolve = resolve })
  constructor(readonly runtime: AntigravityRuntime, readonly request: AgRequest) {
    this.reusable = runtime.options.reuseConversations !== false && !request.output_config?.format && !request.stop_sequences?.length
    this.history = request.messages
    this.contract = contractKey(request)
    const schemas = new AgSchemaCompiler()
    for (const tool of request.tools) this.toolValidators.set(tool.name, schemas.compile(tool.input_schema, `Tool ${tool.name}`))
    if (request.output_config?.format) this.outputValidator = schemas.compile(request.output_config.format.schema, "output_config.format.schema")
  }
  private prompt(request: AgRequest): string {
    const native = agNativeTools(this.runtime.options)
    return renderAgPrompt(request, native) + (this.runtime.options.allowNativeBrowser ? "\nFor browser work, invoke_subagent with TypeName browser and Workspace inherit. Its chrome_devtools MCP tools are enabled; ordinary self agents may not have that browser tool catalog." : "")
  }
  async start(): Promise<void> {
      this.timer = setTimeout(() => this.abort(new AntigravityError("Antigravity turn timed out", 504, "api_error")), this.runtime.turnTimeoutMs)
      this.timer.unref()
    try {
      this.workspace = await realpath(await mkdtemp(join(tmpdir(), "meridian-agy-")))
      await mkdir(join(this.workspace, ".agents"))
      const tools = [...this.request.tools, ...[parallelAgTool({ ...this.request, tool_choice: { type: "auto" } })].filter(tool => tool !== undefined)]
      this.attachments = new AgAttachments(this.workspace, this.attachmentAbort.signal)
      const messages = await this.attachments.messages(this.request.messages)
      const hookPath = join(this.workspace, "policy.cjs")
      // Workspace contains bridge configuration and supplied attachment bytes only.
      // Permit client MCP dispatch, exact supplied image reads, or schema submission.
      await writeFile(hookPath, `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{try{const p=JSON.parse(input);const t=p.toolCall;const a=t?.args;const allowed=(${agNativeAllowed.toString()})(t?.name,a,${JSON.stringify(agNativeTools(this.runtime.options))},${!!this.runtime.options.allowNativeBrowser},${!!this.runtime.options.allowNativeSubagents})||(t?.name==='call_mcp_tool'&&a?.ServerName==='meridian_client'&&${JSON.stringify(tools.map(t => t.name))}.includes(a?.ToolName))||(t?.name==='finish'&&${Boolean(this.request.output_config?.format)})||(t?.name==='view_file'&&JSON.parse(require('node:fs').readFileSync(${JSON.stringify(join(this.workspace, 'attachment-paths.json'))},'utf8')).includes(a?.AbsolutePath));const fs=require('node:fs');const audit=${JSON.stringify(join(this.workspace, 'policy-audit.jsonl'))};if(!fs.existsSync(audit)||fs.statSync(audit).size<65536)fs.appendFileSync(audit,JSON.stringify({name:t?.name,allowed,conversationId:p.conversationId})+'\\n',{mode:384});console.log(JSON.stringify({decision:allowed?'allow':'deny',reason:'Meridian restricts tools to client dispatch, supplied attachments, schema submission and operator-enabled native capabilities'}));}catch(e){console.log(JSON.stringify({decision:'deny',reason:'Invalid Meridian hook payload'}));}});`)
      await writeFile(join(this.workspace, ".agents/hooks.json"), JSON.stringify({ meridian_policy: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: agHookCommand(process.execPath, hookPath), timeout: 5 }] }] } }))
      await writeFile(join(this.workspace, ".agents/mcp_config.json"), JSON.stringify({ mcpServers: {
        meridian_client: { serverUrl: `${this.runtime.mcpUrl}/${this.id}` },
        ...(this.runtime.options.allowNativeBrowser ? { chrome_devtools: {
          command: this.runtime.options.browserMcpExecutable ?? "chrome-devtools-mcp",
          args: ["--headless", "--isolated", "--no-usage-statistics", "--no-performance-crux", "--filesystem-root", this.workspace],
        } } : {}),
      } }))
      if (this.stopped) { await this.cleanup(); return }
      const args = ["--new-project", "--add-dir", this.workspace, "--input-format", "stream-json", "--model", this.request.model, "--output-format", "stream-json", "--print-timeout", `${Math.ceil(this.runtime.turnTimeoutMs / 1000)}s`, "--disable-slash-commands", "--sandbox"]
      if (this.request.output_config?.format) {
        const schemaPath = join(this.workspace, "output-schema.json")
        await writeFile(schemaPath, JSON.stringify(agUpstreamSchema(this.request.output_config.format.schema)))
        args.push("--json-schema", schemaPath)
      }
      if (this.request.output_config?.effort) args.push("--effort", this.request.output_config.effort)
      if (agNativeTools(this.runtime.options).length || (this.request.tools.length && this.runtime.options.allowToolBridge) || this.attachments.present) args.push("--dangerously-skip-permissions")
      if (this.stopped) { await this.cleanup(); return }
      const child = this.child = spawn(this.runtime.executable, args, { cwd: this.workspace, env: this.runtime.childEnv, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true })
      child.stdin.on("error", error => this.abort(new AntigravityError(`Antigravity input failed: ${error.message}`, 502, "api_error")))
      child.stdin.write(JSON.stringify({ event: "user", message: { content: this.prompt({ ...this.request, messages }) } }) + "\n")
      if (!this.reusable) child.stdin.end()
      let stderr = ""
      child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8192) })
      child.stdout.on("data", chunk => {
        this.outputBytes += chunk.length
        if (this.outputBytes > 16 * 1024 * 1024) this.abort(new AntigravityError("Antigravity output exceeded 16 MiB", 502, "api_error"))
      })
      const lines = createInterface({ input: child.stdout })
      lines.on("line", line => {
        if (this.stopped) return
        try {
          if (this.terminal) throw new Error("CLI emitted data after its terminal result")
          const event = envelope.parse(JSON.parse(line))
          const step = event.step_update
          if ((step?.step_type === "tool" || step?.step_type === "subagent") && step.tool_name && agNativeTools(this.runtime.options).includes(step.tool_name)) this.runtime.recordNative({ runId: this.id, name: step.tool_name, state: step.state ?? "unknown", timestamp: Date.now() })
          if (step?.step_type === "agent_response" && step.text_delta && !this.request.output_config?.format) this.queue.push({ kind: "text", text: step.text_delta })
          if (step?.state === "DONE" && step.usage) this.queue.push({ kind: "usage", input: step.usage.input_tokens ?? 0, output: step.usage.output_tokens ?? 0, cache: step.usage.cache_read_tokens ?? 0 })
          if (event.event === "result" && event.result) {
            this.terminal = true
            if (event.result.status !== "SUCCESS" || event.result.denied_actions?.length) {
              this.abort(classifyAgFailure(event.result.error || "Antigravity denied an action; client-owned tool policy or account permission prevented completion"))
            } else if (this.pending.size) this.abort(new AntigravityError("Antigravity ended with unresolved client tools", 502, "api_error"))
            // Success is committed only after a clean process exit, not merely a result line.
            else if (this.request.output_config?.format) {
              if (!Object.hasOwn(event.result, "structured_output") || event.result.structured_output === undefined) throw new Error("CLI omitted required structured_output")
              const invalid = this.outputValidator && agSchemaError(this.outputValidator, event.result.structured_output)
              if (invalid) throw new Error("CLI structured_output did not satisfy the requested schema: " + invalid)
              this.structuredText = JSON.stringify(event.result.structured_output)
            }
            if (!this.stopped && this.reusable) {
              this.runtime.completed++
              clearTimeout(this.timer)
              this.idle = true
              this.queue.push({ kind: "end" })
              this.pendingTimer = setTimeout(() => this.abort(new Error("Idle conversation expired"), "retired"), this.runtime.pendingToolTimeoutMs)
              this.pendingTimer.unref()
            }
          }
        } catch (error) { this.abort(new AntigravityError(`Invalid Antigravity stream: ${String(error)}`, 502, "api_error")) }
      })
      child.once("error", error => this.abort(new AntigravityError(`Cannot start agy: ${error.message}`, 503, "api_error")))
      child.once("close", (code, signal) => {
        this.exited = true
        if (this.terminal && !this.stopped && !this.reusable) {
          if (code !== 0 || signal) this.abort(classifyAgFailure("Antigravity exited unsuccessfully after its result"))
          else {
            this.runtime.completed++
            if (this.structuredText !== undefined) this.queue.push({ kind: "text", text: this.structuredText })
            this.queue.push({ kind: "end" })
          }
        }
        if (!this.terminal && !this.stopped) this.abort(classifyAgFailure(`Antigravity exited without a result${stderr ? ": " + stderr.slice(-1000) : ""}`))
        if (this.reusable && !this.stopped) this.abort(new Error("Native conversation process exited"), this.idle ? "retired" : "failed")
        void this.cleanup()
      })

    } catch (error) {
      this.abort(error instanceof Error ? error : new Error(String(error)))
      await this.cleanup()
      throw error
    }
  }
  dispatchCall(id: string | number, name: string, input: Record<string, unknown>): Promise<AgToolReply> {
    const key = typeof id + ':' + id
    const identity = stable({ name, input })
    const existing = this.rpcCalls.get(key)
    if (existing) {
      if (existing.identity !== identity) return Promise.reject(new Error("MCP request ID was reused for a different tool call"))
      return existing.result
    }
    if (this.rpcCalls.size >= 256) return Promise.reject(new Error("Antigravity turn exceeded 256 tool calls"))
    const result = this.call(name, input)
    this.rpcCalls.set(key, { identity, result })
    return result
  }
  dispatchBatch(id: string | number, input: Record<string, unknown>): Promise<AgToolReply> {
    const parsed = z.object({ calls: z.array(toolParams).min(2).max(16) }).strict().parse(input)
    const key = typeof id + ':' + id
    const identity = stable({ batch: parsed })
    const existing = this.rpcCalls.get(key)
    if (existing) return existing.identity === identity ? existing.result : Promise.reject(new Error("MCP request ID was reused for a different tool call"))
    if (this.rpcCalls.size >= 256) return Promise.reject(new Error("Antigravity turn exceeded 256 tool calls"))
    if (this.pending.size + parsed.calls.length > 32) return Promise.reject(new Error("Too many outstanding tools"))
    const allowed = availableAgTools(this.request)
    for (const call of parsed.calls) {
      const validator = this.toolValidators.get(call.name)
      if (!allowed.some(tool => tool.name === call.name) || !validator) return Promise.reject(new Error("Unknown or excluded client tool"))
      const invalid = agSchemaError(validator, call.arguments)
      if (invalid) return Promise.reject(new Error(`Invalid arguments for ${call.name}: ${invalid}`))
    }
    if (this.toolCalls + parsed.calls.length > 256) return Promise.reject(new Error("Antigravity conversation exceeded 256 client tool calls"))
    const result = Promise.all(parsed.calls.map(call => this.call(call.name, call.arguments))).then(results => ({ type: "tool_result" as const, tool_use_id: "batch", content: JSON.stringify(results.map((result, index) => ({ name: parsed.calls[index]!.name, input: parsed.calls[index]!.arguments, result: result.content, is_error: result.is_error ?? false, clientMessages: result.clientMessages }))) }))
    this.rpcCalls.set(key, { identity, result })
    return result
  }
  async call(name: string, input: Record<string, unknown>): Promise<AgToolReply> {
    if (this.stopped || this.terminal) throw new Error("Turn is closed")
    const validate = this.toolValidators.get(name)
    if (!validate) throw new Error("Unknown client tool")
    const invalid = agSchemaError(validate, input)
    if (invalid) throw new Error(`Invalid arguments for ${name}; correct them to match the supplied schema: ${invalid}`)
    if (this.pending.size >= 32) throw new Error("Too many outstanding tools")
    if (this.toolCalls >= 256) throw new Error("Antigravity conversation exceeded 256 client tool calls")
    this.toolCalls++
    const call: AgCall = { type: "tool_use", id: "toolu_agy_" + randomUUID().replaceAll("-", ""), name, input }
    return new Promise((resolve, reject) => {
      this.pending.set(call.id, { call, resolve, reject })
      this.runtime.toolOwners.set(call.id, this)
      this.queue.push({ kind: "tool", call })
    })
  }
  get active(): boolean { return !this.idle && !this.stopped }
  get reclaimable(): boolean { return !this.busy && (this.delivered.length > 0 || this.idle) && !this.stopped }
  matches(request: AgRequest): boolean {
    return this.reusable && this.toolCalls < 128 && this.idle && !this.stopped && !this.busy && request.messages.length > this.history.length &&
      this.contract === contractKey(request) && historyKey(this.history) === historyKey(request.messages.slice(0, this.history.length)) &&
      request.messages.slice(this.history.length).every(message => message.role === "user")
  }
  async resume(request: AgRequest, signal?: AbortSignal): Promise<void> {
    this.busy = true
    this.idle = false
    clearTimeout(this.pendingTimer)
    this.timer = setTimeout(() => this.abort(new AntigravityError("Antigravity turn timed out", 504, "api_error")), this.runtime.turnTimeoutMs)
    this.timer.unref()
    const cancel = () => this.abort(new AntigravityError("Request cancelled", 499, "api_error"))
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()
    try {
      await this.runtime.verifyAccount()
      const delta = await this.attachments!.messages(request.messages.slice(this.history.length))
      if (this.stopped || signal?.aborted || this.runtime.draining) throw new AntigravityError("Native conversation is no longer available", 409)
      Object.assign(this.request, request)
      this.history = request.messages
      this.terminal = false; this.idle = false; this.outputBytes = 0
      this.child!.stdin.write(JSON.stringify({ event: "user", message: { content: this.prompt({ ...request, messages: delta }) } }) + "\n")
      this.runtime.reused++
    } catch (error) {
      this.abort(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally { signal?.removeEventListener("abort", cancel) }
  }
  markDelivered(calls: AgCall[]): void {
    this.delivered = calls
    this.pendingTimer = setTimeout(() => this.abort(new AntigravityError("Client tool result deadline expired; completed history can be replayed", 409, "invalid_request_error")), this.runtime.pendingToolTimeoutMs)
    this.pendingTimer.unref()
  }
  async toolBatch(first: AgCall): Promise<AgCall[]> {
    if (this.request.tool_choice && "disable_parallel_tool_use" in this.request.tool_choice && this.request.tool_choice.disable_parallel_tool_use) return [first]
    // The CLI has no batch-end frame. Coalesce calls already in flight for one
    // bounded scheduling window; later calls remain queued for the next response.
    await new Promise(resolve => setTimeout(resolve, 25))
    return [first, ...this.queue.takeQueuedTools()]
  }
  async accept(results: AgResult[], clientMessages: AgMessage[] = []): Promise<void> {
    if (results.length !== this.delivered.length || results.some(result => !this.delivered.some(call => call.id === result.tool_use_id))) throw new AntigravityError("Tool results must match the entire delivered batch", 409)
    if (hasAgImages([{ role: "user", content: results }, ...clientMessages]) && !this.runtime.options.allowToolBridge) throw new AntigravityError("Images require explicit MERIDIAN_AGY_ALLOW_TOOL_BRIDGE=1")
    // Prepare the whole batch before resolving anything: malformed attachments
    // must never partially execute a continuation.
    const prepared: AgResult[] = []
    for (const result of results) prepared.push(await this.attachments!.toolResult(result))
    const messages = await this.attachments!.messages(clientMessages)
    if (this.stopped || results.some(result => !this.pending.has(result.tool_use_id))) throw new AntigravityError("Tool result was not requested by this turn", 409)
    clearTimeout(this.pendingTimer)
    this.delivered = []
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!
      const pending = this.pending.get(result.tool_use_id)!
      this.pending.delete(result.tool_use_id)
      this.runtime.rememberConsumedTool(result.tool_use_id)
      this.runtime.toolOwners.delete(result.tool_use_id)
      pending.resolve({ ...prepared[index]!, clientMessages: index === 0 ? messages : [] })
    }
  }
  async stopAtSequence(): Promise<void> {
    this.abort(new AntigravityError("Client stop sequence reached", 499, "api_error"), "completed")
    await this.settled
  }
  abort(error: Error, outcome: "failed" | "completed" | "reclaimed" | "retired" = "failed"): void {
    if (this.stopped) return
    this.stopped = true
    this.attachmentAbort.abort()
    if (outcome === "failed") this.runtime.failed++
    else if (outcome === "reclaimed") this.runtime.reclaimed++
    else if (outcome === "completed" && !this.exited) this.runtime.completed++
    this.queue.fail(error)
    for (const [id, pending] of this.pending) { this.runtime.toolOwners.delete(id); pending.reject(error) }
    this.pending.clear()
    clearTimeout(this.timer); clearTimeout(this.pendingTimer)
    if (this.child?.pid && !this.exited) {
      this.signal("SIGTERM")
      this.killTimer = setTimeout(() => this.signal("SIGKILL"), 1000)
      this.killTimer.unref()
    }
  }
  private signal(signal: NodeJS.Signals): void {
    if (!this.child?.pid) return
    signalAgProcess(this.child, signal)
  }
  private cleanup(): Promise<void> {
    this.cleaning ??= this.cleanupOnce()
    return this.cleaning
  }
  private async cleanupOnce(): Promise<void> {
    clearTimeout(this.timer); clearTimeout(this.pendingTimer); clearTimeout(this.killTimer)
    this.runtime.runs.delete(this.id)
    try { if (this.workspace) await rm(this.workspace, { recursive: true, force: true }) }
    catch (error) { console.error("[antigravity] Temporary workspace cleanup failed:", String(error)) }
    this.settledResolve()
  }
}

export class AntigravityRuntime {
  readonly executable: string
  readonly turnTimeoutMs: number
  readonly pendingToolTimeoutMs: number
  readonly maxConcurrent: number
  readonly childEnv: NodeJS.ProcessEnv
  // Warm live conversations; expired or restarted processes replay client history.
  readonly runs = new Map<string, AntigravityRun>()
  readonly toolOwners = new Map<string, AntigravityRun>()
  // Bounded duplicate protection, not a durable or exactly-once execution ledger.
  private readonly consumedTools = new Set<string>()
  readonly recoveringTools = new Set<string>()
  hasConsumedTool(id: string): boolean { return this.consumedTools.has(createHash("sha256").update(id).digest("hex")) }
  rememberConsumedTool(id: string): void {
    // Recovered IDs are client-supplied; retain fixed-size digests, never large strings.
    this.consumedTools.add(createHash("sha256").update(id).digest("hex"))
    if (this.consumedTools.size > 4096) this.consumedTools.delete(this.consumedTools.values().next().value!)
  }
  mcpUrl = ""
  draining = false
  cliVersion = ""
  reused = 0
  reclaimed = 0
  completed = 0
  failed = 0
  preparing = 0
  readonly nativeActivity: Array<{ runId: string; name: string; state: string; timestamp: number }> = []
  recordNative(event: { runId: string; name: string; state: string; timestamp: number }): void { this.nativeActivity.unshift(event); this.nativeActivity.length = Math.min(this.nativeActivity.length, 500) }
  readonly requests: AgExchange[] = []
  private readonly activityBuckets = new Map<number, { requests: number; errors: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>()
  readonly totals = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  private quota: AgQuota = { windows: [] }
  private quotaCheckedAt = 0
  private quotaCheck?: Promise<AgQuota>
  private statusRefresh?: Promise<void>
  private statusCheckedAt = 0
  private providerError?: string
  private readonly shutdown = new AbortController()
  private server?: Server
  private initialization?: Promise<void>
  private models: string[] = []
  private checkedAt = 0
  private verifying?: Promise<void>
  private checking?: Promise<string[]>
  private closing?: Promise<void>
  constructor(readonly options: AntigravityOptions = {}) {
    this.executable = options.executable ?? "agy"
    this.maxConcurrent = options.maxConcurrent ?? 4
    this.turnTimeoutMs = options.turnTimeoutMs ?? 300_000
    this.pendingToolTimeoutMs = options.pendingToolTimeoutMs ?? 60_000
    for (const value of [this.maxConcurrent, this.turnTimeoutMs, this.pendingToolTimeoutMs]) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Antigravity limits must be positive integers")
    this.childEnv = { ...process.env }
    for (const key of Object.keys(this.childEnv)) if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GENAI_USE_.*|GOOGLE_GEMINI_BASE_URL|ANTHROPIC_.*|MERIDIAN_API_KEY)$/.test(key)) delete this.childEnv[key]
  }
  record(exchange: AgExchange): void {
    this.requests.unshift(exchange)
    this.requests.length = Math.min(this.requests.length, 500)
    const minute = Math.floor(exchange.timestamp / 60000)
    const bucket = this.activityBuckets.get(minute) ?? { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    bucket.requests++; if (exchange.status >= 400) bucket.errors++
    bucket.inputTokens += exchange.inputTokens; bucket.outputTokens += exchange.outputTokens; bucket.cacheReadTokens += exchange.cacheReadTokens
    this.activityBuckets.set(minute, bucket)
    this.activity()
    this.totals.requests++; if (exchange.status >= 400) this.totals.errors++
    this.totals.inputTokens += exchange.inputTokens; this.totals.outputTokens += exchange.outputTokens; this.totals.cacheReadTokens += exchange.cacheReadTokens
  }
  activity() {
    const oldest = Math.floor(Date.now() / 60000) - 59
    const result = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    for (const [minute, bucket] of this.activityBuckets) {
      if (minute < oldest) { this.activityBuckets.delete(minute); continue }
      for (const key of Object.keys(result) as Array<keyof typeof result>) result[key] += bucket[key]
    }
    return result
  }
  providerFacts() {
    if (!this.draining && !this.statusRefresh && Date.now() - this.statusCheckedAt >= 10000) {
      this.statusCheckedAt = Date.now()
      this.statusRefresh = Promise.all([this.accountQuota(), this.availableModels()]).then(() => { this.providerError = undefined }).catch(error => { this.providerError = error instanceof Error ? error.message : String(error) }).finally(() => { this.statusRefresh = undefined })
    }
    return { quota: this.quota, models: this.models, error: this.providerError || this.quota.error, loading: !this.quota.fetchedAt && !this.quota.error && !this.providerError }
  }
  async accountQuota(): Promise<AgQuota> {
    if (Date.now() - this.quotaCheckedAt < (this.quota.error ? 10_000 : 60_000)) return this.quota
    this.quotaCheck ??= (async () => {
      try {
        await this.verifyAccount()
        const result = await exec(this.executable, ["-p", "/usage", "--output-format", "json"], { env: this.childEnv, timeout: 20_000, maxBuffer: 1024 * 1024, signal: this.shutdown.signal })
        const groups = quotaSchema.parse(JSON.parse(result.stdout)).command.data.groups
        const windows = groups.flatMap(group => group.buckets.map(bucket => ({ type: bucket.id, group: group.name, utilization: 1 - bucket.remaining_fraction, resetsAt: Date.parse(bucket.reset_time) })))
        if (windows.some(window => !Number.isFinite(window.resetsAt))) throw new Error("CLI returned an invalid quota reset time")
        this.quota = { fetchedAt: Date.now(), windows }
      } catch (error) { this.quota = { ...this.quota, error: error instanceof Error ? error.message : String(error) } }
      this.quotaCheckedAt = Date.now()
      return this.quota
    })().finally(() => { this.quotaCheck = undefined })
    return this.quotaCheck
  }
  async verifyAccount(): Promise<void> {
    this.verifying ??= this.verifyAccountOnce().finally(() => { this.verifying = undefined })
    return this.verifying
  }
  private async verifyAccountOnce(): Promise<void> {
    if (process.platform === "win32" && !this.options.allowUnverifiedWindows) throw new Error("Windows Antigravity transport is awaiting authenticated live verification; set antigravity.allowUnverifiedWindows only for the platform acceptance gate")
    const opts = { env: this.childEnv, timeout: 20_000, maxBuffer: 1024 * 1024, signal: this.shutdown.signal }
    const [version, config] = await Promise.all([
      exec(this.executable, ["--version"], opts),
      exec(this.executable, ["-p", "/config", "--output-format", "json"], opts),
    ])
    this.cliVersion = version.stdout.trim()
    // Hooks and stream shapes are security/correctness boundaries. Upgrade only
    // after the actual CLI passes the live gate; never silently trust a new binary.
    if (this.cliVersion !== "1.2.7") throw new Error(`Unsupported agy version ${this.cliVersion}; this Meridian build validates agy 1.2.7. Validate a CLI upgrade before updating the compatibility gate.`)
    const settings = z.object({ command: z.object({ data: z.object({ config: z.object({ modelProvider: z.unknown().optional(), useG1Credits: z.unknown().optional(), gcp: z.unknown().optional() }) }) }) }).parse(JSON.parse(config.stdout)).command.data.config
    if (settings.modelProvider || settings.useG1Credits || settings.gcp) throw new Error("Antigravity requires default account authentication with paid overage credits disabled; configure agy first")
  }
  async availableModels(): Promise<string[]> {
    if (Date.now() - this.checkedAt < 60_000) return this.models
    this.checking ??= (async () => {
      await this.verifyAccount()
      const opts = { env: this.childEnv, timeout: 20_000, maxBuffer: 1024 * 1024, signal: this.shutdown.signal }
      const result = await exec(this.executable, ["models"], opts)
      const models = result.stdout.split("\n").filter(line => line.includes("\t")).map(line => line.split("\t")[0]!).filter(Boolean)
      if (!models.length) throw new Error("No account models available; sign in using agy")
      this.models = models; this.checkedAt = Date.now(); return models
    })().finally(() => { this.checking = undefined })
    return this.checking
  }
  async initialize(): Promise<void> {
    this.initialization ??= (async () => {
      await this.availableModels()
      if (this.options.allowNativeBrowser) {
        try {
          const version = await exec(this.options.browserMcpExecutable ?? "chrome-devtools-mcp", ["--version"], { env: this.childEnv, timeout: 10000, maxBuffer: 65536, signal: this.shutdown.signal })
          if (version.stdout.trim() !== "1.9.0") throw new Error("Expected Chrome DevTools MCP 1.9.0")
        } catch (error) {
          throw new Error("Native browser requires installed chrome-devtools-mcp@1.9.0 and Chrome; configure MERIDIAN_AGY_BROWSER_MCP_PATH if it is not on PATH: " + String(error))
        }
      }
      if (this.draining) throw new Error("Antigravity is shutting down")
      this.server = createServer((req, res) => { void this.handleMcp(req, res) })
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject)
        this.server!.listen(0, "127.0.0.1", resolve)
      })
      const address = this.server.address()
      if (!address || typeof address === "string") throw new Error("Cannot bind MCP listener")
      this.mcpUrl = `http://127.0.0.1:${address.port}`
    })().catch(error => { this.initialization = undefined; throw error })
    return this.initialization
  }
  async create(request: AgRequest, signal?: AbortSignal): Promise<AntigravityRun> {
    if (this.draining) throw new AntigravityError("Antigravity is shutting down", 503, "api_error")
    if (((request.tools.length && request.tool_choice?.type !== "none") || hasAgImages(request.messages)) && !this.options.allowToolBridge) throw new AntigravityError("Client tools and images require explicit MERIDIAN_AGY_ALLOW_TOOL_BRIDGE=1; see the Antigravity guide")
    const reusable = [...this.runs.values()].find(run => run.matches(request))
    if (reusable) { await reusable.resume(request, signal); return reusable }
    const reclaim = this.runs.size + this.preparing >= this.maxConcurrent
      ? [...this.runs.values()].find(run => run.reclaimable) : undefined
    if (this.runs.size + this.preparing >= this.maxConcurrent && !reclaim) throw new AntigravityError("Antigravity process capacity is full with active requests", 429, "rate_limit_error", 5)
    // Reserve admission and claim the idle process synchronously, before waiting
    // for exit. Concurrent admissions cannot reclaim the same process or exceed capacity.
    this.preparing++
    if (reclaim) {
      reclaim.busy = true
      reclaim.abort(new AntigravityError("Idle tool process reclaimed; completed history can be replayed", 409), "reclaimed")
    }
    try {
      if (reclaim) await reclaim.settled
      await this.initialize()
      // Model discovery may be cached, subscription/provider authorization cannot be.
      await this.verifyAccount()
      if (!(await this.availableModels()).includes(request.model)) throw new AntigravityError("Unknown Antigravity model; use GET /v1/models for account model slugs")
      if (this.draining) throw new AntigravityError("Antigravity is shutting down", 503, "api_error")
      if (signal?.aborted) throw new AntigravityError("Request cancelled", 499, "api_error")
      const run = new AntigravityRun(this, request)
      this.runs.set(run.id, run)
      const cancel = () => run.abort(new AntigravityError("Request cancelled", 499, "api_error"))
      signal?.addEventListener("abort", cancel, { once: true })
      try { await run.start() } finally { signal?.removeEventListener("abort", cancel) }
      return run
    } finally { this.preparing-- }
  }
  private async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let rpcId: string | number | undefined
    try {
      const run = this.runs.get((req.url ?? "").slice(1))
      if (!run) return reply(res, 404, { error: "Unknown turn" })
      if (req.method !== "POST") return reply(res, 405, {})
      // Decode only after joining bytes: a UTF-8 character may span HTTP chunks.
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > 1024 * 1024) throw new Error("MCP body too large")
        chunks.push(buffer)
      }
      const raw = Buffer.concat(chunks, bytes).toString("utf8")
      if (req.headers.origin) return reply(res, 403, { error: "Browser origins are not allowed" })
      const rpc = rpcSchema.parse(JSON.parse(raw)); rpcId = rpc.id
      if (rpc.id === undefined) { res.writeHead(202); res.end(); return }
      let session = req.headers["mcp-session-id"]
      if (Array.isArray(session)) throw new Error("Invalid MCP session header")
      if (rpc.method === "initialize") {
        if (run.rpcSessions.size >= 64) throw new Error("Too many MCP sessions")
        session = randomUUID()
        run.rpcSessions.add(session)
      } else if (session && !run.rpcSessions.has(session)) throw new Error("Unknown MCP session")
      else if (run.rpcSessions.size && !session) throw new Error("MCP session header required after initialization")
      if (session) res.setHeader("mcp-session-id", session)
      const scopedId = session ? session + ":" + typeof rpc.id + ":" + rpc.id : rpc.id
      let result: unknown
      const parallel = parallelAgTool(run.request)
      const tools = [...availableAgTools(run.request), ...(parallel ? [parallel] : [])]
      if (rpc.method === "initialize") result = { protocolVersion: rpc.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "meridian-client-tools", version: "1" } }
      else if (rpc.method === "tools/list") result = { tools: tools.map(t => ({ name: t.name, description: t.description ?? t.name, inputSchema: t.input_schema })) }
      else if (rpc.method === "tools/call") {
        const params = toolParams.parse(rpc.params)
        if (!tools.some(tool => tool.name === params.name)) throw new Error("Unknown client tool")
        const value = await (params.name === parallel?.name ? run.dispatchBatch(scopedId, params.arguments) : run.dispatchCall(scopedId, params.name, params.arguments))
        // CLI adds timing prose around MCP responses. An explicit JSON envelope
        // preserves the boundary between exact client bytes and harness metadata.
        result = { content: [{ type: "text", text: JSON.stringify({ meridian_client_result: value.content ?? "", meridian_client_followup: value.clientMessages?.length ? value.clientMessages : undefined, is_error: value.is_error ?? false }) }], isError: value.is_error ?? false }
      } else return reply(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } })
      reply(res, 200, { jsonrpc: "2.0", id: rpc.id, result })
    } catch (error) { reply(res, 200, { jsonrpc: "2.0", id: rpcId ?? null, error: { code: -32603, message: String(error) } }) }
  }
  close(): Promise<void> {
    this.closing ??= this.closeOnce()
    return this.closing
  }
  private async closeOnce(): Promise<void> {
    this.draining = true
    this.shutdown.abort()
    // Initialization can be awaiting account checks while close is called.
    await Promise.allSettled([this.initialization, this.statusRefresh, this.quotaCheck, this.verifying, this.checking])
    const runs = [...this.runs.values()]
    for (const run of runs) run.abort(new AntigravityError("Antigravity backend stopped", 503, "api_error"), run.active ? "failed" : "retired")
    await Promise.all(runs.map(run => run.settled))
    if (this.server) {
      const stopped = new Promise<void>((resolve, reject) => this.server!.close(error => error && "code" in error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()))
      this.server.closeAllConnections()
      await stopped
    }
  }
}
