/**
 * Size limits for client tool results before they reach the model.
 *
 * A client that executes its own tools (Zed, OpenCode, Pi) sends every result
 * back verbatim, and some tools have no size ceiling of their own: Zed's `grep`
 * paginates by match count, so a few matches on a file with multi-megabyte
 * lines come back as one multi-megabyte result. A single such result is enough
 * to overflow the model's context ("Prompt is too long"), and because the
 * client resends its history on every turn, the conversation can never
 * recover: the replay budget can drop earlier history, but never the live
 * turn that carries the result.
 *
 * Instead of a fixed byte count, the limits are fractions of the model's
 * context window, so they follow the window table as models change: a result
 * may take at most `MERIDIAN_MAX_TOOL_RESULT_PCT` of the window (default 5%)
 * and all results of the live turn together at most
 * `MERIDIAN_MAX_TURN_RESULTS_PCT` (default 20%). Tokens are estimated at
 * `ESTIMATED_BYTES_PER_TOKEN` bytes each — conservative for prose and code
 * (3.5–4 bytes/token) and within ~30% of the worst case measured on
 * UUID-dense JSON (1.5 bytes/token), which the 5% slack absorbs.
 * `MERIDIAN_MAX_TOOL_RESULT_BYTES` overrides the per-result limit with an
 * absolute number; `0` in any variable disables that limit.
 *
 * An oversized result is replaced by a notice the model reads as a failed
 * call, with the original size, the limit, how to narrow the call and a short
 * sample of the data. Every replacement is recorded as a cut so the caller can
 * log it and tell the person.
 *
 * Pure leaf module: no I/O, no proxy imports. The caller supplies the window.
 */

export const DEFAULT_RESULT_WINDOW_PCT = 5
export const DEFAULT_TURN_WINDOW_PCT = 20
export const ESTIMATED_BYTES_PER_TOKEN = 2
export const PREVIEW_CHARS = 2048
const FALLBACK_WINDOW_TOKENS = 200_000

export interface ToolResultLimits {
  /** Context window the limits were derived from. */
  windowTokens: number
  /** Largest single result passed through unchanged, in bytes (Infinity = no limit). */
  perResultBytes: number
  /** Largest total of all results in the live turn, in bytes (Infinity = no limit). */
  perTurnBytes: number
}

export interface ToolResultCut {
  tool: string
  originalBytes: number
  limitBytes: number
  reason: "result" | "turn"
}

export interface ToolResultBudget {
  readonly limits: ToolResultLimits
  /** Every result replaced by a notice while building this prompt. */
  readonly cuts: ToolResultCut[]
  /** The text the model gets for this result: the text itself, or the notice. */
  fit(text: string, tool?: string): string
}

/** Tool names by `tool_use_id`; `buildToolUseIndex` from `messages.ts` fits. */
export type ToolNameIndex = ReadonlyMap<string, { name: string }>

function parseNonNegative(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function bytesForPercent(windowTokens: number, pct: number): number {
  return pct === 0 ? Infinity : Math.floor((windowTokens * pct) / 100 * ESTIMATED_BYTES_PER_TOKEN)
}

/** Limits for a model whose context window holds `windowTokens` tokens. */
export function resolveToolResultLimits(
  windowTokens: number,
  env: Record<string, string | undefined> = process.env,
): ToolResultLimits {
  const window = Number.isFinite(windowTokens) && windowTokens > 0 ? Math.floor(windowTokens) : FALLBACK_WINDOW_TOKENS
  const resultPct = parseNonNegative(env.MERIDIAN_MAX_TOOL_RESULT_PCT, DEFAULT_RESULT_WINDOW_PCT)
  const turnPct = parseNonNegative(env.MERIDIAN_MAX_TURN_RESULTS_PCT, DEFAULT_TURN_WINDOW_PCT)
  const rawBytes = env.MERIDIAN_MAX_TOOL_RESULT_BYTES
  const bytesOverride = rawBytes === undefined || rawBytes.trim() === "" ? undefined : parseNonNegative(rawBytes, NaN)
  const perResultBytes = bytesOverride === undefined || Number.isNaN(bytesOverride)
    ? bytesForPercent(window, resultPct)
    : bytesOverride === 0 ? Infinity : Math.floor(bytesOverride)
  return { windowTokens: window, perResultBytes, perTurnBytes: bytesForPercent(window, turnPct) }
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unlimited"
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`
  return `${bytes} B`
}

function withheldNotice(cut: ToolResultCut, limits: ToolResultLimits, text: string): string {
  const scope = cut.reason === "result"
    ? `the ${formatBytes(cut.limitBytes)} the proxy accepts for one result`
    : `the ${formatBytes(cut.limitBytes)} left for tool results in this turn`
  // The sample never exceeds the limit that was just enforced.
  const preview = text.slice(0, Math.min(PREVIEW_CHARS, Math.max(Math.floor(cut.limitBytes), 0)))
  const sample = preview
    ? ` The first ${formatBytes(byteLength(preview))} follow as a sample:\n${preview}`
    : ""
  return (
    `[Tool result withheld by the proxy] The \`${cut.tool}\` result is ${formatBytes(cut.originalBytes)}, ` +
    `above ${scope} (limits are a fraction of the model's ${limits.windowTokens.toLocaleString("en-US")}-token context). ` +
    `The model did not receive it. Narrow the call — a stricter include pattern, fewer context lines, ` +
    `head/tail limits, or a smaller file — and retry.` +
    sample
  )
}

function percentOfWindow(bytes: number, limits: ToolResultLimits): string {
  const pct = (bytes / ESTIMATED_BYTES_PER_TOKEN / limits.windowTokens) * 100
  const rounded = pct >= 1 ? Math.round(pct) : Math.round(pct * 100) / 100
  return `${rounded}% of the ${limits.windowTokens.toLocaleString("en-US")}-token window`
}

/**
 * The note shown to the person (prepended to the assistant's answer) when the
 * proxy withheld tool results while building this prompt. The model's own
 * notice lives in the prompt; the client UI only ever shows its own copy of
 * the result, so without this the cut is invisible outside the proxy log.
 * Ends with a blank line so the answer that follows starts on its own line.
 * Empty when nothing was withheld.
 */
export function formatWithheldNote(cuts: readonly ToolResultCut[], limits: ToolResultLimits): string {
  if (cuts.length === 0) return ""
  const list = cuts.map((cut) => `${cut.tool} ${formatBytes(cut.originalBytes)}`).join(", ")
  const parts: string[] = []
  if (cuts.some((cut) => cut.reason === "result")) {
    parts.push(`${formatBytes(limits.perResultBytes)} per result (${percentOfWindow(limits.perResultBytes, limits)})`)
  }
  if (cuts.some((cut) => cut.reason === "turn")) {
    parts.push(`${formatBytes(limits.perTurnBytes)} per turn (${percentOfWindow(limits.perTurnBytes, limits)})`)
  }
  const noun = cuts.length === 1 ? "tool result" : "tool results"
  return (
    `[meridian] Withheld ${cuts.length} ${noun} before they reached the model: ${list}. ` +
    `Limit: ${parts.join("; ")}. The model got a notice with a sample instead.\n\n`
  )
}

/** A budget for one prompt: enforces the per-result and per-turn limits in order of appearance. */
export function createToolResultBudget(limits: ToolResultLimits): ToolResultBudget {
  let remaining = limits.perTurnBytes
  const cuts: ToolResultCut[] = []
  return {
    limits,
    cuts,
    fit(text, tool = "tool") {
      const bytes = byteLength(text)
      if (bytes <= limits.perResultBytes && bytes <= remaining) {
        remaining -= bytes
        return text
      }
      const cut: ToolResultCut = bytes > limits.perResultBytes
        ? { tool, originalBytes: bytes, limitBytes: limits.perResultBytes, reason: "result" }
        : { tool, originalBytes: bytes, limitBytes: Math.max(remaining, 0), reason: "turn" }
      cuts.push(cut)
      const notice = withheldNotice(cut, limits, text)
      remaining = Math.max(remaining - byteLength(notice), 0)
      return notice
    },
  }
}

interface ContentBlock {
  type?: string
  text?: string
  tool_use_id?: string
  content?: unknown
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return !!block && typeof block === "object" && (block as ContentBlock).type === "text"
    && typeof (block as ContentBlock).text === "string"
}

/**
 * Apply the budget to the tool_result blocks of one user message's content,
 * keeping non-text parts such as images. A replaced result is marked
 * `is_error` so the model treats the call as failed and narrows it. Returns
 * the same array when nothing changed; blocks other than tool_result are
 * returned as they are.
 */
export function capStructuredToolResults(
  content: unknown,
  budget: ToolResultBudget,
  toolNames: ToolNameIndex,
): unknown {
  if (!Array.isArray(content)) return content
  let changed = false
  const capped = content.map((block: unknown) => {
    if (!block || typeof block !== "object" || (block as ContentBlock).type !== "tool_result") return block
    const result = block as ContentBlock
    const tool = (result.tool_use_id && toolNames.get(result.tool_use_id)?.name) || "tool"
    if (typeof result.content === "string") {
      const fitted = budget.fit(result.content, tool)
      if (fitted === result.content) return block
      changed = true
      return { ...result, content: fitted, is_error: true }
    }
    if (!Array.isArray(result.content)) return block
    const texts = result.content.filter(isTextBlock)
    const joined = texts.map((t) => t.text).join("\n")
    const fitted = budget.fit(joined, tool)
    if (fitted === joined) return block
    changed = true
    const others = result.content.filter((b: unknown) => !isTextBlock(b))
    return { ...result, content: [{ type: "text", text: fitted }, ...others], is_error: true }
  })
  return changed ? capped : content
}

export interface CappedClientMessages<T> {
  messages: T[]
  cuts: ToolResultCut[]
  limits: ToolResultLimits
}

/**
 * Bound the tool results of the client messages that become one SDK prompt.
 *
 * The per-result limit applies everywhere. The per-turn limit applies only to
 * the live turn — the messages after the last assistant turn — because a
 * fresh replay of a long history carries every earlier result as well, and
 * spending the turn's budget on those would withhold the newest results, the
 * ones the model is about to act on; history size is the replay budget's job.
 * Returns the same array when nothing changed.
 */
export function capClientToolResults<T extends { role: string; content: unknown }>(
  messages: readonly T[],
  limits: ToolResultLimits,
  toolNames: ToolNameIndex,
): CappedClientMessages<T> {
  const history = createToolResultBudget({ ...limits, perTurnBytes: Infinity })
  const live = createToolResultBudget(limits)
  const liveStart = messages.findLastIndex((message) => message.role === "assistant") + 1
  let changed = false
  const capped = messages.map((message, index) => {
    if (message.role !== "user") return message
    const content = capStructuredToolResults(message.content, index < liveStart ? history : live, toolNames)
    if (content === message.content) return message
    changed = true
    return { ...message, content }
  })
  return { messages: changed ? capped : [...messages], cuts: [...history.cuts, ...live.cuts], limits }
}
