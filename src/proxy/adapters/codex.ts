/**
 * Codex CLI endpoint adapter (#475).
 *
 * The `/v1/responses` route serves the Codex CLI (≥ 0.96), which is a
 * tool-driving agentic client: it sends `tools`, expects tool_use back,
 * executes them locally, and returns `function_call_output`. So this endpoint
 * MUST run in passthrough mode — tool_use flows back to the client — unlike
 * the generic `openai` adapter which follows the global passthrough setting.
 *
 * The handler tags the internal /v1/messages hop with `x-meridian-agent:
 * codex` so this adapter is selected deterministically. Behaviour otherwise
 * mirrors `opencode` (tools, MCP server, transforms); the differences are:
 *   - `usesPassthrough() => true` — always forward tool calls (Codex needs them)
 *   - `codeSystemPrompt` OFF (sdkFeatures.ADAPTER_DEFAULTS) — Codex ships its
 *     own ~21KB instructions; the Claude Code preset must not override them
 *
 * NOTE: agent-specific (Codex). Keep this a thin re-identification of the
 * OpenCode adapter; do not fork behaviour here.
 */

import type { AgentAdapter } from "../adapter"
import { openCodeAdapter } from "./opencode"

export const codexAdapter: AgentAdapter = {
  ...openCodeAdapter,
  name: "codex",
  usesPassthrough() {
    return true
  },
  // Codex sends a per-conversation `prompt_cache_key` (mirrored in its
  // client_metadata as session_id); the /v1/responses route forwards it as
  // this header so consecutive turns resume the same SDK session (#655) —
  // which both preserves Claude's signed thinking across turns and keeps
  // the prompt cache warm. Keyed sessions also bypass the headerless
  // client-driven-loop guard (see server.ts) safely: distinct conversations
  // carry distinct keys, so concurrent runs can't collide.
  getSessionId(c) {
    return c.req.header("x-codex-session")
  },
}
