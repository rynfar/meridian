/**
 * Lineage safety harness.
 *
 * `verifyLineage` decides whether an existing SDK session may be resumed, and
 * from which message. A wrong "resume" silently drops conversation history
 * from the model's context; a wrong "diverged" only costs a full replay, which
 * is always correct. The whole safety story is that asymmetry.
 *
 * Three separate bugs came from the same root cause — verification mutating
 * state the caller then read as the resume boundary:
 *
 *   - #689  client tool-loop history dropped on the continuation path
 *   - #692  stale distributed node, 515 cached vs 727 incoming
 *   - the compaction path: an early churned message plus an appended tool
 *     round sent 1 message instead of 5, dropping the tool_result
 *
 * None were caught by example-based tests, because each needed a specific
 * shape nobody thought to write down. So this file checks properties over a
 * generated scenario space instead:
 *
 *  1. INVARIANTS — must hold for every input. The important one is
 *     resume soundness: anything the caller skips must genuinely already be
 *     in the SDK session. All three bugs above violate it.
 *  2. GOLDEN MATRIX — the exact verdict per scenario, so any change to
 *     lineage.ts surfaces as a reviewable diff rather than a silent shift.
 *
 * When a change legitimately alters a verdict, update the table in the same
 * commit and say why. Do not regenerate it blindly: `D -> R` (diverged
 * becoming resume) is the dangerous direction and needs justifying; `R -> D`
 * is conservative.
 */
import { describe, it, expect } from "bun:test"
import {
  computeLineageHash,
  computeMessageHashes,
  verifyLineage,
  type SessionState,
} from "../proxy/session/lineage"

function msg(role: string, content: string) {
  return { role, content }
}

function sessionFor(msgs: Array<{ role: string; content: string }>): SessionState {
  return {
    claudeSessionId: "sdk-1",
    lastAccess: 0,
    lineageHash: computeLineageHash(msgs),
    messageCount: msgs.length,
    messageHashes: computeMessageHashes(msgs),
  }
}

/** Alternating user/assistant conversation: m0, m1, ... m(n-1). */
function conversation(n: number) {
  return Array.from({ length: n }, (_, i) =>
    msg(i % 2 === 0 ? "user" : "assistant", `m${i}`))
}

/** Copy of msgs with the message at `index` replaced by different content. */
function churn(msgs: Array<{ role: string; content: string }>, index: number) {
  return msgs.map((m, i) => (i === index ? msg(m.role, `${m.content}-changed`) : m))
}

interface Scenario {
  label: string
  stored: Array<{ role: string; content: string }>
  incoming: Array<{ role: string; content: string }>
}

/**
 * Mechanically generated: stored length × churn position × growth, plus the
 * shrink (undo) and compaction shapes. Mechanical is the point — it covers
 * combinations nobody would think to write by hand, which is exactly where
 * all three bugs lived.
 */
function scenarios(): Scenario[] {
  const out: Scenario[] = []

  for (const storedLen of [2, 4, 6, 8]) {
    const stored = conversation(storedLen)

    for (const gap of [0, 1, 2, 3, 5]) {
      const appended = Array.from({ length: gap }, (_, i) =>
        msg(i % 2 === 0 ? "assistant" : "user", `new${i}`))

      out.push({
        label: `stored=${storedLen} churn=none gap=${gap}`,
        stored,
        incoming: [...stored, ...appended],
      })

      for (let c = 0; c < storedLen; c++) {
        out.push({
          label: `stored=${storedLen} churn=@${c} gap=${gap}`,
          stored,
          incoming: [...churn(stored, c), ...appended],
        })
      }
    }

    for (const keep of [1, Math.floor(storedLen / 2)]) {
      if (keep > 0 && keep < storedLen) {
        out.push({
          label: `stored=${storedLen} shrink-to=${keep}`,
          stored,
          incoming: stored.slice(0, keep),
        })
      }
    }

    if (storedLen >= 6) {
      out.push({
        label: `stored=${storedLen} compaction`,
        stored,
        incoming: [msg("user", "summary of earlier"), ...stored.slice(-3)],
      })
    }
  }

  out.push({
    label: "unrelated history",
    stored: conversation(6),
    incoming: conversation(4).map((m, i) => msg(m.role, `other${i}`)),
  })

  return out
}

const CODE: Record<string, string> = {
  continuation: "R",
  compaction: "C",
  undo: "U",
  diverged: "D",
}

describe("lineage safety: invariants", () => {
  it("never mutates the cached session", () => {
    // The root cause of #689, #692 and the compaction drop: verification
    // rewrote messageCount, and the caller then read it as the resume
    // boundary, so the slice swallowed the entire unseen history.
    for (const s of scenarios()) {
      const session = sessionFor(s.stored)
      const snapshot = JSON.stringify(session)
      verifyLineage(session, s.incoming)
      expect(JSON.stringify(session), `${s.label} mutated the cached session`).toBe(snapshot)
    }
  })

  it("is deterministic", () => {
    for (const s of scenarios()) {
      const a = verifyLineage(sessionFor(s.stored), s.incoming)
      const b = verifyLineage(sessionFor(s.stored), s.incoming)
      expect(a.type).toBe(b.type)
    }
  })

  it("resume soundness: everything before resumeFrom is already in the session", () => {
    // THE invariant. The caller sends incoming.slice(resumeFrom), so every
    // message before that index must genuinely be in the SDK session already.
    for (const s of scenarios()) {
      const session = sessionFor(s.stored)
      const result = verifyLineage(session, s.incoming)
      if (result.type !== "continuation" && result.type !== "compaction") continue

      const storedHashes = computeMessageHashes(s.stored)
      const incomingHashes = computeMessageHashes(s.incoming)
      const { resumeFrom } = result

      // Strictly inside the array: resumeFrom is a slice start, so resuming at
      // the end sends nothing and the caller silently falls back to the last
      // user message, which is not necessarily the turn the client just added.
      expect(resumeFrom, `${s.label} resumeFrom leaves nothing to send`).toBeLessThan(s.incoming.length)

      if (result.type === "continuation") {
        // Continuation resumes from the stored count, so the stored history
        // must appear unchanged at the same positions.
        expect(resumeFrom, `${s.label} continuation resumeFrom mismatch`).toBe(s.stored.length)
        for (let i = 0; i < resumeFrom; i++) {
          expect(incomingHashes[i], `${s.label} slot ${i} differs but was skipped`).toBe(storedHashes[i]!)
        }
      } else {
        // Compaction: the head is a summary the SDK does not need (it holds
        // the real history), but the preserved suffix must sit immediately
        // before resumeFrom, matching the stored tail.
        const { suffixOverlap } = result
        expect(suffixOverlap, `${s.label} compaction without a suffix`).toBeGreaterThan(0)
        for (let k = 1; k <= suffixOverlap; k++) {
          expect(
            incomingHashes[resumeFrom - k],
            `${s.label} preserved suffix does not match stored tail at -${k}`,
          ).toBe(storedHashes[s.stored.length - k]!)
        }
      }
    }
  })

  it("never resumes a conversation that did not grow", () => {
    // Re-sending the last user message to a session that already has it
    // accumulates ghost context.
    for (const s of scenarios()) {
      if (s.incoming.length > s.stored.length) continue
      const result = verifyLineage(sessionFor(s.stored), s.incoming)
      expect(result.type, `${s.label} resumed without growing`).not.toBe("continuation")
    }
  })
})

describe("lineage safety: golden verdict matrix", () => {
  it("matches the pinned verdict for every scenario", () => {
    const actual = scenarios()
      .map(s => `${s.label} => ${CODE[verifyLineage(sessionFor(s.stored), s.incoming).type]}`)
      .join("\n")

    // R=continuation (resume)  C=compaction (resume)  U=undo (fork)  D=diverged (replay)
    const expected = `stored=2 churn=none gap=0 => D
stored=2 churn=@0 gap=0 => D
stored=2 churn=@1 gap=0 => U
stored=2 churn=none gap=1 => R
stored=2 churn=@0 gap=1 => D
stored=2 churn=@1 gap=1 => D
stored=2 churn=none gap=2 => R
stored=2 churn=@0 gap=2 => D
stored=2 churn=@1 gap=2 => D
stored=2 churn=none gap=3 => R
stored=2 churn=@0 gap=3 => D
stored=2 churn=@1 gap=3 => D
stored=2 churn=none gap=5 => R
stored=2 churn=@0 gap=5 => D
stored=2 churn=@1 gap=5 => D
stored=2 shrink-to=1 => U
stored=2 shrink-to=1 => U
stored=4 churn=none gap=0 => D
stored=4 churn=@0 gap=0 => D
stored=4 churn=@1 gap=0 => D
stored=4 churn=@2 gap=0 => D
stored=4 churn=@3 gap=0 => U
stored=4 churn=none gap=1 => R
stored=4 churn=@0 gap=1 => D
stored=4 churn=@1 gap=1 => D
stored=4 churn=@2 gap=1 => D
stored=4 churn=@3 gap=1 => D
stored=4 churn=none gap=2 => R
stored=4 churn=@0 gap=2 => D
stored=4 churn=@1 gap=2 => D
stored=4 churn=@2 gap=2 => D
stored=4 churn=@3 gap=2 => D
stored=4 churn=none gap=3 => R
stored=4 churn=@0 gap=3 => D
stored=4 churn=@1 gap=3 => D
stored=4 churn=@2 gap=3 => D
stored=4 churn=@3 gap=3 => D
stored=4 churn=none gap=5 => R
stored=4 churn=@0 gap=5 => D
stored=4 churn=@1 gap=5 => D
stored=4 churn=@2 gap=5 => D
stored=4 churn=@3 gap=5 => D
stored=4 shrink-to=1 => U
stored=4 shrink-to=2 => U
stored=6 churn=none gap=0 => D
stored=6 churn=@0 gap=0 => D
stored=6 churn=@1 gap=0 => D
stored=6 churn=@2 gap=0 => D
stored=6 churn=@3 gap=0 => D
stored=6 churn=@4 gap=0 => D
stored=6 churn=@5 gap=0 => U
stored=6 churn=none gap=1 => R
stored=6 churn=@0 gap=1 => C
stored=6 churn=@1 gap=1 => C
stored=6 churn=@2 gap=1 => C
stored=6 churn=@3 gap=1 => C
stored=6 churn=@4 gap=1 => D
stored=6 churn=@5 gap=1 => D
stored=6 churn=none gap=2 => R
stored=6 churn=@0 gap=2 => C
stored=6 churn=@1 gap=2 => C
stored=6 churn=@2 gap=2 => C
stored=6 churn=@3 gap=2 => C
stored=6 churn=@4 gap=2 => D
stored=6 churn=@5 gap=2 => D
stored=6 churn=none gap=3 => R
stored=6 churn=@0 gap=3 => C
stored=6 churn=@1 gap=3 => C
stored=6 churn=@2 gap=3 => C
stored=6 churn=@3 gap=3 => C
stored=6 churn=@4 gap=3 => D
stored=6 churn=@5 gap=3 => D
stored=6 churn=none gap=5 => R
stored=6 churn=@0 gap=5 => C
stored=6 churn=@1 gap=5 => C
stored=6 churn=@2 gap=5 => C
stored=6 churn=@3 gap=5 => C
stored=6 churn=@4 gap=5 => D
stored=6 churn=@5 gap=5 => D
stored=6 shrink-to=1 => U
stored=6 shrink-to=3 => U
stored=6 compaction => D
stored=8 churn=none gap=0 => D
stored=8 churn=@0 gap=0 => D
stored=8 churn=@1 gap=0 => D
stored=8 churn=@2 gap=0 => D
stored=8 churn=@3 gap=0 => D
stored=8 churn=@4 gap=0 => D
stored=8 churn=@5 gap=0 => D
stored=8 churn=@6 gap=0 => D
stored=8 churn=@7 gap=0 => U
stored=8 churn=none gap=1 => R
stored=8 churn=@0 gap=1 => C
stored=8 churn=@1 gap=1 => C
stored=8 churn=@2 gap=1 => C
stored=8 churn=@3 gap=1 => C
stored=8 churn=@4 gap=1 => C
stored=8 churn=@5 gap=1 => C
stored=8 churn=@6 gap=1 => D
stored=8 churn=@7 gap=1 => D
stored=8 churn=none gap=2 => R
stored=8 churn=@0 gap=2 => C
stored=8 churn=@1 gap=2 => C
stored=8 churn=@2 gap=2 => C
stored=8 churn=@3 gap=2 => C
stored=8 churn=@4 gap=2 => C
stored=8 churn=@5 gap=2 => C
stored=8 churn=@6 gap=2 => D
stored=8 churn=@7 gap=2 => D
stored=8 churn=none gap=3 => R
stored=8 churn=@0 gap=3 => C
stored=8 churn=@1 gap=3 => C
stored=8 churn=@2 gap=3 => C
stored=8 churn=@3 gap=3 => C
stored=8 churn=@4 gap=3 => C
stored=8 churn=@5 gap=3 => C
stored=8 churn=@6 gap=3 => D
stored=8 churn=@7 gap=3 => D
stored=8 churn=none gap=5 => R
stored=8 churn=@0 gap=5 => C
stored=8 churn=@1 gap=5 => C
stored=8 churn=@2 gap=5 => C
stored=8 churn=@3 gap=5 => C
stored=8 churn=@4 gap=5 => C
stored=8 churn=@5 gap=5 => C
stored=8 churn=@6 gap=5 => D
stored=8 churn=@7 gap=5 => D
stored=8 shrink-to=1 => U
stored=8 shrink-to=4 => U
stored=8 compaction => D
unrelated history => D`

    expect(actual).toBe(expected)
  })
})
