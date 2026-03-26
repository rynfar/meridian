/**
 * Agent adapter interface.
 *
 * Abstracts agent-specific behavior so the proxy can work with
 * different calling agents (OpenCode, Claude Code, custom agents).
 */

import type { Context } from "hono"

/**
 * An agent adapter provides agent-specific configuration to the proxy.
 * The proxy calls these methods during request handling to determine
 * how to interact with the calling agent.
 */
export interface AgentAdapter {
  /** Human-readable name for logging */
  readonly name: string

  /**
   * Extract a session ID from the request.
   * Returns undefined if the agent doesn't provide session tracking.
   */
  getSessionId(c: Context): string | undefined
  getProfileId(c: Context): string | undefined

  /**
   * Extract the client's working directory from the request body.
   * Returns undefined to fall back to CLAUDE_PROXY_WORKDIR or process.cwd().
   */
  extractWorkingDirectory(body: any): string | undefined

  /**
   * Content normalization — convert message content to a stable string
   * for hashing. Agents may send content in different formats.
   */
  normalizeContent(content: any): string

  /**
   * SDK built-in tools to block (replaced by MCP equivalents).
   * These are tools where the agent provides its own implementation.
   */
  getBlockedBuiltinTools(): readonly string[]

  /**
   * Claude Code SDK tools that have no equivalent in this agent.
   * These are blocked to prevent Claude from calling tools the agent
   * can't handle.
   */
  getAgentIncompatibleTools(): readonly string[]

  /**
   * The MCP server name used by this agent.
   * Tools are registered as `mcp__{name}__{tool}`.
   */
  getMcpServerName(): string

  /**
   * MCP tools that are allowed through the proxy's tool filter.
   */
  getAllowedMcpTools(): readonly string[]
}
