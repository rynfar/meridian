import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { computeCostEstimate, estimateRequestCostUsd, resolveModelPricing, type ModelPricing } from "../telemetry/pricing"
import { OFFICIAL_OPENAI_PRICING } from "../telemetry/openaiOfficialPricing"
import { OPENAI_MODEL_PRICING } from "../telemetry/openaiPricingData"
import {
  LITELLM_URL,
  MODELS_DEV_URL,
  REQUIRED_OPENAI_MODELS,
  buildOpenAiPricing,
  parseLiteLlm,
  parseModelsDev,
  renderOpenAiPricingModule,
  updateOpenAiPricing,
  type CatalogRates,
} from "../telemetry/openaiPricingUpdate"
import type { RequestMetric } from "../telemetry/types"

function makeMetric(overrides: Partial<RequestMetric> = {}): RequestMetric {
  return {
    requestId: "req-gpt",
    timestamp: Date.now(),
    model: "gpt-6-sol",
    mode: "stream",
    isResume: false,
    isPassthrough: false,
    status: 200,
    queueWaitMs: 0,
    proxyOverheadMs: 0,
    ttfbMs: 0,
    upstreamDurationMs: 0,
    totalDurationMs: 0,
    contentBlocks: 1,
    textEvents: 1,
    error: null,
    ...overrides,
  }
}

function catalog(input: number, cachedInput: number | null, output: number, cacheWrite: number | null = null): CatalogRates {
  return { input, cachedInput, output, cacheWrite }
}

describe("OpenAI pricing lookup", () => {
  it("prices every official model at its official rate", () => {
    for (const [id, official] of Object.entries(OFFICIAL_OPENAI_PRICING)) {
      expect(resolveModelPricing(id)).toMatchObject({
        inputPerMTok: official.input,
        cacheReadPerMTok: official.cachedInput,
        outputPerMTok: official.output,
      })
    }
  })

  it("prices every required Codex-backend model", () => {
    for (const id of REQUIRED_OPENAI_MODELS) expect(OPENAI_MODEL_PRICING[id]).toBeDefined()
  })

  it("prices effort-suffixed and dated selectors at the base model's rate", () => {
    const sol = resolveModelPricing("gpt-6-sol")
    expect(resolveModelPricing("gpt-6-sol-high")).toEqual(sol)
    expect(resolveModelPricing("GPT-6-Sol-XHigh")).toEqual(sol)
    expect(resolveModelPricing("gpt-5.5-2026-04-23")).toEqual(resolveModelPricing("gpt-5.5"))
    expect(resolveModelPricing("gpt-5.6-luna-max")).toEqual(resolveModelPricing("gpt-5.6-luna"))
  })

  it("leaves unknown GPT models unpriced instead of guessing a family rate", () => {
    expect(resolveModelPricing("gpt-7-nova")).toBeNull()
    expect(resolveModelPricing("gpt-4o")).toBeNull()
    expect(resolveModelPricing("gpt-5.4-pro")).toBeNull()
  })

  it("applies an override on the base model to its suffixed selectors", () => {
    const custom: ModelPricing = { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1 }
    expect(resolveModelPricing("gpt-6-sol-high", { "gpt-6-sol": custom })).toBe(custom)
    expect(resolveModelPricing("gpt-7-nova-high", { "gpt-7-nova": custom })).toBe(custom)
  })
})

describe("OpenAI cost math", () => {
  it("values cached input and reasoning tokens exactly once", () => {
    // Raw Responses usage: input_tokens 1,000,000 of which cached_tokens
    // 200,000; output_tokens 500,000 of which reasoning_tokens 300,000.
    // Telemetry records the uncached remainder as inputTokens and keeps
    // reasoning inside outputTokens.
    const metric = makeMetric({ inputTokens: 800_000, cacheReadInputTokens: 200_000, outputTokens: 500_000 })
    const cost = estimateRequestCostUsd(metric, resolveModelPricing("gpt-6-sol")!)
    // 0.8 * $2 + 0.2 * $0.20 + 0.5 * $10
    expect(cost).toBeCloseTo(1.6 + 0.04 + 5, 10)
  })

  it("counts GPT requests in the cost estimate instead of as unpriced", () => {
    const estimate = computeCostEstimate([
      makeMetric({ model: "gpt-6-luna-high", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      makeMetric({ model: "gpt-7-nova", inputTokens: 1_000_000 }),
    ])
    expect(estimate.byModel["gpt-6-luna-high"]!.estimatedUsd).toBeCloseTo(0.6, 6)
    expect(estimate.byModel["gpt-7-nova"]!.estimatedUsd).toBeNull()
    expect(estimate.unpricedRequestCount).toBe(1)
  })
})

describe("served-model pricing guard", () => {
  it("leaves a GPT id answered by Claude unpriced", () => {
    // /v1/responses maps an unknown id like gpt-5.5 to the sonnet tier.
    const estimate = computeCostEstimate([
      makeMetric({ model: "sonnet", requestModel: "gpt-5.5", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ])
    expect(estimate.byModel["gpt-5.5"]!.estimatedUsd).toBeNull()
    expect(estimate.unpricedRequestCount).toBe(1)
    expect(estimate.totalUsd).toBe(0)
  })

  it("prices a Claude-answered GPT id only through a user override", () => {
    const custom: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 }
    const metric = makeMetric({ model: "sonnet", requestModel: "gpt-5.5-high", inputTokens: 1_000_000 })
    expect(computeCostEstimate([metric], { "gpt-5.5-high": custom }).totalUsd).toBeCloseTo(3, 6)
    expect(computeCostEstimate([metric], { "gpt-5.5": custom }).totalUsd).toBeCloseTo(3, 6)
  })

  it("prices an OpenAI fallback at the model that served it", () => {
    const estimate = computeCostEstimate([
      makeMetric({ model: "gpt-6-sol", requestModel: "gpt-6-astra", inputTokens: 1_000_000 }),
    ])
    expect(estimate.byModel["gpt-6-astra"]!.estimatedUsd).toBeCloseTo(2, 6)
  })

  it("keeps pricing Claude requests by the client's exact id", () => {
    const estimate = computeCostEstimate([
      makeMetric({ model: "opus", requestModel: "claude-opus-5", inputTokens: 1_000_000 }),
    ])
    expect(estimate.byModel["claude-opus-5"]!.estimatedUsd).toBeCloseTo(5, 6)
  })
})

describe("catalog parsing", () => {
  it("reads OpenAI models from models.dev", () => {
    const parsed = parseModelsDev({
      openai: {
        models: {
          "gpt-6-sol": { cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } },
          "gpt-5.4-pro": { cost: { input: 30, output: 180 } },
          "text-embedding-3-small": { cost: { input: 0.02 } },
          broken: { cost: "free" },
        },
      },
      anthropic: { models: { "claude-opus-5": { cost: { input: 5, output: 25 } } } },
    })
    expect(parsed).toEqual({
      "gpt-6-sol": catalog(2, 0.2, 10, 2.5),
      "gpt-5.4-pro": catalog(30, null, 180),
    })
  })

  it("converts LiteLLM per-token OpenAI rates to per-1M without float noise", () => {
    const parsed = parseLiteLlm({
      "gpt-5.3-codex": {
        litellm_provider: "openai",
        input_cost_per_token: 1.75e-6,
        cache_read_input_token_cost: 1.75e-7,
        output_cost_per_token: 1.4e-5,
      },
      "openai/gpt-6-luna": {
        litellm_provider: "openai",
        input_cost_per_token: 1e-7,
        cache_read_input_token_cost: 1e-8,
        output_cost_per_token: 5e-7,
      },
      "azure/gpt-6-sol": { litellm_provider: "azure", input_cost_per_token: 1, output_cost_per_token: 1 },
      sample_spec: { note: "not a model" },
    })
    expect(parsed).toEqual({
      "gpt-5.3-codex": catalog(1.75, 0.175, 14),
      "gpt-6-luna": catalog(0.1, 0.01, 0.5),
    })
  })
})

describe("buildOpenAiPricing", () => {
  const official = { "gpt-6-sol": { input: 2, cachedInput: 0.2, output: 10 } }
  const base = {
    modelsDev: { "gpt-6-sol": catalog(2, 0.2, 10, 2.5) },
    litellm: { "gpt-6-sol": catalog(2, 0.2, 10), "gpt-5-codex": catalog(1.25, 0.125, 10) },
    official,
    previous: {},
    required: ["gpt-6-sol", "gpt-5-codex"],
  }

  it("prefers models.dev and falls back to LiteLLM for models it lacks", () => {
    const build = buildOpenAiPricing(base)
    expect(build.errors).toEqual([])
    expect(build.table["gpt-6-sol"]).toEqual({ inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 })
    expect(build.table["gpt-5-codex"]).toEqual({ inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheWritePerMTok: 1.25 })
    expect(build.sources).toEqual({ "gpt-6-sol": "models.dev", "gpt-5-codex": "litellm" })
  })

  it("fails when a required model has no cached-input price", () => {
    const build = buildOpenAiPricing({ ...base, litellm: { ...base.litellm, "gpt-5-codex": catalog(1.25, null, 10) } })
    expect(build.errors).toEqual(["gpt-5-codex: no cached-input price"])
  })

  it("fails when a previously priced model disappears from every source", () => {
    const previous = { "gpt-5.2": { inputPerMTok: 1.75, outputPerMTok: 14, cacheReadPerMTok: 0.175, cacheWritePerMTok: 1.75 } }
    const build = buildOpenAiPricing({ ...base, previous })
    expect(build.errors).toEqual(["gpt-5.2: missing from models.dev and LiteLLM"])
  })

  it("fails when the catalogs disagree beyond the tolerance", () => {
    const build = buildOpenAiPricing({ ...base, litellm: { ...base.litellm, "gpt-6-sol": catalog(2, 0.2, 12) } })
    expect(build.errors).toEqual(["gpt-6-sol: models.dev and LiteLLM disagree on output (10 vs 12)"])
    expect(build.table["gpt-6-sol"]).toBeUndefined()
  })

  it("accepts a difference within the tolerance", () => {
    const build = buildOpenAiPricing({ ...base, litellm: { ...base.litellm, "gpt-6-sol": catalog(2.01, 0.2, 10) } })
    expect(build.errors).toEqual([])
  })

  it("fails when both catalogs disagree with the official rates", () => {
    const build = buildOpenAiPricing({
      ...base,
      modelsDev: { "gpt-6-sol": catalog(3, 0.3, 10) },
      litellm: { ...base.litellm, "gpt-6-sol": catalog(3, 0.3, 10) },
    })
    expect(build.errors).toEqual([
      "gpt-6-sol: catalog and official rates disagree on input (3 vs 2)",
      "gpt-6-sol: catalog and official rates disagree on cachedInput (0.3 vs 0.2)",
    ])
  })

  it("fails when an official model is produced by no source", () => {
    const build = buildOpenAiPricing({
      ...base,
      official: { ...official, "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 } },
    })
    expect(build.errors).toEqual(["gpt-6-astra: listed in official rates but not produced by any source"])
  })

  it("adds new GPT text models from models.dev and skips other variants", () => {
    const build = buildOpenAiPricing({
      ...base,
      modelsDev: {
        ...base.modelsDev,
        "gpt-7": catalog(3, 0.3, 15),
        "gpt-7-pro": catalog(30, 3, 180),
        "gpt-7-chat-latest": catalog(3, 0.3, 15),
        "gpt-image-2": catalog(5, 0.5, 40),
        "gpt-4.1": catalog(2, 0.5, 8),
        "gpt-7-mini": catalog(0.5, null, 2),
      },
    })
    expect(build.errors).toEqual([])
    expect(Object.keys(build.table).sort()).toEqual(["gpt-5-codex", "gpt-6-sol", "gpt-7"])
    expect(build.notes).toContain("gpt-7: added from models.dev")
    expect(build.notes).toContain("gpt-7-mini: skipped new model without a cached-input price")
  })
})

describe("updateOpenAiPricing", () => {
  const modelsDevPayload = {
    openai: { models: { "gpt-6-sol": { cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } } } },
  }
  const litellmPayload = {
    "gpt-6-sol": { litellm_provider: "openai", input_cost_per_token: 2e-6, cache_read_input_token_cost: 2e-7, output_cost_per_token: 1e-5 },
  }
  const fixtures: Record<string, unknown> = { [MODELS_DEV_URL]: modelsDevPayload, [LITELLM_URL]: litellmPayload }
  const fetchFixture = async (url: string) => fixtures[url]
  const options = {
    official: { "gpt-6-sol": { input: 2, cachedInput: 0.2, output: 10 } },
    previous: {},
    required: ["gpt-6-sol"],
  }

  it("renders a deterministic module from fixture responses", async () => {
    const result = await updateOpenAiPricing(fetchFixture, options)
    expect(result.errors).toEqual([])
    expect(result.moduleText).toBe(renderOpenAiPricingModule(result.table, result.sources))
    expect(result.moduleText).toContain(
      '"gpt-6-sol": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 }, // models.dev',
    )
  })

  it("produces no module when a check fails", async () => {
    const result = await updateOpenAiPricing(fetchFixture, { ...options, required: ["gpt-6-sol", "gpt-5-codex"] })
    expect(result.moduleText).toBeNull()
    expect(result.errors).toEqual(["gpt-5-codex: missing from models.dev and LiteLLM"])
  })

  it("refuses an empty catalog response", async () => {
    await expect(updateOpenAiPricing(async url => (url === MODELS_DEV_URL ? {} : litellmPayload), options))
      .rejects.toThrow("models.dev returned no OpenAI models")
  })

  it("renders the committed table byte-for-byte", () => {
    const committed = readFileSync(join(import.meta.dir, "..", "telemetry", "openaiPricingData.ts"), "utf-8")
    const sources = Object.fromEntries(
      [...committed.matchAll(/^  "([^"]+)": .* \/\/ (models\.dev|litellm)$/gm)].map(m => [m[1]!, m[2] as "models.dev" | "litellm"]),
    )
    expect(renderOpenAiPricingModule(OPENAI_MODEL_PRICING, sources)).toBe(committed)
  })
})
