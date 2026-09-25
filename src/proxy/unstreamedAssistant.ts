/** Content blocks for a complete SDK assistant turn with no stream events.
 * The server supplies the HTTP envelope and decides which blocks are visible. */
export interface AssistantSseFrame {
  event: "content_block_start" | "content_block_delta" | "content_block_stop"
  data: Record<string, unknown>
  textLength?: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function unstreamedAssistantBlockFrames(
  block: unknown,
  index: number,
  allowThinking: boolean,
): AssistantSseFrame[] {
  if (!record(block)) return []
  let start: Record<string, unknown>
  const deltas: Record<string, unknown>[] = []
  if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
    start = { type: "text", text: "" }
    deltas.push({ type: "text_delta", text: block.text })
  } else if (allowThinking && block.type === "thinking" && typeof block.thinking === "string") {
    start = { type: "thinking", thinking: "", signature: "" }
    if (block.thinking) deltas.push({ type: "thinking_delta", thinking: block.thinking })
    if (typeof block.signature === "string" && block.signature) {
      deltas.push({ type: "signature_delta", signature: block.signature })
    }
  } else if (allowThinking && block.type === "redacted_thinking" && typeof block.data === "string") {
    start = { type: "redacted_thinking", data: block.data }
  } else {
    return []
  }
  return [
    { event: "content_block_start", data: { type: "content_block_start", index, content_block: start } },
    ...deltas.map(delta => ({ event: "content_block_delta" as const,
      data: { type: "content_block_delta", index, delta },
      ...(delta.type === "text_delta" && typeof delta.text === "string" ? { textLength: delta.text.length } : {}),
    })),
    { event: "content_block_stop", data: { type: "content_block_stop", index } },
  ]
}
