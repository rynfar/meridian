# Preliminary release review — #1486 / 1.89.0

**Read-only snapshot: 2026-11-03T08:22:23+00:00. NOT approval to merge or publish.**

The owner authorized a release **after #1220 is safely accepted and merged**. That prerequisite is not met in this snapshot. #1220 remains open at `67d02f56ba69b7e738aea67119ba5b1376ef0db0`, with its original cache/initializer/fingerprint evidence gates retained. Release #1486 does not contain it. Final-head review is required again after either main or the candidate changes.

Worktree: `/Volumes/DevSSD/meridian/review-1220-baseline-20261103`, detached at current main, clean before and after inspection. No checkout/reset, tracked-file edit, tests/builds, live model calls, comments, dispatches, merges, tags or publication were performed. This report is the only new file, outside the checkout. No constants were changed.

## 1. Exact identities and complete release range

| Object | Exact identity / live state |
|---|---|
| Previous release tag | `meridian-v1.88.0` → `cdca353924556acdc00eca8f4162f296f2dab875` |
| Current local and GitHub main | `697f9482c23865e9d9a02095e35d79b0922047a7` |
| Release PR | [#1486](https://github.com/rynfar/meridian/pull/1486), OPEN, `chore(main): release meridian 1.89.0` |
| Release head | `296676632c3ff5097b1420a81e41028b3e669f9c` |
| Release branch | `release-please--branches--main--components--meridian` |
| Reported release PR base SHA | `3a700e365fef08b4549642746a9ccbf59c64d95e` |
| Release-head/main merge base | `3a700e365fef08b4549642746a9ccbf59c64d95e` |
| Release/main divergence | one main-only commit (#1487 docs), one release-only commit (version/changelog) |
| PR status | `mergeStateStatus=UNSTABLE`; statusCheckRollup empty; check-runs API `total_count=0`; `gh pr checks 1486` reports no checks |

The **reviewed release range** is exactly:

```
meridian-v1.88.0..296676632c3ff5097b1420a81e41028b3e669f9c
cdca353924556acdc00eca8f4162f296f2dab875..296676632c3ff5097b1420a81e41028b3e669f9c
```

Complete commits introduced over that tag, oldest first:

```
bf91d7ad3ce45dec11892a8f7f5ac7d5df470f75 docs: record the 1.88.0 release and #1484 (#1485)
8f0b86b8dbcaaa688db067ca07e32219bffb516c test: escrow the Claude Code tool-search harness (#1478) (#1483)
3a700e365fef08b4549642746a9ccbf59c64d95e feat: keep a stopped turn's session when the client discarded its output (#1480)
296676632c3ff5097b1420a81e41028b3e669f9c chore(main): release meridian 1.89.0
```

Complete range diff: **26 files, 3,103 insertions, 60 deletions**, listed in Appendix A. The release-only three-dot diff from current main changes exactly `.release-please-manifest.json`, `CHANGELOG.md`, `package-lock.json`, `package.json`. Direct tree comparison also shows #1487's six review/attribution documents absent from the old release tree. A normal merge should preserve those main-side documents; do not mistake this stale release tree for the final combined tree.

Main's post-tag range is the first three commits above plus `697f9482c23865e9d9a02095e35d79b0922047a7` (#1487 review docs). #1478's runtime fix already shipped in 1.88.0; #1483 only escrows its harness. The only new runtime product behavior in the current candidate is #1480.

## 2. Findings and disposition

### Release gates still open

1. **#1220 is absent and not accepted.** Its current 75-file delta against main is a substantial asynchronous JSON-store change, not a release-metadata tweak. Do not merge #1486 first or claim this preliminary review covers that final combination. A source-only projection `meridian-v1.88.0..67d02f56ba69b7e738aea67119ba5b1376ef0db0` currently spans **96 files, 5,879 insertions, 1,595 deletions** and still has version 1.88.0. It is not a release candidate or a substitute for reviewing the refreshed Release Please head.
2. **No CI checks exist on current release head.** The required final-head `test` gate and other applicable CI are not established. Old #1480 checks, main checks or #1220 checks do not qualify an updated release head. This review did not approve/run any workflow.
3. **No final-candidate source/package E2E was run here.** Prior #1480 evidence is valuable but not final-release qualification. Independently installed tarball validation, and fresh registry install after publication, remain required.
4. **Original #1220 evidence remains a premerge prerequisite.** The retained Opus 5.5 / SDK 0.2.141 / native CLI 2.1.284 / OpenCode 1.18.34 discrepancy is 3,332 prior cached tokens versus 3,132 read: below the unchanged 95% floor of 3,165.4. Original failing native locator/fingerprint stderr and causal explanation are absent; later timings/green reruns are not a resolution. The earlier initializer `[0,1]` failure with discarded stderr and unexplained fingerprint deadline are also retained, not diagnosed away. The PR body still describes older head `92222508`; use exact current-head receipts instead of treating its historical green counts as new qualification.

### Static product/regression assessment

I inspected the complete current release file list and all production diffs: `server.ts`, `requestAbort.ts`, `passthroughEarlyStop.ts`, `session/cache.ts`, `session/lineage.ts`, plus the full new pure `session/interruptedTurn.ts`; the new test case inventory, specs, configuration/E2E docs, release/package files and workflows. No additional material static defect was established in #1480 by this preliminary pass. This is not a claim that the combined #1220 release is safe.

Useful safety boundaries found in the implementation:

- Only a plain continuation resuming exactly its published source can become an interrupted candidate. Side/auxiliary requests and priority publication are excluded.
- Only client disconnect/body cancel after text/thinking, before a tool call and before publication, can keep the source behind the interrupted-turn check. Other destructive paths remain destructive.
- Durable state withholds SDK-prefix proof (`lineageHash` empty, client hash retained). Restoring it requires the process-local record, exact written generation, unchanged prefix and source reply, and only user-side additions. Retained assistant output/unknown tool results replay rather than silently resume.
- A restart, another process or a competing write cannot restore that record. Mark failure falls back to eviction. The one-use claim and turn-lease ordering bound concurrent reconnects.
- Pure decisions stay in `interruptedTurn.ts`, importing only `lineage.ts`; mutable state stays in `cache.ts`. No new public header/config/lifecycle signature is introduced by the current release.

Tests directly cover discarded/retained output, body cancellation, restart, consecutive stops, concurrent reconnects, side requests, fresh-target retry, tool exposure, watchdog, explicit cancellation, shutdown and non-stream paths. Pure tests cover generation/source fences and prefix/reply/tool-result controls. These were inspected, not executed here.

### Known limitations that must remain visible

From current configuration docs and committed #1480 evidence (now on main in #1487):

- **Priority-routed signed turns are not checked after a stop.** A client retaining partial output (OpenCode) can resume without that output. This is explicitly documented as existing behavior, not fixed by this release. The rule must not be advertised as universal cancellation correctness.
- Priority-routed abort eviction before publication and an upstream failure after streamed output are recorded follow-ups, not cleared by #1480.
- A stop after tool exposure, non-stream cancellation, explicit subtree cancel, restart or another process can still require replay. Cache preservation is intentionally limited to the owning process and safe continuation shape.
- #1480's actual Pi 1.4.0 and OpenCode 2.2.0 stop shapes were tested with a scripted upstream; the record explicitly says **no real-model OpenCode stop run**, and no Claude Code/Codex post-stop-shape qualification. Its live discard/keep HTTP cases used Sonnet 5.5; its E41 4/4 record is not #1220's original Opus proof.
- The last release's `desktop / mac` publication failed Apple notarization with HTTP 401, leaving no notarized desktop download. This review did not recheck credentials or establish a fix. Preserve the next actual outcome; npm success must not imply desktop success.

Minor hygiene only: `git diff --check` over the current release range exits 2 for new blank lines at EOF in `src/__tests__/interrupted-turn.test.ts:361`, `src/proxy/session/cache.ts:836`, `src/proxy/session/lineage.ts:863`. No correction was made. This is not the material release blocker.

## 3. Changelog, dependency and Nix checks

- Candidate `package.json`, both package-lock version locations, and `.release-please-manifest.json` all say **1.89.0**.
- The candidate package object differs from the tag's package object only in `version`. Deep comparison of package-lock objects after normalizing its two version fields is equal. There is no dependency/optional/dev dependency or resolved-integrity change.
- The sole 1.89.0 changelog entry is #1480, correctly naming the final behavior rather than the removed operator environment switch. Its date is 2026-11-02. #1483's hidden `test:` and review `docs:` commits should not add user-facing feature entries. No duplicate or entire-history changelog expansion was found.
- Release Please is configured for component `meridian`, root manifest, node release and `meridian-v<version>` tags. #1480's feature warrants the minor version. A later #1220 `fix:` normally adds a Bug Fixes entry without a further minor bump, but this is only an expectation: inspect regenerated version/notes/directives rather than editing anchors manually.
- `bun.lock` is byte-identical at tag, release head and current #1220 head: Git blob `4c64647a3ed6929dff880be79a6019bdf9790326`.
- `nix/pkgs/meridian/node_modules.nix` is also identical at all three: blob `5a17daa66e94f845aaa9eac980fecc4cc43c25a5`, hash `sha256-oH6dWbRTdNQeXEA6rtU2oW/OJPT+UoXnUfajhgQgybs=`. No flake/Nix files change in either delta. Static hash consistency is correct **for unchanged dependencies**; no Nix hash recomputation/build occurred here. Final release's package.json change should trigger `.github/workflows/nix-node-modules.yml`, including cold rebuild and macOS installed-runtime evidence. Require its final-head result.

## 4. Packaging and native/runtime paths

No changes to `scripts/build.ts`, plugin packaging, package `files`/exports/bin/engines/postinstall, Dockerfile, workflows, Nix packaging or plugins occur in the reviewed release range. #1220's inspected delta also changes no dependency or packaging metadata.

The unchanged contract still needs actual-package verification:

- `npm run build` bundles Node entrypoints, packages both OpenCode client-plugin generations, emits declarations and Node-checks the outputs. The new helper must be present in the bundle/declarations without new leaf→server/session cycles.
- The npm files whitelist ships `dist/`, client plugins/assets, README/configuration docs and launchd helper, not E2E scripts/tests/evidence. Run the committed repository harness with `E2E_MERIDIAN_ROOT` pointing at the independent install; merely running from the source root does not test the package arm.
- SDK and libsql remain external runtime dependencies. Locked versions are SDK **0.2.141**, native Claude npm package **2.1.296**, libsql **0.5.29** (TypeScript 5.9.3 build-only). The package ranges allow registry installs to resolve newer versions; record the actual installed tree, selected executable path/source and native version, not just package.json ranges.
- Prior #1480/client evidence used system native CLI **2.1.316**, distinct from lockfile 2.1.296. Preserve that qualification and test the final selected/bundled native path where claimed; do not silently conflate them.
- Root postinstall invokes Claude's installer through Node, not POSIX shell syntax. Windows CI tests it under cmd.exe and builds/boots under Node; these are smoke gates, not real Windows affected-model proof.
- Nix uses the runtime-only tree, hoisted all-platform dependency hash, foreign-platform pruning, stock Node22 and nixpkgs `claude-code` selected via `MERIDIAN_CLAUDE_PATH`; its removed npm native binaries are intentional. Validate the installed Nix path if claiming it, and retain a closure free of build Bun/node_modules derivation.
- Docker installs Claude's native binary in the Alpine runtime stage (musl, not build-stage glibc), provides machine identity and shims its actual binary. Its source/build path differs from `scripts/build.ts`; Docker smoke exercises installed SQLite maintenance/awaited cleanup and a dummy-token Messages request. Require those final-head checks and both released image architectures.
- Native bookkeeping uses builtin `node:sqlite`/`bun:sqlite`, not the libsql driver. `engines.node >=22` alone is not qualification: SQLite must contain the WAL-reset fix (3.51.3+, 3.50.7+ or 3.44.6+ as implemented). Use Node22.22.3+ or explicitly qualified Bun SQLite; record actual engine provenance. CI/release Linux pins Bun1.4.3 instead of packageManager1.3.11 for this reason.

## 5. Future exact-head acceptance checklist

These are required future actions, **not completed checks**. Do not make live calls while #1220's owner/prerequisite gates are unresolved.

1. Re-read live #1220 head/base/state and its acceptance evidence. Resolve the original cache/fingerprint/initializer gates with causal evidence, not a relaxed threshold, different model/platform or unexplained green rerun. Preserve authorship through its own PR. Merge only after exact-head required checks and authorized acceptance; this preliminary review grants neither.
2. Refresh main and Release Please #1486 after that merge. Record exact new head/base, previous tag and full commit/file set; review both complete tag→candidate and current-main three-dot diffs. Check that #1480 and the actual #1220 landing are present, #1487 review docs remain, and no unrelated commits, dependency drift, duplicate notes or version directives arrived. Re-review all material changes and the #1480/#1220 interruption/publication interaction.
3. On that **final candidate**, run `npm test` (pretest typechecks and configured isolated invocations), standalone `npm run typecheck`, and `npm run build`; preserve exact source/build identity and failures. Run final-head CI including `test`, Windows smoke, Docker smoke/build, desktop and applicable Nix hash/installable builds. Neither a bare all-files `bun test` nor old groups/checks substitutes for this.
4. Re-run #1220's direct real JSON durability/order/lock and synchronous SQLite authority/atomicity gates: `proxy-session-store-locking`, `priority-session-store`, `execution-history-store`, `bookkeeping-cache-publication`, `session-cache-clear-completion`, and changed interrupted-turn cache/publication behavior. Retain mutation negative controls (yielding a native continuation must fail SQL tests; delayed headerless rollback-key capture must fail JSON fallback). Test the corrected post-COMMIT JSON eviction invalidation and later writer/clear fences. No native transaction callback may gain an await.
5. Run all four live **E41** modes (sequential/parallel × streaming/nonstreaming), asserting exact batches/result pairing, immutable parent histories, durable distinct forks, active-fork follow-up and **≥95% cache-prefix floor on every continuation**. Keep the original Opus5.5/SDK0.2.141/native2.1.284/OpenCode1.18.34/platform prerequisite separate; newer Sonnet success does not clear it. Use supported SDK session APIs only.
6. For the actual implicated OpenCode continuation/cache flow, run the large-store actual-client gate in E2E.md with isolated projects, two clients, real read receipts, continuation and recorded model/platform/native/SDK versions. Every actual OpenCode/Claude call, even diagnostics, must use that arm's generation-matching **Meridian OpenCode plugin**, installed via setup, exactly one effective entry plus active/runtime/header witnesses, and the qualified active server scrub. Verify routing/plugin state before attributing refusal to credentials. Relevant V2 compatibility also requires affected E42 hosts with separate client/proxy cwd and exact host pinning.
7. Re-run **E79** on the final runtime/source and independently installed tarball: model-free `--fixture --case=all` for actual Pi1.4.0/OpenCode2.2.0 stop shapes, and authorized live discard/keep/strict variants with real SDK/model and cache assertions. Because the committed harness's actual-client cases are fixture-only, a real OpenCode/live stop acceptance must be separately qualified if claimed; do not label the fixture as model proof. Include the #1220 asynchronous mark/evict/clear ordering interaction, restart/other-process replay and priority-path negative controls. Retain documented unsupported/follow-up behavior rather than expanding the claim.
8. Independently `npm pack`/install the final candidate in a disposable prefix; record tarball filename, contents, SHA256/integrity, install/runtime versions and `/health` version/source/build identity. Verify public exports/declarations (including existing `clearSessionCache(): Promise<void>` and lifecycle close completion), matching packaged client integrations, native executable resolution and affected live flows from that install. Tests/scripts must not leak into the tarball.
9. Only after these gates, merge the **exact** release head through normal Release Please `--merge --match-head-commit <verified-head>`; recheck concurrent main changes. Never use manual npm version, direct tag push/publish, routine admin bypass or `publish_only` to skip normal validation. This report does not execute or authorize that merge.
10. After automation, distinguish merged / publication-running / published-and-installed-validated. Verify release workflow success and exact release/tag commit, npm version/latest/gitHead/integrity/SLSA provenance, a **fresh registry install** running actual affected flow, and Docker semver/minor tags for amd64+arm64 and their digests. Record desktop signing/notarization/assets separately. Preserve exact commands, model/SDK/native/client/platform versions, source+merge SHAs, CI URLs and sanitized before/after assertions in a durable handoff/artifact, not only temporary logs.

## Appendix A — complete current candidate file diff

`git diff --numstat meridian-v1.88.0 296676632c3ff5097b1420a81e41028b3e669f9c`:

```text
1	1	.release-please-manifest.json
28	4	ARCHITECTURE.md
7	0	CHANGELOG.md
107	0	E2E.md
40	0	docs/configuration.md
10	1	docs/maintenance/REVIEW_HANDOFF.md
36	0	docs/maintenance/evidence/release-1.88.0-20261102/README.md
2	2	package-lock.json
1	1	package.json
144	0	scripts/e2e-claude-code-tool-search.mjs
509	0	scripts/e2e-client-abort-resume.mjs
28	0	scripts/fixtures/tool-search/mcp-ledger-server.mjs
120	0	scripts/fixtures/tool-search/scripted-upstream.mjs
167	0	scripts/lib/stoppedTurnFixture.mjs
128	0	src/__tests__/interrupted-turn-cache.test.ts
361	0	src/__tests__/interrupted-turn.test.ts
708	0	src/__tests__/proxy-client-abort-resume.test.ts
11	1	src/__tests__/request-abort-cause.test.ts
4	1	src/proxy/SPEC.md
4	2	src/proxy/passthroughEarlyStop.ts
9	0	src/proxy/requestAbort.ts
142	42	src/proxy/server.ts
110	1	src/proxy/session/SPEC.md
116	0	src/proxy/session/cache.ts
300	0	src/proxy/session/interruptedTurn.ts
10	4	src/proxy/session/lineage.ts
```

## Methods / assumptions

Read the release/upstream verification and contribution references, `meridian-evidence`, Nix/API contracts, AGENTS/affected E2E/architecture sections, current/prior review evidence and release automation. Metadata was refreshed read-only with `gh pr view`, `gh pr checks`, check-runs API and GitHub main commit API; local immutable objects supplied diffs and metadata comparisons. No local failure was hidden by a rerun. The branch-protection required-status-checks endpoint returned 404 (“Required status checks not enabled”); this is **not** permission to waive the project's explicit final-head `test` requirement, and this review does not assert the full repository ruleset state.

Assumption: owner release authorization is conditional on #1220's safe merge, per the task brief. Expected release scope after refresh is #1480 + accepted #1220, not whatever future unrelated main work appears. A changed candidate/base invalidates this snapshot and needs another final-head review.
