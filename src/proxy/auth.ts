/**
 * Optional API key authentication middleware.
 *
 * When MERIDIAN_API_KEY is set, requests to protected routes must include
 * a matching key via `x-api-key` header or `Authorization: Bearer` header.
 * When unset, all routes are open (default behavior, backward compatible).
 *
 * Uses constant-time comparison to prevent timing attacks.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import type { Context, Next } from "hono"

function getConfiguredKey(): string | undefined {
  return process.env.MERIDIAN_API_KEY || undefined
}

/**
 * Whether API key authentication is enabled.
 * True when MERIDIAN_API_KEY is set to a non-empty value.
 */
export function authEnabled(): boolean {
  return Boolean(getConfiguredKey())
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Hashes both values to ensure equal-length comparison regardless of input.
 */
function safeCompare(a: string, b: string): boolean {
  const hashA = createHmac("sha256", "meridian").update(a).digest()
  const hashB = createHmac("sha256", "meridian").update(b).digest()
  return timingSafeEqual(hashA, hashB)
}

/**
 * Extract the API key from the request.
 * Checks x-api-key header first, then Authorization: Bearer.
 */
function extractKey(c: Context): string | undefined {
  const apiKey = c.req.header("x-api-key")
  if (apiKey) return apiKey

  const auth = c.req.header("authorization")
  if (auth?.startsWith("Bearer ")) return auth.slice(7)

  return undefined
}

/**
 * Hono middleware that rejects requests without a valid API key.
 * No-op when MERIDIAN_API_KEY is not set.
 */
export async function requireAuth(c: Context, next: Next) {
  const key = getConfiguredKey()
  if (!key) return next()

  const provided = extractKey(c)
  if (!provided || !safeCompare(provided, key)) {
    return c.json({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Invalid or missing API key",
      },
    }, 401)
  }

  return next()
}
