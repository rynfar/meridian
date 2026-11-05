# Independent hosted diagnostic result audit

**Verdict: qualified observed pass; no artifact inconsistency or invalidation found. The earlier 100-ms failure was not reproduced and its cause remains unresolved.**

Read-only audit of downloaded artifacts and saved metadata for [run 41730535471](https://github.com/rynfar/meridian/actions/runs/41730535471), diagnostic head `d26da6f3403dff4c9cca7b295f31c597b2f5f494`. No commands, tests, network, source edits or additional run were performed.

## Native run, separate from observation validity

- Saved GitHub metadata reports successful `lock-diagnostic` and artifact-upload steps. Receipt head matches metadata; native npm exit is **0**, signal null, closed/groupJoined true. No timeout, output cap, log-write error or terminal watchdog is reported. Duration was 724.707 seconds, below the external 2,100-second budget.
- Independently parsed **27 Bun invocations: 8,856 pass, 28 skip, 0 fail**. All report Bun `1.4.3 (c6da4a4d3)`; receipt records Linux x64/Node `v22.23.4`. The full printed command exactly matches frozen baseline package.json; subsequent isolated-file order matches all 26 remaining commands. The target case passed in group 0, between its original adjacent cases.
- Downloaded npm log is exactly **1,678,936 bytes**, matching receipt outputBytes and below 16 MiB. No diagnostic warning appears. The unchanged Bun and independent Node WAL-reset engine-gate tests passed; these three artifacts do not retain a raw SQLite version/source-ID report.

## Trace validity and native observations

- Schema/case/validity checks pass: exact `SIGKILL migration 2/1 PREPARED`, valid true, no invalid reasons, native child PID 9681/status null/SIGKILL, before PREPARED and after READY. All six receipt source hashes match the reviewed freeze/hash manifest; the receipt reports expected-hash verification and the correct read-only helper hash-copy witness.
- **91 events**, all within resume monotonic bounds with consistent elapsed arithmetic and ordered completion times. Every retained fs/death counter exactly matches its event count. Recomputed compact event bytes are **26,181**, exactly the claimed buffer size; uncapped 10,000-event/4-MiB limits hold. Full trace is **30,045 bytes**, also below 4 MiB.
- Four intercepted `/proc/9681/stat` reads threw **ENOENT**; each lies inside a matching original owner-death call that returned **true**, without throwing. All owners match child PID/incarnation/host/boot. These are actual forwarded-call observations, not a recorder-created death result. Two probes precede store acquisition (lifecycle recovery); two are within the store recovery window. Do not call all four store probes.
- Store candidate publication first failed `linkSync` with **EEXIST**, then native recovery renamed/deleted the stale lock and removed its recovery claim; second publication linked successfully. Two candidate fsyncs took **0.282318 / 0.289331 ms**. Candidate-open through successful-link was **2.217497 ms**, not a directly instrumented complete acquisition/deadline interval.

## Interpretation limits

Resume elapsed was **38.391781 ms by monotonic clock** (38 ms by Date.now), not a reproduced 100-ms timeout. The parent summary field `resumeWallMs` uses the monotonic delta; label it accordingly when quoting precise timing. The before snapshot follows helper import: **3.323835 ms after joined clocks**, with 27.481445-ms store-lock age. It is not an immediate post-kill snapshot. Observer/import/snapshot work changes scheduling and adds overhead; native counters establish observed interception here, not transparent timing or exhaustive syscall tracing. Receipt hash-copy mode/join are runtime witnesses, not a separate OS audit. No raw source/proc payload is retained.

No product fix or old-CI cause follows from this pass. Original PR #1506 required red remains unwaived; no merge/release or further attempt is authorized.

## Downloaded artifact SHA256

- `npm-test.log`: `3ceacc99f9ac328b515cd14f247a96304e7267483c730e76d0a36b8237bc4db3`
- `store-lock-diagnostic.json`: `4ed43478337fac1bdc4a55d7f4d17b78a0742331fb5299a93246cf1101086aad`
- `runner-receipt.json`: `4e637a02d4108b8322fdc8f590c19e59a1a41459dae23b59f586c574c7817094`
