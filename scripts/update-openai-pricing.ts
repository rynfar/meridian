#!/usr/bin/env bun
/**
 * Regenerate src/telemetry/openaiPricingData.ts from models.dev (primary) and
 * LiteLLM (cross-check), guarded by the hand-maintained official rates in
 * src/telemetry/openaiOfficialPricing.ts. See openaiPricingUpdate.ts for the
 * validation rules.
 *
 *   bun scripts/update-openai-pricing.ts          # rewrite the table if it changed
 *   bun scripts/update-openai-pricing.ts --check  # exit 2 if it would change
 *
 * Exits 1 without touching the file when any check fails.
 * Run daily by .github/workflows/update-openai-pricing.yml.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OFFICIAL_OPENAI_PRICING } from "../src/telemetry/openaiOfficialPricing"
import { OPENAI_MODEL_PRICING } from "../src/telemetry/openaiPricingData"
import { updateOpenAiPricing } from "../src/telemetry/openaiPricingUpdate"

const DATA_PATH = join(import.meta.dir, "..", "src", "telemetry", "openaiPricingData.ts")

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

const result = await updateOpenAiPricing(fetchJson, {
  official: OFFICIAL_OPENAI_PRICING,
  previous: OPENAI_MODEL_PRICING,
})

for (const note of result.notes) console.log(`note: ${note}`)
if (result.moduleText === null) {
  for (const error of result.errors) console.error(`error: ${error}`)
  console.error(`OpenAI pricing update failed with ${result.errors.length} error(s); table left unchanged.`)
  process.exit(1)
}

const changed = readFileSync(DATA_PATH, "utf-8") !== result.moduleText
console.log(`${Object.keys(result.table).length} OpenAI models priced; table ${changed ? "changed" : "unchanged"}.`)
if (changed) {
  if (process.argv.includes("--check")) process.exit(2)
  writeFileSync(DATA_PATH, result.moduleText)
}
