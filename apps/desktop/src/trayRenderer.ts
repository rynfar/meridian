import { number, object, rows, text } from './core'
import { sortProfilesByConfiguredOrder } from './uiData'
import type { Action, DesktopState } from './contracts'
const root = document.getElementById('panel')!
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const pct = (value: unknown) => number(value) === undefined ? '—' : `${Math.round(Number(value) * 100)}%`
let pending = false
let error = ''
let rendered = ''
let current: DesktopState | undefined
let focusedKey: string | undefined
function render(state: DesktopState) {
  current = state
  const focus = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.key : undefined
  if (focus) focusedKey = focus
  const scroll = root.querySelector('.accounts')?.scrollTop ?? 0
  document.documentElement.classList.toggle('native-glass', state.glass === 'Native Liquid Glass')
  const summary = object(state.summary), tokens = object(summary.tokenUsage), health = object(state.health)
  const active = text(object(state.profiles).activeProfile)
  const follow = object(state.profiles).follow as Record<string, unknown> | undefined
  const profiles = rows(object(state.profiles).profiles)
  const quotas = rows(object(state.quota).profiles)
  const rawIds = [...new Set([...profiles, ...quotas].map(profile => text(profile.id)))].filter(Boolean)
  const profileOrder = Array.isArray(object(state.profiles).profileOrder)
    ? (object(state.profiles).profileOrder as string[])
    : undefined
  const orderedIds = sortProfilesByConfiguredOrder(rawIds, profileOrder)
  const ids = profileOrder && profileOrder.length > 0
    ? orderedIds
    : orderedIds.sort((a, b) => a === active ? -1 : b === active ? 1 : a.localeCompare(b))
  const busy = Boolean(state.busy) || pending
  const button = (action: Action, label: string, value = '', disabled = false) => `<button data-action="${action}" data-value="${esc(value)}" data-key="${action}:${esc(value)}" ${disabled || busy ? 'disabled' : ''}>${label}</button>`
  const populated = (number(summary.totalRequests) ?? 0) > 0
  const latency = number(object(summary.ttfb).p50)
  const status = state.running ? health.status === 'healthy' ? 'Connected' : 'Needs attention' : state.preferences.mode === 'managed' ? 'Stopped' : 'Disconnected'
  const stopped = !state.running && state.preferences.mode === 'managed' && !state.busy
  const issue = state.error || (stopped ? '' : !state.running && state.preferences.mode === 'attached' ? 'Cannot reach the external service.' : state.dataErrors.length ? 'Some live data is unavailable.' : '')
  const html = `<header><div><strong>Meridian</strong><small><span class="dot ${state.running ? health.status === 'healthy' ? 'good' : 'warn' : ''}"></span>${status} · ${state.owned || state.preferences.mode === 'managed' ? 'App managed' : 'External'}</small></div>${button('open-desktop', 'Open dashboard')}</header>
    <section class="metrics" aria-label="Telemetry summary"><div class="hero"><small>Cache reuse</small><strong>${populated ? pct(tokens.avgCacheHitRate) : '—'}</strong></div><div><small>Requests</small><strong>${number(summary.totalRequests)?.toLocaleString() ?? '—'}</strong></div><div><small>First token</small><strong>${populated && latency !== undefined ? `${(latency / 1000).toFixed(1)}s` : '—'}</strong></div></section>
    <small>${number(summary.windowMs) ? `Last ${Math.round(Number(summary.windowMs) / 60000)} minutes` : 'Current telemetry window'} · ${number(summary.errorCount) ?? '—'} errors</small>
    ${issue ? `<div class="notice">${esc(issue)}</div>` : ''}${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
    <h2>Accounts <span class="limits-caption">Limits used</span></h2><div class="accounts">${ids.map(id => {
      const quota = quotas.find(profile => profile.id === id) ?? {}
      const account = rows(object(state?.profiles).profiles).find(profile => profile.id === id) ?? {}
      const fetched = number(quota.fetchedAt)
      const failureObj = quota.failure && typeof quota.failure === 'object' ? quota.failure as Record<string, unknown> : null
      const failureReason = failureObj ? text(failureObj.reason) : ''
      const windows = rows(quota.windows)
      const isStale = Boolean(quota.stale) || (!fetched || Date.now() - fetched > 90_000)
      const needsLogin = account.loggedIn === false || quota.error === 'no_token' || failureReason === 'auth_failure'
      const unavailable = needsLogin || (!windows.length && (quota.error || !fetched))
      const label = (type: unknown) => text(type).replace(/^five_hour$/, '5h').replace(/^seven_day/, '7d').replaceAll('_', ' ')
      const nextReset = windows.filter(window => (number(window.resetsAt) ?? 0) > Date.now()).sort((a, b) => Number(a.resetsAt) - Number(b.resetsAt))[0]
      const plan = text(account.subscriptionType)
      const allowance = text(account.allowance)
      const planLabel = text(account.planLabel)
      const rateLimitTier = text(account.rateLimitTier)
      const allowanceTitle = (planLabel || '') + (rateLimitTier ? ` · ${rateLimitTier}` : '')
      const allowanceTag = allowance ? `<span class="tray-plan" style="color:var(--accent2, #58a6ff);" title="${esc(allowanceTitle)}">${esc(allowance)}</span>` : ''
      const planTag = plan ? `<span class="tray-plan">${esc(plan.toUpperCase())}</span>` : ''
      const org = text(account.organizationName)
      const orgTag = org ? `<span class="tray-plan" style="color:var(--muted);font-size:10px;" title="Organization: ${esc(org)}">${esc(org)}</span>` : ''
      const nameTitle = org ? `${id} (${org})` : id
      const spentObj = quota.spent && typeof quota.spent === 'object' ? quota.spent as Record<string, unknown> : null
      const isSpent = Boolean(spentObj && (!spentObj.until || Number(spentObj.until) > Date.now()))
      const spentDiagnosis = spentObj?.diagnosis && typeof spentObj.diagnosis === 'object' ? spentObj.diagnosis as Record<string, unknown> : null
      const spentBucket = spentDiagnosis ? text(spentDiagnosis.bucket) : ''
      const spentBucketLabel = spentBucket ? (spentBucket === 'five_hour' ? '5h' : spentBucket.replace(/^seven_day/, '7d').replaceAll('_', ' ')) : 'limit'
      const spentBadge = isSpent ? `<span class="needs-login-label" style="background:#ef4444;color:white;" title="${esc(spentDiagnosis ? text(spentDiagnosis.rationale) : 'Refusing')}">Refusing (${esc(spentBucketLabel)})</span>` : ''
      return `<article class="account ${active === id ? 'active' : ''}"><div class="line"><strong class="account-name" title="${esc(nameTitle)}">${esc(id)}</strong>${planTag}${allowanceTag}${orgTag}${active === id ? `<span class="active-label">${follow ? `Following ${esc(text(follow.url))}` : 'Active'}</span>${spentBadge ? ` ${spentBadge}` : ''}` : isSpent ? spentBadge : needsLogin ? '<span class="needs-login-label">Needs login</span>' : follow ? `<span class="tray-plan" title="Switching controlled by ${esc(text(follow.url))}">Followed</span>` : button('switch-profile', 'Use account', id, !state.running)}</div>${needsLogin ? '<p>Sign-in required</p>' : unavailable ? '<p>Usage unavailable</p>' : `<div class="account-limits">${windows.map(window => {
        const utilization = number(window.utilization), reset = number(window.resetsAt)
        const fresh = reset !== undefined && reset > Date.now()
        const resetText = fresh ? `Resets ${new Date(reset).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'})}` : 'Awaiting usage update'
        const description = `${id} · ${label(window.type)} · ${fresh ? pct(utilization) : '—'} used · ${resetText}${isStale ? ' (cached)' : ''}`
        return `<div class="quota" title="${esc(description)}"><div class="line"><span>${esc(label(window.type))}</span><strong>${fresh ? pct(utilization) : '—'}${isStale ? '<small class="tray-stale-tag">cached</small>' : ''}</strong></div>${fresh && utilization !== undefined ? `<progress max="1" value="${Math.max(0, Math.min(1, utilization))}" class="${utilization >= .95 ? 'danger' : ''}" aria-label="${esc(description)}"></progress>` : ''}</div>`
      }).join('') || '<p>No usage windows available</p>'}</div>${active === id && nextReset ? `<small class="next-reset">${esc(label(nextReset.type))} resets ${esc(new Date(Number(nextReset.resetsAt)).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'}))}</small>` : ''}`}</article>`
    }).join('') || (stopped ? '<p>Start Meridian to load accounts and usage.</p>' : '<p>No accounts available. Open the dashboard to connect.</p>')}</div>
    <div class="controls">${state.owned ? button('restart', 'Restart') + button('stop', 'Stop') : state.preferences.mode === 'managed' ? button('start', 'Start Meridian', '', !state.preferences.selected) : '<small>Service managed externally</small>'}</div>
    <footer>${button('toggle-snooze', state.preferences.quietUntil > Date.now() ? 'Resume alerts' : 'Pause alerts 1h', '', !state.preferences.notifications)}${button('refresh', 'Refresh')}${button('quit-app', 'Quit')}</footer><small>${state.busy ? esc(state.busy) : state.lastChecked ? `Updated ${esc(new Date(state.lastChecked).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}))}` : stopped ? 'Service stopped' : 'Awaiting connection'}</small>`
  if (html === rendered) return
  rendered = html; root.innerHTML = html
  const list = root.querySelector('.accounts'); if (list) list.scrollTop = scroll
  if (focusedKey) Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(button => button.dataset.key === focusedKey && !button.disabled)?.focus()
}
root.addEventListener('click', async event => {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-action]') : null
  if (!target || target.disabled || pending) return
  pending = true; error = ''
  if (current) render(current)
  try { current = await window.meridian.action(target.dataset.action as Action, target.dataset.value) }
  catch (caught) { error = String(caught) }
  finally { pending = false; if (current) render(current) }
})
window.meridian.subscribe(render)
void window.meridian.state().then(render).catch(caught => { root.textContent = `Could not load Meridian: ${String(caught)}` })
document.addEventListener('keydown', event => { if (event.key === 'Escape') void window.meridian.action('close-panel') })

new ResizeObserver(() => { void window.meridian.action('resize-panel', root.getBoundingClientRect().height).catch(caught => console.error('Panel sizing failed', caught)) }).observe(root)
