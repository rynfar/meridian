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
/**
 * Codex sends every MCP server as a `namespace` entry with the tool
 * definitions inline, so a desktop session easily carries 250+ tools and
 * crosses the auto-defer threshold. Deferring them is a net loss here: the
 * deferred budget lifts the single-turn cap (see computePassthroughMaxTurns),
 * so every tool-calling turn also generates the SDK's discarded digest turn —
 * one or two extra reads of the full context, measured 2-3x cache reads per
 * turn on a 680k-token session — while the alternative, loading the schemas,
 * costs ~125k cached tokens once. Codex never sets `defer_loading` itself, so
 * with no core set auto-defer stays off, the cap stays at 1, and a tool turn
 * is one model call again.
 */
export const codexTransforms: Transform[] = [
  {
    name: "codex-force-passthrough",
    adapters: ["codex"],
    onRequest(ctx: RequestContext): RequestContext {
      return { ...ctx, passthrough: true, coreToolNames: undefined }
    },
  },
]
