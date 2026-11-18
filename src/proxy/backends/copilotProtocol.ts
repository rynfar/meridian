/**
 * OpenAI Chat Completions requests for the Copilot backend, and how a request
 * relates to the live Copilot session that served the conversation so far.
 * Pure functions: no SDK, no I/O.
 */
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { CopilotToolDefinition } from "./copilotSdk"

export class CopilotError extends Error {
  constructor(message: string, readonly status = 400, readonly type = "invalid_request_error") { super(message) }
}

export interface ChatToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ChatMessage { role: "user" | "assistant" | "tool"; content?: unknown; tool_calls?: ChatToolCall[]; tool_call_id?: string }

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
  | { kind: "user"; prompt: string }

const SUPPORTED = new Set(["model", "messages", "tools", "stream", "stream_options", "max_tokens", "max_completion_tokens", "temperature", "tool_choice", "reasoning_effort", "parallel_tool_calls"])
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/
const SESSION_HEADERS = ["x-session-affinity", "x-opencode-session", "x-session-id"]

export function textOf(content: unknown): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content) && content.every(part => part?.type === "text" && typeof part.text === "string")) return content.map(part => part.text).join("\n\n")
  throw new CopilotError("The Copilot backend accepts text content only. Images, audio and documents are not supported.")
}

function object(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}
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
    if (m.role === "user") return { role: "user", content: textOf(m.content) }
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
  return { kind: "user", prompt: tail.map(m => textOf(m.content)).join("\n\n") }
}

/** The prompt that opens a new session: the message itself, or a replay. */
export function openingPrompt(history: ChatMessage[]): { prompt: string; replayed: boolean } {
  if (history.length === 1 && history[0]!.role === "user") return { prompt: textOf(history[0]!.content), replayed: false }
  const parts = ["[Meridian started a new model session for this conversation. The earlier conversation is replayed below as text. Continue from the end. Do not repeat tool calls that already have results; request tools through real tool calls, never as text.]"]
  for (const m of history) {
    if (m.role === "user") parts.push(`## User\n${textOf(m.content)}`)
    else if (m.role === "assistant") {
      const text = textOf(m.content)
      parts.push(`## Assistant${text ? `\n${text}` : ""}`)
      for (const call of m.tool_calls ?? []) parts.push(`Tool call ${call.id}: ${call.function.name}(${call.function.arguments})`)
    } else parts.push(`## Tool result for ${m.tool_call_id}\n${textOf(m.content)}`)
  }
  return { prompt: parts.join("\n\n"), replayed: true }
}
