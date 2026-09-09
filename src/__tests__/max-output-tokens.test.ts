/**
 * Client `max_tokens` enforcement (#874).
 *
 * `max_tokens` is required on `/v1/messages` and the contract makes it a hard
 * cap on output, with a cut-off response reporting `stop_reason: "max_tokens"`.
 * Nothing on that path read it: 16 produced 3900 output tokens and `end_turn`.
 *
 * The Agent SDK's `Options` has no output cap, so the only lever is the CLI's
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS` — which THROWS when it trips rather than
 * returning a truncated turn. These tests cover the two pure pieces: the env
 * value that is passed down, and the predicate that recognises the refusal.
 *
 * The end-to-end behaviour needs the real CLI and is gated by E49.
 */

import { describe, it, expect } from "bun:test"
import { isOutputTokenCapExceeded } from "../proxy/errors"

describe("isOutputTokenCapExceeded", () => {
  it("recognises the CLI's refusal, wrapped as it actually arrives", () => {
    // Captured verbatim from CLI 2.1.263 with a cap of 64.
    expect(isOutputTokenCapExceeded(
      "Claude Code returned an error result: API Error: Claude's response exceeded the 64 output token maximum."
      + " To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
    )).toBe(true)
  })

  it("matches any cap value", () => {
    for (const n of [1, 16, 512, 32000]) {
      expect(isOutputTokenCapExceeded(`Claude's response exceeded the ${n} output token maximum.`)).toBe(true)
    }
  })

  // The context-window refusal is about INPUT length and must keep its own
  // classification — conflating them would report a context overflow as a
  // truncated answer and tell the client to simply continue.
  it("does not match the input-length/context refusal", () => {
    expect(isOutputTokenCapExceeded(
      "input length and max_tokens exceed context limit: 200000 + 8192 > 200000",
    )).toBe(false)
  })

  it("does not match other terminal reasons", () => {
    for (const m of [
      "Reached maximum number of turns (1)",
      "Claude Code process exited with code 1",
      "You've reached your Fable limit. Switch to another model to continue.",
      "output token maximum",              // the phrase without the count
      "response exceeded the limit",       // similar prose, no token count
    ]) {
      expect(isOutputTokenCapExceeded(m)).toBe(false)
    }
  })

  it("is safe on absent or non-string input", () => {
    expect(isOutputTokenCapExceeded(undefined)).toBe(false)
    expect(isOutputTokenCapExceeded(null)).toBe(false)
    expect(isOutputTokenCapExceeded("")).toBe(false)
  })
})

/**
 * The cap that reaches the subprocess. Mirrors the parse in server.ts: only a
 * positive finite value is honoured, so a malformed request keeps the previous
 * behaviour rather than clamping generation to zero.
 */
function resolveCap(maxTokens: unknown): number | undefined {
  const raw = Number(maxTokens)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined
}

describe("client max_tokens -> subprocess cap", () => {
  it("passes through a positive integer", () => {
    expect(resolveCap(16)).toBe(16)
    expect(resolveCap(4096)).toBe(4096)
  })

  it("floors a fractional value rather than sending a non-integer", () => {
    expect(resolveCap(100.7)).toBe(100)
  })

  it("accepts a numeric string, as a lenient HTTP client may send", () => {
    expect(resolveCap("512")).toBe(512)
  })

  // Every one of these must leave the cap UNSET. Sending 0 or a negative value
  // would clamp generation to nothing on requests that are merely malformed.
  it("leaves the cap unset for anything not a positive number", () => {
    for (const bad of [0, -1, undefined, null, "", "abc", NaN, Infinity, -Infinity, {}, []]) {
      expect(resolveCap(bad)).toBeUndefined()
    }
  })
})
