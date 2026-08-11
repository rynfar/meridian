/**
 * Passthrough early-stop tracking.
 *
 * In passthrough mode the PreToolUse hook denies every client tool call
 * ("forwarded to client — end your turn"), but the SDK then invokes the model
 * one more time to digest the deny. That digest turn is discarded by the proxy
 * yet fully billed — and on always-thinking models (Fable) it costs a whole
 * thinking pass per tool step, roughly doubling per-step output spend and
 * adding a full model round-trip of latency.
 *
 * The fix: the SDK emits each denied call's tool_result as a `user` message in
 * the stream (verified against the real SDK) BEFORE it fires the digest turn's
 * API request. So the proxy can watch the stream, and the moment every
 * client-forwarded tool_use from the assistant turn has its deny persisted,
 * abort the query — the digest turn never generates. Because the denies are
 * already recorded in the SDK session history at that point, the session stays
 * coherent and can be stored + resumed (unlike the #580 duplicate-abort case,
 * which fires mid-hook before persistence).
 *
 * Pure module — no I/O, no imports from server.ts or session/.
 */

/** Passthrough MCP prefix — mirrors PASSTHROUGH_MCP_PREFIX in passthroughTools.
 *  Duplicated here (with a cross-check test) to keep this module leaf-pure. */
const CLIENT_TOOL_PREFIX = "mcp__oc__"

/** Internal SDK tool that executes for real (deferred tool discovery) — its
 *  calls are never forwarded to the client and must not arm the tracker. */
const INTERNAL_TOOLS = new Set(["ToolSearch"])

export interface EarlyStopTracker {
  /** tool_use ids of client-forwarded calls awaiting a persisted deny result */
  expected: Set<string>
  /** subset of `expected` whose tool_result has been observed in the stream */
  resolved: Set<string>
  /** true once shouldEarlyStop has returned true — it fires at most once */
  fired: boolean
}

export function createEarlyStopTracker(): EarlyStopTracker {
  return { expected: new Set(), resolved: new Set(), fired: false }
}

/**
 * Is this content block a tool call that the proxy forwards to the client
 * (as opposed to an internal tool the SDK executes itself)?
 *
 * Client tools appear either with the passthrough MCP prefix (mcp__oc__read)
 * or as bare names (read) — the SDK strips the prefix in some event paths.
 * Internal MCP tools (mcp__opencode__*) and ToolSearch are excluded.
 */
export function isClientForwardedToolUse(block: unknown): boolean {
  const b = block as { type?: unknown; id?: unknown; name?: unknown } | null | undefined
  if (!b || b.type !== "tool_use") return false
  if (typeof b.id !== "string" || b.id.length === 0) return false
  if (typeof b.name !== "string") return false
  if (INTERNAL_TOOLS.has(b.name)) return false
  if (b.name.startsWith("mcp__") && !b.name.startsWith(CLIENT_TOOL_PREFIX)) return false
  return true
}

/**
 * Record the client-forwarded tool_use ids from an assistant message's content.
 */
export function noteAssistantContent(tracker: EarlyStopTracker, content: unknown): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (isClientForwardedToolUse(block)) {
      tracker.expected.add((block as { id: string }).id)
    }
  }
}

/**
 * Record persisted tool_results from a user message's content.
 *
 * Records EVERY tool_result id, not just already-expected ones: the CLI
 * dispatches hooks per-block while later blocks are still streaming, and it
 * emits per-block assistant messages — so a deny's tool_result can reach the
 * iterator BEFORE the assistant message that arms its id in `expected`
 * (observed live, MERIDIAN_TRACE_STREAM). Unmatched ids are harmless:
 * shouldEarlyStop only ever checks ids that are in `expected`.
 */
export function noteUserContent(tracker: EarlyStopTracker, content: unknown): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    const b = block as { type?: unknown; tool_use_id?: unknown } | null | undefined
    if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
      tracker.resolved.add(b.tool_use_id)
    }
  }
}

/**
 * True exactly once: when at least one client tool call was forwarded and
 * every forwarded call's deny has been observed in the stream. At that point
 * the digest turn hasn't generated yet — the caller should abort the query.
 */
export function shouldEarlyStop(tracker: EarlyStopTracker): boolean {
  if (tracker.fired) return false
  if (tracker.expected.size === 0) return false
  for (const id of tracker.expected) {
    if (!tracker.resolved.has(id)) return false
  }
  tracker.fired = true
  return true
}

/** What a client-aborted stream must do with its session mapping. */
export type ClientAbortDisposition =
  | { action: "store"; resumeUuid: string }
  | { action: "evict" }
  | { action: "none" }

/**
 * Decide the fate of a session whose stream the CLIENT aborted (the user hit
 * stop, or the connection dropped).
 *
 * A client abort leaves the SDK session ending in an interrupted tail — the
 * same state the deny-boundary fix addresses for early stop. Resuming from
 * that tail makes the SDK synthesize a "Continue from where you left off."
 * turn, which the model answers with meta text ("No response requested.") or
 * an empty turn. Each empty turn then becomes the next tail, so the session
 * never recovers on its own: every following turn comes back empty until the
 * lineage is discarded.
 *
 * An early stop is meridian's own doing and always has a persisted deny to
 * fork from; a user interrupt is not an early stop and may have none. So:
 *
 * - a boundary was persisted → store it, and the next continuation forks
 *   there (lineage and prompt cache survive);
 * - no boundary → nothing is safe to resume from, so drop the mapping and let
 *   the next request replay into a fresh SDK session. A cache-miss replay is
 *   the cost of not wedging the conversation.
 *
 * `sawDuplicateToolUse` keeps the #552 rule: such a history holds a dangling
 * dropped call that diverges from the client's view and is never resumable.
 */
export function clientAbortDisposition(input: {
  isIndependentSession: boolean
  profileSessionId?: string
  currentSessionId?: string
  sawDuplicateToolUse: boolean
  resumeBoundaryUuid?: string
  /** Only passthrough turns have deny boundaries. */
  passthrough: boolean
}): ClientAbortDisposition {
  // Fork/subagent requests never write the cache, so they have nothing to undo.
  if (input.isIndependentSession || !input.profileSessionId) return { action: "none" }
  // A "deny boundary" is a passthrough concept. In internal mode the SDK runs
  // the tools itself, so a user message carrying tool_results is an ordinary
  // turn — storing its uuid would mark a normal continuation point as a spent
  // deny in the cross-process store, and the next continuation would fork from
  // it. The interrupted tail is still unsafe to resume, so evict and replay.
  if (!input.passthrough) return { action: "evict" }
  if (input.currentSessionId && !input.sawDuplicateToolUse && input.resumeBoundaryUuid) {
    return { action: "store", resumeUuid: input.resumeBoundaryUuid }
  }
  return { action: "evict" }
}

/**
 * Resume boundary of an early-stopped session: the uuid of a persisted `user`
 * message carrying tool_results. The last one before the abort is the final
 * deny — continuations fork there instead of resuming the interrupted tail.
 */
export function resumeBoundaryUuid(message: unknown): string | undefined {
  const m = message as { type?: unknown; uuid?: unknown; message?: { content?: unknown } } | null | undefined
  if (m?.type !== "user") return undefined
  if (typeof m.uuid !== "string" || m.uuid.length === 0) return undefined
  const content = m.message?.content
  if (!Array.isArray(content)) return undefined
  const hasResult = content.some((block) => {
    const b = block as { type?: unknown } | null | undefined
    return b?.type === "tool_result"
  })
  return hasResult ? m.uuid : undefined
}
