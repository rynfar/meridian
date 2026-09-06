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
 * Codex's built-in tools — the ones it sends as top-level `function`/`custom`
 * entries rather than inside an MCP `namespace`. These stay loaded on every
 * turn; everything else (MCP servers, apps) is deferred behind the SDK's tool
 * search when the request crosses the auto-defer threshold. The OpenCode list
 * (read/write/edit/bash/…) names nothing Codex sends, so inheriting it deferred
 * every tool including `exec_command` and cost every turn a discovery round.
 * Mirrors Codex's own native behaviour: MCP tools deferred, built-ins direct.
 */
const CODEX_CORE_TOOL_NAMES: readonly string[] = [
  "exec_command", "write_stdin", "shell", "shell_command", "local_shell",
  "apply_patch", "view_image",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  "request_user_input", "request_plugin_install",
  "get_goal", "create_goal", "update_goal",
]

export const codexTransforms: Transform[] = [
  {
    name: "codex-force-passthrough",
    adapters: ["codex"],
    onRequest(ctx: RequestContext): RequestContext {
      return { ...ctx, passthrough: true, coreToolNames: CODEX_CORE_TOOL_NAMES }
    },
  },
]
