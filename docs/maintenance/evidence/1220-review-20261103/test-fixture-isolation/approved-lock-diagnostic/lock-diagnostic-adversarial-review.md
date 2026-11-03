# One-shot store-lock diagnostic independent review

## Verdict

**APPROVED for the single already-authorized hosted contextual diagnostic. No material blocker remains.** This is not product acceptance, permission for another run, or clearance of the earlier failed gate. No production fix, release or merge is approved by this review.

Reviewed the complete six-file staged `diagnostic.diff` against frozen PR #1506 `c2adc2b5784e9bcd6020193cfcc538883f7695ee`, the hash-named read-only sources, the final hash manifest, and the root-owned offline receipts. This reviewer performed file reads/comparisons and wrote this report only: no tests, builds, subprocess/program commands, network or model calls.

## Frozen custody

Source bytes and hash-named review copies match; reviewed source/copy modes are `0444`:

| Source | SHA256 |
| --- | --- |
| Helper | `a18956f68bba3efeea1c2c2267cdab4917b7b80097f75bf087f5d5047a375f31` |
| Test seam | `ca067aef12ccc7b267cdfb195234b7baa55b5d921206a4e883cf9824c2c4b22d` |
| Offline controls | `78c33754c03ed6ce3f3dc2dd15910dd112a13a7108ea6f648a9730656f7c42f1` |
| Final runner v3 | `b6564116c19e34b5b535daf7187432ec21d2b03d937698beecd49f9595b61bac` |
| Workflow | `9220cb75ba0a096c580f1e90d52897e5a8d670374fa87a72c1d2d7ee572e856d` |

The expected-hash JSON matches all seven referenced source hashes; its SHA256 is `6b50738d657890bcef2281abe80b2a5b797d917df2e4909cef91acbd716108fd`. The runner verifies the expected hashes, creates/verifies a SHA256-named helper copy with mode `0444`, and passes its exact path for the case's dynamic import. The seam has no mutable-source fallback.

## Findings and resolution

- **R1 resolved:** the first runner accepted any truthy parsed trace. Final v3 requires schema 1, the exact case, `valid === true`, empty invalid reasons, uncapped agreed limits, native SIGKILL receipt and pre-resume journal `PREPARED`. Native npm status/signal remain separate. Invalid/missing/capped observation cannot make a green diagnostic.
- **R2 resolved:** the first runner did not handle output-append errors. Final v3 records only the error code, stops log writes, terminates its owned process group and prevents success. Earlier runner freezes were explicitly superseded before hosted execution.
- No other material source or scope finding survived final review.

## Boundary and behavior checks

- Final diff contains only workflow, runner, hash data, helper, standalone controls and the existing test seam. No production module, SQLite implementation/engine, dependency, package test command or required CI check changed. Independent byte comparisons confirm package.json, bun.lock, standard ci.yml, sessionStore, sessionLifecycle, migration and processIncarnation remain baseline-identical. All 53 original assertion lines are identical and in order. Child `spawnSync`, native-result assertions, timeout and join remain unchanged; returning its result does not bypass those assertions.
- Only opt-in `BOOKKEEPING_LOCK_DIAGNOSTIC_DIR` plus migration `2/1 PREPARED` loads/invokes the helper. Other cases retain their original resume path. Runner launches exactly `npm test`; the original group-0 command, full-suite order, internal test deadlines, 100-ms store-lock wait and 0-ms stale threshold remain unchanged.
- Original fs and owner-death functions receive their receiver and argument values through `Reflect.apply`. Native return and thrown-object identities are preserved. Recording exceptions set observer-invalid state without replacing native outcomes. Spies are installed only for parent resume and restored in `finally` before post-resume snapshots or output; restoration faults invalidate evidence.
- Joined child PID/status/signal and joined wall/monotonic clocks precede helper import. Owned lock token/nonce hashes, parsed incarnation, stat identity/mtime, journal phase and wall/monotonic clocks are captured before and after resume. No raw tokens, hostname, source/proc buffers, credentials or arbitrary path strings are emitted by the helper. Candidate/fd/recovery/retired labels retain relevant native operation timing and error codes without payloads.
- Interception counters are visible and required candidate observations are checked. Missing child-death/proc interception invalidates a returned recovery when required; a failure before the first observed recovery probe may retain qualified absence, not an invented probe result. No extra setup owner-death probe or extra proc read is introduced. CPU is aggregate start/end only.
- Events are buffered inside resume; there is no diagnostic output inside the lock budget. Limits are 10,000 events and 4 MiB. Capping invalidates the trace, and final serialized artifact size is independently checked. An oversized artifact becomes a minimal invalid receipt rather than increasing limits.
- On native resume return or throw, the helper restores spies, captures the post-resume state and exclusively creates `store-lock-diagnostic.json` before returning/rethrowing to the test's outer fixture cleanup. Recorder failures preserve native outcome and remain invalid/missing evidence. Successful capture does not imply the rest of npm test passed.
- Runner caps combined npm output at 16 MiB, uses only the external 35-minute budget, records native exit/signal, owns a detached process group and terminates it on budget/output/write failures. Missing group join is red; the terminal watchdog does not claim a clean join. Workflow uses the same `ubuntu-latest`, Node 22, Bun 1.4.3, install/typecheck/full-npm-test context. Its distinct branch-push diagnostic job does not replace required `test`; `if: always()` uploads red or green evidence and missing artifacts fail.

## Offline evidence inspected

`evidence/1506-lock-diagnostic-20261103/offline-receipt.json` records exit 0: **4 controls passed, 0 failed, 23 assertions; typecheck PASS; Node syntax PASS**. Read the matching controls and typecheck logs. Controls cover native forwarding/result/throw identity, recorder-error isolation, event/byte caps and metadata redaction. They used the frozen helper/control copies. Local runtime was Darwin arm64, Bun 1.3.14, Node 22.22.3; this establishes observer controls only, not the Linux timed resume or affected failure.

## Limits and next decision

Observer clocks, classification, hashing and serialization add overhead. Helper import/snapshots may change scheduling; joined clocks expose the import gap, and aggregate CPU includes observer work. Bun export-alias interception remains an explicit assumption: required counters detect missing observations, but zero export-spy calls cannot prove no native call. A false death result still combines alive and indeterminate. A failing artifact filesystem can leave missing evidence, never a qualified product claim.

No hosted result existed at review time. Use the actual captured branch to choose the next action. A qualified observed pass does not explain or clear the earlier failure. Invalid, capped, missing or unjoined evidence makes no product claim and does not authorize a second run. No speculative production correction is recommended by this review.
