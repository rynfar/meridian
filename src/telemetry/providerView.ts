/** Shared provider presentation for the web dashboard and native desktop renderer. */
export interface ProviderUsage {
  id: 'claude' | 'antigravity'; name: string; enabled: boolean; status: string; endpoint: string;
  error?: string; models?: string[]; observedSince?: number;
  capabilities?: Array<{ name: string; status: string; detail: string }>;
  activity?: { requests: number; errors: number; inputTokens: number; outputTokens: number; cacheReadTokens: number };
  accounts: Array<{ id: string; active?: boolean; fetchedAt?: number; error?: string; windows: Array<{ type: string; group?: string; utilization: number; resetsAt: number }> }>;
}
export interface ProviderSnapshot { providers: ProviderUsage[]; fetchedAt: number }
export type ProviderFilter = 'all' | 'claude' | 'antigravity'
/** Dependency-free validation: desktop builds independently of proxy packages. */
export function parseProviderSnapshot(value: unknown): ProviderSnapshot {
  const fail = (): never => { throw new Error('Invalid provider response') }
  const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail()
  const array = (v: unknown): unknown[] => Array.isArray(v) ? v : fail()
  const string = (v: unknown): string => typeof v === 'string' ? v : fail()
  const number = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : fail()
  const count = (v: unknown): number => { const n = number(v); return n >= 0 ? n : fail() }
  const boolean = (v: unknown): boolean => typeof v === 'boolean' ? v : fail()
  const optionalString = (v: unknown) => v === undefined ? undefined : string(v)
  const optionalNumber = (v: unknown) => v === undefined ? undefined : number(v)
  const input = object(value)
  return { fetchedAt: number(input.fetchedAt), providers: array(input.providers).map(value => {
    const p = object(value)
    if (p.id !== 'claude' && p.id !== 'antigravity') return fail()
    const activity = p.activity === undefined ? undefined : object(p.activity)
    return { id: p.id, name: string(p.name), enabled: boolean(p.enabled), status: string(p.status), endpoint: string(p.endpoint), error: optionalString(p.error), models: p.models === undefined ? undefined : array(p.models).map(string), observedSince: optionalNumber(p.observedSince),
      capabilities: p.capabilities === undefined ? undefined : array(p.capabilities).map(value => { const capability = object(value); return { name: string(capability.name), status: string(capability.status), detail: string(capability.detail) } }),
      activity: activity && { requests: count(activity.requests), errors: count(activity.errors), inputTokens: count(activity.inputTokens), outputTokens: count(activity.outputTokens), cacheReadTokens: count(activity.cacheReadTokens) },
      accounts: array(p.accounts).map(value => {
        const a = object(value)
        return { id: string(a.id), active: a.active === undefined ? undefined : boolean(a.active), fetchedAt: optionalNumber(a.fetchedAt), error: optionalString(a.error), windows: array(a.windows).map(value => {
          const w = object(value), utilization = count(w.utilization)
          if (utilization > 1) return fail()
          return { type: string(w.type), group: optionalString(w.group), utilization, resetsAt: number(w.resetsAt) }
        }) }
      }) }
  }) }
}
export function providerOverview(data: ProviderSnapshot, filter: ProviderFilter = 'all'): string {
  const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
  const windowLabel = (value: string) => ({'gemini-weekly':'Weekly','3p-weekly':'Weekly','gemini-5h':'5 hours','3p-5h':'5 hours','five_hour':'5 hours','seven_day':'Weekly'})[value as 'gemini-weekly'] || value.replaceAll('_', ' ')
  const num = (value: number) => value.toLocaleString()
  const providers = data.providers.filter(p => filter === 'all' || p.id === filter)
  const active = providers.filter(p => p.enabled)
  const measured = active.filter(p => p.activity)
  const total = measured.reduce((sum, p) => ({ requests: sum.requests + p.activity!.requests, tokens: sum.tokens + p.activity!.inputTokens + p.activity!.outputTokens, errors: sum.errors + p.activity!.errors }), { requests: 0, tokens: 0, errors: 0 })
  return `<div class="provider-tabs" role="group" aria-label="Provider filter">${(['all', 'claude', 'antigravity'] as const).map(id => `<button data-provider="${id}" aria-pressed="${filter === id}">${id === 'all' ? 'All providers' : id === 'claude' ? 'Claude' : 'Antigravity'}</button>`).join('')}</div>
    <div class="provider-totals" aria-label="Observed activity"><div><span>Requests</span><strong>${measured.length ? num(total.requests) : '—'}</strong></div><div><span>Input + output tokens</span><strong>${measured.length ? num(total.tokens) : '—'}</strong></div><div><span>Errors</span><strong>${measured.length ? num(total.errors) : '—'}</strong></div></div>
    <p class="provider-caption">Observed activity over the past hour. Subscription allowances stay separate.${measured.length < active.length ? ' Some activity is unavailable; totals are partial.' : ''}</p>
    <div class="provider-grid">${providers.map(p => `<article class="provider-card" data-provider-card="${p.id}"><header><div><span class="provider-eyebrow">${p.id === 'claude' ? 'Anthropic subscription' : 'Google subscription'}</span><h2>${esc(p.name)}</h2></div><span class="provider-state ${p.status === 'healthy' ? 'good' : ''}">${esc(p.enabled ? p.status : 'Not enabled')}</span></header>
      ${p.enabled ? `<p class="provider-endpoint">${esc(p.endpoint)}</p>${p.error ? `<p class="provider-warning" role="status">${esc(p.error)}</p>` : ''}
      ${p.activity ? `<div class="provider-activity"><span><strong>${num(p.activity.requests)}</strong> requests</span><span><strong>${num(p.activity.inputTokens + p.activity.outputTokens)}</strong> tokens</span></div>` : '<p class="provider-caption">Activity unavailable</p>'}
      ${p.accounts.map(account => `<section class="provider-account"><h3>${esc(account.id)}${account.active ? ' <span class="provider-caption">· Current account</span>' : ''}</h3>${account.error ? `<p class="provider-warning">${esc(account.error)}${account.windows.length ? ' · Last known limits shown below.' : ''}</p>` : ''}${account.windows.map(w => {
        const stale = !!account.error || !account.fetchedAt || data.fetchedAt - account.fetchedAt > 90000 || w.resetsAt <= data.fetchedAt
        const value = Math.round(w.utilization * 100)
        return `<div class="provider-quota"><div><span>${esc(w.group ? w.group + ' · ' : '')}${esc(windowLabel(w.type))}</span><strong>${value}% used${stale ? ' · stale' : ''}</strong></div><progress max="1" value="${w.utilization}" class="${stale ? 'stale' : value >= 85 ? 'danger' : value >= 60 ? 'warning' : ''}" aria-label="${esc(w.group || p.name)} ${esc(w.type)} usage"></progress><small>${stale ? 'Last known reset' : 'Resets'} ${esc(new Date(w.resetsAt).toLocaleString())}</small></div>`
      }).join('') || '<p class="provider-caption">No current quota data</p>'}</section>`).join('') || '<p class="provider-caption">No account data available</p>'}
      ${p.capabilities?.length ? `<details class="provider-capabilities"><summary>Capabilities and limits</summary><dl>${p.capabilities.map(capability => `<div><dt>${esc(capability.name)} <span>${esc(capability.status)}</span></dt><dd>${esc(capability.detail)}</dd></div>`).join('')}</dl></details>` : ''}
      ${p.models?.length ? `<details><summary>${p.models.length} account models</summary><ul class="provider-models">${p.models.map(m => `<li>${esc(m)}</li>`).join('')}</ul></details>` : ''}
      ${p.id === 'claude' ? '<a class="provider-link" href="/profiles" data-provider-page="/profiles">Manage Claude accounts →</a>' : '<p class="provider-caption">Uses the account signed in to Antigravity CLI. Client tools keep their own approval controls.</p>'}` : `<p class="provider-caption">${p.id === 'antigravity' ? 'Enable Antigravity alongside Claude in service settings.' : 'Claude is not enabled on this service.'}</p>`}</article>`).join('')}</div>`
}
export const providerViewCss = `
.provider-tabs{display:flex;gap:20px;border-bottom:1px solid var(--border);margin-bottom:24px}.provider-tabs button{border:0;border-radius:0;background:transparent;padding:12px 0;color:var(--muted);font:inherit;cursor:pointer}.provider-tabs button[aria-pressed="true"]{color:var(--accent);border-bottom:2px solid var(--accent)}
.provider-totals{display:flex;border:1px solid var(--border);border-radius:12px;background:var(--surface)}.provider-totals>div{flex:1;padding:18px 20px}.provider-totals>div+div{border-left:1px solid var(--border)}.provider-totals span,.provider-eyebrow{display:block;font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted)}.provider-totals strong{display:block;font-size:24px;font-weight:600;margin-top:8px;font-variant-numeric:tabular-nums}
.provider-caption{color:var(--muted);font-size:12px;line-height:1.6}.provider-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px;margin:24px 0}.provider-card{padding:20px;border:1px solid var(--border);border-radius:12px;background:var(--surface);min-width:0}.provider-card>header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0;border:0;position:static;height:auto}.provider-card h2{font-size:20px;margin:6px 0}.provider-state{font-size:11px;color:var(--muted)}.provider-state.good{color:var(--green)}.provider-endpoint{font:12px 'SF Mono',monospace;color:var(--accent2);overflow-wrap:anywhere}.provider-activity{display:flex;gap:24px;margin:20px 0;color:var(--muted);font-size:12px}.provider-activity strong{color:var(--text);font-variant-numeric:tabular-nums}.provider-account{border-top:1px solid var(--border);padding-top:16px;margin-top:16px}.provider-account h3{font-size:13px;font-weight:600;margin:0 0 16px}.provider-quota{margin:16px 0}.provider-quota>div{display:flex;justify-content:space-between;gap:12px;font-size:12px}.provider-quota strong{font-variant-numeric:tabular-nums;white-space:nowrap}.provider-quota small{font-size:11px;color:var(--muted)}.provider-quota progress{display:block;width:100%;height:6px;margin:8px 0;appearance:none;border:0;border-radius:4px;background:var(--surface2);accent-color:var(--green)}.provider-quota progress::-webkit-progress-bar{background:var(--surface2);border-radius:4px}.provider-quota progress::-webkit-progress-value{background:var(--green);border-radius:4px}.provider-quota progress.warning::-webkit-progress-value{background:var(--yellow)}.provider-quota progress.danger::-webkit-progress-value{background:var(--red)}.provider-quota progress.stale::-webkit-progress-value{background:var(--muted)}.provider-warning{font-size:12px;line-height:1.5;color:var(--yellow);overflow-wrap:anywhere}.provider-models{font:12px 'SF Mono',monospace;color:var(--accent2);line-height:1.8;overflow-wrap:anywhere;padding-left:18px}.provider-card summary{cursor:pointer;color:var(--accent);font-size:12px;margin-top:20px}.provider-link{display:inline-block;color:var(--accent);font-size:12px;margin-top:20px;text-decoration:none}
.provider-capabilities dl{margin:12px 0}.provider-capabilities dl>div{display:block;padding:8px 0}.provider-capabilities dt{color:var(--text);font-size:12px;font-weight:600;display:flex;justify-content:space-between;gap:12px}.provider-capabilities dt span{font-weight:400;color:var(--accent2)}.provider-capabilities dd{text-align:left;margin:4px 0 0;color:var(--muted);font-size:12px;line-height:1.6}
@media(max-width:600px){.provider-grid{grid-template-columns:1fr}.provider-totals>div{padding:14px 10px}.provider-totals strong{font-size:20px}.provider-tabs{gap:16px}.provider-card{padding:16px}}
`
