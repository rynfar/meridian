import type { Transform, RequestContext } from "../transform"
import { extractFileChangesFromBash, type FileChange } from "../fileChanges"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

const PI_MCP_SERVER_NAME = "pi"
const PI_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${PI_MCP_SERVER_NAME}__read`,
  `mcp__${PI_MCP_SERVER_NAME}__write`,
  `mcp__${PI_MCP_SERVER_NAME}__edit`,
  `mcp__${PI_MCP_SERVER_NAME}__bash`,
  `mcp__${PI_MCP_SERVER_NAME}__glob`,
  `mcp__${PI_MCP_SERVER_NAME}__grep`,
]

export const piTransforms: Transform[] = [
  {
    name: "pi-core",
    adapters: ["pi"],
    onRequest(ctx: RequestContext): RequestContext {
      const extractFileChangesFromToolUse = (toolName: string, toolInput: unknown): FileChange[] => {
        const input = toolInput as Record<string, unknown> | null | undefined
        const filePath = input?.filePath ?? input?.file_path ?? input?.path
        if (toolName === "write" && filePath) return [{ operation: "wrote", path: String(filePath) }]
        if (toolName === "edit" && filePath) return [{ operation: "edited", path: String(filePath) }]
        if (toolName === "bash" && input?.command) return extractFileChangesFromBash(String(input.command))
        return []
      }

      return {
        ...ctx,
        blockedTools: BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
        allowedMcpTools: PI_ALLOWED_MCP_TOOLS,
        sdkAgents: {},
        supportsThinking: true,
        extractFileChangesFromToolUse,
      }
    },
  },
]
