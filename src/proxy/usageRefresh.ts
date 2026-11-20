/**
 * The usage part of a profile card's Refresh: the per-profile gate that keeps
 * repeated clicks from reaching the provider more than once per interval
 * (each refreshed part has its own slot, see profileRefresh.ts), which
 * windows a fresh reading shows open again, and what the card says.
 *
 * Leaf module: no imports beyond types.
 */

/** One explicit re-read per profile in this span, whoever clicks. */
export const USAGE_REFRESH_MIN_INTERVAL_MS = 30_000

export class UsageRefreshGate {
  private readonly lastAt = new Map<string, number>()

  constructor(private readonly intervalMs = USAGE_REFRESH_MIN_INTERVAL_MS) {}

  /** Claims the key's slot; refused, says how long until the next one opens. */
  claim(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
    const last = this.lastAt.get(key)
    if (last !== undefined && now - last < this.intervalMs) return { ok: false, retryAfterMs: last + this.intervalMs - now }
    this.lastAt.set(key, now)
    return { ok: true }
  }

  forget(key: string): void {
    this.lastAt.delete(key)
  }
}

/**
 * The windows a reading shows below their limit. A reset made outside
 * Meridian reopens them while the refusals it remembers still say spent;
 * these are the buckets those refusals may be cleared for.
 */
export function openedWindowTypes(windows: readonly { readonly type: string; readonly utilization: number | null }[]): string[] {
  return windows.filter(w => w.utilization !== null && w.utilization < 1).map(w => w.type)
}

type UsageReadError = "no_token" | "rate_limited" | "upstream_error"

/**
 * What the card says after a Claude refresh. A read turned away by the 429
 * cooldown inside the stale window answers the old snapshot with no error,
 * so the failure record is what says why it did not land.
 */
export function claudeRefreshNote(read: {
  readonly fresh: boolean
  readonly error: UsageReadError | null
  readonly failureReason: UsageReadError | null
  /** Whether Meridian holds any earlier reading, which is all "the last reading" can mean. */
  readonly hadReading: boolean
}): string {
  if (read.fresh) return "Usage re-read just now."
  const why = read.error ?? read.failureReason
  if (why === "rate_limited") {
    return read.hadReading
      ? "Anthropic is rate limiting usage reads for this account; the last reading stays until the cooldown ends."
      : "Anthropic is rate limiting usage reads for this account, and Meridian has no reading of it yet; try again once the cooldown ends."
  }
  if (why === "no_token") return "No usable login to read usage with; sign this profile in again."
  return read.hadReading
    ? "Anthropic did not answer with new figures; the last reading stays."
    : "Anthropic did not answer with figures, and Meridian has no reading of this account yet."
}

/** Whether a usage refresh landed, was turned away by a rate limit, or failed. */
export function usageReadState(read: { readonly fresh: boolean; readonly error: UsageReadError | null; readonly failureReason: UsageReadError | null }): "fresh" | "rate_limited" | "failed" {
  if (read.fresh) return "fresh"
  return (read.error ?? read.failureReason) === "rate_limited" ? "rate_limited" : "failed"
}
