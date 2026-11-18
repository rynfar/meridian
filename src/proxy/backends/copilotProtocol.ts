/**
 * OpenAI Chat Completions requests for the Copilot backend, and how a request
 * relates to the live Copilot session that served the conversation so far.
 * Pure functions: no SDK, no I/O.
 */
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { CopilotAttachment, CopilotToolDefinition } from "./copilotSdk"

export class CopilotError extends Error {
  constructor(message: string, readonly status = 400, readonly type = "invalid_request_error") { super(message) }
}

export interface ChatToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ChatMessage { role: "user" | "assistant" | "tool"; content?: unknown; attachments?: CopilotAttachment[]; tool_calls?: ChatToolCall[]; tool_call_id?: string }

export interface CopilotRequest {
  model: string
  effort?: string
  system: string
  /** Conversation after the leading system/developer messages. */
  history: ChatMessage[]
  definitions: CopilotToolDefinition[]
  stream: boolean
  includeUsage: boolean
  /** Session identity; absent for tool-less side requests such as titles. */
  key?: string
}

/** What the session has already seen, compared against the next request. */
export interface CopilotSessionView {
  model: string
  effort?: string
  system: string
  definitions: CopilotToolDefinition[]
  history: ChatMessage[]
  previous?: { text: string; callIds: string[] }
  /** Copilot request id per pending tool call id. */
  waiting: Map<string, string>
}

export type CopilotContinuation =
  | { kind: "tool-results"; results: Array<{ requestId: string; content: string }> }
  | { kind: "user"; prompt: string; attachments?: CopilotAttachment[] }

const SUPPORTED = new Set(["model", "messages", "tools", "stream", "stream_options", "max_tokens", "max_completion_tokens", "temperature", "tool_choice", "reasoning_effort", "parallel_tool_calls"])
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/
const SESSION_HEADERS = ["x-session-affinity", "x-opencode-session", "x-session-id"]

export function textOf(content: unknown): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content) && content.every(part => part?.type === "text" && typeof part.text === "string")) return content.map(part => part.text).join("\n\n")
  throw new CopilotError("The Copilot backend accepts text content only. Images, audio and documents are not supported.")
}

function userContentOf(content: unknown): { text: string; attachments?: CopilotAttachment[] } {
  if (!Array.isArray(content) || content.every(part => part?.type === "text")) return { text: textOf(content) }
  const text: string[] = [], attachments: CopilotAttachment[] = []
  for (const raw of content) {
    const part = object(raw)
    if (part.type === "text" && typeof part.text === "string") { text.push(part.text); continue }
    const image = object(part.image_url)
    const match = part.type === "image_url" && typeof image.url === "string" ? /^data:(image\/(?:jpeg|jpg|png|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(image.url) : null
    if (!match) throw new CopilotError(part.type === "image_url" ? "Copilot supports only base64 data URL images (JPEG, PNG, GIF or WebP)." : "Only text and image_url message parts are supported.")
    attachments.push({ type: "blob", mimeType: match[1]!.toLowerCase() === "image/jpg" ? "image/jpeg" : match[1]!.toLowerCase(), data: match[2]!.replace(/\s/g, "") })
  }
  return { text: text.join("\n\n"), ...(attachments.length ? { attachments } : {}) }
}

function object(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}
}

/** Translate Anthropic Messages input into the common Copilot request model. */
export function parseCopilotAnthropicRequest(body: unknown, headers: Headers): CopilotRequest {
  const input = object(body)
  const supported = new Set(["model", "messages", "system", "tools", "stream", "max_tokens", "temperature", "top_p", "tool_choice", "thinking", "effort", "reasoning_effort", "output_config"])
  const unknown = Object.keys(input).filter(name => !supported.has(name))
  if (unknown.length) throw new CopilotError(`Unsupported request options: ${unknown.join(", ")}.`)
  if (input.tool_choice !== undefined && object(input.tool_choice).type !== "auto") throw new CopilotError("Only tool_choice \"auto\" is supported.")
  const output = object(input.output_config), thinking = object(input.thinking)
  if (Object.keys(output).some(name => name !== "effort")) throw new CopilotError("Structured output is not supported.")
  if (input.thinking !== undefined && thinking.type !== "adaptive") throw new CopilotError("Only adaptive thinking mode is supported; disabling reasoning or numeric budgets is not supported.")
  const efforts = [input.effort, input.reasoning_effort, output.effort].filter(value => value !== undefined)
  if (efforts.some(value => typeof value !== "string")) throw new CopilotError("effort must be a string.")
  if (new Set(efforts).size > 1) throw new CopilotError("Conflicting reasoning effort values.")
  const rawSystem = Array.isArray(input.system) ? input.system : input.system == null ? [] : [{ type: "text", text: input.system }]
  const system = rawSystem.map(object).map(block => {
    if (block.type !== "text" || typeof block.text !== "string") throw new CopilotError("Only text system blocks are supported.")
    return block.text
  }).join("\n\n")
  if (!Array.isArray(input.messages) || !input.messages.length) throw new CopilotError("messages must be a non-empty array.")
  const messages: Record<string, unknown>[] = []
  if (system) messages.push({ role: "system", content: system })
  for (const raw of input.messages.map(object)) {
    if (raw.role !== "user" && raw.role !== "assistant") throw new CopilotError("Anthropic messages must have role user or assistant.")
    const blocks = typeof raw.content === "string" ? [{ type: "text", text: raw.content }] : Array.isArray(raw.content) ? raw.content.map(object) : []
    const text: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = []
    const calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = []
    const results: Array<{ tool_use_id: string; content: string }> = []
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") text.push({ type: "text", text: block.text })
      else if (block.type === "image" && raw.role === "user") {
        const source = object(block.source)
        if (source.type !== "base64" || typeof source.data !== "string" || typeof source.media_type !== "string") throw new CopilotError("Image blocks require base64 source media_type and data.")
        text.push({ type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } })
      } else if (block.type === "tool_use" && raw.role === "assistant") {
        if (typeof block.id !== "string" || typeof block.name !== "string") throw new CopilotError("tool_use blocks require id and name.")
        calls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } })
      } else if ((block.type === "thinking" || block.type === "redacted_thinking") && raw.role === "assistant") {
        // Provider-specific thinking is not replayable to Copilot. Adjacent
        // text and tool_use blocks still preserve the usable assistant turn.
      } else if (block.type === "tool_result" && raw.role === "user" && typeof block.tool_use_id === "string") {
        results.push({ tool_use_id: block.tool_use_id, content: Array.isArray(block.content) ? block.content.map(object).filter(part => part.type === "text").map(part => part.text).filter(v => typeof v === "string").join("\n\n") : typeof block.content === "string" ? block.content : "" })
      } else throw new CopilotError(`Unsupported Anthropic content block ${String(block.type)} for ${raw.role}.`)
    }
    if (results.length) {
      for (const result of results) messages.push({ role: "tool", tool_call_id: result.tool_use_id, content: result.content })
      const extra = text.length ? text : undefined
      if (extra) messages.push({ role: "user", content: extra })
    } else messages.push({ role: raw.role, content: text, ...(calls.length ? { tool_calls: calls } : {}) })
  }
  const tools = Array.isArray(input.tools) ? input.tools.map(object).map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })) : []
  return parseCopilotRequest({ model: input.model, messages, tools, stream: input.stream === true, ...(efforts.length ? { reasoning_effort: efforts[0] } : {}) }, headers)
}

/** Validate a Chat Completions body. Unsupported controls are rejected, never silently dropped. */
export function parseCopilotRequest(body: unknown, headers: Headers): CopilotRequest {
  const input = object(body)
  const unknown = Object.keys(input).filter(name => !SUPPORTED.has(name))
  if (unknown.length) throw new CopilotError(`Unsupported request options: ${unknown.join(", ")}.`)
  if (typeof input.model !== "string" || !input.model || input.model.length > 200) throw new CopilotError("model is required.")
  if (input.stream !== undefined && typeof input.stream !== "boolean") throw new CopilotError("stream must be a boolean.")
  if (input.tool_choice !== undefined && input.tool_choice !== "auto") throw new CopilotError("Only tool_choice \"auto\" is supported.")
  if (input.parallel_tool_calls !== undefined && input.parallel_tool_calls !== true) throw new CopilotError("parallel_tool_calls cannot be disabled on the Copilot backend.")
  if (input.reasoning_effort !== undefined && typeof input.reasoning_effort !== "string") throw new CopilotError("reasoning_effort must be a string.")
  if (!Array.isArray(input.messages) || input.messages.length === 0) throw new CopilotError("messages must be a non-empty array.")
  const tools = input.tools ?? []
  if (!Array.isArray(tools)) throw new CopilotError("tools must be an array.")

  const messages = input.messages.map(object)
  let start = 0
  const system: string[] = []
  while (start < messages.length && ["system", "developer"].includes(messages[start]!.role)) system.push(textOf(messages[start++]!.content))
  const history = messages.slice(start).map((m): ChatMessage => {
    if (m.role === "user") { const content = userContentOf(m.content); return { role: "user", content: content.text, ...(content.attachments ? { attachments: content.attachments } : {}) } }
    if (m.role === "tool") {
      if (typeof m.tool_call_id !== "string" || !m.tool_call_id) throw new CopilotError("Tool messages need tool_call_id.")
      return { role: "tool", tool_call_id: m.tool_call_id, content: textOf(m.content) }
    }
    if (m.role === "assistant") {
      const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map(object).map((call): ChatToolCall => {
        const fn = object(call.function)
        if (typeof call.id !== "string" || typeof fn.name !== "string") throw new CopilotError("Assistant tool_calls need id and function.name.")
        return { id: call.id, type: "function", function: { name: fn.name, arguments: typeof fn.arguments === "string" ? fn.arguments : "{}" } }
      })
      return { role: "assistant", content: textOf(m.content), ...(calls.length ? { tool_calls: calls } : {}) }
    }
    throw new CopilotError(["system", "developer"].includes(m.role) ? "System and developer messages are supported only at the start of the conversation." : `Unsupported message role ${String(m.role)}.`)
  })
  if (history.length === 0) throw new CopilotError("messages needs at least one user message after the system prompt.")

  const definitions = tools.map(object).map((tool): CopilotToolDefinition => {
    const fn = object(tool.function)
    if (tool.type !== "function" || !TOOL_NAME.test(fn.name ?? "") || fn.parameters === undefined || object(fn.parameters) !== fn.parameters) throw new CopilotError("Only function tools with a JSON-schema parameters object are supported.")
    // Declaration only: the client executes every call. Overriding built-ins
    // lets client names such as web_fetch win over Copilot's own tools.
    return { name: fn.name, ...(typeof fn.description === "string" ? { description: fn.description } : {}), parameters: fn.parameters, defer: "never", skipPermission: true, overridesBuiltInTool: true }
  })
  if (new Set(definitions.map(tool => tool.name)).size !== definitions.length) throw new CopilotError("Tool names must be unique.")

  return {
    model: input.model,
    effort: input.reasoning_effort,
    system: system.join("\n\n"),
    history,
    definitions,
    stream: input.stream === true,
    includeUsage: object(input.stream_options).include_usage === true,
    key: definitions.length ? conversationKey(headers, input.model, system.join("\n\n"), history) : undefined,
  }
}

/** A client session header when present, otherwise the conversation's opening. */
function conversationKey(headers: Headers, model: string, system: string, history: ChatMessage[]): string {
  for (const name of SESSION_HEADERS) {
    const value = headers.get(name)
    if (value && value.length <= 256) return `header:${name}:${value}`
  }
  return "opening:" + createHash("sha256").update(JSON.stringify([model, system, history[0]])).digest("hex")
}

/**
 * How to continue the live session natively, or null when the request no
 * longer extends what the session has seen (model, prompt or tool change,
 * compaction, edited history) and the conversation must be replayed.
 */
export function planContinuation(view: CopilotSessionView, request: CopilotRequest): CopilotContinuation | null {
  if (view.model !== request.model || view.effort !== request.effort || view.system !== request.system || !isDeepStrictEqual(view.definitions, request.definitions)) return null
  if (!isDeepStrictEqual(request.history.slice(0, view.history.length), view.history)) return null
  const tail = request.history.slice(view.history.length)
  if (view.previous) {
    const assistant = tail.shift()
    if (assistant?.role !== "assistant" || textOf(assistant.content) !== view.previous.text || !isDeepStrictEqual((assistant.tool_calls ?? []).map(call => call.id), view.previous.callIds)) return null
  }
  if (view.waiting.size) {
    const results = tail.slice(0, view.waiting.size), rest = tail.slice(view.waiting.size)
    if (results.length !== view.waiting.size || results.some(m => m.role !== "tool" || !view.waiting.has(m.tool_call_id!)) || new Set(results.map(m => m.tool_call_id)).size !== view.waiting.size || rest.some(m => m.role !== "user")) return null
    // A pending tool phase accepts tool results only, so a user message sent
    // alongside them travels with the last result.
    const extra = rest.map(m => textOf(m.content)).filter(Boolean).join("\n\n")
    return { kind: "tool-results", results: results.map((m, index) => ({
      requestId: view.waiting.get(m.tool_call_id!)!,
      content: index === results.length - 1 && extra ? `${textOf(m.content)}\n\n[User message sent with these tool results]\n${extra}` : textOf(m.content),
    })) }
  }
  if (!tail.length || tail.some(m => m.role !== "user")) return null
  const attachments = tail.flatMap(message => message.attachments ?? [])
  return { kind: "user", prompt: tail.map(m => textOf(m.content)).join("\n\n"), ...(attachments.length ? { attachments } : {}) }
}

/** The prompt that opens a new session: the message itself, or a replay. */
export function openingPrompt(history: ChatMessage[]): { prompt: string; replayed: boolean; attachments?: CopilotAttachment[] } {
  if (history.length === 1 && history[0]!.role === "user") return { prompt: textOf(history[0]!.content), replayed: false, ...(history[0]!.attachments?.length ? { attachments: history[0]!.attachments } : {}) }
  const parts = ["[Meridian started a new model session for this conversation. The earlier conversation is replayed below as text. Continue from the end. Do not repeat tool calls that already have results; request tools through real tool calls, never as text.]"]
  for (const m of history) {
    if (m.role === "user") parts.push(`## User\n${textOf(m.content)}`)
    else if (m.role === "assistant") {
      const text = textOf(m.content)
      parts.push(`## Assistant${text ? `\n${text}` : ""}`)
      for (const call of m.tool_calls ?? []) parts.push(`Tool call ${call.id}: ${call.function.name}(${call.function.arguments})`)
    } else parts.push(`## Tool result for ${m.tool_call_id}\n${textOf(m.content)}`)
  }
  const attachments = history.flatMap(message => message.attachments ?? [])
  return { prompt: parts.join("\n\n"), replayed: true, ...(attachments.length ? { attachments } : {}) }
}
