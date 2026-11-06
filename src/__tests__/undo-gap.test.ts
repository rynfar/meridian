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

  for (const partialReplay of [false, true]) {
    it(`retains ordinary undo at the adjacent assistant checkpoint (partialReplay=${partialReplay})`, () => {
      expect(verifyLineage(cached, [...original.slice(0, 4), { role: "user", content: "replacement question" }], { partialReplay }))
        .toMatchObject({ type: "undo", prefixOverlap: 4, rollbackUuid: "uuid-3" })
    })
  }

  it("does not roll back farther when the adjacent checkpoint UUID is missing", () => {
    const missingAdjacent = { ...cached, sdkMessageUuids: [null, "uuid-1", null, null] }
    expect(verifyLineage(missingAdjacent, [...original.slice(0, 4), { role: "user", content: "replacement question" }]))
      .toMatchObject({ type: "undo", prefixOverlap: 4, rollbackUuid: undefined })
  })

  it("keeps the undo without rollback under partial replay when no assistant UUID proves a fork point", () => {
    const unproved = { ...cached, sdkMessageUuids: original.map(() => null) }
    expect(verifyLineage(unproved, [...original.slice(0, 4), { role: "user", content: "replacement question" }], { partialReplay: true }))
      .toMatchObject({ type: "undo", prefixOverlap: 4, rollbackUuid: undefined })
  })

  it("forks at the last proved assistant under partial replay when the adjacent UUID is missing", () => {
    const missingAdjacent = { ...cached, sdkMessageUuids: [null, "uuid-1", null, null] }
    const incoming = [...original.slice(0, 4), { role: "user", content: "replacement question" }]
    expect(verifyLineage(missingAdjacent, incoming, { partialReplay: true })).toMatchObject({
      type: "diverged", reason: "undo-gap", prefixOverlap: 4,
      rollbackTail: { rollbackIndex: 1, rollbackUuid: "uuid-1", settledToolIds: [] },
    })
  })
})
