import { describe, expect, it } from "bun:test"
import { computeLineageHash, computeMessageHashes, verifyLineage, type SessionState } from "../proxy/session/lineage"

const original = Array.from({ length: 9 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: `original ${index}`,
}))
const cached: SessionState = {
  claudeSessionId: "source", lastAccess: 0, messageCount: original.length,
  lineageHash: computeLineageHash(original), messageHashes: computeMessageHashes(original),
  sdkMessageUuids: original.map((message, index) => message.role === "assistant" ? `uuid-${index}` : null),
}

describe("undo delivery proof (#817)", () => {
  for (const count of [7, 9]) {
    it(`replays ${count} messages when edits begin before the final user turn`, () => {
      const incoming = [...original.slice(0, 4), ...original.slice(4, count).map(message => ({
        ...message, content: `edited ${message.content}`,
      }))]
      expect(verifyLineage(cached, incoming)).toMatchObject({
        type: "diverged", reason: "undo-gap", prefixOverlap: 4,
        mismatch: { index: 4, storedCount: 9, incomingCount: count },
      })
    })
  }

  it("does not silently replace a final assistant turn with an earlier user turn", () => {
    expect(verifyLineage(cached, [...original.slice(0, 2), { role: "assistant", content: "revised assistant" }]))
      .toMatchObject({ type: "diverged", reason: "undo-gap" })
  })

  it("retains ordinary undo at the adjacent assistant checkpoint", () => {
    expect(verifyLineage(cached, [...original.slice(0, 4), { role: "user", content: "replacement question" }]))
      .toMatchObject({ type: "undo", prefixOverlap: 4, rollbackUuid: "uuid-3" })
  })

  it("does not roll back farther when the adjacent checkpoint UUID is missing", () => {
    const missingAdjacent = { ...cached, sdkMessageUuids: [null, "uuid-1", null, null] }
    expect(verifyLineage(missingAdjacent, [...original.slice(0, 4), { role: "user", content: "replacement question" }]))
      .toMatchObject({ type: "undo", prefixOverlap: 4, rollbackUuid: undefined })
  })
})
