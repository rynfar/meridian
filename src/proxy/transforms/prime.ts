import type { Transform, RequestContext } from "../transform"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"
import { resolvePassthrough } from "../../env"
import { PRIME_ALLOWED_MCP_TOOLS, extractPrimeFileChanges } from "../adapters/prime"

/**
 * Resolve passthrough for Prime Agent. Mirrors the adapter's `usesPassthrough()`
 * so transform and adapter agree (enforced by the transform-parity test).
 *
 * Default ON. Prime Agent's only tool is a persistent IPython kernel living in
 * the client, which the proxy cannot execute on its behalf — internal mode drops
 * it and falls back to the MCP tool set, a deliberately degraded path. Opt out
 * with MERIDIAN_PASSTHROUGH=0.
 */
function resolvePrimePassthrough(): boolean {
  return resolvePassthrough(true)
}

export const primeTransforms: Transform[] = [
  {
    name: "prime-core",
    adapters: ["prime"],
    onRequest(ctx: RequestContext): RequestContext {
      return {
        ...ctx,
        blockedTools: BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
        allowedMcpTools: PRIME_ALLOWED_MCP_TOOLS,
        sdkAgents: {},
        passthrough: resolvePrimePassthrough(),
        supportsThinking: true,
        // Shared with the adapter rather than re-implemented, so the two
        // cannot drift apart.
        extractFileChangesFromToolUse: extractPrimeFileChanges,
      }
    },
  },
]
