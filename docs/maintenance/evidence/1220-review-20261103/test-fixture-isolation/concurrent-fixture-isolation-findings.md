# Concurrent HTTP fixture — test-only isolation

Worktree: `/Volumes/DevSSD/meridian/fix-concurrent-fixture-20261103`
Base: `1e24a969cc8aba8c62ad3fcea87a4f3da69c6e52`
Branch supplied by parent: `test/concurrent-fixture-isolation-20261103`.

## Scope and conclusion so far

The implementation is test-only. No production source, public API, dependencies, GC suppression, deletion override, timeout or grace constant changed. It addresses the concrete fixture isolation hole described in `model-pin-concurrent-findings.md`; it does **not** establish the cause of the historical five-second GC failure or claim that a production GC defect was fixed.

Authorized focused validation is complete on the corrected frozen source: concurrent file **2 pass / 0 fail / 201 assertions**, original integration file **11 pass / 0 fail / 52 assertions**, and `npm run typecheck` **exit 0**. The initial failed attempt is preserved. No full suite, build, network, model call, credentials operation, commit or push was performed by this worker.

## Changes

- `package.json`: only `scripts.test` changes. Group 0 excludes `**/*integration-concurrent*`; immediately after group 0, a dedicated `bun test --timeout 30000 src/__tests__/integration-concurrent.test.ts` process runs both cases before `bookkeeping-admission-seam`. All other existing process commands remain in order.
- `src/__tests__/integration.test.ts`: extract the two concurrent cases, their held-query and request-log controls, and their now-unused imports. Ordinary SDK behavior and the logger no-op remain.
- `src/__tests__/integration-concurrent.test.ts`: keep the existing together/reverse real HTTP cases, mocked SDK generator, overlap barrier, publication/writer lease checks, distinct session IDs, 200 responses, headers, bodies, lineage/mapping and final live/unleased assertions. All 20 original `expect` source lines remain verbatim. Add complete namespace provenance and backend ownership guards.

The dedicated file sets Meridian settings/session, Claude config and an existing workdir once in `beforeAll`, under one canonical private root. It also supplies an explicit profile with that same private Claude root. The initial sidecar and mapping store must be empty; before the second case, only the first case's known published live/unleased rows may remain. Each whole-sidecar read rejects an unknown resource or an outside config/project locator; the SDK mock independently asserts effective `cwd` and `CLAUDE_CONFIG_DIR`.

Every created proxy enters an ownership set. Cleanup still joins HTTP, actual GC, and the backend separately; a missing GC/backend hook now fails instead of becoming a resolved no-op. A backend leaves the set only after its close promise resolves. Held SDK/log controls are not reset while that owner remains. The next case refuses admission while a prior proxy is unjoined. File teardown restores environment and deletes the private root only when the set is empty. The root is outside preload's unconditional temp teardown so a failed/unjoined owner cannot lose its namespace through that hook. SDK/log/MCP controls are process-owned (using existing test setters), not auto-cleared while an unjoined backend can remain.

## Unchanged constants and assumptions

- Main admission/response budget: **10,000 ms**, shared exactly as before.
- Each cleanup phase budget: **5,000 ms**, exactly as before.
- Each case and explicit Bun invocation timeout: **30,000 ms**, exactly as before.
- Three overlapping requests, with both `together` and `reverse order` cases.
- All production GC/deletion/lock/SDK settings remain unchanged. Preload's existing maximum-pending test knob remains unchanged.
- The authorized `npm test` process chain is the supported full-suite entrypoint; bare all-files `bun test` is already documented as unsupported and would not provide this new file's dedicated-process guarantee.
- Dependency symlink uses the parent-authorized existing `/Volumes/DevSSD/meridian/review-1220-20261103/node_modules`; no dependency installation was performed.
- Parent requires the existing native SQLite test-library bridge for future runtime commands: `MERIDIAN_TEST_SQLITE_LIBRARY=/opt/homebrew/opt/sqlite/lib/libsqlite3.3.53.4.dylib` (no product setting change).

## Freeze and first execution evidence

Source was copied to SHA256-named read-only files and hashes verified before execution. Initial source custody is in `/Volumes/DevSSD/meridian/concurrent-fixture-isolation-20261103-validation/freeze-manifest.json`; corrected custody is in `/Volumes/DevSSD/meridian/concurrent-fixture-isolation-20261103-validation/freeze-manifest-v2.json`. No old source or log was overwritten.

Current corrected source hashes:

- `package.json`: `66021fc0fcde62ab4d57a3a168cbf7c1901176434cd69f7c570ffbe984ba2d74`
- `src/__tests__/integration.test.ts`: `d4ea1775427c3e9826a915a8e98afa2579e2197240d7053ec279bb601e36805a`
- `src/__tests__/integration-concurrent.test.ts`: `5eb9fcc414add8a8ff7d2fd16c4161a491f4205d712e1383c0d4c43fbc87e817`

First execution: `bun test --timeout 30000 src/__tests__/integration-concurrent.test.ts`, Bun 1.3.14, exit **1**, 0 pass / 2 fail / 18 assertions. Full log: `/Volumes/DevSSD/meridian/concurrent-fixture-isolation-20261103-validation/integration-concurrent.log`. First case reached all three mocked SDK writers held, then its new exact locator check rejected `/private/var/...` versus `/var/...`; HTTP, GC, backend cleanup all completed. Second case's preflight rejected the same path spelling. This is not a passing ownership result and not a GC timeout. It supplies direct evidence for canonicalizing the fixture root once.

## Corrected frozen validation

After the parent's build-completion release, each authorized command was run once with `MERIDIAN_TEST_SQLITE_LIBRARY=/opt/homebrew/opt/sqlite/lib/libsqlite3.3.53.4.dylib`. Source hashes were rechecked against the read-only v2 manifest immediately before each command.

| Command | Result | Evidence |
| --- | --- | --- |
| `bun test --timeout 30000 src/__tests__/integration-concurrent.test.ts` | Exit 0; 2 pass, 0 fail, 201 `expect()` calls; 1.96 s Bun total. Together case 198.79 ms, reverse case 116.27 ms. | `/Volumes/DevSSD/meridian/concurrent-fixture-isolation-20261103-validation/integration-concurrent-v2.log` |
| `bun test --timeout 30000 src/__tests__/integration.test.ts` | Exit 0; 11 pass, 0 fail, 52 `expect()` calls; 992 ms Bun total. | `/Volumes/DevSSD/meridian/concurrent-fixture-isolation-20261103-validation/integration-original.log` |
| `npm run typecheck` | Exit 0. | `/Volumes/DevSSD/meridian/concurrent-fixture-isolation-20261103-validation/typecheck.log` |

No cleanup deadline failure appears in the corrected concurrent log; both cases passed with all exact SDK and whole-sidecar locator checks, original ownership/publication assertions and bounded maintenance joins intact. This establishes the new fixture's isolation contract in the focused run, not a cause for the historical timeout. No unexplained green result replaces that old failure.

## Remaining verification

Parent owns final full-suite/build gates and adversarial review. This worker ran no full suite or build. No live client/model test is required to claim this test-only extraction changes no product behavior; none was performed. This report does not claim final-head full acceptance, a production fix, or resolution of the old five-second GC cause.
