/** Pure display formatters shared by the window and the menu-bar panel. No DOM, no React. */
import { number } from '../../core'

const finite = (value: unknown): number | undefined => number(value)

/**
 * A share as a whole percent that never rounds into a claim it is not:
 * 0.996 → 99 (not "100", which reads as complete), 0.004 → 1 (not "0").
 */
export function percentFigure(share: number): number {
  const rounded = Math.round(share * 100)
  if (rounded >= 100 && share < 1) return 99
  if (rounded <= 0 && share > 0) return 1
  return rounded
}

/** 0.96 → "96%". Unknown is an em dash, never 0%. */
export function pct(value: unknown): string {
  const n = finite(value)
  return n === undefined ? '—' : `${percentFigure(n)}%`
}

/** 833 → "833", 12345 → "12,345". */
export function fmtInt(value: unknown): string {
  const n = finite(value)
  return n === undefined ? '—' : Math.round(n).toLocaleString('en-US')
}

/** Token counts: 232895702 → "232.9M", 945000 → "945k", 812 → "812". */
export function fmtTok(value: unknown): string {
  const n = finite(value)
  if (n === undefined) return '—'
  const abs = Math.abs(n)
  // Thresholds sit where the rounded figure rolls over: 999,500 is "1.0M", not "1000k".
  if (abs >= 999_950_000) return `${(n / 1e9).toFixed(1)}B`
  if (abs >= 999_500) return `${(n / 1e6).toFixed(1)}M`
  if (abs >= 999.5) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}

/** Durations as seconds: 8569 → "8.6s", 240 → "0.24s". */
export function seconds(value: unknown): string {
  const n = finite(value)
  if (n === undefined) return '—'
  return `${(n / 1000).toFixed(n < 1000 ? 2 : 1)}s`
}

/** Short duration for tables: 2 → "2ms", 1877 → "1.9s". */
export function ms(value: unknown): string {
  const n = finite(value)
  if (n === undefined) return '—'
  if (n < 1000) return `${Math.round(n)}ms`
  return seconds(n)
}

/** Local 24-hour clock time: "21:41". */
export function hhmm(value: unknown): string {
  const n = finite(value)
  if (n === undefined) return '—'
  const date = new Date(n)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const DAY = 86_400_000
/** "21:41" today, "Tue 21:41" within a week, "Oct 21 21:41" otherwise. */
export function when(value: unknown, now: number): string {
  const n = finite(value)
  if (n === undefined) return '—'
  const date = new Date(n), today = new Date(now)
  if (date.toDateString() === today.toDateString()) return hhmm(n)
  if (Math.abs(now - n) < 6 * DAY) return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${hhmm(n)}`
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hhmm(n)}`
}

/** "in 3h 12m", "in 4d 2h", "5m ago". */
export function relative(value: unknown, now: number): string {
  const n = finite(value)
  if (n === undefined) return '—'
  const delta = n - now
  const abs = Math.abs(delta)
  const minutes = Math.round(abs / 60_000)
  let text: string
  if (minutes < 1) text = 'under a minute'
  else if (minutes < 60) text = `${minutes}m`
  else if (minutes < 24 * 60) text = `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
  else text = `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60) ? ` ${Math.floor((minutes % 1440) / 60)}h` : ''}`
  return delta >= 0 ? `in ${text}` : `${text} ago`
}

/** API-equivalent dollars: 78.17058 → "$78.17". */
export function usd(value: unknown): string {
  const n = finite(value)
  if (n === undefined) return '—'
  if (n > 0 && n < 0.01) return '<$0.01'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** "1 request", "2 requests". */
export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? word : many}`
}

/** "opus[1m]" → { name: "opus", longContext: true }. */
export function modelName(value: unknown): { name: string; longContext: boolean } {
  const raw = typeof value === 'string' ? value : ''
  const longContext = /\[1m\]$/i.test(raw)
  return { name: raw.replace(/\[1m\]$/i, '') || 'unknown model', longContext }
}

/** Bytes for storage readouts. */
export function bytes(value: unknown): string {
  const n = finite(value)
  if (n === undefined) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}
