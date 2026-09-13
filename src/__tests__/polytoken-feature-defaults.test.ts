/**
 * Polytoken native feature defaults — direct unit tests over sdkFeatures.
 *
 * Native defaults (plan contract):
 *   codeSystemPrompt false (no Claude Code preset — the client owns its prompt)
 *   clientSystemPrompt true (the client's own prompt IS the prompt)
 *   claudeMd off, memory/dreaming/sharedMemory false
 *   supportsThinking true (signed/redacted thinking preserved through the
 *   native response paths — thinkingPassthrough:false is NOT a new
 *   signature-stripping control; the existing thinking-generation and
 *   thinking-forwarding controls keep their documented semantics)
 *
 * Explicit user overrides and instance feature overrides keep their existing
 * precedence: user config > instance features > adapter defaults > global.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { getFeaturesForAdapter, getExplicitThinking } from "../proxy/sdkFeatures"

const savedConfigDir = process.env.MERIDIAN_CONFIG_DIR

beforeEach(() => {
  process.env.MERIDIAN_CONFIG_DIR = `/tmp/meridian-polytoken-features-${Date.now()}-${Math.random().toString(36).slice(2)}`
})

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.MERIDIAN_CONFIG_DIR
  else process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
})

describe("polytoken native feature defaults", () => {
  it("ships the native defaults (no preset, client prompt on, no memory, claudeMd off)", () => {
    const f = getFeaturesForAdapter("polytoken")
    expect(f.codeSystemPrompt).toBe(false)
    expect(f.clientSystemPrompt).toBe(true)
    expect(f.claudeMd).toBe("off")
    expect(f.memory).toBe(false)
    expect(f.dreaming).toBe(false)
    expect(f.sharedMemory).toBe(false)
  })

  it("defaults thinking off as a no-op (client can still request it per-request)", () => {
    const f = getFeaturesForAdapter("polytoken")
    expect(f.thinking).toBe("disabled")
    expect(f.thinkingPassthrough).toBe(false)
    // No explicit thinking setting: per-request client thinking stays possible.
    expect(getExplicitThinking("polytoken")).toBeUndefined()
  })

  it("explicit user overrides win over native defaults", () => {
    // Write a config through the module's own persistence path.
    const { updateAdapterFeatures } = require("../proxy/sdkFeatures") as typeof import("../proxy/sdkFeatures")
    updateAdapterFeatures("polytoken", { codeSystemPrompt: true, thinking: "enabled" })
    const f = getFeaturesForAdapter("polytoken")
    expect(f.codeSystemPrompt).toBe(true)
    expect(f.thinking).toBe("enabled")
    expect(getExplicitThinking("polytoken")).toBe("enabled")
  })
})