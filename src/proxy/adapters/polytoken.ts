/**
 * Polytoken native adapter.
 *
 * Polytoken sends Anthropic Messages requests with a stable
 * `X-Polytoken-Session` header and executes its own tools client-side — the
 * client owns the tool loop, so the proxy must ALWAYS run in passthrough mode
 * and never activate OpenCode-style agent behavior (subagent parsing, fuzzy
 * aliasing, Task-tool routing, file-change tracking).
 *
 * Identity contract:
 *   - Session identity comes ONLY from X-Polytoken-Session, trimmed. No
 *     parent identity, no agent-mode scoping, no attestation, no OpenCode
 *     lineage normalization. A missing/blank header means "no identity": the
 *     request runs fingerprint-less and independent (never resumed) rather
 *     than being given an invented key.
 *   - The header is a session key, not an authentication credential — same
 *     trust model as every other adapter's headers.
 *
 * CWD contract: a network-hosted Polytoken may run its tools and environment
 * far from the proxy, and the client does not advertise a machine-readable
 * working directory, so extraction returns undefined (SDK cwd falls back to
 * MERIDIAN_WORKDIR/process.cwd()) and `clientEnvironmentMayDifferFromProxy`
 * keeps the environment distinction explicit.
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { normalizeContent } from "../messages"

const POLYTOKEN_SESSION_HEADER = "x-polytoken-session"

/**
 * Normalize the native session id: trim surrounding whitespace; a nonempty
 * trimmed string is returned unchanged. Missing/empty/whitespace-only →
 * undefined. No charset restriction, fixed fallback, profile prefix, or
 * affinity-header fallback — the client's value IS the identity.
 */
export function normalizePolytokenSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export const polytokenAdapter: AgentAdapter = {
  name: "polytoken",

  /**
   * NOTE: Polytoken-specific. A network-hosted Polytoken runs its tool loop
   * and environment outside the proxy process; no client-advertised path is
   * machine-readable here, so the proxy never adopts one.
   */
  clientEnvironmentMayDifferFromProxy: true,

  getSessionId(c: Context): string | undefined {
    return normalizePolytokenSessionId(c.req.header(POLYTOKEN_SESSION_HEADER))
  },

  /**
   * NOTE: Polytoken-specific. The client's tools run on the Polytoken host;
   * arbitrary client prose or remote paths must never become the SDK cwd.
   */
  extractWorkingDirectory(_body: any): string | undefined {
    return undefined
  },

  /**
   * NOTE: Polytoken-specific. Same as extractWorkingDirectory: the client
   * advertises no machine-readable working directory, so fingerprinting falls
   * back to the SDK cwd rather than parsing prompt text.
   */
  extractClientWorkingDirectory(_body: any): string | undefined {
    return undefined
  },

  normalizeContent(content: any): string {
    return normalizeContent(content)
  },

  getBlockedBuiltinTools(): readonly string[] {
    return []
  },

  getAgentIncompatibleTools(): readonly string[] {
    return []
  },

  getMcpServerName(): string {
    return "polytoken"
  },

  getAllowedMcpTools(): readonly string[] {
    return []
  },

  /**
   * Polytoken executes its own tools — the proxy never runs SDK-internal tools
   * for this protocol, so there is nothing to block via disallowedTools and
   * no internal MCP server to register.
   */
  getCoreToolNames(): readonly string[] {
    return []
  },

  usesPassthrough(): boolean {
    // MANDATORY. The client owns the tool loop; internal SDK execution would
    // strand every tool call on the proxy host. Global/instance "false"
    // settings are ineffective for this protocol (enforced in server.ts).
    return true
  },

  supportsThinking(): boolean {
    return true
  },

  /**
   * NOTE: Polytoken-specific. The client renders its own file/edit state;
   * appending a synthetic "Files changed:" block would duplicate it.
   */
  shouldTrackFileChanges(): boolean {
    return false
  },

  /**
   * NOTE: Polytoken-specific. No Task-tool parsing, no SDK subagent routing,
   * no agent-name hints: the client owns all agent orchestration.
   */
  buildSdkAgents(_body: any, _mcpToolNames: readonly string[]): Record<string, any> {
    return {}
  },

  buildSdkHooks(_body: any, _sdkAgents: Record<string, any>): undefined {
    return undefined
  },

  buildSystemContextAddendum(_body: any, _sdkAgents: Record<string, any>): string {
    return ""
  },
}

import { polytokenTransforms } from "../transforms/polytoken"
export { polytokenTransforms }