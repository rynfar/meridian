import { describe, expect, it } from "bun:test"
import { computeLineageHash, computeMessageHashes, computeMessageBlockHashes, verifyLineage, type SessionState } from "../proxy/session/lineage"

type Message = { role: string; content: unknown }
const text = (value: string) => ({ type: "text", text: value })
function state(messages: Message[]): SessionState {
  return { claudeSessionId: "fixture-source", lastAccess: 0, messageCount: messages.length,
    lineageHash: computeLineageHash(messages), messageHashes: computeMessageHashes(messages),
    messageBlockHashes: computeMessageBlockHashes(messages) }
}

describe("block continuation must preserve claimed history", () => {
  it("replays when the client removes a meaningful fixture override", () => {
    const original = [{ role: "user", content: [text("Fixture value is ALPHA."), text("Correction: fixture value is BETA.")] }]
    const revised = [{ role: "user", content: [text("Fixture value is ALPHA.")] },
      { role: "user", content: "What is the fixture value in my first message?" }]
    expect(verifyLineage(state(original), revised).type).toBe("diverged")
  })

  it("replays an assistant-to-user role rewrite even if surviving blocks match", () => {
    const original = [{ role: "assistant", content: [text("ALPHA"), text("BETA")] }]
    const revised = [{ role: "user", content: [text("ALPHA")] }, { role: "user", content: "Continue." }]
    expect(verifyLineage(state(original), revised).type).toBe("diverged")
  })

  it("can deliver new text appended after an unchanged tool-result prefix", () => {
    const result = { type: "tool_result", tool_use_id: "read-1", content: "ALPHA" }
    const original = [{ role: "user", content: [result] }]
    const revised = [{ role: "user", content: [result, text("Explain this result.")] }]
    expect(verifyLineage(state(original), revised)).toMatchObject({ type: "continuation", resumeFrom: 0, resumeContentFrom: 1 })
  })
})
