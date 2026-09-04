/** Pure rendering of client tool history for SDK replay. */
import { sanitizeAssistantText } from "./sanitize"
import { describeToolCall, REPLAY_CONTEXT_OPEN, REPLAY_CONTEXT_CLOSE, type ToolCallInfo } from "./messages"

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** One HTTP request must not become several independently answered SDK turns. */
export function coalesceStructuredUserMessages<T extends { message: { content: unknown } }>(messages: T[]): T[] {
  if (messages.length < 2) return messages
  const first = messages[0]!
  return [{ ...first, message: { ...first.message, content: messages.flatMap(entry =>
    Array.isArray(entry.message.content) ? entry.message.content
      : [{ type: "text", text: String(entry.message.content ?? "") }]) } }]
}

/** Frame multimodal history just like text history; the SDK may coalesce the
 * user input messages, but their historical/context boundary must survive. */
export function frameStructuredReplay<T extends { message: { content: unknown } }>(messages: T[], endsWithUser = true): T[] {
  if (messages.length < 2) return messages
  const framed = messages.map((entry, index) => {
    const prefix = !endsWithUser ? "" : index === 0 ? REPLAY_CONTEXT_OPEN : index === messages.length - 1 ? REPLAY_CONTEXT_CLOSE : ""
    if (!prefix) return entry
    const content = entry.message.content
    return { ...entry, message: { ...entry.message, content: Array.isArray(content)
      ? [{ type: "text", text: prefix }, ...content]
      : prefix + String(content ?? "") } }
  })
  // SDK stream inputs are live turns, not a history-import interface. Send
  // the complete replay atomically so the model cannot answer an earlier
  // fragment before the final client tool result has arrived.
  return coalesceStructuredUserMessages(framed)
}

/** Keep completed calls as context, including their exact identity and input.
 * Native assistant messages cannot be supplied to a fresh SDK query. */
export function flattenAssistantContent(content: unknown): string {
  if (typeof content === "string") return sanitizeAssistantText(content)
  if (!Array.isArray(content)) return String(content ?? "")
  return content.map(block => {
    if (!record(block)) return ""
    if (block.type === "text" && typeof block.text === "string") return sanitizeAssistantText(block.text)
    if (block.type === "tool_use") {
      return `Previously called tool: ${JSON.stringify({ id: block.id, name: block.name, input: block.input })}`
    }
    return ""
  }).filter(Boolean).join("\n")
}

/** Identity and success/error are semantic even when the output text matches. */
export function replayToolResultHeader(block: Record<string, unknown>, info?: ToolCallInfo): string {
  const attribution = info ? `${describeToolCall(info)}\n` : ""
  return `${attribution}Recorded tool result: ${JSON.stringify({ tool_use_id: block.tool_use_id, is_error: block.is_error ?? false })}`
}

/** Only a real SDK tool checkpoint may receive native tool_result blocks.
 * Fresh replay renders results as history, retaining their payloads and media
 * rather than presenting orphan results for calls absent from the SDK session. */
export function normalizeStructuredUserContent(
  content: unknown,
  preserveToolResultWrapper = false,
  toolIndex?: Map<string, ToolCallInfo>,
): unknown {
  if (!Array.isArray(content)) return content
  return content.flatMap(block => {
    if (!record(block)) return []
    if (block.type !== "tool_result") return [block]
    if (preserveToolResultWrapper) {
      return [{ ...block, content: normalizeStructuredUserContent(block.content, true, toolIndex) }]
    }
    const info = typeof block.tool_use_id === "string" ? toolIndex?.get(block.tool_use_id) : undefined
    const metadata = { type: "text", text: replayToolResultHeader(block, info) }
    if (Array.isArray(block.content)) {
      const nested = normalizeStructuredUserContent(block.content, false, toolIndex)
      return [metadata, ...(Array.isArray(nested) ? nested : [])]
    }
    return [metadata, { type: "text", text: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "") }]
  })
}
