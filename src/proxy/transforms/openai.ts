import type { Transform, RequestContext } from "../transform"
import { openCodeTransforms } from "./opencode"

/**
 * Anthropic's Claude Agent SDK silently aborts — returning an empty stream
 * (`data: [DONE]` with no content blocks) — when the forwarded system prompt
 * carries Hermes Agent's operational boilerplate (its self-description, tool
 * and permission directives the SDK tries to interpret). The symptom is a
 * client-visible "empty stream with no finish_reason" error and only reproduces
 * with the real Hermes system prompt: generic text of the same size streams
 * fine.
 *
 * The profile persona we actually want forwarded lives in the leading block of
 * the system prompt, before Hermes' self-description. Everything from that
 * boilerplate onward is operational text the SDK-backed model does not need
 * (it has its own tool handling). Truncating at the anchor leaves a clean,
 * profile-specific persona that the SDK accepts.
 *
 * Scoped to the `openai` adapter (Hermes talks to Meridian over
 * /v1/chat/completions). No-op when the anchor is absent.
 */
export const HERMES_BOILERPLATE_ANCHOR = "You run on Hermes Agent"

export const stripHermesBoilerplateTransform: Transform = {
  name: "openai-strip-hermes-boilerplate",
  adapters: ["openai"],

  onRequest(ctx: RequestContext): RequestContext {
    const sys = ctx.systemContext
    if (typeof sys !== "string") return ctx

    const idx = sys.indexOf(HERMES_BOILERPLATE_ANCHOR)
    // idx <= 0 means: anchor absent, or it sits at the very start with no
    // persona ahead of it. Either way there is nothing safe to keep, so leave
    // the system prompt untouched.
    if (idx <= 0) return ctx

    const head = sys.slice(0, idx).trimEnd()
    if (!head) return ctx

    return { ...ctx, systemContext: head }
  },
}

/**
 * Transforms for the generic OpenAI-compatible endpoint. Mirrors the OpenCode
 * transforms (tool/passthrough behaviour is identical) and adds the Hermes
 * boilerplate stripper so forwarded system prompts don't trip the SDK.
 */
export const openAiTransforms: Transform[] = [
  ...openCodeTransforms,
  stripHermesBoilerplateTransform,
]
