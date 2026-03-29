/**
 * OpenCode agent adapter.
 *
 * Provides OpenCode-specific behavior for session tracking,
 * working directory extraction, content normalization, and tool configuration.
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { normalizeContent } from "../messages"
import { extractClientCwd } from "../session/fingerprint"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME, ALLOWED_MCP_TOOLS } from "../tools"

export const openCodeAdapter: AgentAdapter = {
  name: "opencode",

  getSessionId(c: Context): string | undefined {
    return c.req.header("x-opencode-session")
  },

  getProfileId(c: Context): string | undefined {
    return c.req.header("x-meridian-profile")
  },

  extractWorkingDirectory(body: any): string | undefined {
    return extractClientCwd(body)
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
}
