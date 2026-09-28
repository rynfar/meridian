import { hasExtendedContext, type ClaudeModel } from "./models"

/** Approximate replay estimate: overestimates Cyrillic-like scripts, but can
 * underestimate CJK, base64, and multi-page documents. Reactive overflow
 * retries cover underestimates when more history can be dropped. */
export function estimateTokens(content: unknown): number {
  if (typeof content === "string") {
    let ascii = 0
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) < 128) ascii++
    return Math.ceil(ascii / 3.5 + (content.length - ascii) / 1.5)
  }
  if (!Array.isArray(content)) return estimateTokens(String(content))
  return content.reduce((sum, block) => {
    switch (block?.type) {
      case "text": return sum + estimateTokens(block.text)
      case "image": case "document": case "file": return sum + 1600
      case "tool_use": return sum + estimateTokens(block.name + JSON.stringify(block.input))
      case "tool_result": return sum + estimateTokens(block.content)
      case "thinking": case "redacted_thinking": return sum
      default: return sum + estimateTokens(JSON.stringify(block))
    }
  }, 0)
}

export function contextWindowFor(model: string): number {
  return hasExtendedContext(model as ClaudeModel) ? 1_000_000 : 200_000
}

// Leave space for system instructions, tool schemas, and the generated answer.
export const REPLAY_RESERVE_TOKENS = 64_000

/** The reserve is capped at a tenth of the window so it stays proportionate.
 *  A flat 64k is 6.4% of a 1M window but 32% of a 200k one, and stacked on the
 *  0.9 factor and an estimator that overestimates Latin text it put the 200k
 *  budget at 58% of the window: history was dropped from about 101k real
 *  English tokens, roughly half the window, for conversations that used to fit.
 *  Capping keeps the 1M budget byte-for-byte unchanged and lifts 200k models to
 *  the same ~80% share. Underestimates are still covered by the overflow retry. */
export function replayReserveFor(model: string): number {
  return Math.min(REPLAY_RESERVE_TOKENS, Math.floor(contextWindowFor(model) * 0.1))
}

export function replayBudgetFor(model: string): number {
  const configured = replayBudgetOverride()
  if (configured !== undefined) return configured
  return Math.floor(contextWindowFor(model) * 0.9) - replayReserveFor(model)
}

/** Test-only override. Proving the trim against a real model otherwise needs a
 *  six-figure-token conversation, which no gate can afford; with this the live
 *  gate drives the same code path from a handful of turns. */
function replayBudgetOverride(): number | undefined {
  const raw = process.env.MERIDIAN_REPLAY_BUDGET_TOKENS
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

function startsReplayGroup(message: { role: string; content: unknown }): boolean {
  return message.role === "user" && !(Array.isArray(message.content) && message.content.length > 0 &&
    message.content.every(block => block?.type === "tool_result"))
}

/** Keep the objective and a contiguous suffix; result-only turns belong to
 * the preceding user request, not a new independently droppable group. */
export function trimReplayHistory<T extends { role: string; content: unknown }>(
  messages: T[], budget: number,
): { messages: T[]; omittedMessages: number; omittedTokens: number } {
  const costs = messages.map(message => estimateTokens(message.content))
  const total = costs.reduce((sum, cost) => sum + cost, 0)
  if (total <= budget) return { messages, omittedMessages: 0, omittedTokens: 0 }
  const lastUser = messages.findLastIndex(startsReplayGroup)
  // No user boundary means there is no safe historical group to discard.
  const liveStart = Math.max(0, lastUser)
  let keptStart = liveStart
  let keptTokens = costs.slice(liveStart).reduce((sum, cost) => sum + cost, 0)
  const keepHead = liveStart > 0 && keptTokens + costs[0]! <= budget && costs[0]! <= budget * 0.1
  if (keepHead) keptTokens += costs[0]!
  const middleStart = keepHead ? 1 : 0
  let end = liveStart
  while (end > middleStart) {
    let start = end - 1
    while (start >= middleStart && !startsReplayGroup(messages[start]!)) start--
    if (start < middleStart) break
    const cost = costs.slice(start, end).reduce((sum, value) => sum + value, 0)
    if (keptTokens + cost > budget) break
    keptTokens += cost
    keptStart = start
    end = start
  }
  const omittedMessages = keptStart - (keepHead ? 1 : 0)
  const omittedTokens = total - keptTokens
  if (!omittedMessages) return { messages, omittedMessages: 0, omittedTokens: 0 }
  const marker = {
    role: "user",
    content: `[Meridian: ${omittedMessages} earlier messages (~${Math.round(omittedTokens)} tokens) were omitted from this replay to fit the model's context window.]`,
  } as T
  return {
    messages: [...(keepHead ? [messages[0]!] : []), marker, ...messages.slice(keptStart)],
    omittedMessages,
    omittedTokens,
  }
}
