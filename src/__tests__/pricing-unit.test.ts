import { describe, expect, it } from "bun:test"
import {
  resolveModelPricing,
  estimateRequestCostUsd,
  computeCostEstimate,
} from "../telemetry/pricing"
import { computeSummary } from "../telemetry/percentiles"
import type { RequestMetric } from "../telemetry/types"

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

describe("resolveModelPricing", () => {
  it("resolves SDK aliases meridian uses", () => {
    expect(resolveModelPricing("opus")).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 })
    expect(resolveModelPricing("sonnet")).toMatchObject({ inputPerMTok: 3, outputPerMTok: 15 })
    expect(resolveModelPricing("haiku")).toMatchObject({ inputPerMTok: 1, outputPerMTok: 5 })
    expect(resolveModelPricing("fable")).toMatchObject({ inputPerMTok: 10, outputPerMTok: 50 })
  })

  it("strips the [1m] extended-context suffix", () => {
    expect(resolveModelPricing("opus[1m]")).toMatchObject({ inputPerMTok: 5 })
    expect(resolveModelPricing("sonnet[1m]")).toMatchObject({ inputPerMTok: 3 })
    expect(resolveModelPricing("fable[1m]")).toMatchObject({ inputPerMTok: 10 })
  })

  it("resolves concrete API model IDs", () => {
    expect(resolveModelPricing("claude-opus-4-8")).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 })
    expect(resolveModelPricing("claude-sonnet-4-6")).toMatchObject({ inputPerMTok: 3 })
    expect(resolveModelPricing("claude-fable-5")).toMatchObject({ inputPerMTok: 10 })
  })

  it("falls back to family pricing for dated snapshot IDs", () => {
    expect(resolveModelPricing("claude-haiku-4-5-20251001")).toMatchObject({ inputPerMTok: 1, outputPerMTok: 5 })
    expect(resolveModelPricing("claude-sonnet-4-5-20250929")).toMatchObject({ inputPerMTok: 3 })
    expect(resolveModelPricing("claude-opus-4-7-20260101")).toMatchObject({ inputPerMTok: 5 })
  })

  it("prices legacy models at their historical rates", () => {
    expect(resolveModelPricing("claude-opus-4-1")).toMatchObject({ inputPerMTok: 15, outputPerMTok: 75 })
    expect(resolveModelPricing("claude-opus-4-20250514")).toMatchObject({ inputPerMTok: 15 })
    expect(resolveModelPricing("claude-3-opus-20240229")).toMatchObject({ inputPerMTok: 15 })
    expect(resolveModelPricing("claude-3-5-haiku-20241022")).toMatchObject({ inputPerMTok: 0.8, outputPerMTok: 4 })
    expect(resolveModelPricing("claude-3-haiku-20240307")).toMatchObject({ inputPerMTok: 0.25 })
  })

  it("derives cache rates from the input rate", () => {
    const opus = resolveModelPricing("opus")!
    expect(opus.cacheReadPerMTok).toBeCloseTo(0.5, 10)
    expect(opus.cacheWritePerMTok).toBeCloseTo(6.25, 10)
  })

  it("returns null for unrecognized models", () => {
    expect(resolveModelPricing("gpt-4o")).toBeNull()
    expect(resolveModelPricing("unknown")).toBeNull()
    expect(resolveModelPricing("")).toBeNull()
  })

  it("prices claude-sonnet-5 at the introductory rate", () => {
    // $2/$10 through 2026-08-31, then $3/$15 (see pricing.ts comment)
    expect(resolveModelPricing("claude-sonnet-5")).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10 })
  })

  it("prefers user overrides over the built-in table and family fallback", () => {
    const overrides = {
      "claude-opus-4-8": { inputPerMTok: 9, outputPerMTok: 45, cacheReadPerMTok: 0.9, cacheWritePerMTok: 11.25 },
      "totally-custom": { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
    }
    expect(resolveModelPricing("claude-opus-4-8", overrides)!.inputPerMTok).toBe(9)
    expect(resolveModelPricing("claude-opus-4-8[1m]", overrides)!.inputPerMTok).toBe(9)
    expect(resolveModelPricing("totally-custom", overrides)!.outputPerMTok).toBe(2)
    // Models without an override still resolve normally
    expect(resolveModelPricing("haiku", overrides)!.inputPerMTok).toBe(1)
  })
})

describe("estimateRequestCostUsd", () => {
  it("computes cost from all four token buckets", () => {
    const pricing = resolveModelPricing("opus")!
    const metric = makeMetric({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 10_000_000,
      cacheCreationInputTokens: 1_000_000,
    })
    // 1M in ($5) + 1M out ($25) + 10M cache read ($5) + 1M cache write ($6.25)
    expect(estimateRequestCostUsd(metric, pricing)).toBeCloseTo(41.25, 6)
  })

  it("treats missing token fields as zero", () => {
    const pricing = resolveModelPricing("opus")!
    expect(estimateRequestCostUsd(makeMetric(), pricing)).toBe(0)
  })
})

describe("computeCostEstimate", () => {
  it("returns zeros for an empty window", () => {
    const estimate = computeCostEstimate([])
    expect(estimate.totalUsd).toBe(0)
    expect(estimate.byModel).toEqual({})
    expect(estimate.unpricedRequestCount).toBe(0)
  })

  it("aggregates tokens and cost per model", () => {
    const metrics = [
      makeMetric({
        requestModel: "claude-haiku-4-5-20251001",
        inputTokens: 500_000,
        outputTokens: 200_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 400_000,
      }),
      makeMetric({
        requestModel: "claude-haiku-4-5-20251001",
        inputTokens: 500_000,
        outputTokens: 0,
      }),
    ]

    const estimate = computeCostEstimate(metrics)
    const haiku = estimate.byModel["claude-haiku-4-5-20251001"]!

    expect(haiku.requests).toBe(2)
    expect(haiku.inputTokens).toBe(1_000_000)
    expect(haiku.outputTokens).toBe(200_000)
    expect(haiku.cacheReadTokens).toBe(1_000_000)
    expect(haiku.cacheCreationTokens).toBe(400_000)
    // 1M in ($1) + 0.2M out ($1) + 1M cache read ($0.10) + 0.4M cache write ($0.50)
    expect(haiku.estimatedUsd).toBeCloseTo(2.6, 6)
    expect(estimate.totalUsd).toBeCloseTo(2.6, 6)
  })

  it("groups by requestModel, falling back to the SDK model alias", () => {
    const metrics = [
      makeMetric({ requestModel: "claude-opus-4-8", model: "opus", inputTokens: 1_000_000 }),
      makeMetric({ requestModel: undefined, model: "opus", inputTokens: 1_000_000 }),
    ]

    const estimate = computeCostEstimate(metrics)
    expect(estimate.byModel["claude-opus-4-8"]!.estimatedUsd).toBeCloseTo(5, 6)
    expect(estimate.byModel["opus"]!.estimatedUsd).toBeCloseTo(5, 6)
    expect(estimate.totalUsd).toBeCloseTo(10, 6)
  })

  it("flags unrecognized models instead of pricing them at $0", () => {
    const metrics = [
      makeMetric({ requestModel: "some-custom-model", inputTokens: 1_000_000 }),
      makeMetric({ requestModel: "some-custom-model", inputTokens: 1_000_000 }),
      makeMetric({ requestModel: "claude-opus-4-8", inputTokens: 1_000_000 }),
    ]

    const estimate = computeCostEstimate(metrics)
    expect(estimate.byModel["some-custom-model"]!.estimatedUsd).toBeNull()
    expect(estimate.byModel["some-custom-model"]!.inputTokens).toBe(2_000_000)
    expect(estimate.unpricedRequestCount).toBe(2)
    // Unpriced requests are excluded from the total, not counted as $0
    expect(estimate.totalUsd).toBeCloseTo(5, 6)
  })

  it("counts requests with no token data toward the model's request count", () => {
    const estimate = computeCostEstimate([makeMetric({ requestModel: "claude-opus-4-8" })])
    expect(estimate.byModel["claude-opus-4-8"]!.requests).toBe(1)
    expect(estimate.byModel["claude-opus-4-8"]!.estimatedUsd).toBe(0)
  })
})

describe("computeCostEstimate byProfile (multi-account rollup)", () => {
  it("aggregates cost and request count per profile", () => {
    const metrics = [
      makeMetric({ requestModel: "claude-opus-4-8", profileId: "personal", inputTokens: 1_000_000 }),
      makeMetric({ requestModel: "claude-opus-4-8", profileId: "personal", inputTokens: 1_000_000 }),
      makeMetric({ requestModel: "claude-opus-4-8", profileId: "work", outputTokens: 1_000_000 }),
      makeMetric({ requestModel: "claude-opus-4-8" }), // no profileId → "default"
    ]
    const estimate = computeCostEstimate(metrics)
    expect(estimate.byProfile["personal"]).toEqual({ requests: 2, estimatedUsd: 10 })
    expect(estimate.byProfile["work"]).toEqual({ requests: 1, estimatedUsd: 25 })
    expect(estimate.byProfile["default"]!.requests).toBe(1)
  })

  it("counts unpriced-model requests in the profile's request count without cost", () => {
    const estimate = computeCostEstimate([
      makeMetric({ requestModel: "mystery-model", profileId: "personal", inputTokens: 1_000_000 }),
    ])
    expect(estimate.byProfile["personal"]).toEqual({ requests: 1, estimatedUsd: 0 })
  })
})

describe("computeSummary costEstimate integration", () => {
  it("includes a zeroed costEstimate in the empty summary", () => {
    const summary = computeSummary([], 3_600_000)
    expect(summary.costEstimate).toEqual({ totalUsd: 0, byModel: {}, unpricedRequestCount: 0, byProfile: {} })
  })

  it("exposes the window's cost estimate on the summary", () => {
    const summary = computeSummary(
      [makeMetric({ requestModel: "claude-opus-4-8", inputTokens: 1_000_000, outputTokens: 200_000 })],
      3_600_000,
    )
    // 1M in ($5) + 0.2M out ($5)
    expect(summary.costEstimate.totalUsd).toBeCloseTo(10, 6)
    expect(summary.costEstimate.byModel["claude-opus-4-8"]!.requests).toBe(1)
  })

  it("applies pricing overrides passed to computeSummary", () => {
    const overrides = {
      "claude-opus-4-8": { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 1, cacheWritePerMTok: 12.5 },
    }
    const summary = computeSummary(
      [makeMetric({ requestModel: "claude-opus-4-8", inputTokens: 1_000_000 })],
      3_600_000,
      overrides,
    )
    expect(summary.costEstimate.totalUsd).toBeCloseTo(10, 6)
  })
})
