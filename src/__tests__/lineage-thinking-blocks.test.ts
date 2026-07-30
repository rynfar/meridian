/**
 * Lineage hash stability across thinking-block serialization (#710).
 *
 * The hash answers one question: is this the same conversation prefix? A
 * thinking block's `signature` is an opaque per-generation blob, and
 * `redacted_thinking` carries only opaque `data` — neither bears on that
 * question. Before this fix, thinking blocks fell through `normalizeContent`'s
 * unknown-block branch and were serialized whole, signature included.
 *
 * The expensive failure mode is a client that stops echoing thinking blocks
 * once a tool loop finishes. That message's hash changes for every subsequent
 * turn, silently downgrading resume to a full replay and rebuilding the prompt
 * cache from scratch — the cost documented in #689/#701.
 *
 * There was no test covering thinking blocks in the lineage hash at all, which
 * is why the sensitivity went unnoticed.
 */
import { describe, it, expect } from "bun:test"
import { hashMessage, computeLineageHash } from "../proxy/session/lineage"
import { normalizeContent } from "../proxy/messages"

/** Shape of a real captured signature — opaque, high-entropy, per-generation. */
const SIG_A = "ErkCCosBCBAYAipArnuwVmIJYId3EvWd4ITxDyTxhyG1oXG7l8E3OBpQo6JfDB"
const SIG_B = "ZZkCCosBCBAYAipQxxxxVmIJYId3EvWd4ITxDyTxhyG1oXG7l8E3OBpQo6JfXX"

const TEXT = "I'll check the config file."

/** The same logical assistant turn, serialized four ways by different clients. */
const withThinking = [
  { type: "thinking", thinking: "The user wants the config.", signature: SIG_A },
  { type: "text", text: TEXT },
]
const thinkingDropped = [
  { type: "text", text: TEXT },
]
const signatureDropped = [
  { type: "thinking", thinking: "The user wants the config." },
  { type: "text", text: TEXT },
]
const differentSignature = [
  { type: "thinking", thinking: "The user wants the config.", signature: SIG_B },
  { type: "text", text: TEXT },
]
const differentThinkingText = [
  { type: "thinking", thinking: "Completely different reasoning this time.", signature: SIG_A },
  { type: "text", text: TEXT },
]

describe("lineage hash — thinking block variants (#710)", () => {
  it("hashes all four captured variants identically", () => {
    // These four produced four different hashes before the fix.
    const hashes = [withThinking, thinkingDropped, signatureDropped, differentSignature]
      .map(c => hashMessage({ role: "assistant", content: c }))
    expect(new Set(hashes).size).toBe(1)
  })

  it("is stable when a client stops echoing thinking after a tool loop", () => {
    // The headline failure mode. Note this is why the fix drops the block
    // rather than hashing `thinking:<text>` — the latter still churns here.
    expect(hashMessage({ role: "assistant", content: withThinking }))
      .toBe(hashMessage({ role: "assistant", content: thinkingDropped }))
  })

  it("is stable across a re-generated signature", () => {
    expect(hashMessage({ role: "assistant", content: withThinking }))
      .toBe(hashMessage({ role: "assistant", content: differentSignature }))
  })

  it("ignores the thinking text itself, so re-generated reasoning does not churn", () => {
    // Deliberate: thinking is model-emitted and accompanies the same text and
    // tool calls, so it never distinguishes two genuinely different prefixes.
    expect(hashMessage({ role: "assistant", content: withThinking }))
      .toBe(hashMessage({ role: "assistant", content: differentThinkingText }))
  })

  it("ignores redacted_thinking, which carries only opaque data", () => {
    const redacted = [
      { type: "redacted_thinking", data: "EroCCkYIARgCKkBxx==" },
      { type: "text", text: TEXT },
    ]
    expect(hashMessage({ role: "assistant", content: redacted }))
      .toBe(hashMessage({ role: "assistant", content: thinkingDropped }))
  })

  it("still distinguishes turns that differ in real content", () => {
    // The guard must not become permissive: text, tool_use and tool_result all
    // still contribute. Without this, dropping every block would "pass".
    const otherText = [
      { type: "thinking", thinking: "The user wants the config.", signature: SIG_A },
      { type: "text", text: "Actually I'll check something else." },
    ]
    expect(hashMessage({ role: "assistant", content: withThinking }))
      .not.toBe(hashMessage({ role: "assistant", content: otherText }))
  })

  it("still distinguishes a differing tool_use alongside thinking", () => {
    const callA = [
      { type: "thinking", thinking: "reasoning", signature: SIG_A },
      { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } },
    ]
    const callB = [
      { type: "thinking", thinking: "reasoning", signature: SIG_A },
      { type: "tool_use", id: "t1", name: "read", input: { path: "b.ts" } },
    ]
    expect(hashMessage({ role: "assistant", content: callA }))
      .not.toBe(hashMessage({ role: "assistant", content: callB }))
  })

  it("keeps role separation — same content under a different role differs", () => {
    expect(hashMessage({ role: "assistant", content: thinkingDropped }))
      .not.toBe(hashMessage({ role: "user", content: thinkingDropped }))
  })

  it("leaves no empty segment behind when a thinking block is removed", () => {
    // Reducing the block to "" instead of filtering it would leave its join
    // newline in place, churning the hash exactly as the raw block did.
    expect(normalizeContent(withThinking)).toBe(TEXT)
    expect(normalizeContent(withThinking)).not.toStartWith("\n")
  })

  it("normalizes a thinking-only turn to empty rather than a signature blob", () => {
    expect(normalizeContent([{ type: "thinking", thinking: "hm", signature: SIG_A }])).toBe("")
  })

  it("keeps a whole-conversation lineage hash stable across the variants", () => {
    // hashMessage covers one slot; computeLineageHash is what actually gates
    // resume, so pin the same property end to end.
    const prefix = [
      { role: "user", content: "read the config" },
    ]
    const a = computeLineageHash([...prefix, { role: "assistant", content: withThinking }])
    const b = computeLineageHash([...prefix, { role: "assistant", content: thinkingDropped }])
    const c = computeLineageHash([...prefix, { role: "assistant", content: differentSignature }])
    expect(a).toBe(b)
    expect(a).toBe(c)
  })
})
