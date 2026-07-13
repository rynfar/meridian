import type { Transform, RequestContext } from "../transform"
import {
  CHERRY_WEB_TOOLS,
  CHERRY_BLOCKED_BUILTIN_TOOLS,
  CHERRY_INCOMPATIBLE_TOOLS,
} from "../adapters/cherry"

/**
 * Cherry Studio transform — supplies the SDK tool config at request time.
 *
 * The runtime tool policy lives here (server.ts reads `pipelineCtx.*`, not the
 * adapter methods). Cherry is a chat client that wants Claude's own built-in
 * web search, so we:
 *   - allow only WebSearch/WebFetch (no filesystem MCP tools),
 *   - keep those web tools OUT of the disallowed lists, and
 *   - run non-passthrough so the SDK executes the search internally.
 *
 * See adapters/cherry.ts for the full rationale and #481.
 */
export const cherryTransforms: Transform[] = [
  {
    name: "cherry-core",
    adapters: ["cherry"],

    onRequest(ctx: RequestContext): RequestContext {
      return {
        ...ctx,
        blockedTools: CHERRY_BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: CHERRY_INCOMPATIBLE_TOOLS,
        allowedMcpTools: [...CHERRY_WEB_TOOLS],
        coreToolNames: [],
        passthrough: false,
        // Cherry executes no tools itself — the SDK runs WebSearch internally.
        // Hide the resulting internal tool_use blocks (and unrenderable thinking)
        // from the client so it sees only the final grounded answer.
        hidesInternalTools: true,
        supportsThinking: false,
        // Cherry Studio renders assistant text; it has no native "files
        // changed" surface and doesn't execute tools, so nothing to track.
        shouldTrackFileChanges: false,
      }
    },
  },
]
