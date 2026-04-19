## 1. Spike (gating prerequisite)

- [x] 1.1 Create `spike/persistent-demo.ts` — standalone script, no server imports, ~100 lines
- [x] 1.2 Script opens one `query({ prompt: inputQueue, options })` with options matching a typical Pi passthrough session (model, systemPrompt, cwd, MCP, allowedTools)
- [x] 1.3 Script pushes a user message, reads the per-turn terminator (identify the terminal event type empirically; log every event type observed)
- [x] 1.4 Script pushes a second user message, reads the per-turn terminator
- [x] 1.5 Script captures `cacheCreationInputTokens` and `cacheReadInputTokens` for each turn
- [x] 1.6 Script closes the query cleanly
- [x] 1.7 Run spike against real Claude Max credentials
- [x] 1.8 Record results in `openspec/changes/persistent-sdk-sessions/spike-notes.md`: terminal event name, per-turn cache metrics, event-stream transcript
- [x] 1.9 Pass criterion: turn 2 shows `cacheReadInputTokens > 0`. On failure, stop and revisit the design before any further work.
- [x] 1.10 Document the observed per-turn terminator name in spike-notes so subsequent tasks can reference it concretely

## 1b. Extended spike — tool-use turn shapes

The base spike (section 1) proved streaming-input mode caches across plain `user → assistant(text)` turns. Real Pi passthrough traffic is tool-heavy; this section proves the cache survives tool-use turns before committing to the server refactor.

- [x] 1b.1 Extend `spike/persistent-demo.ts` with a reusable `runScenario(name, opts, turns)` helper that spins up one live streaming-input `query()` and runs N turns against it
- [x] 1b.2 Scenario B — single tool roundtrip: register one in-process MCP tool via `createSdkMcpServer`, prompt the model to use it on turn 1, let the SDK execute it, push an unrelated follow-up prompt on turn 2, measure cache
- [x] 1b.3 Scenario C — multi-tool roundtrip: register two tools, prompt the model to use both in parallel on turn 1, follow up on turn 2, measure cache
- [x] 1b.4 Pass criterion for B and C: turn-2 `cacheReadInputTokens > 0` *after* the tool-using turn 1. Record per-scenario metrics in `spike-notes.md` *(B turn-2 cacheRead=14133; C turn-2 cacheRead=14522)*
- [x] 1b.5 Document any observed SDK quirks (event sequence around tool_use, number of `result` events per turn, `stop_reason` values) so downstream tasks can rely on them
- [x] 1b.6 Note the explicit gap: the spike tests SDK-executed tools. The true Pi passthrough path (client executes, pushes `user(tool_result)` into the input queue between turns) is validated later via integration tests once the server refactor lands — call this out in spike-notes.md so the gap is tracked

## 1c. Pi live spike (throwaway) — real Pi → meridian → persistent SDK

Closes the real-world gap left by the synthetic spike in §1b. Proves that a live Pi CLI session using real client-executed tools hits the prompt cache on turn 2 when routed through a persistent SessionRuntime. The implementation is intentionally throwaway — no LRU, no options-drift handling, no undo/fork, no cold-reattach. Single hardcoded session. Discarded once cache metrics are recorded.

- [x] 1c.1 On a spike branch, patch `server.ts` minimally: when env `MERIDIAN_PI_LIVE_SPIKE=1` is set, route Pi-adapter requests through a singleton `SessionRuntime` (find-or-create by `profileSessionId`, push user message, consume `runtime.consumeTurn()` in place of `query(buildQueryOptions(...))` in the existing SSE pipeline, do NOT close the runtime after the turn)
- [x] 1c.2 Run meridian with the spike patch (non-passthrough mode; passthrough-mode interaction surfaced a turn-2-suppression gotcha captured in design §D11 and task §5.12)
- [x] 1c.3 Run a live Pi session with two turns; measure cache
- [x] 1c.4 Pass criterion: turn-2 `cacheReadInputTokens > 0` on a Pi multi-turn session — **ACHIEVED**: T2 cacheRead=10122, cacheCreate=157, cache=98%. Client-executed tool round-trip deferred to task §5.12 live integration (gotcha surfaced; design updated)
- [x] 1c.5 Record results in `spike-notes.md` §"Pi live spike" — done
- [x] 1c.6 Revert the spike patch from `src/proxy/server.ts` — done. `git status` clean on server.ts; unit tests still pass; full typecheck passes. Group 5 re-implements the wiring properly using the deferred-handler pattern from §1d.

## 1d. Pi passthrough tool-integrity design spike (blocker for §5.12)

The §1c extension into passthrough + tool_use proved that draining SDK events in the background is insufficient: the SDK generates synthetic "tool was blocked" content that enters the runtime's conversation and corrupts the model's view when the real client-produced `tool_result` arrives. See `spike-notes.md` §"Pi live spike — passthrough + tool_use extension (negative result)".

This task produces a working end-to-end flow (even crudely) before §5.12 can be written concretely.

- [x] 1d.1 Audit SDK `Query.interrupt()` semantics in streaming-input mode — **Result:** interrupt() cleanly terminates turn-2 generation but leaves the session in a "user-stopped-me" state. Subsequent pushes produce "I've stopped. How would you like to proceed?" instead of resuming on the pushed tool_result. Interrupt is NOT the right semantic.
- [x] 1d.2 Experiment with alternative PreToolUse hook return shapes — **Result:** any hook return that fabricates a synthetic tool_result (including `{decision: "block"}`) pollutes the SDK's in-memory conversation with "blocked by hook" narrative that confuses subsequent turns. PreToolUse is not the right interception point.
- [x] 1d.3 Experiment: no PreToolUse hook; MCP handler returns sentinel — **Result:** works (Scenario B, correctness+cache PASS) but requires a follow-up "override" user message telling the model the sentinel was bogus. Leaks sentinel strings into conversation history. Usable but inelegant.
- [x] 1d.4 Prototype deferred MCP handler pattern (Scenario D) — MCP handler creates a pending promise entry per tool_use id, returns the promise, SDK blocks. Meridian resolves the promise with real tool_result content on the client's next HTTP request. **Result: correctness PASS, cache PASS (T2 cacheRead=14070), SDK in-memory state is byte-clean.** This is the winning approach.
- [x] 1d.5 Pick winning approach — **Scenario D (deferred MCP handler)**. Documented in spike-notes.md §"§1d — Passthrough tool-integrity design spike results".
- [x] 1d.6 Capture approach + trade-offs in design.md §D11 (rewritten) — done.
- [x] 1d.7 Extend spike for multi-tool — **Scenario E PASS**: SDK invokes handlers sequentially (even when model emits them in one turn); each blocks until resolved; final response correctly combines results. T1 cacheRead=42019, T2 cacheRead=14676.
- [x] 1d.8 Test deferred-handler rejection — **Scenario F PASS (runtime recovery)**: handler reject with error; SDK fabricates error tool_result, model continues, runtime stays healthy for subsequent turns (T2 cacheRead=14071). Rejection is a safe mechanism for idle-timeout enforcement.

## 2. Options-drift observability (optional, parallel-safe, gates task 5 kickoff)

Before committing to D4's in-place-vs-reopen policy, measure how often real traffic triggers reopens. High drift would invalidate D4.

- [ ] 2.1 Extend cache-trace emission (gated, log-only) to record `optionsHashReopenCritical` per turn using the fields listed in design.md D4
- [ ] 2.2 Run for one week against real traffic; confirm reopen-critical drift rate < 10 %
- [ ] 2.3 If drift > 10 %, revisit D4 in design.md before proceeding to task 5

**Gate:** Task 5 kickoff is gated on §2.2 completing with pass criterion met (drift rate < 10 %), or on an explicit decision recorded in design.md acknowledging the observed drift rate and accepting the reopen churn as the cost of correctness.

**Waiver (2026-04-19):** Gate §2.2 is **explicitly waived**. This is a solo-dev environment without the traffic volume to make a one-week observability pass meaningful. We accept the risk that D4's reopen policy may churn more than predicted in production and commit to tuning it after live Pi-passthrough observations in task §9.1. §2.1–§2.3 remain as backlog items rather than blockers.

## 3. Module skeleton — `SessionRuntime`

- [x] 3.1 Add `src/proxy/session/runtime.ts` with the `SessionRuntime` type and a `SessionRuntimeManager` that owns the live-query `Map<profileSessionId, SessionRuntime>`
- [x] 3.2 Implement per-session `Mutex` primitive (or reuse an existing one if available)
- [x] 3.3 Implement `AsyncQueue<SDKUserMessage>` single-writer iterable
- [x] 3.4 Implement `optionsHashReopenCritical(options)` using stable JSON stringify + SHA-256 truncated to 16 chars
- [x] 3.5 Implement `SessionRuntime.create(opts)` — starts `query()`, stores options hash, records activity
- [x] 3.6 Implement `SessionRuntime.pushTurn(userMessage, perTurnOptions)` — primitives are shipped (`acquireTurn()` + `consumeTurn()` + `inputQueue.push()`); the server-side composer that applies `setModel` / `applyFlagSettings` before pushing lives in task 5.5 to keep adapter-aware options plumbing in `server.ts`
- [x] 3.7 Implement per-turn boundary detection using the terminator identified in task 1.10; expose it as a helper (`isTurnTerminator` / `TURN_TERMINATOR_EVENT`)
- [x] 3.8 Implement `SessionRuntime.close()` — calls `liveQuery.close()`, awaits subprocess teardown, removes from manager
- [x] 3.9 Implement LRU eviction (`persistentSessionIdleMs` default 15 min, `persistentSessionMaxLive` default 32) — LRU in the manager; periodic timer wiring lives in `server.ts`, task 6.2
- [x] 3.10 Implement crash detection — iterator `throw` on the query triggers manager cleanup of that runtime (`onCrash` callback on runtime init; caller drops the runtime from the manager on error)
- [x] 3.11 Unit tests: mutex serialization, AsyncQueue single-writer safety, options-hash stability, LRU ordering *(23 tests in `session-runtime-unit.test.ts`, all passing)*
- [ ] 3.12 `sweepIdle()` skips runtimes whose mutex is currently held (resolve sweep-vs-mutex race from the plan review) — extend the Mutex API to expose `locked`, have the sweeper check it, and unit-test the interleaving
- [ ] 3.13 `AsyncQueue.push` backpressure — add a configurable high-water mark (default 1024) and emit a telemetry counter `persistent_input_queue_depth` (wired in task 7.3). Optionally reject pushes above a hard cap with a typed error so the server handler can 503
- [x] 3.14 ~~Audit `createPassthroughMcpServer` for in-place tool-surface update support~~ — **Superseded by §5.12.** The §1d spike established that `passthroughTools.ts` must be rewritten around the deferred-handler pattern per design §D11. The old question ("does it support in-place updates?") no longer applies; the new MCP server is constructed per-runtime and tool-surface changes are reopen-required (see §5.12a–§5.12b).

### 3.x Fix-ups surfaced by 2026-04-19 code review

These are specific, scoped issues the review agent flagged in the shipped code. Each is small enough to land without server.ts surgery.

- [ ] 3.15 Fix `classifyPassthroughRequest` to handle non-array object content correctly. Today (`runtime.ts:208`) a non-array, non-undefined input returns `{resolve: [], pushContent: []}` — silently losing the payload. Real clients always send arrays so production risk is low, but the function lies about handling it. Fix: wrap the single object in `[content]` for `pushContent`, or throw a typed error for invalid shape. Add a unit test covering object-not-array input.
- [ ] 3.16 Consolidate `PASSTHROUGH_MCP_PREFIX`. `persistentWiring.ts:218` has a local copy ("Kept in sync with that module" comment) to avoid a circular import from `passthroughTools.ts`. Silent drift hazard. Extract the constant into a leaf module (`src/proxy/session/passthroughConstants.ts` or equivalent) that both files import.
- [ ] 3.17 Document / enforce the `attachDispatchState` contract. The dispatcher (`persistentDispatch.ts:171`) silently no-ops if `getDispatchState(runtime)` returns undefined — meaning drift detection never fires when a future factory author forgets to attach. Either (a) add a dispatch-layer sanity assert on first touch of a runtime, or (b) move `attachDispatchState` inside `dispatchPersistentTurn`'s cold-reattach/create path. Prefer (b) — keeps the contract in one place.
- [ ] 3.18 Make `PersistentWiringDeps` explicit about passthrough binding. Today `buildPassthroughBinding` at `persistentWiring.ts:161` is a `throw`-stub ("server.ts must override"). That's a runtime crash if anyone sets `getPassthroughSpec` to return non-null without also replacing the stub. Fix: add an optional `buildPassthroughBinding: (spec, runtimeRef) => PassthroughMcpBinding` field to `PersistentWiringDeps` and remove the module-level stub. Type-system forces the caller to provide it when passthrough is on.
- [ ] 3.19 Minor hygiene: make `SessionRuntimeInit.optionsHash` optional (the dispatcher uses `attachDispatchState` instead, making the field dead), add an error handler around `LRUMap.onEvict`'s fire-and-forget `close()` (`runtime.ts:443`) so a throwing close doesn't unhandled-reject.

## 4. Mocked `Query` test helper

- [x] 4.1 Add `src/__tests__/helpers/mockQuery.ts` exporting `createMockQuery({ turns })`
- [x] 4.2 Mock emits the empirical per-turn event sequence: leading `system(init)` (suppressable), arbitrary mid-turn events (assistant / stream_event / rate_limit_event / synthetic user for tool-result replay), synthesized `result` terminator with configurable usage/stop_reason/num_turns/subtype. Consumes one `SDKUserMessage` per turn from the input queue.
- [x] 4.3 Mock implements `close()`, `setModel()`, `applyFlagSettings()`, `interrupt()`, `getContextUsage()`, `streamInput()`, `stopTask()`, plus every other Query control method as programmable stubs. Every call is recorded on a `MockQueryControlCalls` object tests can inspect for ordering assertions. Includes `crashOnTurn` config for simulating mid-session iterator throws.
- [ ] 4.4 Replace inline mocks in existing tests (opt-in) so the helper is exercised — deferred; will land organically as §5.7/§6.3/§5.12h integration tests are authored.
- [x] 4.5 Unit tests for the mock itself (`src/__tests__/mock-query-unit.test.ts`): 11 tests covering event sequence, multi-turn behavior, suppressSystemInit, script-provided result preservation, arbitrary mid-turn events, control-method recording, streamInput integration, crash injection, close-wakes-waiters semantics. All passing.

## 5. Server wiring behind feature flag

- [x] 5.1 Added `persistentSessions`, `persistentSessionIdleMs` (900_000), `persistentSessionMaxLive` (32), `persistentSessionMutexWaitMs` (30_000), `persistentPendingExecutionTimeoutMs` (900_000) to `ProxyConfig` in `types.ts`. Defaults match design (flag off preserves today's behavior bit-identically). Full test suite green (1334 pass, 0 fail).
- [ ] 5.2 Branch the two non-streaming `query()` call sites in `server.ts` (lines ~831 / ~870) to route through `SessionRuntime` when the flag is on and the request is not an undo/fork. The lineage classifier (`session/lineage.ts` → continuation / compaction / undo / diverged) runs unchanged and feeds into the persistent-mode branch exactly as it does today — lineage drives reopen/fork decisions; it is NOT replaced by the runtime. **Acceptance criteria surfaced by the 2026-04-19 review:** (a) server.ts maps lineage classifications to `{ isUndo, undoRollbackUuid }` on the dispatcher request; the dispatcher only accepts a boolean, so the mapping table lives here; (b) server.ts observes `session_id` from the yielded `result` event and calls `storeSession(...)` on first capture so `session/cache.ts` stays consistent with disk; (c) `config.persistentSessionMutexWaitMs` is threaded into `runtime.acquireTurn(timeoutMs)`; mutex timeout must convert to HTTP 429 + `Retry-After` at the handler level (§5.10).
- [ ] 5.3 Branch the two streaming `query()` call sites in `server.ts` (lines ~1252 / ~1288) to route through `SessionRuntime` when the flag is on and the request is not an undo/fork. Same lineage-classifier + storeSession + mutex-timeout invariants as §5.2. **Additional acceptance criterion:** the SSE stream from `runtime.consumeTurn()` must forward tool_use content_blocks AND inject synthetic `stop_reason: "tool_use"` + `message_stop` on detecting a deferred-handler pending registration, without breaking out of the outer for-await (see §5.12d).
- [ ] 5.4 Preserve the existing undo/fork path — it always `close()`s the current runtime (if any) and opens a new one with `forkSession: true, resumeSessionAt`
- [x] 5.5a Options classifier (pure) — shipped in `src/proxy/session/optionsClassifier.ts` as `classifyOptionsDrift(request, snapshot): { reopenCriticalHash, hashMismatch, inPlaceUpdates }` + `snapshotOptions()` helper. Emits `setModel` / `applyFlagSettings` deltas only for keys that actually differ; deep-equals thinking/task-budget objects so identical-by-value inputs don't churn. 9 unit tests covering hash drift, in-place emission, both-changed, idempotent no-op, deep-equal stability.
- [x] 5.5b In-place applier — shipped as `applyInPlaceUpdates` in `src/proxy/session/persistentDispatch.ts`; calls `liveQuery.setModel(...)` and `liveQuery.applyFlagSettings(...)` in order based on the classifier output. Tested via the dispatcher's drift-detection path.
- [x] 5.5c Reopen orchestrator — shipped in `dispatchPersistentTurn`: on `hashMismatch`, calls `manager.drop()` to close the old runtime, then `createRuntime` with the existing `claudeSessionId` or the cache-provided id as `resumeSessionId`, then re-enters the turn on the new runtime without losing the pushed user message. 1 test (`reopens via close+cold-reattach when a reopen-critical option changes`) confirms the carry-forward. **Known issue surfaced by the 2026-04-19 review:** the drift check and reopen happen BEFORE the per-session mutex is acquired (`persistentDispatch.ts:171` vs `:193`). Concurrent requests during a close+reopen can race. Small window, but track as a follow-up: either (a) wrap the whole dispatcher entry in a session-level gate before the drift check, or (b) re-order the dispatcher to `acquireTurn` first and do drift detection under the mutex. Defer until §5.2/§5.3 server wiring is in place and the end-to-end concurrency shape is clearer.
- [x] 5.6 Cold-reattach logic — shipped in `acquireOrCreateRuntime`: when no warm runtime exists, `createRuntime` is called with `resumeSessionIdFromCache` passed through as `resumeSessionId`. The factory (server.ts wiring task) is responsible for wiring `storeSession(profileSessionId, messages, claudeSessionId, ...)` to fire on the first `result` event so session/cache.ts stays consistent with disk state.
- [ ] 5.7 Integration test with mocked `Query` covering: first-turn new, second-turn warm, concurrent turns serialized, reopen on options drift, undo close+reopen, cold-reattach after simulated crash, profile switching (request with `x-meridian-profile: A` creates a runtime keyed by `A:<sid>`; a subsequent request with `x-meridian-profile: B` for the same agent-session id creates a separate runtime keyed by `B:<sid>` without interfering)
- [ ] 5.8 Integration test confirming flag-off behavior is bit-identical to today (run existing session-resume and cache-trace tests with `persistentSessions: false`)
- [x] 5.9 ~~Integration test for Pi-shaped client-executed tool pairing~~ — **Superseded by §5.12h** (integration test covers the deferred-handler pairing flow end-to-end). Options-drift reopen mid-pairing is covered by §5.11 separately.
- [ ] 5.10 Integration test for mutex queue overflow (resolves design Q5): when a runtime has a turn in-flight and a second request for the same session waits longer than `persistentSessionMutexWaitMs` (default 30 s), the second request MUST return HTTP 429 with a `Retry-After` header and MUST NOT corrupt the runtime state
- [ ] 5.11 Integration test for fork-lineage equivalence (resolves design Q6): undo on a warm runtime produces the same forked Claude SDK session id that today's `query({ resume, forkSession: true, resumeSessionAt })` path produces for the same inputs, confirming no lineage drift
- [ ] 5.12 Implement the deferred MCP handler pattern for passthrough (design §D11 rewritten after task §1d; replaces the old drain-in-background plan):
  - [x] 5.12a Add `pendingExecutions` registry to `SessionRuntime` — shipped as `registerPendingExecution()` / `resolvePendingExecution()` / `rejectPendingExecution()` / `rejectAllPending()` / `pendingToolUseIds` / `pendingCount` on the runtime, with auto-reject on `close()`. 7 unit tests in `session-runtime-unit.test.ts`.
  - [x] 5.12b Rewrite `createPassthroughMcpServer` to support the deferred-handler pattern — done. Added `PassthroughDeferredMode` interface and `CreatePassthroughMcpOptions` with an optional `deferredMode` hook pair (`dequeueToolUseId`, `registerPendingExecution`). Extracted `createDeferredPassthroughHandler` as a separately-testable factory. Legacy no-op behavior preserved when `deferredMode` is undefined (flag-off path unchanged). 6 unit tests in `passthrough-deferred-unit.test.ts`. Fork commits `2b62c8c` + `d8dfd5c` verification deferred to §5.12c-f server wiring (not applicable to this layer).
  - [x] 5.12c New PreToolUse hook shape for persistent mode — shipped in `persistentWiring.ts` as `buildHooksBinding(runtimeRef)`. Hook returns `{}` for ToolSearch (SDK internal) and `{}` after enqueueing `input.tool_use_id` into the runtime's per-tool-name FIFO for everything else. Never returns `{decision: "block"}` — that path was proven harmful by §1d Scenario C. 4 unit tests. Server wiring will replace the legacy hook with this binding when `persistentSessions` is on.
  - [ ] 5.12d In the streaming SSE layer, when a tool_use content_block is forwarded, inject `message_delta { stop_reason: "tool_use", stop_sequence: null }` + `message_stop` + close SSE. Do NOT touch the runtime — the SDK stays blocked on the pending handler
  - [ ] 5.12e In incoming-request dispatch, classify request shape: plain user message → `input.push`; user message containing `tool_result` blocks whose `tool_use_id`s match `pendingExecutions` → call `resolve(content)` for each; do NOT push. Unmatched tool_result blocks fall back to plain push
  - [ ] 5.12f Add idle-timeout reject for `pendingExecutions` entries (default 15 min); on reject, SDK handler throw propagates, runtime surfaces error and evicts
  - [ ] 5.12g Graceful shutdown rejects all pending promises before `ProxyInstance.close()` resolves
  - [ ] 5.12h Integration test (supersedes §5.9 original): T1 tool_use emission to client, client returns tool_result, SDK receives as MCP return value, final assistant references real content, T2 cacheRead > 0
  - [ ] 5.12i Integration test for multi-tool parallel: two pending handlers, batched tool_results resolve both, SDK continues
  - [ ] 5.12j Integration test for timeout: pending handler rejected after timeout, runtime is cleaned up cleanly
  - [ ] 5.12l (surfaced by the 2026-04-19 review) Integration test: reopen-during-pending-tool — trigger an options-drift reopen while `pendingExecutions` is non-empty; assert all pending handlers are rejected (via `close() → rejectAllPending`), the new runtime starts clean, the client observes a coherent error on the in-flight tool_use turn, and the next turn after reopen succeeds cleanly. Not covered by any existing unit test; easy to add with the mockQuery harness.
  - [ ] 5.12m (surfaced by the 2026-04-19 review) Integration test: crash-recovery end-to-end via dispatcher — use `mockQuery.crashOnTurn` to simulate mid-session iterator throw; assert the dispatcher catches it, `manager.drop()` cleans up the runtime, and the next `dispatchPersistentTurn` call cold-reattaches via `resumeSessionIdFromCache`. Dispatcher-level coverage does not exist today.
  - [x] 5.12k Unit test for the incoming-request shape classifier — shipped as `classifyPassthroughRequest` in `runtime.ts`, returns `{ resolve: [{toolUseId, content}], pushContent: remainder | null }`. 6 unit tests cover matched/unmatched tool_result, non-tool_result blocks preserved, nested text flattening, plain-string content, and empty pending set.
- [x] 5.13 Cache-control sanitizer invariant — helper shipped in `src/proxy/contentSanitizer.ts` as `stripCacheControl(content)`. **Enforcement:** `buildPushMessage` in the dispatcher (`persistentDispatch.ts`) is the single push site and it ALWAYS calls `stripCacheControl` before constructing the `SDKUserMessage`. So long as server.ts wiring routes through `dispatchPersistentTurn`, the invariant is structurally enforced. 6 unit tests on the helper; integration coverage follows with §5.12h.

## 6. Lifecycle hooks — shutdown, eviction, crash

- [ ] 6.1 `ProxyInstance.close()` iterates the live-query map and awaits `SessionRuntime.close()` for each, with a shutdown timeout (default 10 s)
- [ ] 6.2 Periodic LRU sweep timer starts on `createProxyServer` and is cleared on `ProxyInstance.close()`
- [ ] 6.3 Integration test: start proxy, spin up N mock runtimes, call `close()`, assert map empty and all runtimes' `close()` was called
- [ ] 6.4 Crash-mid-SSE integration test (resolves design Q4): inject a mid-turn query failure while the SSE stream is open; assert the HTTP response closes cleanly with an error, the runtime is removed from the manager, the next request cold-reattaches via `resume`, and the reattach turn emits `mode=persistent cacheReadInputTokens=0` (as expected) while turn after that caches

## 7. Observability

- [ ] 7.1 Cache-trace events include `mode: "persistent" | "resume"` field
- [ ] 7.2 Emit runtime lifecycle events (`create`, `reattach`, `reopen`, `evict`, `close`, `crash-recover`) to the existing trace / log channel
- [ ] 7.3 Add counters to the telemetry store: live runtime count, total creates, evictions, reopens, crash-recovers
- [ ] 7.4 Integration test confirming the trace fields are present and correctly tagged
- [ ] 7.5 Audit `src/plugin/claude-max-headers.ts` and any other plugin code for per-request lifecycle assumptions (persistent mode means one subprocess per session rather than per request — header-mutation plugins may need adjustment). Document persistent-mode semantics for plugin authors in `src/plugin/README.md` or similar; add a plugin-compat smoke test.

## 8. Rollout — OpenCode adapter first

Rationale for OpenCode-first (not Pi-first, which was the original plan): OpenCode's tool shape most closely matches what the spike validated (SDK-executed tools via `createSdkMcpServer`). Pi adds the client-executed-tool pairing risk on top of the cache behavior. Validating the cache win on OpenCode first isolates the cache variable; Pi then tests the pairing extension separately. See design.md §D9 for the full rationale.

- [ ] 8.1 Adapter-scoped flag override: allow enabling persistent mode per-adapter so one adapter can be on while others are off
- [ ] 8.2 Manually flip the OpenCode-adapter flag on a staging instance
- [ ] 8.3 Monitor `mode=persistent` metrics for one week
- [ ] 8.4 Pass criteria (both must hold): (a) ≥ 95 % of non-first-turn OpenCode requests show `cacheReadInputTokens > 0`; (b) OpenCode error-rate regression ≤ 0.5 pp vs. the prior week on `persistentSessions: false`
- [ ] 8.5 If pass, proceed to task 9. If fail, gather evidence and revisit design.

## 9. Rollout — remaining adapters

Same pass criteria as §8.4 apply to each adapter: (a) ≥ 95 % non-first-turn cacheRead hit rate, (b) error-rate regression ≤ 0.5 pp vs. the prior `persistentSessions: false` baseline for that adapter.

- [ ] 9.1 Enable persistent mode for Pi adapter (the driver case; tests the client-executed-tool pairing path under real traffic); monitor one week; pass criteria per above
- [ ] 9.2 Enable persistent mode for ForgeCode adapter; monitor one week; pass criteria per above
- [ ] 9.3 Enable persistent mode for Crush adapter; monitor one week; pass criteria per above
- [ ] 9.4 Enable persistent mode for Droid adapter; monitor one week; pass criteria per above
- [ ] 9.5 Enable persistent mode for generic passthrough adapter; monitor one week; pass criteria per above
- [ ] 9.6 When all six adapters (OpenCode + the five above) are green for two weeks, flip `ProxyConfig.persistentSessions` default to `true`

## 10. Cleanup & archive

- [ ] 10.1 Archive the old cache-miss-on-resume playbook in basic-memory (mark resolved)
- [ ] 10.2 Remove the fork's `structuredUserPrompt` branch if persistent mode supersedes it
- [ ] 10.3 Update `ARCHITECTURE.md` with the new `session/runtime.ts` module and its contract
- [ ] 10.4 Update `CLAUDE.md` with persistent-session guidance for future contributors
- [ ] 10.5 Run `openspec validate --strict` and `openspec archive persistent-sdk-sessions`
- [ ] 10.6 Update `E2E.md` with persistent-mode scenarios (warm turn caches, cold-reattach after restart, undo reopen preserves lineage, Pi client-executed-tool pairing). Run the E2E suite once with `persistentSessions: true` before the default flip (task 9.6).
