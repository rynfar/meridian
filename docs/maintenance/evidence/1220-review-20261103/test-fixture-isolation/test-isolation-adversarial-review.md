# Independent adversarial review: test isolation fixes

Date: 2026-11-03. Scope: read-only review of the two maintainer fixture diffs and their relevant helpers/evidence. No tests, builds, model calls, network requests, source edits, commits, or external comments were performed by this reviewer. The only file written by this reviewer is this report.

## Verdict

No material source blocker found at the frozen hashes below. The changes remove an unrelated full-build dependency and give the concurrent ownership cases a genuinely separate Bun process and owned namespaces. They do not establish a production source-fingerprint or concurrent-publication fix.

Concurrent worker evidence now records corrected focused, original integration-file and typecheck PASS at unchanged frozen v2 bytes. Acceptance remains conditional on the parent's final combined-head suite/build/required CI. A static inspection of `npm test` establishes wiring, not a successful whole-suite execution.

## Reviewed final source hashes (SHA256)

CLI worktree: `/Volumes/DevSSD/meridian/fix-bookkeeping-cli-fixture-20261103`.

- `src/__tests__/bookkeeping-cli.test.ts`: `0af9403b81b6aaafd2dc91c9e3e7fefd0203bf72076c7237be27882512888277`.

Concurrent worktree: `/Volumes/DevSSD/meridian/fix-concurrent-fixture-20261103`.

- `package.json`: `66021fc0fcde62ab4d57a3a168cbf7c1901176434cd69f7c570ffbe984ba2d74`.
- `src/__tests__/integration.test.ts`: `d4ea1775427c3e9826a915a8e98afa2579e2197240d7053ec279bb601e36805a`.
- `src/__tests__/integration-concurrent.test.ts`: `5eb9fcc414add8a8ff7d2fd16c4161a491f4205d712e1383c0d4c43fbc87e817` (READY v2).

All hashes were computed independently from the worktree files. The concurrent worker explicitly replied READY before review, invalidated its first snapshot after a concrete failure, and explicitly replied READY v2 before corrected execution. The v2 manifest and read-only hash-named copies are in `/Volumes/DevSSD/meridian/concurrent-fixture-isolation-20261103-validation/freeze-manifest-v2.json` and `frozen/`.

## CLI fixture findings

- The actual `bin/session-bookkeeping.ts` entrypoint is bundled with `Bun.build`, `target: "node"`, and `external: ["libsql"]` into a new private `mkdtempSync` directory. `cli()` starts `node` with that absolute fresh `.mjs` path. There is no fallback to stale `dist`, fake entrypoint, certified-build bypass or production seam.
- The bundle directory has a dependency symlink to the installed project tree and is distinct from each state directory. This matches the relevant existing Node fixture dependency-resolution pattern. `afterAll` explicitly removes the private bundle tree; existing per-case cleanup remains.
- No behavior assertion or test/CLI timeout was dropped or increased. The build success assertion necessarily changes from npm status to `Bun.build.success`. Both misleading "packaged" test titles now say "Node CLI".
- The narrow build does not test packaging, shared-chunk output, declarations or certification. Removing the old 180000ms npm subprocess deadline is removal of that subprocess, not a timeout increase; the 190000ms beforeAll budget remains.

Evidence read (not rerun): `/Volumes/DevSSD/meridian/bookkeeping-cli-fixture-validation-20261103/typecheck.log` passes. The first focused log records 22 pass / 3 fail because the direct in-process Bun APIs reject unqualified Apple SQLite 3.51.0. Exactly one corrected run with the existing supported `MERIDIAN_TEST_SQLITE_LIBRARY=/opt/homebrew/opt/sqlite/lib/libsqlite3.3.53.4.dylib` selection records 25 pass / 0 fail / 255 assertions in `focused-test-patched-sqlite.log`; source and assertions did not change between runs. The worker report retains the red result and records final diff validation.

The separate parent-owned `/Volumes/DevSSD/meridian/explicit-model-fallback-20261103-validation/packaged-cli-lifecycle.mjs` and its JSON receipt were read. They assert the actual independently installed tarball CLI under Node v22.22.3, legacy inspection/refusals and two migrate/export cycles. Its PASS is separate installed-package evidence, not a claim made by the narrow bundle. This reviewer did not independently execute or reconstruct that install.

## Concurrent fixture findings

- The cases are removed from `integration.test.ts`, not duplicated. Only the concurrent-only held SDK generator and diagnostic context machinery are removed there; its remaining SDK and logger behavior stays equivalent when no concurrent capture is active.
- `npm test` adds `--path-ignore-patterns '**/*integration-concurrent*'` to group 0, then invokes exactly one `bun test --timeout 30000 src/__tests__/integration-concurrent.test.ts` before the existing dedicated groups. The new file therefore does not register its process-global mocks in group 0, and both together/reverse cases share one fresh, dedicated process rather than rotating a global root amid unrelated live proxies.
- The new file owns Meridian config, session sidecar, Claude config and working-directory paths under one canonical private root. The dedicated process keeps these paths for both cases. SDK query parameters assert owned cwd and `CLAUDE_CONFIG_DIR`; all sidecar locators and prior transcript mappings assert the owned Claude/workdir namespaces. Complete resource counts reject unrelated sidecar entries, rather than filtering contamination away.
- All 20 original `expect(...)` lines in the extracted block remain verbatim. The three-writer barrier, unique targets, publication + active leases, HTTP 200/body/header results, mapping count/message count/lineage/transcript ownership, reverse completion order, live zero-lease resources and zero in-flight count are retained. Added prior-resource checks preserve and inspect the first case's completed publications in the second case.
- Budgets remain 10000ms for admission/responses, 5000ms for each of the three cleanup phases, and 30000ms per case. Immediate rejection observation and pre-cleanup failure evidence remain. Optional no-op GC/backend cleanup is strengthened to require the actual join APIs.
- The relevant `closeBackend` implementation begins drain, waits for in-flight work, awaits outstanding GC, joins deletion ownership and closes retained bookkeeping. The fixture removes a proxy from `openProxies` only after that promise completes. Held SDK/log controls are not reset while that owner remains open. `afterAll` refuses path restoration/deletion when an owner is still unjoined; the custom root is outside preload's teardown root. A cleanup timeout remains a recorded failure, not proof of a join.
- Initial frozen source `f9e02d546e5db785b7db2199d3ebc810e9eb64436e604b13a4a5f51564d10653` failed its new exact locator assertion on macOS `/var` versus `/private/var`. The retained `integration-concurrent.log` shows all three writers active and all cleanup phases completed. READY v2 adds only the `realpathSync` import and canonicalization of the fresh fixture root. It does not relax equality assertions or deadlines. This is a concrete fixture correction, not an unexplained green rerun.

Worker evidence read after the initial report: `integration-concurrent-v2.log` records **2 pass / 0 fail / 201 assertions**, including both completion orders. `integration-original.log` records **11 pass / 0 fail / 52 assertions**. Both used the required patched SQLite selection; the initial red log is retained. All three concurrent source hashes were independently rechecked unchanged after those runs. `typecheck.log` and the worker's final completion receipt record typecheck **PASS, exit 0**. The worker report is `/Volumes/DevSSD/meridian/concurrent-fixture-isolation-findings.md`. Parent owns final validation and any re-review if bytes change.

## Boundaries and assumptions

- Observed changes are limited to the four paths listed above across two worktrees. `package.json` changes only `scripts.test`, not dependencies. No production/public API, lockfile, dependency or Nix-hash change is required by these diffs.
- Assumed the existing installed dependency tree is the authorized project environment; no dependency installation was performed.
- Assumed the documented `npm test` command is the supported suite entrypoint. Bare all-files `bun test` is not an isolation claim of this fix.
- No constants or timeouts were changed. These are maintainer fixture changes; this review makes no claim to carry contributor #1220 commits or to alter the user's checkout.
