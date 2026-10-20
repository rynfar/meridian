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
 * or `~/.claude/.credentials.json`) to read the access token. We refresh it on
 * 401, before the call when it has expired, and once after a run of 429s
 * (reports say the endpoint rate-limits per access token, so a new token gets a
 * new bucket).
 *
 * Per-profile caching: each profile has its own 30s TTL cache so multi-account
 * setups can be queried independently without cross-contamination. Concurrent
 * callers for the same profile share a single in-flight request.
 */

import { createHash } from "node:crypto"
import { z } from "zod"
import { claudeLog } from "../logger"
import { isCredentialsReadOnly } from "./credentialsMode"
import { parseRetryAfterMs } from "./retryAfter"
import { createPlatformCredentialStore, refreshOAuthToken, type CredentialStore } from "./tokenRefresh"

const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1"
const OAUTH_BETA_HEADER = "oauth-2025-04-20"
const OAUTH_USER_AGENT = "claude-cli/2.1.304 (external, cli)"

/** Raw shape returned by Anthropic. Most fields are optional/nullable. */
interface RawOAuthWindow {
  utilization?: number | null
  resets_at?: string | null
}

interface RawOAuthExtraUsage {
  is_enabled?: boolean
  monthly_limit?: number
  used_credits?: number
  utilization?: number | null
  currency?: string
}

interface RawOAuthLimit {
  kind?: string
  percent?: number | null
  resets_at?: string | null
  scope?: {
    model?: {
      id?: string | null
      display_name?: string | null
    } | null
  } | null
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
  limits?: RawOAuthLimit[] | null
  extra_usage?: RawOAuthExtraUsage | null
  cedar_ember?: unknown
}

export interface OAuthUsageWindow {
  type: string
  utilization: number | null
  resetsAt: number | null
}

export interface OAuthExtraUsageInfo {
  isEnabled: boolean
  monthlyLimit: number
  usedCredits: number
  utilization: number | null
  currency: string
}

export interface OAuthBankedResetGrant {
  id: string | null
  resetsLeft: number
  expiresAt: number | null
}

export interface OAuthBankedResets {
  eligible: boolean
  grants: OAuthBankedResetGrant[]
}

export interface OAuthUsageSnapshot {
  windows: OAuthUsageWindow[]
  extraUsage: OAuthExtraUsageInfo | null
  bankedResets: OAuthBankedResets | null
  fetchedAt: number
  /** Set when this is a previous snapshot served because a fresh fetch
   *  failed transiently (credential-read blip, upstream error). */
  stale?: boolean
}

/**
 * Why a usage fetch produced no snapshot.
 *
 * Distinct values because they call for different things from a human: a
 * missing token needs `claude login`, and the rest need waiting. Keeping them
 * apart is the whole point of this type — every failure used to reach callers
 * as a bare `null`, so the quota routes labelled all of them `no_token`, and a
 * rate-limited read rendered as an account that had lost its credentials. A 429
 * and an empty credential file are not the same news, and only one of them is
 * the user's problem to fix.
 *
 * `rate_limited` is split out from `upstream_error` because it's the one the
 * backoff can keep returning for minutes at a stretch, so it's worth saying
 * plainly rather than as a generic upstream failure.
 */
export type OAuthUsageError = "no_token" | "rate_limited" | "upstream_error"

/** What a fetch produced, before provenance is attached. Internal: every
 *  public exit goes through `withProvenance`. */
interface RawUsageResult {
  snapshot: OAuthUsageSnapshot | null
  /** Set only when `snapshot` is null. */
  error: OAuthUsageError | null
}

/**
 * The run of failed checks since the last successful one.
 *
 * `consecutiveFailures` counts checks that actually reached the credential
 * store or upstream — not polls the 429 cooldown turned away before they got
 * there. The quota page polls every 10s while a backoff runs for a minute or
 * more, so counting suppressed polls would report six failures for one refusal,
 * which says more about the poll interval than about the account.
 */
export interface OAuthUsageFailure {
  reason: OAuthUsageError
  /** Always >= 1 — a success clears the record rather than zeroing it. */
  consecutiveFailures: number
  lastFailureAt: number
}

/** A usage fetch outcome: the snapshot, or why there isn't one. */
export interface OAuthUsageResult extends RawUsageResult {
  /** The failing run in progress, or null when the last check succeeded.
   *  Independent of `snapshot`/`error`: a stale snapshot served inside the
   *  bound reports `error: null`, and a reader still needs to know the figures
   *  are standing in for a check that didn't land. */
  failure: OAuthUsageFailure | null
  /** Last successful reading for this profile at any age — including past the
   *  point `staleOr` stops serving it as `snapshot`. Lets a display keep the
   *  last known numbers, labelled, instead of blanking. */
  lastGood: OAuthUsageSnapshot | null
}

/** The per-profile usage shape the quota routes serve. */
export interface UsageEntryFields {
  windows: OAuthUsageWindow[]
  extraUsage: OAuthExtraUsageInfo | null
  bankedResets: OAuthBankedResets | null
  fetchedAt: number | null
  /** True when the figures are a previous reading rather than one taken by the
   *  check that just ran. */
  stale: boolean
  error: OAuthUsageError | null
  failure: OAuthUsageFailure | null
}

/**
 * Shape a fetch result for a consumer that renders it to a human.
 *
 * Three states a caller must be able to tell apart, and which bare numbers
 * cannot:
 *   never read      — no figures at all: `fetchedAt` null, `stale` false.
 *   read and fresh  — `stale` false, `failure` null.
 *   read then stale — figures as of `fetchedAt`, `stale` true, `failure` saying
 *                     why the newer check didn't land and how many in a row.
 *
 * A window sitting at 0% and a profile that has never been read flatten to the
 * same numbers, so the distinction has to travel as its own field.
 */
export function toUsageEntry(result: OAuthUsageResult): UsageEntryFields {
  const shown = result.snapshot ?? result.lastGood
  return {
    windows: shown?.windows ?? [],
    extraUsage: shown?.extraUsage ?? null,
    bankedResets: shown?.bankedResets ?? null,
    fetchedAt: shown?.fetchedAt ?? null,
    stale: shown != null && (result.snapshot === null || result.snapshot.stale === true),
    error: result.error,
    failure: result.failure,
  }
}

const CACHE_TTL_MS_DEFAULT = 30_000
// A transiently failing fetch serves the last-good snapshot instead of
// blanking the consumer ("no usage data yet" flapping) — but only within
// this bound, so genuinely dead credentials still surface as missing data.
const STALE_MAX_MS_DEFAULT = 15 * 60_000
const RATE_LIMIT_BACKOFF_MS_DEFAULT = 60_000
// Refresh this close to `expiresAt` rather than send a token the endpoint is
// about to reject. The background scheduler normally renews first, so this is
// a backup for a renewal it missed (a timer that fired late after sleep, or a
// failed refresh before its retry). An expired token has drawn 429s from this
// endpoint, not 401s, so the 401 path alone does not cover it.
const EXPIRY_REFRESH_MARGIN_MS = 60_000
// A community report on anthropics/claude-code#31021 says the usage endpoint
// rate-limits per access token, so one token's bucket can stay full while a
// new token reads fine (not measured here). After this many 429s in a row on
// one token, refresh once to get a new token and a new bucket.
const RATE_LIMIT_REFRESH_AFTER = 3
// At most one 429-triggered refresh per profile in this window. A real rate
// limit outlasts a new token, and each refresh rotates the refresh token, so
// an unbounded retry would spend refresh grants for nothing.
const RATE_LIMIT_REFRESH_WINDOW_MS = 60 * 60_000

/** Per-profile cache. Key = profileId (or DEFAULT_KEY for the unscoped default). */
const cacheByProfile = new Map<string, OAuthUsageSnapshot>()
const inflightByProfile = new Map<string, Promise<RawUsageResult>>()
const rateLimitedUntilByProfile = new Map<string, number>()
const failureByProfile = new Map<string, OAuthUsageFailure>()
/** The current run of 429s: which token drew them (a hash, never the token)
 *  and how many in a row. */
const rateLimitRunByProfile = new Map<string, { tokenHash: string; count: number }>()
const lastRateLimitRefreshAtByProfile = new Map<string, number>()
const DEFAULT_KEY = "__default__"

function recordFailure(cacheKey: string, reason: OAuthUsageError): void {
  const prev = failureByProfile.get(cacheKey)
  failureByProfile.set(cacheKey, {
    reason,
    consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
    lastFailureAt: Date.now(),
  })
}

function withProvenance(cacheKey: string, result: RawUsageResult): OAuthUsageResult {
  return {
    ...result,
    failure: failureByProfile.get(cacheKey) ?? null,
    lastGood: cacheByProfile.get(cacheKey) ?? null,
  }
}

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

const RESET_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/i
const RESET_DATE_TIMEZONE = /(?:Z|[+-]\d{2}:\d{2})$/i

function parseResetDate(raw: unknown): number | null {
  if (typeof raw !== "string" || !RESET_DATE_FORMAT.test(raw)) return null
  // Provider timestamps without an offset are UTC, never the host's timezone.
  return parseIsoToMs(RESET_DATE_TIMEZONE.test(raw) ? raw : `${raw}Z`)
}

function parseBankedResets(raw: unknown): OAuthBankedResets | null {
  if (typeof raw !== "object" || raw === null || !("eligible" in raw) || typeof raw.eligible !== "boolean"
    || !("grants" in raw) || !Array.isArray(raw.grants)) return null

  const grants: OAuthBankedResetGrant[] = []
  const rawGrants: unknown[] = raw.grants
  for (const grant of rawGrants) {
    if (typeof grant !== "object" || grant === null || !("resets_left" in grant)
      || typeof grant.resets_left !== "number" || !Number.isSafeInteger(grant.resets_left) || grant.resets_left < 0) continue

    grants.push({
      id: "id" in grant && typeof grant.id === "string" ? grant.id : null,
      resetsLeft: grant.resets_left,
      expiresAt: parseResetDate("ends_at" in grant ? grant.ends_at : null),
    })
  }
  return { eligible: raw.eligible, grants }
}

function normalizeUtilization(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null
  // OAuth returns 0..100. Normalize to 0..1 to match SDK rate_limit_event.
  return Math.max(0, raw / 100)
}

function modelScopedWindowType(limit: RawOAuthLimit): string | null {
  if (limit.kind !== "weekly_scoped") return null

  const model = limit.scope?.model
  const name = model?.display_name?.trim() || model?.id?.trim()
  if (!name) return null

  const slug = name
    .toLowerCase()
    .replace(/^claude[\s_-]+/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return slug ? `seven_day_${slug}` : null
}

function buildSnapshot(raw: RawOAuthUsageResponse): OAuthUsageSnapshot {
  const windows: OAuthUsageWindow[] = []
  for (const key of WINDOW_TYPES) {
    const w = raw[key] as RawOAuthWindow | null | undefined
    if (!w) continue
    const utilization = normalizeUtilization(w.utilization)
    const resetsAt = parseIsoToMs(w.resets_at)
    if (utilization === null && resetsAt === null) continue
    windows.push({ type: key as string, utilization, resetsAt })
  }

  const windowTypes = new Set(windows.map(window => window.type))
  for (const limit of raw.limits ?? []) {
    const type = modelScopedWindowType(limit)
    if (!type || windowTypes.has(type)) continue

    const utilization = normalizeUtilization(limit.percent)
    const resetsAt = parseIsoToMs(limit.resets_at)
    if (utilization === null && resetsAt === null) continue

    windows.push({ type, utilization, resetsAt })
    windowTypes.add(type)
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

  return { windows, extraUsage, bankedResets: parseBankedResets(raw.cedar_ember), fetchedAt: Date.now() }
}

async function readAccessToken(store: CredentialStore): Promise<string | null> {
  const creds = await store.read()
  return creds?.claudeAiOauth?.accessToken ?? null
}

type RefreshFn = (store: CredentialStore) => Promise<boolean>

/** Refresh, then read back the new token. Null when either step fails. */
async function refreshAndRead(store: CredentialStore, refresh: RefreshFn, cacheKey: string, trigger: string): Promise<string | null> {
  if (await refresh(store)) {
    const token = await readAccessToken(store)
    if (token) return token
  }
  claudeLog("oauth_usage.refresh_failed", { profile: cacheKey, trigger })
  return null
}

/**
 * The token to send: the stored one, or a new one when the stored one has
 * expired. A failed refresh still sends the stored token, so the call reports
 * what upstream thinks of it (and a 401 takes its own refresh path).
 *
 * Read-only instances skip this quietly, as `ensureFreshToken` does: it runs
 * on every check, and the instance that owns the credentials renews them.
 */
async function tokenForCall(store: CredentialStore, refresh: RefreshFn, cacheKey: string): Promise<string | null> {
  const oauth = (await store.read())?.claudeAiOauth
  const token = oauth?.accessToken ?? null
  const expiresAt = oauth?.expiresAt
  if (!token || typeof expiresAt !== "number" || expiresAt - Date.now() > EXPIRY_REFRESH_MARGIN_MS) return token
  if (isCredentialsReadOnly()) return token
  claudeLog("oauth_usage.refresh_on_expiry", { profile: cacheKey })
  return (await refreshAndRead(store, refresh, cacheKey, "expiry")) ?? token
}

/** Count a 429 against the token that drew it. A new token starts a new run. */
function countRateLimited(cacheKey: string, token: string): number {
  const tokenHash = createHash("sha256").update(token).digest("hex")
  const prev = rateLimitRunByProfile.get(cacheKey)
  const count = prev?.tokenHash === tokenHash ? prev.count + 1 : 1
  rateLimitRunByProfile.set(cacheKey, { tokenHash, count })
  return count
}

/** Whether this 429 run may spend the profile's one refresh for the window.
 *  Claims the window when it says yes, so a failed refresh counts too. */
function claimRateLimitRefresh(cacheKey: string, runLength: number): boolean {
  if (runLength < RATE_LIMIT_REFRESH_AFTER || isCredentialsReadOnly()) return false
  const last = lastRateLimitRefreshAtByProfile.get(cacheKey)
  if (last !== undefined && Date.now() - last < RATE_LIMIT_REFRESH_WINDOW_MS) return false
  lastRateLimitRefreshAtByProfile.set(cacheKey, Date.now())
  return true
}

/** Minimal fetch shape used by callAnthropic. Avoids `typeof fetch`'s
 *  `preconnect` property, which makes test casts unwieldy. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

async function callAnthropic(
  token: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<RawOAuthUsageResponse | { __status: number; retryAfterMs: number | null }> {
  const res = await fetchImpl(OAUTH_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA_HEADER,
      Accept: "application/json",
      "User-Agent": OAUTH_USER_AGENT,
    },
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    return {
      __status: res.status,
      retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
    }
  }
  return (await res.json()) as RawOAuthUsageResponse
}

type UsageCallResult = Awaited<ReturnType<typeof callAnthropic>>

/**
 * Count a 429 into its token's run; once the run is long enough and the
 * profile's window allows it, refresh and retry once with the new token.
 * Returns the result to report: the retry's, or the original 429. The caller
 * applies the cooldown to whatever 429 comes back, so a failed refresh or a
 * second 429 leaves the throttle as it was.
 */
async function retryAfterRateLimitRun(
  limited: UsageCallResult,
  ctx: { store: CredentialStore; refresh: RefreshFn; cacheKey: string; token: string; fetchImpl: FetchLike; owner: Promise<RawUsageResult> },
): Promise<UsageCallResult> {
  const runLength = countRateLimited(ctx.cacheKey, ctx.token)
  if (!claimRateLimitRefresh(ctx.cacheKey, runLength)) return limited
  claudeLog("oauth_usage.refresh_on_429", { profile: ctx.cacheKey, runLength })
  const newToken = await refreshAndRead(ctx.store, ctx.refresh, ctx.cacheKey, "rate_limited")
  if (!newToken || inflightByProfile.get(ctx.cacheKey) !== ctx.owner) return limited
  const retried = await callAnthropic(newToken, ctx.fetchImpl)
  if (inflightByProfile.get(ctx.cacheKey) !== ctx.owner) return retried
  if ("__status" in retried && retried.__status === 429) countRateLimited(ctx.cacheKey, newToken)
  else rateLimitRunByProfile.delete(ctx.cacheKey)
  return retried
}

export interface FetchOAuthUsageOpts {
  ttlMs?: number
  /** Max age of a last-good snapshot served on fetch failure (default 15 min). */
  staleMaxMs?: number
  /** Minimum per-profile cooldown after HTTP 429 (default 60s). */
  rateLimitBackoffMs?: number
  force?: boolean
  store?: CredentialStore
  profileId?: string | null
  claudeConfigDir?: string
  fetchImpl?: FetchLike
  /** Override the token refresh (for testing). Defaults to refreshOAuthToken. */
  refreshImpl?: RefreshFn
}

export const quotaResetBody = z.object({
  profile: z.string().min(1),
  grantId: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
}).strict()

export type OAuthQuotaResetRequest = z.infer<typeof quotaResetBody>
const quotaResetIdentity = z.object({ organization: z.object({ uuid: z.string().uuid() }) })

const quotaResetOutcome = z.object({
  result: z.enum(["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"]),
  reason: z.unknown().optional(),
  resets_left: z.unknown().optional(),
  cleared: z.unknown().transform(raw => Array.isArray(raw) ? raw.filter((entry: unknown): entry is string => typeof entry === "string") : []).default([]),
  weekly_resets_at: z.unknown().optional(),
  cooldown_until: z.unknown().optional(),
})

export type OAuthResetFailureCode = "no_token" | "no_organization"
  | "upstream_auth" | "rate_limited" | "upstream_error" | "invalid_response" | "reset_indeterminate"

type OAuthResetFailure = {
  ok: false
  status: 429 | 502 | 503
  code: OAuthResetFailureCode
  message: string
  indeterminate: boolean
}

export type OAuthResetResult = OAuthResetFailure | {
  ok: true
  outcome: {
    result: z.infer<typeof quotaResetOutcome>["result"]
    reason: string | null
    resetsLeft: number | null
    cleared: string[]
    weeklyResetsAt: number | null
    cooldownUntil: number | null
  }
}

function invalidateResetUsage(profileId?: string | null): void {
  clearOAuthUsageForProfile(profileId)
  if (profileId == null) clearOAuthUsageForProfile("default")
}

function fail(status: OAuthResetFailure["status"], code: OAuthResetFailureCode, message: string, indeterminate = false): OAuthResetFailure {
  return { ok: false, status, code, message, indeterminate }
}

function httpFailure(status: number): OAuthResetFailure {
  if (status === 401 || status === 403) return fail(502, "upstream_auth", "Upstream rejected OAuth credentials")
  if (status === 429) return fail(429, "rate_limited", "Upstream rate limited the request")
  return fail(502, "upstream_error", "Upstream request failed")
}

/** One explicit mutation; request IDs are caller-owned, not a promise of provider deduplication. */
export async function redeemOAuthQuotaReset(
  input: OAuthQuotaResetRequest,
  opts?: Pick<FetchOAuthUsageOpts, "store" | "profileId" | "claudeConfigDir" | "fetchImpl" | "refreshImpl">,
): Promise<OAuthResetResult> {
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch
  const store = opts?.store ?? createPlatformCredentialStore({ claudeConfigDir: opts?.claudeConfigDir })
  let token: string | null
  try {
    token = await tokenForCall(store, opts?.refreshImpl ?? refreshOAuthToken, opts?.profileId ?? DEFAULT_KEY)
  } catch {
    return fail(503, "no_token", "Could not read OAuth credentials")
  }
  if (!token) return fail(503, "no_token", "No OAuth access token available")
  const headers = {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": OAUTH_BETA_HEADER,
    "User-Agent": OAUTH_USER_AGENT,
    "Content-Type": "application/json",
  }
  let organization: string
  try {
    const identity = await fetchImpl("https://api.anthropic.com/api/oauth/profile", {
      headers, redirect: "error", signal: AbortSignal.timeout(25_000),
    })
    if (!identity.ok) return httpFailure(identity.status)
    const profile = quotaResetIdentity.safeParse(await identity.json())
    if (!profile.success) return fail(502, "no_organization", "OAuth identity did not include a valid organization")
    organization = profile.data.organization.uuid
  } catch {
    return fail(502, "upstream_error", "Could not read OAuth organization")
  }
  try {
    const response = await fetchImpl(`https://api.anthropic.com/api/organizations/${organization}/reset_rate_limits`, {
      method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({ program: "cedar_ember", grant_id: input.grantId, request_id: input.requestId }),
    })
    if (!response.ok) {
      if (response.status >= 500) {
        invalidateResetUsage(opts?.profileId)
        return fail(502, "reset_indeterminate", "Reset outcome is unknown; do not automatically retry", true)
      }
      return httpFailure(response.status)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      invalidateResetUsage(opts?.profileId)
      return fail(502, "invalid_response", "Reset response was invalid; outcome is unknown", true)
    }
    const result = quotaResetOutcome.safeParse(body)
    if (!result.success) {
      invalidateResetUsage(opts?.profileId)
      return fail(502, "invalid_response", "Reset response was invalid; outcome is unknown", true)
    }
    const value = result.data
    if (value.result === "reset" || value.result === "already_used") invalidateResetUsage(opts?.profileId)
    return { ok: true, outcome: {
      result: value.result,
      reason: typeof value.reason === "string" ? value.reason : null,
      resetsLeft: typeof value.resets_left === "number" && Number.isSafeInteger(value.resets_left) && value.resets_left >= 0 ? value.resets_left : null,
      cleared: value.cleared,
      weeklyResetsAt: parseResetDate(value.weekly_resets_at),
      cooldownUntil: parseResetDate(value.cooldown_until),
    } }
  } catch {
    invalidateResetUsage(opts?.profileId)
    return fail(502, "reset_indeterminate", "Reset outcome is unknown; do not automatically retry", true)
  }
}

/**
 * Test-only override. When set, server.ts callers (which don't pass `store`
 * or `fetchImpl`) get this fake instead of hitting Anthropic. Callers that
 * pass either `store` or `fetchImpl` (oauth-usage unit tests) bypass the
 * override entirely, so unit tests of this module aren't affected by the
 * route tests' override.
 *
 * Use this instead of `mock.module()` — Bun's module mocks are process-
 * global and would leak across parallel test files.
 */
let _testOverride: ((opts?: FetchOAuthUsageOpts) => Promise<OAuthUsageSnapshot | null>) | null = null

/** Test-only setter. Pass `null` to clear. */
export function __setFetchOAuthUsageOverride(
  fn: ((opts?: FetchOAuthUsageOpts) => Promise<OAuthUsageSnapshot | null>) | null,
): void {
  _testOverride = fn
}

/**
 * Fetch latest OAuth usage for a specific profile (or the default OAuth
 * account if none specified). Returns null if no OAuth token is available
 * or the upstream call fails (after one refresh attempt).
 *
 * Per-profile in-process cache (30s TTL by default) prevents hammering
 * Anthropic's endpoint when many clients poll concurrently. Concurrent
 * callers for the same profile share a single in-flight request.
 *
 * @param ttlMs           Override the cache TTL (default 30s).
 * @param force           Bypass the TTL cache and fetch fresh. Does NOT bypass
 *                        the in-flight de-dupe or the 429 cooldown — both still
 *                        apply, so a forced caller can still get a stale (or
 *                        null) snapshot rather than a fresh upstream call.
 * @param store           Override the credential store (for testing).
 * @param profileId       Logical profile identifier used as the cache key.
 *                        Pass null/undefined for the default OAuth account.
 * @param claudeConfigDir When provided, reads credentials from this dir's
 *                        keychain entry (macOS) or `.credentials.json`
 *                        (Linux) instead of the platform default.
 * @param fetchImpl       Override the fetch implementation (for testing).
 *                        Defaults to globalThis.fetch.
 */
export async function fetchOAuthUsage(opts?: FetchOAuthUsageOpts): Promise<OAuthUsageSnapshot | null> {
  return (await fetchOAuthUsageResult(opts)).snapshot
}

/** Why a profile has no snapshot, judged from cooldown state alone. Used where
 *  the fetch itself didn't report a reason. */
function missingReason(cacheKey: string): OAuthUsageError {
  const until = rateLimitedUntilByProfile.get(cacheKey)
  return until !== undefined && Date.now() < until ? "rate_limited" : "no_token"
}

/**
 * As `fetchOAuthUsage`, but says why there is no snapshot. Callers that
 * report a per-profile status to a human want this one; `fetchOAuthUsage`
 * remains for callers that only act on the numbers.
 */
export async function fetchOAuthUsageResult(opts?: FetchOAuthUsageOpts): Promise<OAuthUsageResult> {
  // If the caller injected real test deps, run the real impl. This keeps
  // oauth-usage unit tests isolated from any test-set _testOverride.
  const cacheKey = opts?.profileId ?? DEFAULT_KEY
  if (_testOverride && !opts?.fetchImpl && !opts?.store) {
    const snapshot = await _testOverride(opts)
    if (snapshot) {
      failureByProfile.delete(cacheKey)
      return withProvenance(cacheKey, { snapshot, error: null })
    }
    // The override returns a bare snapshot-or-null, so the reason has to come
    // from the one piece of real state that outlives it: the 429 cooldown.
    // Defaulting to "no_token" here would make the override contradict the
    // cooldown the same process just recorded.
    const error = missingReason(cacheKey)
    recordFailure(cacheKey, error)
    return withProvenance(cacheKey, { snapshot: null, error })
  }
  return withProvenance(cacheKey, await fetchOAuthUsageImpl(opts))
}

async function fetchOAuthUsageImpl(opts?: FetchOAuthUsageOpts): Promise<RawUsageResult> {
  const ttl = opts?.ttlMs ?? CACHE_TTL_MS_DEFAULT
  const cacheKey = opts?.profileId ?? DEFAULT_KEY
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch
  const staleMaxMs = opts?.staleMaxMs ?? STALE_MAX_MS_DEFAULT

  // On transient failure, serve the last-good snapshot (bounded) instead of
  // null — a credential-read blip or upstream 5xx should not blank the
  // consumer's usage display until the next successful fetch.
  //
  // `attempted` marks a check that actually reached the credential store or
  // upstream. The 429 cooldown turns polls away before either, and those must
  // not advance the failure count — see OAuthUsageFailure.
  const staleOr = (reason: string, error: OAuthUsageError, attempted = true): RawUsageResult | Promise<RawUsageResult> => {
    if (attempted && inflightByProfile.get(cacheKey) !== promise) return fetchOAuthUsageImpl({ ...opts, force: false })
    if (attempted) recordFailure(cacheKey, error)
    const last = cacheByProfile.get(cacheKey)
    if (last && Date.now() - last.fetchedAt < staleMaxMs) {
      claudeLog("oauth_usage.serving_stale", { profile: cacheKey, reason, ageMs: Date.now() - last.fetchedAt })
      return { snapshot: { ...last, stale: true }, error: null }
    }
    return { snapshot: null, error }
  }

  if (!opts?.force) {
    const cached = cacheByProfile.get(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < ttl) return { snapshot: cached, error: null }
  }
  const existing = inflightByProfile.get(cacheKey)
  if (existing) return existing

  // A 429 must throttle forced and normal callers alike. Without a negative
  // cache, every quota poll retries immediately and can keep Anthropic's
  // private usage endpoint permanently rate-limited.
  const rateLimitedUntil = rateLimitedUntilByProfile.get(cacheKey)
  if (rateLimitedUntil !== undefined) {
    if (Date.now() < rateLimitedUntil) return staleOr("rate_limited", "rate_limited", false)
    rateLimitedUntilByProfile.delete(cacheKey)
  }

  const store = opts?.store ?? createPlatformCredentialStore({ claudeConfigDir: opts?.claudeConfigDir })
  const rateLimitBackoffMs = opts?.rateLimitBackoffMs ?? RATE_LIMIT_BACKOFF_MS_DEFAULT
  const refresh = opts?.refreshImpl ?? refreshOAuthToken

  async function fetchAndCacheUsage(): Promise<RawUsageResult> {
    try {
      let token = await tokenForCall(store, refresh, cacheKey)
      if (inflightByProfile.get(cacheKey) !== promise) return fetchOAuthUsageImpl({ ...opts, force: false })
      if (!token) {
        // This read failing intermittently (e.g. a Keychain entry racing a
        // token-refresh rewrite) was previously silent — log it so flapping
        // usage displays are diagnosable.
        claudeLog("oauth_usage.no_token", { profile: cacheKey })
        return staleOr("no_token", "no_token")
      }

      let result = await callAnthropic(token, fetchImpl)
      if (inflightByProfile.get(cacheKey) !== promise) return fetchOAuthUsageImpl({ ...opts, force: false })
      if ("__status" in result && result.__status === 401) {
        claudeLog("oauth_usage.token_refresh_attempt", { profile: cacheKey })
        const refreshed = await refresh(store)
        if (!refreshed) {
          claudeLog("oauth_usage.refresh_failed", { profile: cacheKey })
          // Not `no_token`: the token is present, and a read-only instance
          // declines to refresh it BY DESIGN (credentialsMode.ts). Reporting
          // a missing login here would tell the operator to re-authenticate
          // every account on the box, on the one instance that is forbidden
          // from touching credentials.
          return staleOr("refresh_failed", "upstream_error")
        }
        const newToken = await readAccessToken(store)
        if (inflightByProfile.get(cacheKey) !== promise) return fetchOAuthUsageImpl({ ...opts, force: false })
        if (!newToken) return staleOr("no_token_after_refresh", "no_token")
        token = newToken
        result = await callAnthropic(newToken, fetchImpl)
      }
      if (inflightByProfile.get(cacheKey) !== promise) return fetchOAuthUsageImpl({ ...opts, force: false })
      if ("__status" in result && result.__status === 429) {
        result = await retryAfterRateLimitRun(result, { store, refresh, cacheKey, token, fetchImpl, owner: promise })
      } else {
        rateLimitRunByProfile.delete(cacheKey)
      }
      if (inflightByProfile.get(cacheKey) !== promise) return fetchOAuthUsageImpl({ ...opts, force: false })
      if ("__status" in result) {
        if (result.__status === 429) {
          // Floor at the backoff, but cap at staleMaxMs: the cooldown suppresses
          // every fetch, so one longer than the stale window would age the
          // last-good snapshot out with nothing able to refresh it — staleOr
          // starts returning null and the display blanks for the remainder.
          // Capping means at most one retry per stale window, still far below
          // the every-poll retries this backoff exists to stop.
          // The cap never drops below the backoff floor, so a small staleMaxMs
          // can't disarm the throttle this whole change exists to provide.
          const retryAfterMs = Math.min(
            Math.max(rateLimitBackoffMs, result.retryAfterMs ?? 0),
            Math.max(staleMaxMs, rateLimitBackoffMs),
          )
          rateLimitedUntilByProfile.set(cacheKey, Date.now() + retryAfterMs)
        }
        claudeLog("oauth_usage.upstream_error", { profile: cacheKey, status: result.__status })
        return staleOr(
          `upstream_${result.__status}`,
          result.__status === 429 ? "rate_limited" : "upstream_error",
        )
      }

      rateLimitedUntilByProfile.delete(cacheKey)
      failureByProfile.delete(cacheKey)
      const snapshot = buildSnapshot(result)
      cacheByProfile.set(cacheKey, snapshot)
      return { snapshot, error: null }
    } catch (err) {
      claudeLog("oauth_usage.fetch_failed", { profile: cacheKey, error: err instanceof Error ? err.message : String(err) })
      return staleOr("exception", "upstream_error")
    } finally {
      if (inflightByProfile.get(cacheKey) === promise) inflightByProfile.delete(cacheKey)
    }
  }

  const promise = fetchAndCacheUsage()
  inflightByProfile.set(cacheKey, promise)
  return promise
}

/**
 * Last-read snapshot for a profile, without fetching.
 *
 * For the error path, which needs the cached windows to work out WHICH
 * allowance was just refused and must not add a network round trip to a request
 * that has already failed. Returns undefined when nothing has been read yet;
 * a stale snapshot is deliberately still returned, because "what we last read"
 * is exactly the evidence being reasoned about there.
 */
export function peekOAuthUsage(profileId?: string | null): OAuthUsageSnapshot | undefined {
  return cacheByProfile.get(profileId ?? DEFAULT_KEY)
}

/** Clear cached OAuth usage snapshot, failure state, and 429 cooldowns for one profile. */
export function clearOAuthUsageForProfile(profileId?: string | null): void {
  const key = profileId ?? DEFAULT_KEY
  cacheByProfile.delete(key)
  inflightByProfile.delete(key)
  rateLimitedUntilByProfile.delete(key)
  failureByProfile.delete(key)
  rateLimitRunByProfile.delete(key)
  lastRateLimitRefreshAtByProfile.delete(key)
}

/** Test-only / shutdown helper — clears all cached snapshots and pending fetches. */
export function resetOAuthUsageCache(): void {
  cacheByProfile.clear()
  inflightByProfile.clear()
  rateLimitedUntilByProfile.clear()
  failureByProfile.clear()
  rateLimitRunByProfile.clear()
  lastRateLimitRefreshAtByProfile.clear()
}
