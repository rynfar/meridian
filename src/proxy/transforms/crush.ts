import type { Transform, RequestContext } from "../transform"
import { extractFileChangesFromBash, type FileChange } from "../fileChanges"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

const CRUSH_MCP_SERVER_NAME = "crush"
const CRUSH_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${CRUSH_MCP_SERVER_NAME}__read`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__write`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__edit`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__bash`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__glob`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__grep`,
]

export const crushTransforms: Transform[] = [
  {
    name: "crush-core",
    adapters: ["crush"],
    onRequest(ctx: RequestContext): RequestContext {
      const extractFileChangesFromToolUse = (toolName: string, toolInput: unknown): FileChange[] => {
        const input = toolInput as Record<string, unknown> | null | undefined
        const filePath = input?.file_path ?? input?.path
        if (toolName === "write" && filePath) return [{ operation: "wrote", path: String(filePath) }]
        if ((toolName === "edit" || toolName === "patch") && filePath) return [{ operation: "edited", path: String(filePath) }]
        if (toolName === "bash" && input?.command) return extractFileChangesFromBash(String(input.command))
        return []
      }

      return {
        ...ctx,
        blockedTools: BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
        allowedMcpTools: CRUSH_ALLOWED_MCP_TOOLS,
        sdkAgents: {},
        supportsThinking: true,
        extractFileChangesFromToolUse,
      }
    },
  },
]
