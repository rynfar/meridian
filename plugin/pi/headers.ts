import { randomUUID } from "node:crypto"
import type { ProviderHeaders, SimpleStreamOptions, SystemMessage, TranscriptContext } from "@earendil-works/pi-ai"
import { PRIORITY_ATTESTATION_HEADER, createPriorityAttestation } from "../priority-attestation"

export const PI_AGENT_ID = "pi"
/**
 * `x-meridian-source` for a side call, which Pi already keys apart from the
 * conversation. Like any source it is never signed. A `fork-` source avoids
 * the subagent tier: a compaction request carries the history it summarizes,
 * so it needs the conversation's context window (1M for Opus and Fable, whose
 * subagent tier is 200k).
 */
export const SIDE_CALL_SOURCE = "fork-side-call"
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

const ACTIVE_AGENT_MARKER = /^<active_agent name="([^"]{1,64})"\/>/
const ADDENDUM_OPEN = "<addendum>\n"
const ADDENDUM_CLOSE = "\n</addendum>"
/**
 * Sections Pi renders after `<addendum>` (core/system-prompt.js). A flattened
 * prompt whose first addendum tag follows one of them is quoting the layout,
 * for example in AGENTS.md, and is not Pi's own addendum.
 */
const SECTIONS_AFTER_ADDENDUM = ["project_context", "skills", "cwd"]

/**
 * pi-subagents passes the agent's tagged prompt as a child's only appended
 * prompt (it replaces APPEND_SYSTEM.md), so the marker opens the addendum. A
 * later paragraph is the root session's own text, never a marker.
 */
function addendumMarker(addendum: string): string | undefined {
  return addendum.replace(/^(?:\r?\n)+/, "").match(ACTIVE_AGENT_MARKER)?.[1]
}

/** A forced prompt is one flat string: the marker leads it, or opens its addendum. */
function flattenedMarker(text: string): string | undefined {
  const leading = text.match(ACTIVE_AGENT_MARKER)?.[1]
  if (leading !== undefined) return leading
  const open = text.indexOf(`\n\n${ADDENDUM_OPEN}`)
  if (open < 0) return undefined
  const quoted = SECTIONS_AFTER_ADDENDUM.some((name) => {
    const index = text.indexOf(`\n\n<${name}>\n`)
    return index >= 0 && index < open
  })
  if (quoted) return undefined
  const start = open + 2 + ADDENDUM_OPEN.length
  const close = text.indexOf(ADDENDUM_CLOSE, start)
  return close < 0 ? undefined : addendumMarker(text.slice(start, close))
}

/** A structured prompt keeps the replacing prompt in `preamble` and each tag in its own section. */
function sectionsMarker(sections: Record<string, string | null>): string | undefined {
  const preamble = sections.preamble?.match(ACTIVE_AGENT_MARKER)?.[1]
  if (preamble !== undefined) return preamble
  const addendum = sections.addendum
  if (!addendum?.startsWith(ADDENDUM_OPEN) || !addendum.endsWith(ADDENDUM_CLOSE)) return undefined
  return addendumMarker(addendum.slice(ADDENDUM_OPEN.length, -ADDENDUM_CLOSE.length))
}

function activeAgentName(message: SystemMessage): string | undefined {
  const texts = typeof message.content === "string" ? [message.content] : message.content.map((block) => block.text)
  for (const text of texts) {
    const name = flattenedMarker(text)
    if (name !== undefined) return name
  }
  return message.sections ? sectionsMarker(message.sections) : undefined
}

/**
 * NOTE: agent-specific (pi) — pi-subagents announces the agent a prompt belongs
 * to with an `<active_agent name="…"/>` marker at the start of the agent's
 * prompt, including for children it runs inside the parent process, where no
 * environment marker exists. An agent whose prompt replaces Pi's leads the
 * system prompt with it; one that appends (the builtin `delegate`, for one)
 * leads Pi's `<addendum>` section. Pi sends the prompt either as
 * structured sections or, when an extension forces it, as one flat string.
 */
function activeAgentSource(context: TranscriptContext): string | undefined {
  for (const message of context.messages) {
    if (message.role !== "system") continue
    const name = activeAgentName(message)
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
 * `fork-side-call` source marks it independent of the conversation while
 * keeping the conversation's model tier. A source another
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
