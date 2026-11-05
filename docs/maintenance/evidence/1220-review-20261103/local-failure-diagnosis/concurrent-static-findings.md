# Concurrent HTTP fixture GC failure — independent static findings

Scope: read-only source/log diagnosis of the worktree identified by the parent as `93b188f6`, `/Volumes/DevSSD/meridian/fix-explicit-model-fallback-20261103`. Evidence: `explicit-model-fallback-20261103-validation/full-npm-test-final.log`. No commands, tests, model calls, imports of project code, network requests, or source edits were performed. This report is the only new file. The supplied head identity was assumed, not independently checked with Git.

## Conclusion

The failed result remains a failure. The three-request ownership/publication behavior passed, but a real maintenance promise did not finish within the fixture's unchanged 5-second cleanup budget. Static inspection exposes a concrete isolation hole: this fixture joins a **whole-store GC sweep**, not maintenance confined to its three new resources. The metadata store is a suite-process scratch directory; its transcript locators are not scratch locators. The logged three locators point at `/Users/rynfar/.claude` and the actual feature checkout.

The default GC deletion path can spawn a fresh Node process that imports the installed real Agent SDK. Bun's mocked query and synthetic executable/auth boundary do not intercept that child. This is a credible source of unknown work that must be measured, not proof that a particular deletion or child caused these exact five seconds. The log lacks the active GC phase, whole-sidecar state, claimed resource identity, child identity, and elapsed phase timings needed to make that final attribution. There is no evidence here for an AsyncLocalStorage defect or for the model-pin change causing this failure.

## What the existing failure proves

- Log lines 11317–11322 show all three mocked SDK turns completing. Line 11332 records HTTP 200 for all three; matching session headers and target IDs; the intended response bodies; `started=[0,1,2]`, `finished=[0,1,2]`, and `activeQueries=0`.
- The assertion path at `integration.test.ts:431–476` reached the cleanup without an earlier exception: every target had its own mapping and expected lineage; all three resources were `live`, with no leases; in-flight HTTP count was zero.
- `cleanup GC sweep` timed out (log 11323, 11333, 11343). HTTP joining and backend cleanup were recorded completed. Test failure was retained (11345, 6113.87 ms). The current fixture does not convert a cleanup timeout into a pass.
- Importantly, `closeBackend` waits for this instance's `sessionGcRunning` and its deletion cleanup owner (`server.ts:12143–12158`). Thus the later completed backend phase supplies an eventual join for that instance; it does **not** retroactively satisfy the earlier 5-second deadline. This record does not prove a permanent leaked child.
- The reverse-order case passed in 3965.45 ms. A nearby unattributed `session GC deferred 1 failed deletion(s)` warning appears at 11352. It establishes that a GC deletion failure was reported in this interval, but lacks proxy/resource IDs and cannot safely be assigned to either case or an older proxy. The reverse-order pass is not acceptance evidence for the failed case.

## Isolation and ownership boundaries

| Boundary | Actual behavior and evidence |
| --- | --- |
| Metadata/config scratch | `preload.ts:65–85` creates one settings/session/temp root per Bun PID and assigns `MERIDIAN_CONFIG_DIR`, `MERIDIAN_SESSION_DIR`, and temp variables. The whole suite process shares them. The raised pending ceiling (`:117`) explicitly accommodates resources accumulating across files. The fixture itself creates no private store. |
| Claude transcript root | `MERIDIAN_CONFIG_DIR` is Meridian settings, **not** Claude's config root (`src/configDir.ts`). `resolveQueryConfigDir` uses `CLAUDE_CONFIG_DIR` or `HOME/.claude` (`query.ts:118–132`). The actual failure record contains `configDir=/Users/rynfar/.claude`, not a fixture directory. |
| Transcript project | No fixture workdir/profile is supplied (`integration.test.ts:331`). `server.ts:2888–2907` falls back to `process.cwd()`. The failure record confirms `projectDir=/Volumes/DevSSD/meridian/fix-explicit-model-fallback-20261103`. |
| Assertions | `resourcesForFixture` filters the sidecar by the three target IDs (`integration.test.ts:356–362`). It records nothing about other rows. Passing these assertions cannot exclude old pending/deleting resources. |
| Sweep scope | `server.ts:946–951` collects instance active pins **plus all durable mapping pins**. `runGcOwned` reconciles and scans all resources in the current store; deletion chooses the oldest due, unpinned, unleased retired row, not one of the new targets (`sessionLifecycle.ts:815–877, 881–915`). Pinned live fixture rows need no physical deletion. |
| Sweep launch/join | A successful fresh managed publication launches `void sweepSessionGc()` (`server.ts:5816–5822`). Cleanup's call may merely join the already-running sweep because the per-proxy `sessionGcRunning` is reused (`:976–980`). HTTP completion is not maintenance completion. |
| Multiple proxies | Sweep coalescing is per proxy. The lifecycle lock queue, lifecycle/store backends, store-directory override, deferred lease-release map, and directory cleanup registry are process-global. Distinct proxies can have separate sweeps serialized/interleaved through the same store. `createTestApp` discards the backend close handle (`integration.test.ts:104–106`), so earlier sections in this file do not explicitly close their proxies. This is a possible residual-work boundary, not proof of a particular unfinished operation. |
| Global hooks | `installSdkMock` installs the active factory at file `beforeAll` and clears it at file `afterAll`; logger mock also installs at `beforeAll`. `heldQuery` and `concurrentLogs` are file globals. The concurrent fixture resets them in `finally` even after a cleanup remains unjoined. That is a real contamination risk if backend joining also times out, but backend joining completed in this failure. No reentrancy/queue-stall evidence identifies an async-context failure here. |

The store directory is resolved dynamically in the JSON path (`sessionLifecycle.ts:1335–1337`, `sessionStore.ts:548–566`), because server lifecycle options do not capture `storeDir`. Rotating globals while any older proxy work survives can redirect subsequent operations. A test-isolation fix must join existing owners before restoring/changing paths, rather than simply set a new env variable and hope background work is gone.

## Where the unknown maintenance work can come from

The call is not a promise bounded by five seconds in production. Existing defaults in `server.ts:894–918` allow 16 deletions, a 30-second claim-run budget, and separate 30-second execution/handshake budgets for each started claim. `runTimeoutMs` only gates the next claim, and begins after deferred lease release/reconciliation (`sessionLifecycle.ts:818–840`). Local FIFO waiting, sidecar reads/writes/fsyncs, dead-owner/executor probes, reconciliation of the whole store, and child startup/handshake/closure are all outside the three mocked generators. The JSON external-lock budget starts only after reaching the local FIFO head (`:1407–1448`); it is not an end-to-end sweep bound. The default local queue stall timer is 60 seconds.

In particular:

1. `sessionLifecycle.ts:841–857` uses a custom deleter only when explicitly supplied. `createProxyServer` supplies neither `deleter` nor `sdkModuleUrl`.
2. `deleteWithSdkChild` resolves the installed SDK URL and spawns Node (`:1113, 1156–1180`), passes the row's stored `CLAUDE_CONFIG_DIR`/project, gates execution on durable attachment, and invokes `sdk.deleteSession` (`:1128–1153`). A project-scoped `not found` triggers a second **dir-less** lookup.
3. Bun module mocks cannot cross this fresh Node process boundary. `modelsMock.ts` blocks normal mocked-query executable/auth/credential operations, not this deletion runtime. `MERIDIAN_TEST_DISABLE_SDK_PROCESS_GATE` in preload is not a GC-deletion override.
4. Read-only inspection of installed SDK 0.2.141 confirms `deleteSession` is filesystem session lookup/removal, not a model query. Its default implementation enumerates candidate project directories; dir-less fallback enumerates the config root's projects. This is real host transcript I/O if a stored locator points there. Do not describe it as a live model call, and do not assume the query mock makes it synthetic.
5. Process-incarnation capture for a newly spawned deletion executor invokes `/bin/ps` on macOS with an existing 2-second probe budget. Own-process identity is cached (`processIncarnation.ts:494–529`), so blaming every own lease for repeated native probes would also be unsupported.

None of these possibilities is isolated by the current failure log. Do not change production GC semantics or timeout constants based on a guess.

## Smallest useful next diagnostic (proposal only; parent owns execution)

Retain the existing 10-second main budget and all 5-second cleanup budgets. In one instrumented run of the implicated fixture, preserve:

1. An all-resource sidecar summary before issuing requests, immediately before joining GC, and at the existing GC deadline: counts by state, due retired rows, and every `deleting` row's key/generation/locator/owner/executor/deletion token. Mark whether each belongs to these three targets. Include effective store directory, Claude root, workdir, bookkeeping mode, and gate filenames. No credentials or transcript bodies.
2. One retained sweep promise, with monotonic start/settled timestamps and an attached settlement observer. Keep the deadline failure even if that promise later settles. Record the eventual backend join separately, as now.

A non-fixture row entering `deleting` with a real executor will directly distinguish external maintenance from the already-proven target publication. If that is absent, add narrowly scoped phase timestamps around deferred releases, reconciliation, claim, child attach/exit/closure, and checkpoint for the next approved diagnostic; do not jump to an async-store theory. This is preferable to another unexplained green rerun or broad historical reconstruction. Any executable helper should be frozen and hashed before READY/execution under the existing custody rule.

## Smallest sound fix direction

**Test:** make the concurrent fixture own its complete namespace: empty metadata store, Meridian settings, explicit Claude config/profile, and existing workdir, all beneath one test root. Assert that the effective transcript locators are within that root and the initial sidecar has no unrelated resources. Keep the actual mocked HTTP/publication assertions and close/join every created proxy before restoring global paths or deleting the root. Do not widen grace periods, suppress GC, or replace an unjoined cleanup with a success. Because this file currently discards older close handles and the suite has process-global paths, setup must first establish no surviving older owner; use a dedicated owned fixture process if that cannot be proved without a larger lifecycle cleanup. Do not introduce a public proxy option just for this test.

An ordinary HTTP publication test should have no physical deletion claims against the host. If testing physical GC is intended, use the existing lifecycle test seams (`deleter` or an owned `sdkModuleUrl` stub) in an isolated lifecycle/deletion fixture, with a synthetic due resource and explicit child-closure assertions. Keep that separate from the three-request publication contract.

**Production:** no production fix is yet demonstrated as necessary. Whole-store GC and independently owned deletion work are intentional. If a bounded diagnostic finds a specific stalled lock, child, or ownership error, fix and directly cover that exact boundary; never narrow production GC to just the current requests or shorten cancellation in a way that abandons deletion custody. The model pin itself only adds the request env value `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` (`models.ts:111–119`) and does not change GC options or directories.

No assumptions about the exact active GC candidate, leaked env/backend selection, or active phase were promoted to findings. No constants were changed. Full final-head acceptance remains blocked on explaining/correcting the failure and new relevant verification; this static report is not a passing test result.
