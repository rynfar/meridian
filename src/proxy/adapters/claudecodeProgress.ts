// NOTE: Claude Code-specific. A subagent periodically asks for a short caption
// of its latest action by appending this instruction to the end of the last
// user message (#1288): as the final text block after tool results or other
// text, or as a user message of its own after an assistant reply. The strings
// below are the client's prompt, byte for byte; only the quoted previous
// caption between them varies.
const PROGRESS_PREFIX = "Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.\n\n"
const PROGRESS_EXAMPLES = `Good: "Reading runAgent.ts"
Good: "Fixing null check in validate.ts"
Good: "Running auth module tests"
Good: "Adding retry logic to fetchUser"

Bad (past tense): "Analyzed the branch diff"
Bad (too vague): "Investigating the issue"
Bad (too long): "Reviewing full branch diff and AgentTool.tsx integration"
Bad (branch name): "Analyzed adam/background-summary branch diff"`

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * True only for the exact caption request: a streaming request with tools
 * whose last message is a user message ending in the caption instruction —
 * the whole string content, or the final text block. Native 2.1.292 can append
 * one exact system task-budget frame after it. Only an identified native CLI
 * request may skip that frame; arbitrary system text remains a real suffix.
 * Earlier blocks are the working turn's content and are not inspected, except that tool results must
 * carry distinct ids. The caption text quoted inside a longer text, followed
 * by more text, or returned inside a tool result does not match.
 */
export function isClaudeCodeProgressSummary(body: unknown, fromCli = false): boolean {
  const request = record(body)
  if (request?.stream !== true || !Array.isArray(request.tools) || request.tools.length === 0) return false
  if (!Array.isArray(request.messages)) return false
  let last = record(request.messages.at(-1))
  // NOTE: native Claude Code 2.1.292, observed through the real SDK/CLI in the
  // caption gate. This is transport budget metadata, not another user turn.
  // Skip exactly one string frame; repeats, text arrays and malformed budgets
  // do not establish caption authority. The final assertion anchors all bytes.
  if (fromCli && last?.role === "system" && typeof last.content === "string"
    && /^<total_tokens>(?:0|[1-9][0-9]{0,8}) tokens left<\/total_tokens>(?![\s\S])/.test(last.content)) {
    last = record(request.messages.at(-2))
  }
  if (last?.role !== "user") return false
  if (typeof last.content === "string") return isProgressPrompt(last.content)
  if (!Array.isArray(last.content)) return false

  const caption = record(last.content.at(-1))
  if (caption?.type !== "text" || typeof caption.text !== "string" || !isProgressPrompt(caption.text)) return false

  const ids = new Set<string>()
  return last.content.slice(0, -1).every(value => {
    const block = record(value)
    if (typeof block?.type !== "string") return false
    if (block.type !== "tool_result") return true
    if (typeof block.tool_use_id !== "string" || !block.tool_use_id || ids.has(block.tool_use_id)) return false
    ids.add(block.tool_use_id)
    return true
  })
}

function isProgressPrompt(text: string): boolean {
  if (!text.startsWith(PROGRESS_PREFIX) || !text.endsWith(PROGRESS_EXAMPLES)) return false
  const previous = text.slice(PROGRESS_PREFIX.length, text.length - PROGRESS_EXAMPLES.length)
  return previous === "" || /^Previous: "[^\r\n]*" — say something NEW\.\n\n$/.test(previous)
}
