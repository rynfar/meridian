/**
 * Shared passthrough deny reason strings.
 *
 * In passthrough mode the PreToolUse hook denies every client tool call with
 * one of these reasons. The SDK records a synthetic `user` message whose
 * `tool_result` content is the deny string. When the client sends back the
 * real tool_result, the lineage verifier must recognise the placeholder and
 * classify the divergence as a passthrough settlement rather than a
 * modified-history rewrite.
 *
 * Single source of truth: both server.ts (the hook) and lineage.ts (the
 * verifier) reference these strings through this module. Never copy them.
 */

/** A forwarded tool call that was NOT a duplicate or forced-single overflow. */
export const FORWARDED_TOOL_DENY =
  "This tool call has been forwarded to the client for execution. " +
  "The result will be delivered in a future turn. " +
  "Do not retry, do not call additional tools, and do not generate further text — end your turn now."

/** An exact-duplicate or post-checkpoint tool call the model must not repeat. */
export const EXACT_DUPLICATE_DENY =
  "This tool call has already been handled by the client-facing turn — do not repeat it. " +
  "Do not call additional tools and do not generate further text — end your turn now."

/** A same-tool-repeat or forced-single overflow that was NOT forwarded. */
export const SAME_TOOL_REPEAT_DENY =
  "This tool call was NOT executed and was not forwarded. Your earlier tool call(s) " +
  "are being returned to the client now; their results arrive next turn. Re-issue this " +
  "call after that if it is still needed. Do not call additional tools and do not " +
  "generate further text — end your turn now."

/** All deny reason strings, for matching against tool_result content. */
export const ALL_DENY_REASONS = [
  FORWARDED_TOOL_DENY,
  EXACT_DUPLICATE_DENY,
  SAME_TOOL_REPEAT_DENY,
] as const

/**
 * True when a tool_result block's content (string form) is one of the
 * passthrough deny placeholder strings. Used by lineage verification to
 * detect that a stored user message is a synthetic denial rather than a
 * genuine tool result.
 *
 * Only matches exact deny strings — never matches arbitrary tool_result
 * payloads.
 */
export function isPassthroughDenyToolResult(content: unknown): boolean {
  if (typeof content !== "string") return false
  return ALL_DENY_REASONS.includes(content as typeof ALL_DENY_REASONS[number])
}