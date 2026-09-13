import type { Transform, RequestContext } from "../transform"

/**
 * Polytoken native transforms.
 *
 * Scoped to adapter base `polytoken` ONLY — deliberately not spread onto
 * openai/jcode/codex, whose tool configs differ. The client owns the tool
 * loop, so this is pure passthrough plumbing:
 *   - passthrough forced true (mandatory client-owned tool execution);
 *   - signed/redacted thinking preserved (supportsThinking true);
 *   - body/system/tools and the client's stream preference preserved;
 *   - empty SDK agents/hooks — no Task/task parsing, no fuzzy aliases;
 *   - no file-change tracking or core-tool rewriting;
 *   - empty blocked/incompatible/allowed MCP lists and coreToolNames: the
 *     generated client-passthrough MCP names are the only allowed tools, and
 *     an OpenCode-style allowlist would collide with client tool names.
 */
export const polytokenTransforms: Transform[] = [
  {
    name: "polytoken-core",
    adapters: ["polytoken"],
    onRequest(ctx: RequestContext): RequestContext {
      return {
        ...ctx,
        blockedTools: [],
        incompatibleTools: [],
        allowedMcpTools: [],
        coreToolNames: [],
        passthrough: true,
        sdkAgents: {},
        sdkHooks: undefined,
        systemContext: ctx.systemContext,
        supportsThinking: true,
        shouldTrackFileChanges: false,
        extractFileChangesFromToolUse: undefined,
      }
    },
  },
]