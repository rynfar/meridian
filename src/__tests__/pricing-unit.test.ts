import { describe, expect, it } from "bun:test"
import {
  BUILTIN_MODEL_PRICING,
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
  it("prices Haiku 5.5 and the default alias at the short-prompt rates", () => {
    for (const model of ["haiku", " Haiku[1m] ", "claude-haiku-5-5", "claude-haiku-5-5[1m]", "claude-haiku-5-5-20261007", "anthropic.claude-haiku-5-5"]) {
      expect(resolveModelPricing(model)).toEqual({
        inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125,
      })
    }
  })

  it("keeps explicit historical and unknown future Haiku rates conservative", () => {
    for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-haiku-6", "claude-haiku-5-50", "claude-haiku-5-5-preview"]) {
      expect(resolveModelPricing(model)).toEqual({
        inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25,
      })
    }
    expect(resolveModelPricing("claude-3-5-haiku-latest")).toMatchObject({ inputPerMTok: 0.8, outputPerMTok: 4 })
    expect(resolveModelPricing("claude-haiku-3")).toMatchObject({ inputPerMTok: 0.25, outputPerMTok: 1.25 })
  })

  it("prices Sonnet 5.5 at standard rates", () => {
    expect(resolveModelPricing("claude-sonnet-5-5")).toEqual({
      inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5,
    })
    expect(resolveModelPricing("claude-sonnet-5-5[1m]")).toEqual({
      inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5,
    })
  })
  it("prices Opus 5.5 including its reduced cache-read rate", () => {
    expect(resolveModelPricing("claude-opus-5-5[1m]")).toEqual({
      inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5,
    })
    expect(resolveModelPricing("claude-opus-5")?.inputPerMTok).toBe(5)
  })
  it("prices Fable 5.2 and Mythos 5.2 including their reduced cache-read rate", () => {
    for (const model of ["claude-fable-5-2", "claude-fable-5-2[1m]", "claude-mythos-5-2"]) {
      expect(resolveModelPricing(model)).toEqual({
        inputPerMTok: 8, outputPerMTok: 40, cacheReadPerMTok: 0.2, cacheWritePerMTok: 10,
      })
    }
    expect(resolveModelPricing("claude-fable-5-1")?.inputPerMTok).toBe(10)
  })
  it("resolves SDK aliases meridian uses", () => {
    expect(resolveModelPricing("opus")).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20 })
    expect(resolveModelPricing("sonnet")).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10 })
    expect(resolveModelPricing("haiku")).toMatchObject({ inputPerMTok: 0.1, outputPerMTok: 0.5 })
    expect(resolveModelPricing("fable")).toMatchObject({ inputPerMTok: 10, outputPerMTok: 50 })
  })

  it("strips the [1m] extended-context suffix", () => {
    expect(resolveModelPricing("opus[1m]")).toMatchObject({ inputPerMTok: 4 })
    expect(resolveModelPricing("sonnet[1m]")).toMatchObject({ inputPerMTok: 2 })
    expect(resolveModelPricing("fable[1m]")).toMatchObject({ inputPerMTok: 10 })
  })

  it("resolves concrete API model IDs", () => {
    expect(resolveModelPricing("claude-opus-4-8")).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 })
    expect(resolveModelPricing("claude-sonnet-4-6")).toMatchObject({ inputPerMTok: 3 })
    expect(resolveModelPricing("claude-fable-5-1")).toMatchObject({ inputPerMTok: 10 })
    expect(resolveModelPricing("claude-fable-5")).toMatchObject({ inputPerMTok: 10 })
    expect(resolveModelPricing("claude-mythos-5-1")).toMatchObject({ inputPerMTok: 10 })
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
    const opus = resolveModelPricing("claude-opus-5")!
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
    expect(resolveModelPricing("haiku", overrides)!.inputPerMTok).toBe(0.1)
  })
})

describe("estimateRequestCostUsd", () => {
  it("uses the Haiku 5.5 tier for the entire request strictly above 100,000 prompt tokens", () => {
    for (const model of ["haiku", "claude-haiku-5-5", "claude-haiku-5-5-20261007"]) {
      const pricing = resolveModelPricing(model)!
      for (const inputTokens of [99_999, 100_000, 100_001]) {
        const metric = makeMetric({ requestModel: model, inputTokens, outputTokens: 200_000 })
        const inputRate = inputTokens > 100_000 ? 0.5 : 0.1
        const outputRate = inputTokens > 100_000 ? 2.5 : 0.5
        expect(estimateRequestCostUsd(metric, pricing)).toBeCloseTo(inputTokens / 1e6 * inputRate + 0.2 * outputRate, 10)
      }
    }
  })

  it("counts both cache buckets in the tier boundary and prices all buckets at that tier", () => {
    const pricing = resolveModelPricing("claude-haiku-5-5")!
    const boundary = makeMetric({ inputTokens: 20_000, cacheReadInputTokens: 30_000, cacheCreationInputTokens: 50_000, outputTokens: 1_000 })
    expect(estimateRequestCostUsd(boundary, pricing)).toBeCloseTo(0.002 + 0.0003 + 0.00625 + 0.0005, 10)
    expect(estimateRequestCostUsd({ ...boundary, cacheReadInputTokens: 30_001 }, pricing)).toBeCloseTo(0.01 + 0.030001 * 0.05 + 0.03125 + 0.0025, 10)
    expect(estimateRequestCostUsd({ ...boundary, cacheCreationInputTokens: 50_001 }, pricing)).toBeCloseTo(0.01 + 0.0015 + 0.050001 * 0.625 + 0.0025, 10)
    // Cached-only prompts still trigger the long tier; missing uncached input is zero.
    expect(estimateRequestCostUsd(makeMetric({ cacheReadInputTokens: 100_001 }), pricing)).toBeCloseTo(0.100001 * 0.05, 10)
    expect(estimateRequestCostUsd(makeMetric({ cacheCreationInputTokens: 100_001 }), pricing)).toBeCloseTo(0.100001 * 0.625, 10)
    expect(estimateRequestCostUsd(makeMetric(), pricing)).toBe(0)
    expect(pricing).toEqual({ inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 })
  })

  it("preserves flat overrides, including overrides numerically equal to built-ins", () => {
    const model = "claude-haiku-5-5"
    const metric = makeMetric({ requestModel: model, inputTokens: 100_001, outputTokens: 1_000, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 30_000 })
    const flat = { inputPerMTok: 7, outputPerMTok: 11, cacheReadPerMTok: 0.3, cacheWritePerMTok: 2 }
    const short = { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 }
    for (const override of [flat, short, BUILTIN_MODEL_PRICING[model]!]) {
      const resolved = resolveModelPricing(model, { [model]: override })!
      const expected = 0.100001 * override.inputPerMTok + 0.001 * override.outputPerMTok + 0.02 * override.cacheReadPerMTok + 0.03 * override.cacheWritePerMTok
      expect(estimateRequestCostUsd(metric, resolved)).toBeCloseTo(expected, 10)
      expect(resolved).toEqual(override)
    }
  })

  it("computes cost from all four token buckets", () => {
    const pricing = resolveModelPricing("claude-opus-5")!
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
    const pricing = resolveModelPricing("claude-opus-5")!
    expect(estimateRequestCostUsd(makeMetric(), pricing)).toBe(0)
  })
})

describe("computeCostEstimate", () => {
  it.each([
    { name: "legacy bare alias retains current valuation", requestModel: undefined, resolvedModel: undefined, inputTokens: 10_000, expected: 0.0015 },
    { name: "legacy requested alias retains current valuation", requestModel: "haiku", resolvedModel: undefined, inputTokens: 10_000, expected: 0.0015 },
    { name: "bare SDK alias pinned to 4.5", requestModel: undefined, resolvedModel: "claude-haiku-4-5", inputTokens: 10_000, expected: 0.015 },
    { name: "requested alias pinned to dated 4.5", requestModel: "haiku", resolvedModel: "claude-haiku-4-5-20251001", inputTokens: 10_000, expected: 0.015 },
    { name: "normalized requested alias pinned to 4.5", requestModel: " Haiku[1m] ", resolvedModel: " Claude-Haiku-4-5[1m] ", inputTokens: 10_000, expected: 0.015 },
    { name: "requested alias pinned to 5.5", requestModel: "haiku", resolvedModel: "claude-haiku-5-5", inputTokens: 10_000, expected: 0.0015 },
    { name: "4.5 pin stays flat above the 5.5 threshold", requestModel: "haiku", resolvedModel: "claude-haiku-4-5", inputTokens: 200_000, expected: 0.205 },
    { name: "5.5 pin selects the long tier", requestModel: "haiku", resolvedModel: "claude-haiku-5-5", inputTokens: 200_000, expected: 0.1025 },
    { name: "unknown pin falls back to explicit historical request", requestModel: "claude-haiku-4-5-20251001", resolvedModel: "unknown-model", inputTokens: 10_000, expected: 0.015 },
    { name: "unknown pin falls back to current alias valuation", requestModel: "haiku", resolvedModel: "unknown-model", inputTokens: 10_000, expected: 0.0015 },
  ])("prices $name without changing the group", ({ requestModel, resolvedModel, inputTokens, expected }) => {
    const metric = makeMetric({ model: "haiku", requestModel, resolvedModel, inputTokens, outputTokens: 1_000 })
    const estimate = computeCostEstimate([metric])
    const key = requestModel || metric.model
    expect(Object.keys(estimate.byModel)).toEqual([key])
    expect(estimate.byModel[key]!.estimatedUsd).toBe(expected)
    expect(estimate.totalUsd).toBe(expected)
    expect(estimate.unpricedRequestCount).toBe(0)
  })

  it("prices mixed effective pins per record within the same requested alias group", () => {
    const metrics = [
      makeMetric({ model: "haiku", requestModel: "haiku", resolvedModel: "claude-haiku-4-5", profileId: "historical", inputTokens: 10_000, outputTokens: 1_000 }),
      makeMetric({ model: "haiku", requestModel: "haiku", resolvedModel: "claude-haiku-5-5", profileId: "current", inputTokens: 10_000, outputTokens: 1_000 }),
      makeMetric({ model: "haiku", requestModel: "haiku", resolvedModel: "claude-haiku-5-5", profileId: "current", inputTokens: 200_000, outputTokens: 1_000 }),
      makeMetric({ model: "haiku", requestModel: "haiku", inputTokens: 10_000, outputTokens: 1_000 }),
    ]
    const estimate = computeCostEstimate(metrics)
    expect(estimate.byModel).toEqual({ haiku: { requests: 4, inputTokens: 230_000, outputTokens: 4_000, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedUsd: 0.1205 } })
    expect(estimate.byProfile).toEqual({ historical: { requests: 1, estimatedUsd: 0.015 }, current: { requests: 2, estimatedUsd: 0.104 }, default: { requests: 1, estimatedUsd: 0.0015 } })
    expect(estimate.totalUsd).toBe(0.1205)
    expect(computeSummary(metrics, 3_600_000).costEstimate).toEqual(estimate)
  })

  it.each([
    { name: "request alias override beats resolved-model override", requestModel: " Haiku[1m] ", requestedOverride: true, resolvedModel: "claude-haiku-5-5", expected: 0.403 },
    { name: "SDK alias override wins without requestModel", requestModel: undefined, requestedOverride: true, resolvedModel: "claude-haiku-4-5", expected: 0.403 },
    { name: "resolved-model override beats alias built-in", requestModel: "haiku", requestedOverride: false, resolvedModel: "claude-haiku-5-5", expected: 1.407 },
    { name: "resolved 4.5 override beats alias built-in", requestModel: "haiku", requestedOverride: false, resolvedModel: "claude-haiku-4-5", expected: 1.407 },
    { name: "explicit request-ID override beats resolved-model override", requestModel: "claude-haiku-4-5-20251001", requestedOverride: true, resolvedModel: "claude-haiku-5-5", expected: 0.403 },
  ])("keeps overrides flat: $name", ({ requestModel, requestedOverride, resolvedModel, expected }) => {
    const requestedKey = requestModel?.includes("20251001") ? requestModel : "haiku"
    const overrides = {
      [resolvedModel]: { inputPerMTok: 7, outputPerMTok: 7, cacheReadPerMTok: 7, cacheWritePerMTok: 7 },
      ...(requestedOverride ? { [requestedKey]: { inputPerMTok: 2, outputPerMTok: 3, cacheReadPerMTok: 4, cacheWritePerMTok: 5 } } : {}),
    }
    const estimate = computeCostEstimate([
      makeMetric({ model: "haiku", requestModel, resolvedModel, inputTokens: 200_000, outputTokens: 1_000 }),
    ], overrides)
    expect(estimate.totalUsd).toBe(expected)
    expect(estimate.byModel[requestModel || "haiku"]!.estimatedUsd).toBe(expected)
  })

  it.each(["haiku", "claude-haiku-5-5"])("keeps a reused built-in %s override flat and inputs immutable", (overrideKey) => {
    const metric = Object.freeze(makeMetric({ model: "haiku", resolvedModel: "claude-haiku-5-5", inputTokens: 200_000, outputTokens: 1_000 }))
    const metrics = [metric]
    Object.freeze(metrics)
    const overrides = Object.freeze({ [overrideKey]: BUILTIN_MODEL_PRICING[overrideKey]! })
    const before = structuredClone({ metrics, overrides, builtins: BUILTIN_MODEL_PRICING })
    const estimate = computeCostEstimate(metrics, overrides)
    expect(estimate.totalUsd).toBe(0.0205)
    expect({ metrics, overrides, builtins: BUILTIN_MODEL_PRICING }).toEqual(before)
  })

  it("keeps unknown request and pin records unpriced rather than inventing a rate", () => {
    const estimate = computeCostEstimate([
      makeMetric({ requestModel: "unknown-request", resolvedModel: "unknown-pin", inputTokens: 10_000 }),
    ])
    expect(estimate.byModel["unknown-request"]!.estimatedUsd).toBeNull()
    expect(estimate.unpricedRequestCount).toBe(1)
    expect(estimate.totalUsd).toBe(0)
  })

  it("tiers Haiku 5.5 per request before model and profile aggregation", () => {
    const metrics = [
      makeMetric({ requestModel: "claude-haiku-5-5", profileId: "personal", inputTokens: 100_000, outputTokens: 1_000 }),
      makeMetric({ requestModel: "claude-haiku-5-5", profileId: "personal", inputTokens: 100_001, outputTokens: 1_000 }),
      makeMetric({ model: "haiku", profileId: "work", cacheReadInputTokens: 100_001, outputTokens: 1_000 }),
      makeMetric({ requestModel: "claude-haiku-4-5-20251001", profileId: "work", inputTokens: 100_001, outputTokens: 1_000 }),
    ]
    const estimate = computeCostEstimate(metrics)
    expect(estimate.byModel["claude-haiku-5-5"]).toMatchObject({ requests: 2, inputTokens: 200_001, outputTokens: 2_000, estimatedUsd: 0.063001 })
    expect(estimate.byModel["haiku"]!.estimatedUsd).toBe(0.0075)
    expect(estimate.byModel["claude-haiku-4-5-20251001"]!.estimatedUsd).toBe(0.105001)
    expect(estimate.byProfile).toEqual({ personal: { requests: 2, estimatedUsd: 0.063001 }, work: { requests: 2, estimatedUsd: 0.112501 } })
    expect(estimate.totalUsd).toBe(0.175502)
    expect(estimate.unpricedRequestCount).toBe(0)
  })

  it("applies normalized flat Haiku overrides through aggregation and summary", () => {
    const overrides = {
      haiku: { inputPerMTok: 2, outputPerMTok: 3, cacheReadPerMTok: 4, cacheWritePerMTok: 5 },
      "claude-haiku-5-5-20261007": { inputPerMTok: 6, outputPerMTok: 7, cacheReadPerMTok: 8, cacheWritePerMTok: 9 },
    }
    const metrics = [
      makeMetric({ requestModel: " Haiku[1m] ", inputTokens: 200_000, outputTokens: 10_000, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 30_000 }),
      makeMetric({ requestModel: "claude-haiku-5-5-20261007", inputTokens: 200_000, outputTokens: 10_000, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 30_000 }),
    ]
    const estimate = computeCostEstimate(metrics, overrides)
    expect(estimate.byModel[" Haiku[1m] "]!.estimatedUsd).toBe(0.66)
    expect(estimate.byModel["claude-haiku-5-5-20261007"]!.estimatedUsd).toBe(1.7)
    expect(estimate.totalUsd).toBe(2.36)
    expect(computeSummary(metrics, 3_600_000, overrides).costEstimate).toEqual(estimate)
  })

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
    expect(estimate.byModel["opus"]!.estimatedUsd).toBeCloseTo(4, 6)
    expect(estimate.totalUsd).toBeCloseTo(9, 6)
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
