/**
 * Compaction notice.
 *
 * Claude Code compacts a session's context on its own once it grows past the
 * auto-compact threshold (or when asked to), and the SDK reports it as a
 * `system` message with subtype `compact_boundary`. Nothing else tells the
 * client: on Zed's side the thread looks intact while the model now reaches
 * the older turns only through a summary. These helpers turn that message
 * into a line for the person at the top of the answer, in the style of the
 * withheld-results note, plus a line for the logs. Pure: no I/O.
 */

export interface Compaction {
  trigger: "auto" | "manual"
  preTokens: number
  postTokens?: number
  durationMs?: number
}

/** The compaction an SDK message reports, or undefined for any other message. */
export function extractCompaction(message: unknown): Compaction | undefined {
  if (!message || typeof message !== "object") return undefined
  const m = message as { type?: unknown; subtype?: unknown; compact_metadata?: unknown }
  if (m.type !== "system" || m.subtype !== "compact_boundary") return undefined
  const meta = (m.compact_metadata && typeof m.compact_metadata === "object" ? m.compact_metadata : {}) as {
    trigger?: unknown
    pre_tokens?: unknown
    post_tokens?: unknown
    duration_ms?: unknown
  }
  return {
    trigger: meta.trigger === "manual" ? "manual" : "auto",
    preTokens: typeof meta.pre_tokens === "number" ? meta.pre_tokens : 0,
    ...(typeof meta.post_tokens === "number" ? { postTokens: meta.post_tokens } : {}),
    ...(typeof meta.duration_ms === "number" ? { durationMs: meta.duration_ms } : {}),
  }
}

function tokens(count: number): string {
  return `${count.toLocaleString("en-US")} tokens`
}

function sizeChange(compaction: Compaction): string {
  return compaction.postTokens === undefined
    ? `${tokens(compaction.preTokens)} before`
    : `${tokens(compaction.preTokens)} before, ${tokens(compaction.postTokens)} after`
}

/** One line for the proxy logs. */
export function describeCompaction(compaction: Compaction): string {
  const duration = compaction.durationMs === undefined ? "" : ` in ${compaction.durationMs} ms`
  return `context_compacted: ${compaction.trigger} compaction, ${sizeChange(compaction)}${duration}`
}

/** The note the person sees, ending in a blank line so the answer follows cleanly. */
export function formatCompactionNote(compaction: Compaction): string {
  const how = compaction.trigger === "manual" ? "on request" : "automatically"
  return (
    `[meridian] Claude Code compacted this conversation's context ${how}: ${sizeChange(compaction)}. ` +
    "The model now sees the earlier turns as a summary.\n\n"
  )
}
