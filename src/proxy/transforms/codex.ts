import type { Transform, RequestContext } from "../transform"

/**
 * Codex CLI transform (#475). Runs after the shared OpenCode transform (which
 * codex reuses for tool config); its only job is to FORCE passthrough on.
 *
 * Codex is a tool-driving agentic client — it executes its own tools and needs
 * tool_use blocks returned to it — so it must run passthrough regardless of the
 * global MERIDIAN_PASSTHROUGH setting. Internal mode (SDK executes tools) would
 * leave Codex waiting for tool calls that never come back.
 */
export const codexTransforms: Transform[] = [
  {
    name: "codex-force-passthrough",
    adapters: ["codex"],
    onRequest(ctx: RequestContext): RequestContext {
      return { ...ctx, passthrough: true }
    },
  },
]
