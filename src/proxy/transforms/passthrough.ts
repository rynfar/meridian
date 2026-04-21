import type { Transform, RequestContext } from "../transform"

const MCP_SERVER_NAME = "litellm"
const ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${MCP_SERVER_NAME}__read`,
  `mcp__${MCP_SERVER_NAME}__write`,
  `mcp__${MCP_SERVER_NAME}__edit`,
  `mcp__${MCP_SERVER_NAME}__bash`,
  `mcp__${MCP_SERVER_NAME}__glob`,
  `mcp__${MCP_SERVER_NAME}__grep`,
]

export const passthroughTransforms: Transform[] = [
  {
    name: "passthrough-core",
    adapters: ["passthrough"],
    onRequest(ctx: RequestContext): RequestContext {
      return {
        ...ctx,
        blockedTools: [],
        incompatibleTools: [],
        allowedMcpTools: ALLOWED_MCP_TOOLS,
        sdkAgents: {},
        passthrough: true,
        prefersStreaming: ctx.body?.stream === true,
      }
    },
  },
]
