/**
 * OpenAI-compatible endpoint adapter.
 *
 * `/v1/chat/completions` serves generic OpenAI chat clients (Open WebUI,
 * LibreChat, curl, any OpenAI-compatible tool). These are NOT coding agents:
 * they bring their own system prompt and don't want the ~28KB claude_code
 * preset injected on top of it (which would override their intent with the
 * Claude Code persona — see the #526 investigation).
 *
 * The handler tags the internal hop with `x-meridian-agent: openai` so this
 * adapter is selected deterministically instead of falling through to the
 * default `opencode` adapter (whose preset defaults ON). Behaviour is
 * otherwise identical to `opencode` — same tools, MCP server, passthrough,
 * and transforms — the ONLY difference is the system-prompt preset default,
 * which is set OFF in sdkFeatures.ADAPTER_DEFAULTS. This mirrors the
 * `passthrough` adapter precedent (#190).
 *
 * NOTE: agent-specific. Keep this as a thin re-identification of the OpenCode
 * adapter; do not fork behaviour here.
 */

import type { AgentAdapter } from "../adapter"
import { openCodeAdapter } from "./opencode"

export const openAiAdapter: AgentAdapter = {
  ...openCodeAdapter,
  name: "openai",
}
