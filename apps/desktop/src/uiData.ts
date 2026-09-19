import { number, rows, text } from './core'

export function filterLogs(data: unknown, query: string) {
  const search = query.trim().toLowerCase()
  return rows(data).filter(log => [log.category, log.level, log.message].some(value => text(value).toLowerCase().includes(search)))
    .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
}

/** Search only operational metadata, never arbitrary nested request content. */
export function filterRequests(data: unknown, query: string, kind: string, provider = 'all') {
  const search = query.trim().toLowerCase()
  return rows(data).filter(row => {
    const matchesText = !search || [row.provider, row.requestId, row.model, row.profileId, row.adapter, row.error, row.sdkSessionId].some(value => text(value).toLowerCase().includes(search))
    const matchesKind = kind === 'all' || (kind === 'errors' && Number(row.status) >= 400) || (kind === 'low-cache' && row.lineageType === 'continuation' && number(row.cacheHitRate) !== undefined && Number(row.cacheHitRate) <= .05)
    return matchesText && matchesKind && (provider === 'all' || (text(row.provider) || 'claude') === provider)
  }).sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
}

/**
 * Order profile ids according to an explicit profileOrder sequence.
 * Ids in `order` come first in that sequence; any remaining ids preserve their
 * initial relative order at the end.
 */
export function sortProfilesByConfiguredOrder(ids: string[], order?: readonly string[]): string[] {
  if (!order || order.length === 0) return ids.slice()
  const rank = new Map<string, number>()
  for (let i = 0; i < order.length; i++) {
    const item = order[i]
    if (item && !rank.has(item)) rank.set(item, i)
  }
  return ids
    .map((id, index) => ({ id, index }))
    .sort((a, b) => {
      const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER
      if (ra !== rb) return ra - rb
      return a.index - b.index
    })
    .map(entry => entry.id)
}
