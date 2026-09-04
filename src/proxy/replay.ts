/** Pure rendering of client tool history for SDK replay. */
import { sanitizeAssistantText } from "./sanitize"
import { describeToolCall, type ToolCallInfo } from "./messages"

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
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
