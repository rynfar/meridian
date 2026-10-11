/**
 * Model mapping and Claude executable resolution.
 */

import { execFileSync } from "child_process"
import { existsSync, readFileSync, statSync } from "fs"
import { fileURLToPath } from "url"
import { join, dirname } from "path"
import { env } from "../env"
import { isCredentialsReadOnly } from "./credentialsMode"
import { credentialsFilePathForProfile } from "./tokenRefresh"
import { claudeLog } from "../logger"
import { authFieldPaths, describeAuthFields } from "./authDiscovery"
import { startAuthStatusProcess, startOwnedClaudeProcess, AuthStatusProcessFailure, type AuthStatusProcess } from "./authStatusProcess"
import { authStatusOwnerContext, type AuthStatusOwnerState, type AuthRefresh } from "./authStatusOwnership"
import { DEFAULT_CLAUDE_EXECUTABLE_PREFERENCE, savedClaudeExecutablePreference, type ClaudeExecutablePreference } from "./claudeExecutablePreference"
import { assertClaudeProbeActive, ownClaudeProbe } from "./claudeProbeOwnership"

import { createClaudeResolution, type ClaudeResolutionScope } from "./claudeResolverOwnership"

/**
 * Files smaller than this are treated as the placeholder stub that
 * `@anthropic-ai/claude-code/install.cjs` writes when the platform-specific
 * binary fails to install. The real Claude Code binary is ~200 MB; the stub
 * is ~500 bytes. Anything under 4 KB is the stub. Used in the bundled-binary
 * resolver step to avoid handing the proxy a non-functional placeholder when
 * upstream postinstall fails (see issue #445).
 */
const STUB_SIZE_THRESHOLD = 4096

/**
 * Shared time budget for finding Claude on PATH and probing its candidates
 * before falling back to a packaged binary.
 *
 * A working installation answers in well under a second when its pages are
 * resident, but it is a ~220 MB binary: on a host under memory pressure they
 * are evicted while it sits idle, and a cold start was measured paging itself
 * back in for 15-40 s. A 2 s budget made the page cache pick the installation
 * - one start ran the operator's `claude`, the next the bundled one, often a
 * different Claude Code version - and keeping both binaries resident deepened
 * the pressure behind the race. A broken installation or unrelated shim
 * answers with an error or the wrong output, judged the moment it arrives;
 * a candidate that never answers consumes the remaining lookup budget.
 */
// Share this budget across the lookup and every candidate. Desktop startup
// waits 60 s for health; leave room for the remaining auth/identity checks.
const CLAUDE_PROBE_TIMEOUT_MS = 45_000
/** A PATH candidate that answered this slowly is still used, and the wait is logged. */
const CLAUDE_PROBE_SLOW_MS = 5_000

export type ClaudeModel = "sonnet" | "sonnet[1m]" | "opus" | "opus[1m]" | "haiku" | "fable" | "fable[1m]"

/**
 * Current canonical pins for the `sonnet`/`opus`/`haiku` SDK aliases.
 *
 * mapModelToClaudeModel collapses every requested model to one of these
 * aliases; the Claude Agent SDK then resolves the alias to a concrete
 * version via ANTHROPIC_DEFAULT_{TYPE}_MODEL env vars. When those env
 * vars are unset the SDK falls back to its own bundled defaults, which
 * lag real Claude Max availability — users end up routed to stale
 * versions (this was the root cause of #419: opus-* requests silently
 * answering as sonnet-4).
 *
 * Meridian now pins these defaults itself at the SDK subprocess boundary
 * so fresh installs behave correctly out of the box. Users can still
 * override via MERIDIAN_DEFAULT_{TYPE}_MODEL (proxy-side) or
 * ANTHROPIC_DEFAULT_{TYPE}_MODEL (shell env, wins over Meridian's pin).
 */
export const CANONICAL_FABLE_MODEL = "claude-fable-5-1"
export const CANONICAL_OPUS_MODEL = "claude-opus-5-5"
export const CANONICAL_SONNET_MODEL = "claude-sonnet-5-5"
export const CANONICAL_HAIKU_MODEL = "claude-haiku-4-5"

/**
 * Build the ANTHROPIC_DEFAULT_{TYPE}_MODEL env record to apply before the
 * inherited process env, so user-set shell values still win but unset
 * variables get Meridian's canonical pins.
 *
 * Accepts an optional `env` arg so unit tests can pass a synthetic env
 * map instead of mutating process.env (which leaks between parallel
 * test files).
 */
export function resolveSdkModelDefaults(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ANTHROPIC_DEFAULT_FABLE_MODEL: env.MERIDIAN_DEFAULT_FABLE_MODEL ?? CANONICAL_FABLE_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: env.MERIDIAN_DEFAULT_OPUS_MODEL ?? CANONICAL_OPUS_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: env.MERIDIAN_DEFAULT_SONNET_MODEL ?? CANONICAL_SONNET_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: env.MERIDIAN_DEFAULT_HAIKU_MODEL ?? CANONICAL_HAIKU_MODEL,
  }
}

/**
 * Per-request tier pin for explicitly versioned model ids (#631).
 *
 * mapModelToClaudeModel collapses every family request to a tier alias
 * ("sonnet"/"opus"/...) that the SDK resolves via ANTHROPIC_DEFAULT_*_MODEL.
 * With canonical pins alone, an explicit `claude-sonnet-5` silently resolved
 * to the canonical sonnet — a proxy must never substitute models, so a
 * fully-versioned id overrides its tier's pin for that request only.
 *
 * Bare aliases ("sonnet", "opus[1m]") and unversioned family names return
 * undefined and keep the canonical pins. Mythos rides the fable tier
 * (claude-mythos-5/-5-1 share it — see mapModelToClaudeModel). A trailing
 * [1m] suffix is stripped; extended context stays alias-level.
 */
export function explicitModelPin(requestedModel: string): Record<string, string> | undefined {
  const base = requestedModel.trim().toLowerCase().replace(/\[1m\]$/, "")
  const match = /^claude-(sonnet|opus|haiku|fable|mythos)-\d[\w.-]*$/.exec(base)
  if (!match) return undefined
  const tier = match[1] === "mythos" ? "FABLE" : match[1]!.toUpperCase()
  return { [`ANTHROPIC_DEFAULT_${tier}_MODEL`]: base }
}
export interface ClaudeAuthStatus {
  loggedIn?: boolean
  subscriptionType?: string
  email?: string
}


const AUTH_STATUS_CACHE_TTL_MS = 60_000
/** Retry delay after the first failed auth check. */
const AUTH_STATUS_FAILURE_TTL_MS = 5_000
const AUTH_STATUS_FAILURE_MAX_TTL_MS = 5 * 60_000

/**
 * How long one `claude auth status` may run before it is killed, and
 * deliberately far longer than any caller waits for it.
 *
 * The CLI is a ~220 MB binary. On a host under memory pressure its pages are
 * evicted between checks, and a run started from a launchd agent was measured
 * paging itself back in for 15-40 s before it answered. Killing it at the
 * caller's patience did not shorten anything: the run never finished, so
 * nothing was cached, and the next attempt started just as cold - a fresh
 * process stayed "Could not verify auth status" for hours with every profile
 * logged in. A run that is allowed to finish answers, and warms the next.
 */
const AUTH_STATUS_SPAWN_TIMEOUT_MS = 90_000
/** How long a caller with no cached answer waits for the check in flight. */
const AUTH_STATUS_WAIT_MS = 5_000
let authStatusWaitMs = AUTH_STATUS_WAIT_MS

/**
 * How long a failed auth check is trusted before the next attempt: 5 s after
 * the first failure, doubling with each consecutive one up to 5 min. A
 * success resets the count. A flat 5 s retry spawned `claude auth status`
 * every few seconds for as long as the check kept failing - under host load
 * that is the very thing keeping it slow.
 */
export function authStatusFailureTtlMs(consecutiveFailures: number): number {
  const doublings = Math.max(0, consecutiveFailures - 1)
  return Math.min(AUTH_STATUS_FAILURE_TTL_MS * 2 ** doublings, AUTH_STATUS_FAILURE_MAX_TTL_MS)
}

let cachedAuthStatus: ClaudeAuthStatus | null = null
/** Last successfully retrieved auth status — survives transient failures
 *  so model selection doesn't degrade from sonnet[1m] to sonnet. */
let lastKnownGoodAuthStatus: ClaudeAuthStatus | null = null
let cachedAuthStatusAt = 0
let cachedAuthStatusLastSuccessAt = 0
let cachedAuthStatusIsFailure = false
let cachedAuthStatusFailures = 0
let cachedAuthStatusPromise: Promise<ClaudeAuthStatus | null> | null = null
let cachedAuthStatusCredMtimeMs = 0

/**
 * Credential-file mtime used to invalidate the auth-status cache, or 0 when
 * that invalidation does not apply.
 *
 * Only consulted under MERIDIAN_CREDENTIALS_READONLY. A read-only instance
 * never refreshes its own tokens, so a rotation performed by the instance that
 * DOES own them is the only thing that ever changes this answer — and with
 * time-based expiry alone the cache would keep serving the pre-rotation status
 * for up to a full TTL after one lands. Comparing mtime picks it up on the
 * next tick instead.
 *
 * With the flag unset this returns 0 unconditionally, so every comparison is
 * equal and production keeps exactly the time-based path it has today — no
 * behaviour change and no extra stat() per call.
 *
 * 0 doubles as "unknown": no credential file, or macOS, where credentials live
 * in the Keychain and have no mtime. Unknown compares equal to unknown, so
 * those setups degrade to the time-based TTL rather than invalidating on every
 * call.
 */
function credentialFileMtimeMs(envOverrides?: Record<string, string>): number {
  if (!isCredentialsReadOnly()) return 0
  try {
    return statSync(credentialsFilePathForProfile(envOverrides?.CLAUDE_CONFIG_DIR)).mtimeMs
  } catch {
    return 0
  }
}

/** Env var names already warned about for an unrecognized per-tier 1M
 *  opt-out value (#702) — ensures the warning fires at most once per
 *  process per variable, since mapModelToClaudeModel runs per request. */
const warnedTierOverrides = new Set<string>()

/**
 * Warn once per process per env var when a per-tier 1M opt-out (#702) is
 * set to a non-empty value that is neither the opt-out (bare tier name)
 * nor the documented `[1m]` no-op. These variables are opt-outs, unlike
 * MERIDIAN_SONNET_MODEL's opt-in: a typo or trailing whitespace there
 * fails safe (no extra billing), but the same typo here fails unsafe —
 * the user keeps getting billed for [1m] despite taking the documented
 * action to stop, with no signal that it didn't take effect. Matches the
 * warn-and-fall-back-to-default tone of MERIDIAN_MAX_SESSIONS parsing in
 * session/cache.ts.
 */
function warnUnrecognizedTierOverride(varName: string, raw: string, tierBase: string): void {
  if (warnedTierOverrides.has(varName)) return
  warnedTierOverrides.add(varName)
  console.warn(
    `[PROXY] Unrecognized MERIDIAN_${varName} value "${raw}"; expected "${tierBase}" or "${tierBase}[1m]" — ignoring, ${tierBase}[1m] remains the default`,
  )
}

/** Clear the per-variable warn-once tracking — for testing only. */
export function resetWarnedTierOverrides(): void {
  warnedTierOverrides.clear()
}

/**
 * Only Claude 4.6 models support the 1M extended context window.
 * Older models (4.5 and earlier) do not.
 */
function supports1mContext(model: string): boolean {
  // Global opt-out: MERIDIAN_1M_CONTEXT_SUPPORT=0 (or false/no) disables 1M
  // auto-selection entirely, downgrading every model to its base variant.
  // Accepts the CLAUDE_PROXY_ alias and all falsy spellings via env().
  const override = env("1M_CONTEXT_SUPPORT")
  if (override === "0" || override === "false" || override === "no") return false
  // Explicit older versions (4-5, 4.5, etc.) do not support 1M
  if (model.includes("4-5") || model.includes("4.5")) return false
  // Everything else (bare names, 4-6, unknown) defaults to latest (1M capable)
  return true
}

/**
 * `sessionKey` scopes the extended-context bench to one conversation. See
 * `recordExtendedContextRateLimited` — a rate limit on one session must not
 * downgrade its concurrent siblings, while an Extra Usage refusal still does
 * (#901). Optional: clients without a session identity fall back to the
 * profile-wide bench.
 */
export function mapModelToClaudeModel(model: string, subscriptionType?: string | null, agentMode?: string | null, profileId?: string, sessionKey?: string): ClaudeModel {
  if (model.includes("haiku")) return "haiku"

  const use1m = supports1mContext(model)
  // Subagents handle focused subtasks and don't benefit from 1M context.
  // Using the base model preserves rate limit budget for the primary agent.
  const isSubagent = agentMode === "subagent"

  // Fable [1m]: the fable tier supports the 1M extended context window and,
  // like Opus, is included on Max with no Extra Usage charge (verified on Max —
  // a fable[1m] request returns normally, no Extra Usage error). Mirrors the
  // opus handling: [1m] for primary agents, base model for subagents, honoring
  // the shared Extra Usage cooldown so a future billing change auto-downgrades.
  // Every fable generation rides the one alias, so this covers Fable 5.1
  // (the canonical pin) and Fable 5 alike.
  //
  // Mythos rides the fable tier: Claude Mythos 5 / 5.1 (claude-mythos-5,
  // claude-mythos-5-1, Project Glasswing) share the matching Fable model's
  // context window and API surface, and the Claude Agent SDK has no separate
  // "mythos" alias. Routing it here (instead of the sonnet fallthrough) keeps
  // explicit mythos requests on the right tier; server.ts pins
  // ANTHROPIC_DEFAULT_FABLE_MODEL to the requested claude-mythos-* id so the
  // concrete model passes through verbatim.
  //
  // Per-tier opt-out (#702). Fable 1M is included at no Extra Usage cost on
  // Max and Team (verified live), so [1m] stays the default — but on plans
  // where it is NOT included, a user with Extra Usage ENABLED is billed
  // silently: the request succeeds, so the extra-usage fallback below never
  // fires. The global MERIDIAN_1M_CONTEXT_SUPPORT switch would also give up
  // opus[1m], which IS included. Only "fable" (normalized) opts out; the
  // [1m] form is a documented no-op; anything else (including unset) leaves
  // the default untouched, with a once-per-process warning for typos.
  if (model.includes("fable") || model.includes("mythos")) {
    const fableOverrideRaw = env("FABLE_MODEL")
    const fableOverride = fableOverrideRaw?.trim().toLowerCase()
    if (fableOverride === "fable") return "fable"
    if (fableOverrideRaw && fableOverride !== "fable[1m]") {
      warnUnrecognizedTierOverride("FABLE_MODEL", fableOverrideRaw, "fable")
    }
    if (use1m && !isSubagent && !isExtendedContextKnownUnavailable(profileId, sessionKey)) return "fable[1m]"
    return "fable"
  }

  // Opus [1m]: included with Max, Team, and Enterprise subscriptions per
  // Anthropic docs (https://code.claude.com/docs/en/model-config#extended-context).
  // Safe to default to [1m] for Max users — no Extra Usage charges.
  // NOTE: There is a known upstream bug (anthropics/claude-code#39841) where
  // Claude Code currently gates opus[1m] behind Extra Usage even on Max.
  // We follow the documented behavior; the bug is Anthropic's to fix.
  //
  // Per-tier opt-out (#702), same shape as fable above — affected users need
  // a remedy that doesn't also disable fable. Only "opus" (normalized) opts
  // out; the [1m] form is a documented no-op; anything else (including
  // unset) leaves the default untouched, with a once-per-process warning
  // for typos.
  if (model.includes("opus")) {
    const opusOverrideRaw = env("OPUS_MODEL")
    const opusOverride = opusOverrideRaw?.trim().toLowerCase()
    if (opusOverride === "opus") return "opus"
    if (opusOverrideRaw && opusOverride !== "opus[1m]") {
      warnUnrecognizedTierOverride("OPUS_MODEL", opusOverrideRaw, "opus")
    }
    if (use1m && !isSubagent && !isExtendedContextKnownUnavailable(profileId, sessionKey)) return "opus[1m]"
    return "opus"
  }

  // Sonnet [1m]: requires Extra Usage on Max plans per Anthropic docs.
  // Unlike Opus, Sonnet 1M is NOT included with the Max subscription —
  // it is always billed as Extra Usage. Default to sonnet (200k) to
  // avoid unexpected charges. Users opt in via MERIDIAN_SONNET_MODEL=sonnet[1m].
  const sonnetOverride = process.env.MERIDIAN_SONNET_MODEL ?? process.env.CLAUDE_PROXY_SONNET_MODEL
  if (sonnetOverride === "sonnet[1m]") {
    if (!use1m || isSubagent || isExtendedContextKnownUnavailable(profileId, sessionKey)) return "sonnet"
    return "sonnet[1m]"
  }

  return "sonnet"
}

// ---------------------------------------------------------------------------
// Extended context availability — time-based cooldown
// ---------------------------------------------------------------------------

/** How long to skip [1m] models after confirming Extra Usage is not enabled. */
const EXTRA_USAGE_RETRY_MS = 60 * 60 * 1000 // 1 hour

/**
 * "[1m] is benched until" timestamps, keyed by scope.
 *
 * Two scopes share this map, because the two reasons to bench have genuinely
 * different blast radii:
 *
 *  - **Profile scope** (`recordExtendedContextUnavailable`) — Extra Usage is a
 *    subscription setting. When an account does not have it, no session on that
 *    account can use [1m], so the whole profile is benched. This was once a
 *    single process-global timestamp, which benched [1m] for EVERY profile the
 *    moment any one of them failed — an account whose plan includes the 1M
 *    window lost it for an hour because an unrelated account ran out of Extra
 *    Usage (#862).
 *
 *  - **Session scope** (`recordExtendedContextRateLimited`) — a plain rate
 *    limit. Benching the whole profile here is what let one child of a
 *    concurrent harness downgrade every sibling to the 200k model at the same
 *    instant, and the model switch cold-caches each of them: their cached
 *    prefixes were built on the 1M model, so the "cheap" fallback costs a full
 *    re-read of every sibling's context (#901). Each session now learns from
 *    its own refusal. If the account's window really is spent, every session
 *    still discovers that — one extra refused attempt each, once, instead of N
 *    simultaneous cache misses.
 *
 * Requests carrying no profile share one default bucket, and requests carrying
 * no session key fall back to profile scope, which leaves the single-session
 * case behaving exactly as it did.
 */
const DEFAULT_BENCH_KEY = "__default__"
/** Bound on session-scoped entries so a long-lived proxy cannot accumulate one
 *  per conversation forever. Entries are all self-expiring, so the sweep below
 *  reclaims normally and the eviction is a backstop. */
const BENCH_MAX_ENTRIES = 5000
const extendedContextBenchedUntil = new Map<string, number>()

function profileBenchKey(profileId: string | undefined): string {
  return profileId || DEFAULT_BENCH_KEY
}

/** Session keys are namespaced under their profile so the same client session
 *  id on two accounts cannot share a bench. The separator is NUL because a
 *  profile id and a client session id are both arbitrary strings: any printable
 *  delimiter is a value one of them could legitimately contain, and a collision
 *  here would silently bench the wrong conversation. */
function sessionBenchKey(profileId: string | undefined, sessionKey: string): string {
  return `${profileBenchKey(profileId)}\u0000session:${sessionKey}`
}

function pruneBenchEntries(now: number): void {
  if (extendedContextBenchedUntil.size < BENCH_MAX_ENTRIES) return
  for (const [key, until] of extendedContextBenchedUntil) {
    if (until <= now) extendedContextBenchedUntil.delete(key)
  }
  while (extendedContextBenchedUntil.size >= BENCH_MAX_ENTRIES) {
    // Everything left is live; drop whichever frees up soonest.
    let soonestKey: string | undefined
    let soonest = Infinity
    for (const [key, until] of extendedContextBenchedUntil) {
      if (until < soonest) { soonest = until; soonestKey = key }
    }
    if (soonestKey === undefined) return
    extendedContextBenchedUntil.delete(soonestKey)
  }
}

/**
 * Bench one scope's [1m] access until `until`.
 *
 * A later mark extends an earlier one; an earlier mark never shortens a longer
 * bench. Two concurrent failures must not un-learn the longer reset — the same
 * rule `ProfileExhaustion.mark` follows, and for the same reason.
 */
function benchExtendedContext(key: string, until: number): void {
  const now = Date.now()
  if (until <= now) return
  const existing = extendedContextBenchedUntil.get(key)
  if (existing !== undefined && existing >= until) return
  pruneBenchEntries(now)
  extendedContextBenchedUntil.set(key, until)
}

function benchActive(key: string, now: number): boolean {
  const until = extendedContextBenchedUntil.get(key)
  if (until === undefined) return false
  if (until <= now) {
    extendedContextBenchedUntil.delete(key)
    return false
  }
  return true
}

/**
 * Record that Extra Usage is not enabled on this subscription.
 * For the next hour, mapModelToClaudeModel will return the base model
 * directly — no failed [1m] attempt per request. After the cooldown
 * the next request probes [1m] once; if Extra Usage was enabled in the
 * meantime it succeeds and the flag is never set again.
 *
 * Profile-wide on purpose: entitlement is a property of the account, not of
 * the conversation that happened to discover it. Every session on this profile
 * would fail identically, so making each one prove that costs N failed
 * requests and buys nothing.
 */
export function recordExtendedContextUnavailable(profileId?: string): void {
  benchExtendedContext(profileBenchKey(profileId), Date.now() + EXTRA_USAGE_RETRY_MS)
}

/**
 * Record that a [1m] request was rate-limited, benching it until `until`.
 *
 * Callers derive `until` from the account's own observed reset rather than a
 * constant. Stripping [1m] on a rate limit while recording nothing is what
 * makes the next request map straight back to [1m]: the conversation then
 * flaps between two models and pays a cold prompt cache in BOTH directions,
 * which routinely costs more than the rate limit it was routing around (#862).
 *
 * Scoped to `sessionKey` when the client has a session identity, so a harness
 * running N children through one account no longer downgrades — and cold-caches
 * — every sibling because one child hit the limit (#901). Without a session
 * key there is nothing narrower to scope to, so the bench stays profile-wide.
 */
export function recordExtendedContextRateLimited(
  profileId: string | undefined,
  until: number,
  sessionKey?: string,
): void {
  benchExtendedContext(
    sessionKey ? sessionBenchKey(profileId, sessionKey) : profileBenchKey(profileId),
    until,
  )
}

/**
 * Returns true while [1m] is benched for this profile, or for this session on
 * it. Expired marks are dropped on read, so the next request probes [1m] once —
 * and if the window has genuinely reset, it simply succeeds.
 */
export function isExtendedContextKnownUnavailable(profileId?: string, sessionKey?: string): boolean {
  const now = Date.now()
  if (benchActive(profileBenchKey(profileId), now)) return true
  return sessionKey ? benchActive(sessionBenchKey(profileId, sessionKey), now) : false
}

/** Clear extended-context benches — for testing only. Clearing a profile also
 *  clears every session benched under it. Clears everything when no id is
 *  given. */
export function resetExtendedContextUnavailable(profileId?: string): void {
  if (!profileId) {
    extendedContextBenchedUntil.clear()
    return
  }
  const prefix = `${profileBenchKey(profileId)}\u0000`
  extendedContextBenchedUntil.delete(profileBenchKey(profileId))
  for (const key of extendedContextBenchedUntil.keys()) {
    if (key.startsWith(prefix)) extendedContextBenchedUntil.delete(key)
  }
}

/**
 * Strip the [1m] suffix from a model, returning the base variant.
 * Used for fallback when the 1M context window is rate-limited.
 */
export function stripExtendedContext(model: ClaudeModel): ClaudeModel {
  if (model === "opus[1m]") return "opus"
  if (model === "sonnet[1m]") return "sonnet"
  if (model === "fable[1m]") return "fable"
  return model
}

/**
 * Check whether a model is using extended (1M) context.
 */
export function hasExtendedContext(model: ClaudeModel): boolean {
  return model.endsWith("[1m]")
}

/**
 * Subscription tiers that include the Opus/Fable 1M extended context window
 * at no Extra Usage cost, per Anthropic's docs
 * (https://code.claude.com/docs/en/model-config#extended-context): Max, Team,
 * and Enterprise. Pro and unknown tiers are not included.
 *
 * Max is matched by prefix because the auth payload reports plan variants
 * ("max", "max_5x", "max_20x", ...) rather than a bare tier name.
 */
const EXTENDED_CONTEXT_SUBSCRIPTION_PREFIXES: readonly string[] = ["max", "team", "enterprise"]

/**
 * Whether a subscription tier includes 1M context on the Opus/Fable tiers.
 *
 * This is the single source of truth for *advertising* the extended window
 * (e.g. `GET /v1/models`). It deliberately does NOT gate routing:
 * mapModelToClaudeModel stays optimistic and lets the runtime Extra-Usage
 * fallback (recordExtendedContextUnavailable) downgrade when a plan turns out
 * not to include it — an unknown or stale tier string must never silently cost
 * a user their 1M window mid-conversation.
 *
 * Pure — string inspection only, no I/O.
 */
export function subscriptionIncludesExtendedContext(subscriptionType?: string | null): boolean {
  if (!subscriptionType) return false
  const normalized = subscriptionType.trim().toLowerCase()
  if (!normalized) return false
  return EXTENDED_CONTEXT_SUBSCRIPTION_PREFIXES.some((tier) => normalized.startsWith(tier))
}

/** Per-profile auth status cache for multi-account support */
interface AuthCache {
  status: ClaudeAuthStatus | null
  lastKnownGood: ClaudeAuthStatus | null
  at: number
  isFailure: boolean
  /** Consecutive failed checks, for the retry backoff. 0 after a success. */
  failures: number
  promise: Promise<ClaudeAuthStatus | null> | null
  lastSuccessAt: number
  credMtimeMs: number
}
const profileAuthCaches = new Map<string, AuthCache>()

interface CachedAuthRefresh extends AuthRefresh {
  promise: Promise<ClaudeAuthStatus | null>
}
const authRefreshes = new Map<string, CachedAuthRefresh>()
let authCacheGeneration = 0

function attachAuthOwner(refresh: AuthRefresh, owner?: AuthStatusOwnerState): void {
  if (refresh.cancelled) return
  if (owner) {
    refresh.owners.add(owner)
    owner.refreshes.add(refresh)
  } else refresh.unowned = true
}

/** Get the last successful auth check timestamp for a profile.
 * @param profileId - Profile ID to look up (uses default cache when omitted) */
export function getAuthCacheInfo(profileId?: string): { lastCheckedAt: number; lastSuccessAt: number; isFailure: boolean } {
  if (!profileId) {
    return { lastCheckedAt: cachedAuthStatusAt, lastSuccessAt: cachedAuthStatusLastSuccessAt, isFailure: cachedAuthStatusIsFailure }
  }
  const cache = profileAuthCaches.get(profileId)
  if (!cache) return { lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }
  return { lastCheckedAt: cache.at, lastSuccessAt: cache.lastSuccessAt, isFailure: cache.isFailure }
}

function getAuthCache(key: string): AuthCache {
  let cache = profileAuthCaches.get(key)
  if (!cache) {
    cache = { status: null, lastKnownGood: null, at: 0, isFailure: false, failures: 0, promise: null, lastSuccessAt: 0, credMtimeMs: 0 }
    profileAuthCaches.set(key, cache)
  }
  return cache
}

/**
 * @param profileId - Profile ID for per-profile cache keying (e.g. "work", "personal").
 *   When undefined, uses the default (global) auth context.
 * @param envOverrides - Optional env vars for per-profile auth (e.g. CLAUDE_CONFIG_DIR).
 */
export function getClaudeAuthStatusAsync(profileId?: string, envOverrides?: Record<string, string>): Promise<ClaudeAuthStatus | null> {
  return getOwnedClaudeAuthStatusAsync(profileId, envOverrides, authStatusOwnerContext.getStore())
}

async function getOwnedClaudeAuthStatusAsync(profileId?: string, envOverrides?: Record<string, string>, owner?: AuthStatusOwnerState): Promise<ClaudeAuthStatus | null> {
  if (owner?.closed) return null
  // Use per-profile cache when a profile ID is provided, else fall back to
  // the legacy global cache for backward compatibility with existing tests.
  const isDefault = !profileId
  const cache = isDefault ? null : getAuthCache(profileId!)

  // Read from the appropriate cache
  const c_status = cache ? cache.status : cachedAuthStatus
  const c_lastKnownGood = cache ? cache.lastKnownGood : lastKnownGoodAuthStatus
  const c_at = cache ? cache.at : cachedAuthStatusAt
  const c_isFailure = cache ? cache.isFailure : cachedAuthStatusIsFailure
  const c_failures = cache ? cache.failures : cachedAuthStatusFailures

  const c_credMtime = cache ? cache.credMtimeMs : cachedAuthStatusCredMtimeMs

  const ttl = c_isFailure ? authStatusFailureTtlMs(c_failures) : AUTH_STATUS_CACHE_TTL_MS
  // A changed credential file means the other instance rotated the token, so
  // the cached answer predates it regardless of how recently it was taken.
  // Always 0 === 0 unless MERIDIAN_CREDENTIALS_READONLY is set.
  const credMtime = credentialFileMtimeMs(envOverrides)
  const previous = c_status ?? c_lastKnownGood
  if (c_at > 0 && Date.now() - c_at < ttl && credMtime === c_credMtime) {
    return previous
  }

  // Stale-while-revalidate. `/health` reads this on every probe, and the
  // refresh spawns the claude binary, which a loaded host stretches past any
  // probe timeout; a load balancer probing with a shorter timeout marked a
  // healthy proxy down each time the cache expired. With a previous answer in
  // hand, serve it and refresh in the background - a changed answer reaches
  // the next caller. Only a caller with nothing to fall back on waits, and only
  // for AUTH_STATUS_WAIT_MS: the check outlives that wait and answers whoever
  // asks after it lands. One refresh at a time: concurrent callers share the
  // in-flight one.
  const key = profileId ?? ""
  const refresh = authRefreshes.get(key)
    ?? startAuthStatusRefresh(cache, profileId, envOverrides, credMtime)
  attachAuthOwner(refresh, owner)
  return previous ?? waitForFirstAnswer(refresh.promise)
}

/** The check in flight, or null - "could not verify" - once the caller's wait runs out. */
function waitForFirstAnswer(inflight: Promise<ClaudeAuthStatus | null>): Promise<ClaudeAuthStatus | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const waitOver = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), authStatusWaitMs)
    timer.unref?.()
  })
  return Promise.race([inflight, waitOver]).finally(() => clearTimeout(timer))
}

const warnedAuthStatusFailures = new Map<string, string>()

const authContextLabel = (profileId: string | undefined) => profileId ? `profile "${profileId}"` : "the default account"
const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

function reportedLoggedIn(stdout: unknown): boolean | undefined {
  try {
    const loggedIn: unknown = JSON.parse(String(stdout))?.loggedIn
    return typeof loggedIn === "boolean" ? loggedIn : undefined
  } catch {
    return undefined
  }
}

/**
 * Why a `claude auth status` run gave no answer, in terms an operator can act
 * on. Never quotes the CLI's output, which carries the account's email.
 */
function describeAuthStatusFailure(err: unknown): string {
  if (err instanceof AuthStatusProcessFailure) {
    if (err.reason === "join") return "Claude auth-status process cleanup is unconfirmed; no replacement check will start"
    if (err.reason === "cancelled") return "Claude auth-status check cancelled during instance shutdown"
    return `no answer within ${AUTH_STATUS_SPAWN_TIMEOUT_MS / 1000}s, so the check was killed`
  }
  const e = err as { killed?: boolean; signal?: string | null; code?: unknown; stdout?: unknown } | null
  if (e?.killed) return `no answer within ${AUTH_STATUS_SPAWN_TIMEOUT_MS / 1000}s, so the check was killed`
  if (typeof e?.code === "number") {
    const loggedIn = reportedLoggedIn(e.stdout)
    return `\`claude auth status\` exited with code ${e.code}${loggedIn === undefined ? "" : ` reporting loggedIn: ${loggedIn}`}`
  }
  if (e?.signal) return `\`claude auth status\` was terminated by ${e.signal}`
  if (typeof e?.code === "string") return `could not run \`claude auth status\` (${e.code})`
  if (err instanceof SyntaxError) return "`claude auth status` answered with output that is not JSON"
  return (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200)
}

function warnAuthStatusFailure(profileId: string | undefined, reason: string, failures: number, everAnswered: boolean, retryInMs: number): void {
  const key = profileId ?? ""
  // A check that keeps failing the same way is retried for as long as the
  // proxy runs: warn on the 1st, 2nd, 4th, 8th... repeat, or when it changes.
  const quietRepeat = warnedAuthStatusFailures.get(key) === reason && (failures & (failures - 1)) !== 0
  warnedAuthStatusFailures.set(key, reason)
  if (quietRepeat) return
  // Not gated on `silent`: an account the proxy cannot verify is not routine
  // chatter, and the throttle above keeps a persistent failure to a few lines.
  console.warn(
    `[PROXY] Could not verify Claude auth status for ${authContextLabel(profileId)}: ${reason} ` +
    `(${failures} in a row; ${everAnswered ? "serving the last known status" : "no status known yet"}; next check in ${Math.round(retryInMs / 1000)}s)`,
  )
}

function noteAuthStatusAnswered(profileId: string | undefined, priorFailures: number, everAnswered: boolean, elapsedMs: number): void {
  warnedAuthStatusFailures.delete(profileId ?? "")
  if (priorFailures > 0) {
    console.warn(`[PROXY] Verified Claude auth status for ${authContextLabel(profileId)} after ${priorFailures} failed check${priorFailures === 1 ? "" : "s"} (this one took ${formatSeconds(elapsedMs)})`)
  } else if (!everAnswered && elapsedMs > authStatusWaitMs) {
    console.warn(`[PROXY] Claude auth status for ${authContextLabel(profileId)} took ${formatSeconds(elapsedMs)} to answer; it read as unverified until then`)
  }
}

function startAuthStatusRefresh(
  cache: AuthCache | null,
  profileId: string | undefined,
  envOverrides: Record<string, string> | undefined,
  credMtime: number,
): CachedAuthRefresh {
  const startedAt = Date.now()
  const generation = authCacheGeneration
  let resolveJoined!: () => void
  const state: CachedAuthRefresh = {
    owners: new Set(), unowned: false, cancelled: false,
    promise: Promise.resolve(null),
    joined: new Promise<void>(resolve => { resolveJoined = resolve }),
  }
  // Register before the first await, so a sibling adopts the same refresh.
  authRefreshes.set(profileId ?? "", state)
  const refresh = (async (): Promise<ClaudeAuthStatus | null> => {
    try {
      // Route through the resolver instead of relying on `claude` being
      // on PATH. Stefan's case (#478): bunx-installed meridian under
      // systemd, no global claude binary — `exec("claude auth status")`
      // fails before we ever spawn the SDK subprocess. The resolved
      // executable comes from the same lookup chain that powers the SDK
      // call (env > bundled > platform-package > PATH > legacy-cli-js),
      // so this path works in every install layout the SDK already
      // supports. execFile (vs exec) avoids any quoting issues with
      // spaces in the resolved path.
      state.resolver = acquireClaudeResolution()
      const claudePath = await state.resolver.result
      if (state.cancelled) return cache ? cache.lastKnownGood : lastKnownGoodAuthStatus
      state.process = startAuthStatusProcess(claudePath, {
        timeoutMs: AUTH_STATUS_SPAWN_TIMEOUT_MS,
        ...(envOverrides ? { env: { ...process.env, ...envOverrides } } : {}),
      })
      void state.process.joined.then(resolveJoined)
      const stdout = await state.process.result
      const parsed = JSON.parse(stdout) as ClaudeAuthStatus
      if (generation !== authCacheGeneration || state.cancelled) return cache ? cache.lastKnownGood : lastKnownGoodAuthStatus
      // The same payload the CLI path logs, from the reader every HTTP route
      // goes through. Both are logged because they can disagree: this one is
      // TTL-cached per profile and falls back to a last-known-good value, so a
      // field visible here may be minutes old while the CLI reads it live.
      claudeLog("auth.status_discovered", {
        source: "cli_async",
        profile: profileId ?? "default",
        fields: authFieldPaths(parsed),
        payload: describeAuthFields(parsed),
      })
      noteAuthStatusAnswered(
        profileId,
        cache ? cache.failures : cachedAuthStatusFailures,
        Boolean(cache ? cache.lastKnownGood : lastKnownGoodAuthStatus),
        Date.now() - startedAt,
      )
      if (cache) {
        cache.status = parsed; cache.lastKnownGood = parsed
        cache.at = Date.now(); cache.isFailure = false; cache.failures = 0; cache.lastSuccessAt = Date.now()
        cache.credMtimeMs = credMtime
      } else {
        cachedAuthStatus = parsed; lastKnownGoodAuthStatus = parsed
        cachedAuthStatusAt = Date.now(); cachedAuthStatusIsFailure = false; cachedAuthStatusFailures = 0
        cachedAuthStatusLastSuccessAt = cachedAuthStatusAt
        cachedAuthStatusCredMtimeMs = credMtime
      }
      return parsed
    } catch (err) {
      if (generation !== authCacheGeneration || state.cancelled) return cache ? cache.lastKnownGood : lastKnownGoodAuthStatus
      // Exit 1 with a complete negative answer is a logout, not an unavailable
      // probe. Keeping the last login here resurrects a credential the CLI has
      // explicitly rejected. A killed/failed process still keeps its fallback.
      if (err instanceof Error && "code" in err && err.code === 1
        && !("killed" in err && err.killed === true)
        && !("signal" in err && err.signal != null)
        && "stdout" in err && reportedLoggedIn(err.stdout) === false) {
        const status: ClaudeAuthStatus = { ...(cache ? cache.lastKnownGood : lastKnownGoodAuthStatus), loggedIn: false }
        console.warn(`[PROXY] Claude auth status for ${authContextLabel(profileId)} exited with code 1 reporting loggedIn: false; login required`)
        if (cache) {
          cache.status = status; cache.lastKnownGood = status
          cache.at = Date.now(); cache.isFailure = false; cache.failures = 0
          cache.credMtimeMs = credMtime
        } else {
          cachedAuthStatus = status; lastKnownGoodAuthStatus = status
          cachedAuthStatusAt = Date.now(); cachedAuthStatusIsFailure = false; cachedAuthStatusFailures = 0
          cachedAuthStatusCredMtimeMs = credMtime
        }
        return status
      }
      const failures = (cache ? cache.failures : cachedAuthStatusFailures) + 1
      const everAnswered = Boolean(cache ? cache.lastKnownGood : lastKnownGoodAuthStatus)
      const retryInMs = authStatusFailureTtlMs(failures)
      claudeLog("auth.status_failed", {
        source: "cli_async",
        profile: profileId ?? "default",
        error: String(err),
        servingLastKnownGood: everAnswered,
        consecutiveFailures: failures,
        retryInMs,
      })
      warnAuthStatusFailure(profileId, describeAuthStatusFailure(err), failures, everAnswered, retryInMs)
      if (cache) {
        cache.isFailure = true; cache.failures = failures; cache.at = Date.now(); cache.status = null
        cache.credMtimeMs = credMtime
        return cache.lastKnownGood
      } else {
        cachedAuthStatusIsFailure = true; cachedAuthStatusFailures = failures; cachedAuthStatusAt = Date.now()
        cachedAuthStatus = null
        cachedAuthStatusCredMtimeMs = credMtime
        return lastKnownGoodAuthStatus
      }
    } finally {
      if (!state.process) void state.resolver?.joined.then(resolveJoined)
    }
  })()

  const release = () => {
    if (authRefreshes.get(profileId ?? "") === state) authRefreshes.delete(profileId ?? "")
    if (cache) {
      if (cache.promise === state.promise) cache.promise = null
    } else if (cachedAuthStatusPromise === state.promise) cachedAuthStatusPromise = null
    for (const owner of state.owners) owner.refreshes.delete(state)
    state.owners.clear()
  }
  // Release confirmed settlement before exposing the result to callers. A
  // result that failed due to an unknown join keeps its slot until a late join.
  state.promise = refresh.finally(() => {
    if (state.resolver?.isJoined() && (!state.process || state.process.isJoined())) release()
  })
  if (cache) cache.promise = state.promise
  else cachedAuthStatusPromise = state.promise
  void Promise.all([state.promise, state.joined]).then(release)
  return state
}

/** The auth-status refresh currently in flight, if any - for testing only. */
export function pendingAuthStatusRefresh(profileId?: string): Promise<ClaudeAuthStatus | null> | null {
  if (!profileId) return cachedAuthStatusPromise
  return profileAuthCaches.get(profileId)?.promise ?? null
}

// --- Claude Executable Resolution ---

/**
 * Tag identifying which resolver step produced the path. Surfaced at startup
 * and in `/health` so users can self-diagnose "wrong claude got picked"
 * without having to inspect their PATH manually (closes the diagnostic gap
 * from #478, where a Bun-shimmed `claude` on PATH led to silent failures
 * that looked indistinguishable from any other SDK error).
 */
export type ClaudeExecutableSource =
  | "env"               // MERIDIAN_CLAUDE_PATH override
  | "custom"            // claudeExecutablePath setting, in custom mode
  | "bundled"           // node_modules/@anthropic-ai/claude-code/bin/claude.exe
  | "platform-package"  // @anthropic-ai/claude-code-<platform>-<arch>/claude
  | "path-lookup"       // `which`/`where claude` PATH lookup
  | "legacy-cli-js"     // SDK cli.js fallback (Bun-only)

export interface ClaudeExecutableInfo {
  path: string
  source: ClaudeExecutableSource
}

let cachedClaudeInfo: ClaudeExecutableInfo | null = null
type ClaudeResolution = ReturnType<typeof createClaudeResolution> & { info(): ClaudeExecutableInfo | null }
let cachedClaudeResolution: ClaudeResolution | null = null
const activeClaudeResolutions = new Set<ClaudeResolution>()
// The executable preference each of the two above was resolved under. A turn
// that finds a different one saved re-resolves, which is what lets the
// setting take effect without a restart.
let cachedClaudeInfoPreference: string | null = null
let cachedClaudeResolutionPreference: string | null = null

/**
 * Resolve the Claude executable path asynchronously (non-blocking).
 *
 * Uses a three-tier cache:
 * 1. cachedClaudePath — resolved path, returned immediately on subsequent calls
 * 2. cachedClaudeResolution — shares subprocess custody through independent leases
 * 3. Falls through to env → usable PATH → packaged CLI → legacy SDK resolution
 *
 * Shared resolution releases only after its actual subprocess joins. Unknown
 * cleanup retains the slot; a successful cached path avoids re-resolution.
 */
/**
 * Resolver step contract — each tries one source, returns a path on success
 * or null on miss. Failures (thrown errors) are caught by the caller and
 * treated as misses so unresolved sources never block subsequent steps.
 */
type ResolverDeps = {
  existsSync: (p: string) => boolean
  statSync: (p: string) => { size: number }
  exec: (cmd: string) => Promise<{ stdout: string }>
  checkActive?: () => void
  execLookupSync?: (command: string, args: string[]) => string
  probeClaude?: (candidate: string, timeoutMs?: number) => Promise<ClaudeProbeResult>
  probeClaudeSync?: (candidate: string, timeoutMs?: number) => ClaudeProbeResult
  /** Monotonic clock; injectable for aggregate-budget controls. */
  now?: () => number
  /** The operator's executable preference; system when absent. */
  preference?: () => ClaudeExecutablePreference
  /** Reports an executable passed over, or a PATH candidate slow to answer; silent when absent. */
  warn?: (message: string) => void
  resolvePackage: (specifier: string) => string
  envGet: (name: string) => string | undefined
  platform: NodeJS.Platform
  arch: string
  isBun: boolean
}

/** What `claude --version` established about a `claude` found on PATH. */
type ClaudeProbeResult =
  | { usable: true; elapsedMs?: number }
  | { usable: false; reason: string }

const DEFAULT_DEPS: ResolverDeps = {
  existsSync,
  statSync: (p) => statSync(p),
  exec: async (cmd) => ({ stdout: await sharedClaudeProbe(`lookup:${cmd}:${process.env.PATH ?? ""}`, { shell: cmd }, 2000, 64 * 1024) }),
  // `env` is explicit because Bun 1.3's execFileSync otherwise hands the child
  // the environment the process started with, so the sync resolver could search
  // a different PATH than the async one.
  execLookupSync: (command, args) => execFileSync(command, args, {
    encoding: "utf8", windowsHide: true, timeout: 2000, maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"], env: process.env,
  }),
  probeClaude: (candidate, timeoutMs) => probeClaudeVersion(candidate, timeoutMs),
  probeClaudeSync: (candidate, timeoutMs) => probeClaudeVersionSync(candidate, timeoutMs),
  preference: savedClaudeExecutablePreference,
  warn: message => console.warn(message),
  resolvePackage: (specifier) => fileURLToPath(import.meta.resolve(specifier)),
  envGet: (name) => process.env[name],
  platform: process.platform,
  arch: process.arch,
  isBun: typeof process.versions.bun !== "undefined",
}

/**
 * Ask a PATH candidate for `--version`. Only its answer, or no answer within
 * `timeoutMs`, decides: a cold installation is slow, not broken.
 */
export async function probeClaudeVersion(candidate: string, timeoutMs = CLAUDE_PROBE_TIMEOUT_MS): Promise<ClaudeProbeResult> {
  const startedAt = Date.now()
  try {
    const stdout = await startOwnedClaudeProcess({ file: candidate, args: ["--version"] }, {
      timeoutMs, maxBuffer: 16 * 1024,
    }).result
    return judgeVersionOutput(stdout, Date.now() - startedAt)
  } catch (err) {
    return { usable: false, reason: describeProbeFailure(err, timeoutMs) }
  }
}

/** `probeClaudeVersion` for the synchronous CLI resolver. */
export function probeClaudeVersionSync(candidate: string, timeoutMs = CLAUDE_PROBE_TIMEOUT_MS): ClaudeProbeResult {
  const startedAt = Date.now()
  try {
    const stdout = execFileSync(candidate, ["--version"], {
      encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024,
      stdio: ["ignore", "pipe", "pipe"], env: process.env,
    })
    return judgeVersionOutput(stdout, Date.now() - startedAt)
  } catch (err) {
    return { usable: false, reason: describeProbeFailure(err, timeoutMs) }
  }
}

function judgeVersionOutput(stdout: string, elapsedMs: number): ClaudeProbeResult {
  if (isClaudeVersionOutput(stdout)) return { usable: true, elapsedMs }
  const firstLine = stdout.trim().split(/\r?\n/)[0]
  return {
    usable: false,
    reason: firstLine ? `\`--version\` printed "${firstLine.slice(0, 80)}", which is not a Claude Code version` : "`--version` printed nothing",
  }
}

/** Why a candidate gave no usable answer to `--version`, in terms an operator can act on. */
function describeProbeFailure(err: unknown, timeoutMs: number): string {
  if (err instanceof AuthStatusProcessFailure && err.reason === "timeout") return `no answer to \`--version\` within ${timeoutMs / 1000}s`
  const e = err as { killed?: boolean; code?: unknown; status?: unknown; signal?: unknown; message?: unknown } | null
  // execFile kills at its timeout and leaves `code` empty; execFileSync reports ETIMEDOUT.
  if (e?.code === "ETIMEDOUT" || (e?.killed === true && e.code == null)) return `no answer to \`--version\` within ${timeoutMs / 1000}s`
  const exitCode = typeof e?.code === "number" ? e.code : e?.status
  if (typeof exitCode === "number") return `\`--version\` exited with code ${exitCode}`
  if (typeof e?.signal === "string") return `\`--version\` was terminated by ${e.signal}`
  if (typeof e?.code === "string") return `it could not be run (${e.code})`
  return String(e?.message ?? err).split("\n")[0]!.slice(0, 200)
}

/**
 * Whether to keep a PATH candidate. Passing one over moves the proxy to
 * another installation, and possibly another Claude Code version, so it is
 * always said, with the reason.
 */
function keepPathCandidate(candidate: string, result: ClaudeProbeResult, deps: ResolverDeps): boolean {
  if (!result.usable) {
    deps.warn?.(
      `[PROXY] Not using the claude found on PATH at ${candidate}: ${result.reason}. ` +
      "Falling back to the next Claude Code installation; set MERIDIAN_CLAUDE_PATH to choose one explicitly.",
    )
    return false
  }
  const elapsedMs = result.elapsedMs ?? 0
  if (elapsedMs >= CLAUDE_PROBE_SLOW_MS) {
    deps.warn?.(`[PROXY] The claude found on PATH at ${candidate} took ${(elapsedMs / 1000).toFixed(1)}s to answer \`--version\`, likely a cold start; using it.`)
  }
  return true
}

/**
 * Step 0: explicit env override. Non-empty MERIDIAN_CLAUDE_PATH wins
 * unconditionally, so users with broken installs / unusual setups can
 * always point at a known-good binary. Mirrors the escape-hatch
 * convention used by other proxy env vars.
 */
function tryEnvOverride(deps: ResolverDeps): string | null {
  const explicit = deps.envGet("MERIDIAN_CLAUDE_PATH")
  if (!explicit) return null
  return deps.existsSync(explicit) ? explicit : null
}

/**
 * Custom mode: the executable the operator chose in settings. Like the env
 * override it only has to exist, so a cold start is never mistaken for a
 * broken install. The settings API vets it as it is chosen; one that has gone
 * since - an upgrade removed its versioned directory, say - falls back to the
 * system order, and says so.
 */
function tryCustomPath(preference: ClaudeExecutablePreference, deps: ResolverDeps): string | null {
  if (preference.mode !== "custom" || !preference.customPath) return null
  if (deps.existsSync(preference.customPath)) return preference.customPath
  deps.warn?.(
    `[PROXY] The Claude Code executable chosen in Settings, ${preference.customPath}, does not exist; ` +
    "using the System order instead. Choose it again in Settings once it is back.",
  )
  return null
}

/** The copy packaged with Meridian: the bundled binary, else its platform package. */
function tryPackaged(deps: ResolverDeps): ClaudeExecutableInfo | null {
  const bundled = tryBundledBinary(deps)
  if (bundled) return { path: bundled, source: "bundled" }
  const platformPkg = tryPlatformPackage(deps)
  if (platformPkg) return { path: platformPkg, source: "platform-package" }
  return null
}

/**
 * Step 2: bundled `@anthropic-ai/claude-code/bin/claude.exe`.
 *
 * Skips the placeholder stub (≤4 KB) so we don't return a non-functional
 * file when the upstream postinstall failed (issue #445). The real
 * platform binary is ~200 MB; the stub is ~500 bytes.
 */
function tryBundledBinary(deps: ResolverDeps): string | null {
  try {
    const pkgPath = deps.resolvePackage("@anthropic-ai/claude-code/package.json")
    const bundled = join(dirname(pkgPath), "bin", "claude.exe")
    if (!deps.existsSync(bundled)) return null
    const size = deps.statSync(bundled).size
    if (size <= STUB_SIZE_THRESHOLD) return null
    return bundled
  } catch {
    return null
  }
}

/**
 * Step 3: platform-specific peer package
 * (`@anthropic-ai/claude-code-<platform>-<arch>`). This is where the
 * actual binary lives in the SDK ≥ 0.2.x split layout — the wrapper at
 * `claude-code/bin/claude.exe` is just a hardlink/copy from here.
 *
 * Bypasses the bundled-binary path entirely, so it works when the
 * upstream postinstall failed to do the link (#445) AND when the
 * bundled wrapper exists but fails to spawn on the host (#417 — Windows
 * `spawn UNKNOWN` reported by BenIsLegit, where the wrapper failed but
 * the platform-package binary worked).
 */
function tryPlatformPackage(deps: ResolverDeps): string | null {
  const binName = deps.platform === "win32" ? "claude.exe" : "claude"
  const candidates = [`@anthropic-ai/claude-code-${deps.platform}-${deps.arch}`]
  // Linux musl variant — claude-code ships a separate package for Alpine
  // and other musl-based distros.
  if (deps.platform === "linux") {
    candidates.push(`@anthropic-ai/claude-code-${deps.platform}-${deps.arch}-musl`)
  }
  for (const pkg of candidates) {
    try {
      const pkgJson = deps.resolvePackage(`${pkg}/package.json`)
      const candidate = join(dirname(pkgJson), binName)
      if (deps.existsSync(candidate)) return candidate
    } catch {
      // Package not installed for this arch — try the next candidate.
    }
  }
  return null
}

/**
 * Step 1: PATH lookup via `where claude` on Windows or `which claude` on POSIX.
 *
 * Windows nuances handled here:
 *   - `where` returns multiple newline-separated paths when multiple
 *     binaries match — pick the first existing one that can run Claude.
 *   - On systems with Git for Windows installed, plain `which claude`
 *     would invoke `which.exe` from `usr/bin/` which emits mingw-style
 *     paths like `/c/nvm4w/nodejs/claude` that `existsSync` rejects.
 *     Using `where` (the cmd.exe builtin / PowerShell-equivalent)
 *     avoids that whole class of bugs.
 *
 * Filtering: any path that starts with `/` on Windows is a mingw-style
 * path (real Windows paths start with a drive letter); skip them rather
 * than feed unusable strings to `existsSync`.
 */
async function tryPathLookup(deps: ResolverDeps): Promise<string | null> {
  const cmd = deps.platform === "win32" ? "where claude" : "which claude"
  const now = deps.now ?? (() => performance.now())
  const deadline = now() + CLAUDE_PROBE_TIMEOUT_MS
  try {
    const { stdout } = await deps.exec(cmd)
    for (const candidate of existingPathCandidates(stdout, deps)) {
      if (!deps.probeClaude) return candidate
      const remainingMs = Math.max(0, Math.floor(deadline - now()))
      if (remainingMs === 0) {
        warnProbeBudgetExhausted(candidate, deps)
        break
      }
      if (keepPathCandidate(candidate, await deps.probeClaude(candidate, remainingMs), deps)) return candidate
    }
  } catch {
    // No `claude` on PATH (or `where`/`which` not available).
  }
  return null
}

/** What `claude --version` prints, e.g. "2.1.284 (Claude Code)"; group 1 is the version. */
const CLAUDE_VERSION_OUTPUT = /^(\d+\.\d+\.\d+(?:[-+][\w.-]+)?) \(Claude Code\)$/

/** A broken installation or unrelated shim must not outrank the package. */
function isClaudeVersionOutput(stdout: string): boolean {
  return CLAUDE_VERSION_OUTPUT.test(stdout.trim())
}

/**
 * How long a version shown in Settings, or a path chosen there, may take to
 * answer. Generous because a ~220 MB binary evicted from the page cache has
 * been measured taking 15-40 s to start on a host under memory pressure.
 */
const CLAUDE_VERSION_READ_TIMEOUT_MS = 60_000

export type ClaudeVersionAnswer = { version: string } | { error: string }

const CLAUDE_VERSION_REMEMBER_MS = 10 * 60_000
const claudeVersionAnswers = new Map<string, { stamp: string; version: string; at: number }>()
const sharedClaudeProbes = new Map<string, { resolution: ReturnType<typeof createClaudeResolution>; identity?: string }>()

async function sharedClaudeProbe(key: string, command: { file: string; args: string[] } | { shell: string }, timeoutMs: number, maxBuffer: number, identity?: string): Promise<string> {
  assertClaudeProbeActive()
  const existing = sharedClaudeProbes.get(key)
  if (existing && existing.identity !== identity) {
    if (existing.resolution.hasUnconfirmedFailure()) throw new AuthStatusProcessFailure("join")
    throw new Error("executable changed during another version check; retry after it closes")
  }
  let resolution = existing?.resolution
  if (!resolution) {
    if (sharedClaudeProbes.size >= 16) throw new Error("Claude executable probes are busy; retry after they close")
    resolution = createClaudeResolution(async scope => {
      scope.active()
      return await scope.own(startOwnedClaudeProcess(command, { timeoutMs, maxBuffer })).result
    })
    sharedClaudeProbes.set(key, { resolution, identity })
    const owned = resolution
    void owned.joined.then(() => { if (sharedClaudeProbes.get(key)?.resolution === owned) sharedClaudeProbes.delete(key) })
  }
  const lease = resolution.acquire()
  ownClaudeProbe(lease)
  try {
    const answer = await lease.result
    assertClaudeProbeActive()
    return answer
  } finally { void lease.cancel().catch(() => undefined) }
}

/**
 * Ask an executable which Claude Code version it is, for Settings to show and
 * to vet a path chosen there. A version is remembered per file for ten
 * minutes, or until its size or mtime changes, so the page does not spawn a
 * 200 MB binary on every load; the time limit catches a wrapper or shim whose
 * target was upgraded underneath it. Failures are not remembered: the next
 * look may find a cold binary warm or a path fixed.
 */
export async function readClaudeVersion(path: string, timeoutMs = CLAUDE_VERSION_READ_TIMEOUT_MS): Promise<ClaudeVersionAnswer> {
  assertClaudeProbeActive()
  let stamp: string
  try {
    const stat = statSync(path)
    stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  } catch {
    return { error: "it does not exist" }
  }
  const remembered = claudeVersionAnswers.get(path)
  if (remembered?.stamp === stamp && Date.now() - remembered.at < CLAUDE_VERSION_REMEMBER_MS) return { version: remembered.version }
  try {
    const stdout = await sharedClaudeProbe(`version:${path}`, { file: path, args: ["--version"] }, timeoutMs, 16 * 1024, stamp)
    const after = statSync(path)
    if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== stamp) return { error: "executable changed during its version check; retry" }
    const version = CLAUDE_VERSION_OUTPUT.exec(stdout.trim())?.[1]
    if (version) {
      claudeVersionAnswers.set(path, { stamp, version, at: Date.now() })
      if (claudeVersionAnswers.size > 128) claudeVersionAnswers.delete(claudeVersionAnswers.keys().next().value!)
      return { version }
    }
    const firstLine = stdout.trim().split(/\r?\n/)[0]
    return { error: firstLine ? `\`--version\` printed "${firstLine.slice(0, 80)}", which is not a Claude Code version` : "`--version` printed nothing" }
  } catch (err) {
    if (err instanceof AuthStatusProcessFailure && err.reason === "join") throw err
    return { error: describeProbeFailure(err, timeoutMs) }
  }
}

/** The npm version a packaged binary was installed from, read from the package beside it. */
function packagedVersion(binary: string): string | null {
  // The bundled binary sits in the package's bin/; a platform package's at its root.
  for (const pkgJson of [join(dirname(binary), "package.json"), join(dirname(binary), "..", "package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: unknown; version?: unknown }
      if (typeof pkg.name === "string" && pkg.name.startsWith("@anthropic-ai/claude-code") && typeof pkg.version === "string") {
        return pkg.version
      }
    } catch {
      // No package here; try the parent.
      continue
    }
  }
  return null
}

export interface ClaudeExecutableCandidate {
  path: string | null
  source: ClaudeExecutableSource | null
  version: string | null
  /** Why there is no path or no version, in terms an operator can act on. */
  detail?: string
}

/**
 * What the system and bundled modes would each run right now, with versions,
 * so Settings can show the choice before it is made. The system candidate is
 * the first `claude` on PATH that answers like Claude Code, as the resolver
 * picks it; the bundled version comes from its package rather than a spawn.
 */
export async function describeClaudeExecutableCandidates(
  deps: ResolverDeps = DEFAULT_DEPS,
): Promise<{ system: ClaudeExecutableCandidate; bundled: ClaudeExecutableCandidate }> {
  const packaged = tryPackaged(deps)
  const bundled: ClaudeExecutableCandidate = packaged
    ? { path: packaged.path, source: packaged.source, version: packagedVersion(packaged.path) }
    : { path: null, source: null, version: null, detail: "not installed: @anthropic-ai/claude-code is missing or its postinstall did not run" }

  let onPath: string[] = []
  try {
    onPath = existingPathCandidates((await deps.exec(deps.platform === "win32" ? "where claude" : "which claude")).stdout, deps)
  } catch (error) {
    if (error instanceof AuthStatusProcessFailure && error.reason === "join") throw error
    // Nothing on PATH; reported below.
  }
  let firstFailure: string | undefined
  for (const candidate of onPath) {
    assertClaudeProbeActive()
    const answer = await readClaudeVersion(candidate)
    if ("version" in answer) return { system: { path: candidate, source: "path-lookup", version: answer.version }, bundled }
    firstFailure ??= `${candidate}: ${answer.error}`
  }
  const system: ClaudeExecutableCandidate = {
    path: null, source: null, version: null,
    detail: firstFailure ? `no claude on PATH answers like Claude Code (${firstFailure})` : "no claude on PATH",
  }
  return { system, bundled }
}

/** Share candidate filtering between startup/query resolution and CLI auth. */
function existingPathCandidates(stdout: string, deps: ResolverDeps): string[] {
  return stdout.split(/\r?\n/).map(s => s.trim()).filter(candidate =>
    candidate.length > 0 && !(deps.platform === "win32" && candidate.startsWith("/")) && deps.existsSync(candidate))
}

function tryPathLookupSync(deps: ResolverDeps): string | null {
  if (!deps.execLookupSync) return null
  const now = deps.now ?? (() => performance.now())
  const deadline = now() + CLAUDE_PROBE_TIMEOUT_MS
  try {
    const stdout = deps.execLookupSync(deps.platform === "win32" ? "where" : "which", ["claude"])
    for (const candidate of existingPathCandidates(stdout, deps)) {
      if (!deps.probeClaudeSync) return candidate
      const remainingMs = Math.max(0, Math.floor(deadline - now()))
      if (remainingMs === 0) {
        warnProbeBudgetExhausted(candidate, deps)
        break
      }
      if (keepPathCandidate(candidate, deps.probeClaudeSync(candidate, remainingMs), deps)) return candidate
    }
    return null
  } catch {
    // A missing/failed lookup must still allow the packaged fallback.
    return null
  }
}

function warnProbeBudgetExhausted(candidate: string, deps: ResolverDeps): void {
  deps.warn?.(`[PROXY] Not probing the claude found on PATH at ${candidate}: the ${CLAUDE_PROBE_TIMEOUT_MS / 1000}s PATH lookup/probe budget is exhausted. Falling back to the next Claude Code installation; set MERIDIAN_CLAUDE_PATH to choose one explicitly.`)
}

/**
 * Step 4: legacy SDK bundled cli.js (SDK < 0.2.98 only — removed in
 * 0.2.98+). Best-effort fallback for stale bun installs; no-op for
 * fresh ones.
 */
function tryLegacySdkCliJs(deps: ResolverDeps): string | null {
  if (!deps.isBun) return null
  try {
    const sdkPath = deps.resolvePackage("@anthropic-ai/claude-agent-sdk")
    const cliJs = join(dirname(sdkPath), "cli.js")
    return deps.existsSync(cliJs) ? cliJs : null
  } catch {
    return null
  }
}

/**
 * Pure resolver, source-aware variant — runs each step and returns the
 * first hit (path + source tag), or null when all steps miss.
 *
 * Order matters: `env` wins unconditionally (operator escape hatch), then the
 * operator's executable preference (claudeExecutablePreference.ts). In system
 * mode, the default, `path-lookup` (the operator-managed installation) comes
 * before `bundled` and `platform-package` (packaged fallbacks); bundled mode
 * swaps the two; custom mode puts `custom` ahead of both and otherwise
 * resolves as system. `legacy-cli-js` comes last (only matters on stale Bun
 * installs of SDK < 0.2.98).
 */
export async function resolveClaudeExecutableWithSource(
  deps: ResolverDeps = DEFAULT_DEPS,
): Promise<ClaudeExecutableInfo | null> {
  const env = tryEnvOverride(deps)
  if (env) return { path: env, source: "env" }
  const preference = deps.preference?.() ?? DEFAULT_CLAUDE_EXECUTABLE_PREFERENCE
  const custom = tryCustomPath(preference, deps)
  if (custom) return { path: custom, source: "custom" }
  if (preference.mode === "bundled") {
    const packaged = tryPackaged(deps)
    if (packaged) return packaged
    const pathLookup = await tryPathLookup(deps)
    deps.checkActive?.()
    if (pathLookup) return { path: pathLookup, source: "path-lookup" }
  } else {
    const pathLookup = await tryPathLookup(deps)
    deps.checkActive?.()
    if (pathLookup) return { path: pathLookup, source: "path-lookup" }
    const packaged = tryPackaged(deps)
    if (packaged) return packaged
  }
  const legacy = tryLegacySdkCliJs(deps)
  if (legacy) return { path: legacy, source: "legacy-cli-js" }
  return null
}

/**
 * Pure resolver — returns the path string only. Kept for callers that
 * don't need the source tag (existing behavior; preserves the existing
 * test surface in claude-executable-resolver.test.ts).
 */
export async function resolveClaudeExecutable(deps: ResolverDeps = DEFAULT_DEPS): Promise<string | null> {
  const info = await resolveClaudeExecutableWithSource(deps)
  return info?.path ?? null
}

/**
 * Synchronous subset of the resolver. Used by CLI commands
 * (`meridian profile list`, `profileAdd`, etc.) that can't await before
 * spawning `claude auth status`.
 *
 * Uses the same precedence as the async resolver, executable preference
 * included, so the CLI and the server run the same binary. Its bounded
 * shell-free lookup is limited to these synchronous CLI commands; live server
 * probes use the async resolver. The legacy SDK cli.js fallback remains
 * limited to the async Bun resolver.
 *
 * Closes the diagnostic gap from #478: `getAuthStatus` in profileCli.ts
 * and `getClaudeAuthStatusAsync` in this file previously called
 * `claude auth status` via shell, which fails when `claude` isn't on
 * PATH (Stefan's case — bunx-installed meridian under systemd, no
 * global claude). Both call sites now route through resolved paths.
 */
export function resolveClaudeExecutableSync(
  deps: ResolverDeps = DEFAULT_DEPS,
): ClaudeExecutableInfo | null {
  const env = tryEnvOverride(deps)
  if (env) return { path: env, source: "env" }
  const preference = deps.preference?.() ?? DEFAULT_CLAUDE_EXECUTABLE_PREFERENCE
  const custom = tryCustomPath(preference, deps)
  if (custom) return { path: custom, source: "custom" }
  if (preference.mode === "bundled") {
    const packaged = tryPackaged(deps)
    if (packaged) return packaged
    const pathLookup = tryPathLookupSync(deps)
    if (pathLookup) return { path: pathLookup, source: "path-lookup" }
    return null
  }
  const pathLookup = tryPathLookupSync(deps)
  if (pathLookup) return { path: pathLookup, source: "path-lookup" }
  return tryPackaged(deps)
}

/**
 * Returns the cached resolved-executable info — `null` if
 * `resolveClaudeExecutableAsync` hasn't run yet. Used by `/health` and the
 * startup log so the resolver only runs once and both surfaces see the
 * same answer.
 */
export function getResolvedClaudeExecutableInfo(): ClaudeExecutableInfo | null {
  return cachedClaudeInfo
}

function ownedResolverDeps(scope: ClaudeResolutionScope): ResolverDeps {
  const start = (command: { file: string; args: string[] } | { shell: string }, maxBuffer: number, timeoutMs = 2000): AuthStatusProcess => {
    scope.active()
    return scope.own(startOwnedClaudeProcess(command, { timeoutMs, maxBuffer }))
  }
  return { ...DEFAULT_DEPS,
    checkActive: () => scope.active(),
    exec: async command => ({ stdout: await start({ shell: command }, 64 * 1024).result }),
    probeClaude: async (candidate, timeoutMs = CLAUDE_PROBE_TIMEOUT_MS) => {
      scope.active()
      const startedAt = Date.now()
      const process = start({ file: candidate, args: ['--version'] }, 16 * 1024, timeoutMs)
      try { return judgeVersionOutput(await process.result, Date.now() - startedAt) }
      catch (error) {
        // A failed but joined probe is a normal miss. An unknown child cannot
        // admit the next candidate/package or clear shared custody.
        if (!process.isJoined()) throw error
        return { usable: false, reason: describeProbeFailure(error, timeoutMs) }
      }
    },
  }
}

function preferenceKey(preference: ClaudeExecutablePreference): string {
  return preference.mode === "custom" ? `custom:${preference.customPath}` : preference.mode
}

function acquireClaudeResolution(preference = DEFAULT_DEPS.preference?.() ?? DEFAULT_CLAUDE_EXECUTABLE_PREFERENCE): AuthStatusProcess & { info(): ClaudeExecutableInfo | null } {
  // The saved preference is read on every call, so a change applies to the
  // next turn whichever process saved it; the resolution, which may spawn
  // `claude --version`, is cached until the preference changes or the
  // executable it found is gone - an upgrade can remove a versioned path.
  assertClaudeProbeActive()
  if ([...activeClaudeResolutions].some(resolution => resolution.hasUnconfirmedFailure())) throw new AuthStatusProcessFailure("join")
  const envPath = process.env.MERIDIAN_CLAUDE_PATH
  const key = JSON.stringify([preferenceKey(preference), envPath ?? null])
  if (cachedClaudeInfo && cachedClaudeInfoPreference === key && existsSync(cachedClaudeInfo.path)) {
    const info = cachedClaudeInfo, path = info.path
    return { result: Promise.resolve(path), joined: Promise.resolve(),
      isJoined: () => true, cancel: () => Promise.resolve(), info: () => info }
  }
  if (!cachedClaudeResolution || cachedClaudeResolutionPreference !== key) {
    // A resolution for an older preference keeps its own leases and children;
    // it only stops being the one new callers join, and cannot publish.
    cachedClaudeInfo = null; cachedClaudeInfoPreference = null
    let info: ClaudeExecutableInfo | null = null
    const resolution: ClaudeResolution = { ...createClaudeResolution(async scope => {
      const deps = { ...ownedResolverDeps(scope), preference: () => preference,
        envGet: (name: string) => name === "MERIDIAN_CLAUDE_PATH" ? envPath : DEFAULT_DEPS.envGet(name) }
      const resolved = await resolveClaudeExecutableWithSource(deps)
      scope.active()
      if (resolved) {
        info = resolved
        const currentKey = JSON.stringify([preferenceKey(savedClaudeExecutablePreference()), process.env.MERIDIAN_CLAUDE_PATH ?? null])
        if (cachedClaudeResolution === resolution && currentKey === key) { cachedClaudeInfo = resolved; cachedClaudeInfoPreference = key }
        return resolved.path
      }
      throw new Error(
        'Could not find Claude Code executable. Install via: npm install -g @anthropic-ai/claude-code, ' +
        'or set MERIDIAN_CLAUDE_PATH=/path/to/claude to point at an existing binary.',
      )
    }), info: () => info }
    activeClaudeResolutions.add(resolution)
    cachedClaudeResolution = resolution
    cachedClaudeResolutionPreference = key
    void resolution.joined.then(() => {
      activeClaudeResolutions.delete(resolution)
      if (cachedClaudeResolution === resolution) { cachedClaudeResolution = null; cachedClaudeResolutionPreference = null }
    })
  }
  const resolution = cachedClaudeResolution
  return { ...resolution.acquire(), info: () => resolution.info() }
}

/** A request-local resolution snapshot; never reads another caller's active cache. */
export async function resolveClaudeExecutableInfoAsync(preference?: ClaudeExecutablePreference): Promise<ClaudeExecutableInfo> {
  const lease = acquireClaudeResolution(preference)
  ownClaudeProbe(lease)
  try {
    await lease.result
    assertClaudeProbeActive()
    const info = lease.info()
    if (!info) throw new Error("Claude executable resolution produced no identity")
    return info
  } finally { void lease.cancel().catch(() => undefined) }
}

export async function resolveClaudeExecutableAsync(): Promise<string> {
  // Direct callers hold a lease until shared resolution settles; auth shutdown
  // may release only its own lease and must not cancel their subprocess.
  return (await resolveClaudeExecutableInfoAsync()).path
}

/** Reset cached path — for testing only */
export function resetCachedClaudePath(): void {
  cachedClaudeInfo = null
  cachedClaudeResolution = null
  cachedClaudeInfoPreference = null
  cachedClaudeResolutionPreference = null
  activeClaudeResolutions.clear()
}

/** Reset cached auth status — for testing only */
export function resetCachedClaudeAuthStatus(): void {
  authCacheGeneration++
  authRefreshes.clear()
  cachedAuthStatus = null
  lastKnownGoodAuthStatus = null
  cachedAuthStatusAt = 0
  cachedAuthStatusLastSuccessAt = 0
  cachedAuthStatusIsFailure = false
  cachedAuthStatusFailures = 0
  cachedAuthStatusPromise = null
  cachedAuthStatusCredMtimeMs = 0
  profileAuthCaches.clear()
  warnedAuthStatusFailures.clear()
}

/** Shorten how long a caller with no cached answer waits; no argument restores the default - for testing only. */
export function setAuthStatusWaitMsForTesting(ms: number = AUTH_STATUS_WAIT_MS): void {
  authStatusWaitMs = ms
}

/** Expire the auth status cache without clearing lastKnownGoodAuthStatus.
 *  The next call re-executes `claude auth status` while the "last known good"
 *  fallback state survives. Used by tests to simulate the TTL elapsing, and by
 *  the login route so a just-authenticated profile stops reporting the cached
 *  "not logged in". */
export function expireAuthStatusCache(): void {
  cachedAuthStatusAt = 0
  // Expiry invalidates the reading, not the lifetime of a running child.
  // Keep sharing it until its process and pipes have actually joined.
  for (const cache of profileAuthCaches.values()) cache.at = 0
}

/**
 * Check if an error is a "Controller is already closed" error.
 * This happens when the client disconnects mid-stream.
 */
export function isClosedControllerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes("Controller is already closed")
}
