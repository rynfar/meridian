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
 *       resetsAt?: number,                              // epoch ms
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
 * State resets on proxy restart — that's fine because the SDK pushes a fresh
 * event on the next request. `clear(profileId)` drops one account (wired into
 * `POST /auth/refresh`, which re-authenticates one credential); `clear()`
 * drops everything and is used by tests.
 */

import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"

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
    buckets.set(key, { ...info, observedAt })
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
