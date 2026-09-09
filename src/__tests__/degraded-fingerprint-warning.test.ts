/**
 * Degraded session fingerprint is now visible (#889).
 *
 * `getConversationFingerprint` seeds on the working directory plus the opening
 * user message; without a directory it hashes the message alone, so two
 * conversations in different repositories that begin with the same text collide
 * onto one session.
 *
 * The directory is regexed out of the `<env>` block of the system prompt, and
 * any plugin implementing `experimental.chat.system.transform` may legally
 * remove that block — `opencode-scrub` deletes it deliberately. Nothing logged
 * when it happened, which is why @connor-grady could report the mechanism while
 * observing no misbehaviour: the opencode adapter's session header keeps this
 * path unreached.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { getConversationFingerprint, extractClientCwd } from "../proxy/session/fingerprint"
import { lookupSession, resetDegradedFingerprintWarningForTests } from "../proxy/session/cache"

const messages = [{ role: "user", content: "Refactor the auth module." }]

describe("the collision this warns about", () => {
  it("gives two different directories different keys", () => {
    const a = getConversationFingerprint(messages, "/repo/alpha")
    const b = getConversationFingerprint(messages, "/repo/bravo")
    expect(a).not.toBe(b)
    expect(a).toBeTruthy()
  })

  // The actual defect: with no directory the key is the message alone, so the
  // two conversations above become indistinguishable.
  it("collides when the directory is missing", () => {
    expect(getConversationFingerprint(messages, undefined))
      .toBe(getConversationFingerprint(messages, undefined))
    expect(getConversationFingerprint(messages, undefined))
      .not.toBe(getConversationFingerprint(messages, "/repo/alpha"))
  })
})

describe("extractClientCwd against a scrubbed system prompt", () => {
  const withEnv = { system: "Here is some useful information:\n<env>\nWorking directory: /repo/alpha\n</env>" }

  it("finds the directory when the block is present", () => {
    expect(extractClientCwd(withEnv)).toBe("/repo/alpha")
  })

  // What a system.transform plugin leaves behind.
  it("returns undefined once the block is removed", () => {
    expect(extractClientCwd({ system: "You are a helpful assistant." })).toBeUndefined()
    expect(extractClientCwd({ system: "" })).toBeUndefined()
    expect(extractClientCwd({})).toBeUndefined()
  })
})

describe("the warning", () => {
  let warnings: string[]
  let originalWarn: typeof console.warn

  beforeEach(() => {
    resetDegradedFingerprintWarningForTests()
    warnings = []
    originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")) }
  })
  afterEach(() => { console.warn = originalWarn })

  it("fires on a keyless lookup with no working directory", () => {
    lookupSession(undefined, messages, undefined)
    expect(warnings.some(w => w.includes("no working directory"))).toBe(true)
  })

  it("names the likely cause and the remedy, not just the symptom", () => {
    lookupSession(undefined, messages, undefined)
    const w = warnings.join("\n")
    expect(w).toContain("<env>")
    expect(w).toContain("system.transform")
    expect(w).toContain("meridian setup")
  })

  it("does NOT fire when a working directory is present", () => {
    lookupSession(undefined, messages, "/repo/alpha")
    expect(warnings.some(w => w.includes("no working directory"))).toBe(false)
  })

  it("does NOT fire on the explicit-session path, which is unaffected", () => {
    lookupSession("ses_explicit", messages, undefined)
    expect(warnings.some(w => w.includes("no working directory"))).toBe(false)
  })

  // It describes the deployment, not the turn; per-request would bury it.
  it("fires once per process, not once per request", () => {
    for (let i = 0; i < 5; i++) lookupSession(undefined, messages, undefined)
    expect(warnings.filter(w => w.includes("no working directory")).length).toBe(1)
  })
})
