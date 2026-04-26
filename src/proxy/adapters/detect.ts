/**
 * Agent adapter detection.
 *
 * Inspects the incoming request to select the appropriate AgentAdapter.
 * Falls back to the OpenCode adapter for backward compatibility.
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { openCodeAdapter } from "./opencode"
import { droidAdapter } from "./droid"
import { crushAdapter } from "./crush"
import { passthroughAdapter } from "./passthrough"
import { piAdapter } from "./pi"
import { forgeCodeAdapter } from "./forgecode"
import { claudeCodeAdapter } from "./claudecode"

const ADAPTER_MAP: Record<string, AgentAdapter> = {
  opencode: openCodeAdapter,
  droid: droidAdapter,
  crush: crushAdapter,
  passthrough: passthroughAdapter,
  pi: piAdapter,
  forgecode: forgeCodeAdapter,
  "claude-code": claudeCodeAdapter,
  claudecode: claudeCodeAdapter,
}

const envDefault = process.env.MERIDIAN_DEFAULT_AGENT || ""
if (envDefault && !ADAPTER_MAP[envDefault]) {
  console.warn(
    `[meridian] Unknown MERIDIAN_DEFAULT_AGENT="${envDefault}". ` +
    `Valid values: ${Object.keys(ADAPTER_MAP).join(", ")}. Falling back to opencode.`
  )
}
const defaultAdapter: AgentAdapter = ADAPTER_MAP[envDefault] ?? openCodeAdapter

/**
 * Detect LiteLLM requests via User-Agent or x-litellm-* headers.
 *
 * LiteLLM's default User-Agent is generic (python-httpx), so header-based
 * detection is more reliable. LiteLLM sends x-litellm-* on regular requests
 * but not on health checks — the User-Agent check catches both.
 */
function isLiteLLMRequest(c: Context): boolean {
  if ((c.req.header("user-agent") || "").startsWith("litellm/")) return true
  const headers = c.req.header()
  return Object.keys(headers).some(k => k.toLowerCase().startsWith("x-litellm-"))
}

/**
 * Detect which agent adapter to use based on request headers.
 *
 * Detection rules (evaluated in order):
 * 1. x-meridian-agent header               → explicit adapter override
 * 2. x-opencode-session or x-session-affinity header → OpenCode adapter
 * 3. User-Agent starts with "opencode/"     → OpenCode adapter
 * 4. User-Agent starts with "factory-cli/"  → Droid adapter
 * 5. User-Agent starts with "Charm-Crush/"  → Crush adapter
 * 6. User-Agent starts with "claude-cli/"  → Claude Code adapter
 * 7. litellm/* UA or x-litellm-* headers   → LiteLLM passthrough adapter
 * 8. Default                                → MERIDIAN_DEFAULT_AGENT env var, or OpenCode
 */
export function detectAdapter(c: Context): AgentAdapter {
  const agentOverride = c.req.header("x-meridian-agent")?.toLowerCase()
  if (agentOverride && ADAPTER_MAP[agentOverride]) {
    return ADAPTER_MAP[agentOverride]!
  }

  // OpenCode: plugin injects x-opencode-session; newer versions use x-session-affinity
  if (c.req.header("x-opencode-session") || c.req.header("x-session-affinity")) {
    return openCodeAdapter
  }

  const userAgent = c.req.header("user-agent") || ""

  // OpenCode User-Agent: opencode/<version>
  if (userAgent.startsWith("opencode/")) {
    return openCodeAdapter
  }

  if (userAgent.startsWith("factory-cli/")) {
    return droidAdapter
  }

  if (userAgent.startsWith("Charm-Crush/")) {
    return crushAdapter
  }

  // Claude Code CLI — `claude-cli/<version>`. Pi (and downstream Pi-based
  // harnesses like pylon) mimic this User-Agent, so when the operator has
  // declared a default via MERIDIAN_DEFAULT_AGENT we treat the env var as
  // the tiebreaker for this ambiguous UA. Other unambiguous UAs
  // (opencode/, factory-cli/, Charm-Crush/) still win over the env default
  // — the env default only resolves the claude-cli collision. Without this,
  // setting MERIDIAN_DEFAULT_AGENT=pi has no effect because the claude-cli
  // matcher fires first for Pi traffic. (Read at call time, not module
  // load, so tests can toggle the env between cases.)
  if (userAgent.startsWith("claude-cli/")) {
    const claudeCliOverride = (process.env.MERIDIAN_DEFAULT_AGENT || "").toLowerCase()
    if (claudeCliOverride && ADAPTER_MAP[claudeCliOverride] && claudeCliOverride !== "claude-code" && claudeCliOverride !== "claudecode") {
      return ADAPTER_MAP[claudeCliOverride]!
    }
    return claudeCodeAdapter
  }

  if (isLiteLLMRequest(c)) {
    return passthroughAdapter
  }

  return defaultAdapter
}
