import { LOGIN_STATES } from "./profileLoginStates"
import { PROFILE_PROVIDERS } from "./profileProviders"
import { formatExtraUsage, formatExtraUsageAmount, formatResetCountdown, classifyUtilization } from "./profileUsage"
import type { FreeResetView } from "./freeResets"

type Cell = { readonly value: number | string | null; readonly html?: string }

function freeResetCells(view: FreeResetView | null, esc: (text: string) => string): Record<string, Cell> {
  const result: Record<string, Cell> = {}
  const columns = { full: "fullReset", fable: "fableReset", unknown: "otherReset" } as const
  for (const group of view?.groups ?? []) {
    const id = columns[group.kind]
    const previous = result[id]
    const count = typeof previous?.value === "number" ? previous.value + group.available : group.available
    result[id] = { value: count, html: (previous?.html ?? "") + '<div>' + group.available
      + '<span class="profile-table-note">' + esc(group.note) + '</span></div>' }
  }
  return result
}
type Input = {
  readonly name: string
  readonly provider: string
  readonly login: string
  readonly active: boolean
  readonly quota?: {
    readonly windows?: readonly { readonly type: string; readonly utilization?: number | null; readonly resetsAt?: number | null }[]
    readonly extraUsage?: Parameters<typeof formatExtraUsage>[0]
    readonly stale?: boolean
  }
  readonly spentLabel?: string | null
  readonly spentDetail?: string | null
  readonly routingDetail?: string | null
}

function tableFacts(input: Input, format: {
  readonly escape: (text: string) => string
  readonly providerName: string
  readonly loginName: string | null
  readonly countdown: typeof formatResetCountdown
  readonly extra: typeof formatExtraUsage
}): Record<string, Cell> {
  const esc = format.escape
  const sub = (text: string) => text ? '<span class="profile-table-note">' + esc(text) + '</span>' : ""
  const windowCell = (type: string): Cell => {
    const window = input.quota?.windows?.find(w => w.type === type)
    const utilization = window?.utilization
    const reset = window?.resetsAt
    const note = reset != null && Number.isFinite(reset)
      ? '<time datetime="' + new Date(reset).toISOString() + '" title="' + esc(new Date(reset).toLocaleString()) + '">'
        + esc(reset > Date.now() ? 'Resets ' + format.countdown(reset) : 'Reset at ' + new Date(reset).toLocaleString()) + '</time>'
      : ""
    const value = utilization != null && Number.isFinite(utilization) ? utilization * 100 : null
    if (value === null && !note) return { value }
    const reading = value === null ? "\u2014" : Math.round(value) + "%"
    return { value, html: reading + (note || input.quota?.stale
      ? '<span class="profile-table-note">' + note + (input.quota?.stale ? (note ? ' · ' : '') + 'Last reading' : '') + '</span>' : '') }
  }
  const extra = format.extra(input.quota?.extraUsage)
  return {
    name: { value: input.name },
    provider: { value: format.providerName },
    active: { value: input.active ? 'Active' : 'Inactive' },
    login: { value: format.loginName },
    fiveHour: windowCell('five_hour'),
    weekly: windowCell('seven_day'),
    extra: extra ? { value: extra.utilizationPct, html: esc(extra.used + ' / ' + extra.limit)
      + sub(extra.utilizationPct + '%' + (extra.over ? ' · ' + extra.over + ' over limit' : '')) } : { value: null },
    spent: { value: input.spentLabel || null, html: input.spentLabel ? esc(input.spentLabel) + sub(input.spentDetail || '') : undefined },
    routing: { value: input.routingDetail || null },
  }
}

export const profileTableFactsJs = `
function escapeProfileTableFact(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function freeResetTableCells(view) {
  return (${freeResetCells.toString()})(view, escapeProfileTableFact);
}

function meridianTableCredits(credits, display) {
  const value = !credits?.unlimited && Number.isFinite(credits?.balance) ? credits.balance : null;
  if (!display && value === null) return { value };
  const label = display?.value ?? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' credits';
  const esc = escapeProfileTableFact;
  return { value, html: (display ? '<span title="' + esc(display.note) + '">' + esc(label) + '</span>' : esc(label))
    + (display?.serving ? '<span class="profile-table-note profile-table-credit-serving">on credits</span>' : '') };
}

function meridianTableFacts(input) {
  const providers = ${JSON.stringify(PROFILE_PROVIDERS)};
  const states = ${JSON.stringify(LOGIN_STATES)};
  const formatExtraUsageAmount = ${formatExtraUsageAmount.toString()};
  const classifyUtilization = ${classifyUtilization.toString()};
  const extra = ${formatExtraUsage.toString()};
  return (${tableFacts.toString()})(input, {
    escape: escapeProfileTableFact,
    providerName: providers.find(p => p.id === input.provider)?.label || input.provider,
    loginName: states.find(s => s.id === input.login)?.label || null,
    countdown: ${formatResetCountdown.toString()},
    extra,
  });
}
`
