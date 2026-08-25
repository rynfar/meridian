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
