import { describe, expect, it } from "bun:test"
import { inspectExecutionHistory } from "../proxy/executionHistory"
import { computeLineageHash, computeMessageHashes, verifyLineage, matchesStoredLineagePrefix, type SessionState } from "../proxy/session/lineage"

describe("execution history equivalence", () => {
  const raw = [{ role: "user", content: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" }, unknown: { first: 1, second: 2 } }] }]
  it("preserves equal clones regardless of object key order without mutation", () => {
    const clone = [{ content: [{ unknown: { second: 2, first: 1 }, cache_control: { type: "ephemeral" }, text: "fixture", type: "text" }], role: "user" }]
    const before = JSON.stringify(raw)
    expect(inspectExecutionHistory(raw, clone)).toEqual({ ok: true, messages: clone, changed: false })
    expect(JSON.stringify(raw)).toBe(before)
  })
  for (const content of [
    [{ type: "text", text: "fixture" }],
    [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" }, unknown: { first: 1, second: 3 } }],
    [{ type: "text", text: "fixture" }, { type: "thinking", thinking: "private fixture", signature: "opaque fixture" }],
  ]) {
    it(`does not discard fields when comparing execution (${JSON.stringify(content)})`, () => {
      expect(inspectExecutionHistory(raw, [{ role: "user", content }])).toEqual({ ok: true, messages: [{ role: "user", content }], changed: true })
    })
  }
  for (const invalid of [undefined, null, {}, [], [null], [{ role: 7, content: "x" }], [{ role: "user", content: null }]]) {
    it(`rejects invalid returned history ${JSON.stringify(invalid)}`, () => {
      expect(inspectExecutionHistory(raw, invalid)).toEqual({ ok: false })
    })
  }
})

it("rejects sparse plugin histories rather than treating holes as messages", () => {
  expect(inspectExecutionHistory([{ role: "user", content: "objective" }], new Array(1))).toEqual({ ok: false })
})

describe("raw client proof is distinct from SDK reuse proof", () => {
  it("does not let a stale optional raw field override a legacy writer's new nonempty proof", () => {
    const old = [{ role: "user", content: "old objective" }]
    const current = [{ role: "user", content: "rewritten objective" }]
    const state: SessionState = { claudeSessionId: "fixture-sdk", lastAccess: 1, messageCount: 1,
      lineageHash: computeLineageHash(current), clientLineageHash: computeLineageHash(old), messageHashes: computeMessageHashes(current) }
    expect(verifyLineage(state, [...old, { role: "user", content: "old-prefix append" }]).type).toBe("diverged")
    expect(verifyLineage(state, [...current, { role: "user", content: "current-prefix append" }]).type).toBe("continuation")
  })
  it("classifies raw continuation while withholding SDK/checkpoint proof", () => {
    const prior = [{ role: "user", content: "client input omitted by a plugin" }]
    const state: SessionState = { claudeSessionId: "fixture-sdk", lastAccess: 1, messageCount: 1, lineageHash: "", clientLineageHash: computeLineageHash(prior), messageHashes: computeMessageHashes(prior) }
    const next = [...prior, { role: "assistant", content: "fixture answer" }, { role: "user", content: "next question" }]
    expect(verifyLineage(state, next).type).toBe("continuation")
    expect(matchesStoredLineagePrefix(state, next)).toBe(false)
    // An old reader that knows only the existing lineageHash must replay.
    expect(verifyLineage({ ...state, clientLineageHash: undefined }, next)).toEqual({ type: "diverged", reason: "unverifiable" })
    expect(verifyLineage(state, [{ role: "user", content: "rewritten client ancestry" }, next[2]!]).type).toBe("diverged")
  })
})
