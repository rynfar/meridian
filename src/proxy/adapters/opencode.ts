/**
 * OpenCode agent adapter.
 *
 * Provides OpenCode-specific behavior for session tracking,
 * working directory extraction, content normalization, and tool configuration.
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { type FileChange, extractFileChangesFromBash } from "../fileChanges"
import { normalizeContent } from "../messages"
import { extractClientCwd } from "../session/fingerprint"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME, ALLOWED_MCP_TOOLS } from "../tools"
import { buildAgentDefinitionsFromTool, mapModelTier } from "../agentDefs"
import { fuzzyMatchAgentName } from "../agentMatch"
import { resolvePassthrough } from "../../env"

export const openCodeAdapter: AgentAdapter = {
  name: "opencode",

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

  extractWorkingDirectory(body: any): string | undefined {
    return extractClientCwd(body)
  },

  /**
   * Same parse, exposed separately on purpose.
   *
   * `extractWorkingDirectory` feeds `resolveSdkWorkingDirectory`, where
   * `MERIDIAN_WORKDIR` / `CLAUDE_PROXY_WORKDIR` outrank it. An operator who
   * pins the SDK to one directory therefore erases the client's path from
   * `claimedWorkingDirectory`, which is what `server.ts` falls back to when an
   * adapter leaves this method undefined. `buildCwdNote` then compares the
   * pinned path against itself, emits nothing, and the SDK's own env block
   * advertises the proxy's directory to the model.
   *
   * Reading the client's path here keeps it out of reach of that override, so
   * the note still names the user's directory and fingerprint bucketing still
   * separates unrelated projects. `piAdapter` does the same for the same
   * reason.
   */
  extractClientWorkingDirectory(body: any): string | undefined {
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
