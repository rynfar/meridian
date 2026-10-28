/** Pure desktop policy. No Electron or proxy imports. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function text(value: unknown): string { return typeof value === 'string' ? value : '' }
export function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
export function rows(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(object) : [] }
export function version(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(value) || value.length > 80) throw new Error('Choose an exact Meridian version, such as 1.71.1.')
  return value
}
export function endpoint(value: unknown): string {
  const url = new URL(text(value))
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a local HTTP address, such as http://127.0.0.1:3456.')
  return url.origin
}
export function port(value: unknown): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1024 || value > 65535) throw new Error('Port must be an integer between 1024 and 65535.')
  return value
}
/** Time range the dashboard summarises. 'today' starts at local midnight. */
export type WindowKind = 'today' | '1h' | '24h' | '7d'
export const windowKinds: readonly WindowKind[] = ['today', '1h', '24h', '7d']
export function windowKind(value: unknown): WindowKind {
  const kind = typeof value === 'string' ? value : text(object(value).kind)
  if (!(windowKinds as readonly string[]).includes(kind)) throw new Error('Choose today, 1h, 24h or 7d.')
  return kind as WindowKind
}
export interface Preferences { window: WindowKind; backend?: 'claude' | 'antigravity' | 'combined'; allowAntigravityTools?: boolean; allowAntigravityBrowser?: boolean; allowAntigravitySubagents?: boolean; persistAntigravityHistory?: boolean; mode: 'managed' | 'attached'; endpoint: string; port: number; selected?: string; previous?: string; autoStart: boolean; notifications: boolean; notificationCritical: boolean; notificationRequests: boolean; notificationCache: boolean; notificationQuota: boolean; openWindowAtLaunch: boolean; hideDockIcon: boolean; quietUntil: number; apiKey?: string }
export const defaults: Preferences = { window: 'today', mode: 'managed', endpoint: 'http://127.0.0.1:3456', port: 3456, autoStart: false, notifications: false, notificationCritical: true, notificationRequests: false, notificationCache: false, notificationQuota: false, openWindowAtLaunch: true, hideDockIcon: false, quietUntil: 0 }
export interface Incident { id: string; title: string; detail: string; timestamp: number; requestId?: string; severity: 'warning' | 'error' }
export class IncidentDetector {
  private seen = new Set<string>()
  private initialized = false
  private streak = new Map<string, number>()
  private windows = new Map<string, number>()
  collect(requests: unknown, quota: unknown, now = Date.now()): Incident[] {
    const result: Incident[] = []
    for (const request of rows(requests).sort((a, b) => (number(a.timestamp) ?? 0) - (number(b.timestamp) ?? 0))) {
      const id = text(request.requestId); if (!id || this.seen.has(id)) continue
      this.seen.add(id)
      const key = [request.profileId, request.model, request.adapter, request.requestSource].join(':')
      const cache = number(request.cacheHitRate)
      if (request.sdkSessionId && request.isResume && cache !== undefined) {
        const count = cache <= 0.05 ? (this.streak.get(key) ?? 0) + 1 : 0
        this.streak.set(key, count)
        if (count === 3) result.push({ id: `cache:${id}`, requestId: id, title: 'Repeated cache misses', detail: 'Three recent continuations for this account and model had at most 5% cache reuse. Inspect prompt, model, account and history changes.', timestamp: now, severity: 'warning' })
      }
      if ((Array.isArray(request.envelopeViolations) && request.envelopeViolations.length) || (number(request.status) ?? 0) >= 500) result.push({ id: `request:${id}`, requestId: id, title: 'Request needs attention', detail: `${text(request.error) || 'Response envelope violation'} · ${id}`, timestamp: now, severity: 'error' })
    }
    for (const profile of rows(object(quota).profiles)) {
      const fetchedAt = number(profile.fetchedAt)
      if (profile.error || !fetchedAt || now - fetchedAt > 90_000) continue
      for (const window of rows(profile.windows)) {
        const used = number(window.utilization); const reset = number(window.resetsAt)
        if (used === undefined || !reset || reset <= now) continue
        const key = `${text(profile.id)}:${text(window.type)}:${reset}`
        const threshold = used >= 1 ? 100 : used >= .95 ? 95 : used >= .8 ? 80 : 0
        if (!this.windows.has(key)) { this.windows.set(key, threshold); continue }
        if (threshold > (this.windows.get(key) ?? 0)) {
          this.windows.set(key, threshold)
          result.push({ id: `quota:${key}:${threshold}`, title: 'Usage threshold reached', detail: `${text(profile.id)} · ${text(window.type).replaceAll('_', ' ')} · ${Math.round(used * 100)}% used`, timestamp: now, severity: 'warning' })
        }
      }
    }
    // Bounded local state: these alerts are advisory, not a lossless event stream.
    if (this.seen.size > 10000) this.seen = new Set([...this.seen].slice(-5000))
    if (this.streak.size > 2000) this.streak.clear()
    if (this.windows.size > 1000) this.windows.clear()
    if (!this.initialized) { this.initialized = true; return [] }
    return result
  }
}
export function redact(value: string): string {
  return value.replace(/(?:sk-ant-|sk-)[\w-]+/g, '[redacted]').replace(/(authorization|x-api-key|oauthToken|apiKey|access_token|refresh_token)(["'\s:=]+)([^\s,"'}]+)/gi, '$1$2[redacted]')
}

/** Accept saved history only after validating it; a truncated file is not state. */
export function incidents(value: unknown): Incident[] {
  return rows(value).flatMap(item => {
    if (!text(item.id) || !text(item.title) || !text(item.detail) || number(item.timestamp) === undefined || (item.severity !== 'warning' && item.severity !== 'error')) return []
    return [{ id: text(item.id), title: text(item.title), detail: text(item.detail), timestamp: Number(item.timestamp), severity: item.severity, requestId: text(item.requestId) || undefined } satisfies Incident]
  }).slice(0, 200)
}
export function isMeridianHealth(value: unknown): boolean {
  const health = object(value)
  return typeof health.version === 'string' && typeof health.status === 'string' && (typeof object(health.plugin).opencode === 'string' || (object(health.build).version === health.version && ['npm', 'local', 'dev'].includes(text(object(health.build).source))))
}

/** What the UI renders instead of an empty table when the viewed service cannot be read. */
export type ConnectionKind = 'ok' | 'stopped' | 'unauthorized' | 'wrong-port' | 'not-meridian' | 'starting'
export interface ConnectionStatus { kind: ConnectionKind; message: string; fix: string }
export type FailureCode = 'refused' | 'reset' | 'timeout' | 'invalid' | 'http' | 'network'
/** A failed HTTP exchange with the viewed Meridian, typed for classification. */
export class ApiError extends Error {
  constructor(message: string, readonly path: string, readonly code: FailureCode, readonly status?: number, readonly data?: unknown) { super(message); this.name = 'ApiError' }
}
/** Normalise Node (undici), Bun and abort errors into one code. */
export function failureCode(error: unknown): FailureCode {
  if (error instanceof ApiError) return error.code
  const value = object(error)
  const cause = object(value.cause)
  const codes = [value.code, cause.code, value.name, cause.name].map(text)
  const message = `${text(value.message)} ${text(cause.message)}`
  if (codes.some(code => ['ECONNREFUSED', 'ConnectionRefused'].includes(code)) || /ECONNREFUSED|Unable to connect|connection refused/i.test(message)) return 'refused'
  if (codes.some(code => ['TimeoutError', 'AbortError', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code)) || /timed? ?out/i.test(message)) return 'timeout'
  if (codes.some(code => ['ECONNRESET', 'ConnectionReset', 'ConnectionClosed', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) || /socket hang up|ECONNRESET|closed unexpectedly/i.test(message)) return 'reset'
  return 'network'
}
export function httpStatus(error: unknown): number | undefined { return error instanceof ApiError ? error.status : number(object(error).status) }
function host(baseUrl: string) { try { return new URL(baseUrl).host } catch { return baseUrl } }
export interface ConnectionInput {
  baseUrl: string; hasApiKey: boolean; managed?: boolean;
  /** Health body when /health answered. */
  health?: unknown;
  /** Why /health failed, when it did. */
  healthError?: unknown;
  /** Status of the first failed telemetry/profile read, when health was fine. */
  dataStatus?: number;
  /** Another Meridian that detection verified, when the viewed one fails. */
  alternative?: string;
}
/**
 * Classify the viewed service. Pure: callers pass what they observed, the UI
 * renders message + fix. An unreadable service is never an empty dashboard.
 */
export function classifyConnection(input: ConnectionInput): ConnectionStatus {
  const where = host(input.baseUrl)
  const start = input.managed ? 'Start the app-managed copy in Service, or start your own Meridian and choose Re-detect.' : 'Start your Meridian service (launchd, Docker or a terminal), then choose Re-detect.'
  const unauthorized = (status: number): ConnectionStatus => ({ kind: 'unauthorized', message: input.hasApiKey ? `Meridian on ${where} rejected the API key (${status}).` : `Meridian on ${where} requires an API key (${status}).`, fix: 'Enter the key in Service → Connection.' })
  const elsewhere = (reason: string): ConnectionStatus | undefined => input.alternative && input.alternative !== input.baseUrl
    ? { kind: 'wrong-port', message: `${reason}, but Meridian is running on ${host(input.alternative)}.`, fix: `Choose Re-detect to view ${host(input.alternative)}, or change the address in Service → Connection.` }
    : undefined
  if (input.healthError !== undefined) {
    const status = httpStatus(input.healthError)
    if (status === 401 || status === 403) return unauthorized(status)
    const code = failureCode(input.healthError)
    if (code === 'refused' || code === 'reset') return elsewhere(`Nothing is answering on ${where}`) ?? { kind: 'stopped', message: `Meridian is not running on ${where} (connection refused).`, fix: start }
    if (code === 'timeout') return elsewhere(`${where} did not answer in time`) ?? { kind: 'stopped', message: `Meridian on ${where} did not answer in time.`, fix: 'Check that the service is not stuck or still starting, then choose Re-detect.' }
    if (code === 'http' || code === 'invalid') return elsewhere(`${where} is not Meridian`) ?? { kind: 'not-meridian', message: `${where} answered${status ? ` with HTTP ${status}` : ''}, but it is not Meridian.`, fix: 'Choose the port your Meridian listens on in Service → Connection, or choose Re-detect.' }
    return elsewhere(`${where} cannot be reached`) ?? { kind: 'stopped', message: `Cannot reach Meridian on ${where}.`, fix: start }
  }
  if (!isMeridianHealth(input.health)) return elsewhere(`${where} is not Meridian`) ?? { kind: 'not-meridian', message: `${where} answered, but it is not Meridian.`, fix: 'Choose the port your Meridian listens on in Service → Connection, or choose Re-detect.' }
  if (input.dataStatus === 401 || input.dataStatus === 403) return unauthorized(input.dataStatus)
  return { kind: 'ok', message: `Viewing Meridian ${text(object(input.health).version)} on ${where}.`, fix: '' }
}
export function startingConnection(baseUrl: string): ConnectionStatus {
  return { kind: 'starting', message: `Starting the app-managed Meridian on ${host(baseUrl)}.`, fix: 'Wait for startup to finish; requests appear once it is healthy.' }
}
