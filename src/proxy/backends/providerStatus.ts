import type { ProviderUsage, ProviderSnapshot } from '../../telemetry/providerView'

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const rows = (v: unknown) => Array.isArray(v) ? v.map(object) : []
const text = (v: unknown) => typeof v === 'string' ? v : ''
const quotaError = (value: unknown) => ({ no_token: 'Sign in to this Claude account to see its usage.', rate_limited: 'Claude usage is temporarily rate-limited.', auth_failure: 'Claude sign-in needs attention.' })[text(value) as 'no_token' | 'rate_limited' | 'auth_failure'] || text(value)
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0

/** Normalize provider facts without adding together unrelated quota percentages. */
export function claudeProvider(healthValue: unknown, summaryValue: unknown, quotaValue: unknown): ProviderUsage {
  const health = object(healthValue), summary = object(summaryValue), tokens = object(summary.tokenUsage)
  return {
    id: 'claude', name: 'Claude', enabled: true, status: text(health.status) || 'unavailable', endpoint: '/v1/messages',
    error: text(object(summary.error).message) || text(object(quotaValue).error) || undefined,
    activity: typeof summary.totalRequests === 'number' ? { requests: summary.totalRequests, errors: number(summary.errorCount), inputTokens: number(tokens.totalInputTokens), outputTokens: number(tokens.totalOutputTokens), cacheReadTokens: number(tokens.totalCacheReadTokens) } : undefined,
    accounts: rows(object(quotaValue).profiles).map(p => ({ id: text(p.id), fetchedAt: number(p.fetchedAt) || undefined, error: quotaError(p.error) || quotaError(object(p.failure).reason) || undefined, windows: rows(p.windows).filter(w => typeof w.utilization === 'number' && Number.isFinite(w.resetsAt)).map(w => ({ type: text(w.type), utilization: Math.min(1, Math.max(0, number(w.utilization))), resetsAt: number(w.resetsAt) })) })),
  }
}
export function providerSnapshot(providers: ProviderUsage[]): ProviderSnapshot { return { providers, fetchedAt: Date.now() } }
export function disabledProvider(id: 'claude' | 'antigravity'): ProviderUsage {
  return { id, name: id === 'claude' ? 'Claude' : 'Antigravity', enabled: false, status: 'disabled', endpoint: id === 'claude' ? '/v1/messages' : '/antigravity/v1/messages', accounts: [] }
}

export { parseProviderSnapshot } from '../../telemetry/providerView'

/** Quota services must never stall navigation or hide current local activity. */
export class ClaudeProviderFacts {
  private health: unknown = { status: 'loading' }
  private quota: unknown = {}
  private checkedAt = 0
  private refreshing?: Promise<void>
  snapshot(read: (path: string) => Promise<unknown>, summary: unknown): ProviderUsage {
    if (!this.refreshing && Date.now() - this.checkedAt >= 10000) {
      this.checkedAt = Date.now()
      this.refreshing = Promise.allSettled([read('/health'), read('/v1/usage/quota/all')]).then(([health, quota]) => {
        this.health = health.status === 'fulfilled' ? health.value : { status: 'unavailable' }
        const failure = quota.status === 'rejected' ? String(quota.reason) : text(object(quota.value).error)
        if (failure) this.quota = { ...object(this.quota), error: failure, profiles: rows(object(this.quota).profiles).map(p => ({ ...p, error: failure })) }
        else if (quota.status === 'fulfilled') this.quota = quota.value
      }).finally(() => { this.refreshing = undefined })
    }
    return claudeProvider(this.health, summary, this.quota)
  }
}
