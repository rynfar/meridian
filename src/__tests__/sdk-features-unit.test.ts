/**
 * Unit tests for sdkFeatures.ts — per-adapter feature toggles and validation.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  validateFeatureUpdate,
  type AdapterFeatures,
} from "../proxy/sdkFeatures"

// ── validateFeatureUpdate ───────────────────────────────────────────

describe("validateFeatureUpdate", () => {
  it("accepts valid boolean fields", () => {
    const result = validateFeatureUpdate({ memory: false, sharedMemory: true })
    expect(result).toEqual({ memory: false, sharedMemory: true })
  })

  it("accepts webFetchPreflight and rejects a non-boolean", () => {
    expect(validateFeatureUpdate({ webFetchPreflight: false })).toEqual({ webFetchPreflight: false })
    expect(() => validateFeatureUpdate({ webFetchPreflight: "off" })).toThrow("webFetchPreflight must be a boolean")
  })

  it("accepts claudeAiConnectors and rejects a non-boolean", () => {
    expect(validateFeatureUpdate({ claudeAiConnectors: true })).toEqual({ claudeAiConnectors: true })
    expect(() => validateFeatureUpdate({ claudeAiConnectors: "yes" })).toThrow("claudeAiConnectors must be a boolean")
  })

  it("accepts codeSystemPrompt and clientSystemPrompt booleans", () => {
    expect(validateFeatureUpdate({ codeSystemPrompt: true })).toEqual({ codeSystemPrompt: true })
    expect(validateFeatureUpdate({ clientSystemPrompt: false })).toEqual({ clientSystemPrompt: false })
  })

  it("rejects non-boolean for system prompt toggles", () => {
    expect(() => validateFeatureUpdate({ codeSystemPrompt: "yes" })).toThrow("codeSystemPrompt must be a boolean")
    expect(() => validateFeatureUpdate({ clientSystemPrompt: 1 })).toThrow("clientSystemPrompt must be a boolean")
  })

  it("accepts valid thinking enum values", () => {
    expect(validateFeatureUpdate({ thinking: "adaptive" })).toEqual({ thinking: "adaptive" })
    expect(validateFeatureUpdate({ thinking: "enabled" })).toEqual({ thinking: "enabled" })
    expect(validateFeatureUpdate({ thinking: "disabled" })).toEqual({ thinking: "disabled" })
  })

  it("accepts valid number fields", () => {
    const result = validateFeatureUpdate({ maxBudgetUsd: 5.5 })
    expect(result).toEqual({ maxBudgetUsd: 5.5 })
  })

  it("accepts valid string fields", () => {
    const result = validateFeatureUpdate({ fallbackModel: "claude-haiku-4-5-20251001", additionalDirectories: "/tmp" })
    expect(result).toEqual({ fallbackModel: "claude-haiku-4-5-20251001", additionalDirectories: "/tmp" })
  })

  it("rejects non-object body", () => {
    expect(() => validateFeatureUpdate(null)).toThrow("body must be a JSON object")
    expect(() => validateFeatureUpdate("string")).toThrow("body must be a JSON object")
    expect(() => validateFeatureUpdate(42)).toThrow("body must be a JSON object")
    expect(() => validateFeatureUpdate([1, 2])).toThrow("body must be a JSON object")
  })

  it("rejects invalid thinking value", () => {
    expect(() => validateFeatureUpdate({ thinking: "banana" })).toThrow("thinking must be one of")
    expect(() => validateFeatureUpdate({ thinking: 123 })).toThrow("thinking must be one of")
  })

  it("rejects wrong type for boolean fields", () => {
    expect(() => validateFeatureUpdate({ memory: 1 })).toThrow("memory must be a boolean")
    expect(() => validateFeatureUpdate({ sharedMemory: null })).toThrow("sharedMemory must be a boolean")
  })

  it("accepts valid claudeMd enum values", () => {
    expect(validateFeatureUpdate({ claudeMd: "off" })).toEqual({ claudeMd: "off" })
    expect(validateFeatureUpdate({ claudeMd: "project" })).toEqual({ claudeMd: "project" })
    expect(validateFeatureUpdate({ claudeMd: "full" })).toEqual({ claudeMd: "full" })
  })

  it("rejects invalid claudeMd value", () => {
    expect(() => validateFeatureUpdate({ claudeMd: true })).toThrow("claudeMd must be one of")
    expect(() => validateFeatureUpdate({ claudeMd: "yes" })).toThrow("claudeMd must be one of")
  })

  it("rejects wrong type for number fields", () => {
    expect(() => validateFeatureUpdate({ maxBudgetUsd: "five" })).toThrow("maxBudgetUsd must be a finite number")
    expect(() => validateFeatureUpdate({ maxBudgetUsd: Infinity })).toThrow("maxBudgetUsd must be a finite number")
    expect(() => validateFeatureUpdate({ maxBudgetUsd: NaN })).toThrow("maxBudgetUsd must be a finite number")
  })

  it("rejects wrong type for string fields", () => {
    expect(() => validateFeatureUpdate({ fallbackModel: 123 })).toThrow("fallbackModel must be a string")
  })

  it("strips unrecognised keys", () => {
    const result = validateFeatureUpdate({ claudeMd: "full", unknownKey: "garbage", anotherBad: 42 })
    expect(result).toEqual({ claudeMd: "full" })
    expect((result as any).unknownKey).toBeUndefined()
    expect((result as any).anotherBad).toBeUndefined()
  })

  it("returns empty object for empty input", () => {
    expect(validateFeatureUpdate({})).toEqual({})
  })
})

// ── Config file roundtrip (contract tests) ──────────────────────────

describe("sdkFeatures config roundtrip", () => {
  const tempDir = join(tmpdir(), `meridian-sdk-features-test-${Date.now()}`)
  const tempFile = join(tempDir, "sdk-features.json")

  beforeEach(() => {
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("JSON roundtrip preserves adapter features", () => {
    const config = {
      crush: { claudeMd: true, memory: true, thinking: "adaptive" as const },
      opencode: { sharedMemory: true },
    }
    writeFileSync(tempFile, JSON.stringify(config, null, 2))
    const loaded = JSON.parse(readFileSync(tempFile, "utf-8"))
    expect(loaded.crush.claudeMd).toBe(true)
    expect(loaded.crush.thinking).toBe("adaptive")
    expect(loaded.opencode.sharedMemory).toBe(true)
  })

  it("merge semantics: spread preserves existing keys", () => {
    const initial = { crush: { claudeMd: true, memory: false } }
    writeFileSync(tempFile, JSON.stringify(initial))
    const config = JSON.parse(readFileSync(tempFile, "utf-8"))
    config.crush = { ...config.crush, memory: true }
    writeFileSync(tempFile, JSON.stringify(config, null, 2))
    const result = JSON.parse(readFileSync(tempFile, "utf-8"))
    expect(result.crush.claudeMd).toBe(true)
    expect(result.crush.memory).toBe(true)
  })

  it("delete removes adapter overrides", () => {
    const config = { crush: { claudeMd: true }, opencode: { memory: true } }
    writeFileSync(tempFile, JSON.stringify(config))
    const loaded = JSON.parse(readFileSync(tempFile, "utf-8"))
    delete loaded.crush
    writeFileSync(tempFile, JSON.stringify(loaded, null, 2))
    const result = JSON.parse(readFileSync(tempFile, "utf-8"))
    expect(result.crush).toBeUndefined()
    expect(result.opencode.memory).toBe(true)
  })

  it("corrupt JSON file is recoverable", () => {
    writeFileSync(tempFile, "not valid json{{{")
    let config = {}
    try {
      config = JSON.parse(readFileSync(tempFile, "utf-8"))
    } catch {
      config = {}
    }
    expect(config).toEqual({})
  })
})

// ── settings UI coverage ────────────────────────────────────────────

// The settings page can only configure adapters it lists in ADAPTER_LABELS.
// That list was written once (#349) and never updated, so `codex` (#654) and
// `cherry` (#481) silently had no UI — which is how the webFetchPreflight
// toggle came to render on seven adapters where it does nothing and none of
// the one where it does. Keep the two lists in lockstep.
describe("settings UI adapter coverage", () => {
  it("exposes every adapter in the registry, with no aliases", () => {
    const { getAllFeatureConfigs } = require("../proxy/sdkFeatures") as typeof import("../proxy/sdkFeatures")
    const { listAdapterNames } = require("../proxy/adapters/detect") as typeof import("../proxy/adapters/detect")

    // Not a hardcoded expected list — that is the bug this replaces. Adding an
    // adapter to ADAPTER_MAP must make it configurable with no second edit.
    expect(Object.keys(getAllFeatureConfigs()).sort()).toEqual(listAdapterNames().sort())
    // `cherrystudio` and `claudecode` are alias keys; they must collapse into
    // their canonical adapter rather than showing up as separate cards.
    expect(Object.keys(getAllFeatureConfigs())).not.toContain("cherrystudio")
    expect(Object.keys(getAllFeatureConfigs())).not.toContain("claudecode")
  })

  it("includes the adapters that were previously unreachable in the UI", () => {
    const { getAllFeatureConfigs } = require("../proxy/sdkFeatures") as typeof import("../proxy/sdkFeatures")
    const names = Object.keys(getAllFeatureConfigs())
    // cherry (#481) is the only adapter the WebFetch preflight toggle affects;
    // codex (#654) and claude-code were absent for the same hardcoded-list reason.
    expect(names).toContain("cherry")
    expect(names).toContain("codex")
    expect(names).toContain("claude-code")
  })

  it("renders adapters from the API response, not a hardcoded page list", () => {
    const { settingsPageHtml } = require("../telemetry/settingsPage") as typeof import("../telemetry/settingsPage")
    // The render loop must iterate the fetched config. Iterating ADAPTER_LABELS
    // is what made a new adapter invisible instead of merely unlabelled.
    expect(settingsPageHtml).toContain("for (const adapter of Object.keys(currentConfig))")
    expect(settingsPageHtml).not.toContain("Object.entries(ADAPTER_LABELS)")
  })

  it("falls back to the raw adapter name when no label exists", () => {
    const { settingsPageHtml } = require("../telemetry/settingsPage") as typeof import("../telemetry/settingsPage")
    expect(settingsPageHtml).toContain("ADAPTER_LABELS[adapter] || adapter")
  })
})
