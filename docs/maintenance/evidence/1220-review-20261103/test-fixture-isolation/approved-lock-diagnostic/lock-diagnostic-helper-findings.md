# Store-lock diagnostic helper: frozen source handoff

## Scope and custody

- Worktree: `/Volumes/DevSSD/meridian/diagnose-1506-lock-20261103`, baseline `c2adc2b5784e9bcd6020193cfcc538883f7695ee`.
- Owned source changes only: the new test fixture helper, one exact-tuple seam in `bookkeeping-crash-process.test.ts`, and standalone controls in `scripts/fixtures/` (outside the original npm test discovery).
- Manifest: `/Volumes/DevSSD/meridian/lock-diagnostic-helper-manifest.json`. Normal sources and hash-named review copies are mode `0444`; SHA256 was checked by reading both copies after writing/chmod. Frozen seam diff: `/Volumes/DevSSD/meridian/lock-diagnostic-frozen-20261103/bookkeeping-crash-process.diff`.
- No Bun/npm/project runtime, model, network, dependency, commit, push, or test execution was performed for this implementation. Root must run the frozen standalone controls and typecheck before its approved single hosted diagnostic.

## Behavior and checks

- The existing child `spawnSync`, timeout and all original assertion lines are unchanged; `child()` returns its original result only after those assertions. A source-only comparison confirms every original `expect(...)` line remains identical and in order.
- Only opt-in `BOOKKEEPING_LOCK_DIAGNOSTIC_DIR` plus exact `SIGKILL migration 2/1 PREPARED` dynamically imports the required `BOOKKEEPING_LOCK_DIAGNOSTIC_HELPER_FILE` through `pathToFileURL`. Missing FILE is an explicit custody error, not a normal-source fallback. Other cases neither import nor invoke the helper.
- The seam retains actual native PID/status/signal and immediate post-join wall/monotonic clocks before helper import. Snapshots follow helper import and precede resume, and follow success/failure before fixture cleanup.
- Snapshots contain only owned lock token/nonce SHA256, parsed PID/incarnation, stat dev/ino/mtime/size, wall/monotonic clocks and journal phase. No hostname, source buffer, proc buffer, or raw random token is emitted.
- Scoped fs synchronous export spies and the owner-death export spy are installed only around parent resume, then restored before the post-resume snapshot. Original receiver/arguments/return/throw identities are forwarded. Recording errors invalidate the receipt and cannot replace the native return/error.
- fd classifications associate candidate/lock/recovery/retired operations; other data paths are counted without recording names or payload. Native child `/proc/<PID>/stat` reads retain only timing and error code, never contents. Native stat observations retain age-clock/mtime pairs.
- There is no setup owner-death probe or extra OS/proc read. CPU is sampled exactly once at resume start and once at resume end; the ending CPU sample precedes ending clocks. Per-native-call events capture clocks only.
- Required case/platform/candidate boundary counters are validated. Missing probe events are explicitly `no-death-probe-observed`, not proof that the native function was never called. Returned recovery requires child-death-probe visibility; observed child probes on matching host/boot require native Linux proc-read visibility. A failed resume may validly have zero observed probes if the budget expired first, but export-alias visibility remains a stated limitation.
- Buffered events cap at 10,000 and 4 MiB. Capping invalidates the receipt. The entire encoded artifact is checked against 4 MiB; an oversized artifact becomes a minimal invalid receipt. Output is exactly `store-lock-diagnostic.json`, opened `wx` with mode `0600`, after resume and spy restoration.

## Offline controls supplied (not executed here)

`scripts/fixtures/store-lock-diagnostic-controls.test.ts` requires the same frozen helper FILE environment variable and checks native receiver/argument/result/throw identity, recorder-error isolation, event and byte cap invalidation, and lock-metadata redaction. Root may copy this control file to its hash-named `.test.ts` path in the same directory and invoke that file only; no original full-suite case is needed for these controls.

## Limits and assumptions

- This is test-only instrumentation, not a product correction or an acceptance pass. The 100 ms acquisition budget, 0 stale threshold, production code, engines, assertions, normal test script and earlier case ordering are unchanged.
- Interception adds clock, classification, hashing and serialization overhead. Timings are not transparent; snapshot/import time and observer overhead can change scheduling. Aggregate CPU includes resume plus observer work, not spy setup or snapshots.
- A false death result conflates alive and indeterminate. `/proc` error-code/timing metadata may distinguish missing native reads from failed native reads when interception is observed; zero export-spy calls alone cannot prove zero native calls.
- Assumed Bun `spyOn` can intercept the existing imported named bindings. Counter validation explicitly rejects missing required fs observations, and the receipt states the remaining alias-visibility limit rather than inventing evidence.
- No production/public interfaces or existing acceptance constants changed. New diagnostic-only constants are 10,000 events and 4 MiB; fixed receipt filename is agreed with the root runner.

## Frozen files

- `src/__tests__/fixtures/store-lock-diagnostic.ts` — `a18956f68bba3efeea1c2c2267cdab4917b7b80097f75bf087f5d5047a375f31`
  - `/Volumes/DevSSD/meridian/lock-diagnostic-frozen-20261103/store-lock-diagnostic-a18956f68bba3efeea1c2c2267cdab4917b7b80097f75bf087f5d5047a375f31.ts`
- `src/__tests__/bookkeeping-crash-process.test.ts` — `ca067aef12ccc7b267cdfb195234b7baa55b5d921206a4e883cf9824c2c4b22d`
  - `/Volumes/DevSSD/meridian/lock-diagnostic-frozen-20261103/bookkeeping-crash-process-ca067aef12ccc7b267cdfb195234b7baa55b5d921206a4e883cf9824c2c4b22d.test.ts`
- `scripts/fixtures/store-lock-diagnostic-controls.test.ts` — `78c33754c03ed6ce3f3dc2dd15910dd112a13a7108ea6f648a9730656f7c42f1`
  - `/Volumes/DevSSD/meridian/lock-diagnostic-frozen-20261103/store-lock-diagnostic-controls-78c33754c03ed6ce3f3dc2dd15910dd112a13a7108ea6f648a9730656f7c42f1.test.ts`
