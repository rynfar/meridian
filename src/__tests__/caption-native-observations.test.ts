import { describe, expect, it } from "bun:test"
import { modelLabel, exactBackendModel, queryCustodyJoined } from "../../scripts/e2e-claude-code-progress-captions/native-observations"

const expected = { requested: "claude-opus-5-5", sdk: "opus[1m]", native: "claude-opus-5-5[1m]", version: "2.1.292" }
const observed = { ...expected, pin: expected.requested }

describe("Native caption model and physical custody observations", () => {
  it("retains exact extended-context labels while rejecting provider prose", () => {
    for (const value of [expected.requested, expected.native, expected.sdk]) expect(modelLabel(value)).toBe(value)
    for (const value of [undefined, null, {}, "oauth-token-secret", "claude-opus-5-5[1m]\n", "claude-opus-5-5[2m]", "Provider refused account user@example.com", "claude-opus-" + "a".repeat(150)]) {
      expect(modelLabel(value)).toBeNull()
    }
  })

  it("requires the exact requested model, SDK alias, pin, native context and version", () => {
    expect(exactBackendModel(observed, expected)).toBe(true)
    expect(exactBackendModel({ ...observed, requested: expected.native }, expected)).toBe(true)
    for (const change of [
      { requested: "claude-opus-4-6" }, { sdk: "opus" }, { sdk: "haiku" },
      { pin: undefined }, { pin: "claude-opus-4-6" },
      { native: expected.requested }, { native: "claude-opus-4-6[1m]" },
      { native: undefined }, { version: "2.1.291" },
    ]) expect(exactBackendModel({ ...observed, ...change }, expected)).toBe(false)
  })

  it("can observe a physical join while model acceptance remains missing", () => {
    const handle = {}, query = { handle, gate: { handle }, iteratorSettledAt: 1001, closeAt: 1002 }
    expect(queryCustodyJoined(query)).toBe(true)
    expect(exactBackendModel({ ...observed, native: undefined }, expected)).toBe(false)
    expect(queryCustodyJoined({ ...query, handle: {} })).toBe(false)
    expect(queryCustodyJoined({ ...query, gate: undefined })).toBe(false)
    expect(queryCustodyJoined({ ...query, handle: undefined })).toBe(false)
  })

  it("requires explicit finite positive iterator and close witnesses", () => {
    const handle = {}, query = { handle, gate: { handle }, iteratorSettledAt: 1001, closeAt: 1002 }
    for (const value of [undefined, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(queryCustodyJoined({ ...query, iteratorSettledAt: value })).toBe(false)
      expect(queryCustodyJoined({ ...query, closeAt: value })).toBe(false)
    }
  })
})
