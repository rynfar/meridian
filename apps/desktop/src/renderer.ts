import { object, rows, text, number } from './core'
import { filterLogs, filterRequests, sortProfilesByConfiguredOrder } from './uiData'
import type { DesktopState, Action } from './contracts'
const pages = ['Overview', 'Usage & accounts', 'Requests', 'Logs', 'Service', 'Versions', 'Plugins', 'Settings'] as const
type Page = typeof pages[number]
const symbols = ['◉', '◷', '⇄', '≡', '◈', '↓', '◇', '⚙']
let page: Page = 'Overview'
let state: DesktopState | undefined
let filter = ''
let requestKind = 'all'
let logSource = 'incidents'
let logFilter = ''
let selectedRequest = ''
let renderedKey = ''
let accountSort: 'configured' | 'spent-desc' | 'spent-asc' = 'configured'

const GENERAL_WINDOW_TYPES = ['five_hour', 'seven_day']
const FADE_FROM = 0.85
const SPENT_AT = 0.95

function computeProfileSpend(profile: Record<string, unknown>, account: Record<string, unknown>) {
  const failureObj = profile.failure && typeof profile.failure === 'object' ? profile.failure as Record<string, unknown> : null
  const failureReason = failureObj ? text(failureObj.reason) : ''
  const isUnusable = account.loggedIn === false || profile.error === 'no_token' || failureReason === 'auth_failure'
  if (isUnusable) return { fraction: 1, state: 'spent', fade: 0, reason: 'unusable' }
  const spentObj = profile.spent && typeof profile.spent === 'object' ? profile.spent as Record<string, unknown> : null
  const isSpent = Boolean(spentObj && (!spentObj.until || Number(spentObj.until) > Date.now()))
  if (isSpent) return { fraction: 1, state: 'spent', fade: 1, reason: 'refusing' }
  const wins = rows(profile.windows)
  let worst: number | null = null
  for (const w of wins) {
    const type = text(w.type)
    if (!GENERAL_WINDOW_TYPES.includes(type)) continue
    const val = number(w.utilization)
    if (val === undefined || !isFinite(val)) continue
    const clamped = Math.max(0, Math.min(1, val))
    if (worst === null || clamped > worst) worst = clamped
  }
  if (worst === null) return { fraction: null, state: 'unknown', fade: 0, reason: null }
  if (worst >= SPENT_AT) return { fraction: worst, state: 'spent', fade: 1, reason: 'usage' }
  if (worst >= FADE_FROM) return { fraction: worst, state: 'fading', fade: (worst - FADE_FROM) / (SPENT_AT - FADE_FROM), reason: null }
  return { fraction: worst, state: 'available', fade: 0, reason: null }
}

function sortProfilesForView(items: string[], mode: 'configured' | 'spent-desc' | 'spent-asc', spentOf: (id: string) => number | null): string[] {
  const list = items.slice()
  if (mode === 'configured') return list
  const direction = mode === 'spent-desc' ? -1 : 1
  return list
    .map((item, index) => ({ item, index, spent: spentOf(item) }))
    .sort((a, b) => {
      if (a.spent === null || b.spent === null) {
        if (a.spent === null && b.spent === null) return a.index - b.index
        return a.spent === null ? 1 : -1
      }
      if (a.spent !== b.spent) return (a.spent - b.spent) * direction
      return a.index - b.index
    })
    .map(entry => entry.item)
}
const el = (id: string) => { const element = document.getElementById(id); if (!element) throw new Error(`Missing ${id}`); return element }
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
const count = (value: unknown) => number(value)?.toLocaleString(undefined, { maximumFractionDigits: 1 }) ?? '—'
const pct = (value: unknown) => number(value) === undefined ? '—' : `${Math.round(Number(value) * 100)}%`
const time = (value: unknown) => number(value) ? new Date(Number(value)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'
const duration = (value: unknown) => number(value) === undefined ? '—' : `${(Number(value) / 1000).toFixed(1)}s`
const empty = (title: string, detail = '') => `<div class="empty"><strong>${esc(title)}</strong>${detail ? `<p>${esc(detail)}</p>` : ''}</div>`
function section(title: string, caption: string, content: string, extra = '') {
  return `<section ${extra}><div class="section-heading"><div><h2>${esc(title)}</h2>${caption ? `<p>${esc(caption)}</p>` : ''}</div></div>${content}</section>`
}
const button = (action: Action, label: string, value = '', disabled = false) => `<button data-action="${action}" data-value="${esc(value)}" ${disabled || state?.busy ? 'disabled' : ''}>${esc(label)}</button>`
function navigate(next: Page) { page = next; selectedRequest = ''; el('content').scrollTop = 0; el('content').replaceChildren(); renderNav(); renderContent(); el('page-title').textContent = page }
function renderNav() {
  const nav = document.querySelector('nav'); if (!nav) return
  nav.innerHTML = pages.map((name, index) => `<button data-page="${esc(name)}" ${page === name ? 'aria-current="page"' : ''}><span aria-hidden="true">${symbols[index]}</span>${esc(name)}${name === 'Logs' && state?.incidents.length ? `<b>${state.incidents.length}</b>` : ''}</button>`).join('')
  nav.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.onclick = () => { const selected = pages.find(name => name === button.dataset.page); if (selected) navigate(selected) })
}
async function action(name: Action, value?: unknown) {
  try { update(await window.meridian.action(name, value)); el('content').replaceChildren(); renderContent(); renderNav() }
  catch (error) { el('notice').textContent = error instanceof Error ? error.message : String(error); el('notice').className = 'notice error' }
}
function contentKey() {
  if (!state) return 'loading'
  const shared = [page, state.owned, state.running, state.busy, state.preferences, state.login]
  if (page === 'Service') return JSON.stringify([...shared, state.migration])
  if (page === 'Versions') return JSON.stringify([...shared, state.installed, state.available, state.latest])
  if (page === 'Settings') return JSON.stringify([...shared, state.features, state.glass, state.loginAtStartup, state.notificationStatus])
  if (page === 'Plugins') return JSON.stringify([...shared, state.plugins, state.catalog])
  if (page === 'Requests') return JSON.stringify([...shared, state.requests])
  if (page === 'Logs') return JSON.stringify([...shared, state.logs, state.serviceLog, state.incidents])
  return JSON.stringify([...shared, state.health, state.quota, state.profiles, state.requests, state.summary])
}
function update(next: DesktopState) {
  const alertsChanged = state?.incidents.length !== next.incidents.length
  state = next
  if (alertsChanged) renderNav()
  document.documentElement.classList.toggle('native-glass', next.glass === 'Native Liquid Glass')
  el('material').textContent = `Desktop ${next.desktopVersion} · Preview`
  const online = Boolean(next.running)
  el('connection-dot').className = `dot ${online ? 'healthy' : ''}`
  el('connection-name').textContent = online ? next.owned ? 'App managed' : 'External service' : next.preferences.mode === 'managed' ? 'Managed service stopped' : 'Not connected'
  el('connection-address').textContent = (next.preferences.mode === 'managed' ? `127.0.0.1:${next.preferences.port}` : next.preferences.endpoint.replace('http://', ''))
  el('last-checked').textContent = next.busy ? next.busy + '…' : next.lastChecked ? `Updated ${time(next.lastChecked)}` : 'Not refreshed'
  el('version').textContent = next.running ? `Meridian ${next.running}` : `Desktop ${next.desktopVersion}`
  el('refresh').toggleAttribute('disabled', Boolean(next.busy))
  el('notice').textContent = next.error || (next.dataErrors.length && !(next.preferences.mode === 'managed' && !next.owned && !next.busy) ? (online ? `${next.dataErrors.length} data source(s) unavailable. Check the connection and API key in Settings.` : 'No Meridian connection yet. Open Settings to connect your existing service.') : '')
  el('notice').className = el('notice').textContent ? 'notice' : ''
  // Preserve editing focus across background polling. Explicit navigation and
  // completed actions rebuild the content, so settings can still reflect saves.
  if (contentKey() !== renderedKey && (!el('content').contains(document.activeElement) || !document.activeElement?.matches('input, select, textarea'))) renderContent()
  const footer = document.querySelector('footer > span'); if (footer) footer.textContent = next.preferences.mode === 'managed' ? next.owned ? 'Running in the background' : 'Service stopped' : 'Connect only'
}
function stats() {
  const summary = object(state?.summary)
  const tokens = object(summary.tokenUsage)
  const populated = Number(summary.totalRequests) > 0
  const windowLabel = number(summary.windowMs) ? `Last ${Math.round(Number(summary.windowMs) / 60000)} minutes` : 'In this telemetry window'
  const routesSummary = object(state?.routesSummary)
  const failedOver = number(routesSummary.failedOver) ?? 0
  const items: [string, string, string][] = [
    ['Requests', count(summary.totalRequests), windowLabel],
    ['Cache reuse', populated ? pct(tokens.avgCacheHitRate) : '—', 'Mean input cache hit'],
    ['First token', populated ? duration(object(summary.ttfb).p50) : '—', 'Median · SDK to first token'],
    ['Errors', count(summary.errorCount), 'HTTP errors'],
  ]
  if (failedOver > 0) {
    items.push(['Failovers', count(failedOver), `${count(routesSummary.requests)} client requests`])
  }
  return `<div class="stats">${items.map(([label, value, note]) => `<div><span class="eyebrow">${label}</span><strong>${value}</strong><small>${note}</small></div>`).join('')}</div>`
}
const go = (target: Page, label: string) => `<button class="text-button" data-go="${esc(target)}">${esc(label)} <span aria-hidden="true">→</span></button>`
const definition = (entries: [string, unknown][]) => `<dl>${entries.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value ?? '—')}</dd></div>`).join('')}</dl>`
function quotas(limit = 100, manage = false) {
  const quotaProfiles = rows(object(state?.quota).profiles)
  const accountProfiles = rows(object(state?.profiles).profiles)
  let ids = [...new Set([...accountProfiles, ...quotaProfiles].map(profile => text(profile.id)))].filter(Boolean)
  if (!ids.length) return empty('No accounts available', 'Check the service connection in Settings.')
  const profileOrder = Array.isArray(object(state?.profiles).profileOrder)
    ? (object(state?.profiles).profileOrder as string[])
    : undefined
  ids = sortProfilesByConfiguredOrder(ids, profileOrder)
  if (manage) {
    ids = sortProfilesForView(ids, accountSort, id => {
      const p = quotaProfiles.find(item => item.id === id) ?? {}
      const a = accountProfiles.find(item => item.id === id) ?? {}
      return computeProfileSpend(p, a).fraction
    })
  }
  ids = ids.slice(0, limit)
  const sortTabsHtml = manage && ids.length > 1 ? `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px">
      <span class="eyebrow">Accounts</span>
      <div class="sort-tabs" role="group" aria-label="Sort accounts">
        <button type="button" class="sort-tab ${accountSort === 'configured' ? 'active' : ''}" data-account-sort="configured" aria-pressed="${accountSort === 'configured'}">Configured</button>
        <button type="button" class="sort-tab ${accountSort === 'spent-desc' ? 'active' : ''}" data-account-sort="spent-desc" title="Closest to running out first" aria-pressed="${accountSort === 'spent-desc'}">Most used</button>
        <button type="button" class="sort-tab ${accountSort === 'spent-asc' ? 'active' : ''}" data-account-sort="spent-asc" title="Most capacity left first" aria-pressed="${accountSort === 'spent-asc'}">Least used</button>
      </div>
    </div>` : ''
  return `${sortTabsHtml}<div class="quota-list">${ids.map(id => {
    const profile = quotaProfiles.find(item => item.id === id) ?? {}
    const account = accountProfiles.find(item => item.id === id) ?? {}
    const active = object(state?.profiles).activeProfile === id
    const failureObj = profile.failure && typeof profile.failure === 'object' ? profile.failure as Record<string, unknown> : null
    const failureReason = failureObj ? text(failureObj.reason) : ''
    const hasWindows = rows(profile.windows).length > 0
    const stale = Boolean(profile.stale) || (number(profile.fetchedAt) && Date.now() - Number(profile.fetchedAt) > 90000)
    const needsLogin = account.loggedIn === false || profile.error === 'no_token' || failureReason === 'auth_failure'
    const reason = needsLogin
      ? 'Sign-in required for this account'
      : !hasWindows && profile.error
        ? 'Usage unavailable'
        : stale && hasWindows
          ? (failureReason === 'rate_limited' ? 'Usage cached (rate limited upstream)' : 'Usage cached (last successful read)')
          : stale
            ? 'Usage may be out of date'
            : ''
    const spentObj = profile.spent && typeof profile.spent === 'object' ? profile.spent as Record<string, unknown> : null
    const isSpent = Boolean(spentObj && (!spentObj.until || Number(spentObj.until) > Date.now()))
    const spentDiagnosis = spentObj?.diagnosis && typeof spentObj.diagnosis === 'object' ? spentObj.diagnosis as Record<string, unknown> : null
    const spentBucket = spentDiagnosis ? text(spentDiagnosis.bucket) : ''
    const spentBucketLabel = spentBucket ? (spentBucket === 'five_hour' ? '5h limit' : spentBucket.replace(/^seven_day/, '7d').replaceAll('_', ' ')) : 'rate limit'
    const spentUntil = spentObj ? number(spentObj.until) : undefined
    const spentUntilText = spentUntil ? (spentUntil > Date.now() ? `resets ${new Date(spentUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '') : ''
    const effectiveReason = isSpent
      ? `Refusing requests: account exhausted (${spentBucketLabel})${spentUntilText ? ` · ${spentUntilText}` : ''}`
      : reason
    const plan = text(account.subscriptionType)
    const cachedProvenance = text(account.authProvenance) === 'cached'
    const planTag = plan ? `<span class="plan-tag">${esc(plan.toUpperCase())}${cachedProvenance ? ' (cached)' : ''}</span>` : ''
    const allowance = text(account.allowance)
    const planLabel = text(account.planLabel)
    const rateLimitTier = text(account.rateLimitTier)
    const allowanceTitle = (planLabel || '') + (rateLimitTier ? ` · ${rateLimitTier}` : '')
    const allowanceTag = allowance ? `<span class="plan-chip" style="font-size:10px;padding:2px 6px;border-radius:6px;background:var(--surface2, rgba(255,255,255,0.08));color:var(--accent2, #58a6ff);margin-left:6px;font-weight:600;font-variant-numeric:tabular-nums;" title="${esc(allowanceTitle)}">${esc(allowance)}</span>` : ''
    const routesSummary = object(state?.routesSummary)
    const aliases = Array.isArray(account.aliases) ? (account.aliases as unknown[]).map(text).filter(Boolean) : []
    const aliasesTag = aliases.length > 0 ? `<small class="mono muted" style="margin-left:8px;font-size:10px" title="Also answers to: ${esc(aliases.join(', '))}">aka ${esc(aliases.join(', '))}</small>` : ""
    const profileTally = object(object(routesSummary.byProfile)[id])
    const servedCount = number(profileTally.served)
    const refusedCount = number(profileTally.refused)
    const tallyTag = (servedCount !== undefined && servedCount > 0) || (refusedCount !== undefined && refusedCount > 0)
      ? `<small class="mono muted" style="margin-left:8px;font-size:10px">${count(servedCount ?? 0)} served${refusedCount ? ` · <span class="status bad" style="font-size:9px;padding:1px 4px">${count(refusedCount)} refused</span>` : ''}</small>`
      : ''
    const spend = computeProfileSpend(profile, account)
    const spendClass = spend.state === 'fading' ? 'spend-fading' : spend.state === 'spent' && spend.reason !== 'unusable' ? 'spend-spent' : ''
    const spendStyle = spend.fade > 0 && spend.state === 'fading' ? ` style="--spend-fade:${spend.fade.toFixed(2)}"` : ''
    return `<article class="account ${active ? 'selected-account' : ''} ${spendClass}"${spendStyle}><div class="account-head"><div class="avatar">${esc(id.slice(0, 1).toUpperCase())}</div><div><strong>${esc(id)}</strong>${planTag}${allowanceTag}${tallyTag}${aliasesTag}${account.email ? `<small>${esc(account.email)}</small>` : ''}</div>${active ? (isSpent ? `<span class="status active">Active</span><span class="status bad" title="${esc(spentDiagnosis ? text(spentDiagnosis.rationale) : 'Account refusing')}">Refusing</span>` : '<span class="status active">Active</span>') : isSpent ? `<span class="status bad" title="${esc(spentDiagnosis ? text(spentDiagnosis.rationale) : 'Account refusing')}">Refusing</span>` : needsLogin ? '<span class="status bad">Needs login</span>' : ''}</div>${effectiveReason ? `<p class="account-warning ${isSpent ? 'account-refusing' : ''}" title="${esc(isSpent && spentDiagnosis ? text(spentDiagnosis.rationale) : profile.error || '')}">${esc(effectiveReason)}</p>` : ''}${rows(profile.windows).map(window => {
      const value = number(window.utilization)
      const clamped = Math.max(0, Math.min(1, value ?? 0))
      const reset = number(window.resetsAt)
      const resetText = reset ? (reset > Date.now() ? `Resets ${new Date(reset).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Awaiting reset update') : 'Reset time unavailable'
      return `<div class="quota"><div><span>${esc(text(window.type).replaceAll('_', ' '))}</span><strong>${pct(value)} used</strong></div>${value === undefined ? '' : `<progress class="${clamped >= .85 ? 'danger' : clamped >= .6 ? 'warning' : ''}" max="1" value="${clamped}" aria-label="${esc(window.type)} usage"></progress>`}<small>${esc(resetText)}</small></div>`
    }).join('') || (reason ? '' : '<p class="muted">No usage windows returned.</p>')}${manage ? `<div class="account-actions">${active ? '<span class="muted">Current profile</span>' : button('switch-profile', 'Use account', id, !state?.running)}${state?.preferences.mode === 'managed' ? button('login-profile', account.loggedIn ? 'Sign in again' : 'Sign in', id, !state.preferences.selected) : ''}</div>` : ''}</article>`
  }).join('')}</div>`
}
function matchingRequests() { return filterRequests(state?.requests, filter, requestKind) }
function accountRoutingCell(row: Record<string, unknown>) {
  const chain = Array.isArray(row.routeChain) ? (row.routeChain as Array<Record<string, unknown>>) : null
  const kind = text(row.routeKind)
  const badge = kind ? `<span class="route-kind-badge route-${esc(kind)}">${esc(kind)}</span>` : ''
  if (chain && chain.length > 1) {
    const chainHtml = chain.map(hop => {
      const ok = Boolean(hop.ok)
      const profile = esc(text(hop.profileId) || 'default')
      const refused = text(hop.refusedBucket)
      const title = esc([hop.error ? text(hop.error) : `status ${hop.status}`, refused].filter(Boolean).join(' · '))
      return `<span class="${ok ? 'status good' : 'status bad'}" style="padding:1px 4px;font-size:9px" title="${title}">${profile}${ok ? ' ✓' : ' ✗'}</span>`
    }).join('<span class="muted" style="font-size:9px"> → </span>')
    return `<div class="route-chain-wrap">${chainHtml}</div>${badge ? `<div>${badge}</div>` : ''}`
  }
  const refusedBucket = text(row.routeRefusedBucket)
  const refusedLabel = refusedBucket ? ` <span class="status bad" style="padding:1px 4px;font-size:9px" title="refused allowance">${esc(refusedBucket)}</span>` : ''
  return `<div><span>${esc(text(row.profileId) || '—')}</span>${refusedLabel}</div>${badge ? `<div>${badge}</div>` : ''}`
}
function requestTable(limit: number, filtered = false) {
  const records = (filtered ? matchingRequests() : rows(state?.requests).sort((a, b) => Number(b.timestamp) - Number(a.timestamp))).slice(0, limit)
  if (!records.length) return empty(filtered && (filter || requestKind !== 'all') ? 'No matching requests' : 'No requests recorded', filtered && (filter || requestKind !== 'all') ? 'Clear the filters to see all activity.' : '')
  return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Model / client</th><th>Account</th><th>Cache</th><th>First token</th><th>Total</th><th>Status</th></tr></thead><tbody>${records.map(row => `<tr><td class="muted mono" title="${esc(new Date(Number(row.timestamp)).toLocaleString())}">${time(row.timestamp)}<small>${number(row.timestamp) ? esc(new Date(Number(row.timestamp)).toLocaleDateString([], {month: 'short', day: 'numeric'})) : ''}</small></td><td><button class="request-link" data-request="${esc(row.requestId)}">${esc(row.model || 'Unknown model')}</button><small>${esc(row.adapter || row.requestSource || 'Unknown client')}</small></td><td>${accountRoutingCell(row)}</td><td class="mono">${pct(row.cacheHitRate)}</td><td class="mono">${duration(row.ttfbMs)}</td><td class="mono">${duration(row.totalDurationMs)}</td><td><span class="status ${Number(row.status) >= 400 ? 'bad' : Number(row.status) >= 200 && Number(row.status) < 400 ? 'good' : ''}">${esc(row.status || '—')}</span></td></tr>`).join('')}</tbody></table></div>`
}
function requestDetail() {
  const row = rows(state?.requests).find(item => item.requestId === selectedRequest)
  if (!row) return ''
  const chain = Array.isArray(row.routeChain) ? (row.routeChain as Array<Record<string, unknown>>) : null
  const chainText = chain && chain.length > 1 ? chain.map(h => `${text(h.profileId) || 'default'} (${h.ok ? '✓' : text(h.refusedBucket) || h.status || '✗'})`).join(' → ') : undefined
  return `<section class="request-detail" aria-label="Request details"><div class="section-heading"><div><h2>${esc(row.model)} <span class="status ${Number(row.status) >= 400 ? 'bad' : 'good'}">${esc(row.status)}</span></h2><p>${esc(new Date(Number(row.timestamp)).toLocaleString())}</p></div><button id="close-detail">Close details</button></div>${row.error ? `<p class="error-message">${esc(row.error)}</p>` : ''}<div class="detail-grid">${definition([['Account', row.profileId], ['Client', row.adapter], ['Routing', row.routeKind || 'direct'], ...(chainText ? [['Failover chain', chainText] as [string, unknown]] : []), ...(row.routeRefusedBucket ? [['Refused on', row.routeRefusedBucket] as [string, unknown]] : []), ['Conversation', row.lineageType], ['Mode', row.mode]])}${definition([['Queue wait', duration(row.queueWaitMs)], ['Proxy processing', duration(row.proxyOverheadMs)], ['First token', duration(row.ttfbMs)], ['Total', duration(row.totalDurationMs)]])}${definition([['Uncached input', count(row.inputTokens)], ['Cache read', count(row.cacheReadInputTokens)], ['Cache write', count(row.cacheCreationInputTokens)], ['Output tokens', count(row.outputTokens)]])}</div><div class="request-identifiers"><span>Request</span><code>${esc(row.requestId)}</code>${row.sdkSessionId ? `<span>SDK session</span><code>${esc(row.sdkSessionId)}</code>` : ''}</div>${Array.isArray(row.envelopeViolations) && row.envelopeViolations.length ? `<p class="error-message">Response integrity: ${esc(row.envelopeViolations.join(', '))}</p>` : ''}</section>`
}
function logContent() {
  const matches = (value: string) => value.toLowerCase().includes(logFilter.toLowerCase())
  if (logSource === 'incidents') {
    const incidents = (state?.incidents ?? []).filter(item => matches(`${item.title} ${item.detail} ${item.severity}`))
    return incidents.map(item => `<div class="incident"><span class="status ${item.severity === 'error' ? 'bad' : ''}">${esc(item.severity)}</span><div><strong>${esc(item.title)}</strong><p>${esc(item.detail)}</p></div><small>${time(item.timestamp)}</small></div>`).join('') || empty(logFilter ? 'No matching alerts' : 'No new alerts')
  }
  if (logSource === 'output') {
    const lines = (state?.serviceLog ?? []).filter(matches)
    return lines.length ? `<pre class="service-output">${esc(lines.join('\n'))}</pre>` : empty(logFilter ? 'No matching output' : 'No app-managed output')
  }
  const logs = filterLogs(state?.logs, logFilter)
  return logs.length ? `<div class="log-view">${logs.map(log => `<div><time>${time(log.timestamp)}</time><span class="log-kind">${esc(log.category || log.level || 'event')}</span><span>${esc(log.message || JSON.stringify(log))}</span></div>`).join('')}</div>` : empty(logFilter ? 'No matching events' : 'No diagnostic events')
}
function activity() {
  const requests = rows(state?.requests).sort((a, b) => Number(a.timestamp) - Number(b.timestamp)).slice(-48)
  if (!requests.length) return empty('No cache history')
  return `<svg class="cache-chart" viewBox="0 0 480 120" preserveAspectRatio="none" role="img" aria-label="Cache reuse for the most recent requests">${requests.map((row, index) => {
    const width = 480 / requests.length
    const height = Math.max(1, Math.min(1, number(row.cacheHitRate) ?? 0) * 112)
    return `<rect class="cache-track" x="${index * width}" y="8" width="${width - 3}" height="112" rx="2"/><rect class="cache-bar" x="${index * width}" y="${120 - height}" width="${width - 3}" height="${height}" rx="2"><title>${esc(row.requestId)} · ${pct(row.cacheHitRate)} cache reuse</title></rect>`
  }).join('')}</svg><div class="chart-caption"><span>Earlier requests</span><span>Latest · ${requests.length} requests</span></div>`
}
function renderContent() {
  renderedKey = contentKey()
  const current = state
  if (!current) { el('content').innerHTML = empty('Connecting to Meridian', 'Reading service health and telemetry…'); return }
  const health = object(current.health)
  let html = ''
  const managed = current.preferences.mode === 'managed'
  const endpoint = managed ? `http://127.0.0.1:${current.preferences.port}` : current.preferences.endpoint
  if (page === 'Overview') {
    html = `<div class="overview-status"><div><strong>${current.running ? `Meridian ${esc(current.running)}` : managed ? 'Meridian is stopped' : current.lastChecked ? 'Not connected' : 'Connecting…'}</strong><span class="status ${health.status === 'healthy' ? 'good' : ''}">${esc(health.status || 'Offline')}</span><small class="mono">${esc(endpoint)}</small></div><div class="button-group">${managed && !current.owned ? (current.preferences.selected ? button('start', 'Start Meridian') : go('Versions', 'Install Meridian')) : go('Service', 'Service')}${go('Usage & accounts', 'Accounts')}</div></div>${stats()}${current.incidents.length ? `<div class="attention-row"><div><strong>${current.incidents.length} new alert${current.incidents.length === 1 ? '' : 's'}</strong><p>${esc(current.incidents[current.incidents.length - 1]?.title)}</p></div>${go('Logs', 'Review alerts')}</div>` : ''}<div class="overview-grid">${section('Cache reuse', 'Last 48 requests', activity())}${section('Connection', '', definition([['Managed by', managed ? 'Meridian Desktop' : 'External service'], ['Active account', object(current.profiles).activeProfile], ['Accounts', rows(object(current.profiles).profiles).length]]))}</div>${section('Usage limits', '', quotas(2))}<div class="section-heading"><h2>Recent requests</h2>${go('Requests', 'View all')}</div>${requestTable(5)}`
  } else if (page === 'Usage & accounts') {
    html = quotas(100, true)
    if (managed) html += section('Add account', '', `<form id="profile-form" class="inline-form"><label>Profile name<input name="profile" placeholder="e.g. work" pattern="[a-zA-Z0-9_-]{1,64}" required></label><button name="operation" value="add-profile" type="submit" ${!current.preferences.selected || current.busy ? 'disabled' : ''}>Add account</button></form>${!current.preferences.selected ? go('Versions', 'Install Meridian to sign in') : ''}`)
    else html += `<p class="page-note">Sign in through the CLI that manages this service.</p>`
  } else if (page === 'Requests') {
    html = `<div class="filter-bar"><input id="filter" type="search" placeholder="Search model, account, client or ID" aria-label="Search requests" value="${esc(filter)}"><select id="request-kind" aria-label="Request filter"><option value="all" ${requestKind === 'all' ? 'selected' : ''}>All requests</option><option value="errors" ${requestKind === 'errors' ? 'selected' : ''}>Errors</option><option value="low-cache" ${requestKind === 'low-cache' ? 'selected' : ''}>Low-cache continuations</option></select><button id="clear-filters">Clear</button></div><div id="request-detail">${requestDetail()}</div><div class="result-count" id="request-count">${matchingRequests().length} of ${rows(current.requests).length} requests</div><div id="results">${requestTable(500, true)}</div>`
  } else if (page === 'Logs') {
    html = `<div class="tab-bar" aria-label="Log source">${[['incidents', 'Alerts', current.incidents.length], ['diagnostics', 'Diagnostics', rows(current.logs).length], ['output', 'Service output', current.serviceLog.length]].map(([value, label, total]) => `<button data-log-source="${value}" aria-pressed="${logSource === value}">${label}<span>${total}</span></button>`).join('')}</div><div class="filter-bar"><input id="log-filter" type="search" aria-label="Search logs" placeholder="Search ${logSource === 'incidents' ? 'alerts' : logSource === 'output' ? 'service output' : 'diagnostics'}" value="${esc(logFilter)}">${logSource === 'incidents' && current.incidents.length ? button('acknowledge', 'Dismiss all alerts') : ''}${button('export-diagnostics', 'Export summary')}</div><div id="log-results">${logContent()}</div>`
  } else if (page === 'Service') {
    html = section('Process', '', `<div class="process-panel"><div class="setting-row"><div><strong>${current.owned ? 'Running' : managed ? 'Stopped' : current.running ? 'Connected' : 'Disconnected'}</strong><p class="mono">${esc(endpoint)}</p></div><span class="status ${current.owned ? 'good' : ''}">${managed ? 'App managed' : 'External'}</span></div>${managed ? `<div class="button-group process-actions">${current.owned ? button('restart', 'Restart') + button('stop', 'Stop') : current.preferences.selected ? button('start', 'Start Meridian') : go('Versions', 'Install Meridian')}</div>` : ''}${definition(managed ? [['Selected version', current.preferences.selected || 'None installed'], ['Crash recovery', '3 restart attempts'], ['Close window', 'Keep running'], ['Quit app', 'Finish active requests, then stop']] : [['Version', current.running], ['Lifecycle', 'Controlled by your service manager']])}</div>`)
    if (current.migration) html += section('Service ownership', '', `<div class="setting-row"><div><strong>${esc(current.migration.label)}</strong><p>${current.migration.adopted ? 'Original supervisor paused' : 'Compatible macOS LaunchAgent'}</p></div>${current.migration.adopted ? button('return-headless', 'Return to headless') : button('take-ownership', 'Manage this service', current.migration.label, !current.migration.canAdopt)}</div>`)
    html += section('Management', '', `<form id="service-form"><label>Run Meridian<select name="mode" ${current.owned ? 'disabled' : ''}><option value="attached" ${!managed ? 'selected' : ''}>Connect to existing service</option><option value="managed" ${managed ? 'selected' : ''}>Manage with this app</option></select></label><label>App-managed port<input name="port" type="number" min="1024" max="65535" value="${current.preferences.port}" required ${current.owned ? 'disabled' : ''}></label><button type="submit" ${current.owned || current.busy ? 'disabled' : ''}>Save</button>${current.owned ? '<p class="page-note">Stop Meridian before changing its mode or port.</p>' : ''}</form><details class="help-detail"><summary>Use an existing installation</summary><p>Connect in Settings to keep its current service manager. To use app management on the same port, stop the existing supervisor first. Compatible macOS LaunchAgents can transfer ownership here. Docker and Nix remain managed externally.</p></details>`)
  } else if (page === 'Versions') {
    html = `<div class="version-summary">${definition([['Running', current.running || 'Stopped'], ['Selected for app', current.preferences.selected || 'None'], ['Previous version', current.preferences.previous || 'None']])}</div>`
    html += section('Releases', '', `<div class="setting-row"><div><strong>${current.latest ? `Latest · ${esc(current.latest)}` : 'Available on npm'}</strong>${!managed ? '<p>Installs a separate app-managed copy.</p>' : ''}</div>${button('check-updates', 'Check for updates')}</div>${current.available.length ? `<form id="install-form" class="inline-form"><label>Version<select name="version">${current.available.map(release => `<option value="${esc(release)}">${esc(release)}${release === current.latest ? ' · Latest' : ''}${current.installed.includes(release) ? ' · Installed' : ''}</option>`).join('')}</select></label><button type="submit" ${current.busy ? 'disabled' : ''}>Install</button></form>` : ''}`)
    html += section('Installed versions', '', current.installed.length ? current.installed.map(release => `<div class="setting-row"><div><strong class="mono">${esc(release)}</strong>${release === current.preferences.previous && release !== current.preferences.selected ? '<small>Previous</small>' : ''}</div>${button('release-notes', 'Release notes', release)}${release === current.preferences.selected ? '<span class="status active">Selected</span>' : button('activate', release === current.preferences.previous ? 'Roll back' : 'Use version', release, !managed)}</div>`).join('') + (!managed ? `<p class="page-note">${go('Service', 'Enable app management to switch versions')}</p>` : '') : empty('No installed versions', 'Check for updates to choose a release.'))
  } else if (page === 'Plugins') {
    const plugins = rows(object(current.plugins).plugins)
    html = `<div class="section-heading"><span class="muted">${plugins.filter(plugin => plugin.status === 'active').length} active · ${plugins.length} loaded</span>${button('reload-plugins', 'Reload plugins', '', !current.running)}</div>${plugins.length ? `<div class="plugin-list">${plugins.map(plugin => `<article class="plugin-row"><div class="plugin-heading"><h2>${esc(plugin.name)}</h2><code>${esc(plugin.version || '')}</code><span class="status ${plugin.status === 'active' ? 'good' : 'bad'}">${esc(plugin.status)}</span></div>${plugin.error ? `<p class="error-message">${esc(plugin.error)}</p>` : ''}${plugin.description ? `<p>${esc(plugin.description)}</p>` : ''}</article>`).join('')}</div>` : empty('No plugins loaded', managed ? '' : 'Install plugins in the connected service, then reload.')}`
    html += section('Install plugins', managed ? 'Shared with local headless installations using the same plugin configuration.' : 'External services manage their own plugin files.', `<div class="section-heading"><span class="muted">Published by rynfar</span>${button('check-plugins', 'Check for updates')}</div>${(current.catalog ?? []).map(plugin => {
      const loaded = plugins.find(item => item.name === plugin.id)
      const latest = plugin.latest
      const upToDate = Boolean(latest && (plugin.installed === latest || loaded?.version === latest && loaded?.status === 'active'))
      return `<div class="setting-row"><div><strong>${esc(plugin.title)} scrub</strong><small class="mono">${esc(plugin.package)}</small><p>${plugin.installed ? `Installed ${esc(plugin.installed)}${loaded?.status === 'active' ? ' · Active' : ' · Loads on next start'}` : loaded?.version ? `Loaded ${esc(loaded.version)}` : 'Not installed'}${latest ? ` · Latest ${esc(latest)}` : ''}</p></div>${button('install-plugin', upToDate ? 'Up to date' : loaded || plugin.installed ? 'Update' : 'Install', plugin.id, !managed || upToDate)}</div>`
    }).join('')}${!managed ? go('Service', 'Manage a local installation') : ''}`)
  } else {
    html = section('Connection', '', `<form id="connection-form"><label>Meridian address<input name="endpoint" type="url" required value="${esc(current.preferences.endpoint)}" spellcheck="false" ${current.owned ? 'disabled' : ''}></label><label>API key <span class="muted">${current.hasApiKey ? '· saved' : '· optional'}</span><input name="apiKey" type="password" autocomplete="off" placeholder="${current.hasApiKey ? 'Leave blank to keep saved key' : 'API key'}" ${current.owned ? 'disabled' : ''}></label><button type="submit" ${current.owned || current.busy ? 'disabled' : ''}>Connect</button>${current.owned ? '<p class="page-note">Stop the managed service before changing connections.</p>' : ''}</form>`)
    html += section('Background', '', `<form id="preferences-form"><label class="check"><input name="autoStart" type="checkbox" ${current.preferences.autoStart ? 'checked' : ''}> Start managed Meridian when the app opens</label><label class="check"><input name="openWindowAtLaunch" type="checkbox" ${current.preferences.openWindowAtLaunch ? 'checked' : ''}> Open dashboard at launch</label><label class="check"><input name="notifications" type="checkbox" ${current.preferences.notifications ? 'checked' : ''}> Desktop notifications</label>${([ ['notificationCritical', 'Service recovery failed'], ['notificationRequests', 'Repeated request failures'], ['notificationCache', 'Repeated cache misses'], ['notificationQuota', 'Usage reaches 95%'] ] as const).map(([key, label]) => `<label class="check"><input name="${key}" type="checkbox" ${current.preferences[key] ? 'checked' : ''}> ${label}</label>`).join('')}<p class="muted">Critical alerts: at most once every 15 minutes. Optional alerts: once per category every 30 minutes. Alerts always remain in Logs.</p><button type="submit">Save</button></form><div class="setting-row"><div><strong>Notifications</strong>${current.notificationStatus ? `<p>${esc(current.notificationStatus)}</p>` : ''}</div>${button('toggle-snooze', current.preferences.quietUntil > Date.now() ? 'Resume alerts' : 'Pause for 1 hour')}${button('test-notification', 'Send test')}</div><div class="setting-row"><div><strong>Open at login</strong><p>${current.loginAtStartup ? 'On' : 'Off'}</p></div>${button('login-at-startup', current.loginAtStartup ? 'Turn off' : 'Turn on', current.loginAtStartup ? 'false' : 'true', current.platform !== 'darwin')}</div>`)
    const adapters = Object.entries(object(current.features)).filter(([, features]) => Object.values(object(features)).some(value => typeof value === 'boolean'))
    html += section('Client settings', 'Changes apply to subsequent requests.', adapters.map(([adapter, features]) => `<details data-detail="${esc(adapter)}"><summary>${esc(adapter)}</summary><form class="features-form" data-adapter="${esc(adapter)}">${Object.entries(object(features)).filter(([, value]) => typeof value === 'boolean').map(([key, value]) => `<label class="check"><input type="checkbox" name="${esc(key)}" ${value ? 'checked' : ''}> ${esc(key.replace(/([A-Z])/g, ' $1').replace(/^./, char => char.toUpperCase()))}</label>`).join('')}<button type="submit">Save</button></form></details>`).join('') || empty('Client settings unavailable'))
    html += section('About', '', definition([['Meridian Desktop', `${current.desktopVersion} · Preview`], ['Appearance', current.glass], ['Platform', current.platform === 'darwin' ? 'macOS' : current.platform]]) + `<div class="setting-row"><div><strong>Diagnostic summary</strong><p>Counts and timings. Excludes prompts and logs.</p></div>${button('export-diagnostics', 'Export')}</div>`)
  }
  if (current.login) html = `<section class="login-panel"><h2>Sign in to Claude</h2><p>Sign in in your browser, then paste the authorization code below.</p><details class="help-detail"><summary>Sign-in details</summary><pre class="service-output">${esc(current.login.output)}</pre></details>${button('open-login', 'Open Claude sign-in', '', !current.login.url)}<form id="login-form"><label>Authorization code<input name="code" autocomplete="off" required></label><button type="submit">Complete sign-in</button></form>${button('login-code', 'Cancel sign-in', 'cancel')}</section>` + html
  const drafts = new Map<string, {value: string; checked: boolean}>()
  el('content').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]').forEach(field => {
    const key = (field.form?.id || field.form?.dataset.adapter || '') + ':' + field.name
    drafts.set(key, {value: field.value, checked: field instanceof HTMLInputElement && field.checked})
  })
  const openDetails = [...el('content').querySelectorAll<HTMLDetailsElement>('details[open][data-detail]')].map(item => item.dataset.detail)
  el('content').innerHTML = html
  el('content').querySelectorAll<HTMLDetailsElement>('details[data-detail]').forEach(item => { item.open = openDetails.includes(item.dataset.detail) })
  el('content').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]').forEach(field => {
    const key = (field.form?.id || field.form?.dataset.adapter || '') + ':' + field.name
    const draft = drafts.get(key)
    if (draft) { field.value = draft.value; if (field instanceof HTMLInputElement) field.checked = draft.checked }
  })
  document.getElementById('check-updates')?.addEventListener('click', () => { void action('check-updates') })
  const refreshRequests = () => { el('results').innerHTML = requestTable(500, true); el('request-count').textContent = `${matchingRequests().length} of ${rows(state?.requests).length} requests` }
  const search = document.getElementById('filter')
  if (search instanceof HTMLInputElement) search.oninput = () => { filter = search.value; refreshRequests() }
  const kind = document.getElementById('request-kind')
  if (kind instanceof HTMLSelectElement) kind.onchange = () => { requestKind = kind.value; refreshRequests() }
  const clear = document.getElementById('clear-filters')
  if (clear) clear.onclick = () => { filter = ''; requestKind = 'all'; if (search instanceof HTMLInputElement) search.value = ''; if (kind instanceof HTMLSelectElement) kind.value = 'all'; refreshRequests() }
  const logSearch = document.getElementById('log-filter')
  if (logSearch instanceof HTMLInputElement) logSearch.oninput = () => { logFilter = logSearch.value; el('log-results').innerHTML = logContent() }
  el('content').onclick = event => {
    if (!(event.target instanceof Element)) return
    const target = event.target.closest<HTMLButtonElement>('button')
    if (!target) return
    if (target.dataset.go) { const next = pages.find(name => name === target.dataset.go); if (next) navigate(next) }
    if (target.dataset.accountSort) { accountSort = target.dataset.accountSort as any; renderContent() }
    if (target.dataset.request) { const id = target.dataset.request; if (page !== 'Requests') navigate('Requests'); selectedRequest = id; el('request-detail').innerHTML = requestDetail(); el('request-detail').scrollIntoView({block:'nearest'}) }
    if (target.id === 'close-detail') { selectedRequest = ''; el('request-detail').replaceChildren() }
    if (target.dataset.logSource) { logSource = target.dataset.logSource; renderContent() }
  }
  el('content').querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(control => control.onclick = () => {
    const name = control.dataset.action as Action
    const value = name === 'login-at-startup' ? control.dataset.value === 'true' : control.dataset.value
    void action(name, value)
  })
  const bindForm = (id: string, handler: (data: FormData, event: SubmitEvent) => void) => {
    const form = document.getElementById(id)
    if (form instanceof HTMLFormElement) form.onsubmit = event => { event.preventDefault(); handler(new FormData(form), event) }
  }
  bindForm('service-form', data => { void action('save-preferences', { mode: data.get('mode'), port: Number(data.get('port')) }) })
  bindForm('install-form', data => { void action('install', data.get('version')) })
  bindForm('preferences-form', data => { void action('save-preferences', Object.fromEntries(['autoStart', 'notifications', 'openWindowAtLaunch', 'notificationCritical', 'notificationRequests', 'notificationCache', 'notificationQuota'].map(key => [key, data.has(key)]))) })
  bindForm('login-form', data => { void action('login-code', data.get('code')) })
  bindForm('profile-form', (data, event) => { const operation = event.submitter instanceof HTMLButtonElement && event.submitter.value === 'login-profile' ? 'login-profile' : 'add-profile'; void action(operation, data.get('profile')) })
  el('content').querySelectorAll<HTMLFormElement>('.features-form').forEach(form => form.onsubmit = event => {
    event.preventDefault()
    const fields = [...form.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    void action('set-features', { adapter: form.dataset.adapter, features: Object.fromEntries(fields.map(field => [field.name, field.checked])) })
  })
  const form = document.getElementById('connection-form')
  if (form instanceof HTMLFormElement) form.onsubmit = event => {
    event.preventDefault(); const data = new FormData(form); const key = String(data.get('apiKey') || '')
    void action('save-preferences', { mode: 'attached', endpoint: data.get('endpoint'), ...(key ? { apiKey: key } : {}) })
  }
}
el('refresh').onclick = () => { void action('refresh') }
renderNav(); renderContent()
window.meridian.subscribe(update)
void window.meridian.state().then(update).catch(error => { el('notice').textContent = String(error) })
