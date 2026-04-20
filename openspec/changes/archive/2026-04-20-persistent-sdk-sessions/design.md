## Context

Meridian bridges agents speaking the Anthropic Messages API (OpenCode, ForgeCode, Pi, Crush, Droid, and generic passthrough) to Claude Max via `@anthropic-ai/claude-agent-sdk`. The current request pattern, visible in `src/proxy/server.ts` at four `query()` call sites (two streaming, two non-streaming) and centralized in `src/proxy/query.ts:buildQueryOptions`, is: look up the prior Claude SDK session id via `session/cache.ts`, construct options including `resume: resumeSessionId`, call `query()`, consume the generator to completion, store the new session id.

Live cache traces show turn 1 writing ~344 `cacheCreationInputTokens` and turn 2 returning `cacheReadInputTokens=0` with ~3637 `cacheCreationInputTokens`. The SDK options between turns are byte-identical except for `resume` and `maxTurns`. The SDK rehydrates the session from `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, reconstructs message objects, and reserializes them for the Anthropic request. That second serialization is not byte-identical to the live-memory serialization of turn 1, so the prompt-cache prefix lookup misses.

The SDK is designed for long-running agent processes. `query()` accepts `prompt: string | AsyncIterable<SDKUserMessage>`. With an AsyncIterable, the query enters "streaming-input mode" and the returned `Query` exposes control methods (`interrupt`, `setPermissionMode`, `setModel`, `applyFlagSettings`, `close`, `initializationResult`, `getContextUsage`, `stopTask`, etc.). `resume` is a recovery path for process restart / host migration; it is not the hot path the SDK is optimized around.

Constraints that must hold across this change:

- External API contract is frozen: `startProxyServer`, `ProxyInstance`, `POST /v1/messages`, `x-opencode-session`, `x-meridian-profile`, `GET /health`, `GET /profiles/list`, `POST /profiles/active`.
- `session/lineage.ts` stays pure.
- No circular dependencies; `server.ts` continues to orchestrate, not compute.
- All adapters continue to work.
- All existing tests pass with `persistentSessions: false`.

## Goals / Non-Goals

**Goals:**

- Turns after the first one on a session hit the Anthropic prompt cache (`cacheReadInputTokens > 0`) with the default `persistentSessions: true` configuration, proven by live trace.
- First turn, cold-reattach turn, and options-drift-reopen turns MAY miss cache — that matches today's behavior and is acceptable.
- Pi passthrough tool-result forwarding stays correct: every tool_use the model emits gets a corresponding tool_result delivered back, and the resumed conversation prefix preserves the tool_use ↔ tool_result pairing.
- Process restart recovers: if the live-query map is empty but `sessionStore` / the SDK `.jsonl` knows the session, the next request transparently reattaches via `resume` and becomes warm.
- Graceful shutdown closes all live queries without leaking subprocesses.
- Feature flag lets us ship, measure, and roll back without code edits.

**Non-Goals:**

- We are not fixing the byte-drift in the SDK's `resume` path. We're routing around it.
- We are not building a multi-host distributed session layer. `SessionRuntime` is in-process.
- We are not adding an outbound Anthropic interceptor. That's an alternative approach, retained as a fallback only if the spike fails.
- We are not carrying forward the fork's `structuredUserPrompt` work. That's a separate branch; if persistent mode succeeds, it is archived.
- We are not changing the existing `session/cache.ts` lineage semantics (continuation / compaction / undo / diverged).

## Decisions

### D1. One `SessionRuntime` per logical session, keyed by `profileSessionId`

`profileSessionId` is the existing key used by `session/cache.ts`, derived from `x-opencode-session` or fingerprint. The live-query map uses the same key — no new identifier. A `SessionRuntime` holds:

- `liveQuery: Query` — the SDK's return value; alive for the lifetime of the runtime.
- `inputQueue: AsyncQueue<SDKUserMessage>` — single-writer input iterable the SDK consumes.
- `claudeSessionId: string | null` — captured on first `session_id` event; used for cold-reattach `resume`.
- `optionsHash: string` — hash of the session-lifetime options (cwd, systemPrompt, mcpServers, allowedTools, etc.); used to detect incompatible drift.
- `mutex: Mutex` — serializes turns within a session.
- `lastActivity: number` — for LRU eviction.

**Alternative considered:** Keying on `(profileSessionId, requestedModel)` so model changes don't share a runtime. Rejected — `setModel()` works mid-session, so model differences are compatible; the extra key would cause unnecessary close+reopens.

### D2. Streaming-input mode for every runtime

`query({ prompt: inputQueue, options })` with `inputQueue` as an AsyncIterable, not a string. This unlocks `setModel`, `applyFlagSettings`, `close`, `interrupt`, `getContextUsage` — the tools we need for in-place per-turn adjustments and clean teardown.

**Alternative considered:** Fresh `query()` per turn but always with full-history preloaded in a string prompt. Rejected — the SDK's `prompt` only accepts user messages (via `SDKUserMessage`), not assistant history. History must come from either `resume` (drifting) or an already-alive query.

### D3. Per-turn boundary from `SDKResultMessage`

In non-persistent mode, the generator ends and the handler knows the turn is complete. In persistent mode, the generator never ends until `close()`. The per-turn terminator is an event with `type === "result"` (`SDKResultMessage`). This was empirically verified in every spike scenario (plain text, SDK-executed single/multi-tool, live Pi, deferred-handler passthrough) and is exposed as `isTurnTerminator` in `runtime.ts`.

**One important nuance surfaced by the live Pi spike:** using `for await (const m of query) { ...; if (terminator) return }` on the SDK query iterator breaks subsequent turns — the for-await protocol calls `iterator.return()` on early exit, which marks the async generator done. `consumeTurn` MUST iterate manually via `queryIter.next()` so the same iterator survives across turns.

**Alternative considered and rejected:** track boundaries via Anthropic-side `message_stop` on the partial-message stream. Not needed — the SDK-level `result` event is reliable and fires once per logical turn even when the SDK internally does multiple Anthropic round-trips for tool execution.

### D4. Options-drift policy — in-place vs. close+reopen

| Option                         | Can change mid-session? | Persistent-mode behavior          |
|--------------------------------|-------------------------|-----------------------------------|
| `model`                        | Yes (`setModel`)         | Apply in place                    |
| `effort`, `thinking`           | Yes (`applyFlagSettings`) | Apply in place                    |
| `maxBudgetUsd`, `fallbackModel`| Yes (`applyFlagSettings`) | Apply in place                    |
| `systemPrompt`                 | No                       | Reopen (hash mismatch)            |
| `cwd`                          | No                       | Reopen (hash mismatch)            |
| `mcpServers`                   | No                       | Reopen (hash mismatch)            |
| `allowedTools` / tool set      | No                       | Reopen (hash mismatch)            |
| `disallowedTools`              | No                       | Reopen (hash mismatch)            |
| `settingSources`               | No                       | Reopen (hash mismatch)            |

Reopen = `query.close()`, throw away the runtime, start a new one with `resume: claudeSessionId` so the new query picks up the existing conversation. That turn pays a cache miss; the one after it warms up again. Options-hash is `stableStringify(reopenCriticalOptions)` then SHA-256 truncated to 16 chars.

**Alternative considered:** Reject requests whose options don't match the runtime's snapshot (HTTP 409). Rejected — the HTTP contract must stay stable; reopen is the right correctness answer even at the cost of one miss.

### D5. Cold reattach — the bridge between warm and persistent

Three entry paths into a turn:

```
┌────────────────────────────────────────────────────────────────────┐
│                    Turn entry dispatcher                            │
└───────────┬──────────────────────┬─────────────────┬───────────────┘
            │                      │                 │
            ▼                      ▼                 ▼
   profileSessionId          exists in          exists in
   unknown                   live-query map     sessionStore only
            │                      │                 │
            ▼                      ▼                 ▼
   Start fresh query         Reuse runtime    Start query({ resume })
   (no resume)               (warm hit)       Hold alive → warm
   Hold alive → warm         Push msg         Push msg
```

**Alternative considered:** Always start a fresh query (no resume) on cold paths and let the SDK pick up from disk as needed. Rejected — that doesn't reattach the session lineage, and the downstream agent expects continuity.

### D6. Undo / fork → close + reopen with fork options

The current code sets `forkSession: true, resumeSessionAt: undoRollbackUuid` on a fresh `query()`. In persistent mode, undo signals a topology change: the in-memory prefix is no longer valid. The runtime handling of undo is:

1. Acquire mutex.
2. `query.close()` the current runtime.
3. Start a new query with `resume: claudeSessionId, forkSession: true, resumeSessionAt: uuid`.
4. Push the current turn's user message.
5. Hold alive.

**Alternative considered:** In-place rewind via `Query.rewindFiles()`. Rejected — `rewindFiles` handles file checkpoints, not conversation fork; orthogonal.

### D7. LRU eviction — 15 min idle, hard cap 32

- Anthropic's ephemeral cache is 5 min; past that, cache benefit is gone but subprocess-warm benefit remains.
- 15 min idle is a compromise between subprocess reuse and memory pressure.
- Hard cap 32 bounds memory in pathological concurrent-session scenarios.
- On eviction: `query.close()`. Next request for that `profileSessionId` goes through cold-reattach.

Both are config-tunable: `ProxyConfig.persistentSessionIdleMs`, `ProxyConfig.persistentSessionMaxLive`.

**Alternative considered:** Align idle timeout with Anthropic's 5-min cache window. Rejected — cache-misses on cold-reattach are cheap relative to subprocess restart cost, so we optimize for warm holds even past the cache window.

### D8. Passthrough MCP is constructed per-runtime and uses deferred handlers

`createPassthroughMcpServer()` is called once per `SessionRuntime` at construction and attached to the query. The handlers are closures over the runtime's `pendingExecutions` map — see §D11 for the full mechanism (deferred promise resolution from the client's tool_result). A tool-surface change between turns is treated as reopen-required under §D4 (close+cold-reattach with a fresh MCP server).

**Alternative considered and rejected:** separate MCP per turn — MCPs are bound at query construction per the SDK, so a separate MCP means a separate query (which is exactly what reopen does). No middle ground exists.

**Alternative considered and rejected:** in-place tool-surface updates on a live MCP server. The original design had a conditional path for this; the §1d spike made the question moot because the deferred-handler mechanism replaces the MCP wholesale on tool-surface change anyway.

### D9. Feature flag + rollout

`ProxyConfig.persistentSessions: boolean` defaults to `false`. The two `query()` call sites branch:

```
if (config.persistentSessions && !isUndo) {
  useRuntime(profileSessionId, body, ...)
} else {
  // existing path
}
```

Rollout sequence (revised — OpenCode first, Pi second):

1. Land the spike; record results in `openspec/changes/persistent-sdk-sessions/spike-notes.md`.
2. Land the code behind the flag, flag off.
3. Enable flag for **OpenCode adapter first** via adapter-scoped gating. OpenCode's tool shape most closely matches what the spike validated (SDK-executed tools). This isolates the cache variable — proves the cache-hit win without confounding with client-executed-tool pairing risk.
4. Observe trace for one week (`mode=persistent` tag). Success criteria: (a) `cacheReadInputTokens > 0` on ≥ 95 % of non-first-turn OpenCode requests; (b) error-rate regression ≤ 0.5 pp vs. the prior week's OpenCode baseline on `persistentSessions: false`.
5. Enable flag for **Pi adapter next** — the original driver case. Pi tests the client-executed-tool pairing path under real traffic, now on top of a cache behaviour already proven by OpenCode. Same pass criteria as step 4, applied per-adapter.
6. Expand to ForgeCode, Crush, Droid, generic passthrough in that order, one at a time, same pass criteria per adapter.
7. After all six adapters green for two weeks, flip the default to `true`.

**Alternative considered:** original Pi-first ordering. Rejected in favour of OpenCode-first because Pi bundles two unproven risks (streaming-input cache behavior under tool turns + client-executed-tool pairing). OpenCode-first isolates the cache variable so that if a regression appears during Pi rollout, the cause is pairing, not caching.

### D10. Cache-control must be stripped from every user message pushed into a SessionRuntime

**Discovered during task §1c live spike.** Anthropic's API caps prompt-cache breakpoints at 4 per request. Pi (and likely other clients) attach `cache_control: {type: "ephemeral"}` to each user message's text block. In today's request-per-process model, those cache_control annotations live only in the current request and meridian's existing fresh-prompt builders already strip them via `stripCacheControlDeep`. In persistent mode they accumulate in the SDK's in-memory message history — after 4 turns, the SDK emits an Anthropic request with 5+ cache_control blocks and gets `HTTP 400: "A maximum of 4 blocks with cache_control may be provided"`.

**Rule:** every user content object pushed into a `SessionRuntime.inputQueue` MUST be passed through `stripCacheControlDeep` (or an equivalent sanitizer) first. Task 3.13 already adds a backpressure concern; this is an additional invariant the server wiring (§5.5c and §5.6) must respect.

### D11. Passthrough client-executed tools use a deferred MCP handler, not PreToolUse blocking

**Initial hypothesis (revised):** the §1c live spike suggested a "drain in background" approach. Subsequent §1c passthrough extension + §1d design spike proved that approach corrupts the SDK's conversation state with synthetic "blocked by hook" narrative, causing model confusion when the real client tool_result arrives.

**Final design (from §1d scenario D, confirmed working):** replace the PreToolUse-block mechanism entirely with a **deferred MCP handler** pattern.

#### Mechanism

1. **Meridian's passthrough MCP server** is created per-`SessionRuntime` (not per-request). Its tool handlers are closures over a per-runtime `pendingExecutions: Map<toolUseId, { resolve: (content: string) => void; reject: (err: unknown) => void; createdAt: number }>`.
2. **When the model emits a tool_use,** the SDK invokes the handler. The handler:
   - Creates a pending entry keyed by the tool_use id.
   - Returns a `Promise<MCPToolResult>` that resolves when meridian resolves the pending entry.
   - The SDK blocks there — it cannot emit further events until the handler returns.
3. **Meridian's SSE layer,** seeing the tool_use content_block through the stream, forwards it to the client (Pi) normally, then injects `message_delta { stop_reason: "tool_use", stop_sequence: null }` + `message_stop` + closes the SSE. The runtime is NOT touched; the SDK is still blocked on the handler.
4. **Client executes the tool locally** and sends a new HTTP request with a `user` message whose content includes `tool_result` blocks.
5. **Meridian receives the new request,** recognizes the tool_result shape, and for each tool_result block looks up its tool_use id in `pendingExecutions` and calls `resolve(content)`. Meridian does NOT push the tool_result as a user input into the runtime's queue — the SDK will see it as the MCP handler's return value, not as a new user message.
6. **SDK's handler returns,** the SDK continues processing, emits events for the model's final response. Meridian streams those to the (new) client SSE response as normal.

#### Why this works where the hook approach didn't

- The SDK's in-memory conversation history contains: `user(prompt) → assistant(tool_use) → user(tool_result: real content) → assistant(final answer)`. Byte-identical to what the client sees.
- No synthetic "blocked" narrative, no sentinel pollution, no override user message hack.
- Prompt cache keys on byte-identical prefixes; turn 2 naturally cache-hits.

#### Synthetic spike evidence (see `spike-notes.md` §"§1d …")

| Scenario | Correctness | T2 cacheRead |
|----------|-------------|--------------|
| C (hook blocks + drain) — the original §D11 plan | FAIL | 14951 |
| A (interrupt) | FAIL | 13823 |
| B (sentinel MCP return + override user message) | PASS | 13823 |
| **D (deferred MCP handler)** | **PASS** | **14070** |

Scenario D is the only one that achieves both correctness and cache cleanly, without conversational residue.

#### Alternatives considered and rejected

- **C (hook-block + background drain)** — corrupts conversation state. Rejected.
- **A (Query.interrupt() after tool_use)** — interrupt has "user stopped me" semantics; model goes into a graceful-abort state instead of waiting for tool result. Rejected.
- **B (sentinel + override)** — works but leaks sentinel strings into history and requires an extra user-message override that's brittle across model versions. Rejected in favor of D's cleaner approach.

#### Operational requirements for §5.12

1. `SessionRuntime` gains a `pendingExecutions: Map<string, PendingExecution>` field, attached at construction.
2. The passthrough MCP server is created per-runtime, with handlers that reference the runtime's `pendingExecutions` via closure.
3. Meridian's incoming-request dispatch classifies request shape:
   - Plain user message → `input.push(userMessage)`.
   - User message containing `tool_result` blocks → `resolvePendingTool(toolUseId, content)` for each block; do NOT push. If a tool_result has no matching pending entry, fall back to pushing (recovery path).
4. Pending executions have an idle timeout (default 15 min); expired entries reject their promises with a typed `PendingExecutionTimeoutError`. The SDK's handler re-throw propagates; the runtime catches and either closes or surfaces an error to the next client request.
5. Graceful shutdown must reject all pending promises before `ProxyInstance.close()` resolves.

#### Tasks affected

- §5.5c (reopen orchestrator) is unaffected by this — passthrough is now handled at the MCP/dispatch layer, not the SSE-suppression layer.
- §5.9 (Pi-shape pairing integration test) is updated to exercise the deferred-handler flow: emit tool_use → SSE closes with stop_reason tool_use → new request with tool_result → resolve pending → SDK continues → final response.
- §5.12 is re-authored around the deferred-handler pattern (see tasks.md).
- §7.3 (telemetry counters) adds `pending_executions_pending`, `pending_executions_resolved`, `pending_executions_timed_out`.
- A small residual: ToolSearch calls (deferred-tool-loading) still need a no-op hook return to tell the SDK to proceed. That can be a minimal PreToolUse hook that returns `{}` for ToolSearch only — no `{decision: "block"}` anywhere.

### D12. Mocked `Query` helper for integration tests

A shared test helper that returns an object implementing:

- `AsyncGenerator<SDKMessage, void>` with programmable per-turn message streams.
- `close(): void` (sync per SDK types).
- All control methods as no-op async stubs by default, overridable.
- Internal wiring to consume the input AsyncIterable and emit the per-turn terminal event after each pushed user message — faithfully reproducing the event sequence documented in `spike-notes.md` (leading `system(init)` per turn, optional `rate_limit_event` mid-turn, synthetic `user` events during tool execution, exactly one `result` per turn).

This helper replaces the current inline mocks; tests opt in with `createMockQuery({ turns: [...] })`. See task §4 for authoring details.

## Risks / Trade-offs

- **[SDK streaming-input bug under our usage pattern]** → Spiked and cleared. Six scenarios across plain text, SDK-executed tools, live Pi, and deferred-handler passthrough all cache correctly.
- **[Subprocess crash mid-session loses the runtime]** → Detect via query iterator throw (wired through `onCrash` in `SessionRuntime`); transparently cold-reattach on the next request via `resume`. One cache miss; correctness preserved.
- **[Per-request options drift more common than expected → reopen churn]** → Observability pass (§2) deferred (waived) due to solo-dev traffic volume. Will be measured post-OpenCode-rollout in §8.3; D4 revisited if the rate exceeds 10 %.
- **[Memory ceiling from N live subprocesses]** → Hard cap + LRU (D7); default 32 live queries, tunable.
- **[Concurrent turns on the same session interleave]** → Per-session mutex (D1); 30 s wait cap; 429 on overflow (§5.10).
- **[Graceful shutdown leaks subprocesses OR hangs on pending deferred handlers]** → `ProxyInstance.close()` rejects all pending deferred-handler promises AND closes every runtime within a 10 s timeout (§6.1 + §5.12g).
- **[SDK updates change control-method semantics]** → SDK version pinned in package.json; bump deliberately; persistent-mode integration tests run as part of the SDK-upgrade checklist.
- **[Mock drift vs. real SDK behavior]** → Mock (§4) faithfully reproduces the empirical event sequence from spike-notes.md. E2E coverage with persistent mode enabled is required before flipping the default (§10.6).
- **[cache_control accumulation hits Anthropic's 4-block cap]** → Every push into the input queue goes through `stripCacheControlDeep` (§D10, §5.13).

## Migration Plan

1. ~~**Spike**~~ — done across six scenarios (task groups §1, §1b, §1c, §1d). Results in `spike-notes.md`.
2. ~~**Module skeleton**~~ — done: `src/proxy/session/runtime.ts` + 23 unit tests.
3. **Mock helper** — task §4. Emits the empirical event sequence from spike-notes.md.
4. **Server wiring** (flag-gated, flag off) — task §5, including the deferred-handler passthrough rewrite (§5.12a–j) and the cache_control sanitizer invariant (§5.13).
5. **Observability** — cache-trace `mode` tag, runtime lifecycle events, pending-execution counters (§7).
6. **OpenCode enable** — flip flag for OpenCode first (§8). Pass criteria: ≥ 95 % non-first-turn cache hits; ≤ 0.5 pp error-rate regression.
7. **Pi enable** (§9.1), then ForgeCode, Crush, Droid, passthrough (§9.2–§9.5) one at a time with the same pass criteria.
8. **Default flip** — `persistentSessions: true` after all six adapters green for two weeks (§9.6) and E2E green (§10.6).
9. **Rollback** — feature flag off at any stage returns to today's behavior instantly. No data migrations, no incompatible state.

## Open Questions (all resolved)

- **Q1 — terminal event:** `SDKResultMessage` (`type === "result"`) is reliable and fires once per logical turn. *Resolved by §1 spike.*
- **Q2 — options drift rate:** gate waived; will be measured post-rollout. *Non-blocking.*
- **Q3 — passthrough MCP in-place updates:** obsolete question. The new deferred-handler design (§D11) replaces the MCP wholesale on tool-surface change; no in-place update required. *Resolved by §1d spike.*
- **Q4 — subprocess crash reattach path:** iterator throw is the canonical signal (wired via `onCrash`); stderr pattern match is not needed. *Resolved in §3 module skeleton.*
- **Q5 — concurrent-turn queueing:** serialize behind the per-session mutex with a 30 s wait cap; 429 on overflow. *Covered by §5.10 integration test and verified live (scenario M: HTTP 429 + Retry-After: 2).*
- **Q6 — fork semantics for live queries:** forks go through close+cold-reattach with `forkSession: true, resumeSessionAt`. Equivalence with today's behavior verified in §5.11 integration test.

## 2026-04-19 late-day addendum — live-validation findings

These additions supplement the original design decisions above based on what we learned executing the refactor end-to-end against real Pi + Claude Max. Full evidence in [[Persistent-Mode Live Validation Results (2026-04-19)]].

### D13. Profile-session-id fingerprint fallback for headerless adapters

**Problem:** The original design assumed `profileSessionId` would always be derivable from an agent-provided session header (e.g. `x-opencode-session`). Pi's adapter returns `undefined` from `getSessionId()` by design — Pi uses fingerprint-based session continuity instead. Without a fix, `turnRunner.startTurn`'s guard (`profileSessionId is a non-empty string`) forces every Pi request into the legacy path regardless of the feature flag.

**Decision:** when `adapter.getSessionId(c)` returns undefined, server.ts derives the persistent-runtime key from `getConversationFingerprint(messages, cwd)` prefixed with `fp:` (or `<profile>:fp:<fingerprint>` when a non-default profile is active). The key is stable across HTTP turns for the same conversation because the fingerprint is derived from the first user message + cwd, both of which are invariant across a session.

**Consequence:** persistent mode works for Pi, ForgeCode, and any future headerless adapter without each adapter needing to implement a synthetic session-id generator. The fingerprint is already computed by `session/cache.ts` for lineage lookup, so we're not adding compute cost.

### D14. maxTurns must be unbounded in persistent mode

**Problem:** The SDK's `Options.maxTurns` applies to the query's entire lifetime, not per HTTP turn. `query.ts:buildQueryOptions` always sets `maxTurns` (3 for passthrough+resume, 2 for passthrough, 200 otherwise). In persistent mode one query serves many HTTP turns, so any finite cap would silently truncate the runtime after that many SDK-internal turns across ALL HTTP requests — a runtime capped at 3 dies after the first tool-use round-trip.

**Decision:** `turnRunner.runPersistent` strips `maxTurns` from the built options before passing to `sdkQuery(...)`. The SDK's own internal default (unbounded in current versions) applies.

**Consequence:** per-HTTP-turn cost is bounded by (a) client usage patterns, (b) `persistentPendingExecutionTimeoutMs` for stuck passthrough tools, (c) Anthropic's `maxBudgetUsd` + rate limits, and (d) `persistentSessionMutexWaitMs` for mutex contention. `error_max_turns` is impossible from the persistent path.

### D15. SSE continuation framing for multi-tool parallel (PARTIAL)

**Problem:** Persistent mode splits ONE SDK message across TWO HTTP responses:
- Request 1 emits tool_use blocks and synthesizes a tool_use pause result.
- Request 2 resolves the pending handlers; SDK resumes emitting events for the SAME in-flight assistant message.

The continuation's first events are mid-message `content_block_*` (typically `input_json_delta` closing the pre-pause tool_use block) with no preceding `message_start`. Strict SSE clients (Pi) reject the frame order with `Unexpected event order, got content_block_delta before "message_start"`.

**Decision:** Introduce a `WeakMap<SessionRuntime, boolean>` continuation flag set by `turnRunner` when yielding the pending-pause synthetic result in streaming mode (`markRuntimeContinuation`). Server.ts's streaming layer reads the flag at the start of each turn (`consumeRuntimeContinuation`) and, when set:
1. On the first SDK stream event, if it's NOT a `message_start`, synthesize a conformant `message_start` frame (fresh UUID, request's model, empty content, zero usage) and reset block-index remapping to 0.
2. Drop the trailing `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` events from the pre-pause message — they reference blocks known only to the prior HTTP response.

**Result:** Pi no longer crashes on parallel-tool streaming. The response is now well-formed SSE (synthetic `message_start` → drops → final `message_stop`).

### D16. Layer 2 open: SDK doesn't auto-continue after pending-resolve when message plans no prose

**Problem (discovered live after D15 landed):** With the SSE crash fixed, the continuation response is well-formed but EMPTY. The model's planned response text never arrives.

**Root cause:** The §D11 design assumed the SDK auto-continues generating after handler resolution. In practice, when the model plans its message to close at tool_use (common when the user prompt says "emit tool calls... THEN reply with X" and the model treats that as two distinct messages), the SDK closes `message_stop` after the tool_use and awaits a NEW user message before generating again. The dispatcher resolves pending handlers without pushing any user content (tool_results were diverted to handler-resolves), so the SDK has no trigger for the response turn.

**Single-tool scenarios (C, D, G) don't hit this** because when the model plans a single tool_use followed by text, it keeps the message open (no `message_stop` after tool_use) and handler-resolve naturally continues into text generation within the same message.

**Tried (reverted):** push an empty user message `[{ type: "text", text: "" }]` after resolve to trigger the next turn. SDK accepted the push but produced no output — empty content is probably rejected by Anthropic or treated as a no-op.

**Fix-plan options for follow-up (not in this change):**
- **Option A:** dispatcher-level state machine detects "model closed message at tool_use" shape and pushes a minimal valid text trigger (e.g. `"continue"`). Costs a small semantic blot in history.
- **Option B:** hybrid push+resolve — push tool_result blocks as a user message AND resolve pending handlers. Anthropic sees tool_results as user messages, SDK's handler-return aligns. Potential conversation-state divergence risk.
- **Option C:** fall back to the non-persistent legacy path for parallel-tool streaming. No cache hit on those turns but correctness preserved.

**Non-blocking for rollout.** Single-tool scenarios pass with cache 93-98%. Non-streaming requests (any adapter using `stream: false`) are unaffected. Documented inline in `src/proxy/session/turnRunner.ts` and `src/proxy/session/persistentDispatch.ts`, and in [[Persistent-Mode Live Validation Results (2026-04-19)]] §"E/F two-layer bug".

### D17. SIGTERM/SIGINT graceful-shutdown handler required

**Problem:** The original design's §6.1 said `ProxyInstance.close()` closes all live runtimes and rejects pending handlers. But `ProxyInstance.close()` is a programmatic API — without a signal handler, SIGTERM kills the Node process immediately, skipping the close path. Persistent runtimes' SDK subprocesses get reaped by parent-death rather than a clean `Query.close()`, lifecycle events never emit, and pending handlers never reject.

**Decision:** `bin/cli.ts` installs SIGTERM + SIGINT handlers that await `proxy.close()` before `process.exit(0)`. Emits `[meridian] received SIGTERM, closing gracefully` to stderr; `persistent.lifecycle { lifecycle: "close", ... }` fires for each runtime.

**Verified live (scenario N):** signal → graceful close → process exit within ~1 s, no leaked subprocesses.
