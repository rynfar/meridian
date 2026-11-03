# PR #1220 — integration review

## Scope and baseline

- Checkout: `/Volumes/DevSSD/meridian/review-1220-20261103`.
- Reviewed PR head `bb2e18a3f8362d1a2b3a3529cd50007361bc070b` against `origin/main` / merge base `697f9482c23865e9d9a02095e35d79b0922047a7`.
- Read `AGENTS.md`, `ARCHITECTURE.md`, proxy/session module specs, public API contract, and the evidence skill. Inspected the complete changed-file inventory and diff, concentrating server/cache/lifecycle changes and the `a21bf609f` merge resolution.
- Original brief was read-only. Parent subsequently authorized corrections in the locator harness, three session-seeding fixture files, and eight additional test-hook files listed below. No commit, push, GitHub comment, merge, release, dependency change or live-model call was performed.

## Findings

### Fixed: locator no-op harness used asynchronous mutations as synchronous values

`scripts/e2e-session-locator-noop.ts` had four omitted awaits: bootstrap (37), genuine mutation assertion (60), first attachment (73), repeated identical attachment (82). With JSON mutations now queued, its tight synchronous mutation loop observed zero replacements and failed its `20`-replacement control before any mutation could run. The first attachment would also be a Promise rather than the generation required by subsequent CAS assertions.

Correction: await all four mutations. This preserves the original Linux tmpfs preflight, replacement-count control, identical-bytes/generation/inode assertions, fixture sizes and limits. Actual before/after Linux tmpfs verification is recorded in the evidence section below.

### Fixed: fixture setup left now-asynchronous mutations unjoined

Awaited existing setup mutations in:

- `src/__tests__/opencode-agent-context-resume.test.ts`: checkpoint seed and old-writer proof removal.
- `src/__tests__/claude-code-cwd-upgrade.test.ts`: all four session seeds.
- `src/__tests__/proxy-transcript-retention.test.ts`: async `beforeEach`, awaited cache clear, and swept-session seed.

Also joined ignored cleanup promises in existing hooks in `proxy-tool-blocking`, `session-lineage`, `session-fingerprint-context`, `proxy-tool-flattening-regression` (two hooks), `plugin-integration`, `proxy-plugin-message-consumption`, `proxy-structured-output`, and `proxy-cache-keepalive` (converted its hook to async). Existing second clears and clear assertions were retained; no intentional concurrent-mutation test was changed.

These tests often appeared green because the new request-arrival store barrier happened to join the fixture seed. Explicit awaits make setup ownership independent of that server behavior and observe write errors. This is fixture hygiene, not a separately demonstrated production regression. The changed fixtures pass 19/19 focused tests.

### Coverage gap handed to parent: purported pending-write tests awaited too early

New tests in `session-cache-coherence.test.ts` and `store-mutation-loop-lag.test.ts` assigned `const pending/write = (await mutation(...))` before mutating caller-owned inputs or starting cleanup. They therefore did not test the advertised pending-write interleaving. Parent owns the corrected versions and mutation controls, separate from this worker's files.

### Fixed: JSON eviction could leave a resurrected local fallback

The original `cache.ts` JSON `evictSession` invalidated memory synchronously at invocation, then awaited durable eviction, but ran post-commit invalidation only for SQL. A lookup during that wait could repopulate the JSON fallback LRU from the still-present durable record. A later genuine store read error could then fall back to an already-evicted session. Store reviewer corrected both keyed and fingerprint branches to run post-success invalidation on JSON as well as SQL, retaining the cache epoch fence and CAS-success check. Independently inspected the final correction and new keyed/fingerprint stale-fallback reproducer plus later-publication preservation control; no remaining defect found. Independent final `session-cache-coherence` + `bookkeeping-cache-publication` check passes **72/72**; see `eviction-fix-independent-final.log`.

## Server, interrupted turns, lifecycle and public contracts

No additional production missing-await or integration regression was found beyond the corrected eviction race.

- Enumerated runtime call sites for all changed store/cache mutation exports, including aliased `evictCachedSession`, star imports, and lifecycle pruning. Runtime roots either await the operation or return it into the admitted publication transaction; `sessionLifecycle.ts` now awaits JSON pruning.
- `mapStoreMutation` preserves synchronous SQL callback results. SQL cache and priority-memory effects remain transaction commit hooks; server publication flags remain outside SQL publication callbacks.
- Inspected request-local durable ordering, cancellation checks at publication, priority finalize/rollback, managed-fork abandonment, stream completion/turn-fence release, recovery publication and all four terminal `storeSession` paths.
- The `a21bf609f` interrupted-turn merge keeps marking in the request's durable order. Marking updates the exact generation, clears resumable cache state and installs the process-local record only after durable success. Cancellation settlement calls `evictSessionNow`, avoiding recursive queue deadlock. Stream `finally` joins the current durable tail before releasing request ownership.
- JSON lifecycle publication retains the sidecar lock while awaiting mapping CAS. SQL remains one synchronous admitted transaction and rejects yielding callbacks; no I/O was added inside it.
- The public `clearSessionCache(): Promise<void>` contract, server constructors, close signatures, configuration and HTTP shapes remain unchanged. Other altered store/cache functions are internal exports, not additional package APIs. No owner-facing constants/config defaults changed in this worker's patch.
- Existing session limitations (headerless overlap, process-local interrupted records, stopped priority routing) are not represented as new regressions or as fixed by #1220.

## Verification and evidence

Evidence directory: `/Volumes/DevSSD/meridian/evidence/review-1220-20261103`.

1. `bun test --timeout 30000 src/__tests__/proxy-request-cancellation.test.ts src/__tests__/interrupted-turn-cache.test.ts src/__tests__/execution-history-store.test.ts`: **24 pass, 0 fail** (`targeted-integration.log`).
2. `MERIDIAN_TEST_SQLITE_LIBRARY=/opt/homebrew/opt/sqlite/lib/libsqlite3.3.53.4.dylib bun test --timeout 30000 src/__tests__/proxy-client-abort-resume.test.ts src/__tests__/bookkeeping-cache-publication.test.ts src/__tests__/bookkeeping-server-admission.test.ts`: **90 pass, 0 fail** (`merged-abort-sql.log`). This includes the main-merged client-abort/discarded-partial/kept-partial paths and SQLite commit/fault authority tests.
3. `bun test --timeout 30000 src/__tests__/opencode-agent-context-resume.test.ts src/__tests__/claude-code-cwd-upgrade.test.ts src/__tests__/proxy-transcript-retention.test.ts`: **19 pass, 0 fail** after fixture corrections (`fixture-await-after.log`). Existing unclosed CWD fixture proxies emitted background GC ENOENT warnings; no assertion failed. Parent was notified.
4. Locator proof: actual original and corrected scripts run in `oven/bun:1.3.14`, Linux arm64, Docker `--network none`, repository read-only, native `/dev/shm` tmpfs. A synthetic machine-id fixture is bind-mounted because the image lacks a machine-id and otherwise fails the unchanged process-incarnation preflight. Original source retained as `locator-noop-before-original.ts`. Identity-qualified original run exits **1** (`0 !== 20` genuine replacements); corrected run exits **0**. For both 100/900-session fixtures, the corrected run records **20** genuine replacements, **0** identical locator replacements/payload bytes, and unchanged contents/generation/file identity. Logs: `locator-linux-identity-before.log`, `locator-linux-identity-after.log`. Initial unqualified container failure is retained, not a product or harness regression.
5. Additional cleanup-hook checks: **117 pass, 0 fail** across seven affected files (`cleanup-hooks-seven-files.log`); documented-isolated fingerprint-context **12 pass, 0 fail** (`cleanup-hook-fingerprint.log`).
6. Independent final cache correction: **72 pass, 0 fail** across `session-cache-coherence.test.ts` and `bookkeeping-cache-publication.test.ts`, with the same native SQLite library setting (`eviction-fix-independent-final.log`). The new tests cover stale fallback and later publication for both keyed and fingerprint maps; existing SQL fault/COMMIT cases remain green.
7. Earlier macOS semantic mirrors independently fail before (`0 !== 20`) and pass after, but are explicitly not Linux tmpfs acceptance proof. Their sources and logs are retained for transparency.

No actual E41 client/model/platform run was made. Mocked/unit/metadata checks cannot explain or close #1220's original live Opus cache-prefix discrepancy; the unchanged threshold and actual-flow gate remain open. Parent owns final full-suite/typecheck/build/CI qualification and final evidence publication. Local paths here are review artifacts, not a claim that durable PR evidence has already been published.

## Final handoff

- This worker's twelve assigned files are corrected and focused checks pass; `git diff --check` on all twelve passes.
- Independently reviewed the store reviewer's final cache patch without editing their files. The material findings described above are corrected in the working tree. No additional blocking integration finding survives this pass.
- Assumptions: ignored fixture setup/cleanup mutations are intended to finish before their hook/request continues; explicitly concurrent tests keep their intentionally unawaited calls. No production constants or public interfaces changed by this worker.
