import { describe, expect, it } from "bun:test"
import { canonicalizeClaudeCodeMessagesForLineage as canonicalize, claudeCodeAdapter } from "../proxy/adapters/claudecode"
import { computeLineageHash, computeMessageHashes, computeMessageBlockHashes, verifyLineage, type SessionState } from "../proxy/session/lineage"

// The wire shapes below are what claude-cli 2.1.289 sent for claude-fable-5-1,
// captured turn by turn against a scripted API on 2026-10-05 (E2E.md,
// "Claude Code system turns across tool rounds").
const text = (value: string) => ({ type: "text", text: value })
const cached = (value: string) => ({ type: "text", text: value, cache_control: { type: "ephemeral" } })
const tokensLeft = (count: number) => `<total_tokens>${count} tokens left</total_tokens>`
const BATCHING = "First privately list what you need next; then request every item that doesn't depend on another's result in this one response."
const toolUse = (id: string) => ({ type: "tool_use", id, name: "Read", input: { file_path: `/work/${id}.txt` } })
const toolResult = (id: string) => ({ type: "tool_result", tool_use_id: id, content: `fixture ${id}` })

type Message = { role: string; content: unknown }
const stateFor = (stored: Message[]): SessionState => ({
  claudeSessionId: "source", lastAccess: 0, messageCount: stored.length,
  lineageHash: computeLineageHash(stored), messageHashes: computeMessageHashes(stored),
  messageBlockHashes: computeMessageBlockHashes(stored) })

const head: Message[] = [
  { role: "user", content: [text("Read the fixture files one after another and report.")] },
  { role: "system", content: "# Environment\nYou have been invoked in the following environment: ..." },
  { role: "assistant", content: [text("Reading two."), toolUse("a"), toolUse("b")] },
]
/** The request that carries round one's results: its system turn is the tail. */
const roundOne: Message[] = [...head,
  { role: "user", content: [toolResult("a"), toolResult("b")] },
  { role: "system", content: [cached(tokensLeft(14994880)), text(BATCHING)] },
]
/** The request after it: round one's system turn has lost the reminder. */
const roundTwo: Message[] = [...head,
  { role: "user", content: [toolResult("a"), toolResult("b")] },
  { role: "system", content: tokensLeft(14994880) },
  { role: "assistant", content: [toolUse("c")] },
  { role: "user", content: [toolResult("c")] },
  { role: "system", content: [cached(tokensLeft(14989880)), text(BATCHING)] },
]
/** What Meridian has stored once it answered `request`: the request and its reply. */
const storedAfter = (request: Message[], reply: Message): Message[] => [...canonicalize(request), reply]

describe("Claude Code system turns in lineage", () => {
  it("resumes the round after a system turn that carried a one-request reminder", () => {
    const stored = storedAfter(roundOne, { role: "assistant", content: [toolUse("c")] })
    expect(verifyLineage(stateFor(stored), canonicalize(roundTwo))).toMatchObject({ type: "continuation", resumeFrom: 6 })
  })

  it("still treats the same history without canonicalization as modified", () => {
    const stored = [...roundOne, { role: "assistant", content: [toolUse("c")] }]
    expect(verifyLineage(stateFor(stored), roundTwo)).toMatchObject({ type: "diverged", reason: "modified-history" })
  })

  it("hashes the active and the historical form of a system turn identically", () => {
    const active = canonicalize(roundOne)
    const historical = canonicalize(roundTwo).slice(0, roundOne.length)
    expect(computeMessageHashes(active)).toEqual(computeMessageHashes(historical))
    expect(computeMessageBlockHashes(active)).toEqual(computeMessageBlockHashes(historical))
  })

  it("keeps every message in place and leaves the request itself untouched", () => {
    const before = structuredClone(roundTwo)
    const canonical = canonicalize(roundTwo)
    expect(canonical.map(message => message.role)).toEqual(roundTwo.map(message => message.role))
    expect(canonical.at(-1)).toEqual({ role: "system", content: [cached(tokensLeft(14989880))] })
    expect(roundTwo).toEqual(before)
  })

  it("drops whatever follows the cache breakpoint, not one known wording", () => {
    const messages = [{ role: "system", content: [cached(tokensLeft(1)), text("A reminder this client has not sent yet."), text("And another.")] }]
    expect(canonicalize(messages)).toEqual([{ role: "system", content: [cached(tokensLeft(1))] }])
  })

  it("drops the known reminder from a system turn that carries no cache breakpoint", () => {
    const messages = [{ role: "system", content: [text(tokensLeft(1)), text(BATCHING)] }]
    expect(canonicalize(messages)).toEqual([{ role: "system", content: [text(tokensLeft(1))] }])
  })

  it("retains a system turn that would be left with nothing when anything follows it", () => {
    const messages = [
      { role: "system", content: [text(BATCHING)] },
      { role: "system", content: BATCHING },
      { role: "user", content: [toolResult("a")] },
    ]
    expect(canonicalize(messages)).toEqual(messages)
  })

  // claude-cli 2.1.294 on claude-fable-5-1 also ends a tool-result request with
  // a system turn holding the reminder alone, and the next request carries no
  // trace of that turn: the reply sits where it was. Live, 2026-10-07/08: 187
  // subagent rounds replayed `modified-history`, stored digest eff8768460e3.
  const reminderOnly: Message[] = [...head,
    { role: "user", content: [toolResult("a"), toolResult("b")] },
    { role: "system", content: [text(BATCHING)] },
  ]
  const afterReminderOnly: Message[] = [...head,
    { role: "user", content: [toolResult("a"), toolResult("b")] },
    { role: "assistant", content: [toolUse("c")] },
    { role: "user", content: [toolResult("c")] },
    { role: "system", content: [text(BATCHING)] },
  ]

  it("leaves out a trailing system turn that holds only the one-request reminder", () => {
    for (const turn of [[text(BATCHING)], [cached(BATCHING)], BATCHING]) {
      const request = [...reminderOnly.slice(0, -1), { role: "system", content: turn }]
      expect(canonicalize(request)).toEqual(reminderOnly.slice(0, -1))
    }
  })

  it("resumes the round after a reminder-only system turn the client never sends again", () => {
    const stored = canonicalize(reminderOnly)
    expect(verifyLineage(stateFor(stored), canonicalize(afterReminderOnly)))
      .toMatchObject({ type: "continuation", resumeFrom: reminderOnly.length - 1 })
  })

  it("keeps a trailing system turn that holds anything besides the reminder", () => {
    const messages = [...reminderOnly.slice(0, -1), { role: "system", content: [text("A notice of some other kind."), text(BATCHING)] }]
    expect(canonicalize(messages)).toEqual([...reminderOnly.slice(0, -1), { role: "system", content: [text("A notice of some other kind.")] }])
  })

  it("retains everything outside a system turn, breakpoint or not", () => {
    const messages = [
      { role: "user", content: [cached("Durable instruction."), text(BATCHING)] },
      { role: "user", content: [toolResult("a"), text(BATCHING)] },
      { role: "assistant", content: [cached("Reply."), text(BATCHING)] },
    ]
    expect(canonicalize(messages)).toEqual(messages)
  })

  it("retains a system turn whose breakpoint is on its last block", () => {
    const messages = [
      { role: "system", content: [text("Earlier notice."), cached(tokensLeft(1))] },
      { role: "system", content: [text("No breakpoint."), text("Still durable.")] },
    ]
    expect(canonicalize(messages)).toEqual(messages)
  })

  it("is what the adapter hands the lineage", () => {
    expect(claudeCodeAdapter.canonicalizeMessagesForLineage?.(roundOne)).toEqual(canonicalize(roundOne))
  })
})
