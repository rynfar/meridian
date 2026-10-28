export const pages = ['today', 'traffic', 'cache', 'accounts', 'logs', 'service'] as const
export type Page = typeof pages[number]
export const pageTitles: Record<Page, string> = { today: 'Today', traffic: 'Traffic', cache: 'Cache', accounts: 'Accounts', logs: 'Logs', service: 'Service' }
/** Screens whose figures follow the time window. */
export const windowed: readonly Page[] = ['today', 'traffic', 'cache', 'accounts']
export interface Focus { request?: string; filter?: 'all' | 'errors' | 'low-cache'; section?: string }
export interface Navigate { (page: Page, focus?: Focus): void }
