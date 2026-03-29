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

/**
 * Detect which agent adapter to use based on request headers.
 *
 * Detection rules (evaluated in order):
 * 1. User-Agent starts with "factory-cli/" → Droid adapter
 * 2. Default → OpenCode adapter (backward compatible)
 */
export function detectAdapter(c: Context): AgentAdapter {
  const userAgent = c.req.header("user-agent") || ""

  if (userAgent.startsWith("factory-cli/")) {
    return droidAdapter
  }

  return openCodeAdapter
}
