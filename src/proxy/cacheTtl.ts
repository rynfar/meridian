/**
 * Per-request prompt-cache lifetime (`x-meridian-cache-ttl`). Leaf module.
 *
 * The CLI chooses how long its cache entries live, and on a subscription it
 * writes the one-hour tier. `5m` pins it to the five-minute tier for the
 * request, as auxiliary requests already are. See proxy-core SPEC, Decisions.
 */

export const CACHE_TTL_HEADER = "x-meridian-cache-ttl"

export type CacheTtlRequest =
  | { ok: true; env: Record<string, string> | undefined }
  | { ok: false; value: string }

/** The env a request's header adds to the CLI, or the value it refused. */
export function cacheTtlFromHeader(value: string | undefined): CacheTtlRequest {
  if (value === undefined || value.trim() === "") return { ok: true, env: undefined }
  if (value.trim().toLowerCase() === "5m") return { ok: true, env: { FORCE_PROMPT_CACHING_5M: "1" } }
  return { ok: false, value }
}

/** The answer to a request whose header asks for a lifetime this proxy does not offer. */
export function invalidCacheTtlResponse(value: string): Response {
  return new Response(JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: `${CACHE_TTL_HEADER} accepts only "5m" (got "${value}"); leave it out to keep the CLI's own choice`,
    },
  }), { status: 400, headers: { "Content-Type": "application/json" } })
}
