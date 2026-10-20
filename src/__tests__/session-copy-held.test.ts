/**
 * What a session holds of a history.
 *
 * A resume sends the turns after what the session holds as a delta, and the
 * delta keeps only the user's side of them: the assistant's, for turns the
 * session wrote itself, are already in it. A reply the session did not write
 * is lost to the model.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyElsewhereHoldingMore, messagesHeld, storeSession } from "../proxy/session/cache"
import type { LineageResult, SessionState } from "../proxy/session/lineage"
import { setSessionStoreDir, storeSharedSession } from "../proxy/sessionStore"
import * as sessionStore from "../proxy/sessionStore"

const session: SessionState = { claudeSessionId: "s", lastAccess: 0, messageCount: 1, lineageHash: "h" }
const user = (text: string) => ({ role: "user", content: text })
const assistant = (text: string) => ({ role: "assistant", content: text })
const continuation = (resumeFrom: number): LineageResult => ({ type: "continuation", session, resumeFrom })

describe("messagesHeld", () => {
  it("counts what a continuation resumes from and the reply it wrote to it", () => {
    expect(messagesHeld(continuation(1), [user("q1"), assistant("a1"), user("q2")])).toBe(2)
  })

  it("counts nothing of a diverged session", () => {
    expect(messagesHeld({ type: "diverged", reason: "unrelated-history" }, [user("q1")])).toBe(0)
  })
})

describe("copyElsewhereHoldingMore", () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "meridian-copy-held-"))
    setSessionStoreDir(directory)
  })
  afterEach(() => {
    setSessionStoreDir(null)
    rmSync(directory, { recursive: true, force: true })
  })

  // Where the conversation is now: three turns, the last one asked.
  const history = [user("q1"), assistant("a1"), user("q2"), assistant("a2"), user("q3")]
  const others = [{ profileId: "backup", key: "backup:conversation" }]

  it("finds the copy that went on elsewhere, used since this account's", () => {
    expect(storeSession("backup:conversation", history.slice(0, 3), "sdk-backup")).not.toBe(false)
    const found = copyElsewhereHoldingMore(others, history, { lastUsedAt: 0, held: 2 })
    expect(found).toMatchObject({ profileId: "backup", key: "backup:conversation", lineage: { type: "continuation", resumeFrom: 3 } })
  })

  it("ignores a copy elsewhere not used since this account's", () => {
    expect(storeSession("backup:conversation", history.slice(0, 3), "sdk-backup")).not.toBe(false)
    expect(copyElsewhereHoldingMore(others, history, { lastUsedAt: Date.now() + 60_000, held: 2 })).toBeUndefined()
  })

  it("ignores a copy elsewhere that holds no more than this account's", () => {
    expect(storeSession("backup:conversation", history.slice(0, 1), "sdk-backup")).not.toBe(false)
    expect(copyElsewhereHoldingMore(others, history, { lastUsedAt: 0, held: 2 })).toBeUndefined()
  })

  it("counts a copy published from a plugin-rewritten execution by its raw client lineage", () => {
    // No SDK-prefix proof (lineageHash empty); the raw ancestry is kept apart.
    expect(storeSession("backup:conversation", history.slice(0, 3), "sdk-transformed", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, false)).not.toBe(false)
    const found = copyElsewhereHoldingMore(others, history, { lastUsedAt: 0, held: 2 })
    expect(found?.session).toMatchObject({ lineageHash: "", clientLineageHash: expect.any(String) })
    expect(found?.lineage.type).toBe("continuation")
  })

  it("does not count a legacy copy elsewhere that proves no lineage", () => {
    expect(storeSharedSession("backup:conversation", "sdk-legacy", 3, "")).not.toBe(false)
    expect(copyElsewhereHoldingMore(others, history, { lastUsedAt: 0, held: 2 })).toBeUndefined()
  })

  it("rejects an unreadable other mapping instead of treating the copy as absent", () => {
    const read = spyOn(sessionStore, "lookupSharedSessionResult").mockReturnValue({
      status: "error", error: new Error("owned other-profile read failure"),
    })
    try {
      expect(() => copyElsewhereHoldingMore(others, history, { lastUsedAt: 0, held: 2 }))
        .toThrow("owned other-profile read failure")
    } finally { read.mockRestore() }
  })

  it("rejects a later read error even after finding a newer readable copy", () => {
    expect(storeSession("backup:conversation", history.slice(0, 3), "sdk-backup")).not.toBe(false)
    const realRead = sessionStore.lookupSharedSessionResult
    const read = spyOn(sessionStore, "lookupSharedSessionResult").mockImplementation(key =>
      key === "unreadable:conversation"
        ? { status: "error", error: new Error("owned later-profile read failure") }
        : realRead(key))
    try {
      expect(() => copyElsewhereHoldingMore([...others, { profileId: "unreadable", key: "unreadable:conversation" }],
        history, { lastUsedAt: 0, held: 2 })).toThrow("owned later-profile read failure")
    } finally { read.mockRestore() }
  })
})
