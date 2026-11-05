# Adversarial review: bookkeeping contract process isolation

Date: 2026-11-05

## Verdict

**No material finding in this bounded test-only correction.** The change preserves the contract assertions and makes their separate process a mandatory `npm test` gate. It is suitable as test-execution isolation, not as a proven causal fix for the original full-suite failure and not as release approval.

The original interfering caller remains unproven. The deterministic control establishes a possible cross-fixture interference mechanism and an isolation boundary; it does not identify that historical caller or establish that every historical failure had this cause.

## Reviewed identity and method

- Worktree: `/Users/rynfar/Library/Caches/meridian-validation.noindex/release-contract-isolation-20261105`
- Branch: `fix/release-contract-test-isolation-20261105`
- Base: `41d7b3e3a2ead7e95e2790cc473b469bd3e9b567`
- Reviewed head: `d0904187c89631a459fa60a112332632b7fd75c4`
- Git object/tree inspection confirms the committed diff contains only `package.json`. A content-hash comparison of all 2447 tracked worktree entries found no differences from that head.
- Parsed JSON and shell tokens were inspected, not just the one-line textual diff. Only `scripts.test` differs at the JSON-value level.
- `package.json` SHA256: `8fb24b45555d84d319e9179e061f6a68b242905c9a3d97cb62c93f951ce43414`
- Unchanged contract SHA256: `b4804b3c5a7b68492118a694e711f10b4f2e2f85d62aa34e1b7f734fcc8f4a10`

This was an independent file/object review. No commands, test runs, network requests, models, credentials, source edits, Git writes, or CI queries were performed. The only written artifact is this review. Recorded execution results below are attributed to the supplied control artifacts, not to a new execution by this reviewer.

## Assertions and execution coverage

The parsed script adds exactly:

1. Bulk-process exclusion: `--path-ignore-patterns '**/*bookkeeping-store-contract*'`.
2. Separate command: `bun test --timeout 30000 src/__tests__/bookkeeping-store-contract.test.ts`, immediately after the existing isolated bookkeeping admission seam command.

The pattern currently matches only `src/__tests__/bookkeeping-store-contract.test.ts`. The standalone invocation has no name filter, skip flag, preload bypass, swallowed exit, or tolerance clause. Existing commands remain ordered and unchanged; the `&&` chain stays fail-fast. The existing `pretest` typecheck and every 30000 ms timeout remain unchanged. The chain grows from 28 to 29 commands: the file moves rather than disappears.

I read all six tests, including setup, teardown, and the Node-target CLI build/export/inspect path. The complete file is byte-identical to the base. It still covers:

1. Scalar NUL rejection for keys, IDs, owner tokens, and locator paths before SQL mutation; empty mappings and fence slots afterward.
2. NUL payload round-trip through the facade and CLI export, with changed imports retiring legacy-export bytes.
3. Migration/export of the reserved NUL metadata key without creating a mapping for it.
4. Visibility of uncommitted writes, copied lookup results, and rollback when the transaction callback returns false.
5. No aliases to caller-owned locators, returned lookup objects, or snapshots.
6. Reduced-schema refusal through CLI inspect, including exit 5, corrupt phase, and export guidance.

## Test seam, product fit, and production-fault challenge

`bunfig.toml` retains the normal test preload. That preload creates per-process configuration/session/temp roots, while files inside one Bun process share the module globals. The contract deliberately changes the process-global session directory and selected backend in its fixture hooks. Running this offline migration/export contract in a fresh process follows the existing suite isolation pattern and avoids an unrelated fixture's outstanding work inheriting those globals.

The relevant boundary is explicit: `sessionStore.ts:701-709` describes `setSessionStoreDir` as test-only; the backend selection seam is also explicitly fixture/embedder-test scoped. No runtime `src` caller switches the directory through that setter. `sessionLifecycle.ts:1336-1338` can re-read the global directory when no explicit `storeDir` is supplied, so deliberately changing that test global during outstanding asynchronous work can redirect a later operation. The review does not treat this artificial directory switch as a supported production configuration change.

The correction changes no runtime code, maintenance refusal, lock handling, cache/session format, public interface, dependency boundary, or production invariant. In particular, it does **not** make offline migration safe while a real writer is active. A migration encountering a genuinely live candidate should still refuse. Existing unchanged coverage for live-candidate refusal in `bookkeeping-cli.test.ts:144-157` and observable-publication-owner refusal in `bookkeeping-migration.test.ts:119-126` remains in the bulk suite, not in the newly excluded filename family.

Thus there is no evidence in this diff that a known supported-production failure is being concealed. It intentionally stops relying on accidental cross-file global-state interaction as a contract test. The historical caller and any broader production-fault claim remain outside the proof.

## Negative-control evidence and limits

Inspected `contract-isolation-control-receipt.json`, the complete frozen helper, and `contract-isolation-control.log`. Helper SHA256 independently matches both its filename and receipt:

`3ef55d99979c6102e4eccb4249e464af3eae07e4f29117e81a3edc91e6de4994`

The helper uses actual `runGc`, store, and migration code. It switches the test directory during the sweep, then pauses `fs/promises.link` before the second directory's lifecycle lock is published. The real candidate has already been initialized and synced by `createInitializedSidecarLockCandidate`. While that candidate is live:

- Same-process migration of that second directory must reject with `live residue:`.
- A fresh Bun process runs the unchanged six-test contract and must exit 0 and report `6 pass`.
- Only after release and awaiting the actual GC promise may migration of the same parent directory resolve to READY.

The recorded log reports 1 pass, 0 fail, and 5 expectations, consistent with the helper and receipt. This is stronger than an unexplained green rerun: it preserves the legitimate refusal and tests the process boundary while the candidate is held. The child uses its own contract fixtures; it does not migrate the parent's active directory. That is the intended isolation proof, not proof that a live-writer migration now succeeds.

The receipt baseline is `e6c5604309fb9aa870e1200321cde4e1072aa3c8`, not the reviewed head. I verified that the helper's implicated store, lifecycle, migration, contract, preload, and Bun configuration files are byte-identical between that baseline and the reviewed worktree. The helper still constructs a specific interleaving; it is not a reproduction identifying the original caller.

## Packaging and remaining gates

Dependencies, devDependencies, version, lockfiles, and Nix files are unchanged. A test-script-only edit does not change the dependency tree or require a Nix dependency-hash update. No constants changed, including timeouts.

Assumptions: the reviewed local Git base is the requested comparison point; live upstream freshness was not rechecked under this read-only/no-network brief. The supplied execution receipt/log are retained evidence, not independent execution here.

Final-head local validation, required CI, any later merge authorization, and separate release/install/live-client gates remain the parent's responsibility. This review neither claims those gates passed nor authorizes publication.
