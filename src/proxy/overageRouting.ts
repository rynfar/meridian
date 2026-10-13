/** Pure, bounded quota evidence for priority routing. No account I/O. */
export interface OverageQuotaSignal {
  readonly type: string
  readonly observedAt: number
  readonly resetsAt?: number | null
  readonly utilization?: number | null
  readonly status?: string
  readonly isUsingOverage?: boolean
}

// Quota snapshots are hints, not permanent account bans. A missing/long reset
// must not strand an account on an observation from a previous conversation.
export const OVERAGE_EVIDENCE_MAX_AGE_MS = 5 * 60_000

export function hasIncludedCapacityExhaustion(
  signals: readonly OverageQuotaSignal[],
  now: number,
): boolean {
  const current = signals.filter(signal =>
    Number.isFinite(signal.observedAt)
    && signal.observedAt <= now
    && now - signal.observedAt < OVERAGE_EVIDENCE_MAX_AGE_MS
    && (signal.resetsAt == null || (Number.isFinite(signal.resetsAt) && signal.resetsAt > now)),
  ).sort((a, b) => b.observedAt - a.observedAt)

  // A newer explicit observation replaces an older overage observation even
  // when the SDK changed bucket names. OAuth extra_usage is deliberately not
  // used: Team seats can report disabled while organization overage is active.
  const overage = current.find(signal =>
    ["five_hour", "seven_day", "default", "overage"].includes(signal.type)
    && typeof signal.isUsingOverage === "boolean",
  )
  if (overage?.isUsingOverage === true) return true

  const seen = new Set<string>()
  for (const signal of current) {
    // Model-specific and unknown windows cannot establish exhaustion for an
    // arbitrary requested model. An explicit SDK overage flag above can.
    if (signal.type !== "five_hour" && signal.type !== "seven_day") continue
    if (seen.has(signal.type)) continue
    seen.add(signal.type)
    if (signal.status === "rejected" || (signal.utilization ?? 0) >= 1) return true
  }
  return false
}

/** Stable partition: included/unknown accounts first, known spent accounts last. */
export function preferIncludedCapacity(
  candidates: readonly string[],
  isSpent: (id: string) => boolean,
): string[] {
  const included: string[] = []
  const spent: string[] = []
  for (const id of candidates) (isSpent(id) ? spent : included).push(id)
  return [...included, ...spent]
}
