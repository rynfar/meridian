/**
 * Error classification for SDK errors.
 * Maps raw error messages to structured HTTP error responses.
 */

export interface ClassifiedError {
  status: number
  type: string
  message: string
}

/**
 * Remediation advice for a rate limit hit on an extended-context request.
 *
 * `model` is the resolved variant (`opus[1m]`, `fable`, `sonnet`, …). The advice
 * has to name the tier that actually failed: the three per-tier variables have
 * opposite polarity, because Sonnet 1M costs Extra Usage on every plan while
 * Fable and Opus 1M are included on Max/Team (#717). So Sonnet opts *in* to 1M
 * and the other two opt *out* of it.
 *
 * Returns "" rather than guessing when there is nothing useful to say:
 *
 *  - The request did not use extended context. Suggesting a 1M variable is
 *    irrelevant, and for Sonnet — which is 200k by default — the old advice
 *    was a literal no-op: the user set the variable to the value it already
 *    had, saw no change, and reasonably concluded Meridian was broken (#716).
 *  - The tier is unrecognized, where the global switch is the only safe advice.
 */
export function extendedContextHint(model?: string): string {
  const advise = (v: string) =>
    ` If you're frequently hitting this, set ${v} to use the 200k model instead.`

  // No model resolved — the outer catch can fire before `model` is assigned.
  // The global switch is correct for every tier, so it's the safe fallback.
  if (!model) return advise("MERIDIAN_1M_CONTEXT_SUPPORT=0")

  const lower = model.toLowerCase()
  if (!lower.includes("[1m]")) return ""
  if (lower.includes("fable") || lower.includes("mythos")) return advise("MERIDIAN_FABLE_MODEL=fable")
  if (lower.includes("opus")) return advise("MERIDIAN_OPUS_MODEL=opus")
  if (lower.includes("sonnet")) return advise("MERIDIAN_SONNET_MODEL=sonnet")
  return advise("MERIDIAN_1M_CONTEXT_SUPPORT=0")
}

/** "hit your limit", "hit your session limit", "hit your weekly limit", and any
 *  future single-word qualifier the CLI adopts. Anchored on both sides so it
 *  can't drift into unrelated text that happens to contain "limit". */
const HIT_YOUR_LIMIT = /hit your (?:[\w-]+ )?limit/

/**
 * Detect specific SDK errors and return helpful messages to the client.
 *
 * `model` is the resolved variant for this request, used only to target the
 * extended-context remediation hint. Optional because the outer error handler
 * may not have assigned it yet when a request fails early.
 */
export function classifyError(errMsg: string, model?: string): ClassifiedError {
  const lower = errMsg.toLowerCase()

  // Expired OAuth token (more specific than the generic auth check below)
  if (lower.includes("oauth token has expired") || lower.includes("not logged in")) {
    return {
      status: 401,
      type: "authentication_error",
      message: "Claude OAuth token has expired and could not be refreshed automatically. Run 'claude login' in your terminal to re-authenticate."
    }
  }

  // Authentication failures
  if (lower.includes("401") || lower.includes("authentication") || lower.includes("invalid auth") || lower.includes("credentials")) {
    return {
      status: 401,
      type: "authentication_error",
      message: "Claude authentication expired or invalid. Run 'claude login' in your terminal to re-authenticate, then restart the proxy."
    }
  }

  // Rate limiting. All quota exhaustion must classify as rate_limit_error
  // (429), not generic api_error: clients back off correctly and priority
  // routing's failover keys off this class. Misclassifying costs a 500 and a
  // profile that never fails over.
  //
  // The CLI's phrasing is a moving target — "You've hit your session limit ·
  // resets <time>", the shorter "You've hit your limit", and "You've hit your
  // weekly limit" have all been observed live, each arriving as its own bug
  // report after the previous literal stopped matching (#764, #787). Match the
  // shape instead of enumerating: "hit your <anything> limit" covers the
  // variants seen so far and the daily/monthly/5-hour ones that would
  // otherwise be the next report.
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")
    || HIT_YOUR_LIMIT.test(lower) || lower.includes("usage limit reached")) {
    const hint = lower.includes("1m") || lower.includes("context")
      ? extendedContextHint(model)
      : ""
    return {
      status: 429,
      type: "rate_limit_error",
      message: `Claude Max rate limit reached. Wait a moment and try again.${hint}`
    }
  }

  // Billing / subscription
  if (lower.includes("402") || lower.includes("billing") || lower.includes("subscription") || lower.includes("payment")) {
    return {
      status: 402,
      type: "billing_error",
      message: "Claude Max subscription issue. Check your subscription status at https://claude.ai/settings/subscription"
    }
  }

  // SDK process crash
  if (lower.includes("exited with code") || lower.includes("process exited")) {
    const codeMatch = errMsg.match(/exited with code (\d+)/)
    const code = codeMatch ? codeMatch[1] : "unknown"

    // If stderr was captured it will be appended to the message — use it for classification
    const hasStderr = lower.includes("subprocess stderr:")
    const stderrContent = hasStderr ? lower.split("subprocess stderr:")[1]?.trim() ?? "" : ""

    // Explicit auth signal in stderr takes priority
    if (stderrContent.includes("authentication") || stderrContent.includes("401") || stderrContent.includes("oauth")) {
      return {
        status: 401,
        type: "authentication_error",
        message: "Claude authentication expired or invalid. Run 'claude login' in your terminal to re-authenticate, then restart the proxy."
      }
    }

    // Code 1 + no stderr: could be auth, but could also be a bad flag combination
    // or an environment issue. Give a less confident message and include stderr if present.
    if (code === "1" && !lower.includes("tool") && !lower.includes("mcp")) {
      const stderrHint = stderrContent ? ` Subprocess output: ${stderrContent.slice(0, 200)}` : " Run with CLAUDE_PROXY_DEBUG=1 for more detail."
      return {
        status: 401,
        type: "authentication_error",
        message: `Claude Code process exited (code 1). This is often an authentication issue — try 'claude login' and restart the proxy.${stderrHint}`
      }
    }

    return {
      status: 502,
      type: "api_error",
      message: `Claude Code process exited unexpectedly (code ${code}). Check proxy logs for details. If this persists, try 'claude login' to refresh authentication.`
    }
  }

  // Timeout
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      status: 504,
      type: "timeout_error",
      message: "Request timed out. The operation may have been too complex. Try a simpler request."
    }
  }

  // Server errors from Anthropic
  if (lower.includes("500") || lower.includes("server error") || lower.includes("internal error")) {
    return {
      status: 502,
      type: "api_error",
      message: "Claude API returned a server error. This is usually temporary — try again in a moment."
    }
  }

  // Overloaded
  if (lower.includes("503") || lower.includes("overloaded")) {
    return {
      status: 503,
      type: "overloaded_error",
      message: "Claude is temporarily overloaded. Try again in a few seconds."
    }
  }

  // Default
  return {
    status: 500,
    type: "api_error",
    message: errMsg || "Unknown error"
  }
}

/**
 * Detect errors caused by an expired or missing OAuth access token.
 * Triggers an inline token refresh + retry in server.ts.
 *
 * Patterns, in order of specificity:
 *   - "OAuth token has expired" / "Not logged in" — CLI-emitted (subprocess
 *     either got 401 with this wording from Anthropic or detected expiry
 *     locally before sending).
 *   - "invalid_token" / "token_expired" — RFC 6750 resource-server errors that
 *     can appear in the API response body.
 *   - "401" + ("authentication" | "unauthorized" | "invalid") — generic 401
 *     wrapping. Anthropic's API does not always echo the CLI-specific wording,
 *     so without this branch a stale access token returns a generic 401 to the
 *     proxy and refresh-and-retry never fires (caller sees the 401).
 *
 * False positives only cost one OAuth round-trip — the refresh is single-shot
 * per request (gated by `tokenRefreshed` in server.ts) and surfaces the
 * original error if it doesn't help.
 */
export function isExpiredTokenError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase()
  if (lower.includes("oauth token has expired") || lower.includes("not logged in")) return true
  if (lower.includes("invalid_token") || lower.includes("token_expired")) return true
  if (lower.includes("401") && (lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("invalid"))) return true
  return false
}

/**
 * Detect errors caused by stale session/message UUIDs.
 * These happen when the upstream Claude session no longer contains
 * the referenced message or conversation (expired, evicted server-side, etc.).
 */
export function isStaleSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return msg.includes("No message found with message.uuid")
    || msg.includes("No conversation found with session ID")
    || msg.includes("No conversation found to continue")
    || msg.includes("No conversations found to resume")
}

/**
 * Detect the CLI's bg-agent resume refusal (#630). With
 * CLAUDE_CODE_SESSION_KIND=bg (#628 scratchpad suppression) every SDK
 * session is registered as a running background agent; a --resume spawned
 * while the previous subprocess for that session is still exiting is
 * refused with exit 1. The refusal text arrives on stderr — the SDK error
 * itself only carries the exit code — so callers pass captured stderr too.
 */
export function isBusySessionError(error: unknown, stderr?: string): boolean {
  const needle = "is currently running as a background agent"
  const msg = error instanceof Error ? error.message : String(error)
  return msg.includes(needle) || (stderr?.includes(needle) ?? false)
}

/**
 * Quick check whether an error message indicates a rate limit.
 * Used by server.ts to decide whether to retry with a smaller context window.
 */
export function isRateLimitError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase()
  return lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")
}

/**
 * Error types that exhaust the CURRENT account while leaving the rest of the
 * pool viable — priority routing's cue to try the next candidate instead of
 * handing the failure to the client.
 *
 * `rate_limit_error` is a spent quota window; `billing_error` is a lapsed
 * subscription or a declined payment method. Both are properties of the one
 * account that raised them and neither can succeed on a retry there, which is
 * exactly what makes another account worth trying.
 *
 * Deliberately absent: `authentication_error`, which the token refresh already
 * recovers in place, and the account-blind failures (`api_error`,
 * `overloaded_error`, `timeout_error`) — those say nothing about entitlement,
 * and failing over on them would spend the whole pool on one upstream hiccup
 * and leave every account marked exhausted for something none of them did.
 */
const ACCOUNT_FAILOVER_ERROR_TYPES: ReadonlySet<string> = new Set([
  "rate_limit_error",
  "billing_error",
])

/**
 * Whether a classified error type means "this account cannot serve the
 * request, another one might". Used by priority routing to decide failover.
 */
export function isAccountFailoverError(errorType: string | null | undefined): errorType is string {
  return typeof errorType === "string" && ACCOUNT_FAILOVER_ERROR_TYPES.has(errorType)
}

/**
 * Whether the refusal is the quota kind, which names its own reset — the two
 * cooldown tiers read the account's five-hour window, and only this kind has
 * anything to look up there. Lives beside the set so the type name stays
 * owned by one module: a rename that missed a caller in the orchestrator would
 * not break failover loudly, it would silently downgrade every quota cooldown
 * to the conservative default.
 */
export function isQuotaRefusal(errorType: string | null | undefined): boolean {
  return errorType === "rate_limit_error"
}

/**
 * Detect errors caused by the 1M context window requiring Extra Usage.
 * Max subscribers without Extra Usage enabled get this error when using
 * sonnet[1m] or opus[1m]. The fix is to fall back to the base model.
 */
export function isExtraUsageRequiredError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase()
  return (lower.includes("extra usage") && lower.includes("1m")) || lower.includes("out of extra usage")
}

/**
 * Structured SDK-termination metadata extracted from raw error text.
 * Used by diagnosticLog to surface why the SDK subprocess ended (max_turns,
 * exit, abort) plus the captured stderr tail — info that classifyError
 * collapses into a generic api_error.
 */
export interface SdkTermination {
  reason: "max_turns" | "process_exit" | "aborted" | "unknown"
  /** Turn count when reason=max_turns and parseable. */
  turns?: number
  /** Exit code when reason=process_exit and parseable. */
  exitCode?: number
  /** Captured "Subprocess stderr: …" tail (truncated). */
  stderrTail?: string
  /** Truncated raw error message — set only when reason="unknown" so the log
   *  line stays self-contained for unrecognized SDK errors (e.g. so we can
   *  add a new pattern next time). */
  rawTail?: string
}

const STDERR_TAIL_MAX = 500
const RAW_TAIL_MAX = 300

function extractStderrTail(errMsg: string): string | undefined {
  const marker = "Subprocess stderr:"
  const idx = errMsg.indexOf(marker)
  if (idx < 0) return undefined
  const tail = errMsg.slice(idx + marker.length).trim()
  if (!tail) return undefined
  return tail.length > STDERR_TAIL_MAX ? tail.slice(0, STDERR_TAIL_MAX) : tail
}

function makeRawTail(errMsg: string): string | undefined {
  // Strip the stderr appendix; we already log it separately as stderrTail.
  const marker = "Subprocess stderr:"
  const idx = errMsg.indexOf(marker)
  const head = (idx >= 0 ? errMsg.slice(0, idx) : errMsg).trim()
  if (!head) return undefined
  return head.length > RAW_TAIL_MAX ? head.slice(0, RAW_TAIL_MAX) : head
}

/**
 * Parse the raw error message thrown by the Claude Agent SDK into structured
 * termination metadata. Pure function — no I/O.
 *
 * Returns reason="unknown" when the message doesn't match any recognized
 * pattern; callers can still log it with whatever surrounding context they have.
 */
export function extractSdkTermination(errMsg: string): SdkTermination {
  const stderrTail = extractStderrTail(errMsg)

  // Look at both the wrapper text and the stderr tail when classifying
  // (the SDK sometimes emits the operative phrase only into stderr).
  const haystack = `${errMsg}\n${stderrTail ?? ""}`
  const lower = haystack.toLowerCase()

  if (lower.includes("reached maximum number of turns")) {
    const m = haystack.match(/Reached maximum number of turns \((\d+)\)/i)
    return {
      reason: "max_turns",
      ...(m ? { turns: Number(m[1]) } : {}),
      ...(stderrTail ? { stderrTail } : {}),
    }
  }

  if (lower.includes("exited with code") || lower.includes("process exited")) {
    const m = haystack.match(/exited with code (\d+)/i)
    return {
      reason: "process_exit",
      ...(m ? { exitCode: Number(m[1]) } : {}),
      ...(stderrTail ? { stderrTail } : {}),
    }
  }

  if (lower.includes("aborterror") || /\baborted\b/.test(lower)) {
    return {
      reason: "aborted",
      ...(stderrTail ? { stderrTail } : {}),
    }
  }

  const rawTail = makeRawTail(errMsg)
  return {
    reason: "unknown",
    ...(stderrTail ? { stderrTail } : {}),
    ...(rawTail ? { rawTail } : {}),
  }
}

/**
 * Render an SdkTermination plus request context as a single greppable log line.
 * Matches the key=value style used by token-health diagnostic messages so all
 * /telemetry/logs entries are uniform.
 *
 * Session IDs are truncated to 8 chars to keep lines short — full IDs are
 * already on the parent telemetry record.
 */
export function formatSdkTermination(
  t: SdkTermination,
  ctx: {
    model?: string
    requestSource?: string
    isResume?: boolean
    hasDeferredTools?: boolean
    sdkSessionId?: string
  },
): string {
  const parts: string[] = [`reason=${t.reason}`]
  if (t.turns !== undefined) parts.push(`turns=${t.turns}`)
  if (t.exitCode !== undefined) parts.push(`exit=${t.exitCode}`)
  if (ctx.model) parts.push(`model=${ctx.model}`)
  if (ctx.requestSource) parts.push(`source=${ctx.requestSource}`)
  if (ctx.isResume !== undefined) parts.push(`resume=${ctx.isResume}`)
  if (ctx.hasDeferredTools !== undefined) parts.push(`deferred=${ctx.hasDeferredTools}`)
  if (ctx.sdkSessionId) parts.push(`session=${ctx.sdkSessionId.slice(0, 8)}`)
  if (t.rawTail) parts.push(`raw=${JSON.stringify(t.rawTail)}`)
  if (t.stderrTail) parts.push(`stderr=${JSON.stringify(t.stderrTail)}`)
  return `sdk_termination ${parts.join(" ")}`
}
