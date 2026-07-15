import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  validatePricingUpdate,
  validateModelKey,
  getPricingOverrides,
  setPricingOverride,
  deletePricingOverride,
  resetPricingOverridesCache,
} from "../telemetry/pricingStore"
import { resolveModelPricing } from "../telemetry/pricing"

describe("validatePricingUpdate", () => {
  it("accepts full rate objects", () => {
    const result = validatePricingUpdate({
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
    })
    expect(result).toEqual({
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
    })
  })

  it("derives cache rates from the input rate when omitted", () => {
    const result = validatePricingUpdate({ inputPerMTok: 4, outputPerMTok: 20 })
    expect(result.cacheReadPerMTok).toBeCloseTo(0.4, 10)
    expect(result.cacheWritePerMTok).toBeCloseTo(5, 10)
  })

  it("requires inputPerMTok and outputPerMTok", () => {
    expect(() => validatePricingUpdate({ outputPerMTok: 20 })).toThrow("inputPerMTok is required")
    expect(() => validatePricingUpdate({ inputPerMTok: 4 })).toThrow("outputPerMTok is required")
  })

  it("rejects negative, non-finite, and non-numeric rates", () => {
    expect(() => validatePricingUpdate({ inputPerMTok: -1, outputPerMTok: 20 })).toThrow("non-negative")
    expect(() => validatePricingUpdate({ inputPerMTok: Infinity, outputPerMTok: 20 })).toThrow("non-negative")
    expect(() => validatePricingUpdate({ inputPerMTok: "5", outputPerMTok: 20 })).toThrow("non-negative")
    expect(() => validatePricingUpdate({ inputPerMTok: 5, outputPerMTok: 20, cacheReadPerMTok: -0.1 })).toThrow("non-negative")
  })

  it("rejects non-object bodies", () => {
    expect(() => validatePricingUpdate(null)).toThrow("JSON object")
    expect(() => validatePricingUpdate([1])).toThrow("JSON object")
    expect(() => validatePricingUpdate("x")).toThrow("JSON object")
  })

  it("accepts zero rates (free models)", () => {
    const result = validatePricingUpdate({ inputPerMTok: 0, outputPerMTok: 0 })
    expect(result).toEqual({ inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 })
  })
})

describe("validateModelKey", () => {
  it("normalizes case, whitespace, and the [1m] suffix", () => {
    expect(validateModelKey("  Claude-Opus-4-8  ")).toBe("claude-opus-4-8")
    expect(validateModelKey("opus[1m]")).toBe("opus")
  })

  it("rejects empty and oversized keys", () => {
    expect(() => validateModelKey("")).toThrow("non-empty")
    expect(() => validateModelKey("   ")).toThrow("non-empty")
    expect(() => validateModelKey("x".repeat(201))).toThrow("at most 200")
  })
})

describe("pricing override persistence", () => {
  let dir: string
  let configPath: string
  const savedEnv = { meridian: undefined as string | undefined, legacy: undefined as string | undefined }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-pricing-test-"))
    configPath = join(dir, "model-pricing.json")
    savedEnv.meridian = process.env.MERIDIAN_PRICING_CONFIG
    savedEnv.legacy = process.env.CLAUDE_PROXY_PRICING_CONFIG
    process.env.MERIDIAN_PRICING_CONFIG = configPath
    delete process.env.CLAUDE_PROXY_PRICING_CONFIG
    resetPricingOverridesCache()
  })

  afterEach(() => {
    if (savedEnv.meridian === undefined) delete process.env.MERIDIAN_PRICING_CONFIG
    else process.env.MERIDIAN_PRICING_CONFIG = savedEnv.meridian
    if (savedEnv.legacy === undefined) delete process.env.CLAUDE_PROXY_PRICING_CONFIG
    else process.env.CLAUDE_PROXY_PRICING_CONFIG = savedEnv.legacy
    resetPricingOverridesCache()
    rmSync(dir, { recursive: true, force: true })
  })

  it("returns empty overrides when no file exists", () => {
    expect(getPricingOverrides()).toEqual({})
  })

  it("persists, reads back, and deletes an override", () => {
    const pricing = validatePricingUpdate({ inputPerMTok: 7, outputPerMTok: 35 })
    setPricingOverride("my-custom-model", pricing)

    expect(existsSync(configPath)).toBe(true)
    expect(getPricingOverrides()["my-custom-model"]).toEqual(pricing)

    // Survives a cache reset (fresh read from disk)
    resetPricingOverridesCache()
    expect(getPricingOverrides()["my-custom-model"]).toEqual(pricing)

    deletePricingOverride("my-custom-model")
    expect(getPricingOverrides()).toEqual({})
  })

  it("normalizes the model key on write", () => {
    setPricingOverride("  My-Model[1m] ", validatePricingUpdate({ inputPerMTok: 1, outputPerMTok: 2 }))
    expect(Object.keys(getPricingOverrides())).toEqual(["my-model"])
  })

  it("skips malformed entries in the file instead of discarding it", () => {
    setPricingOverride("good-model", validatePricingUpdate({ inputPerMTok: 1, outputPerMTok: 2 }))
    const raw = JSON.parse(readFileSync(configPath, "utf-8"))
    raw["bad-model"] = { inputPerMTok: "not-a-number" }
    const { writeFileSync } = require("node:fs") as typeof import("node:fs")
    writeFileSync(configPath, JSON.stringify(raw))
    resetPricingOverridesCache()

    const overrides = getPricingOverrides()
    expect(overrides["good-model"]).toBeDefined()
    expect(overrides["bad-model"]).toBeUndefined()
  })

  it("feeds resolveModelPricing: overrides beat the built-in table", () => {
    setPricingOverride("claude-opus-4-8", validatePricingUpdate({ inputPerMTok: 9, outputPerMTok: 45 }))
    const overrides = getPricingOverrides()

    expect(resolveModelPricing("claude-opus-4-8", overrides)!.inputPerMTok).toBe(9)
    // [1m] and case variants resolve to the same override
    expect(resolveModelPricing("Claude-Opus-4-8[1m]", overrides)!.inputPerMTok).toBe(9)
    // Without overrides the built-in rate still applies
    expect(resolveModelPricing("claude-opus-4-8")!.inputPerMTok).toBe(5)
  })

  it("feeds resolveModelPricing: overrides price otherwise-unknown models", () => {
    setPricingOverride("my-router-model", validatePricingUpdate({ inputPerMTok: 2, outputPerMTok: 4 }))
    const overrides = getPricingOverrides()

    expect(resolveModelPricing("my-router-model")).toBeNull()
    expect(resolveModelPricing("my-router-model", overrides)!.outputPerMTok).toBe(4)
  })
})
