/**
 * Continuous OAuth usage fetching from Anthropic's private OAuth endpoint.
 *
 * Anthropic exposes `GET https://api.anthropic.com/api/oauth/usage` for OAuth
 * (Claude Max) subscribers. Unlike the SDK's `rate_limit_event` (which only
 * populates `utilization` near `allowed_warning` / `rejected`), this endpoint
 * always returns continuous percentage values for every active rate-limit
 * window — exactly what claude.ai's own UI uses.
 *
 * Headers required:
 *   Authorization: Bearer <oauth-access-token>
 *   anthropic-beta: oauth-2025-04-20
 *
 * We reuse `tokenRefresh.ts`'s cross-platform credential store (macOS Keychain
 * or `~/.claude/.credentials.json`) to read the access token, and trigger a
 * background refresh on 401.
 *
 * The result is cached in-process for 30s by default to avoid hammering the
 * upstream when many clients poll concurrently. Clients should poll no more
 * than ~once per 30s.
 */

import { claudeLog } from "../logger"
import { createPlatformCredentialStore, refreshOAuthToken, type CredentialStore } from "./tokenRefresh"

const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const OAUTH_BETA_HEADER = "oauth-2025-04-20"

/** Raw shape returned by Anthropic. Most fields are optional/nullable. */
interface RawOAuthWindow {
  utilization?: number | null   // 0-100 (percentage)
  resets_at?: string | null     // ISO 8601 with timezone
}

interface RawOAuthExtraUsage {
  is_enabled?: boolean
  monthly_limit?: number
  used_credits?: number
  utilization?: number | null
  currency?: string
}

interface RawOAuthUsageResponse {
  five_hour?: RawOAuthWindow | null
  seven_day?: RawOAuthWindow | null
  seven_day_opus?: RawOAuthWindow | null
  seven_day_sonnet?: RawOAuthWindow | null
  seven_day_oauth_apps?: RawOAuthWindow | null
  seven_day_cowork?: RawOAuthWindow | null
  seven_day_omelette?: RawOAuthWindow | null
  iguana_necktie?: RawOAuthWindow | null
  omelette_promotional?: RawOAuthWindow | null
  extra_usage?: RawOAuthExtraUsage | null
}

/** UI-facing normalized shape — utilization in 0..1 fraction, resetsAt in ms. */
export interface OAuthUsageWindow {
  type: string                  // "five_hour", "seven_day", ...
  utilization: number | null    // 0..1
  resetsAt: number | null       // epoch ms
}

export interface OAuthExtraUsageInfo {
  isEnabled: boolean
  monthlyLimit: number
  usedCredits: number
  utilization: number | null
  currency: string
}

export interface OAuthUsageSnapshot {
  windows: OAuthUsageWindow[]
  extraUsage: OAuthExtraUsageInfo | null
  fetchedAt: number             // epoch ms
}

const CACHE_TTL_MS_DEFAULT = 30_000
let cached: OAuthUsageSnapshot | null = null
let inflight: Promise<OAuthUsageSnapshot | null> | null = null

/** Window types we surface (in priority order). */
const WINDOW_TYPES: Array<keyof RawOAuthUsageResponse> = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_oauth_apps",
  "seven_day_cowork",
  "seven_day_omelette",
]

function parseIsoToMs(raw: string | null | undefined): number | null {
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

function normalizeUtilization(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null
  // OAuth returns 0..100. Normalize to 0..1 to match SDK rate_limit_event.
  return Math.max(0, raw / 100)
}

function buildSnapshot(raw: RawOAuthUsageResponse): OAuthUsageSnapshot {
  const windows: OAuthUsageWindow[] = []
  for (const key of WINDOW_TYPES) {
    const w = raw[key] as RawOAuthWindow | null | undefined
    if (!w) continue
    const utilization = normalizeUtilization(w.utilization)
    const resetsAt = parseIsoToMs(w.resets_at)
    // Only emit if we got at least one signal back.
    if (utilization === null && resetsAt === null) continue
    windows.push({ type: key as string, utilization, resetsAt })
  }

  const extra = raw.extra_usage
  const extraUsage: OAuthExtraUsageInfo | null = extra
    ? {
        isEnabled: !!extra.is_enabled,
        monthlyLimit: extra.monthly_limit ?? 0,
        usedCredits: extra.used_credits ?? 0,
        utilization: normalizeUtilization(extra.utilization ?? null),
        currency: extra.currency ?? "USD",
      }
    : null

  return { windows, extraUsage, fetchedAt: Date.now() }
}

async function readAccessToken(store: CredentialStore): Promise<string | null> {
  const creds = await store.read()
  return creds?.claudeAiOauth?.accessToken ?? null
}

async function callAnthropic(token: string, signal?: AbortSignal): Promise<RawOAuthUsageResponse | { __status: number }> {
  const res = await fetch(OAUTH_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA_HEADER,
      Accept: "application/json",
    },
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  if (!res.ok) return { __status: res.status }
  return (await res.json()) as RawOAuthUsageResponse
}

/**
 * Fetch latest OAuth usage. Returns null if no OAuth token is available or
 * the upstream call fails (after one refresh attempt). Cached in-process for
 * 30s to avoid hammering Anthropic's endpoint.
 *
 * Concurrent callers share a single in-flight request.
 *
 * @param ttlMs Override the cache TTL (default 30s).
 * @param force Bypass the cache and fetch fresh.
 * @param store Override the credential store (for testing).
 */
export async function fetchOAuthUsage(opts?: { ttlMs?: number; force?: boolean; store?: CredentialStore }): Promise<OAuthUsageSnapshot | null> {
  const ttl = opts?.ttlMs ?? CACHE_TTL_MS_DEFAULT
  if (!opts?.force && cached && Date.now() - cached.fetchedAt < ttl) {
    return cached
  }
  if (inflight) return inflight

  const store = opts?.store ?? createPlatformCredentialStore()

  inflight = (async () => {
    try {
      const token = await readAccessToken(store)
      if (!token) return null

      let result = await callAnthropic(token)
      // 401 → token expired or revoked; try one refresh + retry.
      if ("__status" in result && result.__status === 401) {
        claudeLog("oauth_usage.token_refresh_attempt", {})
        const refreshed = await refreshOAuthToken(store)
        if (!refreshed) {
          claudeLog("oauth_usage.refresh_failed", {})
          return null
        }
        const newToken = await readAccessToken(store)
        if (!newToken) return null
        result = await callAnthropic(newToken)
      }
      if ("__status" in result) {
        claudeLog("oauth_usage.upstream_error", { status: result.__status })
        return null
      }

      const snapshot = buildSnapshot(result)
      cached = snapshot
      return snapshot
    } catch (err) {
      claudeLog("oauth_usage.fetch_failed", { error: err instanceof Error ? err.message : String(err) })
      return null
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/** Test-only helper. */
export function resetOAuthUsageCache(): void {
  cached = null
  inflight = null
}
