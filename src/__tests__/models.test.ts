/**
 * Unit tests for model mapping and utility functions.
 */
import { afterEach, beforeEach, describe, it, expect, mock } from "bun:test"

import { mapModelToClaudeModel, isClosedControllerError, resetCachedClaudeAuthStatus, stripExtendedContext, hasExtendedContext, recordExtendedContextUnavailable, recordExtendedContextRateLimited, isExtendedContextKnownUnavailable, resetExtendedContextUnavailable, resetWarnedTierOverrides, resolveSdkModelDefaults, subscriptionIncludesExtendedContext, CANONICAL_FABLE_MODEL, CANONICAL_OPUS_MODEL, CANONICAL_SONNET_MODEL, CANONICAL_HAIKU_MODEL } from "../proxy/models"

describe("mapModelToClaudeModel", () => {
  const originalSonnetModel = process.env.CLAUDE_PROXY_SONNET_MODEL

  afterEach(() => {
    if (originalSonnetModel === undefined) delete process.env.CLAUDE_PROXY_SONNET_MODEL
    else process.env.CLAUDE_PROXY_SONNET_MODEL = originalSonnetModel
    resetCachedClaudeAuthStatus()
  })

  it("maps opus 4.6 models to opus[1m]", () => {
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
    expect(mapModelToClaudeModel("opus")).toBe("opus[1m]")
  })

  it("maps opus 4.8 models to opus[1m]", () => {
    expect(mapModelToClaudeModel("claude-opus-4-8")).toBe("opus[1m]")
  })

  it("maps opus 4.5 models to opus (no 1M)", () => {
    expect(mapModelToClaudeModel("claude-opus-4-5")).toBe("opus")
  })

  it("maps haiku models to haiku", () => {
    expect(mapModelToClaudeModel("claude-haiku-4-5")).toBe("haiku")
    expect(mapModelToClaudeModel("haiku")).toBe("haiku")
  })

  it("maps sonnet 4.6 models to sonnet (200k) for max subscriptions by default", () => {
    // Sonnet [1m] requires Extra Usage on Max — default to 200k to avoid charges
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet")
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet")
  })

  it("maps sonnet 4.5 models to sonnet (no 1M regardless of subscription)", () => {
    expect(mapModelToClaudeModel("claude-sonnet-4-5")).toBe("sonnet")
    expect(mapModelToClaudeModel("claude-sonnet-4-5-20250929")).toBe("sonnet")
    expect(mapModelToClaudeModel("claude-sonnet-4-5", "max")).toBe("sonnet")
  })

  it("maps sonnet models to plain sonnet for non-max subscriptions", () => {
    expect(mapModelToClaudeModel("claude-sonnet-4-5", "team")).toBe("sonnet")
    expect(mapModelToClaudeModel("sonnet", "pro")).toBe("sonnet")
    expect(mapModelToClaudeModel("claude-sonnet-4-5-20250929", "")).toBe("sonnet")
  })

  it("defaults unknown models to plain sonnet for non-max subscriptions", () => {
    expect(mapModelToClaudeModel("unknown-model")).toBe("sonnet")
    expect(mapModelToClaudeModel("", undefined)).toBe("sonnet")
  })

  it("respects explicit sonnet[1m] override when opted in", () => {
    process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet[1m]"
    expect(mapModelToClaudeModel("sonnet", "team")).toBe("sonnet[1m]")
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet[1m]")
  })

  it("sonnet[1m] override still skips [1m] for subagents", () => {
    process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet[1m]"
    expect(mapModelToClaudeModel("sonnet", "max", "subagent")).toBe("sonnet")
  })

  it("sonnet[1m] override still skips [1m] during cooldown", () => {
    process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet[1m]"
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet")
    resetExtendedContextUnavailable()
  })

  describe("MERIDIAN_1M_CONTEXT_SUPPORT opt-out", () => {
    afterEach(() => {
      delete process.env.MERIDIAN_1M_CONTEXT_SUPPORT
      delete process.env.CLAUDE_PROXY_1M_CONTEXT_SUPPORT
      delete process.env.CLAUDE_PROXY_SONNET_MODEL
    })

    it("downgrades opus[1m] to opus when disabled", () => {
      process.env.MERIDIAN_1M_CONTEXT_SUPPORT = "0"
      expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus")
      expect(mapModelToClaudeModel("opus")).toBe("opus")
    })

    it("downgrades sonnet[1m] override to sonnet when disabled", () => {
      process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet[1m]"
      process.env.MERIDIAN_1M_CONTEXT_SUPPORT = "0"
      expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet")
    })

    it("accepts false/no spellings and the CLAUDE_PROXY_ alias", () => {
      process.env.MERIDIAN_1M_CONTEXT_SUPPORT = "false"
      expect(mapModelToClaudeModel("opus")).toBe("opus")
      process.env.MERIDIAN_1M_CONTEXT_SUPPORT = "no"
      expect(mapModelToClaudeModel("opus")).toBe("opus")
      delete process.env.MERIDIAN_1M_CONTEXT_SUPPORT
      process.env.CLAUDE_PROXY_1M_CONTEXT_SUPPORT = "0"
      expect(mapModelToClaudeModel("opus")).toBe("opus")
    })

    it("leaves 1M selection intact for other values", () => {
      process.env.MERIDIAN_1M_CONTEXT_SUPPORT = "1"
      expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
    })
  })

  describe("fable 5", () => {
    afterEach(() => {
      resetExtendedContextUnavailable()
      delete process.env.MERIDIAN_1M_CONTEXT_SUPPORT
    })

    it("maps fable to fable[1m] for primary agents (mirrors opus)", () => {
      expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable[1m]")
      expect(mapModelToClaudeModel("fable")).toBe("fable[1m]")
      expect(mapModelToClaudeModel("claude-fable-5", "max")).toBe("fable[1m]")
      expect(mapModelToClaudeModel("claude-fable-5", "max", "primary")).toBe("fable[1m]")
    })

    it("gives subagents base fable regardless of subscription", () => {
      expect(mapModelToClaudeModel("claude-fable-5", "max", "subagent")).toBe("fable")
      expect(mapModelToClaudeModel("fable", "max", "subagent")).toBe("fable")
    })

    it("downgrades fable[1m] to fable during the Extra Usage cooldown", () => {
      recordExtendedContextUnavailable()
      expect(mapModelToClaudeModel("claude-fable-5", "max")).toBe("fable")
    })

    it("downgrades fable[1m] to fable when MERIDIAN_1M_CONTEXT_SUPPORT=0", () => {
      process.env.MERIDIAN_1M_CONTEXT_SUPPORT = "0"
      expect(mapModelToClaudeModel("claude-fable-5", "max")).toBe("fable")
    })

    it("stripExtendedContext and hasExtendedContext handle fable[1m]", () => {
      expect(stripExtendedContext("fable[1m]")).toBe("fable")
      expect(hasExtendedContext("fable[1m]")).toBe(true)
      expect(hasExtendedContext("fable")).toBe(false)
    })
  })

  describe("mythos 5 (rides the fable tier)", () => {
    afterEach(() => {
      resetExtendedContextUnavailable()
      delete process.env.MERIDIAN_1M_CONTEXT_SUPPORT
    })

    it("maps mythos to fable[1m] for primary agents instead of falling through to sonnet", () => {
      expect(mapModelToClaudeModel("claude-mythos-5")).toBe("fable[1m]")
      expect(mapModelToClaudeModel("mythos")).toBe("fable[1m]")
      expect(mapModelToClaudeModel("claude-mythos-5", "max", "primary")).toBe("fable[1m]")
    })

    it("gives subagents base fable", () => {
      expect(mapModelToClaudeModel("claude-mythos-5", "max", "subagent")).toBe("fable")
    })

    it("downgrades to base fable during the Extra Usage cooldown", () => {
      recordExtendedContextUnavailable()
      expect(mapModelToClaudeModel("claude-mythos-5", "max")).toBe("fable")
    })

    it("downgrades to base fable when MERIDIAN_1M_CONTEXT_SUPPORT=0", () => {
      process.env.MERIDIAN_1M_CONTEXT_SUPPORT = "0"
      expect(mapModelToClaudeModel("claude-mythos-5", "max")).toBe("fable")
    })
  })

  describe("subagent mode", () => {
    it("gives subagents base sonnet regardless of subscription", () => {
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", "subagent")).toBe("sonnet")
      expect(mapModelToClaudeModel("sonnet", "max", "subagent")).toBe("sonnet")
    })

    it("gives subagents base opus regardless of subscription", () => {
      expect(mapModelToClaudeModel("claude-opus-4-6", "max", "subagent")).toBe("opus")
      expect(mapModelToClaudeModel("opus", "max", "subagent")).toBe("opus")
    })

    it("haiku is unaffected by agent mode", () => {
      expect(mapModelToClaudeModel("claude-haiku-4-5", "max", "subagent")).toBe("haiku")
    })

    it("primary agents get opus[1m] but sonnet (200k) for max subscription", () => {
      // Opus [1m] is included with Max; Sonnet [1m] requires Extra Usage
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", "primary")).toBe("sonnet")
      expect(mapModelToClaudeModel("claude-opus-4-6", "max", "primary")).toBe("opus[1m]")
    })

    it("null or missing agentMode behaves as primary", () => {
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", null)).toBe("sonnet")
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", undefined)).toBe("sonnet")
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet")
    })

    it("env var override to sonnet[1m] is still blocked for subagents", () => {
      process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet[1m]"
      // Subagents always use base model even with override
      expect(mapModelToClaudeModel("sonnet", "max", "subagent")).toBe("sonnet")
    })
  })
})

describe("per-tier 1M overrides", () => {
  const saved: Record<string, string | undefined> = {}
  // Sonnet's vars and the global 1M switch are cleared too: the regression
  // guard below asserts every tier's default, and the suite shares one
  // process — a leaked MERIDIAN_SONNET_MODEL or MERIDIAN_1M_CONTEXT_SUPPORT
  // from another file would fail it spuriously.
  const KEYS = [
    "MERIDIAN_FABLE_MODEL", "CLAUDE_PROXY_FABLE_MODEL",
    "MERIDIAN_OPUS_MODEL", "CLAUDE_PROXY_OPUS_MODEL",
    "MERIDIAN_SONNET_MODEL", "CLAUDE_PROXY_SONNET_MODEL",
    "MERIDIAN_1M_CONTEXT_SUPPORT", "CLAUDE_PROXY_1M_CONTEXT_SUPPORT",
  ]

  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
    resetExtendedContextUnavailable()
    resetWarnedTierOverrides()
  })

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    resetExtendedContextUnavailable()
    resetWarnedTierOverrides()
  })

  // THE REGRESSION GUARD. Every existing install has neither variable set;
  // this asserts they see exactly today's behaviour. If the new check is
  // misplaced, this fails.
  it("with no override set, defaults are unchanged", () => {
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable[1m]")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
    expect(mapModelToClaudeModel("claude-sonnet-4-6")).toBe("sonnet")
    expect(mapModelToClaudeModel("claude-haiku-4-5-20251001")).toBe("haiku")
  })

  it("MERIDIAN_FABLE_MODEL=fable forces the base variant", () => {
    process.env.MERIDIAN_FABLE_MODEL = "fable"
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable")
  })

  it("MERIDIAN_OPUS_MODEL=opus forces the base variant", () => {
    process.env.MERIDIAN_OPUS_MODEL = "opus"
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus")
  })

  // The complaint in #702: the only existing lever is global, so opting out of
  // fable 1M also gave up opus 1M. The override must be tier-scoped.
  it("the fable override does not affect opus", () => {
    process.env.MERIDIAN_FABLE_MODEL = "fable"
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
  })

  it("the opus override does not affect fable", () => {
    process.env.MERIDIAN_OPUS_MODEL = "opus"
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus")
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable[1m]")
  })

  it("neither override affects sonnet or haiku", () => {
    process.env.MERIDIAN_FABLE_MODEL = "fable"
    process.env.MERIDIAN_OPUS_MODEL = "opus"
    expect(mapModelToClaudeModel("claude-sonnet-4-6")).toBe("sonnet")
    expect(mapModelToClaudeModel("claude-haiku-4-5-20251001")).toBe("haiku")
  })

  it("explicit [1m] values are accepted as a documented no-op", () => {
    process.env.MERIDIAN_FABLE_MODEL = "fable[1m]"
    process.env.MERIDIAN_OPUS_MODEL = "opus[1m]"
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable[1m]")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
  })

  it("an unrecognized value is ignored, not treated as an opt-out", () => {
    process.env.MERIDIAN_FABLE_MODEL = "nonsense"
    process.env.MERIDIAN_OPUS_MODEL = ""
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable[1m]")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
  })

  // These are opt-outs, unlike MERIDIAN_SONNET_MODEL's opt-in: a typo there
  // fails safe (no billing), but the identical typo here fails unsafe (the
  // user keeps being billed for [1m]). Values must be normalized so
  // whitespace/case typos from launchd plists, docker-compose, or quoted
  // .env lines don't silently defeat the opt-out.
  it("surrounding whitespace is normalized", () => {
    process.env.MERIDIAN_FABLE_MODEL = "  fable  "
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable")
  })

  it("case is normalized", () => {
    process.env.MERIDIAN_FABLE_MODEL = "Fable"
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable")
  })

  it("case is normalized for opus", () => {
    process.env.MERIDIAN_OPUS_MODEL = "OPUS"
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus")
  })

  it("the [1m] no-op tolerates whitespace/case and warns nothing", () => {
    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")) }
    try {
      process.env.MERIDIAN_FABLE_MODEL = " fable[1m] "
      expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable[1m]")
      expect(warnings.length).toBe(0)
    } finally {
      console.warn = originalWarn
    }
  })

  it("warns at most once per process per variable for an unrecognized value", () => {
    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")) }
    try {
      process.env.MERIDIAN_FABLE_MODEL = "typo-fable"
      mapModelToClaudeModel("claude-fable-5")
      mapModelToClaudeModel("claude-fable-5")
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain("MERIDIAN_FABLE_MODEL")
    } finally {
      console.warn = originalWarn
    }
  })

  it("the CLAUDE_PROXY_ aliases work identically", () => {
    process.env.CLAUDE_PROXY_FABLE_MODEL = "fable"
    process.env.CLAUDE_PROXY_OPUS_MODEL = "opus"
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus")
  })

  it("MERIDIAN_ takes precedence over CLAUDE_PROXY_", () => {
    process.env.CLAUDE_PROXY_FABLE_MODEL = "fable"
    process.env.MERIDIAN_FABLE_MODEL = "fable[1m]"
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable[1m]")
  })

  // Mythos routes into the fable branch, so the fable switch must cover it.
  it("the fable override covers mythos, which rides the fable tier", () => {
    process.env.MERIDIAN_FABLE_MODEL = "fable"
    expect(mapModelToClaudeModel("claude-mythos-5")).toBe("fable")
  })

  it("subagents still get the base variant regardless of override", () => {
    expect(mapModelToClaudeModel("claude-fable-5", "max", "subagent")).toBe("fable")
    process.env.MERIDIAN_FABLE_MODEL = "fable[1m]"
    expect(mapModelToClaudeModel("claude-fable-5", "max", "subagent")).toBe("fable")
  })

  it("the Extra Usage cooldown still forces the base variant", () => {
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-fable-5")).toBe("fable")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus")
  })
})

// NOTE: getClaudeAuthStatusAsync and Auth status resilience tests are in
// models-auth-status.test.ts — they run in isolation because they manipulate
// process.env.PATH and global auth caches that leak across test files.


describe("stripExtendedContext", () => {
  it("strips [1m] from opus", () => {
    expect(stripExtendedContext("opus[1m]")).toBe("opus")
  })

  it("strips [1m] from sonnet", () => {
    expect(stripExtendedContext("sonnet[1m]")).toBe("sonnet")
  })

  it("returns haiku unchanged", () => {
    expect(stripExtendedContext("haiku")).toBe("haiku")
  })

  it("returns base models unchanged", () => {
    expect(stripExtendedContext("opus")).toBe("opus")
    expect(stripExtendedContext("sonnet")).toBe("sonnet")
  })
})

describe("hasExtendedContext", () => {
  it("returns true for [1m] models", () => {
    expect(hasExtendedContext("opus[1m]")).toBe(true)
    expect(hasExtendedContext("sonnet[1m]")).toBe(true)
  })

  it("returns false for base models", () => {
    expect(hasExtendedContext("opus")).toBe(false)
    expect(hasExtendedContext("sonnet")).toBe(false)
    expect(hasExtendedContext("haiku")).toBe(false)
  })
})

describe("subscriptionIncludesExtendedContext", () => {
  it("includes max and its usage variants", () => {
    expect(subscriptionIncludesExtendedContext("max")).toBe(true)
    expect(subscriptionIncludesExtendedContext("max_5x")).toBe(true)
    expect(subscriptionIncludesExtendedContext("max_20x")).toBe(true)
  })

  it("includes team and enterprise", () => {
    expect(subscriptionIncludesExtendedContext("team")).toBe(true)
    expect(subscriptionIncludesExtendedContext("enterprise")).toBe(true)
  })

  it("excludes pro, free, and unknown tiers", () => {
    expect(subscriptionIncludesExtendedContext("pro")).toBe(false)
    expect(subscriptionIncludesExtendedContext("free")).toBe(false)
    expect(subscriptionIncludesExtendedContext("something-else")).toBe(false)
  })

  it("is case and whitespace insensitive", () => {
    expect(subscriptionIncludesExtendedContext("  Team ")).toBe(true)
    expect(subscriptionIncludesExtendedContext("MAX_20X")).toBe(true)
  })

  it("excludes missing or empty tiers", () => {
    expect(subscriptionIncludesExtendedContext(undefined)).toBe(false)
    expect(subscriptionIncludesExtendedContext(null)).toBe(false)
    expect(subscriptionIncludesExtendedContext("")).toBe(false)
    expect(subscriptionIncludesExtendedContext("   ")).toBe(false)
  })
})

describe("Extra Usage cooldown", () => {
  beforeEach(() => resetExtendedContextUnavailable())
  afterEach(() => resetExtendedContextUnavailable())

  it("isExtendedContextKnownUnavailable is false by default", () => {
    expect(isExtendedContextKnownUnavailable()).toBe(false)
  })

  it("isExtendedContextKnownUnavailable is true immediately after recording", () => {
    recordExtendedContextUnavailable()
    expect(isExtendedContextKnownUnavailable()).toBe(true)
  })

  it("mapModelToClaudeModel returns sonnet (not [1m]) during cooldown", () => {
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet")
  })

  it("sonnet stays sonnet even when cooldown is cleared (default is 200k)", () => {
    recordExtendedContextUnavailable()
    resetExtendedContextUnavailable()
    // Sonnet defaults to 200k now — [1m] requires explicit opt-in
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet")
  })

  it("sonnet[1m] override works when cooldown is cleared", () => {
    process.env.MERIDIAN_SONNET_MODEL = "sonnet[1m]"
    recordExtendedContextUnavailable()
    resetExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet[1m]")
    delete process.env.MERIDIAN_SONNET_MODEL
  })

  it("isExtendedContextKnownUnavailable is false after cooldown expires", () => {
    // Simulate an expired timer by backdating the timestamp
    recordExtendedContextUnavailable()
    // Force-expire by directly calling record then manually manipulating through reset+re-record
    // We can't easily time-travel, so we verify the interface contract:
    // reset clears the flag, making it available again
    resetExtendedContextUnavailable()
    expect(isExtendedContextKnownUnavailable()).toBe(false)
  })

  it("opus[1m] also skips [1m] during cooldown", () => {
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-opus-4-6", "max")).toBe("opus")
  })

  it("cooldown does not affect subagent mode (already uses base model)", () => {
    // subagents already return base model regardless of flag
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", "subagent")).toBe("sonnet")
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", "subagent")).toBe("sonnet")
  })

  it("cooldown does not affect MERIDIAN_SONNET_MODEL override", () => {
    process.env.MERIDIAN_SONNET_MODEL = "sonnet"
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet")
    delete process.env.MERIDIAN_SONNET_MODEL
  })
})

describe("isClosedControllerError", () => {
  it("returns true for Controller is already closed error", () => {
    expect(isClosedControllerError(new Error("Controller is already closed"))).toBe(true)
  })

  it("returns true when message contains the phrase", () => {
    expect(isClosedControllerError(new Error("Error: Controller is already closed foo"))).toBe(true)
  })

  it("returns false for other errors", () => {
    expect(isClosedControllerError(new Error("something else"))).toBe(false)
  })

  it("returns false for non-Error values", () => {
    expect(isClosedControllerError("string")).toBe(false)
    expect(isClosedControllerError(null)).toBe(false)
    expect(isClosedControllerError(undefined)).toBe(false)
    expect(isClosedControllerError(42)).toBe(false)
  })
})

describe("resolveSdkModelDefaults", () => {
  // Pass a synthetic env to every call rather than mutating process.env.
  // Mutating process.env races with proxy-env-stripping.test.ts when bun
  // runs files in parallel.
  it("returns canonical pins when no overrides set", () => {
    const pins = resolveSdkModelDefaults({})
    expect(pins.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe(CANONICAL_FABLE_MODEL)
    expect(pins.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(CANONICAL_OPUS_MODEL)
    expect(pins.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(CANONICAL_SONNET_MODEL)
    expect(pins.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(CANONICAL_HAIKU_MODEL)
  })

  it("MERIDIAN_DEFAULT_OPUS_MODEL override wins over the canonical default", () => {
    const pins = resolveSdkModelDefaults({ MERIDIAN_DEFAULT_OPUS_MODEL: "claude-opus-5-0" })
    expect(pins.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5-0")
  })

  it("MERIDIAN_DEFAULT_SONNET_MODEL override wins over the canonical default", () => {
    const pins = resolveSdkModelDefaults({ MERIDIAN_DEFAULT_SONNET_MODEL: "claude-sonnet-5-0" })
    expect(pins.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5-0")
  })

  it("MERIDIAN_DEFAULT_HAIKU_MODEL override wins over the canonical default", () => {
    const pins = resolveSdkModelDefaults({ MERIDIAN_DEFAULT_HAIKU_MODEL: "claude-haiku-5-0" })
    expect(pins.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-5-0")
  })

  it("MERIDIAN_DEFAULT_FABLE_MODEL override wins over the canonical default", () => {
    const pins = resolveSdkModelDefaults({ MERIDIAN_DEFAULT_FABLE_MODEL: "claude-fable-6" })
    expect(pins.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("claude-fable-6")
  })

  it("returns only the four ANTHROPIC_DEFAULT_* keys — nothing else", () => {
    const pins = resolveSdkModelDefaults({})
    expect(Object.keys(pins).sort()).toEqual([
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
    ])
  })

  it("defaults to process.env when no arg given (production codepath)", () => {
    // Smoke test that the no-arg path still works — value is unspecified but
    // shape must be correct.
    const pins = resolveSdkModelDefaults()
    expect(typeof pins.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("string")
    expect(typeof pins.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("string")
    expect(typeof pins.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("string")
  })
})

describe("extended-context bench is per profile (#862)", () => {
  afterEach(() => {
    resetExtendedContextUnavailable()
  })

  it("keeps one account's Extra Usage failure from benching [1m] on another", () => {
    recordExtendedContextUnavailable("work")
    expect(mapModelToClaudeModel("opus", "max", undefined, "work")).toBe("opus")
    // "personal" may well include the 1M window; benching it because a
    // different account ran out of Extra Usage costs it the window for an hour.
    expect(mapModelToClaudeModel("opus", "max", undefined, "personal")).toBe("opus[1m]")
  })

  it("benches [1m] until the supplied rate-limit reset", () => {
    recordExtendedContextRateLimited("work", Date.now() + 60_000)
    expect(mapModelToClaudeModel("opus", "max", undefined, "work")).toBe("opus")
  })

  it("does not bench when the supplied reset has already passed", () => {
    recordExtendedContextRateLimited("work", Date.now() - 1_000)
    expect(mapModelToClaudeModel("opus", "max", undefined, "work")).toBe("opus[1m]")
  })

  it("lets a later bench extend an earlier one, but never lets an earlier shorten it", () => {
    recordExtendedContextRateLimited("work", Date.now() + 60_000)
    recordExtendedContextRateLimited("work", Date.now() + 1)
    // The near-term mark must not un-bench the profile.
    expect(mapModelToClaudeModel("opus", "max", undefined, "work")).toBe("opus")
  })

  it("reports the bench through isExtendedContextKnownUnavailable per profile", () => {
    recordExtendedContextUnavailable("work")
    expect(isExtendedContextKnownUnavailable("work")).toBe(true)
    expect(isExtendedContextKnownUnavailable("personal")).toBe(false)
  })
})
