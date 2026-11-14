/**
 * Interrupted turns: pure decisions for a turn the client stopped mid-stream.
 *
 * Every resume writes an isolated fork, so a stopped turn's source session
 * still ends at the last completed turn. Whether it may be resumed depends on
 * what the client did with the partial output, which only its next request
 * shows. The rule, its storage and its limits are in the session spec,
 * *Interrupted turns*. State lives in `cache.ts`; orchestration in
 * `server.ts`. Pure module: no I/O, no cache/server imports.
 */

import { computeLineageHash, hashMessage, type LineageResult, type SessionState } from "./lineage"

type LineageMessage = { role: string; content: any }

/**
 * A stopped turn recorded against the session it resumed: what the next
 * request needs to decide whether that session may be resumed.
 */
export interface InterruptedTurn {
  /** Messages the session was published with: its lineage prefix. */
  readonly prefixCount: number
  /** Lineage hash of that prefix, the SDK reuse proof. */
  readonly lineageHash: string
  /** The reply the session already holds: the assistant messages the
   *  stopped request carried after the prefix, before its first user one. */
  readonly replyHashes: readonly string[]
  /** tool_use ids in that reply; user content may answer only these. */
  readonly replyToolUseIds: readonly string[]
}

/** The session a resumed turn read: what the interrupted-turn record keeps. */
export interface InterruptedSessionSource {
  readonly claudeSessionId: string
  readonly messageCount: number
  /** The SDK reuse proof the turn resumed with. */
  readonly lineageHash: string
}

/** A stopped turn's record, before the turn is stopped. */
export interface InterruptCandidate {
  readonly source: InterruptedSessionSource
  readonly turn: InterruptedTurn
}

/** Why the next request after a stopped turn must replay fresh. */
export type InterruptedTurnReplayReason =
  /** The stored prefix no longer matches: an earlier message was edited. */
  | "prefix-changed"
  /** The reply the session holds was altered or dropped. */
  | "reply-changed"
  /** Assistant content follows that reply: the client kept the partial turn. */
  | "kept-assistant"
  /** Nothing follows the reply for the session to answer. */
  | "no-user-turn"
  /** User content answers a tool call the session never made. */
  | "unknown-tool-result"

export type InterruptedTurnDecision =
  | { readonly resume: true }
  | { readonly resume: false; readonly reason: InterruptedTurnReplayReason }

function toolUseIds(messages: ReadonlyArray<LineageMessage>): string[] {
  return messages.flatMap((message) => Array.isArray(message.content)
    ? message.content.flatMap((block: any) =>
      block?.type === "tool_use" && typeof block.id === "string" ? [block.id] : [])
    : [])
}

/**
 * Record the request a client stopped, against the session it resumed from
 * `prefixCount`. Undefined when the request is not that shape: a reply the
 * session holds, then user-side content only. A request that already carried
 * assistant turns the session never wrote is not kept.
 */
export function interruptedTurnOf(
  messages: ReadonlyArray<LineageMessage>,
  prefixCount: number,
  lineageHash: string,
): InterruptedTurn | undefined {
  if (!Number.isSafeInteger(prefixCount) || prefixCount <= 0 || !lineageHash) return undefined
  if (messages.length <= prefixCount) return undefined
  const delta = messages.slice(prefixCount)
  const firstUser = delta.findIndex((message) => message.role === "user")
  if (firstUser < 0) return undefined
  if (delta.slice(firstUser).some((message) => message.role === "assistant")) return undefined
  const reply = delta.slice(0, firstUser)
  return {
    prefixCount,
    lineageHash,
    replyHashes: reply.map(hashMessage),
    replyToolUseIds: toolUseIds(reply),
  }
}

/**
 * Decide the request that follows a stopped turn. Resume only when it keeps
 * the stored prefix and the session's own reply intact and adds only user-side
 * content after them: then the client discarded the partial output, and the
 * resumed session holds exactly what the client holds. Any assistant message
 * after the reply — text, thinking, a tool call, or an empty one — means the
 * client kept the partial, which the session never received, so the request
 * must replay; resuming would let the model and the client diverge silently.
 */
export function classifyInterruptedContinuation(
  turn: InterruptedTurn,
  messages: ReadonlyArray<LineageMessage>,
): InterruptedTurnDecision {
  if (
    messages.length <= turn.prefixCount
    || computeLineageHash(messages.slice(0, turn.prefixCount)) !== turn.lineageHash
  ) return { resume: false, reason: "prefix-changed" }
  const replyEnd = turn.prefixCount + turn.replyHashes.length
  if (messages.length < replyEnd) return { resume: false, reason: "reply-changed" }
  for (let index = 0; index < turn.replyHashes.length; index++) {
    if (hashMessage(messages[turn.prefixCount + index]!) !== turn.replyHashes[index]) {
      return { resume: false, reason: "reply-changed" }
    }
  }
  const added = messages.slice(replyEnd)
  if (added.some((message) => message.role === "assistant")) return { resume: false, reason: "kept-assistant" }
  if (!added.some((message) => message.role === "user")) return { resume: false, reason: "no-user-turn" }
  const answerable = new Set(turn.replyToolUseIds)
  for (const message of added) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type !== "tool_result") continue
      if (typeof block.tool_use_id !== "string" || !answerable.has(block.tool_use_id)) {
        return { resume: false, reason: "unknown-tool-result" }
      }
    }
  }
  return { resume: true }
}

/**
 * The record a turn would leave if the client stopped it mid-stream: only a
 * plain continuation that resumes exactly the published session it read.
 * Side requests and priority publications keep their own abort handling.
 */
export function interruptCandidateOf(input: {
  /** An independent or auxiliary request: not a turn of the conversation. */
  readonly sideRequest: boolean
  readonly priorityPublication: boolean
  readonly lineage: LineageResult
  readonly isResume: boolean
  readonly resumeSessionId: string | undefined
  readonly messages: ReadonlyArray<LineageMessage>
}): InterruptCandidate | undefined {
  if (input.sideRequest || input.priorityPublication) return undefined
  const lineage = input.lineage
  if (lineage.type !== "continuation" || lineage.resumeContentFrom !== undefined) return undefined
  // A realigned session's count and proof are in incoming positions, which
  // the durable mapping the marking keeps does not hold (session spec,
  // *Regrouped user messages*): a stopped regrouped turn evicts, as main's
  // fresh replay of the same turn would.
  if (lineage.regrouped) return undefined
  const session = lineage.session
  if (!input.isResume || input.resumeSessionId !== session.claudeSessionId) return undefined
  if (!session.lineageHash || lineage.resumeFrom !== session.messageCount) return undefined
  const turn = interruptedTurnOf(input.messages, session.messageCount, session.lineageHash)
  return turn ? {
    source: { claudeSessionId: session.claudeSessionId, messageCount: session.messageCount, lineageHash: session.lineageHash },
    turn,
  } : undefined
}

/**
 * Whether the turn's managed fork still copies the session its candidate was
 * recorded for. A retry that switched to a fresh target, or a fork the SDK
 * replaced, is not that session's continuation.
 */
export function forkStillCopiesCandidate(input: {
  readonly candidate: InterruptCandidate | undefined
  readonly freshTarget: boolean
  readonly superseded: boolean
  readonly forkSourceSessionId: string | undefined
}): boolean {
  return input.candidate !== undefined && !input.freshTarget && !input.superseded
    && input.forkSourceSessionId === input.candidate.source.claudeSessionId
}

/**
 * What an interrupted streaming turn does with the mapping it resumed.
 *
 * - `evict`: the turn may have moved the mapped transcript (no managed fork,
 *   or its fork was published), or the client saw output it may hold and the
 *   turn cannot be checked later, so the next request replays.
 * - `preserve`: nothing reached the client, so the mapping is left as it was.
 * - `interrupt`: the client itself stopped the turn after text or thinking
 *   reached it and before any tool call did. The source mapping is kept but
 *   marked interrupted, and the next request resumes it only if it adds
 *   nothing but user content (`classifyInterruptedContinuation`).
 *
 * Every other abort cause, an explicit subtree cancel included, evicts as
 * before (see ARCHITECTURE.md, Cancellation Contract).
 */
export type InterruptedMappingAction = "evict" | "preserve" | "interrupt"

export function interruptedMappingAction(input: {
  readonly managedFork: boolean
  readonly managedForkPublished: boolean
  readonly clientAssistantContentExposed: boolean
  /** A tool_use block reached the client. */
  readonly clientToolUseExposed: boolean
  /** The turn has a candidate record and its fork still copies that session. */
  readonly interruptible: boolean
  /** The client's own disconnect or body cancel aborted the turn. */
  readonly clientStopped: boolean
}): InterruptedMappingAction {
  if (!input.managedFork || input.managedForkPublished) return "evict"
  if (!input.clientAssistantContentExposed) return "preserve"
  if (input.clientToolUseExposed || !input.interruptible) return "evict"
  return input.clientStopped ? "interrupt" : "evict"
}

/** A record taken for the next request: see `takeInterruptedTurn` in cache.ts. */
export interface InterruptedTurnRecordView {
  readonly turn: InterruptedTurn
  /** The mapping with its SDK reuse proof restored, for a resume. */
  readonly restored: SessionState
}

/**
 * The next request's lineage once its interrupted-turn record is decided: a
 * continuation of the restored session, or a fresh replay naming the reason.
 */
export function resolveInterruptedTurn(
  record: InterruptedTurnRecordView,
  messages: ReadonlyArray<LineageMessage>,
): { readonly lineage: LineageResult; readonly decision: InterruptedTurnDecision } {
  const decision = classifyInterruptedContinuation(record.turn, messages)
  return {
    decision,
    lineage: decision.resume
      ? { type: "continuation", session: record.restored, resumeFrom: record.turn.prefixCount }
      : { type: "diverged", reason: "interrupted-turn-kept", detail: decision.reason },
  }
}

/** The durable mapping as the record's owner reads it back. */
export interface StoredInterruptedMapping {
  readonly claudeSessionId: string
  readonly messageCount: number
  readonly lineageHash?: string
  readonly clientLineageHash?: string
}

/** A record as this process wrote it. */
export interface InterruptedTurnRecord {
  readonly generation: string
  /** The mapping generation the marking replaced. */
  readonly markedFrom: string
  readonly claudeSessionId: string
  readonly turn: InterruptedTurn
}

/**
 * Whether `stored`, read at `generation`, is still exactly the mapping the
 * record marked: the same write, the same session and prefix, and its proof
 * still withheld. Anything else replays.
 */
export function recordStillMarks(
  record: InterruptedTurnRecord,
  generation: string | undefined,
  stored: StoredInterruptedMapping | undefined,
): boolean {
  return Boolean(
    generation && generation === record.generation && stored
    && stored.claudeSessionId === record.claudeSessionId
    && !stored.lineageHash
    && stored.clientLineageHash === record.turn.lineageHash
    && stored.messageCount === record.turn.prefixCount,
  )
}

/**
 * Whether the durable mapping is still the session a stopped turn resumed,
 * so it may be marked. A mapping already marked by an earlier stopped turn
 * (proof withheld, kept as `clientLineageHash`) qualifies too: consecutive
 * stopped turns keep the same session.
 */
export function markableSource(
  stored: StoredInterruptedMapping,
  source: InterruptedSessionSource,
  turn: InterruptedTurn,
): boolean {
  if (!source.lineageHash || turn.lineageHash !== source.lineageHash || turn.prefixCount !== source.messageCount) {
    return false
  }
  if (stored.claudeSessionId !== source.claudeSessionId || stored.messageCount !== source.messageCount) return false
  return (stored.lineageHash || stored.clientLineageHash) === source.lineageHash
}

/**
 * Whether a request's mapping changed while it waited only because a stopped
 * turn marked it: that is the stopped turn's own cleanup, not a competing
 * commit, so the request did not lose a race.
 */
export function waitedOutOwnInterruption(
  arrivalGeneration: string | null | undefined,
  record: { readonly markedFrom: string } | undefined,
): boolean {
  return typeof arrivalGeneration === "string" && record !== undefined && arrivalGeneration === record.markedFrom
}
