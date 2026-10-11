/** Parse E41 responses and replay the client's exact assistant content. */
export interface AssistantBlock {
  type: string
  [key: string]: unknown
}

interface AssistantResponse {
  blocks: AssistantBlock[]
  usage: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isBlock(value: unknown): value is AssistantBlock {
  return isRecord(value) && typeof value.type === "string"
}

/** Both response shapes retain opaque thinking signatures and redacted data. */
export function parseAssistantResponse(text: string, stream: boolean): AssistantResponse {
  if (!stream) {
    const body: unknown = JSON.parse(text)
    return {
      blocks: isRecord(body) && Array.isArray(body.content) ? body.content.filter(isBlock) : [],
      usage: isRecord(body) && isRecord(body.usage) ? body.usage : {},
    }
  }

  const blocks: Array<(AssistantBlock & { _json?: string }) | undefined> = []
  let usage: Record<string, unknown> = {}
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    let event: unknown
    try { event = JSON.parse(line.slice(5)) } catch { continue }
    if (!isRecord(event)) continue
    if (event.type === "message_start" && isRecord(event.message) && isRecord(event.message.usage)) {
      usage = { ...usage, ...event.message.usage }
    }
    if (event.type === "message_delta" && isRecord(event.usage)) usage = { ...usage, ...event.usage }
    if (!Number.isInteger(event.index) || typeof event.index !== "number" || event.index < 0) continue
    if (event.type === "content_block_start" && isBlock(event.content_block)) {
      blocks[event.index] = {
        ...event.content_block,
        ...(event.content_block.type === "tool_use" ? { _json: "" } : {}),
      }
    }
    if (event.type !== "content_block_delta" || !isRecord(event.delta)) continue
    const block = blocks[event.index]
    if (!block) continue
    const delta = event.delta
    if (block.type === "text" && delta.type === "text_delta" && typeof delta.text === "string") {
      block.text = (typeof block.text === "string" ? block.text : "") + delta.text
    }
    if (block.type === "thinking" && delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      block.thinking = (typeof block.thinking === "string" ? block.thinking : "") + delta.thinking
    }
    if (block.type === "thinking" && delta.type === "signature_delta" && typeof delta.signature === "string") {
      block.signature = (typeof block.signature === "string" ? block.signature : "") + delta.signature
    }
    if (block.type === "tool_use" && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      block._json = (block._json ?? "") + delta.partial_json
    }
  }
  return {
    usage,
    blocks: blocks.filter(isBlock).map(block => {
      if (block.type !== "tool_use") return block
      const { _json, ...rest } = block
      return { ...rest, input: typeof _json === "string" && _json ? JSON.parse(_json) : (block.input ?? {}) }
    }),
  }
}

/** Keep every received field intact; signatures are opaque, never reconstructed. */
export function replayAssistantBlocks(blocks: AssistantBlock[]): AssistantBlock[] {
  return structuredClone(blocks)
}
