# PR #1220: frozen-head Antigravity probe failure diagnosis

## Conclusion

The local failures are **pre-fixture startup/readiness failures on the executable-shebang path**, not evidence of a session/cache/store regression or failed stubborn-process cleanup. The original tests remain red in the candidate checkout and green in the baseline checkout. Do not report a green local full suite.

A standalone diagnostic importing only Node built-ins reproduces the decisive failure without Meridian code: from the candidate cwd, executing the original `#!/usr/bin/env node` fixture as an executable never reaches its first `calls` append before the unchanged 1000ms deadline. Calling the same fixture through explicit `/usr/bin/env node <script> models` or the same absolute Node binary succeeds in 33–44ms. Restricting PATH does not fix executable-shebang startup. An original test child sampled after 3.47s is still `/usr/bin/env`, with all 809 samples at `_dyld_start +0`, before env main/Node/fixture JS.

This localizes the observed failure to the host/Bun executable-shebang startup path. It does **not** establish the exact macOS loader/Bun/security cause. The candidate/baseline cwd correlation remains real; it must not be relabeled as random suite load, nor attributed to this PR merely because the candidate fails. No source change is proposed here.

## Frozen revisions, environment, custody

- Candidate cwd: `/Volumes/DevSSD/meridian/review-1220-20261103`; clean HEAD `67d02f56ba69b7e738aea67119ba5b1376ef0db0`.
- Baseline cwd: `/Volumes/DevSSD/meridian/review-1220-baseline-20261103`; clean HEAD `697f9482c23865e9d9a02095e35d79b0922047a7`.
- Local tuple: macOS 26.6.2 (25G83), Darwin arm64, Bun 1.3.14, Node v22.22.3.
- `node` resolves `/Users/rynfar/.local/bin/node` -> `/Users/rynfar/.hermes/node/bin/node`, a native Mach-O binary, 112915776 bytes; SHA256 `5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c`. No shell shim at this selected path.
- Ambient `NODE_OPTIONS` and `NODE_PATH` are absent. No `DYLD_*` or `LD_*` keys are present. Test preloads/config are unchanged.
- Parent reports same-head CI `test` green on Linux x64, Bun 1.4.3, Node 22.23.4. This is a different platform/runtime tuple, not a reproduction of the local failure.
- All targeted runs began only after parent confirmed the full suite DONE. Candidate, baseline, diagnostics, and one candidate original control ran sequentially; no concurrent root test process. No models, credentials, application source, fixture constants, dependency versions, or checkout contents were changed. All new diagnostic files are outside both checkouts.

## Original-test evidence

Original command in each checkout: `bun test --timeout 30000 src/__tests__/antigravity-probe.test.ts`. The CLI bound controls the outer test runner; fixture probe deadline remains 1000ms, kill grace 50ms, readiness waits and explicit test timeouts unchanged.

| Run | Result | Duration | Artifact |
| --- | --- | --- | --- |
| Root full-suite group 0 | 8287 pass / 65 skip / 5 fail / 1 error; later groups not run | 958.63s | `final-npm-test.log` |
| Candidate original file | 32 pass / 7 fail / 1 error | 54.73s | `probe-original-candidate.log` |
| Baseline original file | 39 pass / 0 fail | 23.82s | `probe-original-baseline.log` |
| Candidate original control after instrumentation | 30 pass / 9 fail / 1 error | 46.72s | `probe-original-candidate-control.log` |

No further original reruns were made or are proposed. The candidate control did not turn green; this is not pass hunting.

The root full log has five probe failures, beyond the three initial labels:

1. **Configuration retry, stubborn**: attempt 2 ends `reason=timeout, elapsedMs=1012, deadlineMs=1000, signal=SIGTERM, outputBytes=0`. Attempt 1 also dies by SIGTERM, unlike a JS-ready stubborn fixture whose installed handler ignores SIGTERM. A retry cannot demonstrate predecessor ordering if the fixture never enters its mode.
2. **Model-discovery retry, once**: attempt 2 also times out at 1009ms with SIGTERM and zero bytes, rather than returning the second-attempt model line.
3. **Repeated model timeout**: `f.calls()` throws ENOENT for `agy-probe-zPIgUt/calls`. The fixture appends `calls` before all behavior branches; this is missing script-entry evidence, not just slow output or slow cleanup.
4. **Cancelled model discovery**: polling reaches its roughly 2s readiness budget with `count` absent (`false`). The test fails before aborting/joining `pending`.
5. **Account-probe cooldown**: a downstream retry reports `reason=spawn, attempt=2, exit=-2` after the failed readiness test's cleanup deleted its fixture. The unhandled error is consistent with the existing readiness assertion path leaving its pending probe unjoined. It is not independent evidence of durable bookkeeping failure.

During candidate original run 1, a live fixture snapshot contained only `probe.cjs`, with no `calls` or `count`. A process snapshot showed `/usr/bin/env node <fixture>/probe.cjs --version`; a later original-run native sample proves the stalled child was still at env's loader entry. Preserved artifacts: `probe-candidate-readiness-snapshot.json`, `probe-interpreter-native-sample.txt`.

## Discriminating external controls

`probe-exec-timing.ts` materializes the original fixture template body outside the repository and tests it under native Bun using the same 1000ms budget/50ms grace. It does not import Meridian or its preload. Fresh executable-shebang startup times out without a `calls`/`count`; direct Node runs the exact same file in 32.87ms; repeating shebang on that same file still times out with no new call. A fresh direct-Node file succeeds in 34.26ms. Thus file warming or slow Node JS startup does not explain this observation.

`probe-exec-forms.ts` uses one case per arm, the same original fixture body, `AG_PROBE_MODE=success`, and only Node built-ins. Exact argv/cwd, emitted call PID/args, complete environment-key names, key/value digests (no values), PATH digests, readiness, and close outcome are in the logs. The diagnostic does not load the test preload; original test env values were not instrumented. The diagnostic fixture default has `AG_PROBE_SETTINGS` absent rather than the original helper's empty string; both select the same unchanged default settings branch.

| Executable/argv form | Candidate cwd | Baseline cwd |
| --- | --- | --- |
| `<script> models` (original shebang) | timeout 1015.55ms; no call | exit 0, 279.03ms; call |
| `/usr/bin/env node <script> models` | exit 0, 36.27ms | exit 0, 47.66ms |
| `/usr/bin/env /absolute/Node <script> models` | exit 0, 41.32ms | exit 0, 40.50ms |
| `<script> models`, minimal PATH | timeout 1005.68ms; no call | exit 0, 40.93ms; call |
| `/usr/bin/env node <script> models`, minimal PATH | exit 0, 44.34ms | exit 0, 44.88ms |
| `/absolute/Node <script> models` | exit 0, 40.19ms | exit 0, 47.64ms |

Minimal PATH: `/Users/rynfar/.hermes/node/bin:/usr/bin:/bin:/usr/sbin:/sbin`. Both cwd runs use byte-identical PATH per corresponding arm and identical environment key sets. Existing PATH selects the same native Node at index 6; preceding entries contain no executable `node`. Explicit env argv succeeds with both existing and minimal PATH. Therefore PATH search and alternate Node selection are not the demonstrated cause.

- Existing PATH SHA256: `e9eb768c5830235b64cf627672bd4c7b0886ca5ce0947b3bebe680295fc95ae5`.
- Minimal PATH SHA256: `09b773d041f7c0e7eff604c1db73eaa2f74fd32a190977090376410f6226df9f`.
- Sorted NUL-separated env-key SHA256 (both cwd, all argv arms): `8027e714ed2273e1819101ad70b90bee20fda4a52b17b2251fceeaae9a096b5d`.
- Full environment-value digests differ because cwd/PWD and per-run fixture root differ; the logs retain digests, not values. No claim of byte-identical complete environment is made.

## Attribution and remaining gate

The original test plus its complete recursive local import closure (24 files) are byte-identical between revisions. The direct probe/process/runtime/protocol modules, preload and `bunfig.toml` are also byte-identical. Closure paths/hashes are in `probe-import-closure.json`. More importantly, a built-ins-only fixture harness reproduces candidate-cwd failure before JS entry; no changed asynchronous store/cache module is needed to produce it.

Finding: **no causal PR #1220 regression established for these probe failures**. The local original/full-suite failures remain recorded, and the exact host/Bun startup mechanism is unresolved. Do not adjust fixture deadlines, production timeouts, or treat another platform's CI green as local before/after proof. Parent owns any subsequent qualification decision. This diagnosis does not close the independent live E41 cache-prefix/model evidence gate.

## Reproduction and hashes

All artifacts are in `/Volumes/DevSSD/meridian/evidence/review-1220-20261103`. Reproduce each original run from its named checkout with the command above. Reproduce bounded diagnostics with `bun /Volumes/DevSSD/meridian/evidence/review-1220-20261103/probe-exec-timing.ts` or `bun /Volumes/DevSSD/meridian/evidence/review-1220-20261103/probe-exec-forms.ts` from the named cwd. Absolute artifact paths are embedded in the scripts. No real agy/model executable is invoked.

SHA256 manifest: `probe-artifact-sha256.json`, SHA256 `dbe21fd2be4cd870f234920bd20d2679cf00e9c5d09ad8918dac49a2e5c5bb56`. It includes original-test logs, both diagnostic scripts/logs, exact original fixture body, import closure, readiness snapshot, and native sample. Values are immutable evidence from this review; no current application test is claimed green.
