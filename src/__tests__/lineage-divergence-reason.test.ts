/**
 * Every lineage divergence names itself (#820).
 *
 * `classifyLineage` logged four outcomes; `diverged` logged only for
 * `modified-history` and `undo-gap`. Everything else was silent, and the
 * request line renders every divergence without a cached session as the same
 * literal `lineage=new` — so a key that never resolved, a key that resolved
 * against a history that did not match, and a request that never looked at
 * all were indistinguishable from a log.
 *
 * #820 is the cost of that: 6,514 `lineage=new` requests with zero explanatory
 * lines, and the reporter could only identify the bypass by reading
 * `server.ts`. Two reporters drained a Max subscription window first, because
 * every one of those requests returns 200 and nothing in the proxy's own
 * success metrics moves.
 *
 * `independent-request` is the worst of them: it is assigned before
 * `classifyLineage` ever runs, and four unrelated rules collapse into it.
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  independentRequestCause,
  formatDivergence,
  type LineageResult,
  type SessionState,
} from "../proxy/session/lineage"

describe("independentRequestCause", () => {
  const base = {
    hasSessionKey: false,
    forkSource: false,
    isSubagent: false,
    clientDrivenLoop: false,
    hasDurableKey: true,
  }

  it("returns no cause for an ordinary keyed request", () => {
    expect(independentRequestCause({ ...base, hasSessionKey: true })).toBeUndefined()
  })

  it("returns no cause for an ordinary headerless request", () => {
    expect(independentRequestCause(base)).toBeUndefined()
  })

  it("names the headerless tool-result loop — the #820 bypass", () => {
    expect(independentRequestCause({ ...base, clientDrivenLoop: true }))
      .toBe("headerless-tool-result")
  })

  it("names a fork source and a subagent separately", () => {
    expect(independentRequestCause({ ...base, forkSource: true })).toBe("fork-source")
    expect(independentRequestCause({ ...base, isSubagent: true })).toBe("subagent")
  })

  it("names a request with no derivable cache identity", () => {
    expect(independentRequestCause({ ...base, hasDurableKey: false }))
      .toBe("no-cache-identity")
  })

  // The invariant the guard is built on: an explicit key cannot collide, so a
  // keyed fork or subagent resumes normally. Losing this re-broke pylon's
  // long-lived workers once already (they fresh-replayed every turn).
  it("lets an explicit key override the fork and subagent guards", () => {
    expect(independentRequestCause({ ...base, hasSessionKey: true, forkSource: true }))
      .toBeUndefined()
    expect(independentRequestCause({ ...base, hasSessionKey: true, isSubagent: true }))
      .toBeUndefined()
  })

  // `isClientDrivenLoop` already requires a headerless request, so a session
  // key cannot reach this branch at all — asserted so the precedence is not
  // read as "a key also overrides the tool-result bypass".
  it("reports the first rule that fired when several apply", () => {
    expect(independentRequestCause({ ...base, forkSource: true, clientDrivenLoop: true }))
      .toBe("fork-source")
    expect(independentRequestCause({ ...base, clientDrivenLoop: true, hasDurableKey: false }))
      .toBe("headerless-tool-result")
  })
})

describe("formatDivergence", () => {
  const state = { claudeSessionId: "s", lastAccess: 0, messageCount: 1 } as SessionState

  it("says nothing for a resumable classification", () => {
    expect(formatDivergence({ type: "continuation", session: state, resumeFrom: 1 })).toBeUndefined()
    expect(formatDivergence({ type: "undo", session: state, prefixOverlap: 1, rollbackUuid: undefined }))
      .toBeUndefined()
    expect(formatDivergence({ type: "compaction", session: state, resumeFrom: 1, suffixOverlap: 1 }))
      .toBeUndefined()
  })

  // connor-grady's point: these two are different bugs with the same visible
  // symptom, and the log could not tell them apart.
  it("separates a key that never resolved from a history that did not match", () => {
    expect(formatDivergence({ type: "diverged", reason: "not-found" })).toBe("not-found")
    expect(formatDivergence({ type: "diverged", reason: "modified-history" })).toBe("modified-history")
  })

  it("appends the cause only to independent-request", () => {
    expect(formatDivergence({ type: "diverged", reason: "independent-request" }, "headerless-tool-result"))
      .toBe("independent-request:headerless-tool-result")
    expect(formatDivergence({ type: "diverged", reason: "modified-history" }, "headerless-tool-result"))
      .toBe("modified-history")
  })

  it("still names independent-request when no cause was supplied", () => {
    expect(formatDivergence({ type: "diverged", reason: "independent-request" }))
      .toBe("independent-request")
  })

  // The field is pasted into public issues alongside the request line, so it
  // must stay a fixed identifier and never carry message content.
  it("emits only fixed identifiers", () => {
    const reasons: LineageResult[] = [
      { type: "diverged", reason: "unverifiable" },
      { type: "diverged", reason: "replayed-request" },
      { type: "diverged", reason: "modified-history" },
      { type: "diverged", reason: "undo-gap" },
      { type: "diverged", reason: "unrelated-history" },
      { type: "diverged", reason: "not-found" },
      { type: "diverged", reason: "independent-request" },
      { type: "diverged", reason: "priority-failback" },
      { type: "diverged", reason: "missing-session-header" },
      { type: "diverged", reason: "concurrent-race" },
    ]
    for (const r of reasons) {
      expect(formatDivergence(r, "no-cache-identity")).toMatch(/^[a-z-]+(:[a-z-]+)?$/)
    }
  })
})

/**
 * The rejections that reached `classifyLineage` and printed nothing: a stored
 * session existed under the key and was refused without a word.
 */
describe("classifyLineage names the rejections that were silent", () => {
  let dir: string
  let errSpy: ReturnType<typeof spyOn>
  let cache: typeof import("../proxy/session/cache")
  let store: typeof import("../proxy/sessionStore")

  beforeEach(async () => {
    cache = await import("../proxy/session/cache")
    store = await import("../proxy/sessionStore")
    dir = mkdtempSync(join(tmpdir(), "meridian-divergence-reason-"))
    store.setSessionStoreDir(dir, { skipLocking: false })
    cache.clearSessionCache()
    errSpy = spyOn(console, "error")
  })

  afterEach(() => {
    errSpy.mockRestore()
    cache.clearSessionCache()
    store.setSessionStoreDir(null)
    rmSync(dir, { recursive: true, force: true })
  })

  const lines = (): string[] => errSpy.mock.calls.map((c: any) => String(c[0]))
  const notResumable = () => lines().find((l: string) => l.includes("Session not resumable"))

  it("names a replayed request", () => {
    const messages = [{ role: "user", content: "hello" }]
    cache.storeSession("key-replay", messages, "sdk-a")
    expect(cache.lookupSession("key-replay", messages).type).toBe("diverged")
    expect(notResumable()).toContain("reason=replayed-request")
    expect(notResumable()).toContain("incoming 1 msgs")
  })

  it("names an unrelated history", () => {
    cache.storeSession("key-unrelated", [{ role: "user", content: "first conversation" }], "sdk-b")
    const result = cache.lookupSession("key-unrelated", [{ role: "user", content: "different conversation" }])
    expect(result.type).toBe("diverged")
    expect(notResumable()).toContain("reason=unrelated-history")
  })

  it("names an entry that cannot prove what it holds", () => {
    cache.storeSession("key-unverifiable", [], "sdk-c")
    const result = cache.lookupSession("key-unverifiable", [{ role: "user", content: "anything" }])
    expect(result.type).toBe("diverged")
    expect(notResumable()).toContain("reason=unverifiable")
  })

  it("keeps the existing wording for a history rewrite", () => {
    const stored = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }]
    cache.storeSession("key-modified", stored, "sdk-d")
    const rewritten = [{ role: "user", content: "a" }, { role: "assistant", content: "CHANGED" },
      { role: "user", content: "c" }]
    expect(cache.lookupSession("key-modified", rewritten).type).toBe("diverged")
    // `Stale session detected` is what field log analysis already greps for.
    expect(lines().find((l: string) => l.includes("Stale session detected"))).toBeDefined()
    expect(notResumable()).toBeUndefined()
  })

  // `not-found` is returned before classification, and it is the first turn of
  // every conversation. It belongs on the request line, not on a line of its
  // own, or the diagnostic drowns the thing it is supposed to reveal.
  it("stays quiet for a key that simply is not there", () => {
    expect(cache.lookupSession("key-absent", [{ role: "user", content: "hi" }]))
      .toEqual({ type: "diverged", reason: "not-found" })
    expect(notResumable()).toBeUndefined()
  })

  it("leaks no message content", () => {
    const secret = "SUPER-SECRET-PROMPT-TEXT"
    cache.storeSession("key-secret", [{ role: "user", content: secret }], "sdk-e")
    cache.lookupSession("key-secret", [{ role: "user", content: secret }])
    expect(notResumable()).toBeDefined()
    expect(notResumable()).not.toContain(secret)
  })
})
