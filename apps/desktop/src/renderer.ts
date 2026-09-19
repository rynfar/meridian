import { object, rows, text, number } from './core'
import { filterLogs, filterRequests } from './uiData'
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
  return `<div class="stats">${[
    ['Requests', count(summary.totalRequests), windowLabel],
    ['Cache reuse', populated ? pct(tokens.avgCacheHitRate) : '—', 'Mean input cache hit'],
    ['First token', populated ? duration(object(summary.ttfb).p50) : '—', 'Median · SDK to first token'],
    ['Errors', count(summary.errorCount), 'HTTP errors'],
  ].map(([label, value, note]) => `<div><span class="eyebrow">${label}</span><strong>${value}</strong><small>${note}</small></div>`).join('')}</div>`
}
const go = (target: Page, label: string) => `<button class="text-button" data-go="${esc(target)}">${esc(label)} <span aria-hidden="true">→</span></button>`
const definition = (entries: [string, unknown][]) => `<dl>${entries.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value ?? '—')}</dd></div>`).join('')}</dl>`
function quotas(limit = 100, manage = false) {
  const quotaProfiles = rows(object(state?.quota).profiles)
  const accountProfiles = rows(object(state?.profiles).profiles)
  const ids = [...new Set([...accountProfiles, ...quotaProfiles].map(profile => text(profile.id)))].filter(Boolean).slice(0, limit)
  if (!ids.length) return empty('No accounts available', 'Check the service connection in Settings.')
  return `<div class="quota-list">${ids.map(id => {
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
    const plan = text(account.subscriptionType)
    const cachedProvenance = text(account.authProvenance) === 'cached'
    const planTag = plan ? `<span class="plan-tag">${esc(plan.toUpperCase())}${cachedProvenance ? ' (cached)' : ''}</span>` : ''
    return `<article class="account ${active ? 'selected-account' : ''}"><div class="account-head"><div class="avatar">${esc(id.slice(0, 1).toUpperCase())}</div><div><strong>${esc(id)}</strong>${planTag}${account.email ? `<small>${esc(account.email)}</small>` : ''}</div>${active ? '<span class="status active">Active</span>' : needsLogin ? '<span class="status bad">Needs login</span>' : ''}</div>${reason ? `<p class="account-warning" title="${esc(profile.error || '')}">${esc(reason)}</p>` : ''}${rows(profile.windows).map(window => {
      const value = number(window.utilization)
      const clamped = Math.max(0, Math.min(1, value ?? 0))
      const reset = number(window.resetsAt)
      const resetText = reset ? (reset > Date.now() ? `Resets ${new Date(reset).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Awaiting reset update') : 'Reset time unavailable'
      return `<div class="quota"><div><span>${esc(text(window.type).replaceAll('_', ' '))}</span><strong>${pct(value)} used</strong></div>${value === undefined ? '' : `<progress class="${clamped >= .85 ? 'danger' : clamped >= .6 ? 'warning' : ''}" max="1" value="${clamped}" aria-label="${esc(window.type)} usage"></progress>`}<small>${esc(resetText)}</small></div>`
    }).join('') || (reason ? '' : '<p class="muted">No usage windows returned.</p>')}${manage ? `<div class="account-actions">${active ? '<span class="muted">Current profile</span>' : button('switch-profile', 'Use account', id, !state?.running)}${state?.preferences.mode === 'managed' ? button('login-profile', account.loggedIn ? 'Sign in again' : 'Sign in', id, !state.preferences.selected) : ''}</div>` : ''}</article>`
  }).join('')}</div>`
}
function matchingRequests() { return filterRequests(state?.requests, filter, requestKind) }
function requestTable(limit: number, filtered = false) {
  const records = (filtered ? matchingRequests() : rows(state?.requests).sort((a, b) => Number(b.timestamp) - Number(a.timestamp))).slice(0, limit)
  if (!records.length) return empty(filtered && (filter || requestKind !== 'all') ? 'No matching requests' : 'No requests recorded', filtered && (filter || requestKind !== 'all') ? 'Clear the filters to see all activity.' : '')
  return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Model / client</th><th>Account</th><th>Cache</th><th>First token</th><th>Total</th><th>Status</th></tr></thead><tbody>${records.map(row => `<tr><td class="muted mono" title="${esc(new Date(Number(row.timestamp)).toLocaleString())}">${time(row.timestamp)}<small>${number(row.timestamp) ? esc(new Date(Number(row.timestamp)).toLocaleDateString([], {month: 'short', day: 'numeric'})) : ''}</small></td><td><button class="request-link" data-request="${esc(row.requestId)}">${esc(row.model || 'Unknown model')}</button><small>${esc(row.adapter || row.requestSource || 'Unknown client')}</small></td><td>${esc(row.profileId || '—')}</td><td class="mono">${pct(row.cacheHitRate)}</td><td class="mono">${duration(row.ttfbMs)}</td><td class="mono">${duration(row.totalDurationMs)}</td><td><span class="status ${Number(row.status) >= 400 ? 'bad' : Number(row.status) >= 200 && Number(row.status) < 400 ? 'good' : ''}">${esc(row.status || '—')}</span></td></tr>`).join('')}</tbody></table></div>`
}
function requestDetail() {
  const row = rows(state?.requests).find(item => item.requestId === selectedRequest)
  if (!row) return ''
  return `<section class="request-detail" aria-label="Request details"><div class="section-heading"><div><h2>${esc(row.model)} <span class="status ${Number(row.status) >= 400 ? 'bad' : 'good'}">${esc(row.status)}</span></h2><p>${esc(new Date(Number(row.timestamp)).toLocaleString())}</p></div><button id="close-detail">Close details</button></div>${row.error ? `<p class="error-message">${esc(row.error)}</p>` : ''}<div class="detail-grid">${definition([['Account', row.profileId], ['Client', row.adapter], ['Conversation', row.lineageType], ['Mode', row.mode]])}${definition([['Queue wait', duration(row.queueWaitMs)], ['Proxy processing', duration(row.proxyOverheadMs)], ['First token', duration(row.ttfbMs)], ['Total', duration(row.totalDurationMs)]])}${definition([['Uncached input', count(row.inputTokens)], ['Cache read', count(row.cacheReadInputTokens)], ['Cache write', count(row.cacheCreationInputTokens)], ['Output tokens', count(row.outputTokens)]])}</div><div class="request-identifiers"><span>Request</span><code>${esc(row.requestId)}</code>${row.sdkSessionId ? `<span>SDK session</span><code>${esc(row.sdkSessionId)}</code>` : ''}</div>${Array.isArray(row.envelopeViolations) && row.envelopeViolations.length ? `<p class="error-message">Response integrity: ${esc(row.envelopeViolations.join(', '))}</p>` : ''}</section>`
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
