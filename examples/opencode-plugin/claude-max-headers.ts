/**
 * OpenCode plugin — reference implementation.
 *
 * Injects session tracking headers into Anthropic API requests so the
 * proxy can reliably map OpenCode sessions to Claude SDK sessions.
 *
 * This is a minimal example. For a full-featured OpenCode plugin with
 * automatic proxy lifecycle management, see:
 *   https://github.com/ianjwhite99/opencode-meridian
 *
 * Usage:
 *   Copy this file into your project and add to opencode.json:
 *     { "plugin": ["./claude-max-headers.ts"] }
 *
 * Without this plugin:
 *   The proxy falls back to fingerprint-based session matching (hashing
 *   the first user message + working directory). This works but is less
 *   reliable for session resume.
 *
 * See the Programmatic API section in the README for the full plugin contract.
 */

type ChatHeadersHook = (
  incoming: {
    sessionID: string
    agent: any
    model: { providerID: string }
    provider: any
    message: { id: string }
  },
  output: { headers: Record<string, string> }
) => Promise<void>

type PluginHooks = {
  "chat.headers"?: ChatHeadersHook
}

type PluginFn = (input: any) => Promise<PluginHooks>

export const ClaudeMaxHeadersPlugin: PluginFn = async (_input) => {
  return {
    "chat.headers": async (incoming, output) => {
      // Only inject headers for Anthropic provider requests
      if (incoming.model.providerID !== "anthropic") return

      output.headers["x-opencode-session"] = incoming.sessionID
      output.headers["x-opencode-request"] = incoming.message.id
    },
  }
}

export default ClaudeMaxHeadersPlugin
