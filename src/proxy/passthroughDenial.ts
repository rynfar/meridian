/**
 * Marker used when Meridian forwards a passthrough tool call to the client.
 *
 * Keep this module pure. Runtime hooks, diagnostics, and E2E assertions must
 * agree on the exact text, but none of them should know the Claude CLI's
 * private transcript storage format.
 */
export const PASSTHROUGH_DENY_REASON =
  "This tool call has been forwarded to the client for execution. " +
  "The result will be delivered in a future turn. " +
  "Do not retry, do not call additional tools, and do not generate further text — end your turn now."

/** Hook block for a call already answered by the client-facing turn, or raised
 * by the hidden digest after the checkpoint settled. */
export const PASSTHROUGH_HANDLED_REASON =
  "This tool call has already been handled by the client-facing turn — do not repeat it. " +
  "Do not call additional tools and do not generate further text — end your turn now."

/** Hook block for a same-tool repeat or a forced single tool beyond the first. */
export const PASSTHROUGH_NOT_FORWARDED_REASON =
  "This tool call was NOT executed and was not forwarded. Your earlier tool call(s) " +
  "are being returned to the client now; their results arrive next turn. Re-issue this " +
  "call after that if it is still needed. Do not call additional tools and do not " +
  "generate further text — end your turn now."

const HOOK_BLOCK_REASONS = [PASSTHROUGH_DENY_REASON, PASSTHROUGH_HANDLED_REASON, PASSTHROUGH_NOT_FORWARDED_REASON]

interface ContentTextBlock {
  text?: unknown
}

export interface ToolResultLike {
  type?: unknown
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
}

function blockText(block: ToolResultLike): string {
  if (typeof block.content === "string") return block.content
  if (!Array.isArray(block.content)) return ""
  return block.content
    .map((item: unknown) => {
      if (!item || typeof item !== "object") return ""
      const text = (item as ContentTextBlock).text
      return typeof text === "string" ? text : ""
    })
    .join("")
}

/** True only for the synthetic error result emitted by the forwarding hook. */
export function isForwardedDenial(block: ToolResultLike | undefined): boolean {
  return block?.type === "tool_result" &&
    block.is_error === true &&
    blockText(block).includes(PASSTHROUGH_DENY_REASON)
}

/** True for any synthetic error result Meridian's passthrough hook writes. None of
 * them is a client tool result; the client answers those calls in a later turn. */
export function isPassthroughHookBlock(block: ToolResultLike | undefined): boolean {
  if (block?.type !== "tool_result" || block.is_error !== true) return false
  const text = blockText(block)
  return HOOK_BLOCK_REASONS.some(reason => text.includes(reason))
}
