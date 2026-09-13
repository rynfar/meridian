import { describe, expect, it } from "bun:test"
import { canonicalizeOpenCodeMessagesForLineage as canonicalize } from "../proxy/adapters/opencode"
import { computeLineageHash, computeMessageHashes, computeMessageBlockHashes, verifyLineage, type SessionState } from "../proxy/session/lineage"

const text = (value: string) => ({ type: "text", text: value })
const hook = (value: unknown) => text(`<user-prompt-submit-hook>${JSON.stringify(value)}</user-prompt-submit-hook>`)

describe("OpenCode transient hook lineage", () => {
  for (const payload of [
    { continue: true }, { continue: false, stopReason: "Stopped by the hook" },
    { suppressOutput: true }, { decision: "block", reason: "Hook policy" },
    { systemMessage: "Per-turn context" },
    { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Per-turn context" } },
  ]) {
    it(`canonicalizes the known hook output ${JSON.stringify(payload)}`, () => {
      const durable = text("Fixture value is ALPHA.")
      const original = [{ role: "user", content: [hook(payload), durable] }]
      const before = structuredClone(original)
      const stored = canonicalize(original)
      const incoming = canonicalize([{ role: "user", content: [durable] }, { role: "user", content: [text("Continue.")] }])
      const state: SessionState = { claudeSessionId: "source", lastAccess: 0, messageCount: stored.length,
        lineageHash: computeLineageHash(stored), messageHashes: computeMessageHashes(stored),
        messageBlockHashes: computeMessageBlockHashes(stored) }
      expect(verifyLineage(state, incoming)).toMatchObject({ type: "continuation", resumeFrom: 1 })
      expect(original).toEqual(before)
    })
  }

  for (const payload of [{}, { continue: "true" }, { continue: true, fixtureOverride: "BETA" },
    { decision: "unknown" }, { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "context" } }]) {
    it(`retains unrecognized or malformed hook output ${JSON.stringify(payload)}`, () => {
      const messages = [{ role: "user", content: [hook(payload), text("ALPHA")] }]
      expect(canonicalize(messages)).toEqual(messages)
    })
  }

  it("retains hook-only messages, assistant text and prose surrounding a hook", () => {
    const block = hook({ continue: true })
    const messages = [{ role: "user", content: [block] },
      { role: "assistant", content: [block, text("ALPHA")] },
      { role: "user", content: [text(`Explain ${block.text}`), text("ALPHA")] }]
    expect(canonicalize(messages)).toEqual(messages)
  })

  it("preserves the order and identity of every surviving content block", () => {
    const before = text("ALPHA")
    const after = text("BETA")
    expect(canonicalize([{ role: "user", content: [before, hook({ continue: true }), after] }]))
      .toEqual([{ role: "user", content: [before, after] }])
  })
})
