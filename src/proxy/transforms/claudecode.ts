import type { Transform, RequestContext } from "../transform"
import { extractFileChangesFromBash, type FileChange } from "../fileChanges"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, ALLOWED_MCP_TOOLS } from "../tools"
import { resolvePassthrough } from "../../env"

/**
 * Claude Code transform — supplies the SDK tool config at request time.
 *
 * server.ts reads `pipelineCtx.*`, never the adapter methods, so without an
 * entry here a Claude Code client gets the createRequestContext defaults:
 * `blockedTools: []` and `passthrough: undefined`. That means the SDK
 * subprocess runs the client's task with its own built-in Read/Write/Bash on
 * the proxy host while the client executes the same tool calls locally —
 * every side effect happens twice (#546, same failure mode as OpenCode's).
 *
 * Values mirror claudeCodeAdapter (adapters/claudecode.ts); the parity tests
 * hold the two in sync. Core tool names are PascalCase here — Claude Code's
 * toolkit is Read/Write/Edit/Bash/Glob/Grep, not OpenCode's lowercase names.
 */
export const claudeCodeTransforms: Transform[] = [
  {
    name: "claudecode-core",
    adapters: ["claude-code"],

    onRequest(ctx: RequestContext): RequestContext {
      const extractFileChangesFromToolUse = (toolName: string, toolInput: unknown): FileChange[] => {
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
      }

      return {
        ...ctx,
        blockedTools: BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
        allowedMcpTools: ALLOWED_MCP_TOOLS,
        coreToolNames: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        // Claude Code owns tool execution client-side. Mirrors
        // claudeCodeAdapter.usesPassthrough().
        passthrough: resolvePassthrough(true),
        supportsThinking: true,
        // Claude Code surfaces its own file edits; don't duplicate them.
        shouldTrackFileChanges: false,
        extractFileChangesFromToolUse,
      }
    },
  },
]
