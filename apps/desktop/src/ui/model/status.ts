/** Health chip, attached-instance footer and the page-level data state. Pure. */
import { object, text } from '../../core'
import type { DesktopState } from '../../contracts'
import type { Tone } from './tone'
import type { AccountView } from './accounts'

/** What a data screen may render: loading skeletons, a failure state, or data. */
export type DataState = { kind: 'loading' } | { kind: 'failed'; title: string; message: string; fix: string } | { kind: 'ready' }

export function dataState(state: DesktopState | undefined): DataState {
  // Before the first read finishes there is no instance yet.
  if (!state || (!state.instance && !state.lastChecked)) return { kind: 'loading' }
  const connection = state.connection
  if (connection.kind === 'ok') return { kind: 'ready' }
  if (connection.kind === 'starting') return { kind: 'loading' }
  const title = { stopped: 'Meridian is not running', unauthorized: 'Meridian rejected the API key', 'wrong-port': 'Meridian is on another port', 'not-meridian': 'That address is not Meridian' }[connection.kind]
  return { kind: 'failed', title, message: connection.message, fix: connection.fix }
}

/**
 * Whether the account reads (/profiles/list, /v1/usage/quota/all) produced
 * something to show. Both null means not read yet or failed — never "no
 * accounts on this service".
 */
export type AccountsRead = { kind: 'ready'; warning: string } | { kind: 'loading' } | { kind: 'failed'; message: string }
export function accountsRead(state: Pick<DesktopState, 'profiles' | 'quota' | 'dataErrors'>, accounts: number): AccountsRead {
  const errors = state.dataErrors.filter(error => /\/profiles\/list|\/v1\/usage\/quota/.test(error))
  const message = errors.join(' · ')
  if (state.profiles !== null || state.quota !== null || accounts > 0) return { kind: 'ready', warning: message }
  return errors.length ? { kind: 'failed', message } : { kind: 'loading' }
}

export function host(baseUrl: string | undefined): string {
  if (!baseUrl) return ''
  try { return new URL(baseUrl).host } catch { return baseUrl }
}

export interface HealthChip { tone: Tone; label: string; title: string }
/** "Working · personal · Max", or the plain reason it is not. */
export function healthChip(state: DesktopState | undefined, serving: AccountView | undefined): HealthChip {
  if (!state || (!state.instance && !state.lastChecked)) return { tone: 'muted', label: 'Connecting…', title: 'Looking for the Meridian your clients use' }
  const kind = state.connection.kind
  if (kind === 'starting') return { tone: 'yellow', label: 'Starting…', title: state.connection.message }
  if (kind === 'stopped') return { tone: 'red', label: 'Not running', title: state.connection.message }
  if (kind === 'unauthorized') return { tone: 'red', label: 'API key rejected', title: state.connection.message }
  if (kind === 'wrong-port') return { tone: 'yellow', label: 'Wrong port', title: state.connection.message }
  if (kind === 'not-meridian') return { tone: 'red', label: 'Not Meridian', title: state.connection.message }
  const health = object(state.health)
  const upstream = object(object(health.upstream).claude)
  const account = serving ? [serving.id, serving.plan].filter(Boolean).join(' · ') : ''
  const suffix = account ? ` · ${account}` : ''
  if (text(upstream.state) === 'failing' || text(upstream.state) === 'down') return { tone: 'red', label: `Claude connection failed${suffix}`, title: text(upstream.lastErrorKind) || 'Recent requests could not reach Claude.' }
  if (text(upstream.state) && text(upstream.state) !== 'ok') return { tone: 'yellow', label: `Rechecking Claude${suffix}`, title: `Upstream state: ${text(upstream.state)}` }
  const provider = failingProvider(state)
  if (provider) return { tone: text(health.backend) === 'antigravity' ? 'red' : 'yellow', label: `${provider.name} unavailable · ${provider.error || provider.status}`, title: provider.error || `${provider.name} reports ${provider.status}.` }
  if (text(health.status) && text(health.status) !== 'healthy') return { tone: 'yellow', label: `${text(health.status).replace(/^./, c => c.toUpperCase())}${suffix}`, title: state.connection.message }
  if (serving?.limited && serving.active) return { tone: 'yellow', label: `Limited${suffix}`, title: `${serving.id} reached its ${serving.limited.label.toLowerCase()} limit` }
  return { tone: 'green', label: `Working${suffix}`, title: state.connection.message }
}

/** An enabled non-Claude provider (Antigravity) that reports a failure; Claude's own state comes from /health. */
export function failingProvider(state: Pick<DesktopState, 'providers'>): { name: string; status: string; error: string } | undefined {
  const provider = state.providers?.providers.find(p => p.enabled && p.id !== 'claude' && (p.status === 'unavailable' || Boolean(p.error)))
  return provider ? { name: provider.name || provider.id, status: provider.status, error: provider.error ?? '' } : undefined
}

/** A provider's own state for its Accounts section header: "unavailable · agy is not signed in". Null when healthy or unknown. */
export function providerState(state: Pick<DesktopState, 'providers'>, id: string): { text: string; failing: boolean } | null {
  const provider = state.providers?.providers.find(p => p.id === id)
  if (!provider?.enabled || (provider.status === 'healthy' && !provider.error)) return null
  return { text: [provider.status, provider.error].filter(Boolean).join(' · '), failing: provider.status === 'unavailable' || Boolean(provider.error) }
}

/** Sidebar footer: which instance is being viewed and how. */
export function instanceLines(state: DesktopState | undefined): { title: string; detail: string; version: string } {
  if (!state?.instance) return { title: 'Looking for Meridian…', detail: '', version: state ? `Desktop ${state.desktopVersion}` : '' }
  const instance = state.instance
  const where = host(instance.baseUrl)
  const version = instance.version ? `Meridian ${instance.version}` : state.connection.kind === 'ok' ? '' : 'Not reachable'
  if (instance.supervisor.kind === 'app') {
    if (instance.supervisor.label) return { title: `Managing ${instance.supervisor.label}`, detail: `app · ${where}`, version }
    const none = !state.detection?.services.some(service => service.status === 'meridian' && !service.own)
    return { title: state.owned ? `Running Meridian's own copy on :${instance.port}${none ? ' — no service found' : ''}` : `Meridian's own copy on :${instance.port} is stopped`, detail: `app-managed · ${where}`, version }
  }
  const supervisor = instance.supervisor.kind === 'unknown' ? 'external' : instance.supervisor.kind
  return { title: state.connection.kind === 'ok' ? 'Attached to your service' : 'Watching your service', detail: `${supervisor} · ${where}`, version }
}

/** The service is controlled by the app (its own copy or a taken-over agent). */
export function managed(state: DesktopState): boolean { return state.preferences.mode === 'managed' }
