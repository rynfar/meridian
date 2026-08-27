/**
 * Where Meridian keeps its own configuration.
 *
 * One directory holds everything Meridian persists for itself — settings.json,
 * profiles.json, the per-profile CLAUDE_CONFIG_DIRs under profiles/,
 * adapter-instances.json, sdk-features.json, model-pricing.json, telemetry.db.
 * `MERIDIAN_CONFIG_DIR` moves that directory, so a second instance pointed at
 * an empty one gets its own everything rather than inheriting the first
 * instance's accounts.
 *
 * Resolved per call, never frozen at import time. A module-level constant is
 * computed before the CLI has parsed argv or a test has set the variable, and
 * can then be changed by neither.
 *
 * NOTE: deliberately does NOT honour XDG_CONFIG_HOME — anyone who has that set
 * would silently relocate to a different config directory and appear to lose
 * everything in it.
 *
 * NOTE: read straight from process.env rather than through env.ts, which would
 * also accept a CLAUDE_PROXY_CONFIG_DIR alias. This variable postdates that
 * prefix, so there is no legacy deployment to stay compatible with and no
 * reason to start accepting a second name for it.
 */

import { join } from "node:path"
import { homedir } from "node:os"

/** The directory used when MERIDIAN_CONFIG_DIR is unset. */
export function defaultConfigDir(): string {
  return join(homedir(), ".config", "meridian")
}

/** The directory Meridian's configuration lives in. */
export function configDir(): string {
  return process.env.MERIDIAN_CONFIG_DIR || defaultConfigDir()
}

/** A path inside the config directory, e.g. `configPath("profiles.json")`. */
export function configPath(...segments: string[]): string {
  return join(configDir(), ...segments)
}
