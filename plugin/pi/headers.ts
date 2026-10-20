import { randomUUID } from "node:crypto"
import type { ProviderHeaders, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai"
import { PRIORITY_ATTESTATION_HEADER, createPriorityAttestation } from "../priority-attestation"

export const PI_AGENT_ID = "pi"
export const SIDE_CALL_SOURCE = "subagent-generate"
const CHILD_SOURCE = "subagent-child"

/**
 * Identity headers Pi's own values replace. A stale provider configuration, an
 * old copy of this extension or another client's plugin may have set them, and
 * any one of them could bind this request to an unrelated conversation.
 */
const IDENTITY_HEADERS = [
  "x-session-affinity",
  "x-opencode-session",
  "x-session-id",
  "x-parent-session-id",
  "x-meridian-source",
  "x-opencode-agent-mode",
  "x-opencode-agent-name",
  PRIORITY_ATTESTATION_HEADER,
] as const

/** The part of Pi's session manager this extension reads. */
export interface HumanTurnSession {
  getSessionId(): string
  getHeader(): { parentSession?: string } | null
  getBranch(): readonly unknown[]
}

export interface RequestState {
  /** Pi's session manager, captured on every `session_start`. */
  session?: HumanTurnSession
  /** `x-meridian-source` for every request of a delegated child process. */
  childSource?: string
}

export function getHeader(headers: ProviderHeaders, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value !== null) return value
  }
  return undefined
}

/** Replace a header case-insensitively. `null` suppresses a provider default of the same name. */
export function setHeader(headers: ProviderHeaders, name: string, value: string | null): void {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) if (key.toLowerCase() === lower) delete headers[key]
  headers[name] = value
}

function hasHeader(headers: ProviderHeaders, name: string): boolean {
  const lower = name.toLowerCase()
  return Object.entries(headers).some(([key, value]) => key.toLowerCase() === lower && value !== null)
}

function safeName(value: string): string | undefined {
  return value.replace(/[^\x20-\x7E]/g, "").trim() || undefined
}

/**
 * `x-meridian-source` for a delegated child Pi process, read once at load.
 *
 * `MERIDIAN_SOURCE` is the neutral convention: a delegation tool sets it on the
 * child's environment, because it cannot inject headers into another process.
 * `PI_SUBAGENT_CHILD` is pi-subagents' own child marker, honored so its
 * children are tiered without changes to that package.
 */
export function childSourceFromEnvironment(env: NodeJS.ProcessEnv): string | undefined {
  const declared = env.MERIDIAN_SOURCE === undefined ? undefined : safeName(env.MERIDIAN_SOURCE)?.slice(0, 64)
  if (declared) return declared
  return env.PI_SUBAGENT_CHILD === "1" ? CHILD_SOURCE : undefined
}

function systemTexts(context: TranscriptContext): string[] {
  return context.messages.flatMap((message) => {
    if (message.role !== "system") return []
    return typeof message.content === "string" ? [message.content] : message.content.map((block) => block.text)
  })
}

/**
 * NOTE: agent-specific (pi) — pi-subagents announces the agent a prompt belongs
 * to with a leading `<active_agent name="…"/>` marker, including for children it
 * runs inside the parent process, where no environment marker exists.
 */
function activeAgentSource(context: TranscriptContext): string | undefined {
  for (const text of systemTexts(context)) {
    const name = text.match(/^<active_agent name="([^"]{1,64})"\/>/)?.[1]
    const safe = name === undefined ? undefined : safeName(name)
    if (safe) return `subagent-${safe}`
  }
  return undefined
}

function latestHumanTurn(branch: readonly unknown[]): { id: string; issuedAt: number } | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]
    if (typeof entry !== "object" || entry === null) continue
    const { type, id, message } = entry as { type?: unknown; id?: unknown; message?: unknown }
    if (type !== "message" || typeof message !== "object" || message === null) continue
    const { role, timestamp } = message as { role?: unknown; timestamp?: unknown }
    if (role !== "user") continue
    if (typeof id !== "string" || typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      return undefined
    }
    return { id, issuedAt: Math.floor(timestamp / 1000) }
  }
  return undefined
}

/**
 * Sign the visible human turn this request belongs to, for Meridian's
 * `next-user-turn` priority failback.
 *
 * Only a root conversation's own requests are eligible: never a fork, a child
 * process, a side call, a request marked with a source, or an explicit profile
 * pin. Anything ambiguous goes unsigned, which keeps normal profile affinity.
 * Meridian re-checks every condition it can see.
 */
function humanTurnAttestation(
  headers: ProviderHeaders,
  sessionId: string,
  state: RequestState,
  key: Buffer | undefined,
): string | undefined {
  const session = state.session
  if (!session || state.childSource !== undefined) return undefined
  if (hasHeader(headers, "x-meridian-source") || hasHeader(headers, "x-meridian-profile")) return undefined
  if (sessionId !== session.getSessionId() || session.getHeader()?.parentSession) return undefined
  const turn = latestHumanTurn(session.getBranch())
  if (!turn) return undefined
  return createPriorityAttestation({
    generation: "pi1",
    sessionId,
    agentId: PI_AGENT_ID,
    humanMessageId: turn.id,
    issuedAt: turn.issuedAt,
  }, key)
}

/**
 * Request options for one Meridian request.
 *
 * Pi calls the provider's `streamSimple` after its `before_provider_headers`
 * hook has run, so this is the final outbound boundary: the headers here are
 * the configured, caller and hook headers combined.
 *
 * Every request is keyed by its own Pi session ID. A request whose session ID
 * is not the current session's (compaction, branch summaries, an extension's
 * one-shot call) is a side call: Pi already gives it a fresh session ID, and the
 * `subagent-generate` source gives it the base model tier. A source another
 * extension declared from `before_provider_headers` wins; delegated children
 * are tiered through theirs.
 */
export function requestOptions(
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  state: RequestState,
  key?: Buffer,
): SimpleStreamOptions {
  const headers: ProviderHeaders = { ...options?.headers }
  const sessionId = options?.sessionId ?? getHeader(headers, "x-session-affinity") ?? randomUUID()
  const declaredSource = getHeader(headers, "x-meridian-source")
  for (const name of IDENTITY_HEADERS) setHeader(headers, name, null)
  setHeader(headers, "x-meridian-agent", PI_AGENT_ID)
  setHeader(headers, "x-session-affinity", sessionId)

  const session = state.session
  const sideCall = session !== undefined && sessionId !== session.getSessionId()
  const source = declaredSource
    ?? state.childSource
    ?? activeAgentSource(context)
    ?? (sideCall ? SIDE_CALL_SOURCE : undefined)
  if (source) setHeader(headers, "x-meridian-source", source)
  if (!getHeader(headers, "x-request-id")) setHeader(headers, "x-request-id", randomUUID())

  const attestation = humanTurnAttestation(headers, sessionId, state, key)
  if (attestation) setHeader(headers, PRIORITY_ATTESTATION_HEADER, attestation)

  return { ...options, headers }
}
