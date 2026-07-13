/**
 * Tool blocking lists and MCP tool configuration.
 *
 * NOTE: These lists are currently OpenCode-specific. When the adapter pattern
 * is implemented, these will move into the OpenCode adapter and become
 * configurable per-agent. See DEFERRED.md.
 */

/**
 * Block SDK built-in tools so Claude only uses MCP tools
 * (which have correct param names for the calling agent).
 */
export const BLOCKED_BUILTIN_TOOLS = [
  "Read", "Write", "Edit",
  "Bash", "Glob", "Grep", "NotebookEdit",
  "WebFetch", "WebSearch", "TodoWrite"
]

/**
 * Claude Code SDK tools that have NO equivalent in the calling agent (OpenCode).
 * Only block these — everything else either has an agent equivalent
 * or is handled by the agent's own tool system.
 *
 * Tools where the agent has an equivalent but with a DIFFERENT name/schema
 * are blocked so Claude uses the agent's version instead of the SDK's.
 */
export const CLAUDE_CODE_ONLY_TOOLS = [
  "CronCreate",        // Claude Code cron jobs
  "CronDelete",        // Claude Code cron jobs
  "CronList",          // Claude Code cron jobs
  "EnterPlanMode",     // Claude Code mode switching (OpenCode uses plan agent instead)
  "ExitPlanMode",      // Claude Code mode switching
  "EnterWorktree",     // Claude Code git worktree management
  "ExitWorktree",      // Claude Code git worktree management
  "Monitor",           // Claude Code background-process monitoring
  "NotebookEdit",      // Jupyter notebook editing
  "PushNotification",  // Claude Code push-notification delivery
  "RemoteTrigger",     // Claude Code remote-trigger plumbing
  "ScheduleWakeup",    // Claude Code self-paced loop scheduling
  // Schema-incompatible: SDK tool name differs from OpenCode's.
  // If Claude calls the SDK version, OpenCode won't recognize it.
  // Block the SDK's so Claude only sees OpenCode's definitions.
  "TodoWrite",         // OpenCode: todowrite (requires 'priority' field)
  "AskUserQuestion",   // OpenCode: question
  "Skill",             // OpenCode: skill / skill_mcp / slashcommand
  "Agent",             // OpenCode: delegate_task / task
  "TaskOutput",        // OpenCode: background_output
  "TaskStop",          // OpenCode: background_cancel
  "WebSearch",         // OpenCode: websearch_web_search_exa
]

/**
 * Native Anthropic *server* tools carry a dated `type` marker (e.g.
 * `web_search_20250305`, `web_fetch_20260209`). Unlike custom/passthrough
 * tools — which have a `name` + `input_schema` and are executed by the client
 * — these run on Anthropic's servers and emit `server_tool_use` /
 * `web_search_tool_result` blocks. Meridian bridges to Claude Max via the
 * Agent SDK, which has no such server tools and cannot produce those blocks,
 * so a request carrying one can never succeed through the proxy. Match the
 * web_search/web_fetch families (any date suffix) so we catch future variants.
 * See #488 (opencode-websearch plugin) and #481 (Cherry Studio).
 */
const SERVER_TOOL_TYPE = /^web_(search|fetch)_\d+$/

/**
 * Return the distinct native-server-tool `type`s present in a request's `tools`
 * array, in first-seen order. Empty when there are none (the common case) or
 * when `tools` isn't an array. Pure — no I/O.
 */
export function detectServerTools(tools: unknown): string[] {
  if (!Array.isArray(tools)) return []
  const found: string[] = []
  for (const tool of tools) {
    const type = (tool as { type?: unknown })?.type
    if (typeof type === "string" && SERVER_TOOL_TYPE.test(type) && !found.includes(type)) {
      found.push(type)
    }
  }
  return found
}

/**
 * Build the actionable error returned when a request carries native server
 * tools. It tells the user to route that specific call at the real Anthropic
 * API (with their own key) rather than through Meridian — the plugin already
 * supports a separate per-provider baseURL, so this is a config fix on their
 * side, not something Meridian can execute on the Max subscription.
 */
export function serverToolErrorMessage(types: string[]): string {
  const list = types.join(", ")
  return (
    `Anthropic server tools (${list}) can't run through Meridian. ` +
    `Server-side web search/fetch is a raw Anthropic API feature (billed to an API key) ` +
    `that produces server_tool_use / web_search_tool_result blocks the Claude Max / Agent SDK path cannot emit. ` +
    `Point the plugin making this call at the real API instead — configure it with a separate provider using ` +
    `baseURL "https://api.anthropic.com" and your own ANTHROPIC_API_KEY, rather than routing it through Meridian.`
  )
}

/** MCP server name used by the calling agent */
export const MCP_SERVER_NAME = "opencode"

/** MCP tools that are allowed through the proxy's tool filter */
export const ALLOWED_MCP_TOOLS = [
  `mcp__${MCP_SERVER_NAME}__read`,
  `mcp__${MCP_SERVER_NAME}__write`,
  `mcp__${MCP_SERVER_NAME}__edit`,
  `mcp__${MCP_SERVER_NAME}__bash`,
  `mcp__${MCP_SERVER_NAME}__glob`,
  `mcp__${MCP_SERVER_NAME}__grep`
]
