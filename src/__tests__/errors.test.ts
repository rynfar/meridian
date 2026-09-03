/**
 * Unit tests for classifyError — pure function, no mocks needed.
 */
import { describe, it, expect } from "bun:test"
import { canRecoverCapturedToolUses, classifyError, extendedContextHint, classifyResumeRefusal, isBusySessionError, isExtraUsageRequiredError, extractSdkTermination, formatSdkTermination, isAccountFailoverError, isQuotaRefusal, isRateLimitError } from "../proxy/errors"

describe("classifyError", () => {
  describe("authentication errors", () => {
    it("detects 401 status codes", () => {
      const result = classifyError("API Error: 401 authentication_error")
      expect(result.status).toBe(401)
      expect(result.type).toBe("authentication_error")
    })

    it("detects 'authentication' keyword", () => {
      const result = classifyError("authentication failed")
      expect(result.status).toBe(401)
    })

    it("detects 'invalid auth' keyword", () => {
      const result = classifyError("invalid auth token")
      expect(result.status).toBe(401)
    })

    it("detects 'credentials' keyword", () => {
      const result = classifyError("bad credentials provided")
      expect(result.status).toBe(401)
    })

    it("detects process exit code 1 as auth error", () => {
      const result = classifyError("Claude Code process exited with code 1")
      expect(result.status).toBe(401)
      expect(result.type).toBe("authentication_error")
    })

    it("does NOT classify exit code 1 as auth when 'tool' is mentioned", () => {
      const result = classifyError("Claude Code process exited with code 1 - tool error")
      expect(result.status).toBe(502)
      expect(result.type).toBe("api_error")
    })

    it("does NOT classify exit code 1 as auth when 'mcp' is mentioned", () => {
      const result = classifyError("Claude Code process exited with code 1 - mcp server crashed")
      expect(result.status).toBe(502)
      expect(result.type).toBe("api_error")
    })

    it("includes captured stderr in exit code 1 message", () => {
      const result = classifyError("Claude Code process exited with code 1\nSubprocess stderr: --permission-mode: invalid value 'bypassPermissions'")
      expect(result.status).toBe(401)
      expect(result.type).toBe("authentication_error")
      expect(result.message).toContain("permission-mode")
    })

    it("classifies as auth error when stderr contains authentication keyword", () => {
      const result = classifyError("Claude Code process exited with code 1\nSubprocess stderr: OAuth token expired")
      expect(result.status).toBe(401)
      expect(result.type).toBe("authentication_error")
    })
  })

  describe("extended-context remediation hint (#716)", () => {
    // A 1M-context rate limit used to advise MERIDIAN_SONNET_MODEL=sonnet
    // unconditionally. That is a no-op for Sonnet (already 200k by default) and
    // names the wrong variable for the two tiers that actually default to 1M.
    const RATE_LIMITED_1M = "429 rate limit reached for 1m context"

    it("names the Fable variable for a fable[1m] request", () => {
      const r = classifyError(RATE_LIMITED_1M, "fable[1m]")
      expect(r.message).toContain("MERIDIAN_FABLE_MODEL=fable")
      expect(r.message).not.toContain("SONNET")
    })

    it("names the Opus variable for an opus[1m] request", () => {
      const r = classifyError(RATE_LIMITED_1M, "opus[1m]")
      expect(r.message).toContain("MERIDIAN_OPUS_MODEL=opus")
      expect(r.message).not.toContain("SONNET")
    })

    it("names the Sonnet variable only when the user opted in to sonnet[1m]", () => {
      const r = classifyError(RATE_LIMITED_1M, "sonnet[1m]")
      expect(r.message).toContain("MERIDIAN_SONNET_MODEL=sonnet")
    })

    it("stays silent for a 200k request, where the old advice was a no-op", () => {
      // This is the reported bug: Sonnet is 200k by default, so telling the
      // user to set MERIDIAN_SONNET_MODEL=sonnet changes nothing. They set it,
      // see no difference, and conclude the proxy is broken.
      const r = classifyError(RATE_LIMITED_1M, "sonnet")
      expect(r.type).toBe("rate_limit_error")
      expect(r.message).not.toContain("MERIDIAN")
    })

    it("treats mythos as the fable tier", () => {
      expect(extendedContextHint("mythos[1m]")).toContain("MERIDIAN_FABLE_MODEL=fable")
    })

    it("falls back to the global switch when no model resolved", () => {
      // The outer error handler can fire before `model` is assigned. The global
      // switch is correct for every tier, so it is the safe thing to advise.
      const r = classifyError(RATE_LIMITED_1M)
      expect(r.message).toContain("MERIDIAN_1M_CONTEXT_SUPPORT=0")
    })

    it("falls back to the global switch for an unrecognized 1M tier", () => {
      expect(extendedContextHint("someothermodel[1m]")).toContain("MERIDIAN_1M_CONTEXT_SUPPORT=0")
    })

    it("adds no hint when the error is unrelated to context", () => {
      const r = classifyError("429 too many requests", "opus[1m]")
      expect(r.type).toBe("rate_limit_error")
      expect(r.message).not.toContain("MERIDIAN")
    })

    it("still classifies as a rate limit regardless of the hint", () => {
      for (const m of [undefined, "sonnet", "opus[1m]", "fable[1m]"]) {
        const r = classifyError(RATE_LIMITED_1M, m)
        expect(r.status).toBe(429)
        expect(r.type).toBe("rate_limit_error")
      }
    })
  })

  describe("rate limiting", () => {
    it("detects 429 status codes", () => {
      const result = classifyError("429 Too Many Requests")
      expect(result.status).toBe(429)
      expect(result.type).toBe("rate_limit_error")
    })

    it("detects 'rate limit' keyword", () => {
      const result = classifyError("rate limit exceeded")
      expect(result.status).toBe(429)
    })

    it("detects 'too many requests' keyword", () => {
      const result = classifyError("too many requests")
      expect(result.status).toBe(429)
    })
  })

  describe("billing errors", () => {
    it("detects 402 status codes", () => {
      const result = classifyError("402 billing_error")
      expect(result.status).toBe(402)
      expect(result.type).toBe("billing_error")
    })

    it("detects 'subscription' keyword", () => {
      const result = classifyError("subscription expired")
      expect(result.status).toBe(402)
    })

    it("detects a lapsed subscription with a payment-method prompt", () => {
      const r = classifyError("Claude Code returned an error result: Your Claude Max subscription is inactive — update your payment method to continue.")
      expect(r.status).toBe(402)
      expect(r.type).toBe("billing_error")
    })

    it("detects an exhausted extra-usage refusal", () => {
      const r = classifyError("API Error: 400 You're out of extra usage. Add more at claude.ai/settings/usage")
      expect(r.type).toBe("billing_error")
    })

    // These used to classify as billing because the branch matched bare
    // substrings anywhere in the text, and it runs before the crash/max-turns
    // branches so it won. Harmless as a wrong status code; not harmless once
    // isAccountFailoverError keys on the type (#796), where an incidental
    // filename could mark every profile in the pool exhausted.
    it.each([
      ["a filename", "Claude Code returned an error result: Reached maximum number of turns (3) while editing subscription.ts"],
      ["a path", "Error: ENOENT: no such file or directory, open '/repo/src/billing/index.ts'"],
      ["a URL", "fetch failed: https://api.example.com/payment/status returned 500"],
      ["a stack frame line number", "TypeError: undefined is not a function\n    at handler.js:402:15"],
    ])("does not read %s as a billing error", (_label, msg) => {
      const r = classifyError(msg)
      expect(r.type).not.toBe("billing_error")
      expect(isAccountFailoverError(r.type)).toBe(false)
    })
  })

  // #770: guardUpstreamIdle is meridian's own termination, not the SDK's. Its
  // message matched none of the needles, so it landed on "unknown" — which
  // excludes it from canRecoverAsToolUse and discards tool calls the hook had
  // already captured.
  describe("upstream idle termination", () => {
    it("recognises the idle guard's own error and reads the idle window", () => {
      const t = extractSdkTermination("upstream idle for 90001ms (limit 90000ms)")
      expect(t.reason).toBe("upstream_idle")
      expect(t.idleMs).toBe(90001)
    })

    it("recognises it when wrapped by the SDK error text", () => {
      const t = extractSdkTermination("Error: upstream idle for 90001ms (limit 90000ms)\n    at guard.ts:1")
      expect(t.reason).toBe("upstream_idle")
    })

    it("leaves the client-facing classification untouched", () => {
      // The 504 upstream_timeout the client sees comes from an
      // `instanceof UpstreamIdleError` branch in server.ts, NOT from
      // classifyError — which still reads this as a generic api_error. #770 is
      // about the termination reason only, so this pins that the wire status
      // did not move with it.
      const r = classifyError("upstream idle for 90001ms (limit 90000ms)")
      expect(r.status).toBe(500)
      expect(r.type).toBe("api_error")
    })

    it("does not swallow a max_turns error that mentions idling", () => {
      const t = extractSdkTermination("Reached maximum number of turns (3) while waiting for an idle upstream")
      expect(t.reason).toBe("max_turns")
    })
  })

  describe("canRecoverCapturedToolUses", () => {
    const base = { passthrough: true, capturedToolUses: 2, abortIsOurs: true } as const

    it("recovers a turn-cap termination", () => {
      expect(canRecoverCapturedToolUses({ ...base, reason: "max_turns" })).toBe(true)
    })

    // #770: the stall killed the stream, not the work already captured.
    it("recovers an idle-guard termination", () => {
      expect(canRecoverCapturedToolUses({ ...base, reason: "upstream_idle" })).toBe(true)
    })

    it("recovers our own abort but not a client disconnect", () => {
      expect(canRecoverCapturedToolUses({ ...base, reason: "aborted", abortIsOurs: true })).toBe(true)
      expect(canRecoverCapturedToolUses({ ...base, reason: "aborted", abortIsOurs: false })).toBe(false)
    })

    it("does not recover an unrecognised termination", () => {
      expect(canRecoverCapturedToolUses({ ...base, reason: "unknown" })).toBe(false)
    })

    it("does not recover a process crash", () => {
      expect(canRecoverCapturedToolUses({ ...base, reason: "process_exit" })).toBe(false)
    })

    // An overflow is rejected before generation, so there is nothing captured
    // to deliver — and replaying the same oversized prompt cannot succeed.
    it("does not recover a context overflow", () => {
      expect(canRecoverCapturedToolUses({ ...base, reason: "context_overflow" })).toBe(false)
    })

    // Without captured calls there is nothing to deliver, and outside
    // passthrough the client does not execute tools at all.
    it("requires captured tool calls", () => {
      expect(canRecoverCapturedToolUses({ ...base, reason: "max_turns", capturedToolUses: 0 })).toBe(false)
    })

    it("requires passthrough", () => {
      expect(canRecoverCapturedToolUses({ ...base, reason: "max_turns", passthrough: false })).toBe(false)
    })
  })

  describe("context overflow", () => {
    it("classifies the CLI's bare wording", () => {
      const r = classifyError("Claude Code returned an error result: Prompt is too long")
      expect(r.status).toBe(400)
      expect(r.type).toBe("invalid_request_error")
    })

    it("classifies the API's token-count wording", () => {
      const r = classifyError('API Error: 400 {"type":"invalid_request_error","message":"prompt is too long: 215843 tokens > 200000 maximum"}')
      expect(r.status).toBe(400)
    })

    it("classifies the max_tokens phrasing", () => {
      const r = classifyError("input length and `max_tokens` exceed context limit: 197000 + 8192 > 200000")
      expect(r.status).toBe(400)
    })

    it("classifies the OpenAI-compatible code", () => {
      const r = classifyError("context_length_exceeded")
      expect(r.status).toBe(400)
    })

    // The whole reason this branch sits above the crash branch. Without it the
    // code-1 path returns 401 and tells the operator to run `claude login` —
    // advice that cannot work here, for a cause it has hidden.
    it("wins over a process exit carrying the overflow in stderr", () => {
      const r = classifyError("Claude Code process exited with code 1\nSubprocess stderr: Prompt is too long")
      expect(r.status).toBe(400)
      expect(r.type).toBe("invalid_request_error")
      expect(r.message).not.toContain("claude login")
    })

    // A 5xx reads as "transient, try again" to every client retry policy, which
    // is what replays an unfixable request at full upstream cost.
    it.each([
      ["the CLI wording", "Prompt is too long"],
      ["the OpenAI code", "context_length_exceeded"],
    ])("never classifies %s as retryable", (_label, msg) => {
      expect(classifyError(msg).status).toBeLessThan(500)
    })

    // Mirrors #796: the phrase is word-separated, so an identifier carrying the
    // same words cannot steal the branch from the real cause.
    it("ignores an incidental identifier", () => {
      const r = classifyError("Error: ENOENT: no such file or directory, open '/repo/src/prompt-is-too-long.ts'")
      expect(r.status).not.toBe(400)
    })

    // A false 400 is the expensive direction: it tells the client the request is
    // unfixable, so the retry is abandoned and legitimate work is silently
    // dropped. Every case below classified as 400 before the pattern was
    // anchored. Asserting the concrete status, not `not.toBe(400)` — the weaker
    // form is what let an equivalent regression hide in #908.
    it.each([
      ["a negated sentence", "The prompt is too long check did not trigger; this is a network failure"],
      ["the phrase quoted in prose", 'The assistant replied: "prompt is too long" is a common error message users see'],
      ["the phrase quoted inside stderr", 'Subprocess stderr: user asked "why does it say prompt is too long?"'],
      ["a tool_result echoing a grep hit", "tool_result: grep found 'context_length_exceeded' in errors.ts:114"],
    ])("does not classify %s as an overflow", (_label, msg) => {
      const r = classifyError(msg)
      expect(r.status).toBe(500)
      expect(r.type).toBe("api_error")
    })

    // The API envelope is the one non-line-anchored shape that must still match,
    // so the phrase is accepted when it opens a `message` value. That is narrow
    // on purpose: the same words inside any other field, or partway through the
    // message, are prose rather than the error itself.
    //
    // Known boundary: a tool_result echoing a genuine overflow envelope verbatim
    // still classifies as 400. Distinguishing it would mean parsing the message
    // to see whose error it is, and an echoed envelope is a real overflow report
    // either way — so it is left as the accepted edge rather than widened around.
    it.each([
      ["opens the message value", '{"message":"prompt is too long: 215843 tokens > 200000 maximum"}', 400],
      ["sits in another field", '{"note":"prompt is too long is a common error users hit"}', 500],
      ["sits partway through the message", '{"message":"the user asked why prompt is too long appears"}', 500],
    ])("%s", (_label, msg, status) => {
      expect(classifyError(msg).status).toBe(status)
    })

    // The overflow branch runs before the process-crash branch but after the
    // HTTP-status branches, so a real refusal that merely mentions the phrase
    // keeps its own classification rather than being downgraded to a 400.
    it.each([
      ["a rate limit", "429 rate limit exceeded — note: context length exceeded is a different error", 429],
      ["an auth failure", "401 unauthorized. Docs mention context_length_exceeded elsewhere.", 401],
    ])("lets %s keep its status", (_label, msg, status) => {
      expect(classifyError(msg).status).toBe(status)
    })
  })

  describe("process crashes", () => {
    it("detects exit code with specific number", () => {
      const result = classifyError("exited with code 137")
      expect(result.status).toBe(502)
      expect(result.type).toBe("api_error")
      expect(result.message).toContain("137")
    })

    it("detects 'process exited' keyword", () => {
      const result = classifyError("process exited unexpectedly")
      expect(result.status).toBe(502)
    })

    it("uses 'unknown' when exit code not parseable", () => {
      const result = classifyError("process exited somehow")
      expect(result.message).toContain("unknown")
    })
  })

  describe("timeout errors", () => {
    it("detects 'timeout' keyword", () => {
      const result = classifyError("Request timeout after 120s")
      expect(result.status).toBe(504)
      expect(result.type).toBe("timeout_error")
    })

    it("detects 'timed out' keyword", () => {
      const result = classifyError("connection timed out")
      expect(result.status).toBe(504)
    })
  })

  describe("server errors", () => {
    it("detects 500 status codes", () => {
      const result = classifyError("HTTP 500 from API")
      expect(result.status).toBe(502)
      expect(result.type).toBe("api_error")
    })

    it("detects 'server error' keyword", () => {
      const result = classifyError("internal server error")
      expect(result.status).toBe(502)
    })
  })

  describe("overloaded", () => {
    it("detects 503 status codes", () => {
      const result = classifyError("503 overloaded")
      expect(result.status).toBe(503)
      expect(result.type).toBe("overloaded_error")
    })

    it("detects 'overloaded' keyword", () => {
      const result = classifyError("service overloaded")
      expect(result.status).toBe(503)
    })

    it("does not treat status-code digits embedded in UUIDs as HTTP signals", () => {
      for (const code of ["401", "429", "500", "503"]) {
        const message = `Managed SDK fork returned 00000000-0000-4${code}-8000-000000000000`
        const result = classifyError(message)
        expect(result.status).toBe(500)
        expect(result.message).toBe(message)
      }
    })
  })

  describe("busy session (bg agent) detection — #630", () => {
    const busyLine =
      "Error: Session 3cff857d-114e-4be3-8a12-99842ad2326e is currently running as a background agent (bg). Use `claude agents` to find and attach to it, or add --fork-session to branch off a copy."

    it("detects the refusal in the error message", () => {
      expect(isBusySessionError(new Error(busyLine))).toBe(true)
    })

    it("detects the refusal on captured stderr when the error only carries the exit code", () => {
      expect(isBusySessionError(new Error("Claude Code process exited with code 1"), busyLine)).toBe(true)
    })

    it("ignores unrelated exit-1 failures", () => {
      expect(isBusySessionError(new Error("Claude Code process exited with code 1"))).toBe(false)
      expect(isBusySessionError(new Error("Claude Code process exited with code 1"), "Warning: Custom betas are only available for API key users.")).toBe(false)
    })

    it("ignores non-Error values without the needle", () => {
      expect(isBusySessionError("some string", undefined)).toBe(false)
    })
  })

  describe("resume refusal classification", () => {
    const busyRefusal =
      "Error: Session 3cff857d-114e-4be3-8a12-99842ad2326e is currently running as a background agent (bg). Use `claude agents` to find and attach to it, or add --fork-session to branch off a copy."

    it("a lost message names itself, so an identical attempt is pointless", () => {
      expect(classifyResumeRefusal(new Error("No message found with message.uuid of: e663b687-6d08-4cc4-b9a9-5245ce8f1e07"))).toBe("missing-message")
    })

    it("reads the refusal out of a longer message", () => {
      expect(classifyResumeRefusal(new Error("claude code returned an error result: No message found with message.uuid of: abc123"))).toBe("missing-message")
    })

    it("a session that would not open is unresumable, not proven gone", () => {
      expect(classifyResumeRefusal(new Error("No conversation found with session ID: 2e9e868c-ab59-482c-ae28-3b60ec9cb95b"))).toBe("unresumable")
      expect(classifyResumeRefusal(new Error("No conversation found to continue"))).toBe("unresumable")
      expect(classifyResumeRefusal(new Error("No conversations found to resume"))).toBe("unresumable")
      expect(classifyResumeRefusal(new Error("No conversations found to resume."))).toBe("unresumable")
    })

    it("a session held by a running agent is busy, so it can be branched", () => {
      expect(classifyResumeRefusal(new Error(busyRefusal))).toBe("busy")
    })

    it("finds the busy refusal on stderr when the error only carries the exit code", () => {
      expect(classifyResumeRefusal(new Error("Claude Code process exited with code 1"), busyRefusal)).toBe("busy")
    })

    it("leaves failures that are not about the resume unclassified", () => {
      expect(classifyResumeRefusal(new Error("rate limit exceeded"))).toBeUndefined()
      expect(classifyResumeRefusal(new Error("authentication failed"))).toBeUndefined()
      expect(classifyResumeRefusal(new Error("Claude Code process exited with code 1"))).toBeUndefined()
    })

    it("reads no wording off the value of a non-Error failure", () => {
      expect(classifyResumeRefusal("No message found with message.uuid")).toBeUndefined()
      expect(classifyResumeRefusal(null)).toBeUndefined()
      expect(classifyResumeRefusal(undefined)).toBeUndefined()
    })

    it("still finds the busy refusal on stderr, whatever the failure value is", () => {
      // The busy wording travels on stderr precisely because the failure often
      // carries nothing but an exit code, so this one is not value-bound.
      expect(classifyResumeRefusal("exit 1", busyRefusal)).toBe("busy")
      expect(classifyResumeRefusal(null, busyRefusal)).toBe("busy")
    })
  })

  describe("extra usage required", () => {
    it("detects the exact error from Claude SDK", () => {
      expect(isExtraUsageRequiredError(
        "Claude Code returned an error result: API Error: Extra usage is required for 1M context · enable extra usage at claude.ai/settings/usage, or use --model to switch"
      )).toBe(true)
    })

    it("detects lowercase variant", () => {
      expect(isExtraUsageRequiredError("extra usage is required for 1m context")).toBe(true)
    })

    it("detects 'out of extra usage' variant", () => {
      expect(isExtraUsageRequiredError(
        "Claude Code returned an error result: API Error: 400 You're out of extra usage."
      )).toBe(true)
    })

    it("returns false for unrelated errors", () => {
      expect(isExtraUsageRequiredError("rate limit exceeded")).toBe(false)
      expect(isExtraUsageRequiredError("authentication failed")).toBe(false)
    })

    it("returns false when only 'extra usage' but no '1m'", () => {
      expect(isExtraUsageRequiredError("extra usage enabled")).toBe(false)
    })

    it("returns false when only '1m' but no 'extra usage'", () => {
      expect(isExtraUsageRequiredError("using 1m context window")).toBe(false)
    })
  })

  describe("default/unknown", () => {
    it("returns 500 for unknown errors", () => {
      const result = classifyError("Something weird happened")
      expect(result.status).toBe(500)
      expect(result.type).toBe("api_error")
      expect(result.message).toBe("Something weird happened")
    })

    it("returns 'Unknown error' for empty string", () => {
      const result = classifyError("")
      expect(result.status).toBe(500)
      expect(result.message).toBe("Unknown error")
    })
  })
})

describe("extractSdkTermination", () => {
  describe("max_turns", () => {
    it("detects bare max_turns message", () => {
      const t = extractSdkTermination("Reached maximum number of turns (3)")
      expect(t.reason).toBe("max_turns")
      expect(t.turns).toBe(3)
    })

    it("detects max_turns inside SDK wrapper", () => {
      const t = extractSdkTermination("Claude Code returned an error result: Reached maximum number of turns (3)")
      expect(t.reason).toBe("max_turns")
      expect(t.turns).toBe(3)
    })

    it("captures any turn count, not just 3", () => {
      const t = extractSdkTermination("Reached maximum number of turns (12)")
      expect(t.reason).toBe("max_turns")
      expect(t.turns).toBe(12)
    })

    it("returns max_turns reason even when turn count is malformed", () => {
      const t = extractSdkTermination("Reached maximum number of turns")
      expect(t.reason).toBe("max_turns")
      expect(t.turns).toBeUndefined()
    })

    it("captures subprocess stderr tail when present", () => {
      const msg =
        "Claude Code returned an error result: Reached maximum number of turns (3)\n" +
        "Subprocess stderr: Warning: Custom betas are only available for API key users. Ignoring provided betas."
      const t = extractSdkTermination(msg)
      expect(t.reason).toBe("max_turns")
      expect(t.turns).toBe(3)
      expect(t.stderrTail).toContain("Custom betas")
    })
  })

  describe("context_overflow", () => {
    it("names an oversized prompt", () => {
      const t = extractSdkTermination("Claude Code returned an error result: Prompt is too long")
      expect(t.reason).toBe("context_overflow")
    })

    // Ordering guard: the overflow arrives as a process exit often enough that
    // reading the exit first points the diagnostic log at the wrong thing.
    it("wins over a process exit carrying the overflow in stderr", () => {
      const t = extractSdkTermination("process exited with code 1\nSubprocess stderr: Prompt is too long")
      expect(t.reason).toBe("context_overflow")
      expect(t.stderrTail).toContain("Prompt is too long")
    })

    it("survives the round trip into a diagnostic log line", () => {
      const t = extractSdkTermination("Prompt is too long")
      expect(formatSdkTermination(t, { model: "sonnet" })).toContain("reason=context_overflow")
    })
  })

  describe("process_exit", () => {
    it("detects exit code", () => {
      const t = extractSdkTermination("Claude Code process exited with code 137")
      expect(t.reason).toBe("process_exit")
      expect(t.exitCode).toBe(137)
    })

    it("captures stderr tail with exit code", () => {
      const t = extractSdkTermination(
        "process exited with code 1\nSubprocess stderr: --permission-mode invalid value"
      )
      expect(t.reason).toBe("process_exit")
      expect(t.exitCode).toBe(1)
      expect(t.stderrTail).toContain("permission-mode")
    })

    it("returns exit reason without code when code missing", () => {
      const t = extractSdkTermination("process exited unexpectedly")
      expect(t.reason).toBe("process_exit")
      expect(t.exitCode).toBeUndefined()
    })
  })

  describe("aborted", () => {
    it("detects AbortError", () => {
      const t = extractSdkTermination("AbortError: The operation was aborted")
      expect(t.reason).toBe("aborted")
    })

    it("detects 'Aborted' message", () => {
      const t = extractSdkTermination("Aborted")
      expect(t.reason).toBe("aborted")
    })
  })

  describe("unknown", () => {
    it("returns 'unknown' for unrecognized messages", () => {
      const t = extractSdkTermination("Something weird happened")
      expect(t.reason).toBe("unknown")
      expect(t.turns).toBeUndefined()
      expect(t.exitCode).toBeUndefined()
    })

    it("handles empty string safely", () => {
      const t = extractSdkTermination("")
      expect(t.reason).toBe("unknown")
      expect(t.rawTail).toBeUndefined()
    })

    it("captures raw error head when reason=unknown so the cause is debuggable", () => {
      const t = extractSdkTermination("Some weird upstream failure: wibble")
      expect(t.reason).toBe("unknown")
      expect(t.rawTail).toBe("Some weird upstream failure: wibble")
    })

    it("strips the stderr appendix from rawTail (already in stderrTail)", () => {
      const msg =
        "Some weird upstream failure: wibble\n" +
        "Subprocess stderr: Warning: Custom betas..."
      const t = extractSdkTermination(msg)
      expect(t.reason).toBe("unknown")
      expect(t.rawTail).toBe("Some weird upstream failure: wibble")
      expect(t.stderrTail).toContain("Custom betas")
    })

    it("truncates very long rawTail to a sensible bound", () => {
      const longLine = "x".repeat(5000)
      const t = extractSdkTermination(longLine)
      expect(t.reason).toBe("unknown")
      expect((t.rawTail ?? "").length).toBeLessThanOrEqual(300)
    })

    it("does NOT set rawTail when reason is recognized", () => {
      const t = extractSdkTermination("Reached maximum number of turns (3)")
      expect(t.reason).toBe("max_turns")
      expect(t.rawTail).toBeUndefined()
    })
  })

  describe("stderr tail truncation", () => {
    it("truncates very long stderr to a sensible bound", () => {
      const longLine = "x".repeat(10_000)
      const t = extractSdkTermination(`Reached maximum number of turns (3)\nSubprocess stderr: ${longLine}`)
      expect(t.reason).toBe("max_turns")
      expect(t.stderrTail).toBeDefined()
      expect((t.stderrTail ?? "").length).toBeLessThanOrEqual(500)
    })
  })
})

describe("formatSdkTermination", () => {
  it("formats max_turns with full context", () => {
    const line = formatSdkTermination(
      { reason: "max_turns", turns: 3, stderrTail: "Warning: Custom betas..." },
      { model: "opus[1m]", requestSource: "main", isResume: true, hasDeferredTools: false, sdkSessionId: "5fa9ec00-633c-4f00-b1c2-9e1b3c175ca4" },
    )
    expect(line).toContain("sdk_termination")
    expect(line).toContain("reason=max_turns")
    expect(line).toContain("turns=3")
    expect(line).toContain("model=opus[1m]")
    expect(line).toContain("source=main")
    expect(line).toContain("resume=true")
    expect(line).toContain("deferred=false")
    expect(line).toContain("session=5fa9ec00")
    expect(line).toContain("Custom betas")
  })

  it("formats process_exit with exit code and no stderr", () => {
    const line = formatSdkTermination(
      { reason: "process_exit", exitCode: 137 },
      { model: "haiku", isResume: false, hasDeferredTools: false },
    )
    expect(line).toContain("reason=process_exit")
    expect(line).toContain("exit=137")
    expect(line).not.toContain("stderr=")
  })

  it("omits unset context fields", () => {
    const line = formatSdkTermination({ reason: "unknown" }, {})
    expect(line).toBe("sdk_termination reason=unknown")
  })

  it("includes raw=… when reason=unknown carries a rawTail", () => {
    const line = formatSdkTermination(
      { reason: "unknown", rawTail: "Some weird upstream failure" },
      { requestSource: "main" },
    )
    expect(line).toContain("reason=unknown")
    expect(line).toContain("source=main")
    expect(line).toContain('raw="Some weird upstream failure"')
  })
})

describe("classifyError: session/usage limit phrasings (live-observed)", () => {
  it("maps the CLI's 'You've hit your session limit' to rate_limit_error", () => {
    const r = classifyError("Claude Code returned an error result: You've hit your session limit \u00b7 resets 2pm (America/Denver)")
    expect(r.type).toBe("rate_limit_error")
    expect(r.status).toBe(429)
  })

  it("maps the CLI's shorter 'You've hit your limit' wording to rate_limit_error", () => {
    const r = classifyError("Claude Code returned an error result: You've hit your limit \u00b7 resets 6:40pm (UTC)")
    expect(r.type).toBe("rate_limit_error")
    expect(r.status).toBe(429)
  })

  it("maps the CLI's 'You've hit your weekly limit' to rate_limit_error", () => {
    const r = classifyError("Claude Code returned an error result: You've hit your weekly limit \u00b7 resets 2pm (Asia/Jerusalem)")
    expect(r.type).toBe("rate_limit_error")
    expect(r.status).toBe(429)
  })

  it("maps the CLI's 'You've hit your org's monthly spend limit' to rate_limit_error", () => {
    const r = classifyError("Claude Code returned an error result: You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage")
    expect(r.type).toBe("rate_limit_error")
    expect(r.status).toBe(429)
  })

  it("maps the CLI's 'You've hit your monthly spend limit' to rate_limit_error", () => {
    const r = classifyError("You've hit your monthly spend limit · raise it at claude.ai/settings/usage · your session limit resets 5pm (Europe/Warsaw)")
    expect(r.type).toBe("rate_limit_error")
    expect(r.status).toBe(429)
  })

  // The spend-limit pattern allows four qualifier words, which is a much wider
  // net than the single-word HIT_YOUR_LIMIT. Unanchored it matched all three of
  // these. Each would mark a healthy account exhausted and drop it out of a
  // priority pool — the same outage this fix prevents, from the other side.
  it("does not treat a negated spend-limit sentence as a rate limit", () => {
    const r = classifyError("You have not hit your monthly spend limit yet, so this is unrelated.")
    expect(r.type).not.toBe("rate_limit_error")
    expect(isAccountFailoverError(r.type)).toBe(false)
  })

  it("does not treat a quoted spend-limit phrase as a rate limit", () => {
    const r = classifyError("The docs say: when you've hit your monthly spend limit, ask your admin to raise it.")
    expect(r.type).not.toBe("rate_limit_error")
    expect(isAccountFailoverError(r.type)).toBe(false)
  })

  it("does not treat a spend-limit phrase quoted inside tool stderr as a rate limit", () => {
    const r = classifyError("Subprocess stderr: helper printed \"You've hit your org's monthly spend limit\" and exited")
    expect(r.type).not.toBe("rate_limit_error")
    expect(isAccountFailoverError(r.type)).toBe(false)
  })

  // The CLI surfaces a limit banner by exiting and appending it to stderr. A
  // whole-message anchor missed that shape, and the fall-through was a 401
  // telling the operator to run `claude login` for a quota refusal — while the
  // session-limit banner in the identical shape classified correctly.
  it("maps a spend-limit banner appended to subprocess stderr to rate_limit_error", () => {
    const r = classifyError("Claude Code process exited with code 1\nSubprocess stderr: You've hit your org's monthly spend limit \u00b7 ask your admin to raise it")
    expect(r.type).toBe("rate_limit_error")
    expect(r.status).toBe(429)
    expect(r.message).not.toContain("claude login")
  })

  it("classifies the stderr-appended spend and session banners the same way", () => {
    const spend = classifyError("Claude Code process exited with code 1\nSubprocess stderr: You've hit your monthly spend limit")
    const session = classifyError("Claude Code process exited with code 1\nSubprocess stderr: You've hit your session limit")
    expect(spend.type).toBe(session.type)
    expect(spend.status).toBe(session.status)
  })

  // Typographic apostrophes: the CLI renders these in some terminals.
  it("maps the curly-apostrophe spend-limit wording to rate_limit_error", () => {
    const r = classifyError("You\u2019ve hit your org\u2019s monthly spend limit \u00b7 ask your admin to raise it")
    expect(r.type).toBe("rate_limit_error")
    expect(r.status).toBe(429)
  })

  it("maps the CLI's 'You're out of usage credits' to rate_limit_error without a same-profile retry", () => {
    const msg = "Claude Code returned an error result: You're out of usage credits. /model to switch models."
    const r = classifyError(msg)
    expect(r.type).toBe("rate_limit_error")
    expect(r.status).toBe(429)
    expect(isRateLimitError(msg)).toBe(false)
  })

  it.each([
    ["bare banner", "You're out of usage credits"],
    ["nested SDK wrappers", "Error: API Error: You’re out of usage credits! /model to switch models."],
  ])("maps the canonical usage-credit %s to rate_limit_error", (_label, msg) => {
    const r = classifyError(msg)
    expect(r.type).toBe("rate_limit_error")
    expect(r.status).toBe(429)
  })

  it.each([
    ["incidental prose", "The MCP docs say users may be out of usage credits"],
    ["quoted banner", "Claude Code returned an error result: The docs say ‘You're out of usage credits.’"],
    ["negated banner", "Claude Code returned an error result: You're not out of usage credits."],
    ["filename prefix", "Claude Code returned an error result: usage-credits.ts says You're out of usage credits."],
    ["unfinished quotation", "Claude Code returned an error result: You're out of usage credits is a test string"],
    ["punctuated documentation suffix", "Error: You're out of usage credits. This is only a documentation example, account healthy."],
    ["punctuated MCP suffix", "Claude Code returned an error result: You're out of usage credits. (quoted by an MCP error, not account state)"],
  ])("does not classify usage-credit %s as a rate limit", (_label, msg) => {
    expect(classifyError(msg).type).not.toBe("rate_limit_error")
  })

  it("maps the CLI's per-tier limit refusal to rate_limit_error without a same-profile retry", () => {
    const msg = "Claude Code returned an error result: You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."
    const r = classifyError(msg)
    expect(r.type).toBe("rate_limit_error")
    expect(r.status).toBe(429)
    expect(isRateLimitError(msg)).toBe(false)
    expect(isAccountFailoverError(r.type)).toBe(true)
  })

  it("maps the live per-tier refusal with appended beta-warning stderr to rate_limit_error", () => {
    const msg = "Claude Code returned an error result: You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.\nSubprocess stderr: Warning: Custom betas are only available for API key users. Ignoring provided betas."
    const r = classifyError(msg)
    expect(r.type).toBe("rate_limit_error")
    expect(r.status).toBe(429)
  })

  it.each([
    ["bare banner", "You've reached your Fable 5 limit."],
    ["nested SDK wrappers", "Error: API Error: You’ve reached your Fable 5 limit! /model to switch models."],
    ["Opus tier", "You've reached your Opus limit"],
    ["versioned Sonnet tier", "You've reached your Sonnet 4.6 limit"],
    ["Claude-prefixed tier", "You've reached your Claude Opus 4.6 limit"],
    ["space-separated model command", "You've reached your Fable 5 limit /model to switch models."],
    ["multiline subprocess stderr", "Claude Code process exited with code 1\nSubprocess stderr: You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."],
    // server.ts appends captured stderr to Error.message before classification,
    // so the banner is routinely NOT the last thing in the message. These are
    // the shapes that reach classifyError in production; each returned 500
    // api_error (or, with nothing else to go on, a 401 telling the operator to
    // run `claude login`) until the bound became the line rather than the
    // message. See REACHED_YOUR_TIER_LIMIT.
    ["banner then unrelated appended stderr", "You've reached your Fable 5 limit.\nSubprocess stderr: unrelated tool output"],
    // stderrLines.join("\n") labels only the first line, and on Team plans the
    // harmless betas warning is always emitted first — so the real banner
    // arrives on an unlabelled second line.
    ["beta warning first, banner on an unlabelled line", "Claude Code process exited with code 1\nSubprocess stderr: Warning: Custom betas are only available for API key users. Ignoring provided betas.\nYou've reached your Fable 5 limit."],
    ["generic error newline", "Error:\nYou've reached your Fable 5 limit."],
    ["SDK wrapper newline", "Claude Code returned an error result:\nYou've reached your Fable 5 limit."],
    ["trailing newline", "You've reached your Fable 5 limit.\n"],
    ["CRLF line ending", "You've reached your Fable 5 limit.\r\n"],
  ])("maps the credits-era per-tier %s to rate_limit_error", (_label, msg) => {
    const r = classifyError(msg)
    expect(r.type).toBe("rate_limit_error")
    expect(r.status).toBe(429)
  })

  it.each([
    ["specified limit", "You've reached your specified limit"],
    ["quoted banner", "The docs say ‘You've reached your Fable 5 limit.’"],
    ["negated banner", "You've not reached your Fable 5 limit"],
    ["filename prefix", "Claude Code returned an error result: usage-credits.ts says You've reached your Fable 5 limit."],
    ["configured tool qualifier", "You've reached your Fable configured tool limit"],
    ["limitations suffix", "You've reached your Fable 5 limitations"],
    ["unlabelled multiline quote", "MCP server failed:\nYou've reached your Fable 5 limit (quoted from docs)"],
    ["parenthetical documentation suffix", "You've reached your Fable 5 limit (quoted from docs, account healthy)"],
    ["documentation sentence suffix", "Error: You've reached your Fable 5 limit. This is only a documentation example"],
    ["false assertion suffix", "You've reached your Fable 5 limit is false"],
    ["possessive threshold suffix", "You've reached your Fable 5 limit's configured warning threshold"],
    ["joined run command", "You've reached your Fable 5 limitRun /usage-credits"],
    ["joined usage command", "You've reached your Fable 5 limit/usage-credits"],
    ["unspaced punctuated command", "You've reached your Fable 5 limit.Run /usage-credits"],
  ])("does not classify credits-era per-tier %s as a rate limit", (_label, msg) => {
    expect(classifyError(msg).type).toBe("api_error")
  })

  // The second refusal in #909. An entitlement cap, not a spent window, so it
  // is billing_error: it still fails over via ACCOUNT_FAILOVER_ERROR_TYPES,
  // but without isQuotaRefusal sending the cooldown to wait out a five-hour
  // reset that will never arrive.
  it.each([
    ["group", "Your group's usage limit is set to $0 · run /usage-credits to request more"],
    ["organization", "Your organization's usage limit is set to $250 · run /usage-credits to request more"],
    ["typographic apostrophe", "Your group’s usage limit is set to $0"],
    ["behind an SDK wrapper", "Claude Code returned an error result: Your group's usage limit is set to $0 · run /usage-credits to request more"],
    ["on an unlabelled stderr line", "Claude Code process exited with code 1\nSubprocess stderr: Warning: ignoring provided betas.\nYour group's usage limit is set to $0"],
  ])("maps the %s entitlement cap to a failover-eligible billing_error", (_label, msg) => {
    const r = classifyError(msg)
    expect(r.type).toBe("billing_error")
    expect(r.status).toBe(402)
    expect(isAccountFailoverError(r.type)).toBe(true)
    expect(isQuotaRefusal(r.type)).toBe(false)
  })

  it.each([
    ["quoted mid-line", "The docs say your group's usage limit is set to $0"],
    ["no amount", "Your group's usage limit is set to whatever the admin picked"],
  ])("does not treat %s as an entitlement cap", (_label, msg) => {
    expect(classifyError(msg).type).not.toBe("billing_error")
  })

  // #764 and #787 were the same bug twice: a new qualifier, a 500 instead of
  // failover, a PR. These pin the shape so the next variant is already covered.
  it.each([
    ["daily", "You've hit your daily limit · resets midnight (UTC)"],
    ["monthly", "You've hit your monthly limit"],
    ["hyphenated", "You've hit your 5-hour limit · resets 3pm"],
  ])("maps an unseen '%s' limit qualifier to rate_limit_error", (_label, msg) => {
    const r = classifyError(`Claude Code returned an error result: ${msg}`)
    expect(r.type).toBe("rate_limit_error")
    expect(r.status).toBe(429)
  })

  // The qualifier is one word, not a wildcard — an unrelated sentence that
  // merely contains "limit" must not become a 429 that clients back off on.
  it("does not treat unrelated 'limit' prose as a rate limit", () => {
    const r = classifyError("Claude Code returned an error result: you have hit your configured tool call depth limit")
    expect(r.type).not.toBe("rate_limit_error")
  })

  it("maps 'usage limit reached' to rate_limit_error", () => {
    const r = classifyError("usage limit reached | resets at 5pm")
    expect(r.type).toBe("rate_limit_error")
    expect(r.status).toBe(429)
  })
})

describe("isAccountFailoverError", () => {
  it("accepts the types that exhaust one account and leave the pool viable", () => {
    expect(isAccountFailoverError("rate_limit_error")).toBe(true)
    expect(isAccountFailoverError("billing_error")).toBe(true)
  })

  it("rejects failures that say nothing about the account", () => {
    // Failing over on these would spend every account on one upstream hiccup
    // and mark them all exhausted for something none of them did.
    expect(isAccountFailoverError("api_error")).toBe(false)
    expect(isAccountFailoverError("overloaded_error")).toBe(false)
    expect(isAccountFailoverError("timeout_error")).toBe(false)
    expect(isAccountFailoverError("upstream_timeout")).toBe(false)
  })

  it("rejects authentication_error, which the token refresh recovers in place", () => {
    expect(isAccountFailoverError("authentication_error")).toBe(false)
  })

  it("rejects a missing or malformed type rather than guessing", () => {
    expect(isAccountFailoverError(undefined)).toBe(false)
    expect(isAccountFailoverError(null)).toBe(false)
    expect(isAccountFailoverError("")).toBe(false)
  })

  it("agrees with classifyError on a subscription refusal", () => {
    const classified = classifyError("Your Claude Max subscription is inactive - update your payment method")
    expect(classified.type).toBe("billing_error")
    expect(classified.status).toBe(402)
    expect(isAccountFailoverError(classified.type)).toBe(true)
  })
})

describe("isQuotaRefusal", () => {
  it("separates the refusal that names its own reset from the one that does not", () => {
    expect(isQuotaRefusal("rate_limit_error")).toBe(true)
    expect(isQuotaRefusal("billing_error")).toBe(false)
    expect(isQuotaRefusal(undefined)).toBe(false)
  })

  it("is a strict subset of the failover set", () => {
    expect(isAccountFailoverError("rate_limit_error") && isQuotaRefusal("rate_limit_error")).toBe(true)
    expect(isAccountFailoverError("billing_error") && !isQuotaRefusal("billing_error")).toBe(true)
  })
})
