import { fetchOAuthPlanFields, planFieldsMissing } from "./oauthPlan"
import type { OAuthPlanFields } from "./oauthPlan"

export const PLAN_RECHECK_MS = 6 * 60 * 60_000
const PLAN_RETRY_MS = 5 * 60_000

type StoreIdentity = { readonly refreshKey?: string }
type PlanState = OAuthPlanFields & { readonly accessToken: string; readonly planCheckedAt?: number }
type Maintenance = {
  readonly kind: "token" | "plan"
  readonly run: () => Promise<boolean>
}
type PendingMaintenance = { readonly kind: Maintenance["kind"]; readonly promise: Promise<boolean> }

const pendingByKey = new Map<string, PendingMaintenance>()
let pendingByStore = new WeakMap<StoreIdentity, PendingMaintenance>()
const attemptedByKey = new Map<string, number>()
let attemptedByStore = new WeakMap<StoreIdentity, number>()

export function resetPlanRecheck(): void {
  pendingByKey.clear()
  pendingByStore = new WeakMap()
  attemptedByKey.clear()
  attemptedByStore = new WeakMap()
}

/** Plan writes and token rotations share one slot; a forced rotation never joins a plan-only result. */
export async function runCredentialMaintenance(store: StoreIdentity, operation: Maintenance): Promise<boolean> {
  const key = store.refreshKey
  const pending = key ? pendingByKey.get(key) : pendingByStore.get(store)
  if (pending) {
    if (operation.kind === "plan" || pending.kind === "token") return pending.promise
    await pending.promise
    return runCredentialMaintenance(store, operation)
  }

  const promise = Promise.resolve().then(operation.run).finally(() => {
    if (key) {
      if (pendingByKey.get(key)?.promise === promise) pendingByKey.delete(key)
    } else if (pendingByStore.get(store)?.promise === promise) pendingByStore.delete(store)
  })
  const entry = { kind: operation.kind, promise }
  if (key) pendingByKey.set(key, entry)
  else pendingByStore.set(store, entry)
  return promise
}

/** Whether a stored plan reading is missing, undated or expired, and no lookup was tried in the retry window. */
export function planReadingDue(state: Omit<PlanState, "accessToken">, store: StoreIdentity, now = Date.now()): boolean {
  const checkedAt = state.planCheckedAt
  const dated = typeof checkedAt === "number" && Number.isFinite(checkedAt)
  if (!planFieldsMissing(state) && dated && now - checkedAt < PLAN_RECHECK_MS) return false

  const key = store.refreshKey
  const attempted = key ? attemptedByKey.get(key) : attemptedByStore.get(store)
  return attempted === undefined || now - attempted >= PLAN_RETRY_MS
}

export async function readPlanUpdate(state: PlanState, store: StoreIdentity): Promise<{
  readonly fields: OAuthPlanFields
  readonly checkedAt: number
} | null> {
  const now = Date.now()
  if (!planReadingDue(state, store, now)) return null

  const key = store.refreshKey
  if (key) attemptedByKey.set(key, now)
  else attemptedByStore.set(store, now)

  const fields = await fetchOAuthPlanFields(state.accessToken)
  if (Object.keys(fields).length === 0) return null
  return { fields, checkedAt: Date.now() }
}
