# Bookkeeping CLI fixture dependency cleanup

Date: 2026-11-03. Worktree: `/Volumes/DevSSD/meridian/fix-bookkeeping-cli-fixture-20261103`. Branch: `test/bookkeeping-cli-fixture-20261103`. Base HEAD: `1e24a969cc8aba8c62ad3fcea87a4f3da69c6e52` (`origin/main` at worktree creation). No commits or pushes performed.

## Result

Only `src/__tests__/bookkeeping-cli.test.ts` changed (21 insertions, 8 deletions). The behavior tests no longer invoke the unrelated full certified application build in `beforeAll`. They compile the **real** `bin/session-bookkeeping.ts` using `Bun.build`, `target: "node"`, `external: ["libsql"]`, and `naming: "session-bookkeeping.mjs"` into a fresh `mkdtempSync` build directory. `cli()` runs that fresh absolute `.mjs` path using `node`. The repository and dependency target are resolved to real paths; the build directory gets its own `node_modules` symlink. State fixtures remain in separate directories. `afterAll` removes the build directory.

All pre-existing behavior assertions and test/CLI timeout values are unchanged. The build-result assertion necessarily checks `Bun.build` success instead of an npm subprocess status. Both misleading “packaged” titles now say “Node CLI.” The existing `buildNodeFixture` helper remains unchanged and is still used by the cycle fixture. There is no fake entrypoint, production seam, skip-certification flag, timeout increase, dependency change, or spec/production change.

This fixes an architectural test dependency. It does **not** establish the cause of the historical source-fingerprint deadline failure or prove a production fingerprint fix.

## Frozen source and custody

- SHA256 before **all** validation and after both focused attempts: `0af9403b81b6aaafd2dc91c9e3e7fefd0203bf72076c7237be27882512888277`.
- SHA256 of recorded unified diff: `88dfa97ebbf9e2672e3650362e9e749c694256841af3e7b2df8f8d27ca4d204e`.
- Source set read-only (`0444`) before validation, with an identical read-only snapshot at `/Volumes/DevSSD/meridian/bookkeeping-cli-fixture-validation-20261103/bookkeeping-cli.test.0af9403b81b6aaafd2dc91c9e3e7fefd0203bf72076c7237be27882512888277.ts`. No source edits followed validation.
- Evidence directory: `/Volumes/DevSSD/meridian/bookkeeping-cli-fixture-validation-20261103`. Includes `freeze.json`, `source.diff`, both focused logs, `typecheck.log`, runtime fixture witnesses, cleanup observations and `results.json`.
- Final `git diff --check` passed; status shows exactly the allowed test file modified.

## Verification

Runtime versions: Node `v22.22.3`, Bun `1.3.14`, npm `10.9.8`, macOS host.

1. `npm run typecheck`: **PASS**, exit 0. Log: `/Volumes/DevSSD/meridian/bookkeeping-cli-fixture-validation-20261103/typecheck.log`.
2. Initial `bun test --timeout 30000 src/__tests__/bookkeeping-cli.test.ts`: **FAIL**, 22 pass / 3 fail, exit 1, 58.67s. Log: `/Volumes/DevSSD/meridian/bookkeeping-cli-fixture-validation-20261103/focused-test.log`. This attempt omitted the host's required patched SQLite selection. The three in-process Bun tests refused Apple's SQLite 3.51.0 (one secondary assertion failed because the engine refusal prevented its hook from running). The Node CLI lifecycle passed. This red result is retained, not relabeled as a fix failure or hidden.
3. Exactly one corrected focused attempt using the **existing supported preload selection**:
   ```sh
   MERIDIAN_TEST_SQLITE_LIBRARY=/opt/homebrew/opt/sqlite/lib/libsqlite3.3.53.4.dylib bun test --timeout 30000 src/__tests__/bookkeeping-cli.test.ts
   ```
   **PASS**, 25 pass / 0 fail, 255 assertions, exit 0, 59.70s. Log: `/Volumes/DevSSD/meridian/bookkeeping-cli-fixture-validation-20261103/focused-test-patched-sqlite.log`. No assertions, source bytes, qualification policy or timeouts changed between attempts.

Selected library resolves to `/opt/homebrew/Cellar/sqlite/3.53.4/lib/libsqlite3.3.53.4.dylib`. SHA256: `75feed7151d3e496343ffee9c25960d85188ed99b2ffb1051fe016f912c6c808`. Its actual SQLite source ID was not separately queried in this constrained delegation; this is not standalone engine-certification evidence.

During the corrected run, an actual fixture witness showed:

- Fresh build directory `/var/folders/ks/xnz659y11jl44j80b_lfws6r0000gn/T/meridian-test-tmp-19285/bookkeeping-cli-build-DnJXhw`, mode `0700`.
- `session-bookkeeping.mjs` existed, and `node_modules` resolved to `/Volumes/DevSSD/meridian/review-1220-20261103/node_modules`.
- State directory `/var/folders/ks/xnz659y11jl44j80b_lfws6r0000gn/T/meridian-test-tmp-19285/bookkeeping-cli-DEKYL6` was a distinct sibling, not the build directory.
- After test completion, both observed directories were absent. This supports end-of-run cleanup, but does not distinguish this file's `afterAll` from the existing global preload cleanup by itself.

The first top-level temp scan was empty because the existing preload redirects `TMPDIR` into a per-test-process root. No runtime witness was claimed from that empty scan; the later nested-root witness above is the actual observation.

## Scope, assumptions and remaining gates

- Assumed the authorized dependency tree `/Volumes/DevSSD/meridian/review-1220-20261103/node_modules` is the intended installed project environment; the new worktree's ignored `node_modules` symlink points there. No installation occurred.
- Assumed a narrow real-entrypoint Node bundle is sufficient for **behavior-test setup**, not installed-package coverage. The shared fixture helper's dependency-resolution pattern was inspected, not generalized for one use.
- Constants/timeouts changed: **none**. Existing build-hook timeout stays 190000ms; existing CLI and per-test deadlines are unchanged. The removed npm subprocess's 180000ms timeout disappeared with that subprocess, not by extension.
- No full suite, certified application build, live model calls, credentials, network, commit, push or release action occurred in this delegation.
- The narrow bundle does **not** prove packaging, declarations, application builds, provenance or certification. The independent fresh installed-tarball Node 22 CLI lifecycle gate remains separate; the parent reports it PASS and owns its evidence. This report does not substitute its focused run for that gate.
- Parent owns independent final review and any final whole-suite/build/CI/PR work. Required certified-build and final-head CI gates are not waived by this change.
