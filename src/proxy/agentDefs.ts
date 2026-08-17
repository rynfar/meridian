/**
 * Extract SDK AgentDefinition objects from OpenCode's Task tool description.
 *
 * OpenCode (via oh-my-opencode or other frameworks) sends a Task tool with
 * descriptions of each available agent. We parse these and convert them into
 * Claude Agent SDK `AgentDefinition` objects so the SDK's native Task handler
 * routes to properly-configured subagents.
 *
 * This means whatever agents the user configures in their framework
 * automatically become available as SDK subagents — with descriptions,
 * model tiers, and tool access.
 */

/** Fallback agent name used when no fuzzy match is found */
export const FALLBACK_AGENT_NAME = "general"

/**
 * Well-known agent types that the SDK (or Claude) commonly references.
 * These are injected as defaults when parsing yields user-defined agents
 * but is missing one or more of these types.
 */
const DEFAULT_AGENT_TYPES: Record<string, string> = {
  build: "The default agent. Executes tools based on configured permissions.",
  plan: "Plan mode. Disallows all edit tools.",
  explore: "Contextual grep for codebases. Answers 'Where is X?', 'Which file has Y?'.",
  general: "General-purpose agent for researching complex questions and executing multi-step tasks.",
}

/** SDK-compatible agent definition */
export type AgentModelTier = "sonnet" | "opus" | "haiku" | "inherit"

export interface AgentDefinition {
  description: string
  prompt: string
  model?: AgentModelTier
  tools?: string[]
  disallowedTools?: string[]
}

/**
 * Parse agent entries from the Task tool description text.
 *
 * Expected format (from OpenCode):
 *   - agent-name: Description of what the agent does
 *
 * @returns Map of agent name → description
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
 *
 * The SDK only accepts 'sonnet' | 'opus' | 'haiku' | 'inherit'.
 * We map based on the model name pattern, defaulting to 'inherit'
 * for non-Anthropic models (they'll use the parent session's model).
 */
export function mapModelTier(model?: string): AgentModelTier {
  if (!model) return "inherit"
  const lower = model.toLowerCase()
  // AgentDefinition only accepts base SDK tiers. Inheriting an opus[1m]
  // parent would keep native Task subagents on the expensive 1M window;
  // selecting "opus" explicitly preserves the intended 200k subagent tier.
  if (lower.includes("opus")) return "opus"
  if (lower.includes("haiku")) return "haiku"
  if (lower.includes("sonnet")) return "sonnet"
  return "inherit"
}

/**
 * Build SDK AgentDefinition objects from the Task tool description.
 *
 * Each agent gets:
 * - description: from the Task tool text (user-configured)
 * - prompt: instructional prompt incorporating the description
 * - model: the caller-selected base SDK tier; unknown models inherit the parent
 * - tools: undefined (inherit all tools from parent)
 *
 * @param taskDescription - The full Task tool description text from OpenCode
 * @param mcpToolNames - Optional list of MCP tool names to make available to agents
 * @param modelTier - Base SDK tier for native Task subagents
 */
export function buildAgentDefinitions(
  taskDescription: string,
  mcpToolNames?: string[],
  modelTier: AgentModelTier = "inherit"
): Record<string, AgentDefinition> {
  const descriptions = parseAgentDescriptions(taskDescription)
  const agents: Record<string, AgentDefinition> = {}

  for (const [name, description] of descriptions) {
    agents[name] = {
      description,
      prompt: buildAgentPrompt(name, description),
      model: modelTier,
      // Give agents access to MCP tools if provided
      ...(mcpToolNames?.length ? { tools: [...mcpToolNames] } : {}),
    }
  }

  // Inject defaults only when parsing yielded at least one agent.
  // If parsing yielded nothing, leave empty so the SDK uses its built-in types.
  if (descriptions.size > 0) {
    ensureDefaultAgents(agents, mcpToolNames, modelTier)
    addCaseVariants(agents)
  }

  return agents
}

/**
 * Fill in any well-known default agents not already present in the agents map.
 * User-defined agents always take priority (we never overwrite).
 */
function ensureDefaultAgents(
  agents: Record<string, AgentDefinition>,
  mcpToolNames: string[] | undefined,
  modelTier: AgentModelTier
): void {
  for (const [name, description] of Object.entries(DEFAULT_AGENT_TYPES)) {
    if (!agents[name]) {
      agents[name] = {
        description,
        prompt: buildAgentPrompt(name, description),
        model: modelTier,
        ...(mcpToolNames?.length ? { tools: [...mcpToolNames] } : {}),
      }
    }
  }
}

/**
 * Register PascalCase aliases for every agent.
 *
 * Claude frequently sends capitalized agent names (e.g., "Explore", "Plan").
 * The SDK's Claude subprocess validates subagent_type against the registered
 * agents map BEFORE our PreToolUse hook can rewrite it. By registering
 * PascalCase variants we ensure they pass validation.
 *
 * Also registers common Claude-invented names like "general-purpose".
 */
function cloneAgentDefinition(def: AgentDefinition): AgentDefinition {
  return {
    ...def,
    ...(def.tools ? { tools: [...def.tools] } : {}),
    ...(def.disallowedTools ? { disallowedTools: [...def.disallowedTools] } : {}),
  }
}

function addCaseVariants(agents: Record<string, AgentDefinition>): void {
  // Snapshot keys before mutating (avoids iterating newly-added entries)
  const baseNames = Object.keys(agents)

  for (const name of baseNames) {
    const def = agents[name]!
    // Title-case: "explore" → "Explore", "sisyphus-junior" → "Sisyphus-Junior"
    const titleCase = name.replace(/(^|-)(\w)/g, (_m, sep: string, ch: string) =>
      sep + ch.toUpperCase()
    )
    if (titleCase !== name && !agents[titleCase]) {
      agents[titleCase] = cloneAgentDefinition(def)
    }
  }

  // Common Claude-invented aliases that map to registered agents
  const ALIASES: Record<string, string> = {
    "general-purpose": "general",
    "General-Purpose": "general",
  }
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (!agents[alias] && agents[target]) {
      agents[alias] = cloneAgentDefinition(agents[target]!)
    }
  }
}

function getNested(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const key of keys) {
    if (cur === null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

export function parseAgentNamesFromSchema(taskTool: unknown): string[] {
  const enumNames = getNested(taskTool, "input_schema", "properties", "subagent_type", "enum")
  if (!Array.isArray(enumNames)) return []
  return enumNames.filter((n: unknown): n is string => typeof n === "string")
}

export function buildAgentDefinitionsFromTool(
  taskTool: unknown,
  mcpToolNames?: string[],
  modelTier: AgentModelTier = "inherit"
): Record<string, AgentDefinition> {
  const rawDescription = getNested(taskTool, "description")
  const description = typeof rawDescription === "string" ? rawDescription : ""
  const fromDescription = buildAgentDefinitions(description, mcpToolNames, modelTier)
  if (Object.keys(fromDescription).length > 0) return fromDescription

  const names = parseAgentNamesFromSchema(taskTool)
  if (names.length === 0) return {}

  const agents: Record<string, AgentDefinition> = {}
  for (const name of names) {
    if (agents[name]) continue
    const desc = `User-defined agent: ${name}`
    agents[name] = {
      description: desc,
      prompt: buildAgentPrompt(name, desc),
      model: modelTier,
      ...(mcpToolNames?.length ? { tools: [...mcpToolNames] } : {}),
    }
  }
  ensureDefaultAgents(agents, mcpToolNames, modelTier)
  addCaseVariants(agents)
  return agents
}

function buildAgentPrompt(name: string, description: string): string {
  return `You are the "${name}" agent. ${description}

Focus on your specific role and complete the task thoroughly. Return a clear, concise result.`
}
