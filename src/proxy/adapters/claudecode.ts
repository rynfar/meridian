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
import { resolvePassthrough } from "../../env"

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

/**
 * Session identity declared in `metadata.user_id`.
 *
 * `sessionId` is the whole of the session key — nothing is appended, prefixed,
 * or normalized — because it is what every cached mapping is already stored
 * under. `parentSessionId` is additive: a client that does not stamp it gets
 * exactly the identity it got before the field existed.
 */
export interface ClaudeCodeSessionIdentity {
  readonly sessionId: string
  /**
   * The IMMEDIATE parent's session id, when the client declares subagent
   * lineage. Deeper trees are expressed by each level naming its own parent, so
   * consumers walk the chain rather than expecting a root here.
   */
  readonly parentSessionId?: string
}

/**
 * Parse the identity envelope Claude Code (and Prime Agent's extension) embeds
 * in `metadata.user_id`.
 *
 * Strict by design: `user_id` must be, or parse to, an object carrying a
 * non-empty string `session_id`. Anything else yields undefined and the caller
 * falls back to fingerprint resume, so unrelated Anthropic-API clients that put
 * their own value in `user_id` are never mistaken for a keyed session.
 */
export function extractClaudeCodeSessionIdentity(body: unknown): ClaudeCodeSessionIdentity | undefined {
  if (!body || typeof body !== "object") return undefined

  const metadata = (body as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== "object") return undefined

  const rawUserId = (metadata as { user_id?: unknown }).user_id
  let userMetadata: unknown = rawUserId

  if (typeof rawUserId === "string") {
    try {
      userMetadata = JSON.parse(rawUserId)
    } catch {
      return undefined
    }
  }

  if (!userMetadata || typeof userMetadata !== "object") return undefined
  const sessionId = (userMetadata as { session_id?: unknown }).session_id
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined

  const parentSessionId = (userMetadata as { parent_session_id?: unknown }).parent_session_id
  // A node that names itself as its own parent is not a tree edge, and treating
  // it as one would make a request its own cancellation target.
  const parent = typeof parentSessionId === "string"
    && parentSessionId.length > 0
    && parentSessionId !== sessionId
    ? parentSessionId
    : undefined

  return parent ? { sessionId, parentSessionId: parent } : { sessionId }
}

/** Extract the stable conversation ID embedded by Claude Code in metadata.user_id. */
export function extractClaudeCodeSessionId(body: unknown): string | undefined {
  return extractClaudeCodeSessionIdentity(body)?.sessionId
}

/** Extract the immediate parent session key, when the client declares lineage. */
export function extractClaudeCodeParentSessionId(body: unknown): string | undefined {
  return extractClaudeCodeSessionIdentity(body)?.parentSessionId
}

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",

  /** NOTE: Claude Code-specific. Its environment belongs to the remote client. */

  clientEnvironmentMayDifferFromProxy: true,

  /**
   * Claude Code embeds its conversation ID in metadata.user_id rather than a
   * session-affinity header. Fall back to fingerprint resume when absent.
   */
  getSessionId(_c: Context, body?: unknown): string | undefined {
    return extractClaudeCodeSessionId(body)
  },

  /**
   * Subagent lineage from the same envelope that supplied the session key, so
   * a declared parent always names a key derived the same way this one was.
   */
  getParentSessionId(_c: Context, body?: unknown): string | undefined {
    return extractClaudeCodeParentSessionId(body)
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
    return resolvePassthrough(true)
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
