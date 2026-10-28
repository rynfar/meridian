/** Logs screen: diagnostic log filtering by text, level and category. Pure. */
import { number, rows, text } from '../../core'

export interface LogRow { timestamp: number; level: string; category: string; message: string; requestId: string }
export function logRows(value: unknown): LogRow[] {
  return rows(value).map(log => ({ timestamp: number(log.timestamp) ?? 0, level: text(log.level) || 'info', category: text(log.category) || 'event', message: text(log.message) || JSON.stringify(log), requestId: text(log.requestId) }))
    .sort((a, b) => b.timestamp - a.timestamp)
}
export function filterLogRows(logs: readonly LogRow[], query: string, level: string, category: string): LogRow[] {
  const search = query.trim().toLowerCase()
  return logs.filter(log => (level === 'all' || log.level === level) && (category === 'all' || log.category === category)
    && (!search || `${log.category} ${log.level} ${log.message} ${log.requestId}`.toLowerCase().includes(search)))
}
export function logFacets(logs: readonly LogRow[]): { levels: [string, number][]; categories: [string, number][] } {
  const count = (key: 'level' | 'category') => {
    const counts = new Map<string, number>()
    for (const log of logs) counts.set(log[key], (counts.get(log[key]) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }
  return { levels: count('level'), categories: count('category') }
}
/** Tone for a log level. */
export function levelTone(level: string): 'red' | 'yellow' | 'muted' {
  return level === 'error' ? 'red' : level === 'warn' || level === 'warning' ? 'yellow' : 'muted'
}
