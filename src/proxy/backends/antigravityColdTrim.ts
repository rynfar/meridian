import {
  AntigravityError,
  blocks,
  renderAgPrompt,
  renderAgPromptWithinLimit,
  type AgRequest,
} from "./antigravityProtocol"

type PromptBudget = { bytes: number; tokens: number; estimateTokens: (prompt: string) => number }

/** A boundary is safe only after every tool in the current batch was answered. */
function agColdTrimBoundaries(messages: AgRequest["messages"]): number[] {
  const pending = new Set<string>(), boundaries = [0]
  for (let i = 0; i < messages.length; i++) {
    for (const block of blocks(messages[i]!)) {
      if (block.type === "tool_use") pending.add(block.id)
      if (block.type === "tool_result") pending.delete(block.tool_use_id)
    }
    if (!pending.size) boundaries.push(i + 1)
  }
  return boundaries
}

/** Only called for fresh replay; warm continuations supply their delta directly. */
export function renderAgColdTrim(
  request: AgRequest,
  native: string[],
  suffix: string,
  budget: PromptBudget,
): string {
  const fits = (prompt: string) =>
    (!budget.bytes || Buffer.byteLength(prompt) <= budget.bytes) &&
    budget.estimateTokens(prompt) <= budget.tokens
  const full = renderAgPrompt(request, native) + suffix
  if (fits(full)) return full
  const boundaries = agColdTrimBoundaries(request.messages)
  const current = request.messages.findLastIndex(message =>
    message.role === "user" && blocks(message).some(block => block.type === "text" && block.text.trim()),
  )
  const currentUnit = boundaries.findLastIndex(at => at <= current)
  const anchor = currentUnit < 0 ? [] : request.messages.slice(boundaries[currentUnit], boundaries[currentUnit + 1])
  // Keep the final complete unit, including a final tool-result-only batch.
  if (boundaries.at(-1) === request.messages.length) boundaries.pop()
  const prefix = "Older completed turns may have been omitted to fit the input budget.\n\n"
  const compact = (history: AgRequest, head = "") => {
    let bytes = budget.bytes || Buffer.byteLength(renderAgPrompt(history, native) + suffix) + Buffer.byteLength(head)
    for (let attempts = 0; attempts < 8; attempts++) {
      const allowed = bytes - Buffer.byteLength(head)
      if (allowed < 1) return
      let prompt: string
      try {
        prompt = head + renderAgPromptWithinLimit(history, native, suffix, allowed)
      } catch (error) {
        if (error instanceof AntigravityError && error.message.startsWith("prompt is too long:")) return
        throw error
      }
      if (fits(prompt)) return prompt
      bytes = Math.min(bytes - 1, Math.floor(Buffer.byteLength(prompt) * budget.tokens / budget.estimateTokens(prompt)))
    }
  }
  const whole = compact(request)
  if (whole) return whole
  const at = (start: number) => ({
    ...request,
    messages: start > current && anchor.length ? [...anchor, ...request.messages.slice(start)] : request.messages.slice(start),
  })
  const render = (start: number) => prefix + renderAgPrompt(at(start), native) + suffix
  // Within a replay with omissions, suffix sizes decrease at each safe boundary.
  let lo = 1, hi = boundaries.length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (fits(render(boundaries[mid]!))) hi = mid
    else lo = mid + 1
  }
  if (lo < boundaries.length) return render(boundaries[lo]!)

  // Large newest tool payloads can still be shortened via the existing renderer.
  const start = boundaries.at(-1)!
  const prompt = start ? compact(at(start), prefix) : undefined
  if (prompt) return prompt
  throw new AntigravityError("prompt is too long: newest complete turn exceeds the estimated input token budget")
}
