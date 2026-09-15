import { number, rows, text } from './core'

export function filterLogs(data: unknown, query: string) {
  const search = query.trim().toLowerCase()
  return rows(data).filter(log => [log.category, log.level, log.message].some(value => text(value).toLowerCase().includes(search)))
    .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
}

/** Search only operational metadata, never arbitrary nested request content. */
export function filterRequests(data: unknown, query: string, kind: string) {
  const search = query.trim().toLowerCase()
  return rows(data).filter(row => {
    const matchesText = !search || [row.requestId, row.model, row.profileId, row.adapter, row.error, row.sdkSessionId].some(value => text(value).toLowerCase().includes(search))
    const matchesKind = kind === 'all' || (kind === 'errors' && Number(row.status) >= 400) || (kind === 'low-cache' && row.lineageType === 'continuation' && number(row.cacheHitRate) !== undefined && Number(row.cacheHitRate) <= .05)
    return matchesText && matchesKind
  }).sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
}
