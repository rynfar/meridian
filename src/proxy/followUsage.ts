/**
 * Follow another instance's usage figures — the companion to followActive.ts.
 *
 * Anthropic's OAuth usage endpoint is rate limited per account, and that
 * budget is shared by every process holding the account's credentials. Two
 * Meridian instances on one box therefore compete for it: measured here, a
 * second instance polling ten accounts got 429 on all ten, indefinitely,
 * while the first kept fetching normally. The loser has no way to tell that
 * apart from a broken account by looking at its own result.
 *
 * So a follower does not ask Anthropic at all. It reads the figures the
 * instance it already follows has ALREADY paid for, over the same loopback
 * connection it uses for the active profile, and reports them as its own.
 * One poll covers every profile, so the cost to the followed instance is one
 * cached read per interval no matter how many accounts exist.
 *
 * This is deliberately not a general cache-sharing mechanism: it is on only
 * under MERIDIAN_FOLLOW_ACTIVE, which already declares "that instance is the
 * authority and I am the copy".
 *
 * Degradation matches followActive.ts: the poll is background, the request
 * path never waits on it, and a follower with no followed figures falls
 * straight through to its own credential read. Being unable to reach the
 * followed instance must not be worse than not following at all.
 *
 * Leaf module — no imports from server.ts, session/ or profiles.ts. The
 * oauthUsage import is types-only, so there is no runtime cycle with the
 * module that consumes this one.
 */

import { followTarget } from "./followActive"
import { claudeLog } from "../logger"
import type { OAuthBankedResets, OAuthExtraUsageInfo, OAuthUsageSnapshot, OAuthUsageWindow } from "./oauthUsage"

/**
 * Poll cadence.
 *
 * Deliberately much longer than the followed instance's own 30s usage cache.
 * Polling AT that cache's TTL would find it expired almost every time and so
 * would make the followed instance fetch from Anthropic on our behalf, once
 * per profile, forever — trading a follower that competes for the rate limit
 * for a follower that drives the other instance into it instead. Measured on
 * a ten-account box, a 30s poll means twenty upstream fetches a minute that
 * nobody asked for.
 *
 * Usage percentages move over hours, so a two-minute cadence loses nothing
 * that anyone can see, and FOLLOW_USAGE_MAX_AGE_MS still covers several
 * consecutive failures before the figures are withdrawn.
 */
export const FOLLOW_USAGE_POLL_INTERVAL_MS = 120_000

/** Per-poll timeout. Longer than followActive's 2s: the followed instance may
 *  have to fetch from Anthropic before it can answer. */
export const FOLLOW_USAGE_FETCH_TIMEOUT_MS = 8_000

/**
 * How old followed figures may be before they stop being served.
 *
 * Unlike the followed ACTIVE PROFILE — where a stale value is still the best
 * available answer and is served indefinitely — stale usage is a number that
 * silently drifts from the truth. Past this bound the follower says nothing
 * and lets its own credential read decide, which is the honest answer.
 */
export const FOLLOW_USAGE_MAX_AGE_MS = 10 * 60_000

interface FollowedUsage {
  byProfile: Map<string, OAuthUsageSnapshot>
  fetchedAt: number
}

let followed: FollowedUsage | undefined
let timer: ReturnType<typeof setInterval> | undefined

function asFiniteOrNull(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null
}

function readExtraUsage(raw: unknown): OAuthExtraUsageInfo | null {
  if (!raw || typeof raw !== "object" || typeof (raw as { isEnabled?: unknown }).isEnabled !== "boolean") return null
  return raw as OAuthExtraUsageInfo
}

function readBankedResets(raw: unknown): OAuthBankedResets | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as { eligible?: unknown; grants?: unknown }
  if (typeof value.eligible !== "boolean" || !Array.isArray(value.grants)) return null
  return raw as OAuthBankedResets
}

/**
 * Pure: the usable snapshots in a `/v1/usage/quota/all` body.
 *
 * Entries carrying an `error`, or with no windows at all, are DROPPED rather
 * than imported as empty snapshots. A `stale` entry (the followed instance's
 * last good reading, inside its own stale bound) is kept and stays marked. The followed instance failing to read an
 * account is not evidence about that account — importing its failure would
 * launder the peer's transient 429 into ours, and would also stop the
 * follower's own credential read from ever being tried.
 */
export function readFollowedUsage(body: unknown): Map<string, OAuthUsageSnapshot> {
  const out = new Map<string, OAuthUsageSnapshot>()
  if (!body || typeof body !== "object") return out
  const profiles = (body as { profiles?: unknown }).profiles
  if (!Array.isArray(profiles)) return out

  for (const raw of profiles) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as {
      id?: unknown
      windows?: unknown
      extraUsage?: unknown
      bankedResets?: unknown
      fetchedAt?: unknown
      stale?: unknown
      error?: unknown
    }
    const id = typeof entry.id === "string" ? entry.id : undefined
    if (!id || (entry.error != null && entry.error !== "")) continue
    if (!Array.isArray(entry.windows)) continue

    const windows: OAuthUsageWindow[] = []
    for (const w of entry.windows) {
      if (!w || typeof w !== "object") continue
      const win = w as { type?: unknown; utilization?: unknown; resetsAt?: unknown }
      if (typeof win.type !== "string") continue
      windows.push({
        type: win.type,
        utilization: asFiniteOrNull(win.utilization),
        resetsAt: asFiniteOrNull(win.resetsAt),
      })
    }
    if (windows.length === 0) continue

    out.set(id, {
      windows,
      extraUsage: readExtraUsage(entry.extraUsage),
      bankedResets: readBankedResets(entry.bankedResets),
      fetchedAt: asFiniteOrNull(entry.fetchedAt) ?? Date.now(),
      ...(entry.stale === true ? { stale: true } : {}),
    })
  }
  return out
}

/**
 * The followed instance's snapshot for a profile, if there is a fresh one.
 * Called on the usage path — synchronous, cache-only, no I/O. `profileId` is
 * the id the quota routes report, so the unscoped account is `default`.
 */
export function followedUsageSnapshot(profileId: string): OAuthUsageSnapshot | undefined {
  if (!followed || !followTarget()) return undefined
  if (Date.now() - followed.fetchedAt > FOLLOW_USAGE_MAX_AGE_MS) return undefined
  return followed.byProfile.get(profileId)
}

/** One poll of the followed instance's usage. Never throws. */
export async function pollFollowedUsage(): Promise<void> {
  const target = followTarget()
  if (!target) return
  try {
    const res = await fetch(`${target.url}/v1/usage/quota/all`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FOLLOW_USAGE_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      claudeLog("follow_usage.upstream_error", { url: target.url, status: res.status })
      return
    }
    const byProfile = readFollowedUsage(await res.json())
    if (byProfile.size === 0) {
      claudeLog("follow_usage.empty", { url: target.url })
      return
    }
    followed = { byProfile, fetchedAt: Date.now() }
    claudeLog("follow_usage.updated", { url: target.url, profiles: byProfile.size })
  } catch (err) {
    claudeLog("follow_usage.fetch_failed", {
      url: target.url,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Start background polling. No-op when not following. */
export function startFollowUsagePolling(): void {
  if (timer || !followTarget()) return
  void pollFollowedUsage()
  timer = setInterval(() => void pollFollowedUsage(), FOLLOW_USAGE_POLL_INTERVAL_MS)
  timer.unref?.()
}

export function stopFollowUsagePolling(): void {
  if (!timer) return
  clearInterval(timer)
  timer = undefined
}

/** Test-only — clears polled state and any running timer. */
export function resetFollowedUsage(): void {
  stopFollowUsagePolling()
  followed = undefined
}

/** Test-only — seed followed figures without a network round trip. */
export function setFollowedUsageForTesting(
  byProfile: Map<string, OAuthUsageSnapshot>,
  fetchedAt = Date.now(),
): void {
  followed = { byProfile, fetchedAt }
}
