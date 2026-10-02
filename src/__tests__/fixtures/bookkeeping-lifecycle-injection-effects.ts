import type { ProcessIncarnation } from "../../proxy/session/processIncarnation"
import type { SqlRow, TranscriptResource, TranscriptResourceState } from "../../proxy/session/bookkeeping/types"
import type { LifecycleState } from "./bookkeeping-lifecycle-observer"

export interface InjectionSnapshot { ledger: LifecycleState; pins: SqlRow[] }
export interface EffectContext {
  key: string
  locator: TranscriptResource["locator"]
  owner: ProcessIncarnation
  /** Clock of the faulted operation; setup ran at an earlier instant, so every timestamp write is visible. */
  now: number
}
/** Durable effect of ONE successful COMMIT of a write transaction, stated from the SQL it runs.
 * `after` supplies only values the engine generates at random (UUID tokens), each checked for freshness. */
export type DurableEffect = (state: InjectionSnapshot, after: InjectionSnapshot, context: EffectContext) => void

const CLEARED_LATER = "<token cleared by a later committed effect>"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function fresh(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw new Error(`expected a fresh engine UUID, got ${String(value)}`)
  return value
}
function row(state: InjectionSnapshot, { key }: EffectContext): TranscriptResource {
  const resource = state.ledger.resources[key]
  if (!resource) throw new Error(`effect addresses missing resource ${key}`)
  return resource
}
function onlyLease(resource: TranscriptResource) {
  const leases = Object.values(resource.activeLeases ?? {})
  if (leases.length !== 1) throw new Error(`effect expects exactly one lease, found ${leases.length}`)
  return leases[0]!
}
function transition(state: InjectionSnapshot, resource: TranscriptResource, to: TranscriptResourceState): void {
  state.ledger.counts[`resources:${resource.state}`]!--
  state.ledger.counts[`resources:${to}`]!++
  resource.state = to
}
function bump(resource: TranscriptResource, context: EffectContext, touch = true): void {
  resource.rowVersion! += 1
  if (touch) resource.updatedAt = context.now
}
function create(state: InjectionSnapshot, context: EffectContext, to: TranscriptResourceState) {
  const { key, locator, now } = context
  if (state.ledger.resources[key]) throw new Error("create effect on an existing resource")
  const slot = key.slice(0, 4)
  const counter = (state.ledger.fenceSlots[slot] ?? 0) + 1
  state.ledger.fenceSlots[slot] = counter
  state.ledger.counts[`resources:${to}`]!++
  const resource: TranscriptResource = { key, generation: `r:${key}:${counter}`, locator, state: to,
    createdAt: now, updatedAt: now, attempts: 0, rowVersion: 1 }
  return state.ledger.resources[key] = resource
}
function pin(state: InjectionSnapshot, resource: TranscriptResource): void {
  state.pins.push({ mapping_key: "mapping", slot: "current", resource_key: resource.key, generation: resource.generation })
}

const leaseAcquired: DurableEffect = (state, after, context) => {
  const resource = row(state, context), token = fresh(onlyLease(row(after, context)).token)
  resource.activeLeases = { [token]: { token, owner: context.owner, createdAt: context.now } }
  bump(resource, context, false)
}
const leaseReleased: DurableEffect = (state, _after, context) => {
  const resource = row(state, context)
  onlyLease(resource)
  delete resource.activeLeases
  bump(resource, context, false)
}
const promoted: DurableEffect = (state, _after, context) => {
  const resource = row(state, context)
  transition(state, resource, "live")
  delete resource.nextAttemptAt
  bump(resource, context)
}
const retired: DurableEffect = (state, _after, context) => {
  const resource = row(state, context)
  transition(state, resource, "retired")
  resource.nextAttemptAt = context.now // retiredGraceMs = 0
  bump(resource, context)
}
const createdLive: DurableEffect = (state, _after, context) => { create(state, context, "live") }

export const durableEffects = {
  acquire: leaseAcquired,
  attachExecutor: (state, _after, context) => {
    const resource = row(state, context)
    Object.assign(onlyLease(resource), { executor: context.owner, executorRecoverable: true })
    bump(resource, context, false)
  },
  release: leaseReleased,
  releaseJoined: leaseReleased,
  retryDeferred: leaseReleased,
  prepare: (state, _after, context) => { create(state, context, "prepared") },
  preparePublication: (state, after, context) => {
    const resource = create(state, context, "prepared")
    const token = fresh(onlyLease(row(after, context)).token)
    resource.activeLeases = { [token]: { token, owner: context.owner, purpose: "publication", createdAt: context.now } }
    bump(resource, context, false)
  },
  ensure: createdLive,
  register: createdLive,
  attachPinned: (state, after, context) => {
    createdLive(state, after, context)
    pin(state, row(state, context))
  },
  commit: promoted,
  publish: (state, after, context) => {
    promoted(state, after, context)
    pin(state, row(state, context))
  },
  abandon: retired,
  claimDeletion: (state, after, context) => {
    const resource = row(state, context)
    transition(state, resource, "deleting")
    resource.deletionOwner = context.owner
    // A later effect in the same sequence (finish) clears the token; it is then absent from `after` too.
    const observed = row(after, context).deletionToken
    resource.deletionToken = observed === undefined ? CLEARED_LATER : fresh(observed)
    bump(resource, context)
  },
  attachDeletion: (state, _after, context) => {
    const resource = row(state, context)
    resource.deletionExecutor = context.owner
    resource.deletionProcessGroupId = context.owner.pid
    bump(resource, context)
  },
  finishDeletion: (state, _after, context) => {
    const resource = row(state, context)
    transition(state, resource, "deleted")
    for (const field of ["deletionOwner", "deletionToken", "deletionExecutor", "deletionProcessGroupId",
      "nextAttemptAt", "lastError"] as const) delete resource[field]
    bump(resource, context)
  },
  reconcileRescue: promoted,
  reconcileRetire: retired,
} satisfies Record<string, DurableEffect>

export type EffectName = keyof typeof durableEffects

/** Apply committed transactions in order to a deep copy; the argument itself is never mutated. */
export function expectedDurable(before: InjectionSnapshot, after: InjectionSnapshot, context: EffectContext,
  effects: readonly EffectName[]): InjectionSnapshot {
  const state = structuredClone(before)
  for (const effect of effects) durableEffects[effect](state, after, context)
  if (JSON.stringify(state).includes(CLEARED_LATER)) throw new Error("claimed token was never observed nor cleared")
  return state
}
