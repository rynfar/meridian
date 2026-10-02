/**
 * Upstream reachability: the classifier, the evidence read off SDK messages,
 * and the state machine that turns them into a readiness answer.
 *
 * The clock is injected everywhere, so minutes-long windows are exercised
 * without waiting for them.
 */

import { describe, expect, it } from "bun:test"
import {
  answeredOverHttp,
  classifyConnectionFailure,
  DEFAULT_REACHABILITY_THRESHOLDS,
  observeReachability,
  reachabilityEvidence,
  resolveReachabilityThresholds,
  unreachableDetail,
  UpstreamReachability,
  withReachability,
  type ConnectionFailureKind,
  type ReachabilityThresholds,
} from "../proxy/upstreamReachability"

const T0 = Date.parse("2026-10-01T21:00:00.000Z")
const SECOND = 1000
const MINUTE = 60 * SECOND

// The wordings below are the CLI's own (claude-code 2.1.284 formatter, plus
// the older SDK-bundled CLI), behind the wrappers they really arrive in.
const DNS = "Claude Code returned an error result: API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"

function tracker(thresholds: ReachabilityThresholds = DEFAULT_REACHABILITY_THRESHOLDS) {
  const clock = { now: T0 }
  const reach = new UpstreamReachability(() => clock.now, () => thresholds)
  return { clock, reach }
}

describe("classifyConnectionFailure", () => {
  it.each<[string, ConnectionFailureKind]>([
    [DNS, "dns"],
    ["API Error: Can’t reach the API server — check your internet or DNS (EAI_AGAIN)", "dns"],
    ["API Error: Can't reach the API server — check your internet or DNS (FailedToOpenSocket)", "dns"],
    ["API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)", "refused"],
    ["API Error: Connection dropped (ECONNRESET)", "reset"],
    ["API Error: No internet route — check your connection or VPN (EHOSTUNREACH)", "unroutable"],
    ["API Error: Couldn't connect through your proxy (ERR_PROXY_TUNNEL) — the proxy refused the tunnel", "proxy"],
    ["API Error: Unable to connect to API: SSL certificate has expired", "tls"],
    ["API Error: Unable to connect to API: Self-signed certificate detected (SELF_SIGNED_CERT_IN_CHAIN)", "tls"],
    ["API Error: Request timed out. Check your internet connection and proxy settings", "timeout"],
    ["API Error: Unable to connect to API (ENOTFOUND)", "dns"],
    ["API Error: Unable to connect to API (ECONNREFUSED)", "refused"],
    ["API Error: Unable to connect to API (ESOMETHINGNEW)", "connection"],
    ["API Error: Unable to connect to API. Check your internet connection", "connection"],
    ["Claude Code returned an error result: API Error: Connection error.", "connection"],
    // A crash exit carries the CLI's report on a stderr line.
    ["Claude Code process exited with code 1\nSubprocess stderr: API Error: Connection dropped (EPIPE)", "reset"],
  ])("%s -> %s", (text, kind) => {
    expect(classifyConnectionFailure(text)).toBe(kind)
  })

  // Each of these would take a healthy instance out of rotation if it matched.
  it.each([
    "429 rate limit reached for this account",
    "Claude Code returned an error result: You've hit your limit · resets 3pm",
    "API Error: 529 Overloaded",
    "API Error: 401 authentication_error",
    // A slow upstream, not an unreachable one.
    "API Error: Request timed out.",
    // An MCP server reporting its OWN dependency, without the CLI's prefix.
    "Claude Code process exited with code 1\nSubprocess stderr: [mcp] connection refused (ECONNREFUSED) talking to postgres",
    // Quoted mid-line in an assistant turn.
    "The log said API Error: Can't reach the API server, which is odd",
    "ECONNREFUSED",
    "API Error: Connection error. Retrying in 3s",
    "",
  ])("not a connection failure: %s", (text) => {
    expect(classifyConnectionFailure(text)).toBeNull()
  })

  it("accepts nothing that is not a string", () => {
    expect(classifyConnectionFailure(null)).toBeNull()
    expect(classifyConnectionFailure(undefined)).toBeNull()
  })
})

describe("answeredOverHttp", () => {
  it.each([
    "API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 250000 tokens > 200000 maximum\"}}",
    "Claude Code returned an error result: API Error: 401 OAuth token has been revoked",
    "API Error: 529 Overloaded",
    "Claude Code process exited with code 1\nSubprocess stderr: API Error: 403 Your organization has disabled Claude subscription access",
  ])("an HTTP response: %s", (text) => {
    expect(answeredOverHttp(text)).toBe(true)
  })

  it.each([
    DNS,
    "API Error: Connection error.",
    // Raised by the CLI itself, before any request leaves the host.
    "Not logged in · Please run /login",
    "Invalid API key · Fix external API key",
    // Quoted mid-line, or a number that is not a status.
    "The log said API Error: 401 earlier",
    "API Error: 4015 things",
    "handler.js:401:15",
    "",
  ])("not an HTTP response: %s", (text) => {
    expect(answeredOverHttp(text)).toBe(false)
  })

  it("accepts nothing that is not a string", () => {
    expect(answeredOverHttp(null)).toBe(false)
    expect(answeredOverHttp(undefined)).toBe(false)
  })
})

describe("reachabilityEvidence", () => {
  const assistant = (text: string, extra: Record<string, unknown> = {}, model = "claude-opus-5-5") => ({
    type: "assistant",
    message: { model, content: [{ type: "text", text }] },
    ...extra,
  })

  it("reads a retry notice without an HTTP status as a connection failure, and one with a status as an answer", () => {
    expect(reachabilityEvidence({ type: "system", subtype: "api_retry", error_status: null, error: "unknown" }))
      .toEqual({ kind: "failure", failure: "connection", terminal: false })
    expect(reachabilityEvidence({ type: "system", subtype: "api_retry", error_status: 529, error: "server_error" }))
      .toEqual({ kind: "reached" })
  })

  it("counts a response starting, but not the deltas of one already open", () => {
    expect(reachabilityEvidence({ type: "stream_event", event: { type: "message_start" } })).toEqual({ kind: "reached" })
    expect(reachabilityEvidence({ type: "stream_event", event: { type: "content_block_delta" } })).toBeNull()
  })

  it("counts a real assistant message, not a synthetic one", () => {
    expect(reachabilityEvidence(assistant("hello"))).toEqual({ kind: "reached" })
    expect(reachabilityEvidence(assistant("No response requested.", {}, "<synthetic>"))).toBeNull()
  })

  it("reads the CLI's terminal error message for its connection failure", () => {
    expect(reachabilityEvidence(assistant("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", { error: "unknown" }, "<synthetic>")))
      .toEqual({ kind: "failure", failure: "dns", terminal: true })
  })

  it("treats an HTTP-backed refusal as Anthropic answering, and a locally raised one as nothing", () => {
    expect(reachabilityEvidence(assistant("You've hit your limit", { error: "rate_limit" }, "<synthetic>"))).toEqual({ kind: "reached" })
    expect(reachabilityEvidence(assistant("Credit balance is too low", { error: "billing_error" }, "<synthetic>"))).toEqual({ kind: "reached" })
    expect(reachabilityEvidence(assistant("Not logged in", { error: "authentication_failed" }, "<synthetic>"))).toBeNull()
    expect(reachabilityEvidence(assistant("Prompt is too long", { error: "invalid_request" }, "<synthetic>"))).toBeNull()
  })

  it("treats a terminal error carrying an HTTP status as Anthropic answering, whatever its tag", () => {
    expect(reachabilityEvidence(assistant("API Error: 400 prompt is too long: 250000 tokens > 200000 maximum", { error: "invalid_request" }, "<synthetic>")))
      .toEqual({ kind: "reached" })
    expect(reachabilityEvidence(assistant("API Error: 401 OAuth token has been revoked", { error: "authentication_failed" }, "<synthetic>")))
      .toEqual({ kind: "reached" })
  })

  it("ignores everything else", () => {
    expect(reachabilityEvidence({ type: "result", subtype: "success", is_error: false })).toBeNull()
    expect(reachabilityEvidence({ type: "system", subtype: "init" })).toBeNull()
    expect(reachabilityEvidence(null)).toBeNull()
    expect(reachabilityEvidence("text")).toBeNull()
  })
})

describe("UpstreamReachability", () => {
  it("starts ok, with nothing observed", () => {
    const { reach } = tracker()
    expect(reach.snapshot()).toEqual({
      state: "ok",
      since: new Date(T0).toISOString(),
      failingSince: null,
      consecutiveFailures: 0,
      lastReachedAt: null,
      lastFailureAt: null,
      lastErrorKind: null,
      holdUntil: null,
      override: null,
    })
  })

  it("needs the minimum number of failures, however long they span", () => {
    const { clock, reach } = tracker()
    reach.recordFailure("dns")
    clock.now += 5 * MINUTE
    reach.recordFailure("dns")
    expect(reach.snapshot().state).toBe("ok")
  })

  it("needs the failures to span the window, however many there are", () => {
    const { clock, reach } = tracker()
    for (let i = 0; i < 10; i++) {
      reach.recordFailure("dns")
      clock.now += 10 * SECOND
    }
    expect(reach.snapshot().state).toBe("ok")
    expect(reach.snapshot().consecutiveFailures).toBe(10)
  })

  it("concludes unreachable once both hold, and reports the run", () => {
    const { clock, reach } = tracker()
    reach.recordFailure("connection")
    clock.now += MINUTE
    reach.recordFailure("connection")
    clock.now += MINUTE
    reach.recordFailure("dns")
    const at = new Date(T0 + 2 * MINUTE).toISOString()
    expect(reach.snapshot()).toEqual({
      state: "unreachable",
      since: at,
      failingSince: new Date(T0).toISOString(),
      consecutiveFailures: 3,
      lastReachedAt: null,
      lastFailureAt: at,
      lastErrorKind: "dns",
      holdUntil: new Date(T0 + 2 * MINUTE + 5 * MINUTE).toISOString(),
      override: null,
    })
  })

  it("keeps holding while failures continue, then probes once they stop", () => {
    const { clock, reach } = tracker()
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    // Last failure at T0+2m, now T0+3m: still inside the hold.
    reach.recordFailure("dns")
    expect(reach.snapshot().holdUntil).toBe(new Date(T0 + 3 * MINUTE + 5 * MINUTE).toISOString())
    clock.now += 5 * MINUTE - 1
    expect(reach.snapshot().state).toBe("unreachable")
    clock.now += 1
    const probing = reach.snapshot()
    expect(probing.state).toBe("probing")
    expect(probing.since).toBe(new Date(T0 + 8 * MINUTE).toISOString())
    expect(probing.holdUntil).toBeNull()
  })

  it("goes straight back to unreachable on a failure while probing", () => {
    const { clock, reach } = tracker()
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    clock.now += 10 * MINUTE
    expect(reach.snapshot().state).toBe("probing")
    reach.recordFailure("refused")
    const snapshot = reach.snapshot()
    expect(snapshot.state).toBe("unreachable")
    expect(snapshot.since).toBe(new Date(clock.now).toISOString())
    expect(snapshot.lastErrorKind).toBe("refused")
    // Never reached since the run began, so the run is the same outage.
    expect(snapshot.failingSince).toBe(new Date(T0).toISOString())
  })

  it("returns to ok at once on any answer, from every state", () => {
    const { clock, reach } = tracker()
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    expect(reach.snapshot().state).toBe("unreachable")
    reach.recordReached()
    const snapshot = reach.snapshot()
    expect(snapshot).toMatchObject({
      state: "ok",
      since: new Date(clock.now).toISOString(),
      failingSince: null,
      consecutiveFailures: 0,
      lastReachedAt: new Date(clock.now).toISOString(),
      holdUntil: null,
    })
    // The last failure stays on record for whoever is looking back.
    expect(snapshot.lastErrorKind).toBe("dns")

    clock.now += 10 * MINUTE
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    clock.now += 10 * MINUTE
    expect(reach.snapshot().state).toBe("probing")
    reach.recordReached()
    expect(reach.snapshot().state).toBe("ok")
  })

  it("starts the window over after an answer, so failures either side of it never add up", () => {
    const { clock, reach } = tracker()
    reach.recordFailure("dns")
    clock.now += MINUTE
    reach.recordFailure("dns")
    clock.now += 30 * SECOND
    reach.recordReached()
    clock.now += 10 * SECOND
    reach.recordFailure("dns")
    clock.now += 100 * SECOND
    reach.recordFailure("dns")
    expect(reach.snapshot().state).toBe("ok")
    clock.now += 30 * SECOND
    reach.recordFailure("dns")
    expect(reach.snapshot().state).toBe("unreachable")
    expect(reach.snapshot().failingSince).toBe(new Date(T0 + 100 * SECOND).toISOString())
  })

  it("never fails readiness with a zero hold, while still recording the run", () => {
    const { clock, reach } = tracker({ ...DEFAULT_REACHABILITY_THRESHOLDS, holdMs: 0 })
    for (let i = 0; i < 5; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    expect(reach.snapshot().state).toBe("probing")
    expect(reach.snapshot().consecutiveFailures).toBe(5)
  })

  it("re-reads its thresholds on every evaluation", () => {
    let thresholds: ReachabilityThresholds = DEFAULT_REACHABILITY_THRESHOLDS
    const clock = { now: T0 }
    const reach = new UpstreamReachability(() => clock.now, () => thresholds)
    reach.recordFailure("dns")
    clock.now += 10 * SECOND
    reach.recordFailure("dns")
    expect(reach.snapshot().state).toBe("ok")
    thresholds = { unreachableAfterMs: 5 * SECOND, holdMs: MINUTE, minFailures: 2 }
    clock.now += SECOND
    reach.recordFailure("dns")
    expect(reach.snapshot().state).toBe("unreachable")
    thresholds = { ...thresholds, holdMs: 0 }
    expect(reach.snapshot().state).toBe("probing")
  })

  it("forces a state for a bounded time, over whatever traffic says", () => {
    const { clock, reach } = tracker()
    reach.force("unreachable", MINUTE)
    expect(reach.snapshot()).toMatchObject({
      state: "unreachable",
      override: { state: "unreachable", until: new Date(T0 + MINUTE).toISOString() },
      holdUntil: null,
    })
    reach.recordReached()
    expect(reach.snapshot().state).toBe("unreachable")
    clock.now += MINUTE
    expect(reach.snapshot()).toMatchObject({ state: "ok", override: null })

    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    expect(reach.snapshot().state).toBe("unreachable")
    reach.force("ok", 10 * MINUTE)
    expect(reach.snapshot().state).toBe("ok")
    reach.clearOverride()
    expect(reach.snapshot().state).toBe("unreachable")
  })
})

describe("resolveReachabilityThresholds", () => {
  const none = () => undefined
  const noSettings = () => ({})

  it("falls back to the defaults", () => {
    expect(resolveReachabilityThresholds(none, noSettings)).toEqual({ unreachableAfterMs: 120_000, holdMs: 300_000, minFailures: 3 })
  })

  it("reads settings.json, and lets the environment win", () => {
    const settings = () => ({ upstreamUnreachableAfterMs: 60_000, upstreamUnreachableHoldMs: 0, upstreamUnreachableMinFailures: 5 })
    expect(resolveReachabilityThresholds(none, settings)).toEqual({ unreachableAfterMs: 60_000, holdMs: 0, minFailures: 5 })
    const environment = (suffix: string) => ({
      UPSTREAM_UNREACHABLE_AFTER_MS: "10000",
      UPSTREAM_UNREACHABLE_HOLD_MS: "20000",
      UPSTREAM_UNREACHABLE_MIN_FAILURES: "2",
    } as Record<string, string>)[suffix]
    expect(resolveReachabilityThresholds(environment, settings)).toEqual({ unreachableAfterMs: 10_000, holdMs: 20_000, minFailures: 2 })
  })

  it("ignores a value that is not a non-negative integer, and never needs fewer than one failure", () => {
    const environment = (suffix: string) => ({ UPSTREAM_UNREACHABLE_AFTER_MS: "two minutes", UPSTREAM_UNREACHABLE_HOLD_MS: "-5" } as Record<string, string>)[suffix]
    const settings = () => ({ upstreamUnreachableHoldMs: 1.5, upstreamUnreachableMinFailures: 0 })
    expect(resolveReachabilityThresholds(environment, settings)).toEqual({ unreachableAfterMs: 120_000, holdMs: 300_000, minFailures: 1 })
  })
})

describe("observeReachability", () => {
  const terminal = {
    type: "assistant",
    error: "unknown",
    message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)" }] },
  }

  it("counts the CLI's terminal report once, though it arrives as a message and again as the thrown error", () => {
    const { reach } = tracker()
    const observer = observeReachability(reach)
    observer.message({ type: "system", subtype: "api_retry", error_status: null })
    observer.message(terminal)
    observer.error(new Error(DNS))
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 2, lastErrorKind: "dns" })
  })

  it("counts the thrown error when no terminal message preceded it", () => {
    const { reach } = tracker()
    observeReachability(reach).error(new Error(DNS))
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 1, lastErrorKind: "dns" })
  })

  it("leaves the tracker alone for an error that is not a connection failure", () => {
    const { reach } = tracker()
    observeReachability(reach).error(new Error("429 rate limit reached for this account"))
    expect(reach.snapshot().consecutiveFailures).toBe(0)
  })

  it("ends the failure run on a thrown error carrying an HTTP status", () => {
    const { reach } = tracker()
    const observer = observeReachability(reach)
    observer.message({ type: "system", subtype: "api_retry", error_status: null })
    observer.error(new Error("Claude Code returned an error result: API Error: 400 prompt is too long"))
    expect(reach.snapshot()).toMatchObject({ consecutiveFailures: 0, failingSince: null, lastReachedAt: new Date(T0).toISOString() })
  })
})

describe("withReachability", () => {
  it("passes the stream through unchanged while reading it", async () => {
    const { reach } = tracker()
    const messages = [
      { type: "stream_event", event: { type: "message_start" } },
      { type: "stream_event", event: { type: "content_block_delta" } },
    ]
    async function* source() { yield* messages }
    const seen: unknown[] = []
    for await (const message of withReachability(source(), reach)) seen.push(message)
    expect(seen).toEqual(messages)
    expect(reach.snapshot().lastReachedAt).toBe(new Date(T0).toISOString())
  })

  it("records a connection failure the stream throws, and rethrows it", async () => {
    const { reach } = tracker()
    async function* source(): AsyncGenerator<never> { throw new Error(DNS) }
    await expect((async () => { for await (const _ of withReachability(source(), reach)) { /* drain */ } })()).rejects.toThrow("Can't reach the API server")
    expect(reach.snapshot().lastErrorKind).toBe("dns")
  })
})

describe("unreachableDetail", () => {
  it("says nothing while the upstream may serve", () => {
    const { clock, reach } = tracker()
    expect(unreachableDetail(reach.snapshot())).toBeNull()
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    clock.now += 10 * MINUTE
    expect(unreachableDetail(reach.snapshot())).toBeNull()
  })

  it("names when it started, the last error, the count and the last answer", () => {
    const { clock, reach } = tracker()
    reach.recordReached()
    clock.now += SECOND
    for (let i = 0; i < 3; i++) {
      reach.recordFailure("dns")
      clock.now += MINUTE
    }
    expect(unreachableDetail(reach.snapshot())).toBe(
      "Anthropic unreachable since 2026-10-01T21:00:01.000Z (last error: dns, 3 connection failures, last answered 2026-10-01T21:00:00.000Z)",
    )
  })

  it("says when the state is forced", () => {
    const { reach } = tracker()
    reach.force("unreachable", MINUTE)
    expect(unreachableDetail(reach.snapshot())).toBe("forced unreachable by override until 2026-10-01T21:01:00.000Z")
  })
})
