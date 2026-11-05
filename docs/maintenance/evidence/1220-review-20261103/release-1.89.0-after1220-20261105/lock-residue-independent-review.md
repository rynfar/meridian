# Independent review: live lifecycle-lock residue during contract migration

## Finding

The unchanged full local suite failed closed in `bookkeeping-store-contract.test.ts:98`: migration found `session-gc.json.lock.candidate-92039-b7d48221-25ff-4db8-bdb7-562c04dbeb09` still owned by the live suite process. The isolated contract file passing 6/0 does not explain or clear that full-suite failure.

There is a concrete cross-fixture custody gap:

- `src/proxy/server.ts:896` builds `sessionGcOptions` without `storeDir`.
- Managed-request completion starts opportunistic `void sweepSessionGc()` calls (for example lines 5838/5844 and 7300/7306). Consuming an HTTP response does not join those sweeps.
- `src/proxy/sessionLifecycle.ts:1336` resolves an omitted `storeDir` through the mutable global `getSessionStoreDir()`. `runGcOwned` crosses awaits between reconciliation and later deletion claims; each `withSidecarLock` resolves the directory again (line 1408).
- `proxy-session-resume.test.ts:68-70` and `proxy-replay-tool-history.test.ts:34` keep only `app`, discard their proxy cleanup handle, and never await `closeBackend`. Therefore their request-triggered sweeps may remain in flight when another fixture changes the global directory.
- The contract fixture changes that global in `beforeEach` and immediately performs migration after its store mutation. A previous sweep can consequently begin new lifecycle-lock acquisition in the contract fixture's directory.

This is not evidence of a periodic timer in those two fixtures: periodic scheduling belongs to `startProxyServer` (server lines 12394-12397), whereas these fixtures use `createProxyServer` only. `proxy-agent-definitions.test.ts` imports pure agent-definition helpers and does not originate lifecycle work.

## Deterministic discriminating witness

The frozen helper below runs the release worktree's actual lifecycle code on Bun 1.4.3. Its synchronous pin provider switches the global directory after reconciliation has already captured its first lock path. This deliberately controls the same mutable-default boundary without depending on timing, source edits, real SDK calls, or a broad-suite rerun.

Observed lock targets within a single `runGc`:

```
storeDir omitted: first/session-gc.json.lock, second/session-gc.json.lock, second/session-gc.json.lock
storeDir explicit: first/session-gc.json.lock, first/session-gc.json.lock, first/session-gc.json.lock
```

Both cases completed (2 tests, 4 assertions). These assertions establish directory drift with omitted options and its absence with a fixed directory; they do not attribute the historical full-suite candidate to a particular fixture.

Helper: `lock-residue-default-dir-51a0f123f9f6.test.ts`
SHA256: `51a0f123f9f6def505916dc8405ba968b5d6091a5b8f61d564d9d84901f7f471`
Output: `lock-residue-default-dir-witness.log`

## Narrow next action / limits

The shortest actual-suite attribution probes are unchanged `proxy-replay-tool-history + bookkeeping-store-contract` and `proxy-session-resume + bookkeeping-store-contract` runs, with candidate-creation stack/context witnesses if they reproduce. A green pair is not causal disproof: the full suite can add queue depth and scheduling delay. `bookkeeping-proxy-close` uses joined child processes, not same-process proxies; its wall time can delay a pending parent continuation but does not itself establish the lock's caller.

A narrow fixture-custody correction is to retain each app-only proxy and await its `closeBackend()` in `afterEach`, before any directory switch or removal. The production close path already joins `sessionGcRunning` (server line 12218). Add a regression that holds an opportunistic sweep across response completion, verifies cleanup waits for it, then switches the fixture directory and checks that no predecessor lock candidate appears there. Do not relax migration's live-residue refusal, add sleeps, or treat an isolated green rerun as proof.

No source changes were made. No actual originating fixture is attributed. The local full-suite failure remains unresolved; publication remains blocked pending a causal correction and final-head evidence.

## Static lock and migration ordering review (follow-up scope)

This follow-up performed file reads only: no commands, tests, models, network, credentials, or source changes. The deterministic witness above was completed in the preceding review phase, not rerun for this follow-up.

The actual failing store call cannot itself explain the candidate name:

1. `storeSharedSession("key", "id")` has no transcript arguments and enters `mutateStore` (`sessionStore.ts:981`). That function locks only `sessions.json.lock`; it neither acquires the lifecycle lock nor schedules GC. Awaiting it joins its store publication, parent-directory fsync, and `releaseLock` in `finally`.
2. `createInitializedSidecarLockCandidate` (`sessionLifecycle.ts:1365`) opens a unique `session-gc.json.lock.candidate-<pid>-<uuid>` inode, writes its process incarnation, fsyncs, and closes it before returning the candidate. A live, parseable candidate can exist while acquisition is still in progress.
3. `withSidecarLock` (`:1408`) awaits `candidate.discard()` in its inner `finally` **before invoking the protected operation**, then checks/unlinks its exact lock token in its outer `finally` **before resolving**. The FIFO keeps the holder active through this actual finalizer; it does not deliberately resolve before cleanup.
4. Candidate-unlink errors other than ENOENT are logged and swallowed (`lock staging cleanup failed`); lock-release errors are likewise logged. A cleanup failure is therefore possible in principle, but the full failure log provides no such warning. No evidence establishes that failure mode here.
5. `migrateBookkeeping` acquires the maintenance guard, then calls `planResidueArchive` at `migration.ts:176` **before its own** `withLegacyLifecycleMaintenanceLock` call around line 204. Thus this particular candidate was not created by the failing migration's own lifecycle acquisition. The supplied `writersStopped: true` is an operator/test attestation, not a join of legacy same-process work.
6. `planResidueArchive` synchronously inventories candidates and refuses a `live` verdict (`residueArchive.ts:24-27`). `candidateVerdict` reads the stored incarnation and probes that identity. On Darwin its same-identity fallback also conservatively refuses a live process. This refusal is expected safety behavior, not evidence of corrupt NUL metadata.

The concrete conclusion is limited: migration observed another live lifecycle acquisition (or an unremoved candidate from one) in its fresh directory; the awaited store call and migration's own acquisition do not account for it. The unjoined predecessor sweep/mutable-default path is a supported explanation, but the historical originating fixture and exact acquisition phase remain unproven.

Shortest discriminating instrumentation for the parent's experiments: record the candidate basename, target directory, stack/context, and ordered `open -> initialized -> link -> unlink` events only for lifecycle candidates entering `bookkeeping-store-contract-*` directories. Capture the test-directory switch with the same clock. Preserve one bounded run's log even if it passes. A candidate created by a predecessor context after the directory switch supports drift; a completed acquisition with a failed or missing discard supports cleanup residue. Do not claim either from a passing isolated file alone. Fixture cleanup ownership is a candidate correction only, not a verified fix.
