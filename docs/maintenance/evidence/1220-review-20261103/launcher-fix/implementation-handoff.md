# Antigravity probe test launcher remediation

## Frozen review handoff

- Worktree: `/Volumes/DevSSD/meridian/fix-probe-launcher-20261103`.
- Branch: `test/probe-launcher-20261103`; base HEAD `697f9482c23865e9d9a02095e35d79b0922047a7` (fresh origin/main, no contributor commits added).
- Only tracked change: `src/__tests__/antigravity-probe.test.ts`.
- Frozen source SHA256: `bd259b98673fb9a929f624201ac4ab034738b513d9fa3015add391f1c9156bcf`.
- Frozen diff: `/Volumes/DevSSD/meridian/evidence/fix-probe-launcher-20261103/implementation.diff`.
- No commits, pushes, external actions, models, credentials, production changes, dependency changes or live client tests.

## Implementation

1. File-local `spawn` spy delegates registered fixture paths to explicit `Bun.which('node')` argv `[script, ...originalArgs]`. It forwards every unregistered call unchanged, preserves real children/options, and restores after each test. The generated `probe.cjs` no longer relies on an executable shebang.
2. File-local readiness helper owns abort and await/join in `finally`; it observes the pending promise immediately with `Promise.allSettled`. Existing model/configuration cancellation tests retain their readiness counts and expectations.
3. Runtime readiness assertion path now explicitly awaits its observed pending account check after `runtime.close()` before returning to temp cleanup.
4. Behavior controls: a fixture with a missing-interpreter shebang fails direct executable spawning with ENOENT and no calls, then succeeds through the real probe via explicit Node; a deliberately false readiness predicate proves abort, promise settlement, one real call, dead PID and surviving root before root removal. The latter also independently aborts/joins in its outer finally if its assertions fail.

## Constants, paths and assumptions

- Unchanged existing `timeoutMs: 1000`, `killGraceMs: 50`, cancellation probe deadline 3000ms, readiness waits 100/200 iterations at 10ms, timeout retry/cooldown behavior and test timeout 15000ms.
- Generated script remains `<tmpdir>/agy-probe-*/probe.cjs`; calls/count/old-pid files and generated fixture behavior are unchanged beyond removal of launcher shebang.
- Assumes stock Node is available through test host PATH, as existing fixture tests do (`build-source-recovery.test.ts` uses `Bun.which('node')`). Test suite remains explicitly POSIX-qualified; Windows is skipped.
- No claim that this resolves the exact host/Bun/macOS loader cause; it avoids the demonstrated executable-shebang path for synthetic fixtures only.
- Shared untracked node_modules symlink: `/Volumes/DevSSD/meridian/fix-probe-launcher-20261103/node_modules` -> `/Volumes/DevSSD/meridian/review-1220-20261103/node_modules`.

## Validation and exact-custody caveat

- Initial focused run: 41 pass / 0 fail / 166 expectations, 20.12s (`focused-test.log`).
- Focused run after immediate `allSettled` attachment: 41 pass / 0 fail / 166 expectations (`focused-test-final.log`).
- `npm run typecheck`: exit 0 (`typecheck.log`).
- Final `git diff --check`: exit 0.
- **Latest frozen source is not the exact tested snapshot**: after those passing checks, self-review changed the readiness helper to accept the caller's original promise and added an outer cleanup plus explicit settlement witness to the forced-failure control. Parent requested immediate freeze before further runs. Root owns final focused/full suite/typecheck/build verification for this exact hash. No final-head green claim is made.

## Adversarial review notes

- Product fit: strictly test-launcher/fixture cleanup, no application interface or production semantics changed.
- Retry controls still use real ignored-SIGTERM children and require predecessor process disappearance; no fake process or mocked cancellation result.
- Invalid-shebang control discriminates launcher behavior by actual execution, not source/magic-string matching.
- Missing-executable original test remains unregistered and therefore passes through to production spawn unchanged.
- Root reviewer should inspect global spy restoration/scope and the forced-failure witness. Full-suite process-global mock isolation remains parent gate.
