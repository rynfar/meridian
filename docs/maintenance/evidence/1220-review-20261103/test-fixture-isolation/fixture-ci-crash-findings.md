# #1506 hosted CI crash-test diagnosis (read-only)

## Scope and custody

- Inspected `/Volumes/DevSSD/meridian/fix-test-isolation-20261103`, whose worktree Git metadata resolves to `c2adc2b5784e9bcd6020193cfcc538883f7695ee`.
- Read the supplied `ci-test-failed.log` for run `41718313625`, job `126204064158`. Its checkout is the PR merge commit `c0373e7d97aaccdda088bc41005f80ce256e719b`, merging that feature head into `1e24a969cc8aba8c62ad3fcea87a4f3da69c6e52` (log lines 94–124). I assume the cited relevant source matches the tested merge; I did not inspect Git objects or execute Git to prove tree equivalence.
- Hosted environment: Ubuntu 24.04.5, Node 22.23.4, Bun 1.4.3 (`c6da4a4d3`; log lines 11–14, 134–137, 202). Group 0 ends with 8305 pass / 28 skip / 1 fail, 8334 tests across 485 files (13884–13888).
- No tests, builds, models, network calls, shell commands, source edits, or helper programs were run. Only source/log/metadata reads and this report write were performed. No constants changed. The parent-reported local full-suite/typecheck/certified-build passes do not resolve this failure or waive hosted CI.

## Established: the post-kill resume failed, not the control snapshot

The failing path is:

`/tmp/meridian-test-tmp-2252/bookkeeping-crash-migrate-ufAOKR/sessions.json.lock`

The exception is `SessionStoreLockTimeoutError` at `sessionStore.ts:512`, through `withLegacyStoreMaintenanceLock:540`, `migration.ts:206`, and `sessionLifecycle.ts:1454` (log 3737–3754). The test is `SIGKILL migration 2/1 PREPARED`, 212.37 ms total (3755).

`bookkeeping-crash-process.test.ts:117` creates the `bookkeeping-crash-migrate-*` directory. Its pre-kill expected snapshot at line 123 calls `uninterruptedRichSnapshot`, which creates a **separate** `bookkeeping-migration-control-*` directory and migrates that directory (`fixtures/bookkeeping-rich-fixture.ts:70–79`). A failure there would name the control path, not the actual crash fixture.

The failing in-process migration is therefore the resume at crash test line 131. Before reaching it, `child("migrate", directory, point)` at line 130 has returned, and its assertions at lines 79–82 have accepted no spawn error, permitted stderr only, null exit status and `SIGKILL` signal. If the child had thrown this timeout itself, its stderr assertion would fail instead of producing this direct in-process exception. The 212.37 ms is the entire test duration, **not** a measured lock-acquisition duration.

## Established static path: PREPARED leaves a process-owned lock

On a fresh migration, `migration.ts:202–206` takes the lifecycle lock, then the store lock. `barriers()` saves the PREPARED journal and calls `crashPoint("PREPARED")` at lines 184–188, before the barrier replacements at lines 191–195. `maintenanceJournal.ts:159–162` implements this seam as a self-`SIGKILL`, with no JavaScript cleanup.

Thus the PREPARED crash normally leaves both ordinary locks belonging to the child; `sessions.json.lock` is not yet a migration barrier. Its store token is fully initialized and fsynced before atomic hard-link publication (`sessionStore.ts:197–225`), with a process incarnation (`493–501`). A successful PREPARED resume must recover that dead-owner store lock after recovering/acquiring the lifecycle lock. The logged stack shows that the lifecycle operation was entered; it does not reveal its recovery timing or the store lock's observed metadata.

## Budget versus owner-death race: unresolved

The maintenance store acquisition is explicitly `acquireLock(path, 100, 0)` (`sessionStore.ts:540`). It does **not** read `MERIDIAN_SESSION_LOCK_TIMEOUT_MS` for this call. Explicit directories also bypass the general session-directory environment/override selection.

The store loop does this (`493–520`):

1. Capture the current process incarnation, then start a `performance.now() + 100` deadline.
2. Build/write/fsync/close a new candidate, attempt its link, and unlink the candidate, even when the existing lock causes `EEXIST` (`198–225`, `506`).
3. Check the deadline at line 511 **before** attempting stale/dead-owner recovery at line 514.
4. If recovery returns false, check the deadline again, then wait up to 10 ms.

The observed throw at **512**, rather than 517, proves an unsuccessful publication attempt was followed by an expired deadline. It does **not** identify the iteration or prove whether any death probe ran. One candidate publication or scheduler pause consuming the 100 ms budget can hit line 512 before the first recovery attempt. Repeated false recovery decisions can also end at line 512 on a later iteration. No per-operation times or counters are logged.

Recovery also requires both strict age `Date.now() - mtimeMs > 0` and a canonical owner whose incarnation is proven dead; both are rechecked before retirement (`413–465`). Linux death observation reads `/proc/<pid>/stat`; missing proc entries mean dead, matching start ticks mean alive, and unreadable/malformed or host-mismatched observations fail closed (`processIncarnation.ts:124–149, 434–445, 569–582`). The parser reads start ticks but does not use the process-state field. A still-present zombie or runtime reaping defect could therefore matter **if it occurred**, but there is no recorded PID, `/proc` state, kill/presence result, or incarnation probe to establish that. `spawnSync` has returned with SIGKILL; a native/runtime contract violation must not be inferred from that alone.

Likewise the log has no retained lock token, mtime, claim state, owner incarnation, wall/monotonic-clock pair, or syscalls. Fresh/future mtime, fail-closed identity observation, runtime/reap behavior and slow filesystem/scheduling cannot be distinguished. The test's `finally` removes the directory (`crash test:145`), and the supplied log contains no failure snapshot.

## Bounded contamination check

I scanned the 148 test-file headings before/including this file in the supplied log for direct clock, host-ID, process-incarnation and relevant native-module mutation patterns, then read the matching candidates:

- `lifecycle-lock-deadline.test.ts:17` spies on `performance.now`, but its `finally` awaits outstanding operations and restores the clock, durable-sync, unlink and link spies (`63–70`). Its two cases passed earlier in this log.
- `profile-expiry-fields.test.ts` mocks `node:child_process` and `Date.now` only in its scenario worker branch (`104+`); the ordinary test launches separate Bun processes (`69–103`).
- The artificial performance clock and child-process wrapper in `build-source-recovery.test.ts:156–179` are source passed to its probe subprocess, not applied to the shared test process. `sdk-features-isolation.test.ts:19–31` likewise confines its `node:os` mock to a child.
- The direct `processIncarnationIsDead` spies in `bookkeeping-reconcile.test.ts` are restored in each `finally` (118, 166, 201, 236, 283, 300).
- No direct `MERIDIAN_HOST_ID` mutation appeared in those preceding test-file texts. The standard preload clears the Meridian/legacy environment namespace before establishing test directories. Boot/current-incarnation identity is cached; parent/child identity divergence remains a diagnostic possibility only, not an observed event.

This is a bounded direct-pattern check, **not proof that all cross-file contamination is impossible**. It found no concrete leaked clock/host/PID mock that explains the failure. Sidecar/store versions do not alter the explicit store acquisition budget. The adjacent cases passing does not prove flakiness or that this is unrelated to the isolation change.

## Conclusion and smallest next discriminator

**Cannot diagnose the cause from the retained evidence. Stop here; no corrective source change is justified.** The useful result is localization to post-SIGKILL PREPARED store-lock recovery and identification of the exact unobserved deadline/death branch split. The current head's required hosted `test` gate remains failed.

If a separate diagnostic execution is authorized, the smallest useful change is test-only, in this exact case/context: preserve a stage marker, child PID/status/signal, raw lock token plus stat identity/mtime, journal phase, and paired wall/monotonic times immediately after `child()` and on resume failure. Keep native calls delegated unchanged; collect store-candidate publication/fsync timing and the number/results/times of native owner-death probes. Emit a durable artifact **before** directory cleanup. Keep the original 100 ms acquisition budget, stale rules, engines and all assertions. A single bounded context-preserving diagnostic run can then distinguish “budget expired before recovery” from “recovery observed but refused”; a green rerun alone cannot. A deterministic test simulating a >100 ms first publication could prove that static branch exists, but would still not prove it caused this hosted event.

No blind rerun, timeout/engine/assertion weakening, production change, acceptance-gate waiver, or broader queue investigation is recommended.
