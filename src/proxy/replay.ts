/** Pure rendering of client tool history for SDK replay. */
import { sanitizeAssistantText } from "./sanitize"
import { describeToolCall, MULTIMODAL_TYPES, REPLAY_CONTEXT_OPEN, REPLAY_CONTEXT_CLOSE, type ToolCallInfo } from "./messages"

interface ReplayMessage {
  role: string
  content: unknown
}

/** Trailing client metadata belongs to the immediately preceding live user
 * turn. Keep it in that turn when framing replay, without making it an SDK
 * system instruction or changing the original messages used for lineage. */
export function coalesceTrailingSystemReminders(messages: readonly ReplayMessage[]): ReplayMessage[] {
  let boundary = messages.length - 1
  while (boundary >= 0 && messages[boundary]?.role === "system") boundary--
  if (boundary < 0 || boundary === messages.length - 1 || messages[boundary]?.role !== "user") return [...messages]
  const current = messages[boundary]!
  const currentAndReminders = messages.slice(boundary)
  if (!currentAndReminders.every(message => typeof message.content === "string" || Array.isArray(message.content))) return [...messages]
  const content = currentAndReminders.every(message => typeof message.content === "string")
    ? currentAndReminders.map(message => message.content).join("\n\n")
    : currentAndReminders.flatMap(message => Array.isArray(message.content)
      ? message.content : [{ type: "text", text: message.content }])
  return [...messages.slice(0, boundary), { ...current, content }]
}

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

/** One rendered piece of replay text, and whether the client put a cache
 * breakpoint on the block it came from. */
export interface ReplayPart {
  text: string
  clientMarked: boolean
}

export interface ReplayTextBlock {
  type: "text"
  text: string
  cache_control?: { type: "ephemeral" }
}

/**
 * Lay out a fresh replay as text blocks whose concatenation is exactly the
 * string `frameReplayTurns` would produce for the same turns, with one cache
 * breakpoint where the prefix is expected to recur.
 *
 * A single replay string cannot be cached across requests that share history
 * but differ at the tail: the API writes cache entries only at breakpoints and
 * looks them up at block boundaries. Separators lead each block, so a block
 * never changes when later turns are appended.
 *
 * The breakpoint follows the client's own markers. History (everything up to
 * the last assistant turn) never changes once sent, so its last client marker,
 * or failing that its last block, is reusable. After the last assistant turn,
 * Claude Code's permission classifier marks the item under review as well as
 * the end of the transcript before it, and leaves the final instruction
 * unmarked; the item changes on every call. So in that live section, when the
 * client did not mark the final block, its last marker is taken as volatile
 * and the marker before it is used. This holds whether the classifier sends
 * its transcript as one message or as one message per entry. Without such a
 * marker the history choice applies; without history no breakpoint is added
 * and the caller keeps the plain replay. The final block always keeps the
 * breakpoint the SDK adds itself.
 */
export function layoutReplayBlocks(turns: Array<{ role: string; parts: ReplayPart[] }>): ReplayTextBlock[] {
  const nonEmpty = turns
    .map(turn => ({ role: turn.role, parts: turn.parts.filter(part => part.text) }))
    .filter(turn => turn.parts.length > 0)
  const lastTurn = nonEmpty.length - 1
  const framed = nonEmpty.length >= 2 && nonEmpty[lastTurn]!.role === "user"
  const lastAssistant = nonEmpty.findLastIndex(turn => turn.role === "assistant")
  const blocks: Array<ReplayTextBlock & { turn: number; clientMarked: boolean }> = []
  nonEmpty.forEach((turn, index) => turn.parts.forEach((part, partIndex) => {
    let lead = partIndex > 0 ? "\n" : index > 0 ? "\n\n" : ""
    if (framed && partIndex === 0 && index === 0) lead = REPLAY_CONTEXT_OPEN
    if (framed && partIndex === 0 && index === lastTurn) lead = REPLAY_CONTEXT_CLOSE
    blocks.push({ type: "text", text: lead + part.text, turn: index, clientMarked: part.clientMarked })
  }))
  const lastBlock = blocks.length - 1
  const liveMarked = blocks.flatMap((block, index) =>
    block.turn > lastAssistant && block.clientMarked && index < lastBlock ? [index] : [])
  const live = blocks[lastBlock]?.clientMarked ? liveMarked.at(-1) : liveMarked.at(-2)
  const history = blocks.findLastIndex(block => block.turn <= lastAssistant && block.clientMarked)
  const historyEnd = blocks.findLastIndex(block => block.turn <= lastAssistant)
  const marker = live ?? (history >= 0 ? history : historyEnd)
  return blocks.map(({ turn: _turn, clientMarked: _marked, ...block }, index) =>
    index === marker && index < lastBlock ? { ...block, cache_control: { type: "ephemeral" as const } } : block)
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

/** Client `system` tool-change blocks (`tool_addition`/`tool_removal`) are only
 * valid inside a mid-conversation system message. Replay recasts history as user
 * turns, where the API rejects them, so they are rendered as history text. */
function toolChangeText(block: Record<string, unknown>): string | undefined {
  if (block.type !== "tool_addition" && block.type !== "tool_removal") return undefined
  const tool = record(block.tool) ? block.tool : undefined
  const name = typeof block.name === "string" ? block.name : typeof tool?.name === "string" ? tool.name : "unknown"
  return `[Client ${block.type === "tool_addition" ? "added" : "removed"} tool: ${name}]`
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
    const toolChange = toolChangeText(block)
    if (toolChange) return [{ type: "text", text: toolChange }]
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
