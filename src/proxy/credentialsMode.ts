/**
 * Read-only credential mode — `MERIDIAN_CREDENTIALS_READONLY`.
 *
 * Lets a second Meridian instance run beside a production one against the
 * SAME credential files without being able to corrupt them. When set, the
 * instance never initiates a token refresh and never writes a credential; it
 * re-reads credentials from disk so refreshes performed by the OTHER instance
 * are picked up.
 *
 * The hazard this exists for: two instances holding the same OAuth refresh
 * token. Meridian refreshes proactively on boot and on a 45s cadence. If
 * Anthropic rotates the refresh token on use, whichever instance refreshes
 * first invalidates the other's copy, and recovery is an interactive
 * `claude login` per account.
 *
 * Sharing is not a choice the operator makes, which is why this is the only
 * defence rather than one layer of several. `MERIDIAN_CONFIG_DIR` relocates
 * `settings.json` and nothing else: `profiles.json` is a module-level constant
 * in `profiles.ts`, so every instance on a machine reads the same profile
 * list, pointing at the same `claudeConfigDir` credential directories. There
 * is no supported way to give a second instance a different profile set, so
 * any second instance holds the first one's real accounts from the moment it
 * boots. This flag is what stops it writing to them.
 *
 * Env var rather than a settings key on purpose: settings are editable from
 * the web UI, and switching this on for the production instance by accident
 * would silently stop it refreshing its own tokens. The systemd unit is
 * already where the two instances differ.
 *
 * Leaf module — no imports from server.ts or session/.
 */

import { envBool } from "../env"

/**
 * Whether this instance is forbidden from refreshing or writing credentials.
 *
 * Resolved per call rather than frozen at import time, matching
 * `settings.ts`'s treatment of MERIDIAN_CONFIG_DIR: module-level credential
 * stores are constructed at import, so a value captured then would be fixed
 * before any test (or embedding host) could set it.
 */
export function isCredentialsReadOnly(): boolean {
  return envBool("CREDENTIALS_READONLY")
}

/**
 * Report a refused credential write, loudly, and return false so the caller
 * takes its existing write-failed path.
 *
 * Deliberately `console.error` and not `claudeLog`: the latter is gated behind
 * OPENCODE_CLAUDE_PROVIDER_DEBUG, so in a normal deployment it prints nothing.
 *
 * Why failing LOUDLY beats failing safe here: this refusal is the backstop for
 * a write path nobody thought of. Silently swallowing it would leave an
 * operator believing the guarantee held while some future call site quietly
 * did nothing — and the failure it is protecting against (a corrupted token
 * file that a production instance depends on, costing an interactive
 * `claude login` across every account, including borrowed ones) is expensive
 * and manual to recover from. A noisy log that turns out to be benign costs a
 * grep; a silent one costs the fleet. If this line ever appears, the correct
 * response is to find the call site and gate it upstream of the store.
 *
 * @param operation  short label for the call site (e.g. "oauth-refresh")
 * @param target     store identity — a path or keychain service, NEVER a value
 */
export function refuseCredentialWrite(operation: string, target: string): false {
  console.error(
    `[PROXY] REFUSED credential write (${operation} → ${target}): ` +
    `MERIDIAN_CREDENTIALS_READONLY is set, so this instance must not modify credentials. ` +
    `If this is unexpected, the calling code path is missing a read-only guard.`
  )
  return false
}

/** Startup banner state — the mode is announced once per process. */
let bannerLogged = false

/**
 * Announce the mode once at startup, unmistakably.
 *
 * An instance silently in read-only mode when you thought it was normal is a
 * confusing bug — tokens quietly stop being refreshed. An instance loudly in
 * it is self-documenting.
 *
 * Not gated on `silent`, unlike the rest of the startup output: MERIDIAN_SILENT
 * suppresses routine chatter, and this is not routine — it is a non-default
 * operating mode that changes what the process is allowed to do. One line,
 * once, and only when the flag is actually set.
 */
export function logCredentialsModeBanner(): void {
  if (bannerLogged || !isCredentialsReadOnly()) return
  bannerLogged = true
  console.warn(
    `[PROXY] CREDENTIALS READ-ONLY MODE (MERIDIAN_CREDENTIALS_READONLY): ` +
    `this instance will not refresh or write OAuth credentials. ` +
    `Token rotation is another instance's job; credentials are re-read from disk.`
  )
}

/** Reset the once-per-process banner — for testing only. */
export function resetCredentialsModeBanner(): void {
  bannerLogged = false
}
