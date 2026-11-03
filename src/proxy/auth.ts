/**
 * Optional API key authentication middleware.
 *
 * When MERIDIAN_API_KEY is set, requests to protected routes must include
 * a matching key via `x-api-key` header or `Authorization: Bearer` header,
 * or carry the browser session cookie set by `POST /login`.
 * When unset, all routes are open (default behavior, backward compatible).
 *
 * The cookie exists for the admin pages. An API client always has a place to
 * put a header; a browser navigating to /profiles has none, so with the key
 * set it could never open the page. The cookie never holds the key itself —
 * it holds a MAC of the key, so a cookie read out of a browser profile does
 * not hand over the credential API clients use. Setting and clearing it is the
 * job of the /login and /logout routes in server.ts; this module only decides
 * whether a presented cookie is good.
 *
 * Uses constant-time comparison to prevent timing attacks.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import type { Context, Next } from "hono"

/** Name of the browser session cookie set by POST /login. */
export const LOGIN_COOKIE = "meridian_session"

/** How long a browser stays signed in. Re-presenting the key is cheap. */
export const LOGIN_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

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

/** Whether `provided` is the configured key. False when auth is off. */
export function keyMatches(provided: string): boolean {
  const key = getConfiguredKey()
  return Boolean(key) && safeCompare(provided, key!)
}

/**
 * The value the session cookie carries for a given key: a MAC, not the key.
 * Deterministic on purpose, so every browser signed in with the same key
 * holds the same cookie and rotating the key signs all of them out at once.
 */
export function sessionCookieValue(key: string): string {
  return createHmac("sha256", "meridian-session").update(key).digest("hex")
}

/** Cookie attributes for POST /login. `Secure` only when served over https: the LAN endpoint is plain http. */
export function loginCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "Strict" as const,
    path: "/",
    maxAge: LOGIN_COOKIE_MAX_AGE_SECONDS,
    ...(secure ? { secure: true } : {}),
  }
}

/** The named cookie out of a raw `Cookie` header, or undefined. */
function cookieValue(cookieHeader: string | undefined | null, name: string): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return part.slice(eq + 1).trim()
    }
  }
  return undefined
}

function keyFromHeaders(apiKey: string | undefined | null, authorization: string | undefined | null): string | undefined {
  if (apiKey) return apiKey
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7)
  return undefined
}

/**
 * Whether the request authenticates. A header, when present, is the answer:
 * a wrong explicit header is not rescued by a cookie. Without a header the
 * session cookie is consulted.
 */
function authenticates(
  key: string,
  apiKey: string | undefined | null,
  authorization: string | undefined | null,
  cookieHeader: string | undefined | null,
): boolean {
  const provided = keyFromHeaders(apiKey, authorization)
  if (provided !== undefined) return safeCompare(provided, key)
  const cookie = cookieValue(cookieHeader, LOGIN_COOKIE)
  return cookie !== undefined && safeCompare(cookie, sessionCookieValue(key))
}

/** Shared by the Hono default backend and standard-Request runtime backends. */
export function hasValidApiKey(headers: Headers): boolean {
  const key = getConfiguredKey()
  if (!key) return true
  return authenticates(key, headers.get("x-api-key"), headers.get("authorization"), headers.get("cookie"))
}

/**
 * A browser navigating to a page, as opposed to a script or API client: a GET
 * that asks for HTML and presents no key header. Such a caller cannot add a
 * header, so a 401 body would be a dead end; it is sent to /login instead.
 */
function isBrowserNavigation(c: Context): boolean {
  if (c.req.method !== "GET") return false
  if (c.req.header("x-api-key") || c.req.header("authorization")) return false
  return (c.req.header("accept") || "").includes("text/html")
}

/**
 * Hono middleware that rejects requests without a valid API key.
 * No-op when MERIDIAN_API_KEY is not set.
 */
export async function requireAuth(c: Context, next: Next) {
  const key = getConfiguredKey()
  if (!key) return next()

  if (authenticates(key, c.req.header("x-api-key"), c.req.header("authorization"), c.req.header("cookie"))) {
    return next()
  }

  if (isBrowserNavigation(c)) {
    const target = c.req.path + (c.req.url.includes("?") ? c.req.url.slice(c.req.url.indexOf("?")) : "")
    return c.redirect(`/login?next=${encodeURIComponent(target)}`, 302)
  }

  return c.json({
    type: "error",
    error: {
      type: "authentication_error",
      message: "Invalid or missing API key",
    },
  }, 401)
}
