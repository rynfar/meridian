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

/**
 * Detect LiteLLM-style passthrough requests by checking for x-litellm-* headers.
 *
 * LiteLLM sends x-litellm-* headers when configured with a proxy provider.
 * This is the most reliable detection method since LiteLLM's default
 * User-Agent is generic (python-httpx).
 *
 * Note: This detects LiteLLM-style requests, but the adapter is generically
 * named "passthrough" since it describes standard Anthropic API passthrough behavior.
 */
function hasLiteLLMHeaders(c: Context): boolean {
  if ((c.req.header("user-agent") || "").startsWith("litellm/")) return true
  const headers = c.req.header()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith("x-litellm-")) return true
  }
  return false
}

/**
 * Detect which agent adapter to use based on request headers.
 *
 * Detection rules (evaluated in order):
 * 1. User-Agent starts with "factory-cli/"  → Droid adapter
 * 2. User-Agent starts with "Charm-Crush/"  → Crush adapter
 * 3. x-litellm-* headers present             → Passthrough adapter
 * 4. Default                                → OpenCode adapter (backward compatible)
 */
export function detectAdapter(c: Context): AgentAdapter {
  const userAgent = c.req.header("user-agent") || ""

  if (userAgent.startsWith("factory-cli/")) {
    return droidAdapter
  }

  if (userAgent.startsWith("Charm-Crush/")) {
    return crushAdapter
  }

  if (hasLiteLLMHeaders(c)) {
    return passthroughAdapter
  }

  return openCodeAdapter
}
