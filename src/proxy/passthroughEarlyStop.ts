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
 * The SDK emits each denied call's tool_result as a `user` message before it
 * fires the hidden digest turn. Those messages identify a stable assistant
 * checkpoint, but they are NOT a durability acknowledgement: a live PTY E2E
 * observed the assistant and deny in the iterator while neither existed in the
 * session JSONL after an immediate abort. The proxy therefore freezes the
 * assistant UUID/tool IDs at deny settlement and stores the checkpoint only
 * after the SDK's canonical terminal result commits the transcript.
 *
 * What stops the digest turn is the maxTurns cap in query.ts, not this module:
 * capped at 1, the SDK reaches the tool-use boundary and then declines to start
 * another turn, so the digest never generates AND the terminal result still
 * arrives (as `error_max_turns`) to commit the transcript. That is the
 * combination an immediate abort could not give — it skipped the commit.
 *
 * This module still drains rather than aborts, because the cap is lifted for
 * deferred tools, advisors, structured output, and the kill switch. In those
 * configurations the digest turn does generate and is discarded here.
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
  /** tool_use ids of client-forwarded calls awaiting an iterator-observed deny */
  expected: Set<string>
  /** subset of `expected` whose tool_result has been observed in the stream */
  resolved: Set<string>
  /** Last assistant message containing a forwarded tool_use.
   *  The SDK's resumeSessionAt option only accepts assistant UUIDs. */
  toolCallAssistantUuid?: string
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
 * Record one SDK assistant message and remember the only boundary type the
 * Agent SDK supports for resumeSessionAt: an SDKAssistantMessage UUID.
 *
 * The SDK may surface parallel tool calls as multiple assistant messages. The
 * final such message is an ancestor containing the complete tool-use turn, so
 * updating the boundary for every forwarded call leaves the correct stable
 * checkpoint.
 */
export function noteAssistantMessage(tracker: EarlyStopTracker, message: unknown): void {
  const m = message as { type?: unknown; uuid?: unknown; message?: { content?: unknown } } | null | undefined
  if (m?.type !== "assistant") return
  const content = m.message?.content
  const before = tracker.expected.size
  noteAssistantContent(tracker, content)
  if (tracker.expected.size > before) {
    // A newer tool-bearing assistant message supersedes the older checkpoint.
    // Fail closed when its UUID is absent: the older message may not contain
    // every parallel call, so it is not a safe resumeSessionAt target.
    tracker.toolCallAssistantUuid =
      typeof m.uuid === "string" && m.uuid.length > 0 ? m.uuid : undefined
  }
}

/**
 * Record iterator-observed tool_results from a user message's content.
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
 * every forwarded call's deny has been observed in the stream. The caller may
 * freeze the checkpoint then, but must drain to a canonical SDK result before
 * treating the UUID as durably resumable.
 */
export function allForwardedCallsResolved(tracker: EarlyStopTracker): boolean {
  if (tracker.expected.size === 0) return false
  for (const id of tracker.expected) {
    if (!tracker.resolved.has(id)) return false
  }
  return true
}

/**
 * Verify that a resumed tool-result delta settles exactly the tool calls at the
 * stored assistant checkpoint, then coalesce queued user turns into one SDK
 * input. Tool results must precede any ordinary user content, matching the
 * Anthropic Messages protocol.
 */
export function coalesceCompleteToolResultContinuation(
  messages: Array<{ role?: unknown; content?: unknown }>,
  expectedIds: readonly string[]
): Array<{ role: "user"; content: unknown[] }> | undefined {
  if (expectedIds.length === 0 || messages.length === 0) return undefined
  const expected = new Set(expectedIds)
  const actual = new Set<string>()
  const echoedCalls = new Set<string>()
  const content: unknown[] = []
  let sawUser = false
  let sawNonToolResult = false

  for (const message of messages) {
    // The client echoes the just-produced assistant tool_use before its user
    // result. That assistant turn already exists at resumeSessionAt, so the
    // structured SDK delta below intentionally filters it out.
    if (message.role === "assistant" && !sawUser) {
      if (Array.isArray(message.content)) {
        for (const rawBlock of message.content) {
          const block = rawBlock as { type?: unknown; id?: unknown } | null | undefined
          if (block?.type !== "tool_use") continue
          if (typeof block.id !== "string" || !expected.has(block.id) || echoedCalls.has(block.id)) return undefined
          echoedCalls.add(block.id)
        }
      }
      continue
    }
    if (message.role !== "user") return undefined
    // A queued user turn may follow only after the first turn settled the full
    // checkpoint batch. Splitting results across turns is not a valid resume.
    if (sawUser && actual.size !== expected.size) return undefined
    const userContent = Array.isArray(message.content)
      ? message.content
      : typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : undefined
    if (!userContent) return undefined
    sawUser = true
    for (const rawBlock of userContent) {
      const block = rawBlock as { type?: unknown; tool_use_id?: unknown } | null | undefined
      if (block?.type === "tool_result") {
        if (sawNonToolResult || typeof block.tool_use_id !== "string") return undefined
        if (!expected.has(block.tool_use_id) || actual.has(block.tool_use_id)) return undefined
        actual.add(block.tool_use_id)
      } else {
        sawNonToolResult = true
      }
      content.push(rawBlock)
    }
  }

  if (
    actual.size !== expected.size ||
    (echoedCalls.size !== 0 && echoedCalls.size !== expected.size)
  ) return undefined
  return [{ role: "user", content }]
}

/** The cache-stable assistant boundary after every forwarded call settled. */
export function settledToolCallAssistantUuid(tracker: EarlyStopTracker): string | undefined {
  return allForwardedCallsResolved(tracker) ? tracker.toolCallAssistantUuid : undefined
}

export function shouldEarlyStop(tracker: EarlyStopTracker): boolean {
  // Without an assistant UUID there is no valid resumeSessionAt checkpoint.
  // The caller still drains canonically, then evicts the unusable mapping.
  if (tracker.fired || !settledToolCallAssistantUuid(tracker)) return false
  tracker.fired = true
  return true
}

/** What a client-aborted stream must do with its session mapping. */
export type ClientAbortDisposition =
  | { action: "evict" }
  | { action: "none" }

/**
 * Decide the fate of a session whose stream the CLIENT aborted (the user hit
 * stop, or the connection dropped).
 *
 * A client abort leaves the SDK session ending in an interrupted tail. Even an
 * assistant UUID already seen in the iterator is not known durable until the
 * canonical result: the live PTY regression yielded that UUID but never wrote
 * it to JSONL after abort. Therefore every owned mapping is evicted; a replay
 * costs one cache miss but cannot wedge on a missing or interrupted boundary.
 */
export function clientAbortDisposition(input: {
  isIndependentSession: boolean
  profileSessionId?: string
  currentSessionId?: string
  sawDuplicateToolUse: boolean
  toolCallAssistantUuid?: string
  /** Only passthrough turns create synthetic denial side branches. */
  passthrough: boolean
}): ClientAbortDisposition {
  // Fork/subagent requests never write the cache, so they have nothing to undo.
  if (input.isIndependentSession || !input.profileSessionId) return { action: "none" }
  // Iterator-observed UUIDs are not durable across an interrupted query, in
  // passthrough or internal mode. Evict and replay every owned mapping.
  return { action: "evict" }
}
