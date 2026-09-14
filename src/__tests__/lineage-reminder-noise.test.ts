/**
 * The lineage hash must ignore <system-reminder> noise the same way
 * getConversationFingerprint (fingerprint.ts) already does. Otherwise a
 * reminder's dynamic content (file diagnostics, git status, tool manifest)
 * regenerating between turns of the SAME conversation collapses prefix
 * overlap to 0 forever — full replay every turn — even after the
 * conversation has already been bucketed to the right cached session.
 */
import { describe, it, expect } from "bun:test"
import {
  hashMessage,
  computeLineageHash,
  computeMessageHashes,
  computeMessageBlockHashes,
  measurePrefixOverlap,
  verifyLineage,
  type SessionState,
} from "../proxy/session/lineage"

const bigReminder = (payload: string) =>
  `<system-reminder>\n# Environment\n${payload}\n${"x".repeat(2400)}\n</system-reminder>`

function session(messages: Array<{ role: string; content: unknown }>): SessionState {
  return {
    claudeSessionId: "source",
    lastAccess: 0,
    messageCount: messages.length,
    lineageHash: computeLineageHash(messages),
    messageHashes: computeMessageHashes(messages),
    messageBlockHashes: computeMessageBlockHashes(messages),
  }
}

describe("lineage hashing ignores system-reminder noise", () => {
  it("hashes a reminder-only message the same across turns even when the reminder payload changes", () => {
    const turn1 = { role: "user", content: [{ type: "text", text: bigReminder("diagnostics: none") }] }
    const turn2 = { role: "user", content: [{ type: "text", text: bigReminder("diagnostics: 2 warnings") }] }
    expect(hashMessage(turn1)).toBe(hashMessage(turn2))
  })

  it("hashes reminder noise plus task text the same as bare task text", () => {
    const withReminder = {
      role: "user",
      content: [{ type: "text", text: bigReminder("diagnostics: none") }, { type: "text", text: "fix the login bug" }],
    }
    const bare = { role: "user", content: [{ type: "text", text: "fix the login bug" }] }
    expect(hashMessage(withReminder)).not.toBe(hashMessage(bare))
    // The reminder block contributes nothing once stripped: only the second
    // text block's content should distinguish it, so an identical reminder
    // with different task text must still change the hash.
    const differentTask = {
      role: "user",
      content: [{ type: "text", text: bigReminder("diagnostics: none") }, { type: "text", text: "add a test" }],
    }
    expect(hashMessage(withReminder)).not.toBe(hashMessage(differentTask))
  })

  it("hashes a plain-string message with an inline reminder the same across turns", () => {
    const turn1 = { role: "user", content: `${bigReminder("build: green")}\nfix the login bug` }
    const turn2 = { role: "user", content: `${bigReminder("build: red")}\nfix the login bug` }
    expect(hashMessage(turn1)).toBe(hashMessage(turn2))
  })

  it("keeps prefix overlap intact across turns when only the reminder payload changes", () => {
    // Droid wire shape: message 0 is a reminder-only opener, the task
    // arrives in message 1. A live daemon observed this exact shape fail to
    // resume for 29+ consecutive turns because message 0 never re-hashed
    // the same way twice.
    const opener1 = { role: "user", content: [{ type: "text", text: bigReminder("cwd: /repo, diagnostics: none") }] }
    const task = { role: "user", content: "fix the login bug" }
    const stored = session([opener1, task])

    const opener2 = { role: "user", content: [{ type: "text", text: bigReminder("cwd: /repo, diagnostics: 3 errors") }] }
    const followUp = { role: "user", content: "what changed?" }
    const incoming = [opener2, task, { role: "assistant", content: "on it" }, followUp]

    const result = verifyLineage(stored, incoming)
    expect(result.type).not.toBe("diverged")
    if (result.type === "diverged") {
      throw new Error(`expected resumable, got diverged: ${result.reason}`)
    }
  })

  it("measures full prefix overlap across a growing conversation despite a changing reminder", () => {
    const opener = (diagnostics: string) => ({
      role: "user",
      content: [{ type: "text", text: bigReminder(diagnostics) }],
    })
    const history = [opener("none"), { role: "user", content: "start" }, { role: "assistant", content: "ok" }]
    const stored = computeMessageHashes(history)
    const incoming = computeMessageHashes([
      opener("2 warnings"),
      { role: "user", content: "start" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "next turn" },
    ])
    expect(measurePrefixOverlap(stored, incoming)).toBe(stored.length)
  })
})
