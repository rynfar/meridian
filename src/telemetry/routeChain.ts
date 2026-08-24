/**
 * Fold priority-dispatch hops back into one row per client request.
 *
 * Priority routing serves one client request by re-entering the proxy once
 * per candidate account, so a failover already produces several telemetry
 * rows — one per attempt — that share a `routeGroupId`. Nothing correlates
 * them at write time on purpose: the request path may not spend a cycle on
 * anything the dashboard wants. The join happens HERE, on the read path,
 * when somebody actually asks for the data.
 *
 * Pure — no I/O, no store access, no clock.
 */

import type { RequestMetric, RouteHop, RouteKind, RouteProfileTally, RouteSummary } from "./types"

/** Ascending attempt order; timestamp breaks ties (hops can land in the
 *  same millisecond when an account rejects instantly). */
function byAttempt(a: RequestMetric, b: RequestMetric): number {
  return (a.routeAttempt ?? 0) - (b.routeAttempt ?? 0) || a.timestamp - b.timestamp
}

function toHop(metric: RequestMetric): RouteHop {
  return {
    profileId: metric.profileId ?? "default",
    ok: metric.error === null && metric.status < 400,
    status: metric.status,
    error: metric.error,
    ...(metric.routeRefusedBucket ? { refusedBucket: metric.routeRefusedBucket } : {}),
  }
}

/**
 * The kind a collapsed row carries, given the kind its hops recorded.
 *
 * The `-hop` suffix goes because the collapsed thing is a client request, not
 * an attempt. WHICH mode dispatched it must survive that: `priority` drained
 * the pool in configured order, `active+priority` put the selected account at
 * its head, and those are different answers to "why this account".
 */
function collapsedRouteKind(hopKind: RouteKind | undefined): RouteKind {
  return hopKind === "active+priority-hop" ? "active+priority" : "priority"
}

/**
 * Collapse each `routeGroupId` group down to the hop that answered the
 * client — the last one attempted, whether it succeeded or the pool ran
 * out — carrying the whole chain on it.
 *
 * @param metrics Newest first, as every ITelemetryStore.getRecent returns.
 *                Output keeps that order and the group's newest position.
 */
export function collapseRouteChains(metrics: RequestMetric[]): RequestMetric[] {
  const groups = new Map<string, RequestMetric[]>()
  for (const metric of metrics) {
    if (!metric.routeGroupId) continue
    const existing = groups.get(metric.routeGroupId)
    if (existing) existing.push(metric)
    else groups.set(metric.routeGroupId, [metric])
  }
  if (groups.size === 0) return metrics

  const emitted = new Set<string>()
  const out: RequestMetric[] = []
  for (const metric of metrics) {
    const groupId = metric.routeGroupId
    if (!groupId) {
      out.push(metric)
      continue
    }
    if (emitted.has(groupId)) continue
    emitted.add(groupId)
    out.push(collapseGroup(groups.get(groupId)!))
  }
  return out
}

/**
 * One group -> one row. The answering hop keeps its own identity (request
 * id, timings, tokens, status) because that IS what the client got; the
 * failed attempts survive only as chain entries, and the row is relabelled
 * `priority` since the collapsed thing is a client request, not a hop.
 *
 * A group may be partial when older hops have already aged out of the ring
 * buffer or fallen outside the `since` window. The chain then shows what is
 * still known rather than nothing.
 */
function collapseGroup(hops: RequestMetric[]): RequestMetric {
  const ordered = hops.length > 1 ? [...hops].sort(byAttempt) : hops
  const answering = ordered[ordered.length - 1]!
  return {
    ...answering,
    routeKind: collapsedRouteKind(answering.routeKind),
    routeChain: ordered.map(toHop),
  }
}

/**
 * Errors that mean THIS ACCOUNT said no, as opposed to Anthropic having a bad
 * minute. Only these count as refusals: an `overloaded_error` or a
 * `upstream_timeout` says nothing about the account, and tallying it would
 * blame an account for an outage — the exact misattribution this tally exists
 * to prevent. Matches the set the pool router itself fails over on.
 */
const ACCOUNT_REFUSALS: ReadonlySet<string> = new Set(["rate_limit_error", "billing_error"])

/**
 * Tally where a window's requests went and which accounts refused them.
 *
 * Pure, and read-path only — same as everything else in this module.
 *
 * @param collapsed Rows from collapseRouteChains, i.e. one per CLIENT request.
 *                  Passing raw hops would count a failover once per account.
 */
export function summarizeRoutes(collapsed: RequestMetric[]): RouteSummary {
  const byKind: Record<string, number> = {}
  const byProfile: Record<string, RouteProfileTally> = {}
  let failedOver = 0
  let unserved = 0

  for (const metric of collapsed) {
    if (metric.routeKind) byKind[metric.routeKind] = (byKind[metric.routeKind] ?? 0) + 1
    // A row that never went through a pool still describes one account
    // attempt, and in active/sticky mode that is the ONLY place a refusal
    // shows up — no chain is ever built for it.
    const chain = metric.routeChain ?? [toHop(metric)]
    if (chain.length > 1) failedOver++
    if (!chain[chain.length - 1]!.ok) unserved++
    for (const hop of chain) {
      const tally = (byProfile[hop.profileId] ??= { served: 0, refused: 0, refusedBuckets: {} })
      if (hop.ok) {
        tally.served++
        continue
      }
      if (!hop.error || !ACCOUNT_REFUSALS.has(hop.error)) continue
      tally.refused++
      if (hop.refusedBucket) {
        tally.refusedBuckets[hop.refusedBucket] = (tally.refusedBuckets[hop.refusedBucket] ?? 0) + 1
      }
    }
  }

  return { requests: collapsed.length, failedOver, unserved, byKind, byProfile }
}
