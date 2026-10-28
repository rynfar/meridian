import { useMemo } from 'react'
import { useDesktop } from './desktop'
import { buildAccounts, servingAccount, type AccountsModel, type AccountView } from '../model/accounts'
import { pricingTable, requestRows, type Pricing, type RequestRow } from '../model/requests'
import { dataState, type DataState } from '../model/status'

export interface Models { data: DataState; requests: RequestRow[]; accounts: AccountsModel; serving: AccountView | undefined; pricing: Record<string, Pricing> }
const emptyAccounts: AccountsModel = { accounts: [], active: {}, order: [], routing: '' }

/** Derived view models, recomputed only when their inputs change. */
export function useModels(): Models {
  const { state, now } = useDesktop()
  const requests = useMemo(() => requestRows(state?.requests), [state?.requests])
  const accounts = useMemo(() => state ? buildAccounts(state, now) : emptyAccounts,
    // `now` moves every 30s; quota staleness only needs that granularity.
    [state?.profiles, state?.quota, state?.providers, state?.routesSummary, state?.summary, state?.settings, now])
  const pricing = useMemo(() => pricingTable(state?.settings.values.pricing), [state?.settings.values.pricing])
  return { data: dataState(state), requests, accounts, serving: servingAccount(accounts), pricing }
}
