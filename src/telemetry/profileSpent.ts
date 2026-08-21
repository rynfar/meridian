/**
 * How spent a Claude account is — one definition, so every surface that
 * asks "can this account still do work?" gets the same answer.
 *
 * Mirrored by the inline browser script in landing.ts, the same house
 * pattern profileUsage.ts uses: the page is one template literal that runs
 * in the browser and cannot import at runtime, so this TS module is the
 * tested source of truth (profile-spent.test.ts) and the page carries a
 * copy of the arithmetic.
 */

/**
 * Windows that describe the account as a whole. Anthropic also reports
 * per-model caps (seven_day_opus, seven_day_sonnet, seven_day_fable, …);
 * those are deliberately excluded, because hitting one leaves the rest of
 * the account working. seven_day_fable is the concrete case: a profile on
 * the author's fleet sat at 94% Fable with its general windows nearly
 * untouched, and folding that in would have greyed out a usable account.
 */
export const GENERAL_WINDOW_TYPES: readonly string[] = ["five_hour", "seven_day"]

/** Where the gradient starts — below this a profile reads as untouched. */
export const FADE_FROM = 0.85
/** At or above this a profile is spent, whatever the exact number. */
export const SPENT_AT = 0.95

export interface SpendWindow {
  type: string
  utilization?: number | null
}

export interface SpendInput {
  /** `windows` for this profile from /v1/usage/quota/all. */
  windows?: readonly SpendWindow[] | null
  /** `error` for this profile from /v1/usage/quota/all. */
  error?: string | null
  /** `loggedIn` for this profile from /profiles/list. */
  loggedIn?: boolean | null
}

export type SpendState = "unknown" | "available" | "fading" | "spent"

export interface ProfileSpend {
  /** 0..1 — the worse of the general windows; null when nothing is known. */
  fraction: number | null
  state: SpendState
  /**
   * 0..1 — how far to grey the account out. Zero for an unusable one even
   * though it is fully spent: fading is for an account that will come back
   * on its own, and that is the opposite of what a missing login needs.
   * Callers give `reason: "unusable"` its own, louder treatment.
   */
  fade: number
  /** Why it is spent. "unusable" needs a human; "usage" only needs time. */
  reason: "usage" | "unusable" | null
}

/**
 * A profile that cannot serve a request at all, measured rather than
 * assumed: a request carrying `x-meridian-profile` for a profile whose
 * quota entry reports `no_token` comes back 401.
 *
 * `not_oauth` is explicitly NOT this. It is how /v1/usage/quota/all reports
 * an API-key profile, which has no OAuth quota to report and works fine —
 * treating that error like the others would grey out a healthy account.
 */
export function isUnusable(input: SpendInput): boolean {
  if (input.loggedIn === false) return true
  return input.error === "no_token"
}

/**
 * The worse of the general windows, or null when none of them carries a
 * number. Null means "no evidence", which is not the same as zero and must
 * not render as a pristine account.
 */
export function generalUtilization(windows: readonly SpendWindow[] | null | undefined): number | null {
  let worst: number | null = null
  for (const w of windows ?? []) {
    if (!GENERAL_WINDOW_TYPES.includes(w.type)) continue
    const u = w.utilization
    if (u == null || !Number.isFinite(u)) continue
    const clamped = Math.max(0, Math.min(1, u))
    if (worst == null || clamped > worst) worst = clamped
  }
  return worst
}

export function computeProfileSpend(input: SpendInput): ProfileSpend {
  if (isUnusable(input)) {
    return { fraction: 1, state: "spent", fade: 0, reason: "unusable" }
  }
  const fraction = generalUtilization(input.windows)
  if (fraction == null) {
    return { fraction: null, state: "unknown", fade: 0, reason: null }
  }
  if (fraction >= SPENT_AT) {
    return { fraction, state: "spent", fade: 1, reason: "usage" }
  }
  if (fraction >= FADE_FROM) {
    return {
      fraction,
      state: "fading",
      fade: (fraction - FADE_FROM) / (SPENT_AT - FADE_FROM),
      reason: null,
    }
  }
  return { fraction, state: "available", fade: 0, reason: null }
}
