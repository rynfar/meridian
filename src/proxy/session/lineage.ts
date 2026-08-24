/**
 * Session lineage verification.
 *
 * Pure functions for hashing messages and classifying mutations
 * (continuation, compaction, undo, diverged).
 */

import { createHash } from "crypto"
import { HASH_IGNORED_BLOCK_TYPES, normalizeContent } from "../messages"

// --- Types ---

/** Token usage counters from the SDK (subset of Anthropic usage object). */
export interface TokenUsageIteration {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  type?: string
}

/** Token usage counters from the SDK, including optional iteration breakdowns. */
export interface TokenUsage extends TokenUsageIteration {
  iterations?: TokenUsageIteration[]
}

/** Return the effective current-context usage snapshot.
 *  When `iterations` is present and non-empty, returns the last entry;
 *  otherwise returns the original top-level usage object. */
export function normalizeContextUsage(usage: TokenUsage): TokenUsageIteration {
  const lastIteration = usage.iterations?.at(-1)
  return lastIteration ?? usage
}

/** Minimum suffix overlap (stored messages found at the end of incoming)
 *  required to classify a mutation as compaction rather than a branch. */
export const MIN_SUFFIX_FOR_COMPACTION = 2

export interface SessionState {
  claudeSessionId: string
  lastAccess: number
  messageCount: number
  /** Hash of messages[0..messageCount-1] for fast-path lineage verification.
   *  When the full prefix matches, the conversation is a strict continuation
   *  and we skip the per-message diff entirely. */
  lineageHash: string
  /** Per-message content hashes from the last stored request.
   *  Used for precise diff-based mutation classification when the aggregate
   *  lineageHash mismatches. */
  messageHashes?: string[]
  /** Per-message hashes of individual content blocks.
   *  Lets clients append a late parallel tool_result to the final user turn
   *  without forcing a full-history replay. */
  messageBlockHashes?: string[][]
  /** SDK assistant message UUIDs indexed by message position.
   *  Only assistant messages have UUIDs (user messages are null).
   *  Used to find the rollback point for undo. */
  sdkMessageUuids?: Array<string | null>
  /** SDK assistant UUID immediately before synthetic passthrough denials.
   *  Must be an assistant UUID: the Agent SDK rejects other resumeSessionAt boundaries. */
  passthroughToolCallAssistantUuid?: string
  /** Forwarded tool IDs that must be settled together at the checkpoint. */
  passthroughToolCallIds?: string[]
  /** Last observed token usage for this session (from SDK message_start / message_delta events) */
  contextUsage?: TokenUsage
}

/**
 * Associate SDK assistant events from the current upstream run with the single
 * assistant message the Anthropic client will append after this request.
 * Multiple SDK fragments overwrite the same future slot, leaving the final
 * assistant UUID as the undo checkpoint for the consolidated client turn.
 */
export function withClientAssistantUuid(
  existing: Array<string | null>,
  clientMessageCount: number,
  uuid: unknown
): Array<string | null> {
  const next = existing.slice(0, clientMessageCount + 1)
  while (next.length < clientMessageCount) next.push(null)
  // A later UUID-less assistant fragment must not leave an older fragment as
  // the rollback point for a client message that contains both.
  next[clientMessageCount] = typeof uuid === "string" && uuid.length > 0 ? uuid : null
  return next
}

/**
 * Reconcile rollback UUIDs with the session the SDK actually returned.
 *
 * A fork remaps every copied transcript UUID, so UUIDs inherited from the
 * resumed session are invalid in the returned session. The one UUID observed
 * for this request's new client-visible assistant remains valid and occupies
 * its future client message slot.
 */
export function reconcileReturnedSessionUuids(
  existing: Array<string | null>,
  clientMessageCount: number,
  currentAssistantUuid: string | null,
  resumeSessionId: string | undefined,
  returnedSessionId: string | undefined,
): Array<string | null> {
  if (!resumeSessionId || !returnedSessionId || returnedSessionId === resumeSessionId) return existing
  const next = new Array<string | null>(clientMessageCount + 1).fill(null)
  next[clientMessageCount] = currentAssistantUuid
  return next
}

/**
 * Result of lineage verification — classifies the mutation and provides
 * the information needed to take the correct SDK action.
 */
export type LineageResult =
  | { type: "continuation"; session: SessionState; resumeFrom: number; resumeContentFrom?: number }
  | { type: "compaction";   session: SessionState; resumeFrom: number; suffixOverlap: number }
  | { type: "undo";         session: SessionState; prefixOverlap: number; rollbackUuid: string | undefined }
  | { type: "diverged";     reason: LineageDivergenceReason; prefixOverlap?: number;
      /** Which message stopped matching. Present for modified-history, the
       *  only divergence where the answer is both knowable and useful. */
      mismatch?: LineageMismatch }

export type LineageDivergenceReason =
  | "unverifiable"
  | "replayed-request"
  | "modified-history"
  | "unrelated-history"
  | "not-found"
  | "independent-request"
  | "missing-session-header"

// --- Hashing ---

/**
 * Compute a lineage hash of an ordered message array.
 * Used as a fast-path check: if the aggregate hash matches, the messages
 * are an exact prefix-extension and we skip the per-message diff.
 */
export function computeLineageHash(messages: Array<{ role: string; content: any }>): string {
  if (!messages || messages.length === 0) return ""
  const parts = messages.map(m => `${m.role}:${normalizeContent(m.content)}`)
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32)
}

/**
 * Compute a content hash for a single message (role + normalised content).
 * Used to build per-message hash arrays for precise diff-based verification.
 */
export function hashMessage(message: { role: string; content: any }): string {
  return createHash("sha256")
    .update(`${message.role}:${normalizeContent(message.content)}`)
    .digest("hex")
    .slice(0, 32)
}

/** A message's shape, for diagnostics that must never carry its content. */
export interface MessageShape {
  role: string
  /** "string" for plain content, otherwise the block types in order. */
  blocks: string
  /** Bytes of normalized content — size moves when content does. */
  bytes: number
}

/** Why two histories stopped matching, in terms safe to log.
 *
 * Answers the question `prefix overlap 50/51` raises and never answers: WHICH
 * message stopped matching, and what changed about its shape. Content never
 * appears here — only role, block types, byte counts, and digests.
 */
export interface LineageMismatch {
  /** First index whose digest differs, or -1 when the prefix matches entirely. */
  index: number
  storedDigest?: string
  incomingDigest?: string
  /** Only the incoming side has a shape: the stored side is kept as digests,
   *  so its structure is not recoverable — by design, nothing to recover. */
  incomingShape?: MessageShape
  /** Digest of the preceding index, which by definition matched. */
  previousDigest?: string
  storedCount: number
  incomingCount: number
}

function describeShape(message: { role: string; content: any }): MessageShape {
  const normalized = normalizeContent(message.content)
  return {
    role: message.role,
    blocks: Array.isArray(message.content)
      ? message.content.map((b: any) => String(b?.type ?? "unknown")).join(",")
      : typeof message.content === "string" ? "string" : "unknown",
    bytes: Buffer.byteLength(normalized, "utf8"),
  }
}

/**
 * Locate the first message whose hash differs between a stored session and an
 * incoming request.
 *
 * Pure and allocation-light: callers reach for it only on a divergence, which
 * is rare and already about to cost a full replay.
 */
export function describeLineageMismatch(
  cached: SessionState,
  messages: Array<{ role: string; content: any }>,
  /** Reuse the caller's hashes. verifyLineage has already hashed the incoming
   *  history to measure overlap; hashing it again on a 700-message transcript
   *  would double the cost of the request that is already paying for a replay. */
  precomputedIncomingHashes?: string[],
): LineageMismatch {
  const storedHashes = cached.messageHashes ?? []
  const incomingHashes = precomputedIncomingHashes ?? computeMessageHashes(messages)
  const limit = Math.min(storedHashes.length, incomingHashes.length)

  let index = -1
  for (let i = 0; i < limit; i++) {
    if (storedHashes[i] !== incomingHashes[i]) { index = i; break }
  }

  const base: LineageMismatch = {
    index,
    storedCount: cached.messageCount,
    incomingCount: messages.length,
  }
  if (index < 0) return base

  return {
    ...base,
    storedDigest: storedHashes[index],
    incomingDigest: incomingHashes[index],
    incomingShape: messages[index] ? describeShape(messages[index]!) : undefined,
    previousDigest: index > 0 ? storedHashes[index - 1] : undefined,
  }
}

/**
 * One-line explanation of a divergence, for the log that reports it.
 *
 * `prefix overlap 50/51` says how many messages matched and never which one
 * stopped, which is the fact needed to act on it — a trailing-only mismatch is
 * a late tool result or a client re-serialising its last turn, while a mismatch
 * in the middle means the history was rewritten. Same overlap count, different
 * bug.
 *
 * Digests are truncated and content never appears, so the line is safe to paste
 * into a public issue.
 */
export function formatLineageMismatch(mismatch: LineageMismatch): string | undefined {
  if (mismatch.index < 0) return undefined
  const short = (digest: string | undefined) => (digest ? digest.slice(0, 12) : "—")
  const trailing = mismatch.index === mismatch.storedCount - 1
    ? " (trailing message only — the rest of the history matched)"
    : ""
  const shape = mismatch.incomingShape
    ? `${mismatch.incomingShape.role}[${mismatch.incomingShape.blocks}] ${mismatch.incomingShape.bytes}B`
    : "unknown"
  return (
    `first mismatch at index ${mismatch.index}${trailing}: ` +
    `stored=${short(mismatch.storedDigest)} incoming=${short(mismatch.incomingDigest)}, ` +
    `incoming now ${shape}`
  )
}

/**
 * Compute per-message hashes for an entire message array.
 */
export function computeMessageHashes(messages: Array<{ role: string; content: any }>): string[] {
  if (!messages || messages.length === 0) return []
  return messages.map(hashMessage)
}

function hashNormalizedContent(content: any): string {
  return createHash("sha256")
    .update(normalizeContent(content))
    .digest("hex")
    .slice(0, 32)
}

function hashableContentBlocks(content: any): any[] {
  if (!Array.isArray(content)) return [content]
  return content.filter((block: any) => !HASH_IGNORED_BLOCK_TYPES.has(block?.type))
}

/** Compute semantic hashes for each content block in every message. */
export function computeMessageBlockHashes(messages: Array<{ role: string; content: any }>): string[][] {
  if (!messages || messages.length === 0) return []
  return messages.map((message) =>
    hashableContentBlocks(message.content).map((block) =>
      hashNormalizedContent(Array.isArray(message.content) ? [block] : block)))
}

// --- Overlap measurement ---

/**
 * Measure how many stored hashes match from the START of the stored array
 * against the incoming hashes (positional comparison).
 *
 * Prefix overlap means the beginning of the conversation is intact (undo
 * changes the end but preserves the beginning).
 *
 * NOTE: Compares stored[i] === incoming[i] positionally. An earlier
 * implementation used a Set for O(1) lookups, but that allowed a stored
 * hash at position i to match an incoming hash at a completely different
 * position, inflating the overlap count when duplicate messages exist
 * in the conversation history.
 */
export function measurePrefixOverlap(storedHashes: string[], incomingHashes: string[]): number {
  let overlap = 0
  const minLen = Math.min(storedHashes.length, incomingHashes.length)
  for (let i = 0; i < minLen; i++) {
    if (storedHashes[i] === incomingHashes[i]) overlap++
    else break
  }
  return overlap
}

/**
 * Measure how many consecutive messages at the END of the stored array
 * appear as a contiguous run in the incoming array.
 *
 * Suffix overlap means the recent conversation is intact (compaction
 * changes the beginning but preserves the end).
 *
 * Algorithm: find the last stored hash in the incoming array, then walk
 * backward through both arrays verifying contiguous matches. This handles
 * the real-world compaction pattern where new messages are appended AFTER
 * the preserved suffix.
 *
 * NOTE: An earlier implementation used a Set for O(1) lookups, but that
 * allowed a stored suffix hash to match an incoming hash at a completely
 * different position — producing false compaction when duplicate messages
 * exist in the conversation. The current approach verifies positional
 * contiguity.
 */
export function measureSuffixOverlap(storedHashes: string[], incomingHashes: string[]): number {
  if (storedHashes.length === 0 || incomingHashes.length === 0) return 0

  // Find where the last stored hash appears in the incoming array.
  // Search from the end of incoming to prefer the latest match.
  const lastStoredHash = storedHashes[storedHashes.length - 1]!
  let anchorInIncoming = -1
  for (let i = incomingHashes.length - 1; i >= 0; i--) {
    if (incomingHashes[i] === lastStoredHash) {
      anchorInIncoming = i
      break
    }
  }
  if (anchorInIncoming < 0) return 0

  // Walk backward from the anchor, verifying contiguous matches.
  let overlap = 0
  let si = storedHashes.length - 1
  let ii = anchorInIncoming
  while (si >= 0 && ii >= 0) {
    if (storedHashes[si] === incomingHashes[ii]) {
      overlap++
      si--
      ii--
    } else {
      break
    }
  }
  return overlap
}

/**
 * Find the start index in the incoming array where the stored suffix
 * contiguous run begins.  Returns -1 if the suffix overlap is 0.
 */
function findSuffixAnchorStart(
  storedHashes: string[],
  incomingHashes: string[],
  suffixOverlap: number
): number {
  if (suffixOverlap <= 0) return -1
  // The anchor (last stored hash) position in incoming:
  const lastStoredHash = storedHashes[storedHashes.length - 1]!
  let anchor = -1
  for (let i = incomingHashes.length - 1; i >= 0; i--) {
    if (incomingHashes[i] === lastStoredHash) { anchor = i; break }
  }
  if (anchor < 0) return -1
  // The suffix run starts at (anchor - suffixOverlap + 1)
  return anchor - suffixOverlap + 1
}

// --- Lineage verification ---

/**
 * Verify that incoming messages are a valid continuation of a cached session.
 * Uses per-message hash comparison to deterministically classify mutations.
 * This function is deliberately side-effect free: it never mutates the cached
 * state. The caller commits new hashes/counts only after the upstream request
 * succeeds.
 *
 * Decision matrix:
 *   Full prefix match (fast-path)          → continuation (resume from stored count)
 *   Suffix overlap >= MIN_SUFFIX           → compaction   (resume after matched suffix)
 *   Prefix overlap > 0, no suffix, shrank  → undo         (fork at rollback point)
 *   Cached prefix changed while growing    → diverged     (fresh full-history replay)
 *   No overlap                             → diverged     (fresh full-history replay)
 */
export function verifyLineage(
  cached: SessionState,
  messages: Array<{ role: string; content: any }>
): LineageResult {
  // A legacy entry cannot prove which client history its SDK session contains.
  if (!cached.lineageHash || cached.messageCount === 0) {
    return { type: "diverged", reason: "unverifiable" }
  }

  // --- Fast path: aggregate lineage hash ---
  const prefix = messages.slice(0, cached.messageCount)
  const prefixHash = computeLineageHash(prefix)
  if (prefixHash === cached.lineageHash) {
    // Same or fewer messages with matching hash = replay/retry, not continuation.
    // Without this guard, identical requests resume the old SDK session and
    // re-send the last user message, causing ghost context accumulation.
    if (messages.length <= cached.messageCount) {
      return { type: "diverged", reason: "replayed-request" }
    }
    return { type: "continuation", session: cached, resumeFrom: cached.messageCount }
  }

  // --- Slow path: per-message diff ---
  if (!cached.messageHashes || cached.messageHashes.length === 0) {
    // No per-message hashes stored (legacy session). Can't diff — reject.
    return { type: "diverged", reason: "unverifiable" }
  }

  const incomingHashes = computeMessageHashes(messages)

  const prefixOverlap = measurePrefixOverlap(cached.messageHashes, incomingHashes)
  const suffixOverlap = measureSuffixOverlap(cached.messageHashes, incomingHashes)

  // Compaction: suffix preserved, long enough conversation.
  // The suffix must not start at the very beginning of incoming — a valid
  // compaction always has at least one replaced/summarized message before
  // the preserved suffix.  Without this guard, a conversation that simply
  // reuses the stored tail messages at position 0 (e.g. after an undo +
  // retype) would be falsely classified as compaction (#283).
  const MIN_STORED_FOR_COMPACTION = 6
  const suffixStartInIncoming = incomingHashes.length - suffixOverlap >= 0
    ? findSuffixAnchorStart(cached.messageHashes, incomingHashes, suffixOverlap)
    : -1
  // resumeFrom is a slice start, so the preserved suffix must also end before
  // the last message — a run that reaches the end leaves nothing to send. The
  // fast path already refuses that shape ("replayed-request"); without the same
  // guard here, a false suffix match resumes with an empty delta and the caller
  // falls back to getLastUserMessage().
  //
  // That fallback is what makes it silent rather than merely wasteful. Stateless
  // chat frontends re-send the whole history every turn and append a constant
  // trailing block after the user's own message (an injected assistant line, a
  // prefill sent as a user message). Repeat a turn verbatim and that block
  // matches the stored tail for several slots, so the anchor lands on the final
  // message. getLastUserMessage() then returns the constant trailing message
  // instead of the turn the user just typed, and the request reaches the model
  // with the user's input missing — 200, fluent output, nothing in the logs.
  //
  // Genuine compaction is unaffected: a client that compacts also appends the
  // new turn, which keeps the suffix run away from the end.
  const compactionResumeFrom = suffixStartInIncoming + suffixOverlap
  if (
    suffixOverlap >= MIN_SUFFIX_FOR_COMPACTION &&
    cached.messageHashes.length >= MIN_STORED_FOR_COMPACTION &&
    suffixStartInIncoming > 0 &&            // at least one changed message before the preserved suffix
    compactionResumeFrom < messages.length  // and at least one new message after it
  ) {
    return {
      type: "compaction",
      session: cached,
      resumeFrom: compactionResumeFrom,
      suffixOverlap,
    }
  }

  // Append-only parallel tool results: Responses clients can send one result
  // while another tool from the same assistant turn is still running. The
  // Responses adapter coalesces consecutive function_call_output items into a
  // single Anthropic user message, so the later result extends the final cached
  // slot instead of appending a new message. The SDK session already contains
  // the old blocks; resume with only the newly appended tool_result blocks.
  //
  // This is deliberately narrow. Arbitrary text edits and changed existing
  // blocks still diverge, preserving the stale-lineage safety fixes in #689 and
  // #692. Legacy sessions without block hashes also keep replaying safely.
  const boundary = cached.messageCount - 1
  if (
    boundary >= 0 &&
    prefixOverlap === boundary &&
    messages.length >= cached.messageCount &&
    cached.messageBlockHashes?.length === cached.messageCount
  ) {
    const incomingBoundary = messages[boundary]
    const storedBlocks = cached.messageBlockHashes[boundary]
    if (incomingBoundary?.role === "user" && storedBlocks && Array.isArray(incomingBoundary.content)) {
      const incomingBlocks = hashableContentBlocks(incomingBoundary.content)
      const incomingBlockHashes = incomingBlocks.map((block) => hashNormalizedContent([block]))
      const preservesStoredBlocks =
        incomingBlocks.length === incomingBoundary.content.length &&
        incomingBlockHashes.length > storedBlocks.length &&
        storedBlocks.every((hash, index) => incomingBlockHashes[index] === hash)
      const appendedBlocks = incomingBlocks.slice(storedBlocks.length)
      const seenToolResultIds = new Set(
        incomingBlocks.slice(0, storedBlocks.length)
          .filter((block) => block?.type === "tool_result" && typeof block.tool_use_id === "string")
          .map((block) => block.tool_use_id as string),
      )
      const hasOnlyNewToolResults = appendedBlocks.every((block) => {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") return false
        if (seenToolResultIds.has(block.tool_use_id)) return false
        seenToolResultIds.add(block.tool_use_id)
        return true
      })
      if (preservesStoredBlocks && hasOnlyNewToolResults) {
        return {
          type: "continuation",
          session: cached,
          resumeFrom: boundary,
          resumeContentFrom: storedBlocks.length,
        }
      }
    }
  }

  // Undo: prefix preserved (beginning intact) but suffix changed,
  // AND the conversation shrank (fewer messages). If the conversation grew
  // after a cached message changed, the old SDK session cannot prove it has
  // the intervening history; that case is handled as divergence below.
  if (prefixOverlap > 0 && suffixOverlap === 0 && messages.length <= cached.messageCount) {
    // Find the SDK UUID at the last matching position.
    let rollbackUuid: string | undefined
    if (cached.sdkMessageUuids) {
      for (let i = prefixOverlap - 1; i >= 0; i--) {
        if (cached.sdkMessageUuids[i]) {
          rollbackUuid = cached.sdkMessageUuids[i]!
          break
        }
      }
    }
    return { type: "undo", session: cached, prefixOverlap, rollbackUuid }
  }

  // A growing history with a changed cached prefix is not proof that the old
  // SDK session contains the intervening turns. This happens when a request is
  // routed back to a stale proxy node (#692), and when a client-driven tool
  // round runs on a throwaway session that never persists back to the store
  // (#689). Resume would silently skip the missing history, so force a fresh
  // replay instead.
  //
  // This subsumes the MAX_CONTINUATION_GAP bound added in #700: that allowed a
  // resume when only the last stored slot had churned and at most one exchange
  // was appended. A changed slot is a changed slot — the SDK session still
  // holds content the client no longer claims — so the bound is gone and the
  // whole shape diverges.
  if (prefixOverlap > 0 && messages.length > cached.messageCount) {
    return {
      type: "diverged",
      reason: "modified-history",
      prefixOverlap,
      mismatch: describeLineageMismatch(cached, messages, incomingHashes),
    }
  }

  // No meaningful overlap — completely different conversation.
  return { type: "diverged", reason: "unrelated-history", prefixOverlap }
}
