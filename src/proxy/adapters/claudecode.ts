/**
 * Claude Code agent adapter.
 *
 * Claude Code (claude-cli) is unusual among meridian clients in two ways:
 *   1. It typically runs on a different machine than the proxy (pointing at
 *      ANTHROPIC_BASE_URL over the network), so its CWD doesn't exist on the
 *      proxy host.
 *   2. Its system prompt embeds working-directory info using the
 *      `Primary working directory: <path>` format inside a `# Environment`
 *      block — different from OpenCode's `<env>Working directory: <path></env>`.
 *
 * Consequently this adapter:
 *   - Returns `undefined` from extractWorkingDirectory so the SDK subprocess
 *     chdirs into `process.cwd()` (a valid server path) rather than the
 *     client's local filesystem layout.
 *   - Parses the client's local CWD via extractClientWorkingDirectory for
 *     fingerprinting and a system-prompt hint (see server.ts + query.ts).
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { type FileChange, extractFileChangesFromBash } from "../fileChanges"
import { normalizeContent } from "../messages"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME, ALLOWED_MCP_TOOLS } from "../tools"

/**
 * Extract Claude Code's client-local working directory from the request's
 * system prompt. Claude Code injects a block like:
 *
 *   # Environment
 *   You have been invoked in the following environment:
 *    - Primary working directory: /Users/alice/projects/myapp
 *    - ...
 *
 * Returns the path if found, or undefined to fall back to the SDK CWD.
 */
function extractClaudeCodeClientCwd(body: any): string | undefined {
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

  const match = systemText.match(/Primary working directory:\s*([^\n<]+)/i)
  return match?.[1]?.trim() || undefined
}

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",

  /**
   * Claude Code doesn't send a session-affinity header, so fall through to
   * fingerprint-based resume (first-user-message + clientCwd).
   */
  getSessionId(_c: Context): string | undefined {
    return undefined
  },

  /**
   * Claude Code is remote relative to the proxy. Do not use its local path
   * as the SDK subprocess cwd — return undefined so the resolver falls back
   * to MERIDIAN_WORKDIR / process.cwd() (a valid path on the proxy host).
   */
  extractWorkingDirectory(_body: any): string | undefined {
    return undefined
  },

  /**
   * Used for fingerprint bucketing and the system-prompt CWD hint.
   */
  extractClientWorkingDirectory(body: any): string | undefined {
    return extractClaudeCodeClientCwd(body)
  },

  normalizeContent(content: any): string {
    return normalizeContent(content)
  },

  getBlockedBuiltinTools(): readonly string[] {
    return BLOCKED_BUILTIN_TOOLS
  },

  getAgentIncompatibleTools(): readonly string[] {
    return CLAUDE_CODE_ONLY_TOOLS
  },

  getMcpServerName(): string {
    return MCP_SERVER_NAME
  },

  getAllowedMcpTools(): readonly string[] {
    return ALLOWED_MCP_TOOLS
  },

  getCoreToolNames(): readonly string[] {
    // Claude Code ships a Read/Write/Bash/etc. toolkit much like OpenCode.
    return ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
  },

  usesPassthrough(): boolean {
    // Claude Code owns its own tool execution client-side; default to
    // passthrough so tool_use blocks flow back to the CLI.
    const envVal = process.env.MERIDIAN_PASSTHROUGH ?? process.env.CLAUDE_PROXY_PASSTHROUGH
    if (envVal === "0" || envVal === "false" || envVal === "no") {
      return false
    }
    return true
  },

  supportsThinking(): boolean {
    return true
  },

  /**
   * Claude Code surfaces its own file edits in its UI; suppress meridian's
   * synthetic "Files changed:" block to avoid duplication.
   */
  shouldTrackFileChanges(): boolean {
    return false
  },

  /**
   * Map Claude Code tool_use blocks to file changes. Claude Code uses
   * PascalCase tool names (Read, Write, Edit, Bash) with file_path input.
   */
  extractFileChangesFromToolUse(toolName: string, toolInput: unknown): FileChange[] {
    const input = toolInput as Record<string, unknown> | null | undefined
    const filePath = input?.file_path ?? input?.filePath ?? input?.path

    const lowerName = toolName.toLowerCase()
    if (lowerName === "write" && filePath) {
      return [{ operation: "wrote", path: String(filePath) }]
    }
    if ((lowerName === "edit" || lowerName === "multiedit") && filePath) {
      return [{ operation: "edited", path: String(filePath) }]
    }
    if (lowerName === "bash" && input?.command) {
      return extractFileChangesFromBash(String(input.command))
    }
    return []
  },
}
