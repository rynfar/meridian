/**
 * OpenCode plugin — subagent model selection for Meridian.
 *
 * Sends an x-opencode-agent-mode header with every Anthropic API request so
 * Meridian can pick the right context window tier:
 *
 *   - Primary agents  → sonnet[1m] / opus[1m]  (full 1M context)
 *   - Subagents       → sonnet / opus           (200k, saves rate limit budget)
 *
 * OpenCode passes the full agent object (with a .mode field) to the
 * chat.headers hook at runtime, even though the TypeScript type declares
 * `agent` as `string`. We read .mode directly — no API calls needed.
 *
 * Usage — add to opencode.json:
 *   { "plugin": ["./meridian-agent-mode.ts"] }
 *
 * Or combine with the session headers plugin:
 *   { "plugin": ["./claude-max-headers.ts", "./meridian-agent-mode.ts"] }
 */

type Plugin = (input: any) => Promise<{
  "chat.headers"?: (
    input: {
      sessionID: string
      // Typed as string in the SDK types but is actually the full agent object
      // at runtime: { name: string; mode: "primary" | "subagent" | "all" }
      agent: string | { name: string; mode: string }
      model: { providerID: string }
    },
    output: { headers: Record<string, string> }
  ) => Promise<void>
}>

const MeridianAgentModePlugin: Plugin = async () => {
  return {
    "chat.headers": async (incoming, output) => {
      if (incoming.model.providerID !== "anthropic") return

      // The runtime value is the full agent object — cast to read .mode
      const agent = incoming.agent as { name?: string; mode?: string } | string
      const mode = typeof agent === "object" ? (agent.mode ?? "primary") : "primary"
      const name = typeof agent === "object" ? (agent.name ?? "unknown") : String(agent)

      output.headers["x-opencode-agent-mode"] = mode
      output.headers["x-opencode-agent-name"] = name
    },
  }
}

export default MeridianAgentModePlugin
