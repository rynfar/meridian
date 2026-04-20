## Why

Meridian today spawns a fresh `query({ resume })` on every incoming HTTP request. The Agent SDK's `resume` path reads the session `.jsonl` from disk, parses it, rebuilds in-memory message objects, and re-serializes them for the Anthropic request. That second serialization is not byte-identical to the live-memory serialization from the prior turn, so prompt-cache prefix matching fails on resumed turns — observed as `cacheReadInputTokens=0, cacheCreationInputTokens≈3637` on turn 2, despite only a trailing `tool_result` differing. The SDK is designed to be driven as a long-lived process with one `query()` per logical session and an AsyncIterable input queue; `resume` is a recovery mechanism, not the hot path. Using the SDK against its grain is what's costing us the cache.

Six exploratory spikes (see `spike-notes.md`) have validated the core hypothesis across plain text, SDK-executed tools (single + parallel), live Pi non-passthrough, and deferred-handler passthrough: persistent streaming-input mode consistently hits the prompt cache on turn 2+ across every shape tested.

## What Changes

- Introduce a `SessionRuntime` that owns one live `query()` per logical session, with a single-writer AsyncIterable input queue and a per-session mutex.
- Route every turn for a given session through the same `SessionRuntime` instead of calling `query({ resume })` per request.
- Detect per-turn boundaries from the SDK's `SDKResultMessage` event (confirmed by spike).
- Strip `cache_control` from every user content object pushed into a runtime's input queue — Anthropic caps cache_control blocks at 4 per request, and clients like Pi attach them to every turn (design §D10).
- Replace passthrough tool execution's PreToolUse-block mechanism with a **deferred MCP handler** pattern: the passthrough MCP tool handler returns a promise that the runtime resolves when the client sends the real tool_result (design §D11). This preserves byte-clean SDK conversation state across tool boundaries and was the only pattern that passed both correctness and cache in spike scenarios.
- Add an options-drift hash; turns that change `cwd`, `systemPrompt`, `mcpServers`, `allowedTools`, or the tool surface force `close()` + cold-reattach. `model` and `effort/thinking` are applied in place via `setModel`/`applyFlagSettings`.
- Cold-start reattach: when a session exists in `sessionStore` but not in the in-memory live-query map, start `query({ prompt: queue, resume: claudeSessionId })` and hold it alive. The reattach turn may miss cache; subsequent turns hit.
- Undo / fork requests always `close()` the current runtime and open a new one with `forkSession: true, resumeSessionAt`.
- LRU eviction on the live-query map (default 15 min idle timeout, 32 concurrent live queries); `query.close()` on evict. Session stays resumable from disk.
- Feature flag `ProxyConfig.persistentSessions`, default `false`. Rollout order: OpenCode first (isolates cache variable — its tool shape matches the already-proven SDK-executed-tool scenarios), then Pi (which adds the client-executed-tool pairing via deferred handlers), then ForgeCode/Crush/Droid/passthrough.
- Integration-test helper for a mocked `Query` implementing the control surface.

## Capabilities

### New Capabilities

- `sdk-session-runtime`: Owns the lifecycle of a single live `query()` per logical session — construction, input-queue writes, per-turn boundary detection, control-method application, close + cold-reattach, LRU eviction, crash recovery, and the deferred-handler registry for passthrough tool execution. This is the new primitive the server calls into for every turn.

### Modified Capabilities

_None._ This change is purely additive behind a feature flag; the existing `session/cache.ts` + `sessionStore.ts` + `query.ts` + adapter + HTTP contract are preserved. The flag-off path is today's behavior unchanged.

## Impact

- **Code:** new module `src/proxy/session/runtime.ts` (shipped) housing `SessionRuntime`, `SessionRuntimeManager`, `AsyncQueue`, `Mutex`, `hashReopenCriticalOptions`, `isTurnTerminator`, `markRuntimeContinuation`/`consumeRuntimeContinuation`. New `src/proxy/session/optionsClassifier.ts`, `session/persistentDispatch.ts`, `session/persistentWiring.ts`, `session/turnRunner.ts`. `src/proxy/contentSanitizer.ts` for §D10 `stripCacheControl`. `src/proxy/passthroughConstants.ts` for shared MCP naming. `src/proxy/passthroughTools.ts` extended with `PassthroughDeferredMode` for the §D11 deferred-handler pattern. `src/proxy/server.ts` wires `startTurn(...)` at the 4 query() call sites with fingerprint fallback for headerless adapters (Pi), plus a runtime-manager singleton, periodic sweeper, `MutexAcquireTimeoutError → HTTP 429 + Retry-After`, and §5.12d SSE continuation-framing injection. `bin/cli.ts` wires env vars + SIGTERM/SIGINT graceful-shutdown handler.
- **APIs:** no external breaking changes. `startProxyServer`, `ProxyInstance`, `POST /v1/messages`, `x-opencode-session`, `x-meridian-profile`, `GET /health`, `GET /profiles/list`, `POST /profiles/active` all preserved. `AgentAdapter` gains `usesPersistentSessions?(): boolean | undefined` (optional; adapter-scoped override of the global flag). `ProxyServer` gains optional `cleanup(): Promise<void>` hook. `ProxyConfig` gains `persistentSessions?: boolean` (additive, default false), `persistentSessionIdleMs?: number` (15 min), `persistentSessionMaxLive?: number` (32), `persistentSessionMutexWaitMs?: number` (30 s), `persistentPendingExecutionTimeoutMs?: number` (15 min). New env vars: `MERIDIAN_PERSISTENT_SESSIONS`, `MERIDIAN_PERSISTENT_IDLE_MS`, `MERIDIAN_PERSISTENT_MAX_LIVE`, `MERIDIAN_PERSISTENT_MUTEX_WAIT_MS`, `MERIDIAN_PERSISTENT_PENDING_TIMEOUT_MS`.
- **SDK options:** `turnRunner.runPersistent` **strips `maxTurns` entirely** so the SDK applies its own unbounded default. A per-query cap would truncate the runtime's entire lifetime across all HTTP turns it serves (one query serves many HTTP requests in persistent mode). Per-HTTP-turn cost is still bounded by the client's usage patterns, `persistentPendingExecutionTimeoutMs`, Anthropic's `maxBudgetUsd`, and rate limits.
- **Dependencies:** no new runtime deps. Uses existing SDK control methods (`setModel`, `applyFlagSettings`, `close`) and streaming-input mode.
- **Session lifecycle:** Meridian becomes more stateful — process holds N live Claude subprocesses, one per active session. Memory bounded by hard cap; eviction + cold-reattach preserve correctness. Graceful shutdown closes all live queries and rejects all pending deferred-handler promises within 10 s, driven by a SIGTERM/SIGINT handler in the CLI.
- **Testing:** 1386 unit + integration tests pass (89 → 91 test files after `turn-runner-integration.test.ts`, `persistent-dispatch-unit.test.ts` extensions, `persistent-lifecycle-integration.test.ts`). Flag-off tests preserved byte-identical behavior.
- **Observability:** `claudeLog("persistent.turn", { mode, profileSessionId, optionsHashReopenCritical, stream })` per turn; `claudeLog("persistent.lifecycle", { lifecycle: create|reattach|reopen|evict|close|crash-recover, profileSessionId })`; `claudeLog("persistent.continuation_message_start"|"continuation_skip", ...)` for §5.12d framing events; `SessionRuntimeManager.counters` for `live/creates/evictions/reopens/crashRecovers` snapshot.
- **De-risked:** six spikes plus 70+ unit tests + **10 of 14 live-validation scenarios passing** against real Pi + Claude Max with cache-hit at 93-98% on resumed turns. Known limitation: multi-tool parallel passthrough streaming hits a layer-2 empty-response issue where the SDK doesn't auto-continue after pending-resolve (model-plan-dependent); three fix-plan options documented for follow-up. Single-tool and non-streaming paths are fully production-ready.
