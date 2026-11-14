/**
 * The only changes Meridian makes to a ChatGPT-bound Responses body.
 *
 * The ChatGPT path is a pass-through: no Claude system prompt, no scrubbing,
 * no plugin hooks, and no instruction text of Meridian's or Codex CLI's own.
 * What remains here is what `chatgpt.com/backend-api/codex/responses` refuses
 * or cannot serve a request without, plus one edit the operator opts into:
 * the Reasoning Summary setting, which replaces `reasoning.summary` on every
 * request (creating `reasoning` when the client sent none) so the operator
 * gets the summary level they chose whatever each client hardcodes. Each
 * adaptation is listed in `applied` so telemetry and tests can see exactly
 * what changed; input items, system and developer messages, instructions,
 * tools, the rest of the reasoning settings and prompt_cache_key all reach
 * the provider as the client sent them. A body that already satisfies the
 * backend (Codex CLI's) passes with `applied` empty.
 *
 * Measured against the live backend on 2026-09-27: a request with no
 * `instructions` is served and `system` role input is accepted, so the
 * client's system/developer text is NOT moved; `max_output_tokens` is refused
 * with 400 "Unsupported parameter", so it is removed. Measured 2026-11-14:
 * `temperature` and `top_p` are refused the same way on every model the
 * backend serves (gpt-5.6-luna, gpt-6-luna, gpt-6-sol, gpt-6-astra,
 * gpt-6.1-sol), with or without `reasoning.effort = "none"`, so they are
 * removed too. Clients that read model capabilities from a catalog of the
 * public API (where some of these models take sampling parameters) send them.
 *
 * Pure: no I/O, and the input object is not mutated.
 */

/** The summary levels the Responses API accepts for `reasoning.summary`. */
export type ReasoningSummaryLevel = "auto" | "concise" | "detailed"
export const REASONING_SUMMARY_LEVELS: readonly ReasoningSummaryLevel[] = ["auto", "concise", "detailed"]

export type BodyAdaptation =
  /** The backend refuses stored responses ("Store must be set to false"). */
  | "store=false"
  /** The backend only streams. Non-streaming clients get the final response aggregated back. */
  | "stream=true"
  /** With store=false, reasoning survives across turns only as encrypted content the client carries back. */
  | "include+reasoning.encrypted_content"
  /** The backend refuses it (400 "Unsupported parameter: max_output_tokens"); the cap cannot be honoured there. */
  | "-max_output_tokens"
  /** The backend refuses them (400 "Unsupported parameter: temperature" / "top_p") on every model it serves. */
  | "-temperature"
  | "-top_p"
  /** The operator's Reasoning Summary setting replaced what the client asked for. */
  | `reasoning.summary=${ReasoningSummaryLevel}`

export interface AdaptedBody {
  body: Record<string, unknown>
  /** What the client asked for, before `stream=true` was forced. */
  clientWantsStream: boolean
  applied: BodyAdaptation[]
}

export interface AdaptOptions {
  /** Force `reasoning.summary` to this level; undefined keeps the client's. */
  reasoningSummary?: ReasoningSummaryLevel
}

const ENCRYPTED_REASONING = "reasoning.encrypted_content"

export function adaptResponsesBody(input: Record<string, unknown>, options: AdaptOptions = {}): AdaptedBody {
  const body: Record<string, unknown> = { ...input }
  const applied: BodyAdaptation[] = []

  if (body.store !== false) {
    body.store = false
    applied.push("store=false")
  }
  if (body.stream !== true) {
    body.stream = true
    applied.push("stream=true")
  }
  const include = Array.isArray(body.include) ? body.include : []
  if (!include.includes(ENCRYPTED_REASONING)) {
    body.include = [...include, ENCRYPTED_REASONING]
    applied.push("include+reasoning.encrypted_content")
  }
  if ("max_output_tokens" in body) {
    delete body.max_output_tokens
    applied.push("-max_output_tokens")
  }
  for (const sampling of ["temperature", "top_p"] as const) {
    if (sampling in body) {
      delete body[sampling]
      applied.push(`-${sampling}`)
    }
  }
  const summary = options.reasoningSummary
  if (summary) {
    const reasoning = body.reasoning !== null && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
      ? body.reasoning as Record<string, unknown>
      : {}
    if (reasoning.summary !== summary) {
      body.reasoning = { ...reasoning, summary }
      applied.push(`reasoning.summary=${summary}`)
    }
  }

  return { body, clientWantsStream: input.stream === true, applied }
}
