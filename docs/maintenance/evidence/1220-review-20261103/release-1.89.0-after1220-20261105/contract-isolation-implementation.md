# Bookkeeping store contract test process isolation

## Scope and status

Implemented only the authorized `package.json` `scripts.test` correction in:

`/Users/rynfar/Library/Caches/meridian-validation.noindex/release-contract-isolation-20261105`

Parent-supplied base: current `origin/main` at `41d7b3e3`. No Git commands or network refresh were authorized or performed by this worker. The owner checkout and the `release-1.89.0-after1220-20261105` worktree were not read or edited.

No commands, test executions, commits, pushes, model calls, credential operations, runtime changes, assertion changes, timeout changes, dependency changes, version changes, or lockfile edits were performed. No constants changed.

## Change and review rationale

- Exclude `**/*bookkeeping-store-contract*` from the bulk `bun test ./src/__tests__` process.
- Invoke the unchanged `src/__tests__/bookkeeping-store-contract.test.ts` exactly once as its own `bun test --timeout 30000` process immediately after `bookkeeping-admission-seam.test.ts`, beside the existing native-backend isolation entries.
- The contract file changes process-global session-store backend/directory state and asserts offline migration/export behavior. A separate process prevents another suite file's in-flight GC from following its mutable directory selection into this fixture. This follows the existing `npm test` isolation pattern rather than weakening the contract or changing runtime semantics.
- The parent reports an archived original full-suite failure (`8293/65/1`) and an independent actual-source witness for an omitted-`storeDir` GC crossing mutable directory state between awaits. The originating caller in the original failure remains unproven. This correction does not claim otherwise.
- Reviewed `AGENTS.md`, the test script, the unchanged contract file, `ARCHITECTURE.md`, the session module spec, release/evidence skill guidance, and the Nix packaging reference. No module boundary, public contract, invariant, or runtime decision changes; no spec change is needed.
- Nix scope is dependency sections and `bun.lock` (plus Nix files themselves). A test-script-only edit changes neither dependency tree nor the fixed-output dependency hash, so no Nix hash update is called for.

## Static content review (not test execution)

- JSON parses before and after; only `scripts.test` differs at the JSON-value level.
- Removing the two additions reproduces the original script exactly. All existing ordering, timeouts, commands, and assertions remain intact.
- Bulk exclusion occurs once. The explicit contract-file invocation occurs once and runs after the other early native-backend isolation entries.
- The exclusion's matching test path is `src/__tests__/bookkeeping-store-contract.test.ts`; no other matching contract file is present under `src/__tests__`.
- The contract source remains byte-for-byte unchanged.
- The script retains fail-fast `&&` chaining. The contract suite is moved, not skipped.

## Frozen content identities

| Content | SHA256 |
|---|---|
| `package.json` before | `57c9b41d54a5c4d599ba5525c0af6b6f59b323923244ef19692a1bc550ee3b82` |
| `package.json` after | `8fb24b45555d84d319e9179e061f6a68b242905c9a3d97cb62c93f951ce43414` |
| unchanged contract test | `b4804b3c5a7b68492118a694e711f10b4f2e2f85d62aa34e1b7f734fcc8f4a10` |
| exact unified diff below (UTF-8, LF) | `9f2e4514c056b1e51f44502588a03b5c93e2d23069cd044f7064fb57142a1fdf` |

This worker's implementation is frozen at the after-file hash above. If another worker changes the file, re-review that new content; this record applies only to this content.

## Pending evidence owned by parent

No runtime pass is claimed. The deterministic paused-sweep negative control, focused checks, full `npm test`, typecheck, build, final-head CI, and remaining release/install validation remain open for the parent to run and record. No additional repository tests were added under this bounded task.

## Exact frozen diff

```diff
--- a/package.json
+++ b/package.json
@@ -26,7 +26,7 @@
     "postinstall": "node -e \"try{require('child_process').spawnSync(process.execPath,[require.resolve('@anthropic-ai/claude-code/install.cjs')],{stdio:'inherit'})}catch(e){console.error('[meridian] claude-code postinstall skipped:',e.message)}\"",
     "prepublishOnly": "bun run build",
     "pretest": "tsc --noEmit",
-    "test": "bun test ./src/__tests__ --timeout 30000 --path-ignore-patterns '**/*bookkeeping-admission-seam*' --path-ignore-patterns '**/*session-store*' --path-ignore-patterns '**/*store-mutation-loop-lag*' --path-ignore-patterns '**/*session-fingerprint-context*' --path-ignore-patterns '**/*priority-routing-integration*' --path-ignore-patterns '**/*proxy-async-ops*' --path-ignore-patterns '**/*models-auth-status*' --path-ignore-patterns '**/*proxy-context-usage-store*' --path-ignore-patterns '**/*proxy-passthrough-thinking*' --path-ignore-patterns '**/*proxy-thinking-setting*' --path-ignore-patterns '**/*session-recovery*' --path-ignore-patterns '**/*models.test*' --path-ignore-patterns '**/*replay-budget*' --path-ignore-patterns '**/*proxy-health-build*' --path-ignore-patterns '**/*follow-active-integration*' --path-ignore-patterns '**/*profile-credential-isolation*' --path-ignore-patterns '**/*header-settings-routes*' --path-ignore-patterns '**/*claude-executable-settings*' --path-ignore-patterns '**/*proxy-idle-guard-queue*' --path-ignore-patterns '**/*proxy-deny-hold-generating*' --path-ignore-patterns '**/*upstream-reachability-routes*' --path-ignore-patterns '**/*integration-concurrent*' --path-ignore-patterns '**/*store-lock-acquisition*' && bun test --timeout 30000 src/__tests__/integration-concurrent.test.ts && bun test --timeout 30000 src/__tests__/store-lock-acquisition.test.ts && bun test --timeout 30000 src/__tests__/bookkeeping-admission-seam.test.ts && bun test --timeout 30000 src/__tests__/proxy-async-ops.test.ts && bun test --timeout 30000 src/__tests__/proxy-session-store.test.ts && bun test --timeout 30000 src/__tests__/session-store-pruning.test.ts && bun test --timeout 30000 src/__tests__/proxy-session-store-locking.test.ts && bun test --timeout 30000 src/__tests__/session-fingerprint-context.test.ts && bun test --timeout 30000 src/__tests__/proxy-context-usage-store.test.ts && bun test --timeout 30000 src/__tests__/models-auth-status.test.ts && bun test --timeout 30000 src/__tests__/proxy-passthrough-thinking.test.ts && bun test --timeout 30000 src/__tests__/proxy-session-recovery.test.ts && bun test --timeout 30000 src/__tests__/proxy-thinking-setting.test.ts && bun test --timeout 30000 src/__tests__/models.test.ts && bun test --timeout 30000 src/__tests__/replay-budget.test.ts && bun test --timeout 30000 src/__tests__/proxy-health-build.test.ts && bun test --timeout 30000 src/__tests__/priority-routing-integration.test.ts && bun test --timeout 30000 src/__tests__/follow-active-integration.test.ts && bun test --timeout 30000 src/__tests__/store-mutation-loop-lag.test.ts && bun test --timeout 30000 src/__tests__/profile-credential-isolation.test.ts && bun test --timeout 30000 src/__tests__/header-settings-routes.test.ts && bun test --timeout 30000 src/__tests__/priority-session-store.test.ts && bun test --timeout 30000 src/__tests__/claude-executable-settings.test.ts && bun test --timeout 30000 src/__tests__/proxy-idle-guard-queue.test.ts && bun test --timeout 30000 src/__tests__/proxy-deny-hold-generating.test.ts && bun test --timeout 30000 src/__tests__/upstream-reachability-routes.test.ts && bun test --timeout 30000 --test-name-pattern 'naturally closes failed recovery|telemetry settings routes' ./scripts/fixtures/logger-mock-load-order.test.mjs",
+    "test": "bun test ./src/__tests__ --timeout 30000 --path-ignore-patterns '**/*bookkeeping-admission-seam*' --path-ignore-patterns '**/*bookkeeping-store-contract*' --path-ignore-patterns '**/*session-store*' --path-ignore-patterns '**/*store-mutation-loop-lag*' --path-ignore-patterns '**/*session-fingerprint-context*' --path-ignore-patterns '**/*priority-routing-integration*' --path-ignore-patterns '**/*proxy-async-ops*' --path-ignore-patterns '**/*models-auth-status*' --path-ignore-patterns '**/*proxy-context-usage-store*' --path-ignore-patterns '**/*proxy-passthrough-thinking*' --path-ignore-patterns '**/*proxy-thinking-setting*' --path-ignore-patterns '**/*session-recovery*' --path-ignore-patterns '**/*models.test*' --path-ignore-patterns '**/*replay-budget*' --path-ignore-patterns '**/*proxy-health-build*' --path-ignore-patterns '**/*follow-active-integration*' --path-ignore-patterns '**/*profile-credential-isolation*' --path-ignore-patterns '**/*header-settings-routes*' --path-ignore-patterns '**/*claude-executable-settings*' --path-ignore-patterns '**/*proxy-idle-guard-queue*' --path-ignore-patterns '**/*proxy-deny-hold-generating*' --path-ignore-patterns '**/*upstream-reachability-routes*' --path-ignore-patterns '**/*integration-concurrent*' --path-ignore-patterns '**/*store-lock-acquisition*' && bun test --timeout 30000 src/__tests__/integration-concurrent.test.ts && bun test --timeout 30000 src/__tests__/store-lock-acquisition.test.ts && bun test --timeout 30000 src/__tests__/bookkeeping-admission-seam.test.ts && bun test --timeout 30000 src/__tests__/bookkeeping-store-contract.test.ts && bun test --timeout 30000 src/__tests__/proxy-async-ops.test.ts && bun test --timeout 30000 src/__tests__/proxy-session-store.test.ts && bun test --timeout 30000 src/__tests__/session-store-pruning.test.ts && bun test --timeout 30000 src/__tests__/proxy-session-store-locking.test.ts && bun test --timeout 30000 src/__tests__/session-fingerprint-context.test.ts && bun test --timeout 30000 src/__tests__/proxy-context-usage-store.test.ts && bun test --timeout 30000 src/__tests__/models-auth-status.test.ts && bun test --timeout 30000 src/__tests__/proxy-passthrough-thinking.test.ts && bun test --timeout 30000 src/__tests__/proxy-session-recovery.test.ts && bun test --timeout 30000 src/__tests__/proxy-thinking-setting.test.ts && bun test --timeout 30000 src/__tests__/models.test.ts && bun test --timeout 30000 src/__tests__/replay-budget.test.ts && bun test --timeout 30000 src/__tests__/proxy-health-build.test.ts && bun test --timeout 30000 src/__tests__/priority-routing-integration.test.ts && bun test --timeout 30000 src/__tests__/follow-active-integration.test.ts && bun test --timeout 30000 src/__tests__/store-mutation-loop-lag.test.ts && bun test --timeout 30000 src/__tests__/profile-credential-isolation.test.ts && bun test --timeout 30000 src/__tests__/header-settings-routes.test.ts && bun test --timeout 30000 src/__tests__/priority-session-store.test.ts && bun test --timeout 30000 src/__tests__/claude-executable-settings.test.ts && bun test --timeout 30000 src/__tests__/proxy-idle-guard-queue.test.ts && bun test --timeout 30000 src/__tests__/proxy-deny-hold-generating.test.ts && bun test --timeout 30000 src/__tests__/upstream-reachability-routes.test.ts && bun test --timeout 30000 --test-name-pattern 'naturally closes failed recovery|telemetry settings routes' ./scripts/fixtures/logger-mock-load-order.test.mjs",
     "typecheck": "tsc --noEmit",
     "proxy:direct": "bun run ./bin/cli.ts"
   },
```
