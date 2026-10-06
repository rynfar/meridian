// NOTE: Claude Code-specific progress-caption wire shape (#1288).
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

/** Match only the client caption appended after tool results, never quoted history. */
export function isClaudeCodeProgressSummary(body: unknown): boolean {
  const request = record(body)
  if (request?.stream !== true || !Array.isArray(request.tools) || request.tools.length === 0) return false
  if (!Array.isArray(request.messages)) return false
  const last = record(request.messages.at(-1))
  if (last?.role !== "user" || !Array.isArray(last.content) || last.content.length < 2) return false

  const caption = record(last.content.at(-1))
  if (caption?.type !== "text" || typeof caption.text !== "string") return false
  const text = caption.text
  if (!text.startsWith(PROGRESS_PREFIX) || !text.endsWith(PROGRESS_EXAMPLES)) return false
  const previous = text.slice(PROGRESS_PREFIX.length, text.length - PROGRESS_EXAMPLES.length)
  if (previous !== "" && !/^Previous: "[^\r\n]*" — say something NEW\.\n\n$/.test(previous)) return false

  const ids = new Set<string>()
  return last.content.slice(0, -1).every(value => {
    const block = record(value)
    if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string" || !block.tool_use_id || ids.has(block.tool_use_id)) return false
    ids.add(block.tool_use_id)
    return true
  })
}
