/**
 * Route attribution: how an account was chosen (classifyRouteKind) and which
 * accounts a request actually touched (collapseRouteChains).
 *
 * Both are pure — the whole point of the design is that no correlation work
 * happens on the request path, so all of it is directly unit-testable.
 */
import { describe, expect, it } from "bun:test"
import { classifyRouteKind } from "../proxy/routing"
import { collapseRouteChains, summarizeRoutes } from "../telemetry/routeChain"
import type { RequestMetric } from "../telemetry"

function makeMetric(overrides: Partial<RequestMetric> = {}): RequestMetric {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    model: "sonnet",
    mode: "stream",
    isResume: false,
    isPassthrough: false,
    status: 200,
    queueWaitMs: 5,
    proxyOverheadMs: 12,
    ttfbMs: 120,
    upstreamDurationMs: 800,
    totalDurationMs: 850,
    contentBlocks: 3,
    textEvents: 10,
    error: null,
    ...overrides,
  }
}

/** A failed priority hop, as the request handler's catch block records it. */
function failedHop(profileId: string, attempt: number, groupId: string, timestamp: number): RequestMetric {
  return makeMetric({
    profileId,
    routeKind: "priority-hop",
    routeGroupId: groupId,
    routeAttempt: attempt,
    status: 429,
    error: "rate_limit_error",
    timestamp,
  })
}

function okHop(profileId: string, attempt: number, groupId: string, timestamp: number): RequestMetric {
  return makeMetric({
    profileId,
    routeKind: "priority-hop",
    routeGroupId: groupId,
    routeAttempt: attempt,
    timestamp,
  })
}

describe("classifyRouteKind", () => {
  it("calls an internal dispatch hop a hop, even though it is also pinned", () => {
    expect(classifyRouteKind({
      pinnedProfileHeader: "corp2",
      priorityHop: true,
      routingMode: "priority",
    })).toBe("priority-hop")
  })

  it("calls a client-pinned request pinned regardless of routing mode", () => {
    expect(classifyRouteKind({ pinnedProfileHeader: "work", routingMode: "sticky" })).toBe("pinned")
    expect(classifyRouteKind({ pinnedProfileHeader: "work", routingMode: "active" })).toBe("pinned")
  })

  it("reports the routing mode when nothing pinned the request", () => {
    expect(classifyRouteKind({ routingMode: "sticky" })).toBe("sticky")
    expect(classifyRouteKind({ routingMode: "priority" })).toBe("priority")
    expect(classifyRouteKind({ routingMode: "active" })).toBe("active")
    expect(classifyRouteKind({ routingMode: "active+priority" })).toBe("active+priority")
  })

  it("keeps the two pool modes apart on their hops, not just on their rows", () => {
    expect(classifyRouteKind({
      pinnedProfileHeader: "corp2",
      priorityHop: true,
      routingMode: "active+priority",
    })).toBe("active+priority-hop")
  })

  it("returns undefined rather than guessing when routing never resolved", () => {
    expect(classifyRouteKind({})).toBeUndefined()
  })

  it("falls through to the routing mode when the request is not a hop", () => {
    expect(classifyRouteKind({ priorityHop: false, routingMode: "active" })).toBe("active")
  })
})

describe("collapseRouteChains", () => {
  it("folds a multi-hop failover into ONE row carrying the whole chain", () => {
    const collapsed = collapseRouteChains([
      okHop("corp3", 3, "g1", 3_000),
      failedHop("corp2", 2, "g1", 2_000),
      failedHop("corp1", 1, "g1", 1_000),
    ])

    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]!.routeChain).toEqual([
      { profileId: "corp1", ok: false, status: 429, error: "rate_limit_error" },
      { profileId: "corp2", ok: false, status: 429, error: "rate_limit_error" },
      { profileId: "corp3", ok: true, status: 200, error: null },
    ])
  })

  it("keeps the ANSWERING hop's identity — that row is what the client got", () => {
    const answering = okHop("corp3", 2, "g1", 2_000)
    const collapsed = collapseRouteChains([answering, failedHop("corp1", 1, "g1", 1_000)])

    expect(collapsed[0]!.requestId).toBe(answering.requestId)
    expect(collapsed[0]!.profileId).toBe("corp3")
    expect(collapsed[0]!.status).toBe(200)
    expect(collapsed[0]!.error).toBeNull()
  })

  it("relabels the collapsed row `priority` — it is a client request, not a hop", () => {
    const collapsed = collapseRouteChains([okHop("corp3", 2, "g1", 2_000), failedHop("corp1", 1, "g1", 1_000)])
    expect(collapsed[0]!.routeKind).toBe("priority")
  })

  it("keeps WHICH pool mode dispatched it when the hops are dropped", () => {
    const answering = { ...okHop("corp3", 2, "g1", 2_000), routeKind: "active+priority-hop" as const }
    const first = { ...failedHop("corp1", 1, "g1", 1_000), routeKind: "active+priority-hop" as const }
    const collapsed = collapseRouteChains([answering, first])

    expect(collapsed[0]!.routeKind).toBe("active+priority")
  })

  it("names the refused allowance on the hop that refused", () => {
    const refused = { ...failedHop("corp1", 1, "g1", 1_000), routeRefusedBucket: "five_hour" }
    const collapsed = collapseRouteChains([okHop("corp2", 2, "g1", 2_000), refused])

    expect(collapsed[0]!.routeChain).toEqual([
      { profileId: "corp1", ok: false, status: 429, error: "rate_limit_error", refusedBucket: "five_hour" },
      { profileId: "corp2", ok: true, status: 200, error: null },
    ])
  })

  it("marks every hop failed when the whole pool was exhausted", () => {
    const collapsed = collapseRouteChains([
      failedHop("corp2", 2, "g1", 2_000),
      failedHop("corp1", 1, "g1", 1_000),
    ])

    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]!.routeChain!.every((h) => !h.ok)).toBe(true)
    expect(collapsed[0]!.status).toBe(429)
  })

  it("gives a first-try success a one-entry chain", () => {
    const collapsed = collapseRouteChains([okHop("corp1", 1, "g1", 1_000)])
    expect(collapsed[0]!.routeChain).toEqual([{ profileId: "corp1", ok: true, status: 200, error: null }])
    expect(collapsed[0]!.routeKind).toBe("priority")
  })

  it("leaves ungrouped rows exactly as they were", () => {
    const pinned = makeMetric({ profileId: "work", routeKind: "pinned" })
    const sticky = makeMetric({ profileId: "personal", routeKind: "sticky" })
    const collapsed = collapseRouteChains([pinned, sticky])

    expect(collapsed).toEqual([pinned, sticky])
    expect(collapsed[0]!.routeChain).toBeUndefined()
  })

  it("preserves newest-first order across interleaved groups and loose rows", () => {
    const loose = makeMetric({ requestId: "loose", timestamp: 2_500, routeKind: "active" })
    const collapsed = collapseRouteChains([
      okHop("corp1", 2, "g2", 4_000),
      failedHop("corp2", 1, "g2", 3_500),
      loose,
      okHop("corp3", 2, "g1", 2_000),
      failedHop("corp1", 1, "g1", 1_000),
    ])

    expect(collapsed.map((m) => m.profileId ?? m.requestId)).toEqual(["corp1", "loose", "corp3"])
  })

  it("orders by attempt, not by arrival, when hops land in the same millisecond", () => {
    const collapsed = collapseRouteChains([
      okHop("corp3", 3, "g1", 1_000),
      failedHop("corp1", 1, "g1", 1_000),
      failedHop("corp2", 2, "g1", 1_000),
    ])

    expect(collapsed[0]!.routeChain!.map((h) => h.profileId)).toEqual(["corp1", "corp2", "corp3"])
  })

  it("shows what is still known when older hops aged out of the window", () => {
    const collapsed = collapseRouteChains([okHop("corp3", 3, "g1", 3_000)])

    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]!.routeChain).toEqual([{ profileId: "corp3", ok: true, status: 200, error: null }])
  })

  it("names an unprofiled hop `default` rather than dropping it from the chain", () => {
    const collapsed = collapseRouteChains([
      okHop("corp2", 2, "g1", 2_000),
      makeMetric({ routeGroupId: "g1", routeAttempt: 1, status: 429, error: "rate_limit_error", timestamp: 1_000 }),
    ])

    expect(collapsed[0]!.routeChain!.map((h) => h.profileId)).toEqual(["default", "corp2"])
  })

  it("returns the input untouched when nothing was dispatched through a pool", () => {
    const rows = [makeMetric(), makeMetric()]
    expect(collapseRouteChains(rows)).toBe(rows)
  })
})

describe("summarizeRoutes", () => {
  /** The tally is fed collapsed rows, so build them the way the endpoint does. */
  function tally(rows: RequestMetric[]) {
    return summarizeRoutes(collapseRouteChains(rows))
  }

  it("counts a failover as ONE request, and credits each account its part", () => {
    const summary = tally([
      okHop("corp2", 2, "g1", 2_000),
      failedHop("corp1", 1, "g1", 1_000),
    ])

    expect(summary.requests).toBe(1)
    expect(summary.failedOver).toBe(1)
    expect(summary.unserved).toBe(0)
    expect(summary.byProfile.corp1).toEqual({ served: 0, refused: 1, refusedBuckets: {} })
    expect(summary.byProfile.corp2).toEqual({ served: 1, refused: 0, refusedBuckets: {} })
  })

  it("names which allowance each account was refused on, and how often", () => {
    const summary = tally([
      okHop("corp2", 2, "g1", 2_000),
      { ...failedHop("corp1", 1, "g1", 1_000), routeRefusedBucket: "five_hour" },
      okHop("corp2", 2, "g2", 4_000),
      { ...failedHop("corp1", 1, "g2", 3_000), routeRefusedBucket: "five_hour" },
      okHop("corp2", 2, "g3", 6_000),
      { ...failedHop("corp1", 1, "g3", 5_000), routeRefusedBucket: "seven_day_opus" },
    ])

    expect(summary.byProfile.corp1!.refused).toBe(3)
    expect(summary.byProfile.corp1!.refusedBuckets).toEqual({ five_hour: 2, seven_day_opus: 1 })
  })

  it("counts a refusal in a mode that never fails over — the row has no chain at all", () => {
    const summary = tally([
      makeMetric({
        profileId: "work",
        routeKind: "active",
        status: 429,
        error: "rate_limit_error",
        routeRefusedBucket: "five_hour",
      }),
    ])

    expect(summary.requests).toBe(1)
    expect(summary.failedOver).toBe(0)
    expect(summary.unserved).toBe(1)
    expect(summary.byProfile.work).toEqual({ served: 0, refused: 1, refusedBuckets: { five_hour: 1 } })
  })

  it("does NOT blame an account for an upstream outage", () => {
    const summary = tally([
      makeMetric({ profileId: "work", routeKind: "active", status: 503, error: "overloaded_error" }),
    ])

    expect(summary.unserved).toBe(1)
    expect(summary.byProfile.work).toEqual({ served: 0, refused: 0, refusedBuckets: {} })
  })

  it("counts a request nobody answered as unserved", () => {
    const summary = tally([
      failedHop("corp2", 2, "g1", 2_000),
      failedHop("corp1", 1, "g1", 1_000),
    ])

    expect(summary.requests).toBe(1)
    expect(summary.failedOver).toBe(1)
    expect(summary.unserved).toBe(1)
    expect(summary.byProfile.corp1!.refused).toBe(1)
    expect(summary.byProfile.corp2!.refused).toBe(1)
  })

  it("tallies how the account was chosen, using the collapsed row's kind", () => {
    const summary = tally([
      makeMetric({ profileId: "work", routeKind: "pinned" }),
      makeMetric({ profileId: "personal", routeKind: "active" }),
      makeMetric({ profileId: "personal", routeKind: "active" }),
      okHop("corp2", 2, "g1", 2_000),
      failedHop("corp1", 1, "g1", 1_000),
    ])

    expect(summary.byKind).toEqual({ pinned: 1, active: 2, priority: 1 })
  })

  it("is empty and harmless with nothing recorded", () => {
    expect(summarizeRoutes([])).toEqual({
      requests: 0,
      failedOver: 0,
      unserved: 0,
      byKind: {},
      byProfile: {},
    })
  })
})
