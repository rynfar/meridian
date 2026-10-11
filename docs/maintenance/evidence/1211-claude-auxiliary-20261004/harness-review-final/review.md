# #1211 independent corrected harness review

Reviewed corrected blobs at `c237ab9a0d332f6cf3292fc7de2eaf0026fc2037` after the complete initial `f11e60e5b2480bd76a6d5921b8386f58ae53856c` review. H1–H5 are resolved; no remaining material finding in the bounded correction scope. `885b4005` contains harness/test/fixture corrections; later `c237ab9a` archives historical snapshots only. `src/proxy` has no delta from the production head already reviewed.

## H1 — resolved

SDK ownership is retained by query row; SDK IDs crossing query rows and HTTP IDs recurring in complete terminals make nativeReceipts false. Existing canonical arguments and own outside-write checks remain.

Before log independently shows both added ID controls expected exit1/received0. Final receipt reports both pass; no real SDK invocation by reviewer.

Code: scripts/e2e-claude-code-auto-mode.mjs:229-231,320-323,388-403. Control: src/__tests__/claude-auto-mode-harness.test.ts:164-168.

## H2 — resolved

Result boolean validity retained without coercion. Success requires is_error false, narrow error_max_turns requires true plus cap/nativeTurns/terminal/tool constraints.

Before loop reaches only missing success flag (expected exit1/received0); final loop executes missing success and false max-turns. Missing/nonboolean max-turns statically reject via resultFlagValid and strict boolean predicate, without a separate claimed before run.

Code: scripts/e2e-claude-code-auto-mode.mjs:326-331,389. Control: src/__tests__/claude-auto-mode-harness.test.ts:170-173.

## H3 — resolved

Start actual Meridian with silent:false while contained console observer remains active; synthetic target asserts/honors actual silent semantics rather than bypassing them.

Real direct caller/callee inspection establishes suppressed decision cause. Before positive fixture fails with prior silent switch; corrected positive passes. No native client/model was run.

Code: scripts/e2e-claude-code-auto-mode.mjs:45-53,342; src/proxy/server.ts:562,683,2984. Control: src/__tests__/claude-auto-mode-harness.test.ts:26,36,135-136.

## H4 — resolved

Output is exclusively reserved with wx before setup/version/grant operations, descriptor checked regular/owned/0600/single-link and held through final write. Existing output is neither written nor deleted.

Before loop demonstrates first symlink target overwrite, then stops. Final cases reject symlink, hardlink and regular output with zero query marker and unchanged target bytes/inode/link count. No links to owner credentials used.

Code: scripts/e2e-claude-code-auto-mode.mjs:29-40,456-457. Control: src/__tests__/claude-auto-mode-harness.test.ts:114-134.

## H5 — resolved

Bounded SSE receipt now requires start, unique block indices/open-block input, all block closure before tool_use terminal delta, then stop; late content/error invalidates. Ping is benign; this is not complete Anthropic grammar validation.

Before ordered-receipt control reaches missing-start first, expected exit1/received0. Final runs missing-start, early-stop, post-terminal content, duplicate-index and input-after-close; canonical JSON/SSE positive and incomplete-terminal negative remain.

Code: scripts/e2e-claude-code-auto-mode.mjs:176-232. Control: src/__tests__/claude-auto-mode-harness.test.ts:155-159,175-178.

## Added shutdown fixture

Entire 101-line new helper read; private stub/config/plugin paths, factory and default-store operation spies, auth/resolver/organization/update fences, counters, awaited owner join before restoring boundaries/env and removing private state inspected.

Entire 391-line test and complete correction diff read; 10 original assertions/timing cases unchanged, owned direct-app factories/listener tracked, barriers released and listeners close before store/fence cleanup; direct-app getInFlightCount bounds replace arbitrary teardown sleep.

The counters establish controlled after-fixture interception and zero fixture writes only. They do not prove an earlier real credential refresh occurred. This helper fences non-subject side effects while the unchanged real HTTP drain/mapping assertions remain the subject.

## Coverage

- `scripts/e2e-claude-code-auto-mode.mjs`: 460 lines, SHA-256 `01a842ec9327517b265e301bb075c7e1de99de289343e2d30e6811cfdb08589a`. Entire corrected 460-line harness read after complete initial read; all correction hunks, unchanged native SDK observer and real server logging caller/callee, per-request classifier/header facts, descriptor safety, bounded cleanup and final proof checks inspected.
- `src/__tests__/claude-auto-mode-harness.test.ts`: 198 lines, SHA-256 `2098c3b077054a47559fe67049f2027d6c2c3b4b08e1ee1ab0f8b1ee5807e832`. Entire corrected 198-line fixture/test read. New duplicate SDK ownership/HTTP terminal controls, strict flag controls, exclusive output link/file cases, actual silent behavior and all five SSE order modes inspected; prior positive, refusal, model, classifier, cleanup and retention controls retained.
- `E2E.md`: 7507 lines, SHA-256 `69058c010d7b3f71d3c347ce38b7492a4ac03b9fdd8c42e1b9bca26e9faf6655`. All correction changed hunks and applicable E71 section reviewed; literal boolean result flags, unique receipt ownership, exclusive held output and ordered bounded SSE requirement match code. Unrelated full E2E body not re-reviewed.
- `docs/maintenance/evidence/1211-claude-auxiliary-20261004/README.md`: 101 lines, SHA-256 `988aa77b79e8708774432987b0440be1f8a41ceed22a42c71049854934022985`. Entire 101-line narrative and correction link read; exact internal AgentIdentity design citation resolves and confirms premise. Native Linux/client/model gates remain open; final manifest/local-gate update is separate pending scope.
- `src/__tests__/fixtures/proxy-boundary-fences.ts`: 101 lines, SHA-256 `c6cb8c09d9f3bec9e5b0ed1648d11c3734e1effb116079fa6decd6187800fd10`. Entire 101-line new helper read; private stub/config/plugin paths, factory and default-store operation spies, auth/resolver/organization/update fences, counters, awaited owner join before restoring boundaries/env and removing private state inspected.
- `src/__tests__/graceful-shutdown.test.ts`: 391 lines, SHA-256 `32d53b69a5c5b40fc5607a1c9198977b728a9266566f0b88735d16bd3212a881`. Entire 391-line test and complete correction diff read; 10 original assertions/timing cases unchanged, owned direct-app factories/listener tracked, barriers released and listeners close before store/fence cleanup; direct-app getInFlightCount bounds replace arbitrary teardown sleep.

## Limits

- Reviewer ran no tests/suites/probes/native clients/models/auth/network/GitHub operations and made no repository edits. Only temporary review artifacts were written.
- Root-supplied direct focused harness receipt reports 19 pass / 0 fail / 501 assertions; typecheck receipt has exit-zero content. Shutdown receipt reports 10 pass / 0 fail / 41 assertions. These are independently inspected receipts, not reviewer-executed tests.
- Shutdown counters auth10/resolver2/storeFactories10/proactive9/background1/plugin1/storeWrites0 prove the controlled after fixture intercepted those boundaries. Static prior discovery and old green output do not establish an earlier real refresh, read or credential write.
- Initial full npm pretest at f11e stopped before suite with TS2345 new harness test audit.account union; runtime guard now narrows path without cast/suppression. No final full-suite pass is claimed here.
- Current root evidence manifest/full gates will be inspected only after creation on explicit follow-up; this packet does not claim complete escrow integrity review.
- Actual Linux x64/implicated Claude Code/selected installed SDK and CLI/exact served Sonnet E71, E55 parity and all four E41 remain acceptance gates. Synthetic positive results always retain acceptance false; historical source reports and static official binary trace do not supply runtime proof.
- No remaining material finding within this correction delta and added shutdown fixture scope. No new public API contract change or owner-directed defer inferred.
