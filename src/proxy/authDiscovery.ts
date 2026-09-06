/**
 * What Anthropic told us during authentication, rendered safe to log.
 *
 * Three payloads decide what Meridian knows about an account — the token
 * endpoint's response, `GET /api/oauth/profile`, and `claude auth status` —
 * and none of them is currently observable. When a field is absent, or renamed,
 * or Anthropic starts returning a plan tier nobody has seen before, the only
 * symptom downstream is a profile that reads `unknown`, with nothing in any log
 * to say whether the field was missing from the response or dropped on the way
 * to disk. That distinction is the whole of the diagnosis.
 *
 * The obstacle is that two of those payloads carry credentials, so they cannot
 * simply be logged. `logger.ts`'s `sanitize()` redacts by key name, which is
 * the wrong polarity here: it protects the names somebody already thought of,
 * and a field discovered tomorrow is by definition not one of them.
 *
 * So this inverts it. Every string is redacted to its length unless its key is
 * on an allow-list of values known to carry no secret. A new field is therefore
 * reported by NAME and TYPE — enough to see it arrived and to decide what it is
 * — while its contents stay out of the log until somebody deliberately adds it
 * to the list.
 *
 * This is a leaf module — pure, no imports.
 */

/**
 * String-valued keys whose contents are safe to print.
 *
 * Every one is either a duration, a timestamp, an enum Anthropic publishes, or
 * the scope list that already appears in plaintext in the authorize URL. A key
 * that identifies a person or an organization is deliberately absent: `email`,
 * `email_address`, `name`, `display_name` and `uuid` are all reported by length
 * only, because a debug log is routinely pasted into an issue.
 */
export const SAFE_AUTH_STRING_KEYS: ReadonlySet<string> = new Set([
  "token_type",
  "expires_at",
  "expires_in",
  "refresh_token_expires_at",
  "refresh_token_expires_in",
  "scope",
  "scopes",
  "organization_type",
  "rate_limit_tier",
  "billing_type",
  "subscriptionType",
  "rateLimitTier",
])

/**
 * Non-string primitives are printed as they are.
 *
 * A boolean or a number cannot meaningfully be a credential — `true` and `3600`
 * carry no secret — and they are exactly the fields worth reading: `loggedIn`,
 * `expires_in`, and whatever `has_*` flag Anthropic adds next.
 */
function describeValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "string") {
    return SAFE_AUTH_STRING_KEYS.has(key) ? value : `[string len=${value.length}]`
  }
  if (typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return value.map((item) => describeValue(key, item))
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = describeValue(k, v)
    }
    return out
  }
  return `[${typeof value}]`
}

/**
 * Render a parsed auth response as a loggable field map.
 *
 * The shape mirrors the payload rather than flattening it, so a nested
 * `organization.rate_limit_tier` reads the same way in the log as it does in
 * Anthropic's documentation and in the code that consumes it.
 */
export function describeAuthFields(payload: unknown): unknown {
  return describeValue("", payload)
}

/**
 * The keys a payload actually carried, nested ones included, as dotted paths.
 *
 * Logged alongside the described payload because it is the line worth grepping:
 * comparing two logins reduces to comparing two key lists, which answers "did
 * this account's response even contain the field" without reading the values at
 * all.
 */
export function authFieldPaths(payload: unknown, prefix = ""): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return []
  const paths: string[] = []
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    paths.push(path)
    paths.push(...authFieldPaths(value, path))
  }
  return paths
}
