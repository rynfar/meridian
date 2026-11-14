/**
 * A client may regroup its user turns between requests: split one user
 * message into two, merge two into one, or drop / add a user message that
 * holds only a `<system-reminder>`. The SDK transcript never held those
 * boundaries (consecutive user messages reach it as one turn), so a regroup
 * must not cost a full-history replay.
 *
 * Incident (2026-11-07, Oh My Pi through the pi adapter): an idle rebuild of
 * the live history appended an eval-state reminder as its own user message
 * that the session file never kept. After a restart the reminder-only message
 * was gone, every later message shifted by one, and the next turn replayed
 * 767 messages (a 409K-token cache write):
 *
 *   Stale session detected: prefix overlap 615/769, incoming 767 msgs. reason=undo-gap
 *   first mismatch at index 615: stored=8aa5fa057f04 incoming=cc1c23febc5d,
 *   incoming now user[text,text] 187B, stored 1 blocks -> incoming 2 blocks (appended)
 *
 * The fixtures below rebuild that shape with synthetic content. Two of their
 * digests are the incident's own, which ties the fixture to the logged
 * history: a reminder-only user message hashes to `8aa5fa057f04…`, and the
 * side request's opening note (a reminder plus a newline) to `147f348bdf28…`.
 */
import { describe, expect, it } from "bun:test"
import {
  computeLineageHash,
  computeMessageBlockHashes,
  computeMessageHashes,
  hashMessage,
  inheritSdkUuids,
  verifyLineage,
  type SessionState,
} from "../proxy/session/lineage"

type Message = { role: string; content: unknown }

const text = (value: string) => ({ type: "text", text: value })
const reminder = (body: string) => `<system-reminder>\n${body}\n</system-reminder>`
const user = (...blocks: string[]): Message => ({ role: "user", content: blocks.map(text) })
const assistant = (value: string): Message => ({ role: "assistant", content: [text(value)] })
const toolCall = (id: string): Message => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: `why ${id}`, signature: "sig" },
    { type: "tool_use", id, name: "bash", input: { command: id } },
  ],
})
const toolResult = (id: string): Message => ({
  role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `${id} output` }],
})

/** A stored session as `storeSession` writes it: per-message and per-block
 *  hashes, and one SDK UUID slot per message plus the reply's. */
function stored(messages: Message[], uuids: Array<string | null>): SessionState {
  return {
    claudeSessionId: "sdk-source",
    lastAccess: 0,
    messageCount: messages.length,
    lineageHash: computeLineageHash(messages),
    messageHashes: computeMessageHashes(messages),
    messageBlockHashes: computeMessageBlockHashes(messages),
    sdkMessageUuids: uuids,
  }
}

/** UUIDs for every assistant at or after `from`, null elsewhere: what a fresh
 *  replay leaves behind, followed by natively resumed turns. */
function uuidsFrom(messages: Message[], from: number, reply: string | null = "uuid-reply"): Array<string | null> {
  return [...messages.map((m, i) => m.role === "assistant" && i >= from ? `uuid-${i}` : null), reply]
}

// --- The incident's shape ---

const head: Message[] = [
  user("start the work"),
  toolCall("call-1"), toolResult("call-1"),
  toolCall("call-2"), toolResult("call-2"),
  assistant("first part done"),
  user("continue"),
  toolCall("call-3"), toolResult("call-3"),
  assistant("second part done"),
]
/** Live history only: the rebuild's eval-state note, a user message holding
 *  only a system reminder. */
const evalStateNote = user(reminder("eval kernel state: x = 1"))
const prompt = user(reminder("Today: 2026-11-07; cwd /work"), "polish, fix and create PR")
const stretchNote = user("Reply in stretchtext.")
const toolLoop: Message[] = [
  toolCall("call-4"), toolResult("call-4"),
  toolCall("call-5"), toolResult("call-5"),
  toolCall("call-6"), toolResult("call-6"),
]
const finalAnswer = assistant("PR opened")
/** omp's background request, stored under the main key. */
const sideTail: Message[] = [
  user(`${reminder("probe context")}\n`),
  { role: "system", content: [] },
  user("Is the task complete?"),
]
const nextPrompt = user(reminder("Today: 2026-11-07; cwd /work"), "now update the changelog")

/** Stored at 09:16:57: the live history (with the eval note) plus the side request. */
const storedIncident = [...head, evalStateNote, prompt, stretchNote, ...toolLoop, finalAnswer, ...sideTail]
/** Sent at 09:27:03 after the restart: the note is gone; a new prompt follows. */
const incomingIncident = [...head, prompt, stretchNote, ...toolLoop, finalAnswer, nextPrompt, stretchNote]
/** The 08:59 fresh replay wiped every SDK UUID up to the stretch note. */
const firstNativeTurn = head.length + 3
const incidentUuids = uuidsFrom(storedIncident, firstNativeTurn, "uuid-side-reply")
const storedFinal = storedIncident.indexOf(finalAnswer)
const incomingFinal = incomingIncident.indexOf(finalAnswer)

describe("incident: a reminder-only user message disappeared (2026-11-07)", () => {
  it("rebuilds the logged digests", () => {
    expect(hashMessage(evalStateNote).slice(0, 12)).toBe("8aa5fa057f04")
    expect(hashMessage(sideTail[0]!).slice(0, 12)).toBe("147f348bdf28")
  })

  it("realigns past the dropped note, leaving only the side request as the change", () => {
    const result = verifyLineage(stored(storedIncident, incidentUuids), incomingIncident)

    // Before the fix the first mismatch was the eval note itself (index
    // `head.length`, stored 8aa5fa057f04 -> incoming cc1c23febc5d), so
    // nothing after it counted as shared history. Now the shared prefix runs
    // through the final answer, and the remaining change is the side
    // request's opening note: an undo of omp's background turn, whose
    // prefix ends in an assistant with an SDK UUID.
    expect(result).toMatchObject({
      type: "diverged",
      reason: "undo-gap",
      prefixOverlap: incomingFinal + 1,
      regrouped: { runs: 1, storedMessages: storedFinal + 1, incomingMessages: incomingFinal + 1 },
      mismatch: { index: incomingFinal + 1, storedDigest: hashMessage(sideTail[0]!), storedCount: storedIncident.length - 1 },
    })
  })

  it("with partialReplay, forks the undone side request at the final answer's SDK UUID", () => {
    const result = verifyLineage(stored(storedIncident, incidentUuids), incomingIncident, { partialReplay: true })

    // The regroup and the rollback-tail compose: the fork point is chosen in
    // incoming positions on the realigned session, so the moved final answer
    // keeps its stored UUID and only the new prompt and stretch note follow.
    expect(result).toMatchObject({
      type: "diverged",
      reason: "undo-gap",
      prefixOverlap: incomingFinal + 1,
      regrouped: { runs: 1 },
      rollbackTail: { rollbackIndex: incomingFinal, rollbackUuid: `uuid-${storedFinal}`, settledToolIds: [] },
    })
    if (result.type !== "diverged" || !result.rollbackTail) throw new Error("expected a rollback-tail candidate")
    expect(result.rollbackTail.session.claudeSessionId).toBe("sdk-source")
    expect(incomingIncident.length - 1 - result.rollbackTail.rollbackIndex).toBe(2)
  })

  it("resumes the main turn when no side request intervened", () => {
    const storedTurn = [...head, evalStateNote, prompt, stretchNote, ...toolLoop]
    const uuids = uuidsFrom(storedTurn, firstNativeTurn)
    const incoming = [...head, prompt, stretchNote, ...toolLoop, finalAnswer, nextPrompt]
    const result = verifyLineage(stored(storedTurn, uuids), incoming)

    // Before the fix: diverged (modified-history) at the eval note, a full replay.
    expect(result).toMatchObject({
      type: "continuation",
      resumeFrom: storedTurn.length - 1,
      regrouped: { runs: 1, storedMessages: storedTurn.length, incomingMessages: storedTurn.length - 1 },
    })
    // UUIDs follow their assistants into incoming positions; the trailing
    // reply slot moves with them. The server inherits from the result's session.
    if (result.type !== "continuation") throw new Error("expected a continuation")
    const inherited = inheritSdkUuids(result.session, result, incoming)
    incoming.forEach((message, index) => {
      if (index >= storedTurn.length - 1) return
      const storedIndex = index < head.length ? index : index + 1
      expect(inherited[index]).toBe(uuids[storedIndex] ?? null)
    })
    expect(inherited[storedTurn.length - 1]).toBe("uuid-reply")
  })
})

// --- Regrouped user turns that keep the stored history ---

function expectResumes(storedMessages: Message[], incoming: Message[], resumeFrom: number) {
  const result = verifyLineage(stored(storedMessages, uuidsFrom(storedMessages, 0)), incoming)
  expect(result).toMatchObject({ type: "continuation", resumeFrom })
  expect(result.type === "continuation" && result.regrouped).toBeTruthy()
  return result
}

describe("regrouped user turns resume", () => {
  it("two user messages merged into one", () => {
    expectResumes(
      [user("a"), user("b"), assistant("A1"), user("c")],
      [user("a", "b"), assistant("A1"), user("c"), assistant("A2"), user("d")],
      3,
    )
  })

  it("one user message split into two", () => {
    expectResumes(
      [user("a", "b"), assistant("A1"), user("c")],
      [user("a"), user("b"), assistant("A1"), user("c"), assistant("A2"), user("d")],
      4,
    )
  })

  it("a reminder-only user message added between turns", () => {
    expectResumes(
      [user("a"), assistant("A1"), user("b"), assistant("A2"), user("c")],
      [user("a"), assistant("A1"), user(reminder("added")), user("b"), assistant("A2"), user("c"), assistant("A3"), user("d")],
      6,
    )
  })

  it("a reminder-only user message dropped right before an assistant turn", () => {
    expectResumes(
      [user("a"), user(reminder("gone")), assistant("A1"), user("b")],
      [user("a"), assistant("A1"), user("b"), assistant("A2"), user("c")],
      3,
    )
  })

  it("a reminder-only message dropped from the stored history's last user run", () => {
    expectResumes(
      [user("a"), assistant("A1"), user(reminder("gone")), user("b")],
      [user("a"), assistant("A1"), user("b"), assistant("A2"), user("c")],
      3,
    )
  })

  it("several regrouped runs in one history", () => {
    expectResumes(
      [user("a"), user("b"), assistant("A1"), user(reminder("x")), user("c"), assistant("A2"), user("d")],
      [user("a", "b"), assistant("A1"), user("c"), assistant("A2"), user("d"), assistant("A3"), user("e")],
      5,
    )
  })

  it("an undo after a regroup forks at the moved assistant", () => {
    const storedMessages = [user("a"), user(reminder("x")), user("b"), assistant("A1"), user("c"), assistant("A2"), user("d")]
    const result = verifyLineage(stored(storedMessages, uuidsFrom(storedMessages, 0)), [user("a", "b"), assistant("A1"), user("c-edited")])
    expect(result).toMatchObject({ type: "undo", prefixOverlap: 2, rollbackUuid: "uuid-3", regrouped: { runs: 1 } })
  })
})

// --- Changes that are not a regroup keep today's verdicts ---

function expectDiverges(storedMessages: Message[], incoming: Message[], session = stored(storedMessages, uuidsFrom(storedMessages, 0))) {
  const result = verifyLineage(session, incoming)
  expect(result.type).toBe("diverged")
  expect("regrouped" in result).toBe(false)
}

describe("changed user content still diverges", () => {
  it("an edited block inside a regrouped run", () => {
    expectDiverges(
      [user("a"), user("b"), assistant("A1"), user("c")],
      [user("a", "b-edited"), assistant("A1"), user("c"), assistant("A2"), user("d")],
    )
  })

  it("reordered blocks", () => {
    expectDiverges(
      [user("a"), user("b"), assistant("A1"), user("c")],
      [user("b", "a"), assistant("A1"), user("c"), assistant("A2"), user("d")],
    )
  })

  it("a block moved across an assistant turn", () => {
    expectDiverges(
      [user("a"), user("b"), assistant("A1"), user("c")],
      [user("a"), assistant("A1"), user("b", "c"), assistant("A2"), user("d")],
    )
  })

  it("a dropped user message that held real text", () => {
    expectDiverges(
      [user("a"), user("b"), assistant("A1"), user("c")],
      [user("a"), assistant("A1"), user("c"), assistant("A2"), user("d")],
    )
  })

  it("text appended to the stored history's trailing user slot", () => {
    expectDiverges([user("a")], [user("a", "b"), assistant("A1")])
    expectDiverges(
      [assistant("A0"), user(reminder("x")), user("a")],
      [assistant("A0"), user("a", "b"), assistant("A1")],
    )
  })

  it("a reminder with text beside it is content, not a reminder-only message", () => {
    expectDiverges(
      [user("a"), user(`${reminder("x")}\n`), assistant("A1"), user("b")],
      [user("a"), assistant("A1"), user("b"), assistant("A2"), user("c")],
    )
  })

  it("a run holding a block the hash ignores", () => {
    const withThinking: Message = { role: "user", content: [text("a"), { type: "thinking", thinking: "t", signature: "s" }, text("b")] }
    expectDiverges(
      [user("a"), user("b"), assistant("A1"), user("c")],
      [withThinking, assistant("A1"), user("c"), assistant("A2"), user("d")],
    )
  })

  it("a session stored without block hashes", () => {
    const storedMessages = [user("a"), user("b"), assistant("A1"), user("c")]
    const { messageBlockHashes: _omitted, ...legacy } = stored(storedMessages, uuidsFrom(storedMessages, 0))
    expectDiverges(storedMessages, [user("a", "b"), assistant("A1"), user("c"), assistant("A2"), user("d")], legacy)
  })

  it("a regroup in the trailing user run, which no reply follows yet", () => {
    // A resend of the same turn with its reminder dropped keeps main's verdict.
    const storedMessages = [user("a"), assistant("A1"), user(reminder("x")), user("b")]
    const result = verifyLineage(stored(storedMessages, uuidsFrom(storedMessages, 0)), [user("a"), assistant("A1"), user("b")])
    expect(result).toMatchObject({ type: "diverged", reason: "unrelated-history", prefixOverlap: 2 })
    expect("regrouped" in result).toBe(false)
  })
})
