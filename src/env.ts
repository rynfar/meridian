/**
 * Environment variable resolution with backward-compatible aliases.
 *
 * New MERIDIAN_* names take precedence over legacy CLAUDE_PROXY_* names.
 * Both are supported indefinitely to avoid breaking existing deployments.
 */

/**
 * Resolve an env var with MERIDIAN_ prefix, falling back to CLAUDE_PROXY_ prefix.
 * Returns undefined if neither is set.
 */
export function env(suffix: string): string | undefined {
  return process.env[`MERIDIAN_${suffix}`] ?? process.env[`CLAUDE_PROXY_${suffix}`]
}

/**
 * Resolve an env var with a default value.
 */
export function envOr(suffix: string, defaultValue: string): string {
  return env(suffix) ?? defaultValue
}

/**
 * Resolve a boolean env var (truthy = "1", "true", "yes").
 */
export function envBool(suffix: string): boolean {
  const val = env(suffix)
  return val === "1" || val === "true" || val === "yes"
}

/**
 * Resolve passthrough mode from the env var (`MERIDIAN_PASSTHROUGH`, falling
 * back to `CLAUDE_PROXY_PASSTHROUGH`), applying an adapter-specific default
 * when the var is unset or holds an unrecognized value.
 *
 * Recognized: "1"/"true"/"yes" → true, "0"/"false"/"no" → false.
 *
 * This is the single source of truth for passthrough parsing. Each adapter's
 * `usesPassthrough()` and its transform both call it with the same default, so
 * they can never drift (the transform-parity tests enforce the pairing).
 *
 * @param defaultValue used when neither env var is set (or is unrecognized).
 *   Passthrough-by-default adapters pass `true` (opt out with `=0`); opt-in
 *   adapters pass `false` (opt in with `=1`).
 */
export function resolvePassthrough(defaultValue: boolean): boolean {
  const val = env("PASSTHROUGH")
  if (val === "1" || val === "true" || val === "yes") return true
  if (val === "0" || val === "false" || val === "no") return false
  return defaultValue
}

/**
 * Resolve an integer env var with a default.
 */
export function envInt(suffix: string, defaultValue: number): number {
  const val = env(suffix)
  if (!val) return defaultValue
  const parsed = parseInt(val, 10)
  return Number.isFinite(parsed) ? parsed : defaultValue
}
