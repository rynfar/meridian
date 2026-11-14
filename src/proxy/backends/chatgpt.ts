/**
 * The ChatGPT upstream backend: one complete provider request, passed through.
 *
 * The upstream already speaks Responses, so nothing is translated. The body is
 * adapted only where the Codex backend requires it (chatgpt/body.ts) and the
 * response stream comes back byte for byte. This path never enters the Claude
 * pipeline: no adapter detection, no system-prompt handling, no plugin
 * `onRequest`/`onResponse` hooks - which is what keeps a Claude-oriented
 * plugin such as opencode-scrub from rewriting a ChatGPT request. It is still
 * observed: every client turn produces one `ChatGptTurnEvent` for telemetry.
 *
 * Both directions are contained. Outbound headers are built from nothing
 * (chatgpt/request.ts), so nothing the client sent reaches the provider but
 * the body; and only an allowlist of response headers comes back, so a client
 * is never handed chatgpt.com's cookies.
 *
 * Seats and tokens come from a `ChatGptCredentialSource` (owned or
 * follow-external). What is decided here is rotation: try a seat, read far
 * enough into the answer to know whether the SEAT failed, and move on if it
 * did. Retrying stops where the failure sniffer stops - after the client could
 * have seen output, serving the turn again would bill a second account for the
 * same work.
 *
 * Hook points for later features (Max Budget, fallback model, pricing) are the
 * `hooks` option; see ChatGptHooks.
 */
import { randomUUID } from "node:crypto"
import { AssignmentStore, type ProfileExhaustion } from "../routing"
import { isImageEndpoint, type UpstreamBackend, type UpstreamRequest } from "../upstream/backend"
import { adaptResponsesBody, type BodyAdaptation, type ReasoningSummaryLevel } from "../chatgpt/body"
import { buildCodexImagesRequest, buildCodexRequest } from "../chatgpt/request"
import { isModelRefusal, sniffChatGptFailure, type ChatGptFailureKind } from "../chatgpt/stream"
import { aggregateResponsesStream, tapResponsesStream, type ChatGptUsage, type TapSummary } from "../chatgpt/tap"
import { chatGptCooldownUntil, chatGptCreditsFromHeaders, chatGptRateLimitFromHeaders, creditsCanServe, type ChatGptRateLimit } from "../chatgpt/windows"
import type { CodexCredits, CodexUsageWindow } from "../codex/types"
import type { ChatGptCreditsPolicy, ChatGptFreeSeatOrder } from "../chatgpt/features"
import type { ChatGptCredentialSource, SeatUnavailableReason } from "../chatgpt/source"

export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>

/** What a hook sees of a turn before it is dispatched. */
export interface ChatGptTurnInfo {
  requestId: string
  model: string | undefined
  /** The client's body as received, before adaptation. Do not mutate. */
  body: Readonly<Record<string, unknown>>
  headers: Headers
}

export interface ChatGptAttempt {
  seat: string
  status: number
  failure: ChatGptFailureKind | null
}

/** One per client turn, success or failure. Carries no credential. */
export interface ChatGptTurnEvent {
  requestId: string
  startedAt: number
  requestModel: string | null
  /** The model the provider says answered, when it said. */
  model: string | null
  seat: string | null
  status: number
  stream: boolean
  adaptations: BodyAdaptation[]
  attempts: ChatGptAttempt[]
  usage: ChatGptUsage | null
  ttfbMs: number | null
  durationMs: number
  error: string | null
  reasoningSummaryEvents: number
  requestSource?: string
  /** Set when the seat served with its plan quota spent, paying with Codex credits. */
  servedOnCredits?: boolean
}

/** A seat said no to a turn: benched until `until`. Carries no credential. */
export interface ChatGptSeatRefusal {
  requestId: string
  seat: string
  kind: Exclude<ChatGptFailureKind, "transient">
  status: number
  until: number
  /** The limit state the refusing response stated, when it stated one. */
  rateLimit: ChatGptRateLimit | null
  /** When the refused attempt started, so a refusal of a token since renewed can be told apart. */
  startedAt: number
}

export interface ChatGptHooks {
  /**
   * Admission before any seat is tried - the Max Budget seam. Return a
   * Response to refuse the turn; it is returned to the client as is.
   */
  admit?(turn: ChatGptTurnInfo): Response | undefined | Promise<Response | undefined>
  /**
   * Every seat was unavailable or refused - the Fallback Model seam. Return a
   * Response to serve the turn another way, or undefined for the default error.
   */
  onPoolExhausted?(turn: ChatGptTurnInfo & { reasons: ReadonlySet<SeatUnavailableReason> }): Promise<Response | undefined>
  /** Usage/telemetry seam: called once per client turn when it ends. */
  onTurn?(event: ChatGptTurnEvent): void
  /**
   * Refusal seam for an account supervisor: each seat that refused, and how
   * the turn ended for the refused seats - `servedBy` another seat, or every
   * candidate refused (`servedBy: null`).
   */
  onSeatRefused?(refusal: ChatGptSeatRefusal): void
  onRefusalsSettled?(outcome: { requestId: string; refused: readonly ChatGptSeatRefusal[]; servedBy: string | null }): void
}

/**
 * Which seats may serve this turn, decided by the caller (server.ts owns the
 * active pointer, the routing exclusions and the trust of internal headers).
 *
 * - `pool`: every eligible seat, `preferred` first when it can serve, the
 *   `excluded` ones never. The rest follow `order` (the saved profile
 *   order) where given, then the credential owner's order.
 * - `pinned`: that seat only, no failover - an explicit profile header, or a
 *   warm.
 * - `refuse`: answered before any seat is tried.
 *
 * `spendCredits: false` keeps the turn off seats that could serve only on
 * purchased Codex credits (a warm has no business spending them); absent
 * means they may serve once no seat has plan quota left.
 *
 * `free` names the seats on ChatGPT's free plan. They serve a pool turn only
 * after every paid seat with plan quota, `preferred` or not, and then either
 * before any seat serves on credits or after all of them (`freeSeatOrder`,
 * chatgpt/features.ts).
 */
export type ChatGptRoute =
  | {
    kind: "pool"; preferred?: string; excluded: ReadonlySet<string>; order?: readonly string[]; spendCredits?: boolean
    free?: ReadonlySet<string>; freeSeatOrder?: ChatGptFreeSeatOrder
  }
  | { kind: "pinned"; seat: string; spendCredits?: boolean }
  | { kind: "refuse"; response: Response; error: string }

export interface ChatGptBackendOptions<Ctx> {
  source: ChatGptCredentialSource
  /** Rebuild the inbound request; dispatch has already read the original's body. */
  inboundRequest: (context: Ctx) => Request | Promise<Request>
  /** A ChatGPT-only exhaustion tracker; never shared with Claude profiles. */
  exhaustion: ProfileExhaustion
  /** Seat selection per turn; without it every eligible seat serves in the owner's order. */
  route?: (turn: ChatGptTurnInfo) => ChatGptRoute
  /**
   * A seat's Codex credits from the last usage read, with when it was taken;
   * null when unknown. Response headers observed later take precedence.
   */
  credits?: (seat: string) => { credits: CodexCredits; at: number } | null
  /**
   * Bring `credits` and `planWindows` up to date, bounded. Awaited at most
   * once per turn: when a seat that may not spend credits was never read, or
   * a credits seat is needed and its balance is unknown.
   */
  refreshCredits?: () => Promise<void>
  /**
   * The seat's credits policy (chatgpt/features.ts). Absent means `never`:
   * a backend nobody configured does not spend money.
   */
  creditsPolicy?: (seat: string) => ChatGptCreditsPolicy
  /** A seat's plan windows from the last usage read, with when it was taken; null when never read. */
  planWindows?: (seat: string) => { windows: readonly CodexUsageWindow[]; at: number } | null
  /** The operator's Reasoning Summary level, read per turn; undefined keeps the client's. */
  reasoningSummary?: () => ReasoningSummaryLevel | undefined
  hooks?: ChatGptHooks
  fetchImpl?: UpstreamFetch
  now?: () => number
}

export interface ObservedSeatLimits {
  rateLimit: ChatGptRateLimit
  at: number
}

/** Where a seat stands on its credits, for its card. */
export interface ChatGptSeatCreditState {
  /** The plan's quota is spent: the owner stamped it, a refusal benched it, or the newest reading says so. */
  planSpent: boolean
  /** The plan is spent and the seat's latest served turn was paid with credits. */
  servingOnCredits: boolean
}

export interface ChatGptBackend<Ctx> extends UpstreamBackend<Ctx> {
  /** Latest `x-codex-*` window headers per seat, from real responses. */
  observedLimits(): ReadonlyMap<string, ObservedSeatLimits>
  seatCreditState(seat: string): ChatGptSeatCreditState
  /** Drop everything learned about a removed seat: observed windows, credits, refusals, bench. */
  forgetSeat(seat: string): void
}

/** How long a spent seat sits out when the refusal named no reset. */
const DEFAULT_COOLDOWN_MS = 10 * 60_000
/**
 * A refused token is benched briefly: in follow-external mode the owner may
 * refresh it at any moment, and the next request re-reads it anyway.
 */
const REAUTH_COOLDOWN_MS = 60_000
/**
 * How long a seat that refused a model sits that model out. Which models a
 * seat may use follows its plan, which rarely changes; a model later opened to
 * that plan is picked up once this runs out, for the price of one refusal.
 */
const MODEL_REFUSAL_MS = 6 * 60 * 60_000
const MAX_CONVERSATIONS = 5_000

const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after"] as const

function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: { type, message, code: null } }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function forwardHeaders(upstream: Response): Headers {
  const headers = new Headers()
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Seats the order names first, in its order; the rest after them, as they came. */
function inSavedOrder(seats: readonly string[], order: readonly string[]): string[] {
  const rank = new Map(order.map((seat, index) => [seat, index]))
  return seats
    .map((seat, index) => ({ seat, index, rank: rank.get(seat) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.seat)
}

/**
 * The backend's answer to a request it refuses as a request - an unsupported
 * model, a field it rejects - rather than as a seat failure.
 *
 * The Codex backend states such refusals as `{"detail": "..."}`, which an
 * OpenAI client does not read: it looks for `error.message` and would show a
 * generic failure instead of the reason. That one shape is re-enveloped, with
 * the backend's status and its own words; anything else is returned verbatim.
 * This touches the RESPONSE only, and only on a refusal.
 */
function refusalResponse(status: number, text: string, headers: Headers): Response {
  let detail: string | undefined
  try {
    const parsed = asRecord(JSON.parse(text) as unknown)
    detail = parsed && !parsed.error && typeof parsed.detail === "string" ? parsed.detail : undefined
  } catch {
    detail = undefined
  }
  return detail === undefined
    ? new Response(text, { status, headers })
    : errorResponse(status, "invalid_request_error", detail)
}

export function createChatGptBackend<Ctx>(options: ChatGptBackendOptions<Ctx>): ChatGptBackend<Ctx> {
  const dispatch: UpstreamFetch = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const now = options.now ?? Date.now
  const { source, exhaustion, hooks } = options
  const affinity = new AssignmentStore(MAX_CONVERSATIONS)
  const observed = new Map<string, ObservedSeatLimits>()
  const observedCredits = new Map<string, { credits: CodexCredits; at: number }>()
  const reserveRefusedUntil = new Map<string, number>()
  const modelRefusedUntil = new Map<string, number>()
  const reserveKey = (seat: string, model: string | undefined) => `${seat}\u0000${model ?? ""}`

  /** The newer of what a response stated and what the usage read found. */
  const creditsOf = (seat: string): CodexCredits | null => {
    const seen = observedCredits.get(seat)
    const read = options.credits?.(seat) ?? null
    if (seen && (!read || seen.at >= read.at)) return seen.credits
    return read?.credits ?? null
  }

  /** Whether the newer of the usage read and the last response's headers says a plan window is spent and not yet reset. */
  const readingSpent = (seat: string): boolean => {
    const seen = observed.get(seat)
    const read = options.planWindows?.(seat) ?? null
    if (seen && (!read || seen.at >= read.at)) return (chatGptCooldownUntil(seen.rateLimit, seen.at) ?? 0) > now()
    return !!read && read.windows.some(window => window.utilization !== null && window.utilization >= 1
      && (window.resetsAt === null || window.resetsAt > now()))
  }

  /** `seats` in the owner's rotation for `model`: its active seat first, then store order. */
  const inOwnerOrder = (seats: readonly string[], model: string | undefined): string[] => {
    const views = source.seats(model)
    const all = views.map(view => view.id)
    const start = Math.max(0, views.findIndex(view => view.active === true))
    const rank = new Map([...all.slice(start), ...all.slice(0, start)].map((seat, index) => [seat, index]))
    return [...new Set(seats)].sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER))
  }

  const lastServedOnCredits = new Map<string, boolean>()

  const bench = (seat: string, kind: ChatGptFailureKind, rateLimit: ChatGptRateLimit | null): number => {
    const until = kind === "requires_reauth"
      ? now() + REAUTH_COOLDOWN_MS
      : chatGptCooldownUntil(rateLimit, now()) ?? now() + DEFAULT_COOLDOWN_MS
    exhaustion.mark(seat, until, kind)
    return until
  }

  return {
    provider: "chatgpt",
    observedLimits: () => observed,

    forgetSeat(seat) {
      observed.delete(seat)
      observedCredits.delete(seat)
      lastServedOnCredits.delete(seat)
      exhaustion.forget(seat)
      for (const map of [reserveRefusedUntil, modelRefusedUntil]) {
        for (const key of [...map.keys()]) if (key.startsWith(`${seat}\u0000`)) map.delete(key)
      }
    },

    seatCreditState(seat) {
      const planSpent = (source.reserveSeats?.() ?? []).includes(seat)
        || exhaustion.snapshot().some(mark => mark.id === seat && mark.reason === "quota_spent")
        || readingSpent(seat)
      return { planSpent, servingOnCredits: planSpent && lastServedOnCredits.get(seat) === true }
    },

    async handle(request: UpstreamRequest<Ctx>) {
      const startedAt = now()
      const requestId = randomUUID()
      const imageOperation = isImageEndpoint(request.endpoint) ? request.endpoint : undefined
      if (request.endpoint !== "responses" && !imageOperation) {
        return errorResponse(404, "not_found_error",
          `This model is served by ChatGPT, which Meridian reaches through the Responses and Images APIs only. ${request.route} is not available for it.`)
      }

      const inbound = await options.inboundRequest(request.context)
      const rawBody = await inbound.text()
      let parsed: Record<string, unknown> | undefined
      try {
        parsed = asRecord(JSON.parse(rawBody) as unknown)
      } catch {
        parsed = undefined
      }
      if (!parsed) return errorResponse(400, "invalid_request_error", "Request body must be a JSON object")

      const model = typeof parsed.model === "string" ? parsed.model : undefined
      const requestSource = inbound.headers.get("x-meridian-source")?.slice(0, 64) || undefined
      const turn: ChatGptTurnInfo = { requestId, model, body: parsed, headers: inbound.headers }
      // An image request goes as the client wrote it: the Responses
      // adaptations (forced stream, store=false) mean nothing to that endpoint.
      const adapted = imageOperation
        ? { body: parsed, clientWantsStream: parsed.stream === true, applied: [] }
        : adaptResponsesBody(parsed, { reasoningSummary: options.reasoningSummary?.() })
      const attempts: ChatGptAttempt[] = []

      const report = (fields: Partial<ChatGptTurnEvent> & { status: number }) => {
        hooks?.onTurn?.({
          requestId, startedAt, requestModel: model ?? null, model: model ?? null, seat: null,
          stream: adapted.clientWantsStream, adaptations: adapted.applied, attempts,
          usage: null, ttfbMs: null, durationMs: now() - startedAt, error: null,
          reasoningSummaryEvents: 0, ...(requestSource ? { requestSource } : {}), ...fields,
        })
      }
      const fail = (response: Response, error: string) => {
        report({ status: response.status, error })
        return response
      }

      const route = options.route?.(turn) ?? { kind: "pool", excluded: new Set<string>() }
      if (route.kind === "refuse") return fail(route.response, route.error)

      const refused = await hooks?.admit?.(turn)
      if (refused) return fail(refused, "refused_by_admission")

      // Serialized once: every seat is offered exactly the same bytes.
      const outbound = JSON.stringify(adapted.body)
      const reasons = new Set<SeatUnavailableReason>()
      const cacheKey = typeof parsed.prompt_cache_key === "string" && parsed.prompt_cache_key ? parsed.prompt_cache_key : undefined
      // A warm has no business spending credits, whatever the policy says.
      const policyOf = (seat: string): ChatGptCreditsPolicy =>
        route.spendCredits === false ? "never" : options.creditsPolicy?.(seat) ?? "never"

      // Every seat this turn may reach, in the owner's order. A pinned seat is
      // tried even when the owner would not pick it: its own credential check
      // below says why it cannot serve, if it cannot.
      const stampedSpent = source.reserveSeats?.(model) ?? []
      const listed = route.kind === "pinned" ? [route.seat] : inOwnerOrder([...source.candidateSeats(model), ...stampedSpent], model)
      const routable = route.kind === "pool" ? listed.filter(seat => !route.excluded.has(seat)) : listed
      if (routable.length < listed.length) reasons.add("excluded")

      // A seat nobody has read yet may be drained already, and the backend
      // would bill its credits without being asked. Read once, bounded,
      // before such a seat is sent work it may not be allowed to pay for.
      let refreshed = false
      const refreshOnce = async () => {
        if (refreshed || !options.refreshCredits) return
        refreshed = true
        await options.refreshCredits()
      }
      if (options.planWindows && routable.some(seat => policyOf(seat) !== "immediately" && options.planWindows!(seat) === null && !observed.has(seat))) {
        await refreshOnce()
      }

      // Plan quota first; a spent plan only as the seat's policy allows. A
      // seat benched for any reason but its plan stays out entirely.
      const benched = new Map(exhaustion.snapshot().map(mark => [mark.id, mark.reason]))
      const planTier: string[] = []
      const immediate: string[] = []
      const reserve: string[] = []
      for (const seat of routable) {
        const reason = benched.get(seat)
        if (reason !== undefined && reason !== "quota_spent") { reasons.add("quota_exhausted"); continue }
        if (!stampedSpent.includes(seat) && reason === undefined && !readingSpent(seat)) { planTier.push(seat); continue }
        reasons.add("quota_exhausted")
        if ((reserveRefusedUntil.get(reserveKey(seat, model)) ?? 0) > now()) continue
        const policy = policyOf(seat)
        if (policy === "immediately") immediate.push(seat)
        else if (policy === "reserve") reserve.push(seat)
      }
      const payable = async (candidates: readonly string[]): Promise<string[]> => {
        if (candidates.length === 0) return []
        if (candidates.some(seat => creditsOf(seat) === null)) await refreshOnce()
        return candidates.filter(seat => creditsCanServe(creditsOf(seat)))
      }
      const onCreditsNow = new Set(await payable(immediate))

      // Free-plan seats with quota left, held out of the normal order: they
      // follow every paid seat with plan quota, then come before the seats
      // serving on credits or, under `after-credits`, after the reserve tier.
      const freeSeats = route.kind === "pool" ? route.free ?? new Set<string>() : new Set<string>()
      const lateFree: string[] = []
      const seats = ((): string[] => {
        const eligible = routable.filter(seat => planTier.includes(seat) || onCreditsNow.has(seat))
        const live = route.kind === "pool" && route.order ? inSavedOrder(eligible, route.order) : eligible
        const freePlan = live.filter(seat => freeSeats.has(seat) && planTier.includes(seat))
        const rest = live.filter(seat => !freePlan.includes(seat))
        let tiers: string[][]
        if (freePlan.length === 0) tiers = [live]
        else if (route.kind === "pool" && route.freeSeatOrder === "after-credits") {
          tiers = [rest]
          lateFree.push(...freePlan)
        } else {
          tiers = [rest.filter(seat => planTier.includes(seat)), freePlan, rest.filter(seat => !planTier.includes(seat))]
        }
        // The active seat leads its tier: a supervisor that moved the pointer
        // wants the next turn there, at the price of a cold cache. Otherwise a
        // conversation stays on the seat holding its prompt-cache prefix while
        // that seat can serve. Neither lifts a free seat over a paid one.
        const lead = tiers.find(tier => tier.length > 0) ?? []
        const active = route.kind === "pool" ? route.preferred : undefined
        const cached = cacheKey ? affinity.get(cacheKey)?.profileId : undefined
        const first = [active, cached].find(seat => seat !== undefined && lead.includes(seat))
        const ordered = tiers.flat()
        return first === undefined ? ordered : [first, ...ordered.filter(seat => seat !== first)]
      })()

      const refusals: ChatGptSeatRefusal[] = []
      let settled = false
      const settle = (servedBy: string | null) => {
        if (settled || refusals.length === 0) return
        settled = true
        hooks?.onRefusalsSettled?.({ requestId, refused: refusals, servedBy })
      }

      // The reserve tier: seats under the `reserve` policy whose plan quota is
      // spent but whose credits can still pay, offered only once every seat
      // above has been tried. A seat that already answered this turn is not
      // asked twice, and one that refused a credits turn for this model sits
      // out until its refusal's reset.
      const creditReserve = async (dispatched: ReadonlySet<string>): Promise<string[]> => {
        const held = await payable(reserve.filter(seat => !dispatched.has(seat)))
        return route.kind === "pool" && route.order ? inSavedOrder(held, route.order) : held
      }

      let spent: Response | undefined
      let spentKind: ChatGptFailureKind | undefined
      let modelRefusal: { seat: string; status: number; text: string; headers: Headers } | undefined
      // A seat that refused this model sits it out (MODEL_REFUSAL_MS). It is
      // asked again only when no other seat was, so a model that every seat
      // refuses still gets the backend's own answer, not "unavailable".
      const refusesModel = (seat: string) => (modelRefusedUntil.get(reserveKey(seat, model)) ?? 0) > now()
      const queue: Array<{ seat: string; onCredits: boolean }> = []
      const sittingOut: Array<{ seat: string; onCredits: boolean }> = []
      const enqueue = (seat: string, onCredits: boolean) => (refusesModel(seat) ? sittingOut : queue).push({ seat, onCredits })
      for (const seat of seats) enqueue(seat, onCreditsNow.has(seat))
      const dispatched = new Set<string>()
      let reserveQueued = false
      for (let next = 0; ; next++) {
        if (next === queue.length && !reserveQueued) {
          reserveQueued = true
          for (const seat of await creditReserve(dispatched)) enqueue(seat, true)
          for (const seat of lateFree) enqueue(seat, false)
        }
        if (next === queue.length && dispatched.size === 0 && sittingOut.length > 0) queue.push(sittingOut.shift()!)
        if (next === queue.length) break
        const { seat, onCredits } = queue[next]!
        let credential = await source.credentials(seat, { model, spendCredits: onCredits })
        // An expired token may have been rotated by its owner since the last
        // read: look once more before giving up on the seat.
        if (!credential.ok && credential.reason === "expired") credential = await source.credentials(seat, { model, reread: true, spendCredits: onCredits })
        if (!credential.ok) { reasons.add(credential.reason); continue }
        let authAttemptStartedAt = now()
        dispatched.add(seat)

        let retriedAuth = false
        for (;;) {
          const { url, headers } = imageOperation
            ? buildCodexImagesRequest(imageOperation, credential.account)
            : buildCodexRequest(adapted.body, credential.account)
          let upstream: Response
          try {
            upstream = await dispatch(url, { method: "POST", headers, body: outbound, redirect: "error", signal: inbound.signal })
          } catch {
            // Unreachable for one seat is unreachable for all; report the shape only.
            settle(null)
            return fail(errorResponse(502, "api_error", "The ChatGPT upstream could not be reached."), "upstream_unreachable")
          }

          const sniffed = await sniffChatGptFailure(upstream)
          const rateLimit = chatGptRateLimitFromHeaders(upstream.headers)
          if (rateLimit) observed.set(seat, { rateLimit, at: now() })
          const stated = chatGptCreditsFromHeaders(upstream.headers)
          if (stated) observedCredits.set(seat, { credits: stated, at: now() })
          attempts.push({ seat, status: upstream.status, failure: sniffed.failure?.kind ?? null })
          const headersOut = forwardHeaders(upstream)

          // Not a seat failure yet not a success: the request itself was
          // refused, and every other seat would refuse it the same way, so
          // no seat is benched and none is tried. Treating it as a success
          // would hand a non-stream client a bogus "stream ended" 502.
          // A refusal of the model itself is the exception: which models a
          // seat may use follows its plan, so the next seat is asked, and
          // this one sits out that model alone.
          if (!sniffed.failure && upstream.status >= 400) {
            const text = await new Response(sniffed.body).text()
            if (isModelRefusal(upstream.status, text)) {
              modelRefusedUntil.set(reserveKey(seat, model), now() + MODEL_REFUSAL_MS)
              modelRefusal = { seat, status: upstream.status, text, headers: headersOut }
              break
            }
            settle(null)
            report({ status: upstream.status, seat, error: "request_refused" })
            return refusalResponse(upstream.status, text, headersOut)
          }

          if (!sniffed.failure) {
            const until = chatGptCooldownUntil(rateLimit, now())
            if (until !== null) exhaustion.mark(seat, until, "quota_spent")
            if (cacheKey) affinity.set(cacheKey, { profileId: seat, requestId: undefined })
            lastServedOnCredits.set(seat, onCredits)
            settle(seat)
            // An image answer is one JSON document with no Responses events
            // to tap: it passes through as the provider sent it.
            if (imageOperation) {
              report({
                status: upstream.status, seat, ttfbMs: now() - startedAt,
                ...(onCredits ? { servedOnCredits: true } : {}),
              })
              return new Response(sniffed.body, { status: upstream.status, headers: headersOut })
            }
            const onDone = (summary: TapSummary) => report({
              status: upstream.status, seat, model: summary.model ?? model ?? null, usage: summary.usage,
              ...(onCredits ? { servedOnCredits: true } : {}),
              ttfbMs: summary.firstOutputAt === null ? null : summary.firstOutputAt - startedAt,
              reasoningSummaryEvents: summary.reasoningSummaryEvents,
              error: summary.interrupted ?? (summary.outcome && summary.outcome !== "completed" ? `response_${summary.outcome}` : null),
            })
            const tapped = tapResponsesStream(sniffed.body, onDone, now)
            if (adapted.clientWantsStream) return new Response(tapped, { status: upstream.status, headers: headersOut })
            const final = await aggregateResponsesStream(tapped)
            if (!final) return errorResponse(502, "api_error", "The ChatGPT stream ended without a final response.")
            return new Response(JSON.stringify(final), { status: 200, headers: { "content-type": "application/json" } })
          }

          // A provider-side fault says nothing about this seat; benching
          // healthy accounts during an incident would only deepen it.
          const failureKind = sniffed.failure.kind
          if (failureKind === "transient") {
            settle(null)
            report({ status: upstream.status, seat, error: "transient" })
            return new Response(sniffed.body, { status: upstream.status, headers: headersOut })
          }

          if (failureKind === "requires_reauth" && !retriedAuth) {
            // Re-read once: the owner may have rotated this token after we read it.
            const fresh = await source.credentials(seat, { model, reread: true, spendCredits: onCredits })
            if (fresh.ok && fresh.account.accessToken !== credential.account.accessToken) {
              void sniffed.body.cancel().catch(() => {})
              credential = fresh
              authAttemptStartedAt = now()
              retriedAuth = true
              continue
            }
          }

          const refusal: ChatGptSeatRefusal = {
            requestId, seat, kind: failureKind, status: upstream.status,
            until: bench(seat, failureKind, rateLimit), rateLimit, startedAt: authAttemptStartedAt,
          }
          refusals.push(refusal)
          if (onCredits) reserveRefusedUntil.set(reserveKey(seat, model), refusal.until)
          hooks?.onSeatRefused?.(refusal)
          if (failureKind === "requires_reauth") reasons.add("requires_reauth")
          void spent?.body?.cancel().catch(() => {})
          spent = new Response(sniffed.body, { status: upstream.status, headers: headersOut })
          spentKind = failureKind
          break
        }
      }
      settle(null)

      // A quota refusal is returned as the provider sent it, keeping its
      // status and stated wait. A refused credential is not: its body means
      // nothing actionable to the client, the reason below does.
      if (spent && spentKind !== "requires_reauth") {
        report({ status: spent.status, error: spentKind ?? "refused" })
        return spent
      }
      void spent?.body?.cancel().catch(() => {})

      if (modelRefusal) {
        report({ status: modelRefusal.status, seat: modelRefusal.seat, error: "request_refused" })
        return refusalResponse(modelRefusal.status, modelRefusal.text, modelRefusal.headers)
      }

      const fallback = await hooks?.onPoolExhausted?.({ ...turn, reasons })
      if (fallback) return fallback

      const message = source.describeUnavailable(reasons)
      // No seat at all is a sign-in to do, not an outage to wait out.
      const auth = reasons.has("expired") || reasons.has("requires_reauth") || source.seats().length === 0
      const quota = !auth && reasons.size > 0 && [...reasons].every(r => r === "quota_exhausted" || r === "cooling_down")
      const response = auth
        ? errorResponse(401, "authentication_error", message)
        : quota ? errorResponse(429, "rate_limit_error", message) : errorResponse(503, "overloaded_error", message)
      return fail(response, auth ? "chatgpt_auth_unavailable" : quota ? "chatgpt_quota_exhausted" : "chatgpt_unavailable")
    },
  }
}
