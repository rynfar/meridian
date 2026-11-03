# Frozen fingerprint observer

READY: `/Volumes/DevSSD/meridian/explicit-model-fallback-20261103-validation/fingerprint-diagnostic/observer-48a3b976991fae1da284619b725d2a775377feeff83bf153a7880070619d0bb2.mjs`

SHA256: `48a3b976991fae1da284619b725d2a775377feeff83bf153a7880070619d0bb2`

Size: 17700 bytes, 327 lines. Mode: read-only (0444). The frozen file was copied from the draft and its bytes/hash/mode rechecked. No edits have occurred after freezing. Run the hash-named file, **not** `observer-draft.mjs`.

## Execution ownership

No JavaScript, Bun, npm, tests, models, or program commands were executed by this worker. Validation so far is static inspection plus Python byte/hash/mode checks, **not** JS syntax or runtime validation. The helper includes nine deterministic assertions with fake return/throw measurement boundaries, label/delta/byte/error-redaction checks. They perform no filesystem/process I/O and execute once when the parent loads the preload; they do **not** prove Bun interception. There is no separate test command to run.

Parent owns exactly one bounded normal build, with the original process/pipes joined and original exit captured. From `/Volumes/DevSSD/meridian/fix-explicit-model-fallback-20261103`, use the native build entrypoint:

```text
E2E_MERIDIAN_ROOT=/Volumes/DevSSD/meridian/fix-explicit-model-fallback-20261103
E2E_FINGERPRINT_TRACE=/Volumes/DevSSD/meridian/explicit-model-fallback-20261103-validation/fingerprint-diagnostic/build-trace.json
bun --preload /Volumes/DevSSD/meridian/explicit-model-fallback-20261103-validation/fingerprint-diagnostic/observer-48a3b976991fae1da284619b725d2a775377feeff83bf153a7880070619d0bb2.mjs scripts/build.ts
```

Set these as environment variables through the parent's runner. The native entry is the same implementation used by `npm run build`, without the npm wrapper. Preserve an outer 180s hard limit with bounded process-group/pipes termination/join. Do not run a second build merely to obtain green evidence. The trace destination must not exist; it is written once using the captured original `writeFileSync`, with `wx` and mode 0600. A hard kill can prevent the exit trace; report that absence rather than inferring no activity.

## What is observed

- Export spies on `snapshotSource`, `certifyBuild`, `hashFileInto`, `fingerprintBudget`, and optionally `artifactInventory`. The gate wrapper labels preflight/pre-gates/post-gates source snapshots by the actual synchronous certification/gates sequence.
- Source-phase filesystem calls, fd→file association, regular-file size/kind, per-file read bytes/chunks/wall totals/max, per-file hash-update bytes/wall totals/max, and original open/stat/close/symlink metadata call times.
- Git operation labels, elapsed time, status/signal, stdout/stderr lengths only; `ls-files` lists are compared in memory and only relative added/removed filenames are emitted.
- Aggregate phase wall/CPU, budget method counts/successful entry/consume/file-size counters, error operation/file, and a lower-bound recording-cost estimate. There is no per-read CPU measurement or per-read output.
- Metadata reads are separate rows. File detail caps at 10,000 rows per phase; aggregate bytes/counters continue. All repository file paths are relative; outside-root paths are opaque labels. No source buffers, Git status contents, stdout/stderr contents, hash digests, build identities, tokens, or raw exception messages/stacks are emitted in the trace. Ordinary build stdout/stderr are separate evidence owned by the parent.

## Exact limits and interpretation

1. **This changes timing.** Spy dispatch, clocks, bookkeeping, string byte-length accounting, module preloading, and wrapper calls consume time inside the original 2s deadline. Recording-cost estimate excludes dispatch/clock/lookup work. It cannot establish the uninstrumented failing run's precise timing or reproduce its scheduling. A deadline failure under observation is diagnostic data, not proof of the earlier cause or of a production regression. A pass is likewise not a fix.
2. The original production limits/functions/arguments/returned build values/errors are forwarded; no source is changed. **`fingerprintBudget` returns a wrapped interface object, so its object identity is changed.** That is acceptable only for this external diagnostic, not claimed as a transparent production run.
3. Bun must support spying on these ESM/builtin exports and update their named-import bindings. Installation success alone does not prove interception. Inspect `interception.validForPostGatesDiagnosis`, the required boundary count, and all per-phase Git/fs/hash/budget counters. Missing counters produce `INVALID_TRACE`; an underlying successful build then exits 78 and its original exit code is retained in the trace. Partial early-failure data may still be useful but cannot be a post-gates comparison.
4. Same-module lexical calls may bypass export spies. In particular, the metadata reader's internal fresh budget and `certifyBuild`'s internal `artifactInventory` call may not hit their export spies. The source snapshots are cross-module calls; their cross-module budget/hash imports are the required counters. An absent artifact phase is explicitly not proof that artifact inventory did not run. Source phase CPU includes instrumentation and native code; read-wall-minus-CPU does not distinguish I/O from scheduling.
5. The measurement recorder executes in `finally` and is **not** guarded against its own internal exception. Such an exception can replace an original return/error. Any unexpected plain `Error`, helper/recording stack, trace-write failure, setup error, malformed/missing trace, or missing interception is an observer-invalid result, not causal build evidence. Embedded fake controls cover forwarding success/throw identity but do not test a failing recorder. `OBSERVED` means required counters were present, **not** proven observational fidelity or product acceptance.
6. Optional Git calls can legitimately fail and be swallowed by the original snapshot implementation. A recorded operation error is not by itself the final snapshot outcome. Inspect the phase `outcome`/`error` and original build exit. Input paths are metadata only; index/untracked classification is unavailable because the existing combined `ls-files` command does not label it and no extra Git pass is introduced.

No fingerprint constant or repository source was changed. This helper is not a product fix, and no finding should be resolved by a green rerun alone.
