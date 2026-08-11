/**
 * Was a turn productive, or did it come back silent?
 *
 * Three separate defects have now ended the same way: the proxy hands the
 * client a well-formed terminal envelope — `stop_reason: "end_turn"`, HTTP 200,
 * `error: null` — carrying nothing the client can act on. An interrupted tail
 * (#768), an unsettled client abort (#768), a spent deny at the boundary seam
 * (#768). Each was found by tracing its own cause; each was invisible until
 * someone read a transcript.
 *
 * The causes differ, the shape does not. So this module states the shape as an
 * invariant instead of chasing the next cause:
 *
 *   A terminal envelope must carry text or a tool call.
 *
 * Anything else is a silent turn, and a silent turn is a defect — never a
 * successful response. In an interactive session it costs a confused user and a
 * retyped prompt. In an autonomous run there is nobody to retype: the loop sees
 * a finished turn with no work in it and stops, or worse, reads its own
 * unfulfilled promise on the next turn and reports the failure as its own.
 *
 * `thinking` deliberately does not count. The empty-turn signature IS thinking
 * with an empty text block — counting it as content would classify the exact
 * defect this module exists to catch as healthy.
 *
 * Pure module — no I/O, no imports from server.ts or session/.
 */

/** What a completed turn delivered to the client. */
export type TurnOutcome =
  | { kind: "productive" }
  | { kind: "silent"; reason: SilentReason }

/**
 * Why a turn is silent. Both shapes reach the client identically; they are
 * distinguished so telemetry can tell "the model said nothing" from "the model
 * said nothing and we never even opened a message".
 */
export type SilentReason =
  /** Nothing at all — no blocks were forwarded. */
  | "no_blocks"
  /** Blocks were forwarded, but none of them carried text or a tool call. */
  | "no_actionable_content"

/**
 * Classify a turn by what actually reached the client.
 *
 * `textEvents` counts forwarded text deltas, not text blocks: an EMPTY text
 * block produces a block start and stop with no delta between them, which is
 * precisely the shape a spent-deny turn takes. Counting blocks would miss it.
 */
export function classifyTurnOutcome(input: {
  /** Forwarded `text_delta` events (or, non-streaming, non-empty text blocks). */
  textEvents: number
  /** Tool calls the client will execute — actionable even with no prose. */
  toolUses: number
  /** Blocks forwarded in total, including thinking. */
  blocksForwarded: number
}): TurnOutcome {
  if (input.textEvents > 0 || input.toolUses > 0) return { kind: "productive" }
  return {
    kind: "silent",
    reason: input.blocksForwarded > 0 ? "no_actionable_content" : "no_blocks",
  }
}

/**
 * The nudge sent to recover a silent turn, in the same SDK session.
 *
 * Deliberately not the CLI's own nudge ("your previous response had no visible
 * output"). That one is issued INSIDE the session with the offending
 * instruction still in context, so on the observed cases the model obeyed the
 * instruction a second time and answered empty again. This one names the
 * contradiction and discharges it, the same move that fixed the boundary seam.
 *
 * Says nothing about which defect caused the silence: the recovery is for the
 * class, and the model does not need our diagnosis to answer.
 */
export const SILENT_TURN_NUDGE =
  "Your previous turn produced no visible output — no text and no tool call — so the client received " +
  "nothing to act on. Any earlier instruction to end your turn without further text applied only to " +
  "that turn and is now discharged. Answer now, in text, addressing the most recent request and any " +
  "tool results above it. If a tool call is still required, make it."

/**
 * Fault injection: swallow the upstream text of this request's turn.
 *
 * The defect's live rate is roughly three in five hundred requests, all on a
 * session's second turn. A harness cannot wait for that — a ten-attempt run
 * expects 0.06 occurrences — so without injection a green E2E is ambiguous:
 * the guard works, or the defect simply did not happen. That ambiguity is
 * exactly what let two earlier "verified" fixes ship broken.
 *
 * So the shape is reproduced on demand: drop the text the upstream turn
 * produced, leaving its block start and stop in place — an EMPTY text block,
 * which is the production signature exactly. Everything downstream (detection,
 * recovery, envelope, telemetry) then runs for real against a real model; only
 * the trigger is synthetic.
 *
 * EVERY text delta of the turn is dropped, not just the first: one surviving
 * delta makes the turn productive and the guard never engages. The recovery
 * turn is unaffected because it forwards through its own path, not the upstream
 * forward site this gates.
 *
 * Off unless MERIDIAN_DEBUG_FORCE_SILENT_TURN names a session id (or `1` for
 * every session). Debug-only — never a production path.
 */
export function shouldInjectSilentTurn(input: {
  raw: string | undefined
  sessionId: string | undefined
}): boolean {
  if (!input.raw) return false
  if (input.raw === "1") return true
  return Boolean(input.sessionId && input.raw === input.sessionId)
}

/**
 * Is one in-session recovery attempt worth making?
 *
 * Only for a genuinely silent turn, at most once, and never when the client is
 * already gone — a disconnected client cannot receive the recovered answer, and
 * spending a model turn to write into a closed socket is pure waste.
 */
export function shouldAttemptRecovery(input: {
  outcome: TurnOutcome
  alreadyAttempted: boolean
  clientGone: boolean
  /** The SDK session to resume; without it there is nothing to continue from. */
  sessionId?: string
  enabled: boolean
}): boolean {
  if (!input.enabled) return false
  if (input.outcome.kind !== "silent") return false
  if (input.alreadyAttempted) return false
  if (input.clientGone) return false
  return Boolean(input.sessionId)
}
