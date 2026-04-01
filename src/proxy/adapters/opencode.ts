/**
 * OpenCode agent adapter.
 *
 * Provides OpenCode-specific behavior for session tracking,
 * working directory extraction, content normalization, tool configuration,
 * subagent definition parsing, and fuzzy agent name matching.
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { type FileChange, extractFileChangesFromBash } from "../fileChanges"
import { normalizeContent } from "../messages"
import { extractClientCwd } from "../session/fingerprint"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

// --- MCP tool configuration ---

const MCP_SERVER_NAME = "opencode"

const ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${MCP_SERVER_NAME}__read`,
  `mcp__${MCP_SERVER_NAME}__write`,
  `mcp__${MCP_SERVER_NAME}__edit`,
  `mcp__${MCP_SERVER_NAME}__bash`,
  `mcp__${MCP_SERVER_NAME}__glob`,
  `mcp__${MCP_SERVER_NAME}__grep`,
]

// --- Agent definition parsing ---

/** SDK-compatible agent definition */
export interface AgentDefinition {
  description: string
  prompt: string
  model?: "sonnet" | "opus" | "haiku" | "inherit"
  tools?: string[]
  disallowedTools?: string[]
}

/**
 * Parse agent entries from the Task tool description text.
 *
 * Expected format (from OpenCode):
 *   - agent-name: Description of what the agent does
 */
export function parseAgentDescriptions(taskDescription: string): Map<string, string> {
  const agents = new Map<string, string>()

  const agentSection = taskDescription.match(
    /Available agent types.*?:\n((?:- [\w][\w-]*:.*\n?)+)/s
  )
  if (!agentSection) return agents

  const entries = agentSection[1]!.matchAll(/^- ([\w][\w-]*):\s*(.+)/gm)
  for (const match of entries) {
    agents.set(match[1]!, match[2]!.trim())
  }

  return agents
}

/**
 * Map an OpenCode model string to an SDK model tier.
 */
export function mapModelTier(model?: string): "sonnet" | "opus" | "opus[1m]" | "haiku" | "inherit" {
  if (!model) return "inherit"
  const lower = model.toLowerCase()
  if (lower.includes("opus")) return "opus[1m]"
  if (lower.includes("haiku")) return "haiku"
  if (lower.includes("sonnet")) return "sonnet"
  return "inherit"
}

function buildAgentPrompt(name: string, description: string): string {
  return `You are the "${name}" agent. ${description}

Focus on your specific role and complete the task thoroughly. Return a clear, concise result.`
}

/**
 * Build SDK AgentDefinition objects from the Task tool description.
 */
export function buildAgentDefinitions(
  taskDescription: string,
  mcpToolNames?: string[]
): Record<string, AgentDefinition> {
  const descriptions = parseAgentDescriptions(taskDescription)
  const agents: Record<string, AgentDefinition> = {}

  for (const [name, description] of descriptions) {
    agents[name] = {
      description,
      prompt: buildAgentPrompt(name, description),
      model: "inherit",
      ...(mcpToolNames?.length ? { tools: [...mcpToolNames] } : {}),
    }
  }

  return agents
}

// --- Fuzzy agent name matching ---

const KNOWN_ALIASES: Record<string, string> = {
  "general-purpose": "general",
  "default": "general",
  "code-reviewer": "oracle",
  "reviewer": "oracle",
  "code-review": "oracle",
  "review": "oracle",
  "consultation": "oracle",
  "analyzer": "oracle",
  "debugger": "oracle",
  "search": "explore",
  "grep": "explore",
  "find": "explore",
  "codebase-search": "explore",
  "research": "librarian",
  "docs": "librarian",
  "documentation": "librarian",
  "lookup": "librarian",
  "reference": "librarian",
  "consult": "oracle",
  "architect": "oracle",
  "image-analyzer": "multimodal-looker",
  "image": "multimodal-looker",
  "pdf": "multimodal-looker",
  "visual": "multimodal-looker",
  "planner": "plan",
  "planning": "plan",
  "builder": "build",
  "coder": "build",
  "developer": "build",
  "writer": "build",
  "executor": "build",
}

const STRIP_SUFFIXES = ["-agent", "-tool", "-worker", "-task", " agent", " tool"]

export function fuzzyMatchAgentName(input: string, validAgents: string[]): string {
  if (!input) return input
  if (validAgents.length === 0) return input.toLowerCase()

  const lowered = input.toLowerCase()

  // 1. Exact match (case-insensitive)
  const exact = validAgents.find(a => a.toLowerCase() === lowered)
  if (exact) return exact

  // 2. Known aliases
  const alias = KNOWN_ALIASES[lowered]
  if (alias && validAgents.includes(alias)) return alias

  // 3. Prefix match
  const prefixMatch = validAgents.find(a => a.toLowerCase().startsWith(lowered))
  if (prefixMatch) return prefixMatch

  // 4. Substring match
  const substringMatch = validAgents.find(a => a.toLowerCase().includes(lowered))
  if (substringMatch) return substringMatch

  // 5. Suffix-stripped match
  for (const suffix of STRIP_SUFFIXES) {
    if (lowered.endsWith(suffix)) {
      const stripped = lowered.slice(0, -suffix.length)
      const strippedMatch = validAgents.find(a => a.toLowerCase() === stripped)
      if (strippedMatch) return strippedMatch
    }
  }

  // 6. Reverse substring (input contains a valid agent name)
  const reverseMatch = validAgents.find(a => lowered.includes(a.toLowerCase()))
  if (reverseMatch) return reverseMatch

  // 7. Fallback
  return lowered
}

// --- Adapter implementation ---

export const openCodeAdapter: AgentAdapter = {
  name: "opencode",

  getSessionId(c: Context): string | undefined {
    return c.req.header("x-opencode-session")
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

  buildSdkAgents(body: any, mcpToolNames: readonly string[]): Record<string, any> {
    if (!Array.isArray(body.tools)) return {}
    const taskTool = body.tools.find((t: any) => t.name === "task" || t.name === "Task")
    if (!taskTool?.description) return {}
    return buildAgentDefinitions(taskTool.description, [...mcpToolNames])
  },

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

  buildSystemContextAddendum(_body: any, sdkAgents: Record<string, any>): string {
    const validAgentNames = Object.keys(sdkAgents)
    if (validAgentNames.length === 0) return ""
    return `\n\nIMPORTANT: When using the task/Task tool, the subagent_type parameter must be one of these exact values (case-sensitive, lowercase): ${validAgentNames.join(", ")}. Do NOT capitalize or modify these names.`
  },

  extractFileChangesFromToolUse(toolName: string, toolInput: unknown): FileChange[] {
    const input = toolInput as Record<string, unknown> | null | undefined
    const filePath = input?.filePath ?? input?.file_path

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
