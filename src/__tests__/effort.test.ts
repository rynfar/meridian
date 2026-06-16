/**
 * Unit tests for effort normalization.
 *
 * The SDK `--effort` flag accepts a fixed vocabulary (low/medium/high/xhigh/max).
 * Clients (especially OpenAI-compatible ones) may send values outside it —
 * notably OpenAI's `"minimal"` — which the SDK rejects. normalizeEffort gates
 * the value so an unknown effort falls back to the model default (undefined)
 * instead of erroring the whole request.
 */
import { describe, it, expect } from "bun:test"
import { normalizeEffort, VALID_EFFORTS } from "../proxy/effort"

describe("normalizeEffort", () => {
  it("passes through every valid Claude effort level", () => {
    for (const level of VALID_EFFORTS) {
      expect(normalizeEffort(level)).toBe(level)
    }
  })

  it("accepts xhigh and max (beyond the legacy low/medium/high)", () => {
    expect(normalizeEffort("xhigh")).toBe("xhigh")
    expect(normalizeEffort("max")).toBe("max")
  })

  it("drops OpenAI's 'minimal' (not a valid Claude effort)", () => {
    expect(normalizeEffort("minimal")).toBeUndefined()
  })

  it("drops unknown / malformed values rather than forwarding them", () => {
    expect(normalizeEffort("super")).toBeUndefined()
    expect(normalizeEffort("")).toBeUndefined()
    expect(normalizeEffort("HIGH")).toBeUndefined() // case-sensitive: SDK wants lowercase
    expect(normalizeEffort(undefined)).toBeUndefined()
    expect(normalizeEffort(null)).toBeUndefined()
    expect(normalizeEffort(3)).toBeUndefined()
    expect(normalizeEffort({})).toBeUndefined()
  })
})
