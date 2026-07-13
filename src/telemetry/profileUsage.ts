/**
 * Pure helpers for rendering OAuth usage data on the profile page.
 *
 * Lives outside the inline-HTML template in profilePage.ts so the labeling
 * and formatting logic can be unit-tested. The same logic is mirrored in
 * the page's inline browser script — see profilePage.ts.
 *
 * Why duplicate at all? profilePage.ts is one big template literal that
 * runs in the browser, so we can't directly import these at runtime. We
 * inline the constants (via JSON.stringify) and re-implement the small
 * format functions in the template, with these TS versions guarding the
 * behavior via tests.
 */

/** Friendly labels for Anthropic's raw window keys. */
export const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_opus: "7d Opus",
  seven_day_sonnet: "7d Sonnet",
  seven_day_oauth_apps: "7d Apps",
  seven_day_cowork: "7d Cowork",
  seven_day_omelette: "7d Omelette",
}

/**
 * Map a raw window type (e.g. "five_hour", "seven_day_opus") to a short
 * human label. Falls back to a prettified version of the key for any
 * type we haven't named (Anthropic adds new windows occasionally).
 */
export function labelForWindow(type: string): string {
  if (WINDOW_LABELS[type]) return WINDOW_LABELS[type]!
  // Fallback: replace underscores with spaces and capitalize each word.
  return type
    .split("_")
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ")
}

/**
 * Bucket a 0..1 utilization value into a status used for color coding.
 * Mirrors pylon's three-tier scheme: comfortable / warning / hot.
 */
export type UsageStatus = "ok" | "warn" | "high"
export function classifyUtilization(utilization: number | null | undefined): UsageStatus {
  if (utilization == null || !Number.isFinite(utilization)) return "ok"
  if (utilization >= 0.85) return "high"
  if (utilization >= 0.6) return "warn"
  return "ok"
}

/**
 * Format the time-until-reset for a window.
 *
 * `resetsAt` is a Unix epoch in milliseconds (matching Meridian's own
 * /v1/usage/quota response shape) — null when the window has no known
 * reset time.
 *
 * `now` is injectable so tests don't depend on Date.now(); production
 * callers omit it and the function uses the current time.
 */
export function formatResetCountdown(resetsAt: number | null | undefined, now: number = Date.now()): string {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return ""
  const ms = resetsAt - now
  if (ms <= 0) return "resetting…"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  if (hours < 24) return remMin > 0 ? `in ${hours}h ${remMin}m` : `in ${hours}h`
  const days = Math.floor(hours / 24)
  const remHr = hours % 24
  return remHr > 0 ? `in ${days}d ${remHr}h` : `in ${days}d`
}

/**
 * Format an extra-usage block. Returns null when the profile has no
 * extra-usage info worth showing (disabled or missing data) — caller
 * should hide the section entirely in that case.
 */
export interface ExtraUsageDisplay {
  used: string
  limit: string
  utilizationPct: number
  status: UsageStatus
}
export function formatExtraUsage(eu: {
  isEnabled: boolean
  monthlyLimit: number
  usedCredits: number
  utilization: number | null
  currency: string
} | null | undefined): ExtraUsageDisplay | null {
  if (!eu || !eu.isEnabled) return null
  const monthlyLimit = Number.isFinite(eu.monthlyLimit) ? eu.monthlyLimit : 0
  if (monthlyLimit <= 0) return null
  const used = Number.isFinite(eu.usedCredits) ? eu.usedCredits : 0
  const utilization =
    eu.utilization != null && Number.isFinite(eu.utilization)
      ? Math.max(0, Math.min(1, eu.utilization))
      : monthlyLimit > 0
        ? Math.max(0, Math.min(1, used / monthlyLimit))
        : 0
  return {
    used: `${eu.currency || ""}${used.toFixed(2)}`.trim(),
    limit: `${eu.currency || ""}${monthlyLimit.toFixed(2)}`.trim(),
    utilizationPct: Math.round(utilization * 100),
    status: classifyUtilization(utilization),
  }
}

/**
 * Weekly-pace comparison for the 7-day usage window.
 *
 * Compares how much of the weekly allowance has been consumed against how much
 * *time* has elapsed in the window — the "am I burning it too fast?" question.
 * The window resets at `resetsAt` and started 7 days earlier, so the elapsed
 * fraction gives the expected (even-pace) utilization.
 *
 * Returns null when there isn't enough data to compute a meaningful pace
 * (missing utilization or reset time) — callers should hide the widget then.
 *
 * `now` is injectable for tests; production callers omit it.
 */
export interface WeeklyPace {
  /** Actual utilization, rounded to a percent (may exceed 100). */
  actualPct: number
  /** Expected utilization at this point in the window, 0..100. */
  expectedPct: number
  /** actualPct − expectedPct; positive means ahead of (faster than) pace. */
  deltaPct: number
  /** Extrapolated end-of-window utilization at the current rate; null if it's
   *  too early in the window to project without wild swings. */
  projectedPct: number | null
  /** Consumption relative to even pace. */
  status: "under" | "on" | "ahead"
  /** Position in the window, 0..1 (fraction of the 7 days elapsed). */
  elapsedFraction: number
}

const SEVEN_DAYS_MS = 7 * 86_400_000
/** Delta (percentage points) within which pace is considered "on track". */
const PACE_ON_BAND = 7
/** Don't extrapolate a projection until this fraction of the window elapsed. */
const PROJECT_MIN_ELAPSED = 0.1

export function computeWeeklyPace(
  utilization: number | null | undefined,
  resetsAt: number | null | undefined,
  now: number = Date.now(),
): WeeklyPace | null {
  if (utilization == null || !Number.isFinite(utilization)) return null
  if (resetsAt == null || !Number.isFinite(resetsAt)) return null

  const windowStart = resetsAt - SEVEN_DAYS_MS
  const elapsedFraction = Math.max(0, Math.min(1, (now - windowStart) / SEVEN_DAYS_MS))

  const actualPct = Math.round(Math.max(0, utilization) * 100)
  const expectedPct = Math.round(elapsedFraction * 100)
  const deltaPct = actualPct - expectedPct

  const status: WeeklyPace["status"] =
    deltaPct > PACE_ON_BAND ? "ahead" : deltaPct < -PACE_ON_BAND ? "under" : "on"

  const projectedPct =
    elapsedFraction >= PROJECT_MIN_ELAPSED
      ? Math.round((Math.max(0, utilization) / elapsedFraction) * 100)
      : null

  return { actualPct, expectedPct, deltaPct, projectedPct, status, elapsedFraction }
}
