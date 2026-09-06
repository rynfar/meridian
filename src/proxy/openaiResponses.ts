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
 * Also handles base64 data-URL image input and maps a `max_tokens` stop to an
 * `incomplete` Responses status.
 *
 * NOTE: agent-specific (Codex). Kept isolated per ARCHITECTURE.md — this
 * module owns the Responses wire format; no Responses logic leaks elsewhere.
 */

import type {
  AnthropicRequestBody,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTool,
  AnthropicUsage,
} from "./openai"
import { mergeAnthropicUsage, parseDataUrlImage, totalAnthropicInputTokens } from "./openai"
import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Responses request types (subset Codex actually sends)
// ---------------------------------------------------------------------------

interface ResponsesContentPart {
  type: "input_text" | "output_text" | "input_image" | string
  text?: string
  image_url?: string
}

interface ResponsesMessageItem {
  /** Optional per the spec — `EasyInputMessage` requires only `role`. */
  type?: "message"
  role: "user" | "assistant" | "developer" | "system"
  /** Also optional per the spec: `EasyInputMessage` requires only `role`. */
  content?: ResponsesContentPart[] | string
}
interface ResponsesFunctionCallItem {
  type: "function_call"
  name: string
  /** Set when the tool lives in a `namespace` tool entry (an MCP server). */
  namespace?: string
  arguments: string
  call_id: string
}
interface ResponsesFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string
}
/** A freeform (`type:"custom"`) tool call — Codex's `apply_patch`. */
interface ResponsesCustomToolCallItem {
  type: "custom_tool_call"
  name: string
  namespace?: string
  input: string
  call_id: string
}
interface ResponsesCustomToolCallOutputItem {
  type: "custom_tool_call_output"
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
  | ResponsesCustomToolCallItem
  | ResponsesCustomToolCallOutputItem
  | ResponsesReasoningItem

export interface ResponsesTool {
  type: "function" | "custom" | "namespace" | string
  name: string
  description?: string
  strict?: boolean
  parameters?: unknown
  /** `custom` tools: the freeform grammar Codex expects the input to follow. */
  format?: unknown
  /** `namespace` tools: the nested function/custom tools of one MCP server. */
  tools?: ResponsesTool[]
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
// Tool aliasing: namespaced and custom tools
// ---------------------------------------------------------------------------

/**
 * Codex (0.15x) ships every MCP server as one `{type:"namespace", name,
 * tools:[…]}` entry with the tool definitions nested inside, and its freeform
 * `apply_patch` as `{type:"custom"}`. Claude sees one flat list of function
 * tools, so each nested or custom tool is exposed under an alias, and the alias
 * table maps Claude's call back onto the exact `{namespace, name}` pair Codex's
 * router resolves (`ToolName::new(namespace, name)` — a flattened name without
 * `namespace` never matches a namespaced tool).
 */
export interface ResponsesToolAlias {
  namespace?: string
  name: string
  kind: "function" | "custom"
}
export type ResponsesToolAliases = Map<string, ResponsesToolAlias>

/**
 * Claude tool names are `[A-Za-z0-9_-]{1,64}`, and the passthrough MCP server
 * prepends its own `mcp__oc__` (PASSTHROUGH_MCP_PREFIX in passthroughTools.ts;
 * a test pins the two in sync), so an alias gets the remainder.
 */
const PASSTHROUGH_PREFIX_LENGTH = "mcp__oc__".length
export const RESPONSES_TOOL_ALIAS_MAX = 64 - PASSTHROUGH_PREFIX_LENGTH

/**
 * The Claude-visible name of a tool. Deterministic on (namespace, name): the
 * history Codex replays next turn carries the same pair and must land on the
 * same alias, or the replayed `tool_use` names no longer match the tool set.
 */
export function responsesToolAlias(namespace: string | undefined, name: string): string {
  const raw = namespace ? `${namespace}__${name}` : name
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_")
  if (safe.length <= RESPONSES_TOOL_ALIAS_MAX) return safe
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 8)
  return `${safe.slice(0, RESPONSES_TOOL_ALIAS_MAX - digest.length - 1)}_${digest}`
}

/**
 * Alias table for a request's tools. Pure and deterministic, so the route can
 * rebuild it for the response side without threading state through the
 * request translator. Top-level function tools keep their own names and are
 * not listed.
 */
export function buildResponsesToolAliases(tools: ResponsesTool[] | undefined): ResponsesToolAliases {
  const aliases: ResponsesToolAliases = new Map()
  for (const tool of tools ?? []) {
    if (tool.type === "custom") {
      aliases.set(responsesToolAlias(undefined, tool.name), { name: tool.name, kind: "custom" })
    } else if (tool.type === "namespace") {
      for (const nested of tool.tools ?? []) {
        if (nested.type !== "function" && nested.type !== "custom") continue
        aliases.set(responsesToolAlias(tool.name, nested.name), {
          namespace: tool.name,
          name: nested.name,
          kind: nested.type,
        })
      }
    }
  }
  return aliases
}

/**
 * A freeform tool has no JSON arguments: Claude gets a single `input` string
 * and the whole payload is passed through verbatim as `custom_tool_call.input`.
 */
const CUSTOM_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    input: { type: "string", description: "The complete freeform payload, exactly as the tool's format requires." },
  },
  required: ["input"],
  additionalProperties: false,
}

function customToolDescription(tool: ResponsesTool): string {
  const parts = [tool.description ?? "", "Freeform tool: put the entire payload in the `input` string; do not wrap it in JSON."]
  const format = tool.format && typeof tool.format === "object" ? (tool.format as { syntax?: unknown; definition?: unknown }) : undefined
  if (typeof format?.definition === "string") {
    parts.push(`Input grammar${typeof format.syntax === "string" ? ` (${format.syntax})` : ""}:\n${format.definition}`)
  }
  return parts.filter((s) => s.length > 0).join("\n\n")
}

function translateResponsesTools(tools: ResponsesTool[]): AnthropicTool[] {
  const out: AnthropicTool[] = []
  const push = (namespace: string | undefined, tool: ResponsesTool) => {
    if (tool.type === "function") {
      out.push({
        name: namespace ? responsesToolAlias(namespace, tool.name) : tool.name,
        description: namespace ? `[${namespace}] ${tool.description ?? ""}`.trimEnd() : tool.description ?? "",
        input_schema: tool.parameters ?? { type: "object", properties: {} },
      })
    } else if (tool.type === "custom") {
      out.push({
        name: responsesToolAlias(namespace, tool.name),
        description: customToolDescription(tool),
        input_schema: CUSTOM_TOOL_INPUT_SCHEMA,
      })
    }
    // Server-side tool kinds (`web_search`, …) have no Claude counterpart here.
  }
  for (const tool of tools) {
    if (tool.type === "namespace") {
      for (const nested of tool.tools ?? []) push(tool.name, nested)
    } else {
      push(undefined, tool)
    }
  }
  return out
}

/** The Responses item for a Claude `tool_use`, resolved through the alias table. */
function toolCallItem(
  ctx: ResponsesCtx,
  id: string,
  callId: string,
  name: string,
  argsJson: string,
  status: "in_progress" | "completed"
): Record<string, unknown> {
  const alias = ctx.toolAliases?.get(name)
  const namespace = alias?.namespace ? { namespace: alias.namespace } : {}
  if (alias?.kind === "custom") {
    let input = argsJson
    try {
      const parsed: unknown = JSON.parse(argsJson || "{}")
      if (parsed && typeof parsed === "object" && typeof (parsed as { input?: unknown }).input === "string") {
        input = (parsed as { input: string }).input
      } else if (argsJson === "" || argsJson === "{}") {
        input = ""
      }
    } catch {
      // Not JSON: Claude may already have emitted the freeform payload itself.
    }
    return { type: "custom_tool_call", id, call_id: callId, name: alias.name, ...namespace, input, status }
  }
  return { type: "function_call", id, call_id: callId, name: alias?.name ?? name, ...namespace, arguments: argsJson, status }
}

// ---------------------------------------------------------------------------
// Request translation: Responses → Anthropic
// ---------------------------------------------------------------------------

/**
 * The effective discriminator for an input item.
 *
 * `type` is optional on Responses input items — `EasyInputMessage` requires
 * only `role` — so a typeless item that carries a role IS a message. Codex
 * always sends `type`, which is why this went unnoticed; clients that follow
 * the spec (e.g. the Vercel AI SDK's `.responses()` model) send bare
 * `{role, content}` and had every message silently dropped, translating to
 * zero messages and a 400 from upstream.
 *
 * Returns undefined for anything unrecognized, so the caller's `default:`
 * skips it:
 *   - non-object elements — `input` is untrusted JSON, and `in` THROWS on a
 *     primitive operand, which would surface as an unstructured HTTP 500
 *   - a present-but-unknown `type` — future item kinds must not be coerced
 *     into messages just because they happen to carry a role
 */
function itemDiscriminator(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined
  const record = item as Record<string, unknown>
  if (typeof record.type === "string") return record.type
  if (record.type === undefined && "role" in record) return "message"
  return undefined
}

function partsToText(content: ResponsesContentPart[] | string | undefined): string {
  if (content === undefined) return ""
  if (typeof content === "string") return content
  return content
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text)
    .join("")
}

/**
 * Content blocks for a message with image parts. Returns null when there are
 * no images so the caller keeps the plain-text path. Remote (non-data-URL)
 * images become an omission note, matching the chat-completions adapter.
 */
function partsToBlocks(content: ResponsesContentPart[] | string | undefined): AnthropicContentBlock[] | null {
  if (content === undefined || typeof content === "string") return null
  const hasImage = content.some((p) => p.type === "input_image")
  if (!hasImage) return null

  const blocks: AnthropicContentBlock[] = []
  for (const part of content) {
    if (typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text })
    } else if (part.type === "input_image") {
      const image = typeof part.image_url === "string" ? parseDataUrlImage(part.image_url) : null
      blocks.push(image ?? { type: "text", text: "[Unsupported input_image omitted: only data URLs are currently supported]" })
    }
  }
  return blocks
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
    // NOTE: this switches on a COMPUTED discriminator, not on `item.type`, so
    // TypeScript no longer narrows `item` per case — the `as` casts below are
    // load-bearing assertions rather than belt-and-braces. Keep them.
    switch (itemDiscriminator(item)) {
      case "message": {
        const msg = item as ResponsesMessageItem
        if (msg.role === "developer" || msg.role === "system") {
          const t = partsToText(msg.content)
          if (t) systemParts.push(t)
          break
        }
        const role = msg.role === "assistant" ? "assistant" : "user"
        const imageBlocks = partsToBlocks(msg.content)
        if (imageBlocks) {
          for (const block of imageBlocks) pushBlock(role, block)
          break
        }
        const text = partsToText(msg.content)
        if (text) pushBlock(role, { type: "text", text })
        break
      }
      case "function_call": {
        const fc = item as ResponsesFunctionCallItem
        let input: Record<string, unknown> = {}
        try { input = fc.arguments ? JSON.parse(fc.arguments) : {} } catch { input = {} }
        const name = fc.namespace ? responsesToolAlias(fc.namespace, fc.name) : fc.name
        pushBlock("assistant", { type: "tool_use", id: fc.call_id, name, input })
        break
      }
      case "function_call_output": {
        const fo = item as ResponsesFunctionCallOutputItem
        pushBlock("user", { type: "tool_result", tool_use_id: fo.call_id, content: fo.output })
        break
      }
      case "custom_tool_call": {
        const ct = item as ResponsesCustomToolCallItem
        const name = responsesToolAlias(ct.namespace, ct.name)
        pushBlock("assistant", { type: "tool_use", id: ct.call_id, name, input: { input: ct.input ?? "" } })
        break
      }
      case "custom_tool_call_output": {
        const co = item as ResponsesCustomToolCallOutputItem
        pushBlock("user", { type: "tool_result", tool_use_id: co.call_id, content: co.output })
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
    result.tools = translateResponsesTools(body.tools)
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
  /**
   * Alias table from `buildResponsesToolAliases(request.tools)`: maps Claude's
   * tool_use names back onto Codex's `{namespace, name}` and custom tools.
   */
  toolAliases?: ResponsesToolAliases
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
  usage?: AnthropicUsage
}

function mapUsage(usage: AnthropicUsage | undefined) {
  const input = totalAnthropicInputTokens(usage)
  const output = usage?.output_tokens ?? 0
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    // `cached_tokens` is OpenAI's field; `cache_write_tokens` is a Meridian
    // extension — see the note on OpenAiCompletion in ./openai.
    input_tokens_details: {
      cached_tokens: usage?.cache_read_input_tokens ?? 0,
      cache_write_tokens: usage?.cache_creation_input_tokens ?? 0,
    },
  }
}

/**
 * A `max_tokens` stop means truncation — report `incomplete` so the client
 * can tell a cut-off answer from a finished one.
 */
function toResponsesStatus(stopReason: string | undefined): "completed" | "incomplete" {
  return stopReason === "max_tokens" ? "incomplete" : "completed"
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
      const callId = String(block.id)
      output.push(toolCallItem(ctx, `fc_${callId}`, callId, String(block.name), JSON.stringify(block.input ?? {}), "completed"))
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

  const status = toResponsesStatus(res.stop_reason)
  return {
    id: ctx.responseId,
    object: "response",
    created_at: ctx.created,
    model: ctx.model,
    status,
    ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
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
  message?: { id?: string; usage?: AnthropicUsage }
  content_block?: { type?: string; id?: string; name?: string; input?: unknown }
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; stop_reason?: string }
  usage?: AnthropicUsage
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
  let usage: AnthropicUsage | undefined
  let createdEmitted = false
  let stopReason: string | undefined

  // Per-open-block state, keyed by Anthropic block index.
  interface BlockState {
    kind: "text" | "tool" | "skip"
    outputIndex: number
    itemId: string
    text: string          // accumulated text (text blocks)
    args: string          // accumulated JSON (tool blocks)
    callId?: string
    name?: string
    custom?: boolean      // freeform tool: no argument deltas, one done item
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
        if (event.message?.usage) usage = mergeAnthropicUsage(usage, event.message.usage)
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
          const callId = String(cb.id ?? "")
          const name = String(cb.name ?? "")
          const custom = ctx.toolAliases?.get(name)?.kind === "custom"
          blocks.set(idx, { kind: "tool", outputIndex: oi, itemId, text: "", args: "", callId, name, custom })
          out.push(emit("response.output_item.added", {
            output_index: oi,
            item: toolCallItem(ctx, itemId, callId, name, "", "in_progress"),
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
          // A custom tool's payload is the `input` string inside Claude's JSON
          // — it cannot be streamed as freeform deltas; Codex takes the whole
          // item from response.output_item.done.
          if (!st.custom) {
            out.push(emit("response.function_call_arguments.delta", {
              item_id: st.itemId, output_index: st.outputIndex, delta: event.delta.partial_json,
            }))
          }
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
          if (!st.custom) {
            out.push(emit("response.function_call_arguments.done", {
              item_id: st.itemId, output_index: st.outputIndex, arguments: st.args,
            }))
          }
          const item = toolCallItem(ctx, st.itemId, st.callId ?? "", st.name ?? "", st.args, "completed")
          finalOutput.push(item)
          out.push(emit("response.output_item.done", { output_index: st.outputIndex, item }))
        }
        break
      }

      case "message_delta": {
        if (event.usage) usage = mergeAnthropicUsage(usage, event.usage)
        if (typeof event.delta?.stop_reason === "string") stopReason = event.delta.stop_reason
        break
      }

      case "message_stop": {
        const status = toResponsesStatus(stopReason)
        out.push(emit(status === "incomplete" ? "response.incomplete" : "response.completed", {
          response: responseEnvelope(status, {
            output: finalOutput,
            usage: mapUsage(usage),
            parallel_tool_calls: true,
            tool_choice: "auto",
            tools: [],
            ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
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
