/**
 * OpenAI Responses API ⇄ Anthropic translation (#475).
 *
 * Pure functions — no HTTP/Hono — mirroring `openai.ts` (the chat-completions
 * adapter). Serves the Codex CLI ≥ 0.96, which dropped `wire_api="chat"` and
 * now speaks only `POST /v1/responses`. The `/v1/responses` route in
 * server.ts forwards in-process to `/v1/messages` and pipes the response
 * through these translators.
 *
 * Scope is Phase 1 of the approved design spec
 * (docs/superpowers/specs/2026-07-08-codex-responses-api-design.md): text +
 * function tool-calling, streaming and non-streaming, forced passthrough.
 * Reasoning items are omitted (verified working against real Codex 0.143).
 *
 * NOTE: agent-specific (Codex). Kept isolated per ARCHITECTURE.md — this
 * module owns the Responses wire format; no Responses logic leaks elsewhere.
 */

import type {
  AnthropicRequestBody,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTool,
} from "./openai"

// ---------------------------------------------------------------------------
// Responses request types (subset Codex actually sends)
// ---------------------------------------------------------------------------

interface ResponsesContentPart {
  type: "input_text" | "output_text" | string
  text?: string
}

interface ResponsesMessageItem {
  type: "message"
  role: "user" | "assistant" | "developer" | "system"
  content: ResponsesContentPart[] | string
}
interface ResponsesFunctionCallItem {
  type: "function_call"
  name: string
  arguments: string
  call_id: string
}
interface ResponsesFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string
}
interface ResponsesReasoningItem {
  type: "reasoning"
  [k: string]: unknown
}
type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem

interface ResponsesTool {
  type: "function" | string
  name: string
  description?: string
  strict?: boolean
  parameters?: unknown
}

export interface ResponsesRequest {
  model?: string
  instructions?: string
  input?: string | ResponsesInputItem[]
  tools?: ResponsesTool[]
  tool_choice?: unknown
  parallel_tool_calls?: boolean
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  reasoning?: { effort?: string }
  stream?: boolean
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Request translation: Responses → Anthropic
// ---------------------------------------------------------------------------

function partsToText(content: ResponsesContentPart[] | string): string {
  if (typeof content === "string") return content
  return content
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text)
    .join("")
}

/**
 * Map a Responses `tool_choice` to Anthropic's. Codex sends `"auto"`,
 * `"required"`, `"none"`, or `{type:"function", name}`. `"none"` maps to
 * undefined (Anthropic has no explicit none — omitting lets the model decide,
 * and Codex only sends none when it doesn't want tools anyway).
 */
function mapToolChoice(tc: unknown): AnthropicRequestBody["tool_choice"] {
  if (tc === "auto") return { type: "auto" }
  if (tc === "required") return { type: "any" }
  if (tc && typeof tc === "object") {
    const o = tc as { type?: string; name?: string }
    if (o.type === "function" && o.name) return { type: "tool", name: o.name }
    if (o.type === "auto") return { type: "auto" }
    if (o.type === "any" || o.type === "required") return { type: "any" }
  }
  return undefined
}

/**
 * Translate a Responses request to an Anthropic /v1/messages body.
 * Returns null when `input` is missing (invalid request).
 */
export function translateResponsesToAnthropic(body: ResponsesRequest): AnthropicRequestBody | null {
  if (body.input === undefined || body.input === null) return null

  const items: ResponsesInputItem[] =
    typeof body.input === "string"
      ? [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }]
      : body.input

  // System: instructions + any developer/system-role messages folded in
  // (Codex's harness rules arrive as developer turns).
  const systemParts: string[] = []
  if (body.instructions) systemParts.push(body.instructions)

  const messages: AnthropicMessage[] = []
  const pushBlock = (role: "user" | "assistant", block: AnthropicContentBlock) => {
    const last = messages[messages.length - 1]
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content.push(block)
    } else {
      messages.push({ role, content: [block] })
    }
  }

  for (const item of items) {
    switch (item.type) {
      case "message": {
        const msg = item as ResponsesMessageItem
        if (msg.role === "developer" || msg.role === "system") {
          const t = partsToText(msg.content)
          if (t) systemParts.push(t)
          break
        }
        const text = partsToText(msg.content)
        if (text) pushBlock(msg.role === "assistant" ? "assistant" : "user", { type: "text", text })
        break
      }
      case "function_call": {
        const fc = item as ResponsesFunctionCallItem
        let input: Record<string, unknown> = {}
        try { input = fc.arguments ? JSON.parse(fc.arguments) : {} } catch { input = {} }
        pushBlock("assistant", { type: "tool_use", id: fc.call_id, name: fc.name, input })
        break
      }
      case "function_call_output": {
        const fo = item as ResponsesFunctionCallOutputItem
        pushBlock("user", { type: "tool_result", tool_use_id: fo.call_id, content: fo.output })
        break
      }
      case "reasoning":
        // Phase 1: dropped. Phase 2 decodes the encrypted envelope back into
        // a Claude thinking block for reasoning continuity.
        break
      default:
        break
    }
  }

  const result: AnthropicRequestBody = {
    model: typeof body.model === "string" ? body.model : "",
    messages,
    max_tokens: body.max_output_tokens ?? 8192,
    stream: body.stream ?? false,
  }
  if (systemParts.length > 0) result.system = systemParts.join("\n\n")
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = body.tools
      .filter((t) => t.type === "function")
      .map((t): AnthropicTool => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.parameters ?? { type: "object", properties: {} },
      }))
  }
  const tc = mapToolChoice(body.tool_choice)
  if (tc) result.tool_choice = tc
  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.top_p !== undefined) result.top_p = body.top_p
  if (body.reasoning?.effort !== undefined) result.reasoning_effort = body.reasoning.effort

  return result
}

// ---------------------------------------------------------------------------
// Response translation: Anthropic → Responses (non-streaming)
// ---------------------------------------------------------------------------

export interface ResponsesCtx {
  responseId: string
  model: string
  created: number
  /**
   * The client asked for reasoning (Codex sends `reasoning.effort` +
   * `include: ["reasoning.encrypted_content"]`). Phase 1 doesn't forward
   * Claude's signed thinking, but Codex 0.144 HANGS waiting for a reasoning
   * item it requested — so we emit one empty placeholder reasoning item to
   * satisfy its state machine. Set from `reasoningRequested(body)`.
   */
  reasoningRequested?: boolean
}

/** Did the Responses request ask for reasoning output? */
export function reasoningRequested(body: ResponsesRequest): boolean {
  if (body.reasoning && typeof body.reasoning === "object") return true
  const include = (body as { include?: unknown }).include
  return Array.isArray(include) && include.some((v) => typeof v === "string" && v.startsWith("reasoning"))
}

interface AnthropicResponseLike {
  content?: Array<Record<string, unknown>>
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

function mapUsage(usage: { input_tokens?: number; output_tokens?: number } | undefined) {
  const input = usage?.input_tokens ?? 0
  const output = usage?.output_tokens ?? 0
  return { input_tokens: input, output_tokens: output, total_tokens: input + output }
}

/**
 * Assemble a complete Responses `response` object from an Anthropic response.
 * Text blocks become a single `message` item with `output_text` parts;
 * tool_use blocks become `function_call` items. Thinking blocks are dropped.
 */
export function translateAnthropicToResponses(res: AnthropicResponseLike, ctx: ResponsesCtx): Record<string, unknown> {
  const output: Array<Record<string, unknown>> = []
  const textParts: Array<{ type: "output_text"; text: string; annotations: unknown[] }> = []

  for (const block of res.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push({ type: "output_text", text: block.text, annotations: [] })
    } else if (block.type === "tool_use") {
      output.push({
        type: "function_call",
        id: `fc_${block.id}`,
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
        status: "completed",
      })
    }
    // thinking: dropped (phase 1)
  }

  // Message item first (Codex renders assistant text), then tool calls — but
  // only emit a message item if there is text (a pure tool turn has none).
  if (textParts.length > 0) {
    output.unshift({
      type: "message",
      id: `msg_${ctx.responseId}`,
      status: "completed",
      role: "assistant",
      content: textParts,
    })
  }

  // Placeholder reasoning item (#475) so a reasoning-requesting client doesn't
  // hang waiting for one — see the streaming translator for the rationale.
  if (ctx.reasoningRequested) {
    output.unshift({
      type: "reasoning",
      id: `rs_${ctx.responseId}`,
      summary: [],
      encrypted_content: null,
      status: "completed",
    })
  }

  return {
    id: ctx.responseId,
    object: "response",
    created_at: ctx.created,
    model: ctx.model,
    status: "completed",
    output,
    usage: mapUsage(res.usage),
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
  }
}

// ---------------------------------------------------------------------------
// Response translation: Anthropic SSE → Responses SSE (streaming)
// ---------------------------------------------------------------------------

export interface AnthropicSseEvent {
  type: string
  index?: number
  message?: { id?: string; usage?: { input_tokens?: number } }
  content_block?: { type?: string; id?: string; name?: string; input?: unknown }
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; stop_reason?: string }
  usage?: { output_tokens?: number }
}

export interface ResponsesSseEmission {
  event: string
  data: Record<string, unknown>
}

/**
 * Stateful Anthropic-SSE → Responses-SSE translator. One instance per stream;
 * call with each Anthropic event, emit the returned Responses events in order.
 */
export function createResponsesSseTranslator(ctx: ResponsesCtx) {
  let seq = 0
  let outputIndex = 0
  let inputTokens = 0
  let outputTokens = 0
  let createdEmitted = false

  // Per-open-block state, keyed by Anthropic block index.
  interface BlockState {
    kind: "text" | "tool" | "skip"
    outputIndex: number
    itemId: string
    text: string          // accumulated text (text blocks)
    args: string          // accumulated JSON (tool blocks)
    callId?: string
    name?: string
  }
  const blocks = new Map<number, BlockState>()
  // Completed items collected for the terminal response.completed.
  const finalOutput: Array<Record<string, unknown>> = []

  // The Responses event `data` payload MUST carry its own `type` field — the
  // OpenAI Responses SSE format is self-describing and Codex's deserializer
  // is `#[serde(tag = "type")]`, so a payload without `type` fails to parse
  // and Codex treats the whole stream as broken ("stream closed before
  // response.completed") even though every event was sent. The SSE `event:`
  // line alone is not enough.
  const emit = (event: string, data: Record<string, unknown>): ResponsesSseEmission => ({
    event,
    data: { type: event, ...data, sequence_number: seq++ },
  })

  const responseEnvelope = (status: string, extra: Record<string, unknown> = {}) => ({
    id: ctx.responseId,
    object: "response",
    created_at: ctx.created,
    model: ctx.model,
    status,
    ...extra,
  })

  return (event: AnthropicSseEvent): ResponsesSseEmission[] => {
    const out: ResponsesSseEmission[] = []

    switch (event.type) {
      case "message_start": {
        inputTokens = event.message?.usage?.input_tokens ?? 0
        if (!createdEmitted) {
          createdEmitted = true
          out.push(emit("response.created", { response: responseEnvelope("in_progress", { output: [] }) }))
          out.push(emit("response.in_progress", { response: responseEnvelope("in_progress", { output: [] }) }))
          // Placeholder reasoning item (#475): Codex hangs if it requested
          // reasoning and no reasoning item appears. Phase 1 forwards no
          // actual thinking; an empty item satisfies the client's state
          // machine. Codex echoes it back next turn — where our request
          // translator drops reasoning items — so it's inert.
          if (ctx.reasoningRequested) {
            const oi = outputIndex++
            const itemId = `rs_${ctx.responseId}`
            const item = { type: "reasoning", id: itemId, summary: [] as unknown[], encrypted_content: null, status: "completed" }
            out.push(emit("response.output_item.added", { output_index: oi, item: { ...item, status: "in_progress" } }))
            finalOutput.push(item)
            out.push(emit("response.output_item.done", { output_index: oi, item }))
          }
        }
        break
      }

      case "content_block_start": {
        const idx = event.index ?? 0
        const cb = event.content_block ?? {}
        if (cb.type === "text") {
          const oi = outputIndex++
          const itemId = `msg_${ctx.responseId}_${oi}`
          blocks.set(idx, { kind: "text", outputIndex: oi, itemId, text: "", args: "" })
          out.push(emit("response.output_item.added", {
            output_index: oi,
            item: { type: "message", id: itemId, status: "in_progress", role: "assistant", content: [] },
          }))
          out.push(emit("response.content_part.added", {
            item_id: itemId, output_index: oi, content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }))
        } else if (cb.type === "tool_use") {
          const oi = outputIndex++
          const itemId = `fc_${cb.id}`
          blocks.set(idx, { kind: "tool", outputIndex: oi, itemId, text: "", args: "", callId: cb.id, name: cb.name })
          out.push(emit("response.output_item.added", {
            output_index: oi,
            item: { type: "function_call", id: itemId, call_id: cb.id, name: cb.name, arguments: "", status: "in_progress" },
          }))
        } else {
          // thinking / unknown → skip, but track so deltas/stop are ignored.
          blocks.set(idx, { kind: "skip", outputIndex: -1, itemId: "", text: "", args: "" })
        }
        break
      }

      case "content_block_delta": {
        const idx = event.index ?? 0
        const st = blocks.get(idx)
        if (!st || st.kind === "skip") break
        if (st.kind === "text" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
          st.text += event.delta.text
          out.push(emit("response.output_text.delta", {
            item_id: st.itemId, output_index: st.outputIndex, content_index: 0, delta: event.delta.text,
          }))
        } else if (st.kind === "tool" && event.delta?.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
          st.args += event.delta.partial_json
          out.push(emit("response.function_call_arguments.delta", {
            item_id: st.itemId, output_index: st.outputIndex, delta: event.delta.partial_json,
          }))
        }
        break
      }

      case "content_block_stop": {
        const idx = event.index ?? 0
        const st = blocks.get(idx)
        if (!st || st.kind === "skip") break
        if (st.kind === "text") {
          out.push(emit("response.output_text.done", {
            item_id: st.itemId, output_index: st.outputIndex, content_index: 0, text: st.text,
          }))
          out.push(emit("response.content_part.done", {
            item_id: st.itemId, output_index: st.outputIndex, content_index: 0,
            part: { type: "output_text", text: st.text, annotations: [] },
          }))
          const item = {
            type: "message", id: st.itemId, status: "completed", role: "assistant",
            content: [{ type: "output_text", text: st.text, annotations: [] }],
          }
          finalOutput.push(item)
          out.push(emit("response.output_item.done", { output_index: st.outputIndex, item }))
        } else if (st.kind === "tool") {
          out.push(emit("response.function_call_arguments.done", {
            item_id: st.itemId, output_index: st.outputIndex, arguments: st.args,
          }))
          const item = {
            type: "function_call", id: st.itemId, call_id: st.callId, name: st.name,
            arguments: st.args, status: "completed",
          }
          finalOutput.push(item)
          out.push(emit("response.output_item.done", { output_index: st.outputIndex, item }))
        }
        break
      }

      case "message_delta": {
        if (typeof event.usage?.output_tokens === "number") outputTokens = event.usage.output_tokens
        break
      }

      case "message_stop": {
        out.push(emit("response.completed", {
          response: responseEnvelope("completed", {
            output: finalOutput,
            usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
            parallel_tool_calls: true,
            tool_choice: "auto",
            tools: [],
          }),
        }))
        break
      }

      default:
        break
    }

    return out
  }
}
