# PR #1220: independent session store review

## Scope and reviewed revisions

- PR head reviewed: `bb2e18a3f8362d1a2b3a3529cd50007361bc070b`.
- Compared the complete production diff against `origin/main`: `sessionStore.ts`, `session/cache.ts`, `session/storeMutationResult.ts`, `sessionLifecycle.ts`, `server.ts`, the three bookkeeping backend files, and the three modified E2E scripts.
- Read local `AGENTS.md`, `ARCHITECTURE.md`, session `SPEC.md`, evidence skill, validation commands and relevant affected E2E sections.
- Initial review was read-only. Parent subsequently authorized the minimal fix and regression tests in **only** `src/proxy/session/cache.ts` and `src/__tests__/session-cache-coherence.test.ts`. No commits, pushes, comments, merges or live-model calls were made by this worker.

## Findings

### P3 — successful JSON eviction could retain a local fallback repopulated during its asynchronous write — FIXED locally

Original locations: `src/proxy/session/cache.ts:219-227` and `240-245`, especially the SQL-only post-commit invalidation at lines 225 and 243.

JSON eviction deleted local memory immediately, then yielded for the ordered durable mutation. An overlapping `lookupSession()` could still find the old durable mapping and repopulate the LRU. On successful durable eviction, only SQL ran the final cache invalidation. A later genuine store read error then exposed that stale JSON LRU entry as a continuation of the SDK session that eviction had removed.

Reproduction requires no artificial disk delay: create mapping; call `evictSession()` without awaiting; call `lookupSession()`; await successful eviction; confirm durable absence; corrupt only the isolated fixture store; call `lookupSession()` again. Original PR head returns `continuation` for both header-keyed and fingerprint-keyed cases. Unchanged baseline returns `diverged/not-found`.

**Impact limit:** this proves a cache/fallback contract regression, not an unsafe current HTTP resume. `server.ts:3368-3373` independently rejects a durable read error before reaching `lookupSession()`, without yielding between those operations. Do not describe this probe as proof that a corrupt-store HTTP request resumes stale history.

Authorized fix preserves JSON's immediate invalidation and runs the existing epoch-fenced post-commit invalidation for **both** backends. The epoch remains captured at invocation. SQL's synchronous COMMIT behavior is unchanged. Later queued publications retain their state; there are keyed/fingerprint positive controls for that order.

New tests: `session-cache-coherence.test.ts`, two parameterized cases each for overlapping-read eviction and a write started after eviction. The parent's separate correction removing accidental pre-awaits in the first three existing cases was retained.

Discrimination: a shadow module tree containing original PR `cache.ts` and the new test file has exactly **2 failures, 12 passes** (the keyed/fingerprint eviction regressions). Fixed checkout has **14/14 JSON** and **14/14 SQLite**. The standalone before/after probe also changes from stale continuation to not-found on both key types.

### P3 — stale synchronous-cost description in architecture — reported to parent

`ARCHITECTURE.md:846` (“Session store write cost”) still says all `sessionStore.ts` mutations are synchronous and run on the event loop. That contradicts the new asynchronous JSON contract at lines 552 onward. The wording should distinguish still-synchronous read/parse/serialization CPU work from asynchronous durable I/O. No doc edit was made by this worker.

## Other inspected areas: no further concrete regression established

- Lock candidate metadata is written, fsynced and closed before atomic no-replace hard-link publication. Retries yield. Stale-incarnation recovery and offline legacy maintenance remain fail-closed. The per-path queue preserves invocation order and continues after rejection.
- JSON inputs that outlive invocation are copied before the first yield. Store drafts preserve exact generation CAS and immutable cached entries. Temporary-file sync/close precede rename, and authority is rechecked immediately before dispatching rename. Parent-directory flush remains legacy best-effort, not a newly strengthened guarantee.
- Request-local durable ordering serializes publication/finalization with cancellation settlement. JSON publication flags are set before request cancellation can inspect the completed mutation. SQL flags stay after the outer awaited COMMIT. Stream completion joins newly queued durable work and rollback retirements before releasing its turn.
- Cache clear fences older hooks by invocation epoch and clears again inside its durable commit boundary, not a later continuation that could erase a subsequent writer. Priority publication metadata still follows the store commit even if cache clear supersedes its local LRU hook.
- `markSessionInterrupted()` already deletes the resumable cache and writes its interrupted record **after** the store mutation resolves for both backends; it does not share the fixed SQL-only invalidation gap. Store, rollback and clear likewise already apply their replacement/reset effect at completion. Other durable evictions flow through the corrected `evictSession()`.
- Native SQL mutations retain synchronous results in admitted scopes. `mapStoreMutation()` invokes their continuation immediately; lifecycle publication still uses the existing transaction thenable rejection rather than awaiting inside SQL. False/throw/COMMIT-fault paths and exact route/mapping rollback stay covered by focused tests.

## Verification and limits

Executed in the target repository with its Bun environment:

- Locking, store mutation baseline, loop-lag and cache coherence (initial head): **34 passes**. The combined invocation additionally attempted SQLite cache publication, which correctly refused local bundled SQLite 3.51.0; its 58 initialization failures were environmental, not a regression finding.
- Repeated SQL verification with `MERIDIAN_TEST_SQLITE_LIBRARY=/opt/homebrew/opt/sqlite/lib/libsqlite3.3.53.4.dylib`: bookkeeping cache publication, server admission inventory and cache-clear completion: **83 passes**.
- Request cancellation, priority client cancellation and priority session store: **45 passes**.
- Post-fix `session-cache-coherence.test.ts`: **14 passes JSON**; **14 passes SQLite** with patched library and `BOOKKEEPING_TEST_STORE_BACKEND=sqlite`.
- New regression negative control: **12 passes, 2 expected failures** using the original PR cache source.
- `git diff --check`: passes after the worker changes.

No final full-suite/typecheck/build rerun was claimed by this worker; parent owns those final-head gates. No live client, SDK or model execution occurred. In particular, these mocked/file-store tests do **not** causally resolve #1220's original live Opus cache-prefix discrepancy or replace the unchanged E41 acceptance threshold.

## Evidence

Escrow directory: `/Volumes/DevSSD/meridian/evidence/review-1220-20261103/`.

- `eviction-fallback-probe.mjs` — same headless fixture probe for original, baseline and corrected source.
- `eviction-fallback-head.log`, `eviction-fallback-baseline.log`, `eviction-fallback-fixed.log`.
- `eviction-fallback-negative-tests.log` — exact two regression failures with original cache source; `eviction-negative-control/` is the local shadow module tree.
- `eviction-fallback-json-tests.log`, `eviction-fallback-sql-tests.log`.
- `eviction-fallback-local-fix.patch` (includes the parent's preserved correction in the same test file).
- `store-review-focused-initial.log`, `store-review-focused-sql-patched.log`, `store-review-cancellation-focused.log`.

Assumptions: JSON is the default store path; SQLite tests explicitly select the existing test fixture backend. No production constants, timeouts, limits, dependencies or public interfaces were changed by this worker.
