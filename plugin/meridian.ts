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

import {
  PRIORITY_ATTESTATION_HEADER,
  createPriorityAttestation,
  deleteHeader,
  getHeader,
  setHeader,
} from "./priority-attestation"

type AgentInput = string | { name?: string; mode?: string; hidden?: boolean }
type ConfigAgent = { mode?: string; hidden?: boolean }

type Plugin = (input: any) => Promise<{
  config?: (cfg: { agent?: Record<string, ConfigAgent | undefined> }) => Promise<void> | void
  "chat.headers"?: (
    input: {
      sessionID: string
      // Older OpenCode versions pass the full agent object
      // ({ name, mode: "primary" | "subagent" | "all" }); OpenCode >= 1.17
      // passes just the agent NAME as a string. Handle both.
      agent: AgentInput
      model: { providerID: string }
      message: { id: string; sessionID?: string; time?: { created?: number } }
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

const INTERNAL_AGENT_IDS = new Set(["title", "summary", "compaction"])
const ROOT_SESSION_CACHE_MAX = 256
const ROOT_SESSION_CACHE_TTL_MS = 5_000
const LOOKUP_TIMEOUT_MS = 250

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function withTimeout<T>(pending: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([pending, timedOut])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const MeridianPlugin: Plugin = async (pluginInput) => {
  // Agent traits from the merged config, per plugin instance. Replaced
  // wholesale on reload so routing eligibility cannot use stale visibility.
  let configAgents: Record<string, ConfigAgent> = {}
  const rootSessionCache = new Map<string, { expiresAt: number; pending: Promise<boolean> }>()

  const resolve = (agent: AgentInput): { name: string; mode: string } => {
    if (typeof agent === "object" && agent !== null) {
      // Legacy runtime shape: full agent object with an explicit mode.
      return { name: agent.name ?? "unknown", mode: agent.mode ?? "primary" }
    }
    // OpenCode >= 1.17: agent is the name string. Resolve the mode from the
    // merged config (captured in the config hook) + built-in defaults.
    const name = String(agent)
    return { name, mode: configAgents[name]?.mode ?? BUILTIN_AGENT_MODES[name] ?? "primary" }
  }

  const isStrictVisiblePrimary = (agent: AgentInput): boolean => {
    const name = typeof agent === "string" ? agent : agent.name
    if (!name || INTERNAL_AGENT_IDS.has(name)) return false
    if (typeof agent === "object") {
      return agent.mode === "primary" && agent.hidden !== true
    }
    const configured = configAgents[name]
    if (configured) return configured.mode === "primary" && configured.hidden !== true
    return BUILTIN_AGENT_MODES[name] === "primary"
  }

  const isRootSession = async (sessionID: string): Promise<boolean> => {
    const cached = rootSessionCache.get(sessionID)
    if (cached && cached.expiresAt > Date.now()) return cached.pending
    const pending = (async (): Promise<boolean> => {
      if (!isRecord(pluginInput) || !isRecord(pluginInput.client)) return false
      const sessionApi = pluginInput.client.session
      if (!isRecord(sessionApi) || typeof sessionApi.get !== "function") return false
      const controller = new AbortController()
      try {
        const lookup = Promise.resolve(Reflect.apply(sessionApi.get, sessionApi, [
          { path: { id: sessionID }, signal: controller.signal },
        ]) as unknown)
        const result = await withTimeout(lookup, LOOKUP_TIMEOUT_MS)
        if (!isRecord(result)) return false
        const data = isRecord(result.data) ? result.data : result
        return data.id === sessionID && data.parentID === undefined && data.fork === undefined
      } catch {
        return false
      } finally {
        controller.abort()
      }
    })()
    rootSessionCache.delete(sessionID)
    rootSessionCache.set(sessionID, { expiresAt: Date.now() + ROOT_SESSION_CACHE_TTL_MS, pending })
    while (rootSessionCache.size > ROOT_SESSION_CACHE_MAX) {
      const oldest = rootSessionCache.keys().next().value
      if (oldest === undefined) break
      rootSessionCache.delete(oldest)
    }
    const eligible = await pending
    if (!eligible && rootSessionCache.get(sessionID)?.pending === pending) rootSessionCache.delete(sessionID)
    return eligible
  }

  return {
    // Runs with the merged OpenCode config (on init, and again on config
    // reload). Captures user-defined agents and built-in overrides.
    config: (cfg) => {
      const next: Record<string, ConfigAgent> = {}
      for (const [name, def] of Object.entries(cfg?.agent ?? {})) {
        if (!def) continue
        next[name] = {
          ...(typeof def.mode === "string" ? { mode: def.mode } : {}),
          ...(typeof def.hidden === "boolean" ? { hidden: def.hidden } : {}),
        }
      }
      configAgents = next
    },

    "chat.headers": async (incoming, output) => {
      // This is V1's final supported outbound boundary. Remove an earlier
      // plugin/provider spoof even when this request is not eligible.
      deleteHeader(output.headers, PRIORITY_ATTESTATION_HEADER)
      // Only inject headers for Anthropic provider requests.
      if (incoming.model.providerID !== "anthropic") return

      // Session tracking. Replace case-insensitively so the values compared by
      // the proxy are the same trusted hook inputs that are signed below.
      setHeader(output.headers, "x-opencode-session", incoming.sessionID)
      setHeader(output.headers, "x-opencode-request", incoming.message.id)

      const { name, mode } = resolve(incoming.agent)
      const safeName = name.replace(/[^\x20-\x7E]/g, "").trim() || "unknown"

      // The proxy expects primary|subagent. "all" agents can act as either;
      // without per-request context, treat them as primary (full tier) to
      // preserve capability. This permissive tiering decision is NOT reused as
      // strict routing eligibility.
      setHeader(output.headers, "x-opencode-agent-mode", mode === "subagent" ? "subagent" : "primary")
      // Strip non-ASCII characters (e.g. zero-width spaces) that cause
      // "Header has invalid value" errors in Node.js / undici.
      setHeader(output.headers, "x-opencode-agent-name", safeName)

      if (getHeader(output.headers, "x-meridian-profile") !== undefined) return
      if (safeName !== name || !isStrictVisiblePrimary(incoming.agent)) return
      const createdAt = incoming.message.time?.created
      if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0) return
      const issuedAt = Math.floor(createdAt / 1000)
      if (incoming.message.sessionID !== undefined && incoming.message.sessionID !== incoming.sessionID) return
      if (!(await isRootSession(incoming.sessionID))) return
      // A config reload can complete while the bounded root lookup is in
      // flight. Re-check visibility at the final signing instant.
      if (!isStrictVisiblePrimary(incoming.agent)) return
      const token = createPriorityAttestation({
        generation: "oc1",
        sessionId: incoming.sessionID,
        agentId: safeName,
        humanMessageId: incoming.message.id,
        issuedAt,
      })
      if (token) setHeader(output.headers, PRIORITY_ATTESTATION_HEADER, token)
    },
  }
}

export default MeridianPlugin
