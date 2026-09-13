/**
 * OpenCode agent adapter.
 *
 * Provides OpenCode-specific behavior for session tracking,
 * working directory extraction, content normalization, and tool configuration.
 */

import type { Context } from "hono"
import type { AgentAdapter, RoutingTurnIdentity } from "../adapter"
import { type FileChange, extractFileChangesFromBash } from "../fileChanges"
import { PRIORITY_ATTESTATION_HEADER, verifyPriorityAttestation } from "../priorityAttestation"
import { normalizeContent } from "../messages"
import { extractClientCwd } from "../session/fingerprint"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME, ALLOWED_MCP_TOOLS } from "../tools"
import { buildAgentDefinitionsFromTool, mapModelTier } from "../agentDefs"
import { fuzzyMatchAgentName } from "../agentMatch"
import { resolvePassthrough } from "../../env"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * NOTE: OpenCode-specific. OpenCode 1.18 emits UserPromptSubmit hook context as
 * an extra text block on the active user turn, then removes that block when the
 * same turn becomes history. It is request-scoped instruction metadata, not
 * durable conversation content, so hashing it makes every following text turn
 * look like modified history.
 */
function isTransientUserPromptHook(block: unknown): boolean {
  if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return false
  const match = block.text.match(
    /^\s*<user-prompt-submit-hook>\s*([\s\S]*?)\s*<\/user-prompt-submit-hook>\s*$/,
  )
  if (!match?.[1]) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return false
  }
  if (!isRecord(parsed)) return false
  if (isRecord(parsed.hookSpecificOutput)) {
    return parsed.hookSpecificOutput.hookEventName === "UserPromptSubmit"
      && typeof parsed.hookSpecificOutput.additionalContext === "string"
  }
  // NOTE: OpenCode's hook bridge also wraps common SyncHookJSONOutput fields,
  // e.g. {"continue":true}, without hookSpecificOutput (#872). Recognize the
  // documented control envelope, not arbitrary JSON or arbitrary removed text.
  const fields = Object.entries(parsed)
  return fields.length > 0 && fields.every(([key, value]) => {
    switch (key) {
      case "continue":
      case "suppressOutput": return typeof value === "boolean"
      case "stopReason":
      case "systemMessage":
      case "reason": return typeof value === "string"
      case "decision": return value === "approve" || value === "block"
      default: return false
    }
  })
}

export function canonicalizeOpenCodeMessagesForLineage(
  messages: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: unknown }> {
  // Preserve message positions exactly; only block content may be filtered.
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message
    const content = message.content.filter((block) => !isTransientUserPromptHook(block))
    // A hook-only message has no durable identity. Retain it rather than
    // collapsing distinct requests to the same empty hash.
    if (content.length === 0 || content.length === message.content.length) return message
    return { ...message, content }
  })
}

export const openCodeAdapter: AgentAdapter = {
  name: "opencode",

  /**
   * NOTE: OpenCode-specific. OpenCode can call a network-hosted Meridian while
   * its tools and environment block remain local to the OpenCode process.
   */
  clientEnvironmentMayDifferFromProxy: true,

  /**
   * NOTE: OpenCode-specific. OpenCode runs its internal one-shot agents —
   * `title`, `summary`, `compaction` — under the USER'S session id, so the
   * raw header is not a conversation identity on its own. Verified live
   * against OpenCode 1.18.11: the title turn and the user's build turn arrive
   * within milliseconds of each other carrying the same `x-opencode-session`.
   * OpenCode also sends that value as `x-session-affinity` natively, so a
   * client with no plugin has no agent header and cannot be scoped here — see
   * the note in the body, and `meridian setup` (required, warned about at
   * startup and reported by /health).
   *
   * Sharing one key made two unrelated conversations share one lineage and one
   * per-session turn lease. The title turn wins the race, commits its
   * one-message lineage, and the user's real turn — after waiting 5-12s behind
   * the lease — is measured against it as `unrelated-history`: refused with
   * HTTP 400 `session_turn_conflict` since #825, and before that replayed in
   * full against a cold prompt cache.
   *
   * Scoping by agent gives every non-primary agent its own lineage and lease.
   * The primary agent's key is deliberately left byte-identical to the raw
   * header so existing conversations, the shared session store, and the
   * `x-opencode-session` contract are unaffected.
   *
   * Real task-tool subagents are scoped too, which is strictly better than the
   * status quo: they also carried the parent's key, so their turns and the
   * parent's competed for one lease and one lineage.
   */
  getSessionId(c: Context): string | undefined {
    const base = c.req.header("x-opencode-session") ?? c.req.header("x-session-affinity")
    if (!base) return undefined
    // Only non-primary agents are scoped, and only when the plugin says so.
    // Inferring the agent from the request's shape was tried and reverted: the
    // only available signal — a tool-less single-message conversation — is also
    // the first turn of an ordinary tool-less chat, so scoping on it broke
    // resume for those on turn 2 (5 suites red, incl. session-lineage's strict
    // continuation). A plugin too old to send the name gets today's behavior.
    if (c.req.header("x-opencode-agent-mode") !== "subagent") return base
    const agent = c.req.header("x-opencode-agent-name")?.trim()
    return agent ? `${base}#${agent}` : base
  },

  /** NOTE: OpenCode-specific. The plugin marks client-managed subagent turns. */
  getAgentMode(c: Context): string | undefined {
    return c.req.header("x-opencode-agent-mode")
  },

  /**
   * NOTE: OpenCode-specific. Only a final-hook HMAC assertion can authorize a
   * user-turn routing change. Raw request-kind/request-ID headers are not a
   * trust boundary: OpenCode is the default adapter and any HTTP client can
   * copy them.
   */
  getRoutingTurnIdentity(c: Context): RoutingTurnIdentity | undefined {
    // Explicit pins never participate in priority failback. Check presence,
    // not truthiness, so an empty malformed pin also fails closed.
    if (c.req.header("x-meridian-profile") !== undefined) return undefined
    const sessionId = c.req.header("x-opencode-session")
    const agentId = c.req.header("x-opencode-agent-name")
    if (!sessionId || !agentId || c.req.header("x-opencode-agent-mode") !== "primary") {
      return undefined
    }
    const attestation = verifyPriorityAttestation(c.req.header(PRIORITY_ATTESTATION_HEADER))
    if (!attestation || attestation.sessionId !== sessionId || attestation.agentId !== agentId) {
      return undefined
    }
    return {
      kind: "human",
      turnId: attestation.turnId,
      issuedAt: attestation.issuedAt,
      generation: attestation.generation === "oc1"
        ? "opencode-v1"
        : "opencode-v2-beta-18314",
    }
  },

  extractWorkingDirectory(body: any): string | undefined {
    return extractClientCwd(body)
  },

  /**
   * NOTE: OpenCode-specific. Expose the same request parse independently from
   * `extractWorkingDirectory`: operator overrides may replace the SDK cwd, but
   * must not replace the path used for project fingerprinting or the client
   * environment note.
   */
  extractClientWorkingDirectory(body: any): string | undefined {
    return extractClientCwd(body)
  },

  normalizeContent(content: any): string {
    return normalizeContent(content)
  },

  canonicalizeMessagesForLineage(messages) {
    return canonicalizeOpenCodeMessagesForLineage(messages)
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
    // Tools Claude uses on nearly every turn — always loaded, never deferred.
    return ["read", "write", "edit", "bash", "glob", "grep"]
  },

  usesPassthrough(): boolean {
    return resolvePassthrough(true)
  },

  supportsThinking(): boolean {
    return true
  },

  /**
   * NOTE: OpenCode-specific. OpenCode already exposes file edits in its own UI,
   * so Meridian should not append a synthetic "Files changed:" block.
   */
  shouldTrackFileChanges(): boolean {
    return false
  },

  /**
   * NOTE: OpenCode-specific. Parses the Task tool description to extract
   * subagent names and build SDK AgentDefinition objects for native subagent routing.
   */
  buildSdkAgents(body: any, mcpToolNames: readonly string[]): Record<string, any> {
    if (!Array.isArray(body.tools)) return {}
    const taskTool = body.tools.find((t: any) => t.name === "task" || t.name === "Task")
    if (!taskTool) return {}
    return buildAgentDefinitionsFromTool(taskTool, [...mcpToolNames], mapModelTier(body.model))
  },

  /**
   * NOTE: OpenCode-specific. Builds a PreToolUse hook that fuzzy-matches
   * subagent_type values to valid agent names before the SDK processes them.
   */
  buildSdkHooks(body: any, sdkAgents: Record<string, any>): any {
    const validAgentNames = Object.keys(sdkAgents)
    if (validAgentNames.length === 0) return undefined
    return {
      PreToolUse: [{
        matcher: "Task",
        hooks: [async (input: any) => ({
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            updatedInput: {
              ...input.tool_input,
              subagent_type: fuzzyMatchAgentName(
                String(input.tool_input?.subagent_type || ""),
                validAgentNames
              ),
            },
          },
        })],
      }],
    }
  },

  /**
   * NOTE: OpenCode-specific. Appends agent name hint to system context so
   * Claude uses exact lowercase agent names when invoking the task/Task tool.
   */
  buildSystemContextAddendum(_body: any, sdkAgents: Record<string, any>): string {
    const validAgentNames = Object.keys(sdkAgents)
    if (validAgentNames.length === 0) return ""
    return `\n\nIMPORTANT: When using the task/Task tool, the subagent_type parameter must be one of these exact values (case-sensitive, lowercase): ${validAgentNames.join(", ")}. Do NOT capitalize or modify these names.`
  },

  /**
   * NOTE: OpenCode-specific. Maps OpenCode's tool names to file changes.
   * OpenCode uses lowercase tool names (write, edit, multiedit) with filePath input.
   * The passthrough proxy may also return PascalCase names (Write, Edit, MultiEdit)
   * from the SDK's tool registration, so we match both.
   * Bash commands are parsed for output redirects (>, >>), tee, and sed -i.
   */
  extractFileChangesFromToolUse(toolName: string, toolInput: unknown): FileChange[] {
    const input = toolInput as Record<string, unknown> | null | undefined
    const filePath = input?.filePath ?? input?.file_path ?? input?.path

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

import { openCodeTransforms } from "../transforms/opencode"
export { openCodeTransforms }
