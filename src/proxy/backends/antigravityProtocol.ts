import { z } from "zod"

export class AntigravityError extends Error {
  constructor(message: string, readonly status = 400, readonly type = "invalid_request_error", readonly retryAfter = status === 429 ? 60 : status === 503 ? 5 : undefined) { super(message) }
}

/** Preserve actionable account failures without retrying a potentially executed tool. */
export function classifyAgFailure(message: string): AntigravityError {
  if (/INVALID_ARGUMENT/.test(message)) return new AntigravityError(message)
  if (/rate.?limit|quota|resource.exhausted|too many requests|\b429\b/i.test(message)) {
    const seconds = /retry(?:[- ]after| in)[:= ]+(\d+)\s*(?:s|seconds)?/i.exec(message)?.[1]
    return new AntigravityError(message, 429, "rate_limit_error", seconds ? Math.min(86400, Math.max(1, Number(seconds))) : 60)
  }
  if (/unauthenticated|authentication required|sign.?in required|login required|token expired/i.test(message)) return new AntigravityError(message, 401, "authentication_error")
  if (/overloaded|service unavailable|\b503\b|\b529\b/i.test(message)) return new AntigravityError(message, 503, "overloaded_error")
  return new AntigravityError(message, 502, "api_error")
}

const textBlock = z.object({ type: z.literal("text"), text: z.string() })
const imageBlock = z.object({ type: z.literal("image"), source: z.union([z.object({ type: z.literal("url"), url: z.url().startsWith("https://") }).strict(), z.object({
  type: z.literal("base64"), media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.string().min(4).max(8 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(data => data.length % 4 === 0, "Invalid base64 length"),
}).strict()]) })
const documentBlock = z.object({ type: z.literal("document"), title: z.string().optional(), source: z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), media_type: z.literal("text/plain"), data: z.string().max(1024 * 1024) }).strict(),
  z.object({ type: z.literal("base64"), media_type: z.enum(["application/pdf", "text/plain"]), data: z.string().max(8 * 1024 * 1024) }).strict(),
]) }).strict()
const audioBlock = z.object({ type: z.literal("audio"), source: z.object({ type: z.literal("base64"), media_type: z.enum(["audio/wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/flac"]), data: z.string().max(8 * 1024 * 1024) }).strict() }).strict()
const videoBlock = z.object({ type: z.literal("video"), source: z.object({ type: z.literal("base64"), media_type: z.enum(["video/mp4", "video/webm", "video/quicktime"]), data: z.string().max(8 * 1024 * 1024) }).strict() }).strict()
const callBlock = z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) })
const resultBlock = z.object({
  type: z.literal("tool_result"), tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.discriminatedUnion("type", [textBlock, imageBlock, documentBlock, audioBlock, videoBlock]))]).optional(), is_error: z.boolean().optional(),
})
const block = z.discriminatedUnion("type", [textBlock, imageBlock, documentBlock, audioBlock, videoBlock, callBlock, resultBlock])
const message = z.object({ role: z.enum(["user", "assistant"]), content: z.union([z.string(), z.array(block)]) })
const outputFormat = z.object({ type: z.literal("json_schema"), schema: z.record(z.string(), z.unknown()) }).strict()
const schema = z.object({
  meridian_tool_grammars: z.record(z.string(), z.object({ syntax: z.enum(['lark', 'regex']), definition: z.string().max(65536) }).strict()).refine(value => Object.keys(value).length <= 16, 'At most 16 custom grammars').optional(),
  meridian_session_key: z.string().max(512).optional(),
  model: z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  messages: z.array(message).min(1),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  // A catalog is not an execution batch. The CLI accepts larger MCP catalogs;
  // retain per-tool validation and the runtime's separate action limits.
  tools: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), description: z.string().optional(), input_schema: z.record(z.string(), z.unknown()) })).default([]),
  stream: z.boolean().default(false), max_tokens: z.number().int().positive().optional(),
  tool_choice: z.discriminatedUnion("type", [
    z.object({ type: z.enum(["auto", "any"]), disable_parallel_tool_use: z.boolean().optional() }).strict(),
    z.object({ type: z.literal("none") }).strict(),
    z.object({ type: z.literal("tool"), name: z.string(), disable_parallel_tool_use: z.boolean().optional() }).strict(),
  ]).optional(),
  thinking: z.discriminatedUnion("type", [
    z.object({ type: z.literal("disabled") }),
    z.object({ type: z.literal("enabled"), budget_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), display: z.enum(["summarized", "omitted"]).optional() }).strict(),
    z.object({ type: z.literal("adaptive"), display: z.enum(["summarized", "omitted"]).optional() }),
  ]).optional(),
  output_config: z.object({
    effort: z.enum(["low", "medium", "high"]).optional(),
    format: outputFormat.optional(),
  }).strict().optional(),
  output_format: outputFormat.optional(),
  temperature: z.number().optional(), top_p: z.number().optional(), top_k: z.number().optional(),
  stop_sequences: z.array(z.string().min(1).max(1024)).max(4).optional(),
}).passthrough()

export type AgRequest = z.infer<typeof schema>
export type AgMessage = z.infer<typeof message>
export type AgBlock = z.infer<typeof block>
export type AgCall = z.infer<typeof callBlock>
export type AgResult = z.infer<typeof resultBlock>
export function parseAgRequest(value: unknown, adaptThinkingBudgets = false): AgRequest {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new AntigravityError("Antigravity supports text, images, documents and adapted media; invalid or unsupported request: " + parsed.error.issues.map(i => i.path.join(".") + " " + i.message).join("; "))
  const request = parsed.data
  if (request.thinking?.type === "enabled") {
    if (!adaptThinkingBudgets) throw new AntigravityError("Numeric thinking budgets require MERIDIAN_AGY_ADAPT_THINKING_BUDGETS=1; this maps budgets to approximate Gemini effort, not token limits")
    const family = /^(gemini-[a-zA-Z0-9._-]+)-(low|medium|high)$/.exec(request.model)?.[1]
    if (!family) throw new AntigravityError("Thinking-budget adaptation requires a Gemini low/medium/high model slug from /v1/models")
    const budget = request.thinking.budget_tokens
    const effort = budget <= 2048 ? "low" : budget <= 8192 ? "medium" : "high"
    if (request.output_config?.effort && request.output_config.effort !== effort) throw new AntigravityError("Explicit effort conflicts with the adapted thinking budget")
    request.model = `${family}-${effort}`
    request.thinking = { type: "adaptive", ...(request.thinking.display ? { display: request.thinking.display } : {}) }
    request.output_config = { ...request.output_config, effort }
  }
  if (request.output_format) {
    if (request.output_config?.format) throw new AntigravityError("Use only one of output_format and output_config.format")
    request.output_config = { ...request.output_config, format: request.output_format }
    delete request.output_format
  }
  for (const key of ["temperature", "top_p", "top_k", "betas"]) {
    if (request[key] !== undefined) throw new AntigravityError(`Antigravity does not support ${key}`)
  }
  if (request.output_config?.effort && !request.model.endsWith("-" + request.output_config.effort)) throw new AntigravityError("This agy model does not support the requested effort override; select the matching low/medium/high model slug from /v1/models")
  const choice = request.tool_choice
  if (choice?.type === "tool" && !request.tools.some(t => t.name === choice.name)) throw new AntigravityError("tool_choice names an unknown tool")
  if (request.tool_choice?.type === "any" && !request.tools.length) throw new AntigravityError("tool_choice any requires tools")

  if (new Set(request.tools.map(t => t.name)).size !== request.tools.length) throw new AntigravityError("Duplicate tool names")
  if (request.messages.at(-1)?.role !== "user") throw new AntigravityError("The last message must be a user message")
  // A replay must never turn an unpaired historical action into a fresh instruction.
  const seen = new Set<string>()
  let pending = new Set<string>()
  for (const message of request.messages) {
    const content = blocks(message)
    const results = content.filter(b => b.type === "tool_result")
    if (pending.size && (message.role !== "user" || results.length !== pending.size)) throw new AntigravityError("Every tool call must have a matching result in the next user message")
    for (const b of content) {
      if (b.type === "tool_use") {
        if (message.role !== "assistant" || !b.id || seen.has(b.id)) throw new AntigravityError("Invalid or duplicate historical tool call")
        seen.add(b.id)
      }
      if (b.type === "tool_result") {
        if (message.role !== "user" || !pending.delete(b.tool_use_id)) throw new AntigravityError("Unknown or duplicate historical tool result")
      }
    }
    if (pending.size) throw new AntigravityError("Missing historical tool result")
    pending = new Set(content.filter(b => b.type === "tool_use").map(b => b.id))
  }
  return request
}
export function blocks(message: AgMessage): AgBlock[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]"
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => JSON.stringify(key) + ":" + stable(val)).join(",") + "}"
  return JSON.stringify(value) ?? "null"
}
export function historyKey(messages: AgMessage[]): string {
  return stable(messages.map(m => ({ role: m.role, content: blocks(m) })))
}
export function contractKey(request: AgRequest): string {
  return stable({ session: request.meridian_session_key, grammars: request.meridian_tool_grammars, model: request.model, system: request.system, tools: request.tools, max_tokens: request.max_tokens, thinking: request.thinking, stop_sequences: request.stop_sequences, output_config: request.output_config })
}
/** Client plugins may refresh instructions/tool definitions, but cannot retarget a pending execution. */
export function sameAgExecutionContract(previous: AgRequest, next: AgRequest): boolean {
  return contractKey({ ...previous, system: next.system, tools: next.tools }) === contractKey(next)
}
export function hasAgImages(messages: AgMessage[]): boolean {
  return messages.some(m => blocks(m).some(b => (b.type === "image" || b.type === "document" || b.type === "audio" || b.type === "video") || (b.type === "tool_result" && Array.isArray(b.content) && b.content.some(c => c.type === "image" || c.type === "document" || c.type === "audio" || c.type === "video"))))
}
export function availableAgTools(request: AgRequest): AgRequest["tools"] {
  const choice = request.tool_choice
  return choice?.type === "none" ? [] : choice?.type === "tool" ? request.tools.filter(t => t.name === choice.name) : request.tools
}
export function parallelAgTool(request: AgRequest): AgRequest["tools"][number] | undefined {
  if (!availableAgTools(request).length || (request.tool_choice && "disable_parallel_tool_use" in request.tool_choice && request.tool_choice.disable_parallel_tool_use)) return undefined
  let name = "meridian_parallel"
  while (request.tools.some(tool => tool.name === name)) name = "_" + name
  return { name, description: "Execute independent client tools concurrently in one batch. Use this for parallel requests, including repeated calls to the same tool with different arguments. Each result identifies its original name and input. Follow the exact client schemas supplied in the prompt.", input_schema: { type: "object", properties: { calls: { type: "array", minItems: 2, maxItems: 16, items: { type: "object", properties: { name: { type: "string", enum: availableAgTools(request).map(tool => tool.name) }, arguments: { type: "object" } }, required: ["name", "arguments"], additionalProperties: false } } }, required: ["calls"], additionalProperties: false } }
}
export function forcedAgTool(request: AgRequest): boolean {
  return request.tool_choice?.type === "any" || request.tool_choice?.type === "tool"
}
export function toolChoiceInstruction(request: AgRequest): string {
  const instruction = request.tool_choice?.type === "tool" ? `For this response you must call the client tool ${request.tool_choice.name}. Do not answer with prose.`
    : request.tool_choice?.type === "any" ? "For this response you must call a client tool. Do not answer with prose."
    : request.tool_choice?.type === "none" ? "For this response do not call client tools. Answer the user."
    : "Choose whether to call a client tool or answer the user."
  return instruction + (parallelAgTool(request) ? `\nFor independent parallel client actions, call the meridian_client MCP tool ${parallelAgTool(request)!.name} with {calls:[{name,arguments},...]}. It delivers those calls together to the client.\n` + JSON.stringify(parallelAgTool(request)) : "") + "\nThe complete client tool definitions for this response follow. Use these exact schemas; do not read CLI metadata files to discover tools.\n" + JSON.stringify(availableAgTools(request))
}
/** Index and text of the newest user message with typed text; tool-result-only turns are skipped. */
function latestRequest(messages: AgMessage[]): { at: number; text: string } {
  for (let at = messages.length - 1; at >= 0; at--) {
    const { role, content } = messages[at]!
    const text = role !== "user" ? "" : typeof content === "string" ? content : content.flatMap(b => b.type === "text" ? [b.text] : []).join("\n")
    if (text.trim()) return { at, text: text.trim() }
  }
  return { at: -1, text: "" }
}
// Argument names that say what a tool call acted on. Clients order arguments freely (write arrives as {content, file_path}).
const TARGET_KEYS = ["file_path", "filePath", "path", "file", "command", "cmd", "url", "pattern", "query"]
/** What a tool call acted on: its first target-like string argument, else its first argument. */
function toolTarget(input: Record<string, unknown>): string {
  const key = TARGET_KEYS.find(k => typeof input[k] === "string")
  const target = String(key ? input[key] : Object.values(input)[0] ?? "")
  return recapPreview(target, 80, 41)
}
/** Head and tail of a long restated text; the full text stays in the history, so restating never multiplies a large paste. */
function clip(text: string, max = 4000): string {
  if (text.length <= max) return text
  const ends = textEnds(text, max / 2, max / 2)
  return ends.head + `\n[... ${ends.omitted} chars omitted; full text is in the client conversation below ...]\n` + ends.tail
}

type RecapBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: string; target: string }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "image" | "document" | "audio" | "video"; omitted: true }
type RecapMessage = { role: AgMessage["role"]; content: string | RecapBlock[] }

function textEnds(text: string, head: number, tail: number): { head: string; tail: string; omitted: number } {
  const splitsPair = (at: number) => (text.charCodeAt(at - 1) & 0xFC00) === 0xD800 && (text.charCodeAt(at) & 0xFC00) === 0xDC00
  const headEnd = head > 0 && splitsPair(head) ? head - 1 : head
  const tailStart = text.length - tail + (tail > 0 && splitsPair(text.length - tail) ? 1 : 0)
  return { head: text.slice(0, headEnd), tail: text.slice(tailStart), omitted: tailStart - headEnd }
}

function recapPreview(text: string, max = 200, tail = 0): string {
  if (text.length <= max) return text
  const ends = textEnds(text, max - tail - 1, tail)
  return ends.head + "…" + ends.tail
}

function recapMessage(message: AgMessage): RecapMessage {
  return { role: message.role, content: typeof message.content === "string" ? recapPreview(message.content) : message.content.map((block): RecapBlock => {
    if (block.type === "text") return { type: block.type, text: recapPreview(block.text) }
    if (block.type === "tool_use") return { type: block.type, id: block.id, name: block.name, target: toolTarget(block.input), input: recapPreview(JSON.stringify(block.input)) }
    if (block.type === "tool_result") {
      const content = Array.isArray(block.content) ? block.content.map(item => item.type === "text" ? { type: item.type, text: recapPreview(item.text) } : { type: item.type, omitted: true }) : block.content ?? ""
      return { type: block.type, tool_use_id: block.tool_use_id, content: recapPreview(JSON.stringify(content)), ...(block.is_error === undefined ? {} : { is_error: block.is_error }) }
    }
    return { type: block.type, omitted: true }
  }) }
}

/** Advisory JSON retains complete newest call/result batches; authority stays in the unchanged history. */
function recentWork(messages: AgMessage[]): { text: string; complete: boolean } {
  if (!messages.length) return { text: "", complete: true }
  const groups: RecapMessage[][] = []
  let complete = true
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    const calls = blocks(message).filter(block => block.type === "tool_use")
    const next = messages[i + 1]
    if (message.role === "assistant" && calls.length && next?.role === "user") {
      const results = blocks(next).filter(block => block.type === "tool_result")
      const ids = new Set(calls.map(call => call.id))
      if (ids.size === calls.length && results.length === calls.length && results.every(result => ids.has(result.tool_use_id))) {
        complete &&= !results.some(result => result.is_error)
        groups.push([recapMessage(message), recapMessage(next)])
        i++
        continue
      }
    }
    complete &&= !blocks(message).some(block => block.type === "tool_use" || block.type === "tool_result")
    groups.push([recapMessage(message)])
  }
  const notice = "\n[Earlier or oversized work omitted; consult the full client history.]"
  let selected: RecapMessage[] = []
  let text = "[]"
  let omitted = false
  for (let i = groups.length - 1; i >= 0; i--) {
    const candidate = [...groups[i]!, ...selected]
    const encoded = JSON.stringify(candidate)
    if (encoded.length > 4000 - notice.length) { omitted = true; break }
    selected = candidate
    text = encoded
  }
  return { text: text + (omitted ? notice : ""), complete: complete && !omitted }
}

export function renderAgPrompt(request: AgRequest, nativeTools: string[] = [], omitted = false): string {
  // NOTE: in long tool-heavy histories Gemini loses the newest request (and the work already done for it) at the end of
  // one large JSON value and resumes earlier tasks. Restate both, briefly, ahead of the history, which stays last.
  const latest = latestRequest(request.messages)
  const { at } = latest
  const current = clip(latest.text)
  const since = recentWork(request.messages.slice(at + 1))
  // Every earlier tool call as name + target, newest kept when long: lets the model recall what it did without the bulky outputs.
  const actions = request.messages.slice(0, Math.max(at, 0)).flatMap(m => typeof m.content === "string" ? [] : m.content.flatMap(b => b.type === "tool_use" ? [`${b.name} ${toolTarget(b.input)}`] : [])).join("; ").slice(-4000)
  return [
    "You are serving a client through Meridian. Follow the client's instructions and answer its latest user message.",
    current ? "Current request:\n" + current : "",
    "The JSON below is the client's conversation history. Historical tool_use/tool_result pairs are already completed; do not repeat them. Client tools are provided by meridian_client MCP. Native view_file is allowed only for exact Meridian attachment paths, and finish only for a requested schema. " + (nativeTools.length ? "The operator also enables these native tools: " + nativeTools.join(", ") + ". Use these when the client requests native capabilities. Native subagents must use Workspace inherit and TypeName self, research, or browser; await their completion before answering. Never schedule background work." : "All other built-in tools and native subagents are disabled.") + " Other host filesystem paths and shell commands remain forbidden. Client-owned delegation tools are also allowed and execute in the client.",
    "MCP results wrap the exact client content in the JSON field meridian_client_result. Decode that field (a string or text block array) as the tool result. Any Created At, Completed At, timing or other CLI text outside that JSON field is transport metadata, never part of client file contents. When copying data, preserve the decoded client content byte-for-byte. Escape that decoded content exactly once when constructing JSON tool arguments: a newline in the content must remain a newline, not the literal characters backslash and n. Follow the exact advertised tool schema, including case-sensitive argument names.",
    "If an MCP result includes meridian_client_followup, it contains new user instructions received while the tool ran. Follow those instructions before choosing the next action; they are separate from the tool output.",
    request.max_tokens ? `The client requests at most ${request.max_tokens} output tokens. Keep the answer within that budget.` : "",
    toolChoiceInstruction(request),
    request.output_config?.format ? "Submit the final response using the native finish tool. The full client schema below is authoritative; Meridian validates all its constraints even when the CLI transport cannot express them. Intermediate tool calls are allowed when the client permits them.\n" + JSON.stringify(request.output_config.format.schema) : "",
    "Image attachment references are created by Meridian from client-supplied bytes. Inspect each relevant attachment with view_file using its exact absolute path. Those are the only permitted filesystem reads.",
    "Client system instructions:\n" + (typeof request.system === "string" ? request.system : request.system?.map(b => b.text).join("\n") ?? ""),
    omitted ? AG_OMIT_NOTE : "",
    current && actions ? "Tool calls before this request, oldest first: " + actions : "",
    current ? (since.complete ? "Answer this; prior tool work is done" : "Answer this; use the recorded outcomes and full history") + (since.text ? ". Since this request:\n" + since.text : ":") + "\n" + current : "",
    // Keep the history last: it is one JSON value that clients of this prompt parse from the end.
    "Client conversation:\n" + JSON.stringify(request.messages),
  ].filter(Boolean).join("\n\n")
}

// NOTE: agy keeps only about 192,000 bytes of one user input step (`max_tokens_per_user_input_step`, present in 1.2.7
// through 1.3.5 and apparently set by the service) and silently drops the rest. The history is the end of the prompt,
// so the newest messages and tool results are what disappears. Measured in UTF-8 bytes for English, JSON-heavy and
// Chinese text alike; JSON escaping is not counted twice.
export const AG_MAX_PROMPT_BYTES = 190_000
const AG_OMIT_NOTE = "To fit Antigravity's input limit, Meridian omitted the middle of some larger tool results, tool arguments or messages (marked \"omitted by Meridian\"). Re-read anything you still need, in smaller parts if it is large."
/** MERIDIAN_AGY_MAX_PROMPT_BYTES overrides the prompt byte limit; 0 disables it. */
export function agPromptByteLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MERIDIAN_AGY_MAX_PROMPT_BYTES
  if (raw === undefined || raw === "") return AG_MAX_PROMPT_BYTES
  const limit = Number(raw)
  return Number.isSafeInteger(limit) && limit >= 0 ? limit : AG_MAX_PROMPT_BYTES
}
function promptTooLong(bytes: number, limit: number): AntigravityError {
  return new AntigravityError(`prompt is too long: ${bytes} bytes > ${limit} maximum that Antigravity accepts without silently dropping the end of the conversation`)
}
/** The newest user message with typed text: the client's current request. */
function latestTypedRequest(messages: AgMessage[]): number {
  for (let at = messages.length - 1; at >= 0; at--) {
    const { role, content } = messages[at]!
    if (role === "user" && (typeof content === "string" ? content.trim() : content.some(b => b.type === "text" && b.text.trim()))) return at
  }
  return -1
}
/** Text with its middle replaced by a marker, or undefined when that would not make it shorter. */
function omitMiddle(text: string, keep: number, min: number): string | undefined {
  if (text.length <= min) return undefined
  // A cut inside a surrogate pair would leave a lone surrogate in the kept head or tail, so move it inward.
  const isLow = (at: number) => (text.charCodeAt(at) & 0xFC00) === 0xDC00, isHigh = (at: number) => (text.charCodeAt(at) & 0xFC00) === 0xD800
  const headEnd = keep > 0 && isHigh(keep - 1) && isLow(keep) ? keep - 1 : keep
  const tailStart = keep > 0 && isLow(text.length - keep) && isHigh(text.length - keep - 1) ? text.length - keep + 1 : text.length - keep
  const out = `${text.slice(0, headEnd)}\n[... ${tailStart - headEnd} chars omitted by Meridian: Antigravity input limit; re-read if needed ...]\n${text.slice(tailStart)}`
  return out.length < text.length ? out : undefined
}
/** Every string leaf of a JSON value shrunk, keys, array shape and other values unchanged; the same value when nothing qualified. */
function omitDeep(value: unknown, cut: (text: string) => string | undefined): unknown {
  if (typeof value === "string") return cut(value) ?? value
  if (Array.isArray(value)) { const items = value.map(item => omitDeep(item, cut)); return items.some((item, i) => item !== value[i]) ? items : value }
  if (value && typeof value === "object") { const entries = Object.entries(value).map(([key, item]) => [key, omitDeep(item, cut)] as const); return entries.some(([key, item]) => item !== (value as Record<string, unknown>)[key]) ? Object.fromEntries(entries) : value }
  return value
}
type OmitKind = "result" | "use" | "text"
type Loose = { type?: string; text?: string; content?: unknown; input?: Record<string, unknown> }
/** One message with one kind of content shrunk (tool results, tool_use arguments or text); the same object when nothing qualified. */
function omitIn(message: AgMessage, kind: OmitKind, keep: number, min: number): AgMessage {
  const cut = (text: string) => omitMiddle(text, keep, min)
  const text = (b: Loose): Loose => { const t = typeof b.text === "string" ? cut(b.text) : undefined; return t === undefined ? b : { ...b, text: t } }
  if (typeof message.content === "string") { const t = kind === "text" ? cut(message.content) : undefined; return t === undefined ? message : { ...message, content: t } }
  let changed = false
  const content = (message.content as Loose[]).map(b => {
    let next = b
    if (kind === "text" && b.type === "text") next = text(b)
    else if (kind === "result" && b.type === "tool_result") {
      if (typeof b.content === "string") { const t = cut(b.content); if (t !== undefined) next = { ...b, content: t } }
      else if (Array.isArray(b.content)) { const parts = (b.content as Loose[]).map(part => part.type === "text" ? text(part) : part); if (parts.some((part, i) => part !== (b.content as Loose[])[i])) next = { ...b, content: parts } }
    } else if (kind === "use" && b.type === "tool_use" && b.input) {
      const input = omitDeep(b.input, cut)
      if (input !== b.input) next = { ...b, input: input as Record<string, unknown> }
    }
    if (next !== b) changed = true
    return next
  })
  return changed ? { ...message, content } as AgMessage : message
}
/**
 * renderAgPrompt plus an optional suffix, kept within `limit` bytes instead of letting agy drop the newest messages.
 * Shrinks the oldest large content first, to head-and-tail snippets and then to markers: tool results, tool_use
 * arguments and long text before the client's current request; then older tool work and assistant text since it;
 * last, the newest round's tool results and arguments, including tool results sent with the request. The request's
 * own text is never shrunk: when it alone does not fit, the request fails with a 400 prompt-too-long error. Under the
 * limit the prompt is unchanged.
 */
export function renderAgPromptWithinLimit(request: AgRequest, nativeTools: string[] = [], suffix = "", limit = agPromptByteLimit()): string {
  const full = renderAgPrompt(request, nativeTools) + suffix
  if (!limit || Buffer.byteLength(full) <= limit) return full
  const current = latestTypedRequest(request.messages)
  const lastAssistant = request.messages.findLastIndex(m => m.role === "assistant"), lastUser = request.messages.findLastIndex(m => m.role === "user")
  // Tool results that arrive with the request (some clients add text next to them) count as the newest round.
  const newest = new Set([lastAssistant, lastUser, current].filter(at => at >= 0 && at >= current))
  const size = (message: AgMessage) => Buffer.byteLength(JSON.stringify(message))
  let messages = request.messages, changed = false
  let excess = Buffer.byteLength(full) - limit + Buffer.byteLength(AG_OMIT_NOTE) + 2
  const render = () => renderAgPrompt({ ...request, messages }, nativeTools, true) + suffix
  const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i)
  const phases: Array<{ at: number[]; kinds: readonly OmitKind[]; passes: readonly (readonly [number, number])[] }> = [
    { at: range(0, current), kinds: ["result", "use", "text"], passes: [[300, 2000], [0, 200]] },
    { at: range(current + 1, messages.length).filter(at => !newest.has(at)), kinds: ["result", "use", "text"], passes: [[300, 2000], [0, 200]] },
    { at: [...newest].sort((a, b) => a - b), kinds: ["result", "use"], passes: [[4000, 10000], [1000, 2500]] },
  ]
  for (const { at, kinds, passes } of phases) for (const [keep, min] of passes) for (const kind of kinds) for (const i of at) {
    const next = omitIn(messages[i]!, kind, keep, min)
    if (next === messages[i]) continue
    if (!changed) { messages = [...messages]; changed = true }
    excess -= size(messages[i]!) - size(next)
    messages[i] = next
    if (excess > 0) continue
    const prompt = render(), over = Buffer.byteLength(prompt) - limit
    if (over <= 0) return prompt
    excess = over
  }
  const prompt = changed ? render() : full, bytes = Buffer.byteLength(prompt)
  if (bytes > limit) throw promptTooLong(bytes, limit)
  return prompt
}

export type AgEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; call: AgCall }
  | { kind: "usage"; input: number; output: number; cache: number }
  | { kind: "end" }
  | { kind: "error"; error: Error }

/** Single consumer, bounded upstream buffering; tools stay pending between HTTP responses. */
export class AgEventQueue {
  private items: AgEvent[] = []
  private waiter?: (event: AgEvent) => void
  private failure?: Error
  push(event: AgEvent): void {
    if (this.failure) return
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(event) }
    else {
      if (this.items.length >= 8192) { this.fail(new Error("Antigravity event buffer exceeded")); return }
      this.items.push(event)
    }
  }
  fail(error: Error): void {
    this.failure = error
    this.items = []
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ kind: "error", error }) }
  }
  takeQueuedTools(): AgCall[] {
    const calls: AgCall[] = []
    while (this.items[0]?.kind === "tool") {
      const event = this.items.shift()!
      if (event.kind === "tool") calls.push(event.call)
    }
    return calls
  }
  next(): Promise<AgEvent> {
    if (this.failure) return Promise.resolve({ kind: "error", error: this.failure })
    const event = this.items.shift()
    if (event) return Promise.resolve(event)
    if (this.waiter) return Promise.reject(new Error("Concurrent Antigravity response consumer"))
    return new Promise(resolve => { this.waiter = resolve })
  }
}
