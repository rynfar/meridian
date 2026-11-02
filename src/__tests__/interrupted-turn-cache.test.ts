/**
 * The interrupted-turn record against a real JSON session store (session
 * spec, *Interrupted turns*): marking withholds the durable resume proof, the
 * record binds to the exact write, and one request takes it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearSessionCache,
  forgetInterruptedTurnsForTests,
  lookupSession,
  markSessionInterrupted,
  storeSession,
  takeInterruptedTurn,
} from "../proxy/session/cache"
import { computeLineageHash } from "../proxy/session/lineage"
import { interruptedTurnOf, type InterruptedTurn } from "../proxy/session/interruptedTurn"
import { lookupSharedSessionResult, setSessionStoreDir, storeSharedSession } from "../proxy/sessionStore"

type Message = { role: string; content: any }

const KEY = "interrupted-cache-key"
const PREFIX: Message[] = [{ role: "user", content: "u1" }]
const STOPPED: Message[] = [...PREFIX, { role: "assistant", content: [{ type: "text", text: "a1" }] }, { role: "user", content: "u2" }]
const NEXT: Message[] = [...STOPPED, { role: "user", content: "u3" }]
const PROOF = computeLineageHash(PREFIX)
const SOURCE = { claudeSessionId: "sess-1", messageCount: 1, lineageHash: PROOF }

let directory = ""

beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "interrupted-turn-cache-")))
  setSessionStoreDir(directory)
  await clearSessionCache()
})

afterEach(async () => {
  await clearSessionCache()
  setSessionStoreDir(null)
  rmSync(directory, { recursive: true, force: true })
})

function found() {
  const result = lookupSharedSessionResult(KEY)
  if (result.status !== "found") throw new Error(`expected a stored mapping, got ${result.status}`)
  return result
}

function turn(): InterruptedTurn {
  const recorded = interruptedTurnOf(STOPPED, 1, PROOF)
  if (!recorded) throw new Error("expected an interrupted turn")
  return recorded
}

/** Publish the session after turn 1, then mark it as a stopped turn 2 would. */
function publishAndMark(): string {
  const published = storeSession(KEY, PREFIX, SOURCE.claudeSessionId)
  if (!published) throw new Error("publication failed")
  const generation = markSessionInterrupted(KEY, undefined, STOPPED, published, SOURCE, turn())
  if (!generation) throw new Error("marking failed")
  return generation
}

describe("markSessionInterrupted", () => {
  it("keeps the session and its hashes but withholds the resume proof durably", () => {
    publishAndMark()
    const { session } = found()
    expect(session.claudeSessionId).toBe("sess-1")
    expect(session.messageCount).toBe(1)
    expect(session.lineageHash).toBe("")
    expect(session.clientLineageHash).toBe(PROOF)
    expect(session.messageHashes?.length).toBe(1)
  })

  it("drops the in-memory copy that still carries the proof", () => {
    publishAndMark()
    // A store read failure falls back to memory; that copy must not resume.
    writeFileSync(join(directory, "sessions.json"), "{ not json")
    const lineage = lookupSession(KEY, NEXT)
    expect(lineage.type).toBe("diverged")
  })

  it("refuses a mapping that changed since the turn read it", () => {
    const published = storeSession(KEY, PREFIX, SOURCE.claudeSessionId)
    if (!published) throw new Error("publication failed")
    expect(storeSession(KEY, PREFIX, SOURCE.claudeSessionId)).toBeTruthy()
    expect(markSessionInterrupted(KEY, undefined, STOPPED, published, SOURCE, turn())).toBe(false)
    expect(found().session.lineageHash).toBe(PROOF)
  })

  it("marks again a mapping an earlier stopped turn already marked", () => {
    const first = publishAndMark()
    expect(takeInterruptedTurn(KEY, first, found().session)).toBeDefined()
    const second = markSessionInterrupted(KEY, undefined, STOPPED, first, SOURCE, turn())
    expect(second).toBeTruthy()
    expect(takeInterruptedTurn(KEY, second || undefined, found().session)).toBeDefined()
  })
})

describe("takeInterruptedTurn", () => {
  it("hands the record to one request, with the proof restored", () => {
    const generation = publishAndMark()
    const claim = takeInterruptedTurn(KEY, generation, found().session)
    expect(claim?.restored.lineageHash).toBe(PROOF)
    expect(claim?.restored.claudeSessionId).toBe("sess-1")
    expect(claim?.markedFrom).not.toBe(generation)
    expect(takeInterruptedTurn(KEY, generation, found().session)).toBeUndefined()
  })

  it("refuses a mapping any later write replaced, even one that still withholds the proof", () => {
    publishAndMark()
    const before = found()
    const rewritten = storeSharedSession(KEY, "sess-1", 1, "", undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, before.generation, PROOF, undefined)
    expect(rewritten).toBeTruthy()
    const after = found()
    expect(after.session.lineageHash).toBe("")
    expect(takeInterruptedTurn(KEY, after.generation, after.session)).toBeUndefined()
  })

  it("finds nothing after a restart", () => {
    const generation = publishAndMark()
    forgetInterruptedTurnsForTests()
    expect(takeInterruptedTurn(KEY, generation, found().session)).toBeUndefined()
  })
})
