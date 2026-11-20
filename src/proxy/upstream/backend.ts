/**
 * The provider-neutral upstream seam.
 *
 * Meridian's inbound surfaces — the Anthropic Messages API and the OpenAI
 * Responses API — describe the CLIENT. Which vendor actually serves a request
 * is a separate axis: a Codex CLI client may legitimately be served by Claude
 * today and by another provider tomorrow. `AgentAdapter` already owns the
 * first axis (session headers, working-directory parsing, tool mappings), so
 * overloading it with the second would collapse two independent questions
 * into one. This registry owns the second axis and nothing else.
 *
 * The boundary is ONE COMPLETE PROVIDER REQUEST: credentials, streaming,
 * failure classification and account rotation all live inside `handle`. A
 * seam any deeper would force a non-Claude backend to synthesize Agent SDK
 * events, session ids and resume semantics it does not have, and every
 * synthesized value would be somewhere a foreign request could leak into
 * Claude's machinery. The high seam costs some duplication and buys a wall.
 *
 * Provider-neutral by construction: no vendor name appears here beyond the
 * `ProviderId` union, and the module is generic over the HTTP context type so
 * it never imports Hono — server.ts remains the only module that touches HTTP
 * concerns (ARCHITECTURE.md, dependency rule 4).
 */

export type ProviderId = "claude" | "chatgpt"

/**
 * Which inbound API surface a request arrived on.
 *
 * Distinct from the route string on purpose: `/v1/messages` and `/messages`
 * are two routes onto one surface. A backend cares about the surface; the
 * queue wrapper and telemetry care about the route the client actually called.
 *
 * The two image operations of the OpenAI Images API are surfaces of their own
 * rather than one surface told apart by route: they reach different upstream
 * endpoints, and only a provider that generates images serves them.
 */
export type UpstreamEndpoint = "messages" | "responses" | "image_generations" | "image_edits"

export type ImageEndpoint = Extract<UpstreamEndpoint, "image_generations" | "image_edits">

export function isImageEndpoint(endpoint: UpstreamEndpoint): endpoint is ImageEndpoint {
  return endpoint === "image_generations" || endpoint === "image_edits"
}

export interface UpstreamRequest<Ctx> {
  /** The inbound HTTP context, owned and shaped by the HTTP layer. */
  readonly context: Ctx
  /** The inbound API surface. */
  readonly endpoint: UpstreamEndpoint
  /** The route the client called, preserved verbatim. */
  readonly route: string
  readonly clientSessionId?: string
}

export interface UpstreamBackend<Ctx> {
  readonly provider: ProviderId
  handle(request: UpstreamRequest<Ctx>): Promise<Response>
}

/**
 * Thrown when a request resolves to a provider with no backend registered.
 *
 * Typed rather than a bare Error because a caller has to tell it apart from
 * an upstream failure: it means "this deployment cannot serve this model",
 * which is a configuration answer and not something a retry can fix.
 */
export class UnknownProviderError extends Error {
  readonly provider: string

  constructor(provider: string) {
    super(`No upstream backend is registered for provider "${provider}"`)
    this.name = "UnknownProviderError"
    this.provider = provider
  }
}

export interface UpstreamRegistry<Ctx> {
  registerBackend(backend: UpstreamBackend<Ctx>): void
  /** @throws UnknownProviderError when nothing is registered for `provider`. */
  backendFor(provider: ProviderId): UpstreamBackend<Ctx>
  registeredProviders(): ProviderId[]
}

/**
 * Create a registry.
 *
 * Per-instance rather than module-global. `createProxyServer` can be called
 * many times in one process — the test suite does it constantly — and each
 * server's backends close over that server's own config and handlers. A
 * module-global map would let one instance's wiring answer another instance's
 * request, which is the kind of cross-talk that only ever shows up as a
 * mystifying failure in an unrelated test.
 */
export function createUpstreamRegistry<Ctx>(): UpstreamRegistry<Ctx> {
  const backends = new Map<ProviderId, UpstreamBackend<Ctx>>()

  return {
    registerBackend(backend) {
      backends.set(backend.provider, backend)
    },

    backendFor(provider) {
      const backend = backends.get(provider)
      // No fallback, deliberately. Handing back "the only backend we have"
      // is precisely how a request for one vendor gets served by another
      // vendor's account.
      if (!backend) throw new UnknownProviderError(provider)
      return backend
    },

    registeredProviders() {
      return [...backends.keys()]
    },
  }
}
