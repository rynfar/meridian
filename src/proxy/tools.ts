/**
 * Shared tool blocking lists.
 *
 * These lists are used by multiple adapters (OpenCode, Droid, Crush) to block
 * SDK built-in tools so Claude uses the agent's MCP equivalents instead.
 */

/**
 * Block SDK built-in tools so Claude only uses MCP tools
 * (which have correct param names for the calling agent).
 */
export const BLOCKED_BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit",
  "Bash", "Glob", "Grep", "NotebookEdit",
  "WebFetch", "WebSearch", "TodoWrite"
]

/**
 * Claude Code SDK tools that have NO equivalent in the calling agent.
 * Block these so Claude doesn't try to use tools the agent can't handle.
 */
export const CLAUDE_CODE_ONLY_TOOLS = [
  "ToolSearch",        // Claude Code deferred tool loading (internal mechanism)
  "CronCreate",        // Claude Code cron jobs
  "CronDelete",        // Claude Code cron jobs
  "CronList",          // Claude Code cron jobs
  "EnterPlanMode",     // Claude Code mode switching
  "ExitPlanMode",      // Claude Code mode switching
  "EnterWorktree",     // Claude Code git worktree management
  "ExitWorktree",      // Claude Code git worktree management
  "NotebookEdit",      // Jupyter notebook editing
  // Schema-incompatible: SDK tool name differs from the agent's.
  "TodoWrite",         // OpenCode: todowrite (requires 'priority' field)
  "AskUserQuestion",   // OpenCode: question
  "Skill",             // OpenCode: skill / skill_mcp / slashcommand
  "Agent",             // OpenCode: delegate_task / task
  "TaskOutput",        // OpenCode: background_output
  "TaskStop",          // OpenCode: background_cancel
  "WebSearch",         // OpenCode: websearch_web_search_exa
]
