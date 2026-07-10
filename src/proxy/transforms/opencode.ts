import type { Transform, RequestContext } from "../transform"
import { extractFileChangesFromBash, type FileChange } from "../fileChanges"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, ALLOWED_MCP_TOOLS } from "../tools"
import { buildAgentDefinitionsFromTool } from "../agentDefs"
import { fuzzyMatchAgentName } from "../agentMatch"
import { resolvePassthrough } from "../../env"

export const openCodeTransforms: Transform[] = [
  {
    name: "opencode-core",
    // "openai" (/v1/chat/completions) reuses this pipeline via the transform
    // registry; it must be listed here or the transform is skipped and OpenAI
    // clients get built-in tools unblocked + passthrough off (#546).
    adapters: ["opencode", "openai"],

    onRequest(ctx: RequestContext): RequestContext {
      const body = ctx.body

      // Tool configuration
      const blockedTools = BLOCKED_BUILTIN_TOOLS
      const incompatibleTools = CLAUDE_CODE_ONLY_TOOLS
      const allowedMcpTools = ALLOWED_MCP_TOOLS
      const coreToolNames: readonly string[] = ["read", "write", "edit", "bash", "glob", "grep"]

      // Passthrough mode (env var, default true). Mirrors opencodeAdapter.usesPassthrough().
      const passthrough = resolvePassthrough(true)

      // SDK agents (parse Task tool description)
      let sdkAgents: Record<string, any> = {}
      if (Array.isArray(body.tools)) {
        const taskTool = body.tools.find((t: any) => t.name === "task" || t.name === "Task")
        if (taskTool) {
          sdkAgents = buildAgentDefinitionsFromTool(taskTool, [...allowedMcpTools])
        }
      }

      // SDK hooks (fuzzy-match agent names in Task tool)
      let sdkHooks: any = undefined
      const validAgentNames = Object.keys(sdkAgents)
      if (validAgentNames.length > 0) {
        sdkHooks = {
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
      }

      // System context addendum (agent name hints)
      let systemContext = ctx.systemContext
      if (validAgentNames.length > 0 && systemContext !== undefined) {
        systemContext += `\n\nIMPORTANT: When using the task/Task tool, the subagent_type parameter must be one of these exact values (case-sensitive, lowercase): ${validAgentNames.join(", ")}. Do NOT capitalize or modify these names.`
      } else if (validAgentNames.length > 0) {
        systemContext = `IMPORTANT: When using the task/Task tool, the subagent_type parameter must be one of these exact values (case-sensitive, lowercase): ${validAgentNames.join(", ")}. Do NOT capitalize or modify these names.`
      }

      // File change extraction function
      const extractFileChangesFromToolUse = (toolName: string, toolInput: unknown): FileChange[] => {
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
      }

      return {
        ...ctx,
        blockedTools,
        incompatibleTools,
        allowedMcpTools,
        coreToolNames,
        passthrough,
        sdkAgents,
        sdkHooks,
        systemContext,
        supportsThinking: true,
        shouldTrackFileChanges: false,
        extractFileChangesFromToolUse,
      }
    },
  },
]
