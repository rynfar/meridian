/** Pure rendering of client tool history for SDK replay. */
import { sanitizeAssistantText } from "./sanitize"
import { describeToolCall, MULTIMODAL_TYPES, REPLAY_CONTEXT_OPEN, REPLAY_CONTEXT_CLOSE, type ToolCallInfo } from "./messages"

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function mediaType(block: unknown): string | undefined {
  return record(block) && typeof block.type === "string" && MULTIMODAL_TYPES.has(block.type)
    ? block.type : undefined
}

function mediaCounts(content: unknown): Record<"image" | "document" | "file", number> {
  const counts = { image: 0, document: 0, file: 0 }
  if (!Array.isArray(content)) return counts
  for (const block of content) {
    const type = mediaType(block)
    if (type === "image" || type === "document" || type === "file") counts[type]++
  }
  return counts
}

function mediaSummary(counts: ReturnType<typeof mediaCounts>): string {
  return `${counts.image} ${counts.image === 1 ? "image" : "images"}, ` +
    `${counts.document} ${counts.document === 1 ? "document" : "documents"}, and ` +
    `${counts.file} ${counts.file === 1 ? "file" : "files"}`
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
  const lastIndex = messages.length - 1
  const historical = { image: 0, document: 0, file: 0 }
  if (endsWithUser) {
    for (const entry of messages.slice(0, lastIndex)) {
      const counts = mediaCounts(entry.message.content)
      historical.image += counts.image
      historical.document += counts.document
      historical.file += counts.file
    }
  }
  const hasHistoricalMedia = historical.image + historical.document + historical.file > 0
  const current = mediaCounts(messages[lastIndex]!.message.content)
  const provenance = hasHistoricalMedia
    ? `\n[Meridian attachment provenance: The current client turn contains exactly ${mediaSummary(current)}. ` +
      `Earlier replayed turns contain ${mediaSummary(historical)}. ` +
      `Those historical media are not new user attachments in this turn.]`
    : ""
  const framed = messages.map((entry, index) => {
    const isHistory = endsWithUser && index < lastIndex
    const prefix = !endsWithUser ? "" : index === 0 ? REPLAY_CONTEXT_OPEN : index === lastIndex
      ? REPLAY_CONTEXT_CLOSE + (hasHistoricalMedia
        ? "Any images, documents, or files above came from earlier turns in this replay. They are not attachments to the user's current message below.\n\n"
        : "") : ""
    const content = entry.message.content
    const suffix = index === lastIndex ? provenance : ""
    if (!Array.isArray(content)) {
      if (!prefix && !suffix) return entry
      return { ...entry, message: { ...entry.message, content: prefix + String(content ?? "") + suffix } }
    }
    const blocks = isHistory ? content.flatMap(block => {
      const type = mediaType(block)
      return type
        ? [{ type: "text", text: `Historical ${type} from an earlier turn, not an attachment to the current user message:\n` }, block]
        : [block]
    }) : content
    if (!prefix && !suffix && blocks === content) return entry
    return { ...entry, message: { ...entry.message, content: [
      ...(prefix ? [{ type: "text", text: prefix }] : []), ...blocks,
      ...(suffix ? [{ type: "text", text: suffix }] : []),
    ] } }
  })
  // SDK stream inputs are live turns, not a history-import interface. Send
  // the complete replay atomically so the model cannot answer an earlier
  // fragment before the final client tool result has arrived.
  return coalesceStructuredUserMessages(framed)
}

/** Keep completed calls as context, including their exact identity and input.
 * Native assistant messages cannot be supplied to a fresh SDK query. */
export function flattenAssistantContent(content: unknown, renderToolName?: (name: string) => string): string {
  if (typeof content === "string") return sanitizeAssistantText(content)
  if (!Array.isArray(content)) return String(content ?? "")
  return content.map(block => {
    if (!record(block)) return ""
    if (block.type === "text" && typeof block.text === "string") return sanitizeAssistantText(block.text)
    if (block.type === "tool_use") {
      const name = typeof block.name === "string" && renderToolName
        ? renderToolName(block.name)
        : block.name
      return `Previously called tool: ${JSON.stringify({ id: block.id, name, input: block.input })}`
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
