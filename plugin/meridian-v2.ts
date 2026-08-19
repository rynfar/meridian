/**
 * Meridian OpenCode plugin — **v2 line** (`@opencode-ai/cli@beta`, `opencode2`).
 *
 * The v1 plugin next to this file hooks `chat.headers`. That hook does not
 * exist in opencode v2 at all, so on a v2 client the v1 plugin is inert: no
 * agent tier, and — worse — no chance to fix what v2's core does on its own.
 *
 * What v2's core does: `SessionModelHeaders.make` stamps `x-opencode-session`
 * (plus `x-session-affinity` / `X-Session-Id`) on **every** model request,
 * including the `title` and `summary` one-shots that run inside the parent
 * session and fire in parallel with the user's real turn. Both requests then
 * carry the same session id, both contend for the proxy's per-session turn
 * lease, and the loser — in practice the user's first turn — dies with
 * `400 session_turn_conflict` ("This session advanced while the request was
 * waiting"). Same failure the v1 fix addressed; v2 needs its own hook.
 *
 * This plugin uses v2's `session.model.request` hook, which fires for the
 * one-shots too and may rewrite headers before the request goes out:
 *   1. title/summary → session affinity stripped, `x-meridian-source:
 *      subagent-<name>` added, so the proxy sees an explicitly parallel
 *      stream instead of a contender for the session's turn (and its lineage
 *      fingerprint fallback cannot glue them back onto the session — the
 *      title prompt embeds the conversation's own first message).
 *   2. every request → `x-opencode-agent-name` / `x-opencode-agent-mode`, so
 *      the proxy picks the model tier per agent: primary gets the 1M
 *      variants, subagents the 200k ones.
 *
 * compaction deliberately keeps its session id: the proxy needs it to attach
 * the compaction to the lineage and already exempts it from the conflict
 * check.
 *
 * Install (opencode v2) — add to ~/.config/opencode/opencode.json:
 *   { "plugin": ["/absolute/path/to/plugin/meridian-v2.ts"] }
 */

/** Providers that point at a Meridian endpoint in practice. */
const MERIDIAN_PROVIDERS = new Set(["anthropic", "meridian"])

/**
 * Modes of v2's built-in agents. Used when the agent lookup can't answer — a
 * miss must not silently promote a subagent to the 1M tier.
 */
const BUILTIN_AGENT_MODES: Record<string, string> = {
  build: "primary",
  plan: "primary",
  general: "subagent",
  explore: "subagent",
  title: "subagent",
  summary: "subagent",
  compaction: "subagent",
}

/** Utilities v2 runs inside the PARENT session, concurrently with its turn. */
const PARENT_SESSION_ONE_SHOTS = new Set(["title", "summary"])

/**
 * Header names that bind a request to a session. Spelled here exactly as
 * `SessionModelHeaders.make` writes them — the hook hands over a plain
 * record, so a case that does not match is a header left behind.
 */
const SESSION_AFFINITY_HEADERS = [
  "x-opencode-session",
  "x-session-affinity",
  "X-Session-Id",
  "x-parent-session-id",
]

interface ModelRequest {
  sessionID: string
  agent: string
  model: { providerID?: string }
  headers: Record<string, string>
}

export default {
  id: "meridian",
  setup(context: any) {
    const resolveMode = async (agent: string): Promise<string> => {
      try {
        // v2 takes an object and answers { location, data: Agent.Info }.
        const info = await context.agent?.get?.({ agentID: agent })
        const mode = info?.data?.mode ?? info?.mode
        if (typeof mode === "string") return mode
      } catch {
        // An agent the runtime cannot describe falls back to the table below.
      }
      return BUILTIN_AGENT_MODES[agent] ?? "primary"
    }

    return context.session.hook("model.request", async (input: ModelRequest) => {
      if (!MERIDIAN_PROVIDERS.has(String(input.model?.providerID ?? ""))) return

      const raw = String(input.agent ?? "")
      // The built-ins arrive under exactly these names. A user-defined agent
      // that merely sanitizes to the same name is distinct and keeps affinity.
      const isOneShot = PARENT_SESSION_ONE_SHOTS.has(raw)
      const mode = (await resolveMode(raw)) === "subagent" ? "subagent" : "primary"

      // Strip non-ASCII characters (zero-width spaces and the like) only at
      // the header boundary, where undici otherwise rejects the request.
      const name = raw.replace(/[^\x20-\x7E]/g, "").trim() || "unknown"

      if (isOneShot) {
        for (const header of SESSION_AFFINITY_HEADERS) delete input.headers[header]
        input.headers["x-meridian-source"] = `subagent-${name}`
      } else {
        // Core already sets this; restated so the header is present even if a
        // future core stops stamping it, and so the value is the one this
        // hook was handed rather than whatever survived another plugin.
        input.headers["x-opencode-session"] = String(input.sessionID)
      }

      input.headers["x-opencode-agent-name"] = name
      input.headers["x-opencode-agent-mode"] = mode
    })
  },
}
