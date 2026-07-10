import { describe, expect, it } from "bun:test"
import { detectTokenAnomalies, type TokenSnapshot, type TokenAnomaly } from "../proxy/tokenHealth"

function makeSnapshot(overrides: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    requestId: "req-001",
    turnNumber: 2,
    inputTokens: 5000,
    outputTokens: 500,
    cacheReadInputTokens: 4000,
    cacheCreationInputTokens: 200,
    cacheHitRate: 0.8,
    isResume: true,
    isPassthrough: false,
    ...overrides,
  }
}

describe("detectTokenAnomalies", () => {
  it("returns empty array when no anomalies", () => {
    const prev = makeSnapshot({ turnNumber: 1, inputTokens: 4500 })
    const curr = makeSnapshot({ turnNumber: 2, inputTokens: 5000 })
    expect(detectTokenAnomalies(curr, prev)).toEqual([])
  })

  it("detects context spike (>60% input growth)", () => {
    const prev = makeSnapshot({ turnNumber: 1, inputTokens: 5000 })
    const curr = makeSnapshot({ turnNumber: 2, inputTokens: 11000 })
    const anomalies = detectTokenAnomalies(curr, prev)
    expect(anomalies.length).toBeGreaterThanOrEqual(1)
    expect(anomalies.some(a => a.type === "context_spike")).toBe(true)
  })

  // #496: in passthrough, nearly all input is cache-read, so raw inputTokens
  // sits at 1-2 and any jitter reads as huge % growth ("grew 100% (1 -> 2)").
  // A tiny baseline must not trip the alert.
  it("does not flag a context spike when the baseline is tiny (1 -> 2)", () => {
    const prev = makeSnapshot({ turnNumber: 1, inputTokens: 1 })
    const curr = makeSnapshot({ turnNumber: 2, inputTokens: 2 })
    expect(detectTokenAnomalies(curr, prev).some(a => a.type === "context_spike")).toBe(false)
  })

  it("does not flag a context spike for sub-threshold baselines (100 -> 400)", () => {
    const prev = makeSnapshot({ turnNumber: 1, inputTokens: 100 })
    const curr = makeSnapshot({ turnNumber: 2, inputTokens: 400 })
    expect(detectTokenAnomalies(curr, prev).some(a => a.type === "context_spike")).toBe(false)
  })

  it("still flags a genuine spike from a meaningful baseline (5000 -> 50000)", () => {
    const prev = makeSnapshot({ turnNumber: 1, inputTokens: 5000 })
    const curr = makeSnapshot({ turnNumber: 2, inputTokens: 50000 })
    const spike = detectTokenAnomalies(curr, prev).find(a => a.type === "context_spike")
    expect(spike).toBeDefined()
    expect(spike!.severity).toBe("critical")
  })

  it("detects cache miss on resume as critical when previous metric exists", () => {
    const prev = makeSnapshot({ turnNumber: 1, cacheHitRate: 0.85 })
    const curr = makeSnapshot({
      turnNumber: 2,
      cacheReadInputTokens: 0,
      cacheHitRate: 0,
      isResume: true,
    })
    const anomalies = detectTokenAnomalies(curr, prev)
    const cacheMiss = anomalies.find(a => a.type === "cache_miss")
    expect(cacheMiss).toBeDefined()
    expect(cacheMiss!.severity).toBe("critical")
    expect(cacheMiss!.detail).toContain("check tool ordering")
  })

  it("detects cache miss on resume as warn when no previous metric (post-restart)", () => {
    const curr = makeSnapshot({
      turnNumber: 2,
      cacheReadInputTokens: 0,
      cacheHitRate: 0,
      isResume: true,
    })
    const anomalies = detectTokenAnomalies(curr, undefined)
    const cacheMiss = anomalies.find(a => a.type === "cache_miss")
    expect(cacheMiss).toBeDefined()
    expect(cacheMiss!.severity).toBe("warn")
    expect(cacheMiss!.detail).toContain("normal after proxy restart")
  })

  it("does not flag cache miss on first request (not resume)", () => {
    const curr = makeSnapshot({
      turnNumber: 1,
      cacheReadInputTokens: 0,
      cacheHitRate: 0,
      isResume: false,
    })
    const anomalies = detectTokenAnomalies(curr, undefined)
    expect(anomalies.some(a => a.type === "cache_miss")).toBe(false)
  })

  it("detects sustained high growth rate", () => {
    const prev = makeSnapshot({ turnNumber: 5, inputTokens: 10000 })
    const curr = makeSnapshot({ turnNumber: 6, inputTokens: 17000 })
    const anomalies = detectTokenAnomalies(curr, prev)
    expect(anomalies.some(a => a.type === "context_spike")).toBe(true)
  })

  it("works with no previous snapshot (first turn)", () => {
    const curr = makeSnapshot({ turnNumber: 1 })
    const anomalies = detectTokenAnomalies(curr, undefined)
    expect(anomalies).toEqual([])
  })

  it("includes human-readable detail in each anomaly", () => {
    const prev = makeSnapshot({ turnNumber: 1, inputTokens: 5000, cacheHitRate: 0.9 })
    const curr = makeSnapshot({
      turnNumber: 2, inputTokens: 11000,
      cacheReadInputTokens: 0, cacheHitRate: 0, isResume: true,
    })
    const anomalies = detectTokenAnomalies(curr, prev)
    for (const a of anomalies) {
      expect(a.detail.length).toBeGreaterThan(10)
      expect(a.severity).toMatch(/^(warn|critical)$/)
    }
  })
})
