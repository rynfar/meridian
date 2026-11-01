# Meridian review checkpoint — 2026-11-01 UTC

Last code delivery: `84043282aec4c83e29bc052943140abdeca8754a` (#1477). The 2026-11-01 review of the new contributor PRs is recorded first; older sections below are unchanged history. The previous checkpoint is [immutable at 95b3af5a](https://github.com/rynfar/meridian/blob/95b3af5a2441731285c6c0dbfb29fc0b72411bf8/docs/maintenance/REVIEW_HANDOFF.md).

## 2026-11-01: new contributor PRs reviewed, #1471 and #1477 merged

The owner asked to review the new contributor PRs, merge the ready ones, put corrections on the contributors' branches, and keep their credit, following this guidance. No PR comment, release, account switch or credential change was made. The review base was `origin/main` `4d16958a`.

- **Queue:** #1471, #1475, #1476, #1477 and #1478 (opened 2026-10-29 to 31).
  - Not reviewed: #1464 (Zed adapter) is the contributor's draft; Release Please #1469 and the owner's draft #1468 are out of scope.
  - Each PR had an independent adversarial review in an isolated worktree, local gates, and model-free E2E. Per-PR records: [review-20261101](evidence/review-20261101/).
- **Merged, contributor as Git Author.** Each was an exact-head squash, and each landed tree equals the reviewed parent merged with the validated head.
  - [#1471](https://github.com/rynfar/meridian/pull/1471) `6056b54a`, Author Connor Grady: a profiles-only deployment no longer checks or keeps warm the unused default auth context. The maintainer added a keepalive test and a spec decision on his branch. Merge state was `CLEAN`. [Record](evidence/review-20261101/pr-1471.md).
  - [#1477](https://github.com/rynfar/meridian/pull/1477) `84043282`, Author Máté Rémiás: `/`, `/profiles` and, through the maintainer's correction, `/providers` stop polling usage while their tab is hidden. Merged `--admin` under the step-3 `bad_email` exception, after every check on head `7183e85a` passed. [Record](evidence/review-20261101/pr-1477.md).
  - On the combined main, typecheck, a certified build and both PRs' targeted tests pass.
- **Corrected, held for owner decisions:** [#1475](https://github.com/rynfar/meridian/pull/1475), head `c353a485`, all checks green, `CLEAN`.
  - Maintainer fixes are on Connor's branch for the Home Manager env harness, the manual `nix-update` command and the E2E.md plugin path.
  - Validated on aarch64-linux Nix, including consumer overlays and the claude-code floor. [Record](evidence/review-20261101/pr-1475.md).
- **Corrected, live gate open:** [#1478](https://github.com/rynfar/meridian/pull/1478), head `1718878b`, all checks green, merge blocked only by unsigned commits.
  - The maintainer correction makes the rendered `tool_reference` text name the registered tool (#1107 class).
  - Model-free runs pass: real Claude Code 2.1.316 against a scripted upstream, with before/after, sequential, parallel and fresh-replay cases and an OpenCode-shaped negative control.
  - Live Sonnet/Opus 5.5 runs and the four E41 modes could not run: the active Claude account answered "You've hit your weekly limit · resets Nov 4". [Record](evidence/review-20261101/pr-1478.md).
- **Deferred, design decision:** [#1476](https://github.com/rynfar/meridian/pull/1476), head `ef3ac97e`, nothing pushed. The change honours Pi's cache-only startup phase, but without a usable catalog `--model meridian/…` then fails in every Pi mode. With `defaultProvider: meridian`, Pi silently starts on its direct Anthropic provider. `scripts/e2e-pi-extension-side-calls.mjs` breaks. [Record and options](evidence/review-20261101/pr-1476.md).
- **Live model use:** one real-model run of #1476's modified `scripts/e2e-pi-extension.mjs` passed (4 Pi requests, no refusal). One #1478 request was refused by the weekly limit, and live calls stopped there. Meridian reports quota utilization as 0..1: `1` means 100%, not 1%.
- **Owner decisions:**
  1. **#1475:** keep `packages.<system>.meridian` requiring `NIXPKGS_ALLOW_UNFREE=1 --impure`, with docs steering NixOS configurations to the overlay (recommended)? How should the release notes name the consumer-facing changes, given `refactor` is hidden there (recommended: a `fix(nix):` title)? Should Connor make the `src`-before-version reorder in `nix/pkgs/claude-code/package.nix`, or should it be a follow-up?
  2. **#1478:** run the live gate on another profile with included usage now, or on the current account after the Nov 4 reset?
  3. **#1476:** the strict cache-only phase as proposed, a bounded (about 1 s) cold-start fetch (recommended, which should go to the contributor first), or decline?
  4. **Comments:** draft review comments for all five PRs are prepared but not posted. Posting needs authorization. #1471's description says the instance exits at startup; with the bundled CLI it warns and keeps running.
- **Follow-ups:**
  - The CLI start-up check treats `claude auth status` exiting 1 as "could not verify", so a logged-out instance with no profiles warns instead of exiting. Fix this after #1471.
  - `proxy-async-ops.test.ts`'s first test reads the default credential store (the macOS login Keychain) during local `npm test`.
  - Meridian Desktop's main process polls usage every 10 s while its window is hidden.
  - ARCHITECTURE.md's agent-specific table is titled for OpenCode and cannot list #1478's `clientOwnsToolSearch`.
  - Escrow #1478's Claude Code tool-search harness in a maintainer PR once its live gate runs.
- **Attribution audit:** `scripts/attribution-audit.mjs` reran on main `84043282` in an isolated blob-less clone, and [the ledger](ATTRIBUTION_LEDGER.md) is regenerated.
  - #1471 and #1477 are classified `merged`.
  - "Re-landed with the maintainer as Author" stays at 137, so there is no new maintainer re-land.
  - The one new "Closed in favor of a maintainer PR" row is the earlier owner-approved #1243 decline (closed 2026-10-21, whose comment cites #1433). It is not from this run.
- **Workspace:**
  - Removed: the #1471/#1477 review worktrees, their local branches, the baseline worktree and the #1471 base copy.
  - Kept for continuation, under `/Volumes/DevSSD/meridian`: the review worktrees `wt-review-1475`, `wt-review-1476` and `wt-review-1478`, with sanitized local evidence in `evidence/review-20261101/`, and the Docker volume `pr1475-nix` holding #1475's Nix store.
  - The owner's checkout was not touched.
- **Local test environment (this Mac):**
  - Bun 1.3.14 loads Apple's SQLite 3.51.0, which the bookkeeping engine refuses: about 1,054 tests fail on unchanged main. Use `MERIDIAN_TEST_SQLITE_LIBRARY=/opt/homebrew/opt/sqlite/lib/libsqlite3.3.53.4.dylib`.
  - The `npm test` script chains its 26 groups with `&&`, so a group-0 failure hides groups 1–25. Run each group separately.
  - Under concurrent load, real-process and real-socket tests in error-reporting, stream-idle-guard, plugin-update-routes and cross-process-turn-coordinator fail on unchanged main too.

## 2026-10-26/27: backlog run and 1.87.0 published

The owner authorized the following for this run:

- reviewing and merging the queue;
- live model calls on included usage only, stopping on Extra Usage, 402 or `billing_error`, with no account or model switching;
- PR and issue comments;
- scrub releases;
- release 1.87.0.

Each PR below was adversarially reviewed and live- or headless-tested before merge. The review record is on the PR.

- **Contributor PRs merged, contributor as Git Author:**
  - [#1443](https://github.com/rynfar/meridian/pull/1443) `662fd4c1`: settings rows. The two fields were removed on the owner's decision.
  - [#1445](https://github.com/rynfar/meridian/pull/1445) `a70a9925`: plugin update check, under the same toggle as Meridian's own.
  - [#1446](https://github.com/rynfar/meridian/pull/1446) `72da1744`: duplicate-account flags and in-place refresh. This is the UI only; shared-quota routing was split out.
  - [#1410](https://github.com/rynfar/meridian/pull/1410) `9d971d50` and [#1444](https://github.com/rynfar/meridian/pull/1444) `cb377858`: shared passthrough tool definitions and lists, with heap evidence.
  - [#1429](https://github.com/rynfar/meridian/pull/1429) `19b0f762` (materemias): lists banked resets and redeems one only explicitly.
  - [#1261](https://github.com/rynfar/meridian/pull/1261) `3548ff28`: transcript cleanup, narrowed to an opt-in that deletes what Claude Code's own cleanup deletes. `transcriptSweep` is not exported.
  - [#1193](https://github.com/rynfar/meridian/pull/1193) `1b643b1a` (XInTheDark): optional prompt-cache keepalive. It is operator-only and off by default, beats near the 1-hour expiry, and lasts up to 3 hours. Maintainer corrections went on the contributor's branch.
  - [#1463](https://github.com/rynfar/meridian/pull/1463) `25345754`: a ChatGPT seat is listed as it was while its renewal is out.
- **Maintainer PRs:**
  - [#1455](https://github.com/rynfar/meridian/pull/1455): spec graph.
  - [#1456](https://github.com/rynfar/meridian/pull/1456): closes #1449, `~` in `PI_CODING_AGENT_DIR`.
  - [#1458](https://github.com/rynfar/meridian/pull/1458): closes #1448, V2 compaction keeps the conversation's tier.
  - Bot PRs [#1459](https://github.com/rynfar/meridian/pull/1459) and [#1462](https://github.com/rynfar/meridian/pull/1462).
  - #1311 was closed (not planned): existing headers already cover it.
- **Signing exception used once:** #1429's commits are signed but GitHub cannot verify them (`bad_email`). The owner approved an `--admin` exact-head squash on 2026-10-26, and [contributing.md](../../.agents/references/contributing.md) now records that case.
- **Scrub releases:** opencode-scrub 0.3.0 (#20) and pi-scrub 0.2.3 (#15) are published and verified.
- **Release [1.87.0](https://github.com/rynfar/meridian/releases/tag/meridian-v1.87.0) is published.**
  - Gates: full gates, a packed-tarball OpenCode V1 and Pi E2E, and a fresh registry install.
  - Published: npm `latest` with provenance, plus Docker `1.87.0`/`1.87`.
  - `desktop / mac` again failed Apple notarization (HTTP 401).
  - [Release record](evidence/release-1.87.0-20261027/README.md).
- **Filed:** #1451 (warn when Pi traffic lacks pi-scrub), #1460 (the header shows the active profile while priority routing serves from another), and #1461 (an E41 cyber refusal on Opus 5.5 silently falls back to Opus 4.8). #1450 remains open.
- **Follow-ups:**
  - Replace the CI Apple notarization credential.
  - Desktop does not reload a dead renderer.
  - The startup model-catalog warm-up fetches (npm, GitHub, chatgpt.com) have no off switch.
  - Nowaker follow-ups for #1261: an idle sweep with custody, and pin-aware cleanup.
  - Shared-quota routing for #1446.
  - #1193 keepalive beats are not shown while retention is on.
- **Not done:** the owner's launchd service (port 3456) still runs 1.86.0. An upgrade is handed to a separate agent, because this run is served through that service.

## 2026-10-26: 1.86.0 published

- **Release [1.86.0](https://github.com/rynfar/meridian/releases/tag/meridian-v1.86.0) is published and installed-package validated** (owner-authorized). Merge `e521c5feb190d1b73b812b42bb51d1d068b3f11c` from Release Please #1438 head `a9e2c95a`. npm `latest` with provenance; Docker `1.86.0`/`1.86` for amd64 and arm64.
- **Desktop download missing:** the release's `desktop / mac` job failed at Apple notarization (HTTP 401), as for 1.85.0. The owner's app was built and installed locally from the tag.
- **#1453** (merged `5359f634`) fixed the Pi extension missing pi-subagents' appended-prompt marker, found during live proof of #1408; saved-session resume and in-process pi-subagents are now qualified.
- **Follow-up:** Meridian Desktop does not reload a window whose renderer process is gone, which leaves an empty glass panel.
- [Release record](evidence/release-1.86.0-20261026/README.md).

## 2026-10-25: #1408 delivered, 1.86.0 reviewed

- **[#1408](https://github.com/rynfar/meridian/pull/1408), merged `bd021733deb054bbb95cacc0383fa816469e5773`.** Git Author: Nate Berkopec; the maintainer is credited with a `Co-authored-by` trailer.
  - Nate's signed original `33357ce4` and eight signed maintainer corrections were added to his branch by fast-forward (`388b05bb`). Normal exact-head squash; the tree is identical to the validated head.
  - Corrections:
    - side calls keep the conversation's model tier (`fork-side-call`);
    - setup moves aside a non-Meridian `extensions/meridian`;
    - `--client=pi` and `~` in `PI_CODING_AGENT_DIR` work;
    - migration docs and known limits.
  - The owner approved the `pi1`, `plugin.pi` and `MERIDIAN_SOURCE` contracts (recorded in `api-contract.md`).
  - Two independent adversarial reviews; their findings were fixed or recorded.
  - Local gates: typecheck and build pass. All 26 test groups ran: 8,131 pass, 63 skip, 14 fail. The 14 failures are environmental (real-process SQLite children on Bun's system SQLite 3.51.0) and fail identically on unchanged main. All hosted checks pass.
  - Live evidence: real Pi 1.4.0/1.3.0 wire identity and compaction side calls pass. [Review, live evidence, gates and artifacts](evidence/1408-pi-extension-20261025/README.md).
- **Pi generation gate closed (correction).** The recorded Extra Usage refusals came from harnesses run without the Pi scrub server plugin. With pi-scrub, real Pi 1.4.0 generation through the extension passes, including the tool loop, the child and Opus 5.5 at high effort. The 1.79.0 "no content" control was a separate 1.79.0 streaming bug that current main fixes. `scripts/e2e-pi-extension.mjs` now requires the scrub, and the Pi docs and setup say it is needed. [Correction](evidence/1408-pi-extension-20261025/README.md#correction-the-generation-refusal-was-a-missing-scrub-2026-10-25).
- **Follow-ups (filed as #1448, #1449, #1450):**
  - OpenCode V2 compaction still uses the 200k `subagent-compaction` tier on Opus and Fable 1M; needs an owner decision.
  - `antigravitySetup.ts` lacks `~` expansion for `PI_CODING_AGENT_DIR`.
  - A Pi side call does not inherit its conversation's `[1m]` rate-limit pause.
  - The remaining Pi known limits are listed in `docs/agents.md`.
- **Release Please [#1438](https://github.com/rynfar/meridian/pull/1438) proposes 1.86.0 (head `49245d4e`). Publication is not authorized.**
  - The candidate tarball was installed into an isolated prefix: Pi setup, `/health`, a stale-copy negative control, Pi discovery and plain generation pass.
  - An independent release review found no code or packaging blocker and recommends adding an upgrade note for #1426's `x-session-id` behavior.
  - The candidate's workflows were waiting for approval and have been approved; check their results on #1438 before any release decision.
- **Workspace:** the #1408 integration, unchanged-main comparison and release-candidate worktrees, the local integration branch, the installed prefix and every scratch Pi and Meridian directory from this continuation have been removed. The owner's root checkout and its uncommitted files were not touched. This approved continuation delivered two contributor PRs, the approved decline, and its tracking issue. The earlier blocked-goal audit preceded the new owner approvals; it is historical and does not mean every remaining item has the same blocker.

Release [1.86.0](https://github.com/rynfar/meridian/releases/tag/meridian-v1.86.0) is published and verified (see above). Mac notarization is still deferred. No subsequent release is authorized. External comments remain restricted to explicit authorization: this continuation posted only the approved #1243 explanation and created the approved #1441 tracking issue. No comments were posted on #1261 or #1094.

## Delivered

- **[#1426](https://github.com/rynfar/meridian/pull/1426), merged `a5a939be8e3bd43e73b8750963900568530e6445`.** Actual Git Author Alex Gleason <alex@alexgleason.me>; signed squash, reviewed parent 075e9e47 and exact candidate-tree match. Owner-approved generic OpenAI conversation header contract is recorded in **[#1441](https://github.com/rynfar/meridian/issues/1441), now completed**. Original signed 337ccc9 and separate signed maintainer corrections remain on Alex's branch at 88dee56a. Normal exact-head squash, no admin/check bypass. [Review and71 remotely verified archive members](evidence/1426-approved-session-header-20261021/README.md), [Author/tree receipt](evidence/1426-approved-session-header-20261021/POST-MERGE.json), [issue completion](evidence/1426-approved-session-header-20261021/TRACKING-RESOLVED.json).
- **[#1440](https://github.com/rynfar/meridian/pull/1440), merged `c84af243708578c0f15c92acad90fa68e364aaa9`.** Actual Git Author Damian Nowak <spam@nowaker.net>, GitHub accountNowaker. This is the contributor's display name, with the original source email; it is not a maintainer re-land. Original signed e4bc487e and separate signed test/main-merge corrections remain on Nowaker's branch at 9b54e310. Signed normal exact-head squash, parent a5a939be, exact validated-tree match. [Review and25 remotely verified proof members](evidence/1440-chatgpt-setup-cleanup-20261021/README.md), [Author/tree receipt](evidence/1440-chatgpt-setup-cleanup-20261021/POST-MERGE.json).
- **[#1243](https://github.com/rynfar/meridian/pull/1243), closed unmerged.** The owner-approved [exact explanation](https://github.com/rynfar/meridian/pull/1243#issuecomment-6318784815) was posted and read back before closure. Its automatic SQLite selection/import conflicts with the delivered JSON-default, explicit SQLite opt-in and offline-migration contract. Source 5198b68a and Nowaker's `feat/session-store-sqlite` branch are preserved. #1220 remains separate and open. [Closure receipt](evidence/1243-approved-decline-20261021.json).

## Verification and attribution

#1426 final local `npm test`: **8,096 pass /36 skip /0 fail**, all 26 configured invocations; typecheck/build and eight executed hosted checks pass. Seven real SDK/provider cases and 46 generations pass: four E41 modes with Sonnet5.5, both generic OpenAI tool-loop response modes and original E58 with Haiku4.5. SDK0.2.141/nativeCLI2.1.306 on Darwin arm64. These are qualified protocol hosts, including the actual installed V1 hook for E41; no actual OpenCode binary or Shakespeare-browser claim is made. Cache, tool pairing, durable forks, parent immutability and headerless controls pass. The final correction changes only a scoped test observer; runtime bytes match the live-tested head. Historical failed CI/recorder attempts and exact limits remain preserved. The usage endpoint returned429, so capacity was labelled unknown; paid Extra Usage stayed disabled, no refusal occurred, and no owner credential refresh/write or account/model fallback was used. Older held Opus/Fable cases are not cleared by these different runs.

#1440 final local: **8,098 pass /36 skip /0 fail**, all 26 groups; typecheck/build and eight executed hosted checks pass. Eight direct tests and 70 adjacent tests pass. Actual local HTTP fault injection at both setup boundaries proves counts1→0, exact abort-listener removal and stuck cleanup→joined while retaining HTTP500. This boundary precedes provider dispatch and requires zero SDK/backend generation requests, using synthetic credentials and external-fetch guards. The first recorder's baseline shutdown timeout is retained; its receipt/termination correction preserves the same before/after assertions.

A fresh full attribution audit on code main c84af243 and current PR refs classifies both new contributions as properly merged. The **137 legacy maintainer re-lands remain unchanged**, with no new maintainer re-land and no historical repair claimed. One historical unmapped foreign commit remains in the audit output. [Filtered audit, new entries and counts](evidence/backlog-approval-batch-20261021/ATTRIBUTION.json). The complete old handoff remains [immutable at1549d563](https://github.com/rynfar/meridian/blob/1549d563adda26d73747902e86e254dbbd591096/docs/maintenance/REVIEW_HANDOFF.md); the previous compact checkpoint is [6352beed](https://github.com/rynfar/meridian/blob/6352beedcc4f2d1347adab41d7397f2cb58eecdc/docs/maintenance/REVIEW_HANDOFF.md).

## Fresh queue and dispositions

The 16:23 UTC discovery covered 165 accessible repositories, three accessible organizations and all six managed Meridian/scrub queues, with no access gap. Meridian has **19 open PRs /12 issues** after the contributor deliveries. The documentation checkpoint PR temporarily adds one until it merges. Hudscrub, Hermes scrub and OpenClaw scrub queues are empty. OpenCode scrub release#20 and Pi scrub release#15 remain unauthorized. [Filtered discovery and exact source heads](evidence/backlog-approval-queue-20261021.json). Refresh GitHub again before acting; older green checks do not qualify a changed head or base.

- **#1261, needs corrections and a public-lifecycle decision:** the contributor rewrote it at14:18UTC; current source is ec2e235d, parent 075e9e47. Deterministic controls prove it starts a sweep when a root becomes busy during the credential await, and releases an SDK slot after its settle timeout while the child remains unjoined. Idle/initially-busy controls pass. Native cleanup was not run. Durable pins, cross-instance ownership and migration/deletion fences remain unqualified. The exported `ProxyServer.transcriptSweep` addition needs owner approval plus issue coverage, or should remain internal. No #1426 approval covers it. Full22-file UI/acceptance review is unfinished. [Current findings, source hashes and six proof members](evidence/1261-revisit-20261021/README.md). Earlier Opus failures are retained, not treated as a current-head qualification or diagnosed away.
- **#1429:** banked-reset product behavior and selection of scarce grants need an owner decision; no redemption or quota burn.
- **#1410/#1399:** original Opus5.5→4.8/refusal/cache evidence lacks the exact executed source and correlated provider trace. Adjacent-model success does not clear it.
- **#1399, head644deec8:** final pre-a5a939 local8,112/36/0 and hosted checks passed; SQL shutdown-budget and fixture defects were corrected. Actual original Opus/native/hourly throughput, latency, shutdown and SQL real-SDK gates remain missing. [Proof](https://github.com/rynfar/meridian/blob/8459725bc29c93cbf48cbf14bdeef5479c6cfe35/docs/maintenance/evidence/1399-current-main-20261021/FINAL.md).
- **#1400, headec7e0a15:** local8,163/36/0 and hosted checks passed before the new main. Natural Fable-specific exhaustion with a healthy distinct included account, whole-pool spent, post-heartbeat refusal, main/subagent and Linux cases remain missing. No selective-exhaustion fixture was supplied. [Proof](https://github.com/rynfar/meridian/blob/8459725bc29c93cbf48cbf14bdeef5479c6cfe35/docs/maintenance/evidence/1400-current-main-20261021/FINAL.md).
- **#1396, head8c02fff:** local8,117/36/0 and hosted checks passed before the new main; all source authors remain retained. Actual reminder-only/client transition and source/model/cache proof remain incomplete; mixed annotations and failed95% cache floors are retained. Unknown durable system tails must stay preserved. [Proof](https://github.com/rynfar/meridian/blob/8459725bc29c93cbf48cbf14bdeef5479c6cfe35/docs/maintenance/evidence/1396-current-main-20261021/FINAL.md).
- **#1340, headbd5808f3:** bounded notice is not exactly-once execution. #1437 fixes the retained oversized request, but the notice still lacks benefit/reporter duplicate proof. Fresh identical attempts must dispatch. No closure inferred.
- **#1314, head5c96dd30:** Pi/Gemini source and installed paths passed earlier. Reporter ACP/platform and duplicate cause are missing. Original d1a13085 is signed with unknown_key, not unsigned; the unsigned-only admin exception does not apply. [Proof](https://github.com/rynfar/meridian/blob/985793c9c2720b7a2a56d7ebd9f4fcc71b95cca9/docs/maintenance/evidence/1314-current-main-20261021/QUALIFIED.md).
- **#1220, head92222508:** earlier8,102/36/0 and hosted checks pass. Actual Opus5.5/SDK0.2.141/native2.1.284/OpenCode1.18.34 cache3332→3132 misses the95% floor3165.4; original native locator/fingerprint stderr is absent. The scoped capture test correction is now on main through1426, without importing the async-writer implementation. No blind model retry or closure.
- **#1193:** owner-deferred warming, lifecycle/cost and benefit decision.
- **Drafts #1402/#1359/#1347/#1322/#1317/#1266/#1050:** retain draft/no-review/owner holds. Do not mark ready or review around them.
- **Release Please #1438:** proposed 1.86.0 (now including #1408), publication unauthorized; see the 2026-10-25 section.

Issues #1390/#1338/#1302/#1229 map to held drafts. #1311's separate agent identity contract remains unapproved. #1439 needs exact suspension incident/provider notice and versions; IP/header causation remains a hypothesis. #1073 retains unfinished provider/platform work and deferred Mac notarization. #1011 retains its owner-deferred capped-streaming work. #933's broader CI/fast-500 causes remain incomplete; the concrete capture/receipt fixture corrections are bounded improvements, not universal resolution. #769 needs the exact private OpenClaw trigger/version and Off–On–Off proof. #650 remains owner-deferred for its sender-secret prerequisite.

**#1094 has a new 15:39 UTC comment:** a participant reports using2.1.1 after upgrading. Main already qualifies2.0.16,2.0.21,2.0.31 plus three betas. The new report lacks exact installed-plugin/route/model witnesses. Qualify2.1.1 separately with required V2 package/live/extended gates before adding that exact version; do not blanket-unpin future versions. The original minimized content-sensitive billing payload and active negative control remain absent. Keep open; no comment or model probe was sent. [Updated disposition](evidence/1094-version-report-20261021.json).

## Workspace and next continuation

Both task checkouts and the one reused dependency installation are removed. All local controllers and real live actors are terminal; all private grants/live fixture homes are removed. The1261 lab install link/source copies and the isolated attribution metadata repository are removed. No local task Docker resource was created. The original root remains at446a0f1633be3a0cf36d8f1e9f222e914d2f7c83 and all 12 original dirty-file hashes match. Seventeen other user/T3 worktree records remain untouched. [Final cleanup receipt](evidence/backlog-approval-batch-20261021/CLEANUP.json).

Recovery refs retain exact1426/1440 candidates and the reviewed1261 source. Old absolute-path controllers refer to removed workspaces; create a fresh isolated current-main checkout and install/select the exact qualified tools before future execution. No global prune, unknown-process kill, owner-credential change or later release is authorized. Continue from a concrete changed prerequisite or newly actionable scope; do not mark the whole backlog goal complete because these two PRs merged.
