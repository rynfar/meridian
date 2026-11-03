export const pages = ['today', 'traffic', 'cache', 'accounts', 'logs', 'service'] as const
export type Page = typeof pages[number]
export const pageTitles: Record<Page, string> = { today: 'Today', traffic: 'Traffic', cache: 'Cache', accounts: 'Accounts', logs: 'Logs', service: 'Service' }
/** Screens whose figures follow the time window. */
export const windowed: readonly Page[] = ['today', 'traffic', 'cache', 'accounts']
export interface Focus { request?: string; filter?: 'all' | 'errors' | 'low-cache'; section?: string }
export interface Navigate { (page: Page, focus?: Focus): void }

/** ⌘1–⌘6 open the screens in sidebar order; ⌘R refreshes. */
export const pageShortcut: Record<Page, string> = Object.fromEntries(pages.map((page, index) => [page, `⌘${index + 1}`])) as Record<Page, string>
export const refreshShortcut = '⌘R'
export type Shortcut = { kind: 'page'; page: Page } | { kind: 'refresh' }
/** The window shortcut a keydown means, if any. Command on macOS; Control elsewhere. */
export function shortcutFor(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, mac = true): Shortcut | null {
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!command || event.altKey || event.shiftKey) return null
  if (event.key.toLowerCase() === 'r') return { kind: 'refresh' }
  const index = Number.parseInt(event.key, 10)
  const page = Number.isInteger(index) && String(index) === event.key ? pages[index - 1] : undefined
  return page ? { kind: 'page', page } : null
}
