// A Claude Code subagent progress-caption request (#1288). PROGRESS_PROMPT is
// the client's instruction verbatim. The client appends it to the last user
// message: after its tool results and other text, or as a user message of its
// own after an assistant reply.
export const PROGRESS_PROMPT = `Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.

Previous: "Reading the parser in config.ts" — say something NEW.

Good: "Reading runAgent.ts"
Good: "Fixing null check in validate.ts"
Good: "Running auth module tests"
Good: "Adding retry logic to fetchUser"

Bad (past tense): "Analyzed the branch diff"
Bad (too vague): "Investigating the issue"
Bad (too long): "Reviewing full branch diff and AgentTool.tsx integration"
Bad (branch name): "Analyzed adam/background-summary branch diff"`

// The first caption of a subagent quotes no previous caption.
export const PROGRESS_FIRST_PROMPT = PROGRESS_PROMPT.replace(/Previous: .*\n\n/, "")

export const PROGRESS_WORK = [
  { role: "user", content: "Read alpha.txt" },
  { role: "assistant", content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "alpha.txt" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "ALPHA" }] },
]

export function progressBody(sessionId = "progress-session") {
  return {
    model: "claude-opus-4-6",
    max_tokens: 128,
    stream: true,
    tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } }],
    metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
    messages: [
      ...PROGRESS_WORK.slice(0, -1),
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "read-1", content: "ALPHA" },
        { type: "text", text: PROGRESS_PROMPT },
      ] },
    ],
  }
}
