/**
 * Meridian OpenCode plugin.
 *
 * Injects headers into every Anthropic API request so the proxy can:
 *   1. Track sessions reliably (x-opencode-session / x-opencode-request)
 *   2. Select the right model tier per agent (x-opencode-agent-mode)
 *      — primary agents get sonnet[1m] / opus[1m] (full 1M context)
 *      — subagents get sonnet / opus (200k, preserves rate-limit budget)
 *
 * Install once globally:
 *   meridian setup
 *
 * Or manually add to ~/.config/opencode/opencode.json:
 *   { "plugin": ["/absolute/path/to/plugin/meridian.ts"] }
 */

type AgentInput = string | { name?: string; mode?: string }

type Plugin = (input: any) => Promise<{
  config?: (cfg: { agent?: Record<string, { mode?: string } | undefined> }) => Promise<void> | void
  "chat.headers"?: (
    input: {
      sessionID: string
      // Older OpenCode versions pass the full agent object
      // ({ name, mode: "primary" | "subagent" | "all" }); OpenCode >= 1.17
      // passes just the agent NAME as a string. Handle both.
      agent: AgentInput
      model: { providerID: string }
      message: { id: string }
    },
    output: { headers: Record<string, string> }
  ) => Promise<void>
}>

/**
 * Modes of OpenCode's built-in agents (they are not listed in the merged
 * config unless the user overrides them, so the `config` hook alone can't
 * see them). User-defined agents and built-in overrides are layered on top
 * from the config hook.
 */
const BUILTIN_AGENT_MODES: Record<string, string> = {
  build: "primary",
  plan: "primary",
  general: "subagent",
  explore: "subagent",
  // Hidden internal agents. These usually route to small_model (a
  // non-Anthropic provider) but are mapped defensively.
  title: "subagent",
  summary: "subagent",
  compaction: "subagent",
}

const MeridianPlugin: Plugin = async () => {
  // Modes from the merged config, per plugin instance. Replaced wholesale on
  // every config-hook fire so a reload can't leave stale entries behind.
  let configModes: Record<string, string> = {}

  const resolve = (agent: AgentInput): { name: string; mode: string } => {
    if (typeof agent === "object" && agent !== null) {
      // Legacy runtime shape: full agent object with an explicit mode.
      return { name: agent.name ?? "unknown", mode: agent.mode ?? "primary" }
    }
    // OpenCode >= 1.17: agent is the name string. Resolve the mode from the
    // merged config (captured in the config hook) + built-in defaults.
    const name = String(agent)
    return { name, mode: configModes[name] ?? BUILTIN_AGENT_MODES[name] ?? "primary" }
  }

  return {
    // Runs with the merged OpenCode config (on init, and again on config
    // reload). Captures the mode of user-defined agents and built-in
    // overrides so chat.headers can classify string agent names.
    config: (cfg) => {
      const next: Record<string, string> = {}
      for (const [name, def] of Object.entries(cfg?.agent ?? {})) {
        if (typeof def?.mode === "string") next[name] = def.mode
      }
      configModes = next
    },

    "chat.headers": async (incoming, output) => {
      // Only inject headers for Anthropic provider requests
      if (incoming.model.providerID !== "anthropic") return

      // Session tracking
      output.headers["x-opencode-session"] = incoming.sessionID
      output.headers["x-opencode-request"] = incoming.message.id

      const { name, mode } = resolve(incoming.agent)

      // The proxy expects primary|subagent. "all" agents can act as either;
      // without per-request context, treat them as primary (full tier) to
      // preserve capability.
      output.headers["x-opencode-agent-mode"] = mode === "subagent" ? "subagent" : "primary"
      // Strip non-ASCII characters (e.g. zero-width spaces) that cause
      // "Header has invalid value" errors in Node.js / undici.
      output.headers["x-opencode-agent-name"] = name.replace(/[^\x20-\x7E]/g, "").trim() || "unknown"
    },
  }
}

export default MeridianPlugin
