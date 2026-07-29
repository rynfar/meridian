/**
 * Rate limit store — captures `SDKRateLimitInfo` events emitted by
 * `@anthropic-ai/claude-agent-sdk`'s `query()` stream.
 *
 * The SDK reports the live Claude Max subscription quota state as
 * `rate_limit_event` events in the form:
 *
 *   {
 *     type: "rate_limit_event",
 *     rate_limit_info: {
 *       status: "allowed" | "allowed_warning" | "rejected",
 *       resetsAt?: number,                              // epoch SECONDS — see toEpochMs
 *       rateLimitType?: "five_hour" | "seven_day"
 *                     | "seven_day_opus" | "seven_day_sonnet"
 *                     | "overage",
 *       utilization?: number,                           // 0..1
 *       overageStatus?: "allowed" | "allowed_warning" | "rejected",
 *       overageResetsAt?: number,
 *       isUsingOverage?: boolean,
 *       surpassedThreshold?: number,
 *       ...
 *     },
 *     uuid, session_id
 *   }
 *
 * We keep the most recent entry per `rateLimitType` (or "default" if absent)
 * in memory. State resets on proxy restart — that's fine because the SDK will
 * push a fresh event on the next request.
 *
 * Entries are scoped per profile. Each profile is a separate Claude Max
 * subscription with separate quotas, so a flat store would let one account's
 * reset time be read as another's — which is exactly how priority routing
 * (`routing: "priority"`) mis-derived exhaustion cooldowns before this was
 * scoped. Every read names its profile explicitly; single-profile setups
 * simply use the literal `"default"` key.
 *
 * `clear(profileId)` drops one account (wired into `POST /auth/refresh`,
 * which re-authenticates one credential); `clear()` drops everything and is
 * used by tests.
 */

import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"

/**
 * Boundary above which a timestamp is already milliseconds.
 *
 * As epoch milliseconds this is 1973-03-03; as epoch seconds it is the year
 * 5138. Every real reset time arrives either as ~1.8e9 (seconds, today) or
 * ~1.8e12 (milliseconds, today), so the two ranges cannot collide for any date
 * this proxy will ever see.
 */
const MIN_EPOCH_MS = 1e11

/**
 * Normalize an SDK reset timestamp to epoch milliseconds.
 *
 * The SDK reports these in epoch SECONDS while everything downstream —
 * `Date.now()` comparisons in the priority-cooldown chain, the documented
 * `/v1/usage/quota` contract, and consumers like the telemetry badge and Pylon
 * — is epoch milliseconds. Proven by observing one profile's `five_hour` reset
 * from both sources minutes apart: OAuth reported `1785234600292` and the SDK
 * reported `1785234600` for the same instant (#708).
 *
 * Detects the unit rather than multiplying unconditionally, because
 * `SDKRateLimitInfo.resetsAt` is typed `number` with no documented unit. An
 * unconditional `* 1000` would silently corrupt every value if the SDK ever
 * switched to milliseconds; this stays correct under either.
 */
export function toEpochMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return value < MIN_EPOCH_MS ? Math.round(value * 1000) : value
}

export interface RateLimitEntry extends SDKRateLimitInfo {
  /** When this entry was captured (epoch ms). */
  observedAt: number
}

/** Type discriminator for the entry's bucket key. */
export type RateLimitBucketKey = NonNullable<SDKRateLimitInfo["rateLimitType"]> | "default"

class RateLimitStore {
  /** profileId -> (bucket key -> entry). One inner map per configured profile. */
  private byProfile = new Map<string, Map<RateLimitBucketKey, RateLimitEntry>>()

  /**
   * Record a rate-limit info snapshot for a specific profile.
   * Last-write-wins per (profileId, rateLimitType). Older entries for the
   * same pair are overwritten — clients should treat the latest as canonical.
   *
   * `observedAt` defaults to the current wall clock but may be supplied
   * explicitly so callers (and tests) can control the capture timestamp used
   * for newest-first ordering in {@link getAll}.
   */
  record(profileId: string, info: SDKRateLimitInfo | undefined | null, observedAt: number = Date.now()): void {
    if (!info || typeof info !== "object") return
    const key: RateLimitBucketKey = info.rateLimitType ?? "default"
    let buckets = this.byProfile.get(profileId)
    if (!buckets) {
      buckets = new Map<RateLimitBucketKey, RateLimitEntry>()
      this.byProfile.set(profileId, buckets)
    }
    // Normalize units here, at the single boundary where SDK data enters, so no
    // consumer has to remember that the SDK speaks seconds (#708).
    buckets.set(key, {
      ...info,
      resetsAt: toEpochMs(info.resetsAt),
      overageResetsAt: toEpochMs(info.overageResetsAt),
      observedAt,
    })
  }

  /** Snapshot one profile's entries, newest-first by observedAt. */
  getAll(profileId: string): RateLimitEntry[] {
    const buckets = this.byProfile.get(profileId)
    if (!buckets) return []
    return Array.from(buckets.values()).sort((a, b) => b.observedAt - a.observedAt)
  }

  /** Snapshot a single bucket for one profile, or undefined if not yet seen. */
  get(profileId: string, key: RateLimitBucketKey): RateLimitEntry | undefined {
    return this.byProfile.get(profileId)?.get(key)
  }

  /** Bucket count for one profile, or across all profiles when omitted. */
  size(profileId?: string): number {
    if (profileId !== undefined) return this.byProfile.get(profileId)?.size ?? 0
    let total = 0
    for (const buckets of this.byProfile.values()) total += buckets.size
    return total
  }

  /**
   * Drop stored entries for one profile, or every profile when `profileId`
   * is omitted. Wired into the `POST /auth/refresh` handler so a refreshed
   * credential's stale quotas can't linger. Also used by tests for isolation.
   */
  clear(profileId?: string): void {
    if (profileId !== undefined) this.byProfile.delete(profileId)
    else this.byProfile.clear()
  }
}

/**
 * Process-wide singleton. Importers should always use this instance — do
 * not instantiate `RateLimitStore` directly outside of tests.
 */
export const rateLimitStore = new RateLimitStore()

/** Exported for test isolation only. */
export { RateLimitStore as _RateLimitStoreForTests }
