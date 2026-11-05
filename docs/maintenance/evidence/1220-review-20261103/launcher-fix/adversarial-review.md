# Antigravity probe test-launcher adversarial review

## Scope and verdict

Reviewed the final frozen `src/__tests__/antigravity-probe.test.ts` in `/Volumes/DevSSD/meridian/fix-probe-launcher-20261103`, branch `test/probe-launcher-20261103`, based on `697f9482c23865e9d9a02095e35d79b0922047a7`.

Source SHA256: `bd259b98673fb9a929f624201ac4ab034738b513d9fa3015add391f1c9156bcf`.

**No material finding survives this read-only review. No source correction is requested.** This is a static review, not a test result or gate waiver. No test commands, live models, credential operations, network actions, or source edits were performed. This report is the only file written by the reviewer.

## Concrete inspected risks

### Spawn scope, receiver, and overloads

- Lines 11, 22–23 and 35 select exact registered fixture paths. The missing-executable negative control at lines 191–195 uses the unregistered `f.executable + '-missing'` and requires native `reason=spawn, attempt=1`. Rewriting every executable through Node would turn that into a script error and fail this assertion.
- Lines 13 and 19–25 capture the original `childProcess.spawn`, retain its function type through `Proxy`, and invoke it with `Reflect.apply(target, receiver, ...)`. Unregistered calls forward the original full argument list unchanged, including the native overload forms and receiver; no replacement overload implementation is introduced.
- The registered branch assumes an argv array. The real exercised caller at `antigravityProbe.ts:36–37` always supplies that array and a third options argument. The wrapper preserves that options object and prepends only the fixture script to argv. Fixture line 39 still records application arguments with `process.argv.slice(2)`.
- `spawnSync`, `execFile`, production source, dependencies, and public interfaces are unchanged.

### Real lifecycle/retry behavior remains under test

- `antigravityProbe.ts:19–27` still retries only timeouts; `:37` still creates real pipe stdio and detached POSIX children; `:42–53` still applies the real grace/deadline timers and AbortSignal; `:65–72` still settles on `close`, joining exit and stdio before retry.
- `antigravityProcess.ts:14–29` still signals the actual process group. Fixture lines 47–53 still record the first PID, ignore SIGTERM in stubborn mode, and fail a retry if that earlier PID remains alive. Tests at lines 107–122 retain real retry/count assertions for both configuration and model discovery. The launcher does not stub probe results or relax any original deadline/grace constant.
- The helper at lines 65–76 accepts the caller's actual pending promise. The model/configuration callers at lines 124–130 and 178–183 retain their existing 3000 ms timeout, 200/100 ten-millisecond readiness polls, single-call assertions, and final PID checks. Cancellation still comes from the real AbortController.

### Rejection and cleanup ownership

- Line 66 attaches `Promise.allSettled([pending])` synchronously before polling. Lines 72–74 always abort and join that same promise, including when readiness throws. Rejections during polling are handled immediately, not left unobserved until a later assertion.
- The strengthened regression at lines 88–106 owns the pending probe outside the helper, attaches its own settled witness immediately, forces readiness failure, and requires the promise to be settled and the PID gone while the root still exists. Only then does it delete the root. Its outer `finally` aborts and joins again if any regression assertion fails, so a broken helper cannot make the control itself orphan the child.
- Runtime-shutdown lines 199–203 handle the pending verification rejection immediately and join it after runtime close even on readiness failure. `AntigravityRuntime.closeOnce` aborts shutdown and joins verification/checking at `antigravityRuntime.ts:674–681`.
- `afterEach` at lines 27–30 restores the spy, clears registration, then deletes roots. The explicit background-probe paths finish their joins before that hook; other probe calls are directly awaited and runtime-owning cases close in `finally`. This does not assert recovery from an arbitrary test-runner hard timeout.

### Invalid-shebang control is discriminating

- Lines 79–86 give the fixture an impossible interpreter path. The **unspied** native `spawnSync` uses a 1000 ms timeout/SIGKILL and must report `ENOENT` without a fixture-body `calls` witness.
- The same file must then succeed through the registered asynchronous launcher and record exactly `['models']`. Removing or breaking the rewrite cannot satisfy the positive half; running the fixture in the direct control cannot satisfy the negative half.
- This proves the intended test-launch distinction once executed; it does not explain the original host-specific pre-JavaScript shebang stall or establish real official-agy behavior.

### Shared-suite fit and mock isolation

- The spawn spy is per-test and explicitly restored (lines 15–30), not a persistent module mock. Registration/roots are module-local; these tests are not concurrent.
- Inspected `bunfig.toml`, `src/__tests__/preload.ts`, `processProbeStubs.ts`, and other `child_process` mock sites. Preload does not replace spawn. Shared process-probe stubs replace `execFile`; SDK-gate/process-incarnation observers replace `spawnSync`. Broad native-command traps in `profile-expiry-fields.test.ts` and `login-deadline-persistence.test.ts` run in separate worker processes. The broad `models-auth-status.test.ts` mock is already isolated by `package.json:29`.
- This file remains in the shared first phase of `npm test`; no new exclusion was added. Actual Bun live-binding/restoration and full-suite order behavior still require that shared-suite execution, not only a focused pass.

## Assumptions and remaining gates

Assumed the parent's reported baseline shebang-versus-explicit-Node comparison is diagnostic context, not independently reproduced evidence. Assumed supported non-Windows test hosts provide Node, as the project already requires (`package.json:19–20`). Reviewer changed no constants. The new direct-launch negative control adds a 1000 ms timeout; original readiness/probe/kill-grace budgets remain unchanged.

Focused execution, `npm test`, typecheck, build, final-head CI, and durable baseline/final launcher evidence remain the implementation/parent's gates. A focused green run does not waive shared-process mock-isolation validation. No product-behavior or live affected-client E2E claim is made here.
