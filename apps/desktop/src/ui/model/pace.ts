/**
 * Pace on a limit window: how much of the window has already elapsed, against
 * how much of the allowance is used. The tick sits at the elapsed share; usage
 * well past it means the account runs out before the reset. Pure — the clock
 * is passed in.
 */
import { hhmm } from './format'
import type { LimitWindow } from './accounts'

const HOUR = 3_600_000, DAY = 24 * HOUR
/** Pace within ±5 points of the elapsed share reads as "on pace". */
export const PACE_BAND = 0.05

/** Length of a usage window, null when unknown (no tick is drawn then). */
export function windowSpan(type: string): number | null {
  if (type === 'five_hour' || /(^|[-_])5h$/.test(type)) return 5 * HOUR
  if (type === 'seven_day' || /^seven_day_/.test(type) || /(^|[-_])(7d|weekly)$/.test(type)) return 7 * DAY
  if (type === '30d' || /(^|[-_])30d$/.test(type)) return 30 * DAY
  return null
}

export type PaceState = 'on' | 'ahead' | 'under' | 'full'
export interface Pace {
  /** Share of the window already elapsed, 0..1: where the tick goes. */
  elapsed: number;
  state: PaceState;
  label: string;
}

/** null when the tick would mislead: stale reading, unknown reset, usage or window length. */
export function pace(window: Pick<LimitWindow, 'type' | 'utilization' | 'resetsAt' | 'stale'> | undefined, now: number): Pace | null {
  if (!window || window.stale || window.resetsAt === null || window.utilization === null || !Number.isFinite(window.utilization)) return null
  const span = windowSpan(window.type)
  if (!span || window.resetsAt <= now) return null
  const elapsed = Math.min(1, Math.max(0, 1 - (window.resetsAt - now) / span))
  const used = window.utilization
  const state: PaceState = used >= 1 ? 'full' : used > elapsed + PACE_BAND ? 'ahead' : used < elapsed - PACE_BAND ? 'under' : 'on'
  const label = { full: 'limit reached', ahead: 'ahead of pace', under: 'under pace', on: 'on pace' }[state]
  return { elapsed, state, label }
}

const weekday = (t: number) => new Date(t).toLocaleDateString('en-US', { weekday: 'short' })

/** Clock time when the reset is within a day of now, else weekday + time: "14:59", "Sun 10:00". */
export function resetClock(resetsAt: number, now: number): string {
  return Math.abs(resetsAt - now) < DAY ? hhmm(resetsAt) : `${weekday(resetsAt)} ${hhmm(resetsAt)}`
}

/** Beneath a limit bar: "resets 14:59", "resets Sun 10:00", "reset at 10:00" once passed, or why there is no time. */
export function resetText(window: Pick<LimitWindow, 'resetsAt' | 'stale'> | undefined, now: number): string {
  if (!window) return 'no reading'
  if (window.resetsAt === null) return 'reset unknown'
  if (window.resetsAt <= now) return `reset at ${resetClock(window.resetsAt, now)}`
  return `resets ${resetClock(window.resetsAt, now)}`
}

/** Said of a window whose reset passed: "reset at 10:00, awaiting a new reading". */
export function awaitingText(window: Pick<LimitWindow, 'resetsAt'>, now: number): string {
  return window.resetsAt === null ? 'awaiting a new reading' : `reset at ${resetClock(window.resetsAt, now)}, awaiting a new reading`
}

/** A held account's action text: "until 10:59" today, "until Wed" later, "limited" when unknown. */
export function untilText(resetsAt: number | null, now: number): string {
  if (resetsAt === null || resetsAt <= now) return 'limited'
  return resetsAt - now < DAY ? `until ${hhmm(resetsAt)}` : `until ${weekday(resetsAt)}`
}
