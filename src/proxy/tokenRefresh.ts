/**
 * Cross-platform OAuth token refresh for Claude Code credentials.
 *
 * Storage backends:
 *   macOS  — system Keychain via /usr/bin/security (no prompt — pre-authorised)
 *   Linux  — ~/.claude/.credentials.json
 *
 * The credential store is dependency-injectable for testing. Production code
 * uses createPlatformCredentialStore() which picks the right backend
 * automatically.
 *
 * Concurrent calls to refreshOAuthToken() are deduplicated: if a refresh is
 * already in flight, subsequent callers wait for the same promise rather than
 * issuing a second network request and racing on the write.
 */

import { execFile as execFileCb } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, platform, userInfo } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { claudeLog } from "../logger"

const execFile = promisify(execFileCb)

const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const KEYCHAIN_SERVICE = "Claude Code-credentials"
const CREDENTIALS_FILE = `${homedir()}/.claude/.credentials.json`
const DEFAULT_CLAUDE_DIR = `${homedir()}/.claude`

/**
 * Map a `claudeConfigDir` to the keychain service name claude-code uses
 * for that directory.
 *
 * Default `~/.claude` uses the bare service name `Claude Code-credentials`.
 * Any other directory uses `Claude Code-credentials-<sha256(absPath).slice(0,8)>` —
 * matching claude-code's own convention so we can read OAuth tokens for
 * additional Meridian profiles without prompting the user.
 */
export function configDirToKeychainService(claudeConfigDir: string): string {
  const abs = resolve(claudeConfigDir)
  if (abs === resolve(DEFAULT_CLAUDE_DIR)) return KEYCHAIN_SERVICE
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 8)
  return `${KEYCHAIN_SERVICE}-${hash}`
}

/** Map `claudeConfigDir` to the file-based credentials path. */
export function configDirToCredentialsFile(claudeConfigDir: string): string {
  return join(resolve(claudeConfigDir), ".credentials.json")
}

interface OAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  /**
   * When the *refresh* token itself stops working — i.e. when the login dies
   * and an interactive `claude login` becomes mandatory. Written by the CLI at
   * login; optional because nothing guarantees its presence.
   *
   * Distinct from `expiresAt`, which is the ~8h access-token lifetime that the
   * background scheduler rolls on its own. No amount of refreshing extends
   * this one unless Anthropic hands back a new value (see `doRefresh`).
   */
  refreshTokenExpiresAt?: number
  scopes?: string[]
  subscriptionType?: string
  rateLimitTier?: string
}

interface CredentialsFile {
  claudeAiOauth: OAuthCredentials
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Credential store interface — injectable for testing
// ---------------------------------------------------------------------------

export interface CredentialStore {
  /** Stable identity for in-flight refresh deduplication across store instances. */
  refreshKey?: string
  read(): Promise<CredentialsFile | null>
  write(credentials: CredentialsFile): Promise<boolean>
}

/**
 * Serialize a credentials object to the on-disk / Keychain format Claude Code
 * expects.
 *
 * MUST be compact (no whitespace) — Claude Code's credential parser cannot
 * read pretty-printed JSON and treats the user as logged out when it
 * encounters one. See issue #452.
 *
 * Exported so the regression test can pin the output format directly.
 */
export function serializeCredentials(credentials: CredentialsFile): string {
  return JSON.stringify(credentials)
}

// ---------------------------------------------------------------------------
// macOS Keychain backend
// ---------------------------------------------------------------------------
//
// Claude Code stores credentials as hex-encoded JSON in the Keychain after
// `claude login`. Older installs may store raw JSON. We detect on read and
// preserve the original encoding on write so Claude Code can always read back
// what we write.

function parseKeychainValue(raw: string): { credentials: CredentialsFile; wasHex: boolean } | null {
  const trimmed = raw.trim()
  // Try raw JSON first
  try {
    return { credentials: JSON.parse(trimmed) as CredentialsFile, wasHex: false }
  } catch {}
  // Try hex-decoded JSON (Claude Code's format after `claude login`)
  try {
    const decoded = Buffer.from(trimmed, "hex").toString("utf-8")
    return { credentials: JSON.parse(decoded) as CredentialsFile, wasHex: true }
  } catch {}
  return null
}

// Track encoding format across read → write within the same refresh call.
// Keyed by service name so per-profile stores don't clobber each other.
const keychainWasHexByService = new Map<string, boolean>()

function buildMacosStore(serviceName: string): CredentialStore {
  return {
    refreshKey: `keychain:${serviceName}`,

    async read() {
      try {
        const { stdout } = await execFile(
          "/usr/bin/security",
          ["find-generic-password", "-s", serviceName, "-a", userInfo().username, "-w"],
          { timeout: 5000 }
        )
        const parsed = parseKeychainValue(stdout)
        if (!parsed) throw new Error("Could not parse keychain value as JSON or hex-encoded JSON")
        keychainWasHexByService.set(serviceName, parsed.wasHex)
        return parsed.credentials
      } catch (err) {
        claudeLog("token_refresh.keychain_read_failed", { service: serviceName, error: String(err) })
        return null
      }
    },

    async write(credentials) {
      const json = serializeCredentials(credentials)
      const wasHex = keychainWasHexByService.get(serviceName) ?? false
      // Write back in the same encoding Claude Code expects — hex after `claude login`.
      const value = wasHex ? Buffer.from(json).toString("hex") : json
      try {
        await execFile(
          "/usr/bin/security",
          ["add-generic-password", "-U", "-s", serviceName, "-a", userInfo().username, "-w", value],
          { timeout: 5000 }
        )
        return true
      } catch (err) {
        claudeLog("token_refresh.keychain_write_failed", { service: serviceName, error: String(err) })
        return false
      }
    },
  }
}

const macosStore: CredentialStore = buildMacosStore(KEYCHAIN_SERVICE)

// ---------------------------------------------------------------------------
// Linux / file backend
// ---------------------------------------------------------------------------

function buildFileStore(filePath: string): CredentialStore {
  const absPath = resolve(filePath)
  return {
    refreshKey: `file:${absPath}`,

    async read() {
      try {
        if (!existsSync(absPath)) return null
        return JSON.parse(readFileSync(absPath, "utf-8")) as CredentialsFile
      } catch (err) {
        claudeLog("token_refresh.file_read_failed", { path: absPath, error: String(err) })
        return null
      }
    },

    async write(credentials) {
      try {
        // Ensure parent dir exists for non-default paths.
        mkdirSync(dirname(absPath), { recursive: true })
        writeFileSync(absPath, serializeCredentials(credentials), "utf-8")
        return true
      } catch (err) {
        claudeLog("token_refresh.file_write_failed", { path: absPath, error: String(err) })
        return false
      }
    },
  }
}


const fileStore: CredentialStore = buildFileStore(CREDENTIALS_FILE)

/**
 * Returns the appropriate credential store for the current platform.
 *
 * If `claudeConfigDir` is provided, returns a profile-specific store that
 * reads from the matching keychain entry (macOS) or `<dir>/.credentials.json`
 * (Linux). Default behaviour (no opts) is unchanged — reads from the
 * standard `~/.claude` location.
 */
export function createPlatformCredentialStore(opts?: { claudeConfigDir?: string }): CredentialStore {
  if (opts?.claudeConfigDir) {
    if (platform() === "darwin") {
      return buildMacosStore(configDirToKeychainService(opts.claudeConfigDir))
    }
    return buildFileStore(configDirToCredentialsFile(opts.claudeConfigDir))
  }
  return platform() === "darwin" ? macosStore : fileStore
}

/** Look up the appropriate file path for a profile (Linux convention even on macOS for inspection). */
export function credentialsFilePathForProfile(claudeConfigDir?: string): string {
  return claudeConfigDir ? configDirToCredentialsFile(claudeConfigDir) : CREDENTIALS_FILE
}

/**
 * What the stored credential says about this account's ability to authenticate.
 *
 * `unknown` is deliberately NOT a soft `absent`. `read()` answers `null` both
 * for a credential that is not there and for one it could not parse, so from
 * here the two are indistinguishable - and a Keychain that momentarily refuses,
 * or a file caught mid-write, must never be allowed to report a working account
 * as logged out. Only a credential that was read successfully and carries no
 * access token is `absent`.
 */
export type StoredCredentialPresence = "present" | "absent" | "unknown"

export async function readStoredCredentialPresence(
  store: CredentialStore,
): Promise<StoredCredentialPresence> {
  let credentials: CredentialsFile | null
  try {
    credentials = await store.read()
  } catch {
    return "unknown"
  }
  if (!credentials) return "unknown"
  const accessToken = credentials.claudeAiOauth?.accessToken
  return typeof accessToken === "string" && accessToken.length > 0 ? "present" : "absent"
}

// ---------------------------------------------------------------------------
// OAuth refresh
// ---------------------------------------------------------------------------

/** In-flight refresh promises — deduplicates concurrent callers per credential store. */
const inflightRefreshByKey = new Map<string, Promise<boolean>>()
const inflightRefreshByStore = new WeakMap<CredentialStore, Promise<boolean>>()

/**
 * Refresh the Claude Code OAuth access token.
 *
 * Reads the stored refresh token, exchanges it for a new access token via
 * Anthropic's OAuth endpoint, and writes the updated credentials back.
 *
 * Returns true on success, false on any failure. Concurrent calls share one
 * in-flight request so only one network round-trip is made.
 *
 * @param store  Override the credential store (for testing).
 */
export async function refreshOAuthToken(store?: CredentialStore): Promise<boolean> {
  const s = store ?? createPlatformCredentialStore()
  const refreshKey = s.refreshKey
  if (refreshKey) {
    const inflight = inflightRefreshByKey.get(refreshKey)
    if (inflight) return inflight

    const refresh = doRefresh(s).finally(() => {
      inflightRefreshByKey.delete(refreshKey)
    })
    inflightRefreshByKey.set(refreshKey, refresh)
    return refresh
  }

  const inflight = inflightRefreshByStore.get(s)
  if (inflight) return inflight

  const refresh = doRefresh(s).finally(() => {
    inflightRefreshByStore.delete(s)
  })
  inflightRefreshByStore.set(s, refresh)
  return refresh
}

async function doRefresh(store: CredentialStore): Promise<boolean> {
  const credentials = await store.read()
  if (!credentials) {
    claudeLog("token_refresh.no_credentials", {})
    return false
  }

  const { refreshToken } = credentials.claudeAiOauth
  if (!refreshToken) {
    claudeLog("token_refresh.no_refresh_token", {})
    return false
  }

  let response: Response
  try {
    response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    claudeLog("token_refresh.request_failed", { error: String(err) })
    return false
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    claudeLog("token_refresh.bad_response", { status: response.status, body })
    return false
  }

  let tokenData: {
    access_token: string
    refresh_token?: string
    expires_in?: number
    expires_at?: number
    refresh_token_expires_at?: number
    refresh_token_expires_in?: number
  }
  try {
    tokenData = await response.json() as typeof tokenData
  } catch (err) {
    claudeLog("token_refresh.parse_failed", { error: String(err) })
    return false
  }

  const now = Date.now()
  const expiresAt =
    tokenData.expires_at ??
    (tokenData.expires_in ? now + tokenData.expires_in * 1000 : now + 8 * 60 * 60 * 1000)

  // The refresh token is rotated on every refresh, so its expiry may roll
  // forward too. Anthropic does not currently document returning this. The
  // previous code preserved any on-disk value through the spread below but
  // never parsed a new one from the response, so the stored expiry could only
  // ever be as old as the last interactive login — leaving any countdown built
  // on it pessimistic. Persist it when offered; keep the previous value when
  // not, which is the conservative direction (warn early rather than never).
  const refreshTokenExpiresAtRaw =
    tokenData.refresh_token_expires_at ??
    (tokenData.refresh_token_expires_in ? now + tokenData.refresh_token_expires_in * 1000 : undefined)
  // A refresh that just succeeded proves the refresh token is still valid, so
  // its expiry must lie in the future. Reject anything else — a seconds-rather
  // -than-ms value would land in 1970 and read downstream as "login already
  // expired", turning a healthy proxy into a permanent alert.
  const refreshTokenExpiresAt =
    refreshTokenExpiresAtRaw && refreshTokenExpiresAtRaw > now ? refreshTokenExpiresAtRaw : undefined

  credentials.claudeAiOauth = {
    ...credentials.claudeAiOauth,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? refreshToken,
    expiresAt,
    ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
  }

  const written = await store.write(credentials)
  if (!written) return false

  // Logged so it is observable whether Anthropic ever rolls the refresh-token
  // window — undefined here means the renewal countdown stays anchored to the
  // last interactive login.
  claudeLog("token_refresh.success", { expiresAt, refreshTokenExpiresAt })
  return true
}

/**
 * Refresh the access token if it is within `bufferMs` of expiry.
 *
 * Cheap to call before every SDK request: when the token isn't due yet this
 * is just one credential-store read. When it is due, the underlying
 * `refreshOAuthToken()` call is in-flight-deduplicated so concurrent callers
 * share one network round-trip.
 *
 * Returns true when the token is fresh after the call (already valid OR
 * successfully refreshed), false on any failure (no credentials, no
 * expiresAt, refresh request failed). False is non-fatal — the caller
 * proceeds with whatever token is on disk and falls back to the reactive
 * refresh-on-401 path if Anthropic rejects it.
 */
export async function ensureFreshToken(
  store?: CredentialStore,
  bufferMs = 5 * 60 * 1000,
): Promise<boolean> {
  const s = store ?? createPlatformCredentialStore()
  const credentials = await s.read()
  const expiresAt = credentials?.claudeAiOauth?.expiresAt
  if (!expiresAt) return false
  if (expiresAt - Date.now() > bufferMs) return true
  return refreshOAuthToken(s)
}

/**
 * Default warning window before the login dies, in days.
 *
 * Three, matching the CLI's own `tff` constant — the window outside which it
 * suppresses the expiry tip entirely. The login only lasts 30 days, so a wider
 * window would spend a tenth of every cycle in the alerting state and train
 * the alert to be ignored. Override with MERIDIAN_AUTH_RENEWAL_WARN_DAYS.
 */
export const DEFAULT_RENEWAL_WARN_DAYS = 3

/**
 * Parse the MERIDIAN_AUTH_RENEWAL_WARN_DAYS window, falling back to the
 * default for anything unusable.
 *
 * An explicit finite check rather than `Number(raw) || DEFAULT`: `0` is a
 * legitimate setting — warn only once the login has actually lapsed — and the
 * shortcut would swallow it as falsy. Negative windows are rejected too; they
 * would mean "warn only after the login has been dead for N days", which no
 * monitor wants.
 */
export function resolveRenewalWarnDays(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RENEWAL_WARN_DAYS
}

export interface AuthRenewalStatus {
  /** Epoch ms the refresh token stops working, when known. */
  refreshTokenExpiresAt?: number
  /** Whole days until then. Negative once it has passed. */
  daysUntilRenewal?: number
  /** True once inside the warning window — the field monitors should alert on. */
  renewalRequiredSoon: boolean
}

/**
 * Report how long the *login* has left, as opposed to the access token.
 *
 * This is the signal behind Claude Code's "your login expires in N days"
 * warning: when the refresh token dies, the background scheduler can no longer
 * keep the proxy alive and someone must run `claude login` interactively.
 * Nothing in the automated path recovers from it.
 *
 * `renewalRequiredSoon` stays false when the expiry is unknown — an absent
 * field is not evidence of an imminent problem, and alerting on it would fire
 * on every deployment that predates the CLI writing it.
 */
/**
 * How long a read of the refresh-token expiry stays fresh.
 *
 * `/health` is hot: the dashboard polls it every 10s per open page, plugin
 * health checks hit it, and external monitors poll it too. On macOS a
 * credential-store read spawns `/usr/bin/security find-generic-password`, so
 * reading per request means a subprocess per poll — for a value that moves on
 * a ~30-day cadence. Five minutes is far shorter than any meaningful change to
 * the login window and still collapses ~97% of the reads.
 */
const RENEWAL_EXPIRY_TTL_MS = 5 * 60_000

const renewalExpiryCache = new Map<string, { value: number | undefined; at: number }>()
const renewalExpiryInflight = new Map<string, Promise<number | undefined>>()

/** Drop cached refresh-token expiries — for tests, and after a re-login. */
export function resetAuthRenewalCache(): void {
  renewalExpiryCache.clear()
  renewalExpiryInflight.clear()
}

/**
 * Read the refresh-token expiry, cached per credential store.
 *
 * Keyed on `refreshKey`, which both real stores set (`keychain:` / `file:`).
 * A store WITHOUT one is not cached at all: its identity is unknown, so
 * caching could conflate genuinely different accounts — the same reasoning
 * that makes the key profile-scoped in the first place.
 *
 * A failed read is never cached. A keychain blip should retry on the next
 * poll, not suppress the renewal warning for the whole TTL.
 */
async function readRefreshTokenExpiry(s: CredentialStore): Promise<number | undefined> {
  const key = s.refreshKey
  if (key) {
    const cached = renewalExpiryCache.get(key)
    if (cached && Date.now() - cached.at < RENEWAL_EXPIRY_TTL_MS) return cached.value
    const inflight = renewalExpiryInflight.get(key)
    if (inflight) return inflight
  }

  const read = (async (): Promise<number | undefined> => {
    let credentials: CredentialsFile | null = null
    try {
      credentials = await s.read()
    } catch {
      return undefined
    }
    const value = credentials?.claudeAiOauth?.refreshTokenExpiresAt
    if (key) renewalExpiryCache.set(key, { value, at: Date.now() })
    return value
  })()

  if (!key) return read
  renewalExpiryInflight.set(key, read)
  try {
    return await read
  } finally {
    renewalExpiryInflight.delete(key)
  }
}

export async function getAuthRenewalStatus(
  store?: CredentialStore,
  warnDays = DEFAULT_RENEWAL_WARN_DAYS,
): Promise<AuthRenewalStatus> {
  const s = store ?? createPlatformCredentialStore()
  // Only the READ is cached. The day count and the flag are recomputed every
  // call so elapsed time and a changed warnDays are always reflected.
  const refreshTokenExpiresAt = await readRefreshTokenExpiry(s)
  if (!refreshTokenExpiresAt) return { renewalRequiredSoon: false }

  const msRemaining = refreshTokenExpiresAt - Date.now()
  // Ceil, matching the CLI's own `Math.ceil(remaining / 86400000)` so this
  // number reads identically to the "Your login expires in N days" warning
  // Claude Code prints. Flooring here would report one day fewer than the
  // terminal does and make the two impossible to reconcile.
  const daysUntilRenewal = Math.ceil(msRemaining / 86_400_000)
  return {
    refreshTokenExpiresAt,
    daysUntilRenewal,
    renewalRequiredSoon: daysUntilRenewal <= warnDays,
  }
}

// ---------------------------------------------------------------------------
// Background refresh scheduler
// ---------------------------------------------------------------------------

let scheduledRefreshTimer: ReturnType<typeof setTimeout> | null = null
let scheduledRefreshActive = false
// Generation counter — bumped on every start/stop. Each scheduleNext chain
// captures the generation it began with and re-checks it after every await;
// if the global generation has moved on, the chain has been superseded and
// must bail rather than arm a follow-up timer. Without this, a stop()+start()
// that interleaves with an in-flight read leaves the first chain alive,
// arming a timer that overwrites scheduledRefreshTimer (so stop() can't
// clear it) and keeps firing in parallel with the live chain.
let scheduledRefreshGeneration = 0

/**
 * Start a self-rescheduling timer that refreshes the access token shortly
 * before each expiry — regardless of incoming traffic.
 *
 * Idempotent: a second call while one is already running is a no-op. Safe to
 * call from any code path; returns synchronously and schedules in the
 * background.
 *
 * Why traffic-independent matters: without this, an idle proxy never fires
 * either the proactive (`ensureFreshToken`) or reactive (401-retry) refresh
 * path. Anthropic's OAuth refresh tokens appear to be invalidated server-side
 * after sitting unused for an extended period (observed 2026-05-03: two NAS
 * instances idle past expiry both got `400 invalid_grant` on a manual refresh
 * attempt; only fix was OAuth-flow re-login). Running a refresh every ~8h
 * keeps the refresh chain warm.
 *
 * On `refreshOAuthToken()` failure (network, transient API error, refresh
 * token rejected) we retry every `failureRetryMs` — gives operators a window
 * to `claude login` and have the new tokens picked up automatically on the
 * next tick.
 */
export function startBackgroundRefresh(
  store?: CredentialStore,
  bufferMs = 5 * 60 * 1000,
  failureRetryMs = 5 * 60 * 1000,
): void {
  if (scheduledRefreshActive) return
  scheduledRefreshActive = true
  const gen = ++scheduledRefreshGeneration
  void scheduleNext(store ?? createPlatformCredentialStore(), bufferMs, failureRetryMs, gen)
}

/** Stop the background scheduler. Idempotent. */
export function stopBackgroundRefresh(): void {
  scheduledRefreshActive = false
  scheduledRefreshGeneration++
  if (scheduledRefreshTimer) clearTimeout(scheduledRefreshTimer)
  scheduledRefreshTimer = null
}

async function scheduleNext(
  store: CredentialStore,
  bufferMs: number,
  failureRetryMs: number,
  gen: number,
): Promise<void> {
  if (!scheduledRefreshActive || gen !== scheduledRefreshGeneration) return

  const credentials = await store.read().catch(() => null)
  if (!scheduledRefreshActive || gen !== scheduledRefreshGeneration) return

  const expiresAt = credentials?.claudeAiOauth?.expiresAt

  if (!expiresAt) {
    // Operator hasn't logged in yet (no credentials) or credentials are
    // missing the field. Re-poll periodically — once `claude login` writes
    // the file, the next tick picks it up.
    armTimer(failureRetryMs, store, bufferMs, failureRetryMs, gen)
    return
  }

  const dueIn = expiresAt - Date.now() - bufferMs
  if (dueIn <= 0) {
    // Already due (or past) — fire now, schedule the follow-up based on the
    // new expiresAt (or retry in failureRetryMs if refresh failed).
    const ok = await refreshOAuthToken(store)
    if (!scheduledRefreshActive || gen !== scheduledRefreshGeneration) return
    claudeLog("token_refresh.scheduled", { ok, immediate: true })
    armTimer(ok ? 0 : failureRetryMs, store, bufferMs, failureRetryMs, gen)
    return
  }

  armTimer(dueIn, store, bufferMs, failureRetryMs, gen)
}

/** Largest delay setTimeout accepts before Node clamps it to 1ms (2^31 - 1). */
const MAX_TIMEOUT_MS = 2_147_483_647

function armTimer(
  delayMs: number,
  store: CredentialStore,
  bufferMs: number,
  failureRetryMs: number,
  gen: number,
): void {
  // A token lifetime beyond ~24.8 days produces a delay above the 32-bit
  // signed max. Node then clamps it to 1ms and emits TimeoutOverflowWarning;
  // the 1ms timer fires, scheduleNext recomputes the same huge delay, and it
  // loops forever (#515). Cap the delay — the callback re-runs scheduleNext,
  // which recomputes the remaining time and arms the next (also-capped) timer.
  const safeDelayMs = delayMs > MAX_TIMEOUT_MS ? MAX_TIMEOUT_MS : delayMs
  scheduledRefreshTimer = setTimeout(async () => {
    if (!scheduledRefreshActive || gen !== scheduledRefreshGeneration) return
    // The dueIn re-check inside scheduleNext distinguishes "fire-now" from
    // "reschedule-only" ticks: when the disk-state recompute lands inside the
    // buffer window, scheduleNext fires a refresh and emits the debug-gated
    // `token_refresh.scheduled` telemetry; otherwise it just arms the next
    // timer. Neither path writes to stderr (the unconditional log was removed
    // in #518 to stop polluting embedded TUI hosts).
    void scheduleNext(store, bufferMs, failureRetryMs, gen)
  }, safeDelayMs)
  if (scheduledRefreshTimer && (scheduledRefreshTimer as { unref?: () => void }).unref) {
    (scheduledRefreshTimer as { unref: () => void }).unref()
  }
}

/** For testing only. */
export function isBackgroundRefreshActive(): boolean {
  return scheduledRefreshActive
}

/** Reset in-flight state — for testing only. */
export function resetInflightRefresh(): void {
  inflightRefreshByKey.clear()
}
