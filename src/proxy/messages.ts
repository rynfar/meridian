/**
 * Message parsing and normalization utilities.
 */

/**
 * Strip cache_control from a content block (or nested blocks).
 * cache_control is ephemeral metadata that agents add/remove between requests;
 * it must not affect content hashing or lineage verification.
 */
function stripCacheControlForHashing(obj: any): any {
  if (!obj || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(stripCacheControlForHashing)
  const { cache_control, ...rest } = obj
  return rest
}

/**
 * Normalize message content to a string for hashing and comparison.
 * Handles both string content and array content (Anthropic content blocks).
 * Strips cache_control metadata to ensure hash stability across requests.
 *
 * NOTE: OpenCode sends content as a string on the first request but as
 * an array on subsequent ones. This normalizer handles both formats.
 * Other agents may behave differently — this will move to the adapter pattern.
 */
export function normalizeContent(content: any): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((block: any) => {
      if (block.type === "text" && block.text) return block.text
      if (block.type === "tool_use") return `tool_use:${block.id}:${block.name}:${JSON.stringify(block.input)}`
      if (block.type === "tool_result") {
        const inner = block.content
        if (typeof inner === "string") return `tool_result:${block.tool_use_id}:${inner}`
        // Strip cache_control from nested content blocks before serializing
        return `tool_result:${block.tool_use_id}:${JSON.stringify(stripCacheControlForHashing(inner))}`
      }
      // Unknown block types: strip cache_control before serializing
      return JSON.stringify(stripCacheControlForHashing(block))
    }).join("\n")
  }
  return String(content)
}

/**
 * Extract the advisor model from a tools array.
 * Returns the model string if an advisor tool definition is found, undefined otherwise.
 * The advisor tool is identified by a type starting with "advisor_".
 */
export function extractAdvisorModel(tools: unknown): string | undefined {
  if (!Array.isArray(tools)) return undefined
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue
    const candidate = tool as Record<string, unknown>
    if (typeof candidate.type === "string" && candidate.type.startsWith("advisor_") && typeof candidate.model === "string" && candidate.model.length > 0) {
      return candidate.model
    }
  }
  return undefined
}

/**
 * Remove advisor tool definitions from a tools array.
 * Returns a new array with advisor tools filtered out.
 */
export function stripAdvisorTools(tools: unknown[]): unknown[] {
  return tools.filter((tool) => {
    if (!tool || typeof tool !== "object") return true
    const candidate = tool as Record<string, unknown>
    return !(typeof candidate.type === "string" && candidate.type.startsWith("advisor_"))
  })
}

/**
 * Extract only the last user message (for session resume — SDK already has history).
 */
export function getLastUserMessage(messages: Array<{ role: string; content: any }>): Array<{ role: string; content: any }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return [messages[i]!]
  }
  return messages.slice(-1)
}

/**
 * Remove fields the Claude Agent SDK attaches to streamed events that are not
 * part of the public Anthropic streaming schema.
 *
 * The SDK adds `context_management` (advisory metadata about upstream context
 * edits) to `message_delta`. The real Anthropic API does not return it on a
 * normal (non-beta) request, and stock clients — e.g. langchain-anthropic —
 * assume any present field is a typed SDK model and call `.model_dump()` on it,
 * crashing on the raw dict (#525). The context edit already happened upstream,
 * so the field is safe to drop.
 *
 * Mutates and returns the event for convenient inline use in the SSE forward
 * path; a no-op when the field is absent, so it is safe to call on every event.
 */
export function stripNonStandardStreamFields<T>(event: T): T {
  if (event && typeof event === "object") {
    const e = event as Record<string, unknown>
    delete e.context_management
    const delta = e.delta
    if (delta && typeof delta === "object") {
      delete (delta as Record<string, unknown>).context_management
    }
  }
  return event
}
