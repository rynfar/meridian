/**
 * The ChatGPT card on /providers: seats, quota windows, activity and models.
 *
 * Windows come from two read-only sources. The usage service (`/wham/usage`,
 * fetched with each seat's current access token and cached) is preferred;
 * where it has nothing, the `x-codex-*` headers of the seat's latest real
 * response stand in. Neither path refreshes a token. No credential field of a
 * seat reaches this module's output.
 */
import type { ProviderUsage } from '../../telemetry/providerView'
import type { RequestMetric } from '../../telemetry/types'
import type { CodexUsageResponse } from '../codex/types'
import { chatGptSeatLabel, observedUsageWindows } from '../chatgpt/profiles'
import type { ChatGptCredentialSource, SeatUnavailableReason } from '../chatgpt/source'
import type { ChatGptModelCatalogView } from '../chatgpt/catalog'
import type { ObservedSeatLimits } from './chatgpt'

export { chatGptSeatLabel }

const REASON_TEXT: Record<SeatUnavailableReason, string> = {
  unknown: 'Account not found in the credential store.',
  disabled: 'Disabled by its credential owner.',
  cooling_down: 'Cooling down at its credential owner.',
  quota_exhausted: 'Quota exhausted.',
  no_token: 'No access token yet.',
  expired: 'Access token expired; waiting for its owner to refresh it.',
  requires_reauth: 'Needs an interactive login.',
  no_authority: 'This Meridian does not hold refresh authority.',
  excluded: 'Excluded from work routing.',
}

export const CHATGPT_ADAPTER = 'chatgpt'

function modelsCapability(view: ChatGptModelCatalogView): { name: string; status: string; detail: string } {
  if (view.source === 'static') {
    return { name: 'Models', status: 'built-in', detail: "The backend's model catalog has not been read yet; offering the built-in list." }
  }
  const plans = Object.entries(view.plans).map(([plan, models]) => `${plan} ${models.length}`).join(', ')
  const readAt = view.fetchedAt === null ? 'never' : new Date(view.fetchedAt).toISOString()
  return { name: 'Models', status: 'catalog', detail: `From the backend's model catalog, read ${readAt} for Codex ${view.clientVersion ?? 'unknown'}. Models per plan: ${plans || 'none'}.` }
}

function headerWindows(observed: ObservedSeatLimits | undefined) {
  return observedUsageWindows(observed)
    .filter(w => w.utilization !== null && w.resetsAt !== null)
    .map(w => ({ type: w.type, utilization: w.utilization!, resetsAt: w.resetsAt! }))
}

export function chatGptProvider(input: {
  source: ChatGptCredentialSource
  observed: ReadonlyMap<string, ObservedSeatLimits>
  usage: CodexUsageResponse | null
  recent: readonly RequestMetric[]
  models: ChatGptModelCatalogView
}): ProviderUsage {
  const { source, observed, usage, recent } = input
  const turns = recent.filter(metric => metric.adapter === CHATGPT_ADAPTER)
  const usageById = new Map((usage?.entries ?? []).map(entry => [entry.id, entry]))
  return {
    id: 'chatgpt',
    name: 'ChatGPT',
    enabled: true,
    status: source.isServing() ? 'healthy' : 'unavailable',
    endpoint: '/v1/responses',
    error: source.isServing() ? undefined : source.mode === 'owned'
      ? 'This Meridian does not hold refresh authority for its ChatGPT accounts.'
      : 'The oc-codex-multi-auth store could not be read.',
    models: [...input.models.models],
    capabilities: [
      { name: 'Credentials', status: source.mode, detail: source.mode === 'follow-external'
        ? 'Follows the oc-codex-multi-auth store read-only. Meridian never refreshes or writes it.'
        : 'Meridian owns these accounts and holds the single refresh lease.' },
      { name: 'Pass-through', status: 'on', detail: 'No Claude prompt, no scrubbing, no request plugins. Only store=false, stream=true, the encrypted-reasoning include and removing max_output_tokens, temperature and top_p are adapted, as the backend requires.' },
      modelsCapability(input.models),
      { name: 'Thinking', status: 'summaries', detail: 'ChatGPT exposes only short reasoning summaries and encrypted reasoning; both pass through untouched.' },
    ],
    activity: {
      requests: turns.length,
      errors: turns.filter(metric => metric.error !== null || metric.status >= 400).length,
      inputTokens: turns.reduce((sum, m) => sum + (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0), 0),
      outputTokens: turns.reduce((sum, m) => sum + (m.outputTokens ?? 0), 0),
      cacheReadTokens: turns.reduce((sum, m) => sum + (m.cacheReadInputTokens ?? 0), 0),
    },
    accounts: source.seats().map(seat => {
      const entry = usageById.get(seat.id)
      const fetched = entry?.windows.filter(w => w.utilization !== null && w.resetsAt !== null)
        .map(w => ({ type: w.type, utilization: Math.min(1, Math.max(0, w.utilization!)), resetsAt: w.resetsAt! })) ?? []
      const fromHeaders = headerWindows(observed.get(seat.id))
      return {
        id: seat.id,
        label: chatGptSeatLabel(seat.id, seat.email),
        active: seat.active,
        fetchedAt: entry?.fetchedAt ?? observed.get(seat.id)?.at,
        error: seat.reason ? REASON_TEXT[seat.reason] : undefined,
        windows: fetched.length > 0 ? fetched : fromHeaders,
      }
    }),
  }
}
