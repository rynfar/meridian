import { describe, it, expect } from "bun:test"
import { MODEL_CATALOG } from "../proxy/openai"

describe("OpenAI compatibility — model catalog", () => {
  it("contains at least 3 models", () => {
    expect(MODEL_CATALOG.length).toBeGreaterThanOrEqual(3)
  })

  it("has correct context windows", () => {
    const opus = MODEL_CATALOG.find(m => m.id.includes("opus"))
    const sonnet = MODEL_CATALOG.find(m => m.id.includes("sonnet"))
    const haiku = MODEL_CATALOG.find(m => m.id.includes("haiku"))

    expect(opus).toBeTruthy()
    expect(sonnet).toBeTruthy()
    expect(haiku).toBeTruthy()

    // Opus gets 1M via SDK [1m] suffix
    expect(opus!.contextWindow).toBe(1000000)
    // Sonnet and Haiku at 200K
    expect(sonnet!.contextWindow).toBe(200000)
    expect(haiku!.contextWindow).toBe(200000)
  })

  it("each model has required fields", () => {
    for (const m of MODEL_CATALOG) {
      expect(m.id).toBeTruthy()
      expect(m.claudeModel).toBeTruthy()
      expect(m.contextWindow).toBeGreaterThan(0)
      expect(m.maxOutput).toBeGreaterThan(0)
      expect(Array.isArray(m.aliases)).toBe(true)
    }
  })

  it("aliases resolve correctly", () => {
    // Check that common aliases are present
    const allAliases = MODEL_CATALOG.flatMap(m => m.aliases)
    expect(allAliases).toContain("opus")
    expect(allAliases).toContain("sonnet")
    expect(allAliases).toContain("haiku")
  })
})

describe("OpenAI compatibility — settings persistence", () => {
  it("getProxySettings returns defaults", async () => {
    const { getProxySettings } = await import("../keys/settings")
    const settings = getProxySettings()
    expect(settings.maxConcurrent).toBeGreaterThan(0)
    expect(typeof settings.passthrough).toBe("boolean")
    expect(typeof settings.globalLimit6h).toBe("number")
    expect(typeof settings.globalLimitWeekly).toBe("number")
  })
})
