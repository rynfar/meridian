/**
 * User-defined model pricing overrides.
 *
 * Lets users correct a stale built-in rate or define pricing for models the
 * static table in pricing.ts doesn't know about (custom routers, brand-new
 * releases). Overrides win over the built-in table in resolveModelPricing.
 *
 * Persisted to ~/.config/meridian/model-pricing.json (override the path with
 * MERIDIAN_PRICING_CONFIG). Read at request time with a short cache, so
 * settings-page edits show up on the next dashboard refresh without a proxy
 * restart. Mirrors the sdkFeatures.ts persistence pattern.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { env } from "../env"
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  normalizeModelKey,
  type ModelPricing,
} from "./pricing"

export type PricingOverrides = Record<string, ModelPricing>

const MAX_MODEL_KEY_LENGTH = 200

function getConfigPath(): string {
  const explicit = env("PRICING_CONFIG")
  if (explicit) return explicit
  const dir = join(homedir(), ".config", "meridian")
  return join(dir, "model-pricing.json")
}

let cachedOverrides: PricingOverrides | null = null
let cachedPath: string | null = null
let lastReadTime = 0
const CACHE_TTL_MS = 5000

function readOverrides(): PricingOverrides {
  const path = getConfigPath()
  const now = Date.now()
  if (cachedOverrides && cachedPath === path && now - lastReadTime < CACHE_TTL_MS) {
    return cachedOverrides
  }

  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
      const result: PricingOverrides = {}
      for (const [model, value] of Object.entries(raw)) {
        try {
          result[normalizeModelKey(model)] = validatePricingUpdate(value)
        } catch {
          // Skip malformed entries rather than discarding the whole file
        }
      }
      cachedOverrides = result
    } else {
      cachedOverrides = {}
    }
  } catch {
    cachedOverrides = {}
  }
  cachedPath = path
  lastReadTime = now
  return cachedOverrides
}

function writeOverrides(overrides: PricingOverrides): void {
  const path = getConfigPath()
  const tmp = `${path}.tmp`
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(overrides, null, 2))
    renameSync(tmp, path)
    cachedOverrides = overrides
    cachedPath = path
    lastReadTime = Date.now()
  } catch (e) {
    console.error("[pricing] write failed:", (e as Error).message)
  }
}

/** Current user-defined pricing overrides, keyed by normalized model string. */
export function getPricingOverrides(): PricingOverrides {
  return readOverrides()
}

/**
 * Validate a pricing update body into a complete ModelPricing.
 * inputPerMTok and outputPerMTok are required; cache rates are optional and
 * derived from the input rate (read 0.1x, write 1.25x) when omitted.
 * Throws on invalid input.
 */
export function validatePricingUpdate(raw: unknown): ModelPricing {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("body must be a JSON object")
  }
  const input = raw as Record<string, unknown>

  const readRate = (key: string, required: boolean): number | undefined => {
    const value = input[key]
    if (value === undefined || value === null || value === "") {
      if (required) throw new Error(`${key} is required`)
      return undefined
    }
    if (typeof value !== "number" || !isFinite(value) || value < 0) {
      throw new Error(`${key} must be a non-negative finite number`)
    }
    return value
  }

  const inputPerMTok = readRate("inputPerMTok", true)!
  const outputPerMTok = readRate("outputPerMTok", true)!
  const cacheReadPerMTok = readRate("cacheReadPerMTok", false) ?? inputPerMTok * CACHE_READ_MULTIPLIER
  const cacheWritePerMTok = readRate("cacheWritePerMTok", false) ?? inputPerMTok * CACHE_WRITE_MULTIPLIER

  return { inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok }
}

/** Validate the model key for an override. Throws on invalid input. */
export function validateModelKey(model: string): string {
  const normalized = normalizeModelKey(model)
  if (normalized.length === 0) throw new Error("model must be a non-empty string")
  if (normalized.length > MAX_MODEL_KEY_LENGTH) {
    throw new Error(`model must be at most ${MAX_MODEL_KEY_LENGTH} characters`)
  }
  return normalized
}

/** Create or replace the pricing override for a model. */
export function setPricingOverride(model: string, pricing: ModelPricing): void {
  const key = validateModelKey(model)
  const overrides = { ...readOverrides(), [key]: pricing }
  writeOverrides(overrides)
}

/** Remove the pricing override for a model (reverts to the built-in table). */
export function deletePricingOverride(model: string): void {
  const key = validateModelKey(model)
  const overrides = { ...readOverrides() }
  delete overrides[key]
  writeOverrides(overrides)
}

/** Reset the read cache — for testing only (path changes between tests). */
export function resetPricingOverridesCache(): void {
  cachedOverrides = null
  cachedPath = null
  lastReadTime = 0
}
