/**
 * Cherry Studio adapter.
 *
 * Cherry Studio (https://github.com/CherryHQ/cherry-studio) is a desktop chat
 * client — not a coding agent. Pointed at Meridian it works for plain chat,
 * but its web search failed (#481): the model reported it had "no WebSearch or
 * WebFetch tool exposed". That's because Meridian blocks the SDK's built-in
 * WebSearch/WebFetch globally — those are blocked for coding agents like
 * OpenCode, which ship their own web-search equivalents (`websearch_web_search_exa`).
 *
 * Unlike a coding agent, Cherry Studio does NOT execute tools itself; it relies
 * on Claude's own built-in web search. So this adapter:
 *   - unblocks the SDK's built-in WebSearch/WebFetch (verified to work on the
 *     Max/OAuth path — the SDK runs the search server-side and returns grounded
 *     results), and
 *   - runs in internal (non-passthrough) mode so the SDK actually executes the
 *     search instead of trying to hand it back to a client that can't run it.
 *
 * It exposes only the web tools — no filesystem MCP tools — since a chat client
 * has no business reading or writing files on the proxy host.
 *
 * Detection: selected via `x-meridian-agent: cherry` (or `cherrystudio`) or the
 * `MERIDIAN_DEFAULT_AGENT=cherry` env var. Cherry Studio doesn't send a
 * Meridian-specific header, so a user running a dedicated Meridian for it should
 * set the env default. (If a distinctive User-Agent is confirmed, add UA
 * detection in detect.ts.)
 *
 * NOTE: agent-specific. See ARCHITECTURE.md "Agent-Specific Logic".
 */

import type { AgentAdapter } from "../adapter"
import { openCodeAdapter } from "./opencode"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

/** The SDK built-in web tools Cherry Studio wants Claude to run itself. */
export const CHERRY_WEB_TOOLS = ["WebSearch", "WebFetch"] as const

const isWebTool = (t: string): boolean => (CHERRY_WEB_TOOLS as readonly string[]).includes(t)

/** Built-ins blocked for Cherry — everything OpenCode blocks EXCEPT the web tools. */
export const CHERRY_BLOCKED_BUILTIN_TOOLS = BLOCKED_BUILTIN_TOOLS.filter(t => !isWebTool(t))

/** Incompatible tools for Cherry — CLAUDE_CODE_ONLY_TOOLS minus the web tools. */
export const CHERRY_INCOMPATIBLE_TOOLS = CLAUDE_CODE_ONLY_TOOLS.filter(t => !isWebTool(t))

export const cherryAdapter: AgentAdapter = {
  // Identity (session tracking, cwd, content normalization) is identical to a
  // generic Anthropic-API client, so reuse OpenCode's.
  ...openCodeAdapter,
  name: "cherry",

  usesPassthrough(): boolean {
    return false
  },

  // Cherry Studio has no renderer for the SDK's signed thinking blocks; strip
  // them (see the hidesInternalTools handling in server.ts).
  supportsThinking(): boolean {
    return false
  },

  getBlockedBuiltinTools(): readonly string[] {
    return CHERRY_BLOCKED_BUILTIN_TOOLS
  },

  getAgentIncompatibleTools(): readonly string[] {
    return CHERRY_INCOMPATIBLE_TOOLS
  },

  getAllowedMcpTools(): readonly string[] {
    return [...CHERRY_WEB_TOOLS]
  },

  // A chat client has no filesystem tools; override OpenCode's core list so
  // auto-defer doesn't try to always-load read/write/edit/etc.
  getCoreToolNames(): readonly string[] {
    return []
  },
}
