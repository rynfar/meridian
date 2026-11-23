import type { Transform, RequestContext } from "../transform"

/**
 * Zed rides the OpenAI-compatible endpoint and reuses OpenCode's tool
 * pipeline (see transforms/registry.ts); this follow-on transform applies
 * what differs for Zed.
 */
export const zedTransforms: Transform[] = [
  {
    name: "zed-core",
    adapters: ["zed"],

    onRequest(ctx: RequestContext): RequestContext {
      return {
        ...ctx,
        // NOTE: Zed-specific. Zed's tool names (read_file, grep, terminal, …)
        // share nothing with OpenCode's core set, so auto-defer would keep one
        // tool eager and defer the other eighty-odd behind ToolSearch. Zed's
        // catalog stays fully loaded, as it was validated.
        coreToolNames: undefined,
        // NOTE: Zed-specific. Nothing from the proxy host: Zed ships the
        // user's AGENTS.md and the project's rules in its own system prompt.
        settingSources: [],
        // NOTE: Zed-specific. Zed's panel shows every file edit as a tool
        // card; Meridian's "Files changed:" block would only duplicate it.
        shouldTrackFileChanges: false,
        extractFileChangesFromToolUse: undefined,
      }
    },
  },
]
