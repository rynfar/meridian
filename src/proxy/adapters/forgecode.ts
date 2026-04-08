/**
 * ForgeCode agent adapter.
 *
 * Provides ForgeCode-specific behavior for session tracking, working directory
 * extraction, content normalization, and tool configuration.
 *
 * ForgeCode (forgecode.dev) is a Rust-based terminal coding agent by Antinomy
 * that makes standard Anthropic Messages API calls. When using a custom provider
 * URL (pointing at Meridian), ForgeCode operates in passthrough mode with its
 * own tool execution loop.
 *
 * Key characteristics:
 * - User-Agent: reqwest default (no distinctive prefix) — use x-meridian-agent or env var
 * - No session header: relies on fingerprint-based session cache
 * - CWD in system prompt: <current_working_directory>/path</current_working_directory>
 * - Snake_case tools: read, write, patch, multi_patch, shell, fs_search, etc.
 * - Always streams (stream: true by default)
 * - Manages its own tool execution loop: passthrough mode is appropriate
 * - Subagent routing handled client-side via Task tool — invisible to proxy
 *
 * Detection: ForgeCode uses reqwest's default User-Agent, so automatic detection
 * is unreliable. Use one of:
 * - x-meridian-agent: forgecode header (per-request)
 * - MERIDIAN_DEFAULT_AGENT=forgecode env var (global default)
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { type FileChange, extractFileChangesFromBash } from "../fileChanges"
import { normalizeContent } from "../messages"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

const FORGECODE_MCP_SERVER_NAME = "forgecode"

const FORGECODE_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${FORGECODE_MCP_SERVER_NAME}__read`,
  `mcp__${FORGECODE_MCP_SERVER_NAME}__write`,
  `mcp__${FORGECODE_MCP_SERVER_NAME}__edit`,
  `mcp__${FORGECODE_MCP_SERVER_NAME}__bash`,
  `mcp__${FORGECODE_MCP_SERVER_NAME}__glob`,
  `mcp__${FORGECODE_MCP_SERVER_NAME}__grep`,
]

/**
 * Extract the client's working directory from ForgeCode's system prompt.
 *
 * ForgeCode embeds CWD in an XML tag within the system prompt:
 *   <current_working_directory>/path/to/project</current_working_directory>
 *
 * This differs from OpenCode's <env> block and Pi's plain-text format.
 */
function extractForgeCodeCwd(body: any): string | undefined {
  let systemText = ""
  if (typeof body.system === "string") {
    systemText = body.system
  } else if (Array.isArray(body.system)) {
    systemText = body.system
      .filter((b: any) => b.type === "text" && b.text)
      .map((b: any) => b.text)
      .join("\n")
  }
  if (!systemText) return undefined

  const match = systemText.match(/<current_working_directory>\s*([^<]+?)\s*<\/current_working_directory>/i)
  return match?.[1]?.trim() || undefined
}

export const forgeCodeAdapter: AgentAdapter = {
  name: "forgecode",

  /**
   * ForgeCode sends no session header.
   * Session continuity is maintained via fingerprint-based cache lookup.
   */
  getSessionId(_c: Context): string | undefined {
    return undefined
  },

  extractWorkingDirectory(body: any): string | undefined {
    return extractForgeCodeCwd(body)
  },

  normalizeContent(content: any): string {
    return normalizeContent(content)
  },

  /**
   * ForgeCode uses snake_case tool names (read, write, patch, shell) which
   * don't conflict with SDK built-in PascalCase names (Read, Write, Edit, Bash).
   * Block the SDK built-ins regardless to prevent ambiguity.
   */
  getBlockedBuiltinTools(): readonly string[] {
    return BLOCKED_BUILTIN_TOOLS
  },

  /**
   * ForgeCode doesn't have equivalents for Claude Code SDK-only tools
   * (cron jobs, mode switching, worktree management, etc.).
   */
  getAgentIncompatibleTools(): readonly string[] {
    return CLAUDE_CODE_ONLY_TOOLS
  },

  getMcpServerName(): string {
    return FORGECODE_MCP_SERVER_NAME
  },

  getAllowedMcpTools(): readonly string[] {
    return FORGECODE_ALLOWED_MCP_TOOLS
  },

  /**
   * ForgeCode manages its own subagents via its Task tool client-side.
   * No SDK agent definitions needed.
   */
  buildSdkAgents(_body: any, _mcpToolNames: readonly string[]): Record<string, any> {
    return {}
  },

  /**
   * No PreToolUse hooks needed — ForgeCode handles its own tool execution.
   */
  buildSdkHooks(_body: any, _sdkAgents: Record<string, any>): undefined {
    return undefined
  },

  /**
   * No additional system context needed for ForgeCode.
   */
  buildSystemContextAddendum(_body: any, _sdkAgents: Record<string, any>): string {
    return ""
  },

  /**
   * ForgeCode handles its own tool execution loop (standard Anthropic tool_use /
   * tool_result cycle). Passthrough mode is appropriate.
   * Defer to MERIDIAN_PASSTHROUGH / CLAUDE_PROXY_PASSTHROUGH env var.
   */
  // usesPassthrough not defined — defers to env var

  /**
   * ForgeCode uses snake_case tool names: write, patch, multi_patch, shell.
   * Input path field is file_path (snake_case) for write/patch.
   * Shell commands are parsed for output redirects.
   */
  extractFileChangesFromToolUse(toolName: string, toolInput: unknown): FileChange[] {
    const input = toolInput as Record<string, unknown> | null | undefined
    const filePath = input?.file_path ?? input?.filePath ?? input?.path

    if (toolName === "write" && filePath) {
      return [{ operation: "wrote", path: String(filePath) }]
    }
    if ((toolName === "patch" || toolName === "multi_patch") && filePath) {
      return [{ operation: "edited", path: String(filePath) }]
    }
    if (toolName === "shell" && input?.command) {
      return extractFileChangesFromBash(String(input.command))
    }
    return []
  },
}
