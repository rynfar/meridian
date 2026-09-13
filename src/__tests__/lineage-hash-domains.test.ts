import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { normalizeContent } from "../proxy/messages"
import {
  computeLineageHash, computeMessageHashes, computeMessageBlockHashes,
  hashMessage, verifyLineage, type SessionState,
} from "../proxy/session/lineage"

type Message = { role: string; content: unknown }
const text = (value: string) => ({ type: "text", text: value })
const result = (id: string, content: unknown, is_error = false) => ({ type: "tool_result", tool_use_id: id, content, is_error })
function session(messages: Message[]): SessionState {
  return {
    claudeSessionId: "source", lastAccess: 0, messageCount: messages.length,
    lineageHash: computeLineageHash(messages), messageHashes: computeMessageHashes(messages),
    messageBlockHashes: computeMessageBlockHashes(messages),
  }
}

describe("lineage hash domains", () => {
  for (const [label, left, right] of [
    ["text versus tool result", text("tool_result:call_1:ok"), result("call_1", "ok")],
    ["text versus tool use", text('tool_use:call_1:read:{}'), { type: "tool_use", id: "call_1", name: "read", input: {} }],
    ["tool result delimiter", result("call_1:a", "b"), result("call_1", "a:b")],
    ["tool result error status", result("call_1", "ok", false), result("call_1", "ok", true)],
    ["nested result text versus block array", result("call_1", '[{"type":"text","text":"ok"}]'), result("call_1", [text("ok")])],
  ] as const) {
    it(`separates ${label} at every hash level`, () => {
      const a = { role: "user", content: [left] }
      const b = { role: "user", content: [right] }
      expect(computeMessageBlockHashes([a])).not.toEqual(computeMessageBlockHashes([b]))
      expect(hashMessage(a)).not.toBe(hashMessage(b))
      expect(computeLineageHash([a])).not.toBe(computeLineageHash([b]))
      expect(verifyLineage(session([a]), [b, { role: "assistant", content: "next" }]).type).toBe("diverged")
    })
  }

  it("does not let content inject message boundaries into the aggregate hash", () => {
    const a = [{ role: "user", content: "one\nassistant:two" }, { role: "assistant", content: "three" }]
    const b = [{ role: "user", content: "one" }, { role: "assistant", content: "two\nassistant:three" }]
    expect(computeLineageHash(a)).not.toBe(computeLineageHash(b))
    expect(verifyLineage(session(a), [...b, { role: "user", content: "next" }]).type).toBe("diverged")
  })

  it("keeps block boundaries distinct from a newline in text", () => {
    expect(hashMessage({ role: "user", content: [text("one"), text("two")] }))
      .not.toBe(hashMessage({ role: "user", content: [text("one\ntwo")] }))
  })

  it("does not reinterpret a cached assistant as a user during a block append", () => {
    const a = [{ role: "assistant", content: [text("old")] }]
    const b = [{ role: "user", content: [text("old"), result("new", "new result")] }]
    expect(verifyLineage(session(a), b).type).toBe("diverged")
  })

  it("preserves plain-string versus text-block equivalence and ignores cache hints", () => {
    const a = { role: "user", content: "hello" }
    const b = { role: "user", content: [{ ...text("hello"), cache_control: { type: "ephemeral" } }] }
    expect(hashMessage(a)).toBe(hashMessage(b))
    expect(computeMessageBlockHashes([a])).toEqual(computeMessageBlockHashes([b]))
  })

  it("continues only from the newly appended parallel result", () => {
    const a = [{ role: "user", content: [result("a", "first")] }]
    const b = [{ role: "user", content: [result("a", "first"), result("b", "second")] }]
    expect(verifyLineage(session(a), b)).toMatchObject({ type: "continuation", resumeFrom: 0, resumeContentFrom: 1 })
  })

  it("treats JSON key order as immaterial without discarding tool arguments named cache_control", () => {
    const call = (input: unknown) => ({ role: "assistant", content: [{ type: "tool_use", id: "a", name: "write", input }] })
    expect(hashMessage(call({ path: "a", nested: { x: 1, y: 2 } })))
      .toBe(hashMessage(call({ nested: { y: 2, x: 1 }, path: "a" })))
    expect(hashMessage(call({ cache_control: "first" })))
      .not.toBe(hashMessage(call({ cache_control: "second" })))
  })

  it("ignores nested content cache hints but retains image payload identity", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "first" } }
    const a = { role: "user", content: [result("a", [image])] }
    const hinted = { role: "user", content: [result("a", [{ ...image, cache_control: { type: "ephemeral" } }])] }
    const changed = { role: "user", content: [result("a", [{ ...image, source: { ...image.source, data: "second" } }])] }
    expect(hashMessage(a)).toBe(hashMessage(hinted))
    expect(hashMessage(a)).not.toBe(hashMessage(changed))
  })

  it("safely replays a legacy cache instead of trusting its ambiguous hashes", () => {
    const a = [{ role: "user", content: [text("tool_result:call_1:ok")] }]
    const legacyDigest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32)
    const old = session(a)
    old.lineageHash = legacyDigest(a.map(m => `${m.role}:${normalizeContent(m.content)}`).join("\n"))
    old.messageHashes = a.map(m => legacyDigest(`${m.role}:${normalizeContent(m.content)}`))
    old.messageBlockHashes = [[legacyDigest(normalizeContent(a[0]!.content))]]
    const b = [{ role: "user", content: [result("call_1", "ok")] }, { role: "assistant", content: "next" }]
    expect(verifyLineage(old, b).type).toBe("diverged")
    expect(verifyLineage(old, [...a, { role: "assistant", content: "next" }]).type).toBe("diverged")
  })
})
