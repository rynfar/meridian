/**
 * Account view model: Claude profiles, ChatGPT seats and Antigravity accounts
 * in one shape, from /profiles/list, /v1/usage/quota/all and /providers/status.
 * Pure — the clock is passed in.
 */
import { number, object, rows, text } from '../../core'
import type { DesktopState } from '../../contracts'
import { sortProfilesByConfiguredOrder } from '../../uiData'
import { untilText } from './pace'

export type AccountProvider = 'claude' | 'chatgpt' | 'antigravity'
export interface LimitWindow {
  type: string; label: string; short: string; group?: string;
  utilization: number | null; resetsAt: number | null;
  /** The reading is old or its reset already passed: never show it as free capacity. */
  stale: boolean;
  /** Its reset already passed: the figure describes the previous window, so it never limits the account. */
  expired: boolean;
  primary: boolean;
}
export interface AccountLimit { window: string; label: string; short: string; resetsAt: number | null; stale: boolean; source: 'usage' | 'refusing'; rationale?: string }
export interface AccountView {
  id: string; provider: AccountProvider; label: string; email: string; organization: string;
  /** "Max", "Team", "Plus"; the provider word is added by callers. */
  plan: string; planDetail: string;
  active: boolean; loggedIn: boolean; needsLogin: boolean;
  /** Usage data could not be read; windows may be last-known. */
  usageNote: string; fetchedAt: number | null;
  windows: LimitWindow[]; fiveHour?: LimitWindow; weekly?: LimitWindow;
  /** Worst primary-window utilization of the current windows, null when unknown. */
  peak: number | null;
  /** The peak comes from an old reading or a window awaiting its post-reset reading. */
  peakStale: boolean;
  /** The window behind `peak` (or, when every window has reset, the last one read), for a mini track. */
  peakWindow?: LimitWindow;
  /** At a current primary limit or refusing; a window whose reset passed never counts. */
  limited: AccountLimit | null;
  /** `text` names dollars (Accounts only); `summary` never does (Today, DESIGN: no dollars in heroes). */
  extraUsage: { enabled: boolean; text: string; summary: string } | null;
  duplicateOf: string[]; duplicateTitle: string; aliases: string[];
  renewal: { days: number | null; soon: boolean };
  served?: number; refused?: number; costUsd?: number;
  seat?: string;
  /** ChatGPT seats: who holds the login, the token state and what removes the seat when Meridian cannot. */
  owner?: ChatGptOwnerView | null; tokenState?: string; removal?: string;
}
/** /profiles/list `chatgpt.owner` (and each seat's `owner`): who signs ChatGPT seats in. */
export interface ChatGptOwnerView { name: string; webSignIn: boolean; login: string; loginMethod: string; refresh: string; refreshTool: string; remove: string; importCommand: string }
export function chatGptOwner(value: unknown): ChatGptOwnerView | null {
  const owner = object(value)
  if (!text(owner.name)) return null
  return { name: text(owner.name), webSignIn: owner.webSignIn === true, login: text(owner.login), loginMethod: text(owner.loginMethod), refresh: text(owner.refresh), refreshTool: text(owner.refreshTool), remove: text(owner.remove), importCommand: text(owner.importCommand) }
}
/** Meridian holds the seats' logins and signs them in over HTTP: Add, Sign in again, Renew and Remove work here. */
export function chatGptManaged(owner: ChatGptOwnerView | null | undefined): boolean {
  return owner?.name === 'meridian' && owner.webSignIn
}
export interface OwnerCommand { label: string; command: string; note: string }
/** What to run where Meridian cannot sign a seat in itself, as /profiles shows it. */
export function ownerCommands(owner: ChatGptOwnerView | null | undefined, seat?: { label: string; expired: boolean }): OwnerCommand[] {
  if (!owner || chatGptManaged(owner)) return []
  if (owner.name === 'meridian') return owner.importCommand ? [{ label: 'Import', command: owner.importCommand, note: 'Sign the account in with opencode first, then bring it into Meridian’s store.' }] : []
  const commands: OwnerCommand[] = []
  if (owner.login) commands.push({ label: seat ? 'Sign in again' : 'Sign in', command: owner.login, note: [owner.loginMethod && `choose ${owner.loginMethod}`, seat ? `pick ${seat.label}` : 'then Add account', `at ${owner.name}`].filter(Boolean).join(' · ') })
  if (owner.refresh && (!seat || seat.expired)) commands.push({ label: 'Renew', command: owner.refresh, note: owner.refreshTool ? `or the ${owner.refreshTool} tool in an opencode session` : '' })
  return commands
}
export interface AccountsChatGpt { owner: ChatGptOwnerView | null }
export interface AccountsModel {
  accounts: AccountView[];
  /** Active id per provider. */
  active: Partial<Record<AccountProvider, string>>;
  follow?: { url: string; stale: boolean };
  /** Configured pool order (Claude ids and ChatGPT seats), for reorder. */
  order: string[];
  routing: string;
  /** Present when the service serves ChatGPT (/profiles/list `chatgpt`). */
  chatgpt?: AccountsChatGpt;
}

const STALE_MS = 90_000
const PRIMARY = ['five_hour', 'seven_day']
const LABELS: Record<string, [string, string]> = {
  five_hour: ['5-hour', '5h'], seven_day: ['Weekly', '7d'], '5h': ['5-hour', '5h'], '7d': ['Weekly', '7d'],
  'gemini-5h': ['5-hour', '5h'], '3p-5h': ['5-hour', '5h'], 'gemini-weekly': ['Weekly', '7d'], '3p-weekly': ['Weekly', '7d'], '30d': ['30 days', '30d'],
}
export function windowLabel(type: string): { label: string; short: string } {
  const known = LABELS[type]
  if (known) return { label: known[0], short: known[1] }
  const weekly = /^seven_day_(.+)$/.exec(type)
  if (weekly?.[1]) {
    const name = weekly[1].replaceAll('_', ' ').replace(/^./, c => c.toUpperCase())
    return { label: `Weekly · ${name}`, short: `7d ${name}` }
  }
  const pretty = type.replaceAll('_', ' ')
  return { label: pretty, short: pretty }
}

const DUPLICATE_BASIS: Record<string, string> = {
  'account-organization': 'the same Claude account in the same organization',
  'email-organization': 'the same email and organization',
  seat: 'the same ChatGPT seat',
  'workspace-email': 'the same email in the same ChatGPT workspace',
}

function planWord(profile: Record<string, unknown>): string {
  const sub = text(profile.subscriptionType)
  if (sub) return sub.charAt(0).toUpperCase() + sub.slice(1)
  return text(profile.accountType) || text(profile.planLabel)
}

function extraUsage(value: unknown): AccountView['extraUsage'] {
  const eu = object(value)
  if (eu.isEnabled === undefined) return null
  if (eu.isEnabled !== true) return { enabled: false, text: 'Extra Usage off · no paid overage', summary: 'Extra Usage off · no paid overage' }
  const currency = text(eu.currency) === 'USD' ? '$' : text(eu.currency) ? `${text(eu.currency)} ` : '$'
  const limit = number(eu.monthlyLimit) ?? 0
  const used = number(eu.usedCredits) ?? 0
  if (limit <= 0) return { enabled: true, text: 'Extra Usage on · no monthly limit', summary: 'Extra Usage on · no monthly limit' }
  const share = number(eu.utilization) ?? used / limit
  return { enabled: true, text: `Extra Usage on · ${currency}${used.toFixed(2)} of ${currency}${limit.toFixed(2)} this month`, summary: `Extra Usage on · ${Math.round(share * 100)}% of the monthly limit used` }
}

function limitWindows(raw: unknown, now: number, staleReading: boolean): LimitWindow[] {
  return rows(raw).map(item => {
    const type = text(item.type)
    const utilization = number(item.utilization) ?? null
    const resetsAt = number(item.resetsAt) ?? null
    const { label, short } = windowLabel(type)
    const group = text(item.group) || undefined
    const expired = resetsAt !== null && resetsAt <= now
    return { type, label: group ? `${group} · ${label}` : label, short, group, utilization, resetsAt, stale: staleReading || expired, expired, primary: PRIMARY.includes(type) || FIVE_HOUR.has(type) || WEEKLY.has(type) || /(^|-)(5h|weekly)$/.test(type) }
  })
}

const FIVE_HOUR = new Set(['five_hour', '5h', 'gemini-5h', '3p-5h'])
const WEEKLY = new Set(['seven_day', '7d', 'gemini-weekly', '3p-weekly'])
const byUse = (a: LimitWindow, b: LimitWindow) => (b.utilization ?? -1) - (a.utilization ?? -1)
/** The worst window of a kind (Antigravity reports one per model group), current readings first. */
function pick(windows: readonly LimitWindow[], types: ReadonlySet<string>): LimitWindow | undefined {
  const matching = windows.filter(w => types.has(w.type))
  return [...matching.filter(w => !w.expired)].sort(byUse)[0] ?? [...matching].sort(byUse)[0]
}

/**
 * Peak and limit from usage windows. A window whose reset passed is awaiting
 * a new reading: it neither limits the account nor reads as free capacity.
 */
function usage(windows: readonly LimitWindow[]): Pick<AccountView, 'peak' | 'peakStale' | 'peakWindow'> & { full?: LimitWindow } {
  const read = windows.filter(w => w.primary && w.utilization !== null)
  const current = read.filter(w => !w.expired).sort(byUse)
  const worst = current[0]
  const full = current.filter(w => (w.utilization ?? 0) >= 1).sort((a, b) => (FIVE_HOUR.has(a.type) ? -1 : 0) - (FIVE_HOUR.has(b.type) ? -1 : 0))[0]
  return { peak: worst?.utilization ?? null, peakStale: read.some(w => w.stale), peakWindow: worst ?? [...read].sort(byUse)[0], full }
}

const usageLimit = (full: LimitWindow | undefined): AccountLimit | null =>
  full ? { window: full.type, label: full.label, short: full.short, resetsAt: full.resetsAt, stale: full.stale, source: 'usage' } : null

function spentLimit(spent: Record<string, unknown>, now: number): AccountLimit | null {
  if (!Object.keys(spent).length) return null
  const until = number(spent.until) ?? null
  if (until !== null && until <= now) return null
  const diagnosis = object(spent.diagnosis)
  const bucket = text(diagnosis.bucket)
  const { label, short } = bucket ? windowLabel(bucket) : { label: 'rate', short: 'rate' }
  return { window: bucket || 'rate', label, short, resetsAt: until, stale: false, source: 'refusing', rationale: text(diagnosis.rationale) || undefined }
}

type Inputs = Pick<DesktopState, 'profiles' | 'quota' | 'providers' | 'routesSummary' | 'summary' | 'settings'>

export function buildAccounts(state: Inputs, now: number): AccountsModel {
  const profilesBody = object(state.profiles)
  const listed = rows(profilesBody.profiles)
  const quotas = rows(object(state.quota).profiles)
  const activeProfiles = object(profilesBody.activeProfiles)
  const spentList = rows(profilesBody.spent)
  const tally = object(object(state.routesSummary).byProfile)
  const costs = object(object(object(state.summary).costEstimate).byProfile)
  const followRaw = object(profilesBody.follow)
  const follow = text(followRaw.url) ? { url: text(followRaw.url), stale: followRaw.stale === true } : undefined

  const ids = [...new Set([...listed, ...quotas].map(profile => text(profile.id)).filter(Boolean))]
  const routing = object(state.settings.values.routing)
  const configured = Array.isArray(routing.profileOrder) ? routing.profileOrder.map(text).filter(Boolean)
    : Array.isArray(profilesBody.profileOrder) ? profilesBody.profileOrder.map(text).filter(Boolean) : []
  const ordered = sortProfilesByConfiguredOrder(ids, configured)

  const active: AccountsModel['active'] = {}
  const accounts: AccountView[] = ordered.map(id => {
    const profile = listed.find(item => item.id === id) ?? {}
    const quota = quotas.find(item => item.id === id) ?? {}
    const provider: AccountProvider = typeof profile.seat === 'string' || text(profile.provider) === 'chatgpt' ? 'chatgpt' : 'claude'
    const fetchedAt = number(quota.fetchedAt) ?? null
    const failure = text(object(quota.failure).reason)
    const staleReading = quota.stale === true || fetchedAt === null || now - fetchedAt > STALE_MS
    const windows = limitWindows(quota.windows, now, staleReading)
    const needsLogin = profile.loggedIn === false || quota.error === 'no_token' || failure === 'auth_failure'
    const isActive = typeof activeProfiles[provider] === 'string' ? activeProfiles[provider] === id
      : profile.isActive === true || quota.isActive === true || (provider === 'claude' && profilesBody.activeProfile === id)
    if (isActive && !active[provider]) active[provider] = id
    const fiveHour = pick(windows, FIVE_HOUR)
    const weekly = pick(windows, WEEKLY)
    const { full, ...peak } = usage(windows)
    // A refusal counts while its `until` is ahead; spentLimit drops it after.
    const spent = spentLimit(object(quota.spent), now) ?? spentLimit(spentList.find(item => text(item.profileId) === id) ?? {}, now)
    const limited: AccountLimit | null = spent ?? usageLimit(full)
    const usageNote = needsLogin ? 'Sign-in required'
      : !windows.length && quota.error ? 'Usage unavailable'
      : staleReading && windows.length ? failure === 'rate_limited' ? 'Last reading (usage reads are rate limited)' : 'Last reading'
      : ''
    const duplicateOf = Array.isArray(profile.duplicateOf) ? profile.duplicateOf.map(text).filter(Boolean) : []
    const t = object(tally[id])
    return {
      id, provider, label: text(profile.label) || id,
      email: text(profile.email), organization: text(profile.organizationName),
      plan: planWord(profile), planDetail: text(profile.planName) || text(profile.planLabel),
      active: isActive, loggedIn: profile.loggedIn !== false, needsLogin,
      usageNote, fetchedAt, windows, fiveHour, weekly, ...peak, limited,
      extraUsage: extraUsage(quota.extraUsage),
      duplicateOf,
      duplicateTitle: duplicateOf.length ? `Signed in to ${DUPLICATE_BASIS[text(profile.duplicateBasis)] ?? 'the same account'} as ${duplicateOf.join(', ')}: one account and one quota under ${duplicateOf.length + 1} names.` : '',
      aliases: Array.isArray(profile.aliases) ? profile.aliases.map(text).filter(Boolean) : [],
      renewal: { days: number(profile.daysUntilRenewal) ?? null, soon: profile.renewalRequiredSoon === true },
      served: number(t.served), refused: number(t.refused), costUsd: number(object(costs[id]).estimatedUsd),
      seat: typeof profile.seat === 'string' ? profile.seat : undefined,
      ...(provider === 'chatgpt' ? { owner: chatGptOwner(profile.owner) ?? chatGptOwner(object(profilesBody.chatgpt).owner), tokenState: text(profile.tokenState), removal: text(profile.removal) || undefined } : {}),
    }
  })

  // Antigravity accounts come only from the provider snapshot.
  for (const provider of state.providers?.providers ?? []) {
    if (provider.id !== 'antigravity' || !provider.enabled) continue
    for (const account of provider.accounts) {
      const staleReading = Boolean(account.error) || !account.fetchedAt || (state.providers?.fetchedAt ?? now) - account.fetchedAt > STALE_MS
      const windows = limitWindows(account.windows, now, staleReading)
      // Every Antigravity window is a quota window (5h and weekly per model group).
      const { full, ...peak } = usage(windows.map(w => ({ ...w, primary: true })))
      if (account.active && !active.antigravity) active.antigravity = account.id
      accounts.push({
        id: account.id, provider: 'antigravity', label: account.label ?? account.id, email: '', organization: '', plan: 'Google', planDetail: '',
        active: account.active === true, loggedIn: true, needsLogin: false, usageNote: account.error ?? '', fetchedAt: account.fetchedAt ?? null,
        windows, fiveHour: pick(windows, FIVE_HOUR), weekly: pick(windows, WEEKLY), ...peak, limited: usageLimit(full),
        extraUsage: null, duplicateOf: [], duplicateTitle: '', aliases: [], renewal: { days: null, soon: false },
      })
    }
  }
  const chatgptBody = object(profilesBody.chatgpt)
  const chatgpt = Object.keys(chatgptBody).length ? { owner: chatGptOwner(chatgptBody.owner) } : undefined
  return { accounts, active, follow, chatgpt, order: configured.length ? sortProfilesByConfiguredOrder(ids, configured) : ids, routing: text(routing.routing) || text(profilesBody.routing) }
}

/** The account serving requests now: the active Claude account, else the active ChatGPT seat. */
export function servingAccount(model: AccountsModel): AccountView | undefined {
  const id = model.active.claude ?? model.active.chatgpt ?? model.active.antigravity
  return model.accounts.find(account => account.id === id) ?? model.accounts[0]
}

/** Accounts at a primary limit or refusing — the sidebar badge. */
export function limitedCount(model: AccountsModel): number {
  return model.accounts.filter(account => account.limited).length
}

/** Move one id within the configured order, keeping every other id in place. */
export function moveInOrder(order: readonly string[], id: string, direction: -1 | 1, sameGroup: (other: string) => boolean = () => true): string[] {
  const next = [...order]
  const from = next.indexOf(id)
  if (from < 0) return next
  let to = from + direction
  while (to >= 0 && to < next.length && !sameGroup(next[to] ?? '')) to += direction
  if (to < 0 || to >= next.length) return next
  next[from] = next[to] ?? id
  next[to] = id
  return next
}

export type AccountAction =
  | { kind: 'serving' } | { kind: 'sign-in' } | { kind: 'held'; text: string } | { kind: 'followed' } | { kind: 'use' } | { kind: 'none' }
/**
 * The one action beside an account on Today, Accounts and the menu bar.
 * Antigravity accounts are never switched from here; an account whose reset
 * passed is not held, so it offers Use.
 */
export function accountAction(account: Pick<AccountView, 'active' | 'needsLogin' | 'limited' | 'provider'>, follow: boolean, now: number): AccountAction {
  if (account.active) return { kind: 'serving' }
  if (account.needsLogin) return account.provider === 'antigravity' ? { kind: 'none' } : { kind: 'sign-in' }
  if (account.limited) return { kind: 'held', text: untilText(account.limited.resetsAt, now) }
  if (account.provider === 'antigravity') return { kind: 'none' }
  return follow ? { kind: 'followed' } : { kind: 'use' }
}

/** Mockup copy for a limit: "5h limit", "weekly limit". */
export function limitPill(limit: AccountLimit): string {
  if (limit.source === 'refusing') return limit.short === 'rate' ? 'refusing' : `refusing · ${limit.short}`
  if (limit.window === 'five_hour') return '5h limit'
  if (limit.window === 'seven_day') return 'weekly limit'
  return `${limit.short} limit`
}
