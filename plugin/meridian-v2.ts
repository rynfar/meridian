/**
 * Meridian OpenCode plugin for the V2 beta line.
 *
 * OpenCode V2 runs hidden title and summary requests in the parent session,
 * often in parallel with the visible first turn. V2's core gives all of those
 * requests the same session-affinity headers. Meridian must detach the hidden
 * one-shots before they reach the proxy or they can advance the visible
 * conversation's durable lineage.
 *
 * The model hook applies the identity as early as V2 permits. The HTTP hook
 * enforces it again at the final request boundary. This removes stale or
 * spoofed control headers regardless of header casing.
 *
 * NOTE: OpenCode-specific. Keep this separate from plugin/meridian.ts: V1
 * expects a default plugin function and V2 expects a Plugin.define() object.
 */

import * as Plugin from "@opencode-ai/plugin/promise/plugin"

/** Exact V2 host used to compile and validate this beta-only integration. */
export const SUPPORTED_OPENCODE_V2_VERSION = "0.0.0-beta-18314"

const MERIDIAN_PROVIDERS = new Set(["anthropic", "meridian"])
const PARENT_SESSION_ONE_SHOTS = new Set(["title", "summary"])
const ATTACHED_COMPACTION_AGENT = "compaction"

const SESSION_AFFINITY_HEADERS = [
  "x-opencode-session",
  "x-session-affinity",
  "x-session-id",
  "x-parent-session-id",
] as const

const MERIDIAN_CONTROL_HEADERS = [
  "x-meridian-source",
  "x-opencode-agent-name",
  "x-opencode-agent-mode",
] as const

export interface AgentTraits {
  mode: "primary" | "subagent"
  hidden: boolean
}

const BUILTIN_AGENT_TRAITS: Record<string, AgentTraits> = {
  build: { mode: "primary", hidden: false },
  plan: { mode: "primary", hidden: false },
  general: { mode: "subagent", hidden: false },
  explore: { mode: "subagent", hidden: false },
  // Exact beta-18314 defines all three hidden internal agents as primary.
  title: { mode: "primary", hidden: true },
  summary: { mode: "primary", hidden: true },
  compaction: { mode: "primary", hidden: true },
}

export function fallbackAgentTraits(agent: string): AgentTraits {
  return BUILTIN_AGENT_TRAITS[agent] ?? { mode: "primary", hidden: false }
}

type MutableHeaders = Record<string, string> | Headers

function deleteHeader(headers: MutableHeaders, name: string): void {
  if (headers instanceof Headers) {
    headers.delete(name)
    return
  }
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key]
  }
}

function setHeader(headers: MutableHeaders, name: string, value: string): void {
  deleteHeader(headers, name)
  if (headers instanceof Headers) headers.set(name, value)
  else headers[name] = value
}

function safeAgentName(agent: string): string {
  return agent.replace(/[^\x20-\x7E]/g, "").trim() || "unknown"
}

export function shouldDetachFromParentSession(agent: string, _traits: AgentTraits): boolean {
  // The exact built-in ID is authoritative. `hidden` is presentation config:
  // making the built-in visible does not stop V2 from running its parent-
  // session title/summary job concurrently with the primary turn.
  return PARENT_SESSION_ONE_SHOTS.has(agent)
}

/**
 * Rewrite one V2 request's identity without changing its body or model input.
 * This pure helper is shared by model.request and http.request.
 */
export function applyMeridianV2Headers(
  headers: MutableHeaders,
  input: { sessionID: string; agent: string; traits: AgentTraits },
): void {
  for (const name of SESSION_AFFINITY_HEADERS) deleteHeader(headers, name)
  for (const name of MERIDIAN_CONTROL_HEADERS) deleteHeader(headers, name)

  const name = safeAgentName(input.agent)
  const detached = shouldDetachFromParentSession(input.agent, input.traits)

  if (detached) {
    setHeader(headers, "x-meridian-source", `subagent-${name}`)
  } else {
    // Set every V2 affinity spelling from the trusted hook input. Do not retain
    // provider-config values that can bind this request to another session.
    setHeader(headers, "x-opencode-session", input.sessionID)
    setHeader(headers, "x-session-affinity", input.sessionID)
    setHeader(headers, "x-session-id", input.sessionID)
    if (input.agent === ATTACHED_COMPACTION_AGENT) {
      // Source selects the base model tier without making the adapter append
      // `#compaction` to the primary session key.
      setHeader(headers, "x-meridian-source", "subagent-compaction")
    }
  }

  const internalMode = PARENT_SESSION_ONE_SHOTS.has(input.agent)
    ? "subagent"
    : input.agent === ATTACHED_COMPACTION_AGENT ? "primary" : input.traits.mode
  setHeader(headers, "x-opencode-agent-name", name)
  setHeader(headers, "x-opencode-agent-mode", internalMode)
}

const MeridianV2Plugin = Plugin.define({
  id: "meridian",
  setup: async (context) => {
    const traitsByAgent = new Map<string, {
      expiresAt: number
      pending: Promise<AgentTraits>
    }>()
    const registered: Array<{ dispose: () => Promise<void> }> = []

    const resolveAgentTraits = (agent: string): Promise<AgentTraits> => {
      const cached = traitsByAgent.get(agent)
      if (cached && cached.expiresAt > Date.now()) return cached.pending

      const pending = Promise.resolve()
        .then(() => context.agent.get({ agentID: agent }))
        .then(({ data }) => ({
          mode: data.mode === "subagent" ? "subagent" as const : "primary" as const,
          hidden: data.hidden,
        }))
        .catch(() => {
          // A transient lookup failure must not permanently promote a custom
          // child to primary. Retry at the final HTTP boundary or next turn.
          if (traitsByAgent.get(agent)?.pending === pending) traitsByAgent.delete(agent)
          return fallbackAgentTraits(agent)
        })
      traitsByAgent.set(agent, { expiresAt: Date.now() + 5_000, pending })
      return pending
    }

    const apply = async (
      input: { sessionID: string; agent: string; model: { providerID: string } },
      headers: MutableHeaders,
    ): Promise<void> => {
      if (!MERIDIAN_PROVIDERS.has(String(input.model.providerID))) return
      const agent = String(input.agent)
      applyMeridianV2Headers(headers, {
        sessionID: String(input.sessionID),
        agent,
        traits: await resolveAgentTraits(agent),
      })
    }

    try {
      for (const providerID of MERIDIAN_PROVIDERS) {
        registered.push(await context.session.hook("model.request", async (input) => {
          await apply(input, input.headers)
        }, { providerID }))
        registered.push(await context.session.hook("http.request", async (input) => {
          await apply(input, input.request.headers)
        }, { providerID }))
      }
    } catch (error) {
      await Promise.allSettled(registered.map(({ dispose }) => dispose()))
      throw error
    }

    return async () => {
      const results = await Promise.allSettled(registered.map(({ dispose }) => dispose()))
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, "Failed to dispose Meridian V2 hooks")
    }
  },
})

export default MeridianV2Plugin
