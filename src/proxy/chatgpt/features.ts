/**
 * Operator settings for the ChatGPT gateway.
 *
 * Separate from the per-adapter SDK features (sdkFeatures.ts) on purpose: those
 * configure the Claude Agent SDK, and the ChatGPT path never runs adapter
 * detection or the SDK, so a per-adapter key would silently not apply. They
 * are stored under `chatgpt` in settings.json and re-read on every request,
 * like routing.
 *
 * Defaults differ from Claude's where the pass-through contract demands it:
 * reasoning summaries are forwarded unless the operator turns them off, because
 * the client asked for them and dropping them by default would be a mutation of
 * a pass-through response.
 */
import { getSetting, setSetting } from "../../settings"
import { REASONING_SUMMARY_LEVELS, type ReasoningSummaryLevel } from "./body"
import { CHATGPT_MODELS, providerForModel } from "../upstream/provider"

export interface ChatGptFeatures {
  /** Forward ChatGPT's reasoning summaries to the client. */
  thinkingPassthrough: boolean
  /** The reasoning summary level every request asks for; `client` sends what the client asked for. */
  reasoningSummary: ChatGptReasoningSummary
  /** Per-request cost cap in USD, 0 = off. */
  maxBudgetUsd: number
  /** A ChatGPT model to retry on when the requested one cannot serve, "" = off. */
  fallbackModel: string
  /** When a seat whose plan quota is spent may serve on its purchased Codex credits. */
  creditsPolicy: ChatGptCreditsPolicy
  /** Per-seat overrides of `creditsPolicy`, keyed by seat id (accountUserId). */
  seatCreditsPolicy: Record<string, ChatGptCreditsPolicy>
  /** Where a free-plan seat ranks for unpinned work: before any seat spends credits, or after. */
  freeSeatOrder: ChatGptFreeSeatOrder
  /**
   * Per-seat renewal intervals in hours, keyed by seat id (accountUserId). A
   * seat named here is renewed this long after its access token was issued
   * instead of 80% into the token's life (owned.ts `renewalDueAt`).
   */
  seatRenewalHours: Record<string, number>
}

/** The range a seat's renewal interval may take: an hour, up to the ten days a token lasts. */
export const CHATGPT_RENEWAL_HOURS_MIN = 1
export const CHATGPT_RENEWAL_HOURS_MAX = 240

function isRenewalHours(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= CHATGPT_RENEWAL_HOURS_MIN && value <= CHATGPT_RENEWAL_HOURS_MAX
}

/** Each seat's own renewal interval in milliseconds, as owned.ts reads it. */
export function chatGptRenewalIntervals(features: ChatGptFeatures): Record<string, number> {
  return Object.fromEntries(Object.entries(features.seatRenewalHours).map(([seat, hours]) => [seat, hours * 3_600_000]))
}

/**
 * Which `reasoning.summary` ChatGPT is asked for. `client` leaves the body as
 * the client sent it, summary or none. Any other value replaces the client's
 * on every request, and adds a `reasoning` object to one that had none:
 * clients hardcode a level per model variant (opencode sends `auto`, and
 * nothing at all for a model it does not recognise as a reasoning one), so
 * one setting here is the only place an operator can choose it for all of
 * them. Independent of Thinking Passthrough, which decides whether the
 * summaries that come back reach the client.
 */
export type ChatGptReasoningSummary = "client" | ReasoningSummaryLevel
export const CHATGPT_REASONING_SUMMARIES: readonly ChatGptReasoningSummary[] = ["client", ...REASONING_SUMMARY_LEVELS]

export function isChatGptReasoningSummary(value: unknown): value is ChatGptReasoningSummary {
  return typeof value === "string" && (CHATGPT_REASONING_SUMMARIES as readonly string[]).includes(value)
}

/** The level to force on the outbound body, or undefined to keep the client's. */
export function forcedReasoningSummary(features: ChatGptFeatures): ReasoningSummaryLevel | undefined {
  return features.reasoningSummary === "client" ? undefined : features.reasoningSummary
}

/**
 * When a seat on ChatGPT's free plan may take unpinned work. Either way it
 * comes after every paid seat with plan quota left, because a free seat
 * refuses most Codex models and its quota is small.
 *
 * - `before-credits`: next, before any seat is sent work on its Codex credits.
 *   Free quota costs nothing; credits are bought.
 * - `after-credits`: only once no seat can serve on credits either.
 *
 * A turn pinned to a free seat goes there regardless, as any pin does.
 */
export type ChatGptFreeSeatOrder = "before-credits" | "after-credits"
export const CHATGPT_FREE_SEAT_ORDERS: readonly ChatGptFreeSeatOrder[] = ["before-credits", "after-credits"]

export function isChatGptFreeSeatOrder(value: unknown): value is ChatGptFreeSeatOrder {
  return typeof value === "string" && (CHATGPT_FREE_SEAT_ORDERS as readonly string[]).includes(value)
}

/**
 * When a seat whose plan windows are spent may be served on its Codex credits.
 *
 * Credits can be real money: they are bought, and a workspace with automatic
 * reload is charged again whenever the balance runs low. The backend spends
 * them by itself once a seat's plan is drained - nothing in the request opts
 * in - so the only control is whether Meridian sends that seat the turn.
 *
 * - `never`: a plan-exhausted seat is never sent work.
 * - `reserve`: only once no seat has plan quota left.
 * - `immediately`: as soon as the seat's own plan is drained, in normal
 *   routing order, as if its plan were still running.
 *
 * None of these touches a seat that still has plan quota.
 */
export type ChatGptCreditsPolicy = "never" | "reserve" | "immediately"
export const CHATGPT_CREDITS_POLICIES: readonly ChatGptCreditsPolicy[] = ["never", "reserve", "immediately"]
/** What a seat override set to this means: follow the instance's policy. */
export const CHATGPT_CREDITS_INHERIT = "inherit"

export function isChatGptCreditsPolicy(value: unknown): value is ChatGptCreditsPolicy {
  return typeof value === "string" && (CHATGPT_CREDITS_POLICIES as readonly string[]).includes(value)
}

/** The policy a seat runs under, and whether it is the seat's own or the instance's. */
export function effectiveCreditsPolicy(features: ChatGptFeatures, seat: string): { policy: ChatGptCreditsPolicy; source: "seat" | "default" } {
  const own = features.seatCreditsPolicy[seat]
  return own ? { policy: own, source: "seat" } : { policy: features.creditsPolicy, source: "default" }
}

export const CHATGPT_FEATURE_DEFAULTS: Readonly<ChatGptFeatures> = {
  thinkingPassthrough: true,
  reasoningSummary: "client",
  maxBudgetUsd: 0,
  fallbackModel: "",
  // A fresh install must not spend money nobody agreed to spend.
  creditsPolicy: "never",
  seatCreditsPolicy: {},
  freeSeatOrder: "before-credits",
  seatRenewalHours: {},
}

/**
 * The effective features. A saved value of the wrong type, a negative budget, or
 * a fallback model this build no longer routes to ChatGPT falls back to the
 * default rather than reaching the request path. What the gateway currently
 * offers is deliberately not the test here: that follows the backend's catalog
 * and can shrink for an hour, and a saved choice should outlive that.
 */
export function getChatGptFeatures(): ChatGptFeatures {
  const saved = getSetting("chatgpt") ?? {}
  return {
    thinkingPassthrough: typeof saved.thinkingPassthrough === "boolean"
      ? saved.thinkingPassthrough
      : CHATGPT_FEATURE_DEFAULTS.thinkingPassthrough,
    reasoningSummary: isChatGptReasoningSummary(saved.reasoningSummary) ? saved.reasoningSummary : CHATGPT_FEATURE_DEFAULTS.reasoningSummary,
    maxBudgetUsd: typeof saved.maxBudgetUsd === "number" && Number.isFinite(saved.maxBudgetUsd) && saved.maxBudgetUsd > 0
      ? saved.maxBudgetUsd
      : CHATGPT_FEATURE_DEFAULTS.maxBudgetUsd,
    fallbackModel: typeof saved.fallbackModel === "string" && providerForModel(saved.fallbackModel) === "chatgpt"
      ? saved.fallbackModel
      : CHATGPT_FEATURE_DEFAULTS.fallbackModel,
    creditsPolicy: isChatGptCreditsPolicy(saved.creditsPolicy) ? saved.creditsPolicy : CHATGPT_FEATURE_DEFAULTS.creditsPolicy,
    seatCreditsPolicy: savedSeatPolicies(saved.seatCreditsPolicy),
    freeSeatOrder: isChatGptFreeSeatOrder(saved.freeSeatOrder) ? saved.freeSeatOrder : CHATGPT_FEATURE_DEFAULTS.freeSeatOrder,
    seatRenewalHours: savedRenewalHours(saved.seatRenewalHours),
  }
}

function savedRenewalHours(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => isRenewalHours(entry[1])))
}

function savedSeatPolicies(value: unknown): Record<string, ChatGptCreditsPolicy> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
  const result: Record<string, ChatGptCreditsPolicy> = {}
  for (const [seat, policy] of Object.entries(value as Record<string, unknown>)) {
    if (isChatGptCreditsPolicy(policy)) result[seat] = policy
  }
  return result
}

/**
 * A validated update. `seatCreditsPolicy` and `seatRenewalHours` are patches
 * of their own: each named seat is set, and one set to `inherit` (credits) or
 * null (renewal) loses its override.
 */
export type ChatGptFeatureUpdate = Partial<Omit<ChatGptFeatures, "seatCreditsPolicy" | "seatRenewalHours">> & {
  seatCreditsPolicy?: Record<string, ChatGptCreditsPolicy | typeof CHATGPT_CREDITS_INHERIT>
  seatRenewalHours?: Record<string, number | null>
}

/**
 * Validate a partial update in full before anything is written, so a body with
 * one good key and one bad one is refused rather than half-applied.
 *
 * The fallback model must be one the gateway offers (`fallbackChoices`, the
 * same list the settings page shows): a Claude id, or a ChatGPT id no seat can
 * serve, would send the retry to a model that refuses it.
 */
export function validateChatGptFeatureUpdate(
  raw: unknown,
  fallbackChoices: readonly string[] = CHATGPT_MODELS,
  /** A profile id, former id or seat id to its seat id; undefined = not a ChatGPT seat. */
  resolveSeat: (idOrSeat: string) => string | undefined = () => undefined,
): ChatGptFeatureUpdate {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("body must be a JSON object")
  const result: ChatGptFeatureUpdate = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "thinkingPassthrough") {
      if (typeof value !== "boolean") throw new Error("thinkingPassthrough must be a boolean")
      result.thinkingPassthrough = value
    } else if (key === "reasoningSummary") {
      if (!isChatGptReasoningSummary(value)) throw new Error(`reasoningSummary must be one of: ${CHATGPT_REASONING_SUMMARIES.join(", ")}`)
      result.reasoningSummary = value
    } else if (key === "maxBudgetUsd") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("maxBudgetUsd must be a number >= 0")
      result.maxBudgetUsd = value
    } else if (key === "fallbackModel") {
      if (typeof value !== "string" || (value !== "" && !fallbackChoices.includes(value))) {
        throw new Error(`fallbackModel must be "" or one of: ${fallbackChoices.join(", ")}`)
      }
      result.fallbackModel = value
    } else if (key === "creditsPolicy") {
      if (!isChatGptCreditsPolicy(value)) throw new Error(`creditsPolicy must be one of: ${CHATGPT_CREDITS_POLICIES.join(", ")}`)
      result.creditsPolicy = value
    } else if (key === "seatCreditsPolicy") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("seatCreditsPolicy must be an object of profile id -> policy")
      const seats: NonNullable<ChatGptFeatureUpdate["seatCreditsPolicy"]> = {}
      for (const [id, policy] of Object.entries(value as Record<string, unknown>)) {
        const seat = resolveSeat(id)
        if (!seat) throw new Error(`seatCreditsPolicy: unknown ChatGPT profile "${id}"`)
        if (policy !== CHATGPT_CREDITS_INHERIT && !isChatGptCreditsPolicy(policy)) {
          throw new Error(`seatCreditsPolicy.${id} must be one of: ${[CHATGPT_CREDITS_INHERIT, ...CHATGPT_CREDITS_POLICIES].join(", ")}`)
        }
        seats[seat] = policy
      }
      result.seatCreditsPolicy = seats
    } else if (key === "seatRenewalHours") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("seatRenewalHours must be an object of profile id -> hours")
      const seats: NonNullable<ChatGptFeatureUpdate["seatRenewalHours"]> = {}
      for (const [id, hours] of Object.entries(value as Record<string, unknown>)) {
        const seat = resolveSeat(id)
        if (!seat) throw new Error(`seatRenewalHours: unknown ChatGPT profile "${id}"`)
        if (hours !== null && !isRenewalHours(hours)) {
          throw new Error(`seatRenewalHours.${id} must be a number of hours from ${CHATGPT_RENEWAL_HOURS_MIN} to ${CHATGPT_RENEWAL_HOURS_MAX}, or null`)
        }
        seats[seat] = hours
      }
      result.seatRenewalHours = seats
    } else if (key === "freeSeatOrder") {
      if (!isChatGptFreeSeatOrder(value)) throw new Error(`freeSeatOrder must be one of: ${CHATGPT_FREE_SEAT_ORDERS.join(", ")}`)
      result.freeSeatOrder = value
    } else {
      throw new Error(`Unknown ChatGPT setting: ${key}`)
    }
  }
  return result
}

export function chatGptFeatureCapabilities(features: ChatGptFeatures): Array<{ name: string; status: string; detail: string }> {
  return [
    {
      name: "Thinking",
      status: features.thinkingPassthrough ? "summaries" : "hidden",
      detail: features.thinkingPassthrough
        ? "ChatGPT exposes only short reasoning summaries and encrypted reasoning; both pass through untouched."
        : "Reasoning summaries are removed from responses. Encrypted reasoning still passes through for the next turn.",
    },
    {
      name: "Reasoning Summary",
      status: features.reasoningSummary,
      detail: features.reasoningSummary === "client"
        ? "Each request asks for the reasoning summary level its client chose, or none."
        : `Every request asks for ${features.reasoningSummary} reasoning summaries, whatever its client chose.`,
    },
    {
      name: "Max Budget",
      status: features.maxBudgetUsd > 0 ? `$${features.maxBudgetUsd}` : "off",
      detail: "Per-request cost cap from OpenAI pricing: refused before sending, or stopped mid-stream, when the estimate is over it.",
    },
    {
      name: "Fallback Model",
      status: features.fallbackModel || "off",
      detail: "Retried once on this model when the requested one fails before any output was sent.",
    },
    {
      name: "Codex Credits",
      status: features.creditsPolicy + (Object.keys(features.seatCreditsPolicy).length > 0 ? ` (+${Object.keys(features.seatCreditsPolicy).length} seat overrides)` : ""),
      detail: CREDITS_POLICY_DETAIL[features.creditsPolicy],
    },
    {
      name: "Free Seats",
      status: features.freeSeatOrder,
      detail: features.freeSeatOrder === "before-credits"
        ? "A free-plan seat takes unpinned work after every paid seat with plan quota, and before any seat spends Codex credits."
        : "A free-plan seat takes unpinned work only once no seat can serve on its plan or on Codex credits.",
    },
  ]
}

const CREDITS_POLICY_DETAIL: Record<ChatGptCreditsPolicy, string> = {
  never: "A seat whose plan quota is spent is never served on its purchased Codex credits.",
  reserve: "A seat whose plan quota is spent serves on its Codex credits only once no seat has plan quota left.",
  immediately: "A seat serves on its Codex credits as soon as its own plan quota is spent, in normal routing order.",
}

export function updateChatGptFeatures(patch: ChatGptFeatureUpdate): ChatGptFeatures {
  const saved = getSetting("chatgpt") ?? {}
  const { seatCreditsPolicy: seatPatch, seatRenewalHours: renewalPatch, ...rest } = patch
  const next = { ...saved, ...rest }
  if (renewalPatch) {
    const seats = savedRenewalHours(saved.seatRenewalHours)
    for (const [seat, hours] of Object.entries(renewalPatch)) {
      if (hours === null) delete seats[seat]
      else seats[seat] = hours
    }
    next.seatRenewalHours = seats
  }
  if (seatPatch) {
    const seats: Record<string, ChatGptCreditsPolicy> = savedSeatPolicies(saved.seatCreditsPolicy)
    for (const [seat, policy] of Object.entries(seatPatch)) {
      if (policy === CHATGPT_CREDITS_INHERIT) delete seats[seat]
      else seats[seat] = policy
    }
    next.seatCreditsPolicy = seats
  }
  setSetting("chatgpt", next)
  return getChatGptFeatures()
}

export function resetChatGptFeatures(): ChatGptFeatures {
  setSetting("chatgpt", undefined)
  return getChatGptFeatures()
}
