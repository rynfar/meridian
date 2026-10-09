# Upstream review handoff

## Current recovered continuation (2026-10-08)

The owner resumed the combined oldest-first PR/issue queue. The dirty checkout
remains at `446a0f1633be3a0cf36d8f1e9f222e914d2f7c83`: head, index, status and
all twelve dirty items match the saved before record. Work uses isolated feature
branches from fetched main `458cf15c59dc5ff99f50bf4dea4a002ff44b947f`.
No community comments, new release, tags or publishing occurred.

- **SQLite #1219:** the interrupted R7 native fixture run had already completed.
  Joined receipts establish all sixteen cases pass under both Bun 1.3.11 and
  Node 22.0.0, with exit-zero joined outer commands. The native artifact SHA256 is
  `6caf1e117be0cf83cb7ad392d0e1b6a5826a96f8d4e4f7a2dd5e86c3e0b9e128`.
  It was not rerun or rebuilt. Delivery preparation stays at `d4dce40f` in
  `codex/sqlite-inspection-1219-20261008`. This is bounded native fixture proof;
  physical guard xWrite, natural close/projection faults, complete controller and
  migration ownership, Linux/client/model/package and final CI gates remain open.
- **AGY #1314 / issue #1073:** [draft #1317](https://github.com/rynfar/meridian/pull/1317)
  preserves source `d1a13085` by Cd1s as authored cherry-pick `80d4b966`, with
  separate corrections. The real Pi 1.1.0 / agy 1.2.7 / Gemini 3.8 Flash Low /
  Darwin import-and-replacement gate fails unchanged on baseline `458cf15c`,
  `dedf4096` and corrected code head `0e7c1df1`: two identical successful writes
  instead of one. Actual joins/pipes are qualified separately. Code-head local
  gates pass 5,521 tests / 35 skip / zero fail, typecheck and build; `cd6b31a7`
  adds only the failed-evidence record. [The committed proof](https://github.com/rynfar/meridian/blob/cd6b31a752e2f2d20240fee1e63ea46a39830dd9/docs/maintenance/antigravity-history-1314-proof.md)
  retains the reproducible escrow and product hold. No blind prompt retry,
  installation or green CI resolves that live failure. Exact reporter ACP/OS,
  installed package, broader platform/model and final-head CI remain separate.
  Keep source #1314 and issue #1073 open; investigate deterministic result-tail
  semantics before another actual arm.
- **Profiles #1316 / [delivery #1318](https://github.com/rynfar/meridian/pull/1318):** root source/browser review accepts the scoped display fix,
  with completed local gates and final-head CI still required. Nowaker <spam@nowaker.net> source
  `67c78683696712f7db714cbc5bb529bde8f5dfc3` is preserved with Author/AuthorDate
  as `b4d8095e2fb998396d4e3a217547888477b23199` in
  `codex/profiles-needs-login-1316-20261008`. Actual baseline/candidate Profiles
  templates execute in the T3 browser with owned synthetic HTTP data. The
  baseline lacks both badges/red borders; the candidate shows them, preserves
  the active blue ring, avoids healthy/API false flags, clears on recovery and
  handles unavailable quota conservatively. Paired 1280/375px and a 320px control
  fit. E2E.md qualifies this display gate without model/OAuth generation.
  [The scoped proof](evidence/profiles-needs-login-1316.md) records review,
  reproducible fixture, validation and media limits. Broader login/expiry issues
  stay open. Preserve Nowaker credit when squashing and recheck source head before
  closing it as incorporated.

All supplemental receipts, failed traces and before/after media remain under
`/Users/rynfar/repos/meridian-review-evidence-20261006/resumption-20261008-round1`.
Older dated statuses below do not supersede this checkpoint. Existing owner holds
on #650, #1193 and #1011, no-review/draft holds, and prior missing affected-flow
acceptance gates remain in force. The queue is not claimed cleared.

## Current CI diagnostics continuation (2026-10-08)

[#1312](https://github.com/rynfar/meridian/pull/1312) merged as
`048c5e195d237508d71a2723c1249081eb9b4d91`: npm test explicitly discovers
source tests and runs priority-session-store in its own final stage. Older
missing-file counts below are dated observations.

The usage-zero integration assertion now retains a cloned error body before
JSON parsing on unexpected status. Known JSON/plain 500 controls still fail;
only corrected Received diffs retain their full bodies. The existing guarded
integration file passed 13 tests / 135 assertions and typecheck passed before
rebase; the identical diagnostic is retained on current main. See
[the durable diagnostic evidence](evidence/ci-usage-zero-diagnostics-20261008/README.md)
for exact fixtures, commands, first logs and native-auth qualifications.

Keep #917 and #933 open. #990 addresses the two recorded timing mechanisms;
#935 covers the original eleven-victim ownership-backlog cluster. Five of seven
original fast #917 receipts are matched, two remain missing, and fast 500/marker
causes remain unknown. The absolute-path plugin change was dropped because its
original failure had HTTP 200 and a missing marker. #1306's held-writer diagnostics and existing
MCP/limiter diagnostics remain separate evidence. No timeout, expected status,
product code or API contract changes are included. Final delivery-head local
and CI gates remain required; a green suite does not diagnose the older causes.

## Oldest-first continuation (2026-10-07)

The owner requested oldest PRs and issues first. Use creation date ascending
across Meridian and managed scrub repositories, while respecting drafts,
explicit no-review requests and existing owner holds. This supersedes older
queue-order suggestions below. The paginated refresh at **2026-10-07 22:18:35
UTC**, after #1176 closed, contained 18 Meridian issues and 23 Meridian PRs,
plus three managed scrub PRs and no scrub issues across six managed repositories.
These are dated observations; refresh before selecting another item.

- **Issue [650](https://github.com/rynfar/meridian/issues/650), July 17:**
  receiver and sender workflows are delivered. Fresh secret-name metadata shows
  `MERIDIAN_DISPATCH_TOKEN` absent from Hermes, OpenCode and Pi scrub repositories.
  The owner explicitly kept this deferred on October 7. Do not provision a
  token or run a dispatch while that hold stands. Revisit only on owner steering;
  acceptance still requires the narrowly scoped credential and a witnessed
  sender-to-receiver dispatch. Do not export a broad CLI credential as a substitute.
- **Issue [769](https://github.com/rynfar/meridian/issues/769), August 7:**
  the published OpenClaw scrub does not establish that the reporter's newer,
  undisclosed trigger is handled. The latest owner hold requires a minimized
  failing input or private, version-matched off/on/off verification. Do not add
  speculative rules or close the report because the plugin exists.
- **Issues [917](https://github.com/rynfar/meridian/issues/917) and
  [933](https://github.com/rynfar/meridian/issues/933), August 31/September 4:**
  the two last cited examples have concrete time-budget explanations. The
  [tool-cache failure](https://github.com/rynfar/meridian/actions/runs/34315620193/job/102351097458)
  explicitly expired at 5,003 ms under Bun's implicit five-second timeout;
  the older claim that it had no timing bound was incorrect. The
  [extra-usage failure](https://github.com/rynfar/meridian/actions/runs/34315145910/job/102349683150)
  received 1,992 ms against the obsolete 500 ms assertion. Merged #990
  (`92698147221c02afe89496906617f963b392bea6`), an ancestor of current main,
  supplies the 30-second suite bound and a ten-second amplified-backoff control
  with a five-second observation bound. These corrections do not explain the
  [remaining fast concurrent failure](https://github.com/rynfar/meridian/actions/runs/33907044767/job/101134309533):
  at #935 head `0d863bcf62a31317e202e668f0c22bb291b445d4`, one of three
  headerless requests returned 500 at 132 ms after all three logged usage. Its
  response body was not captured. The same head's later success cannot establish
  a fix. Both issues remain open for that cause and the original unclassified
  fast failures. Current main `6636c0da` passed the focused original HTTP test;
  this is current mocked behavior, not a retrospective diagnosis.
  The corrected `src/__tests__/integration.test.ts` fixture holds three SDK
  writers, verifies distinct targets and durable mappings, and checks both
  simultaneous and reverse-order completion plus released ownership. A
  synthetic SDK-error control makes both versions reject HTTP 500: the old
  fixture omits its error body, while the corrected fixture retains the body,
  target, request index and cleanup facts. This demonstrates diagnostic capture,
  not reproduction of the historical cause. The shared ten-second main-work
  budget leaves three bounded five-second cleanup phases within the explicit
  thirty-second test limit; unfinished work is recorded without claiming a join.
  [Delivery #1306](https://github.com/rynfar/meridian/pull/1306) is now merged as
  `eb88f9894229f70be453ca2d83ab36643b1a142b`, after six successful checks on
  `486240609e2e1d9f5672656e62acb84fcfb28463`. The merged tree
  `fb95ec3dc59506d2d1b009f61af14063471ca63c` matches the tested tree and human
  authorship is verified. It improves diagnostic evidence; neither CI issue is
  closed by that test delivery.
- **Issue [1011](https://github.com/rynfar/meridian/issues/1011), September 10:**
  the remaining authored `c5804275` commit is still owner-deferred. It changes
  empty capped-output guarantees and stream/nonstream parity; oldest-first
  ordering does not supply the missing contract decision.
- **Issue [1068](https://github.com/rynfar/meridian/issues/1068), September 19:**
  the owner chose the shipped append-only approach on October 7. The request
  for a new context API was declined and closed as not planned at **22:40:55 UTC**.
  [#1163](https://github.com/rynfar/meridian/pull/1163) remains the delivered
  guidance: earlier advisory text stays in the resumed SDK session. This closure
  does not claim replacement/removal semantics or a live Pydantic AI cache
  benchmark. The older open-design statements below are historical.
- **Issue [1073](https://github.com/rynfar/meridian/issues/1073), September 19:**
  the official-CLI macOS implementation and its recorded expansions already
  landed. A bounded internal correction now requires boolean `useG1Credits`;
  only explicit false passes the existing subscription-only checks. Sixteen
  unchanged-runtime fixture cases reproduce missing/falsy acceptance. Corrected
  probe/backend suites pass 39/72 tests. Final local gates on rebased delivery
  `a6d15a2f970edabe0fc323bbcb8506597008f356` pass **5,452 / 35 skip / 0 fail**,
  typecheck and build; the earlier 5,451 result remains pre-rebase evidence.
  Official agy 1.2.7 / Gemini 3.8 Flash Low / actual Pi 0.72.1 on macOS arm64
  passes text, client-tool roundtrip, completed-history replay and exact-file
  streaming client read/write. The native executable remains hash/version
  identical before/after. The committed account-settings probe disables
  auto-update and checks executable hashes around both read-only commands;
  only whitelisted setting types/flags are retained. First self-update and
  local API-key fixture failures remain qualified in
  [the durable proof](evidence/1073-subscription-settings.md).
  [Delivery #1307](https://github.com/rynfar/meridian/pull/1307) merged as
  `ff260ea217072cf842f319c64d563e122f4d6964` after six successful final-head checks
  and the expected changelog skip, including
  [required test](https://github.com/rynfar/meridian/actions/runs/37689253024/job/113024913360).
  Merged tree `2d4112bcae9c1900016b225e2f5ea07679341f6b` exactly matches the tested
  tree; human credit is verified. Broader Linux/Windows and reliability acceptance
  keeps #1073 open. No new owner approval is needed for this internal enforcement
  of its already approved subscription boundary.
- **Oldest nondraft scrub PR
  [OpenCode 18](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/18),
  September 27:** source `03d2f561` remains conflicted and held for the recorded
  Claude-only correction and affected-client proof. Scrub release PRs Pi 15 and
  OpenCode 20 still need separate release authorization.
- **PR [1176](https://github.com/rynfar/meridian/pull/1176), September 28:**
  declined and closed unmerged at **2026-10-07 22:16:36 UTC**, with unchanged head
  `f552804e061a9aaca8ef371779f1c9e093e2ec5f`. This supersedes the reviewer hold:
  Meridian has no supported OpenAI-serving producer for the proposed built-in
  GPT valuation. GPT request IDs are served by Claude; synthetic GPT metrics,
  override convenience and 25 unused catalog entries do not establish that feature.
  The authored [Nowaker source](https://github.com/Nowaker/meridian/tree/f552804e061a9aaca8ef371779f1c9e093e2ec5f)
  and `feat/openai-pricing` branch are preserved. Reconsider only if a separately
  approved supported OpenAI backend lands with observed served-model/normalized
  usage and actual-client proof, then refresh valuation, overrides, partial-cost
  display and authoritative prices. No backend work is inferred from this decline.
- **PR [1193](https://github.com/rynfar/meridian/pull/1193), September 29:**
  the owner explicitly kept `7c9308968f760119e1b9f3ba8d74497af39d4a85` deferred on
  October 7. Do not run warming queries. Revisit on owner steering; the tracked
  background-call contract, real idle cache-loss/benefit proof and lifecycle gates
  remain required. The universal five-minute TTL rationale is unproven for Meridian.
  Static review retains missing normal process/hook fences, private source pinning
  and release-before-join, plus stale admission after the semaphore wait: expiry,
  opt-out and mapping replacement are not revalidated. Preserve foreground priority,
  revocation, tool denial and joined cleanup before acceptance. The
  [prior disposition](BACKLOG_DISPOSITIONS_2026-10-01.md) records the original
  gates; this pass adds the stale-admission finding. The owner deferral supplies
  no implementation approval.
- **PR [1201](https://github.com/rynfar/meridian/pull/1201), October 1:**
  unchanged source `30e01969c4511cc21e3a46c76d35c615a5ac6466` remains held for the
  original worker/deployment, SDK, exact model and cache/resume acceptance evidence.
  Two reconstruction cases using the public production producer passed with explicit
  in-memory shell/database/event/interruption doubles: Meowbert
  [historical `b5a83ea8`](https://github.com/XInTheDark/meowbert-ai-agent/commit/b5a83ea81fa7314256d90bb0ad378536923cd65a)
  produces call A / output A / call B / output B; its
  [caller fix `08e771a9`](https://github.com/XInTheDark/meowbert-ai-agent/commit/08e771a948d6d9db1fe96fee93c9ed7d54068cf4)
  produces call A / call B / output A / output B. Both exercised the production
  dispatcher, shell handler, persistence/reconstruction and Claude normalizer,
  preserving correlated receipts and each revision's ordering. This confirms the
  public producer shape, not an end-to-end Meridian fix. The original live
  parallel-call/resume and unrelated/duplicate/missing-call controls remain open.
- **PR [1211](https://github.com/rynfar/meridian/pull/1211), October 1:**
  unchanged source `22566e8ac0b9e079bb0d28c0eb4aa05207c56070` retains the
  **accept with maintainer corrections** disposition; actual affected-client
  acceptance stays held. Recover the corrected `e731a2dfae4931d0c7718e99098cc4ab4a3355a2`
  delivery from `codex/claude-auxiliary-1211-20261004`; do not duplicate it or land
  the original unchanged. The [retained proof](https://github.com/rynfar/meridian/blob/e731a2dfae4931d0c7718e99098cc4ab4a3355a2/docs/maintenance/evidence/1211-claude-auxiliary-20261004/README.md)
  supersedes the obsolete API-approval hold: the hook is internal. Revisit with a
  ready owned Linux x64 environment and original main/classifier model evidence.
  Native E71 before/after, separately observed requested/served model identities,
  E55 gateway parity and all four E41 modes remain gates; the historical `sonnet`
  alias does not supply exact served IDs or the missing native CLI identity.
  Current-main reconciliation then needs fresh local gates and final-head CI.
- **Issue [1212](https://github.com/rynfar/meridian/issues/1212) / PR
  [1213](https://github.com/rynfar/meridian/pull/1213), October 1:**
  the preserved correction from administratively closed
  [draft #1267](https://github.com/rynfar/meridian/pull/1267),
  `fe93ce447bd277a45157fcaad957cd37e4eba2e6`, remains held for native evidence.
  It was not merged; source #1213 remains open. Its
  [qualified proof](https://github.com/rynfar/meridian/blob/fe93ce447bd277a45157fcaad957cd37e4eba2e6/docs/maintenance/evidence/1213-native-sonnet-context.md)
  establishes local controls and actual package-installed Meridian V2 plugin
  execution, but no valid Sonnet 5.5 completion. Actual Linux/OpenCode/Sonnet 5.5
  large-history baseline/fixed/resume evidence remains missing; preparation and
  historical green gates do not replace it.

Every future actual OpenCode/Claude verification or access diagnostic requires
the generation-matching Meridian OpenCode plugin and retained configuration/load/
route witnesses under the [mandatory preflight](../../E2E.md#required-meridian-opencode-plugin-preflight).
Check that path before interpreting a refusal or requesting another owner login.

This pass does not authorize a release or close the remaining CI issues.

## Current continuation — 2026-10-07

Pi continuation #1290/#1289 was delivered by [#1296](https://github.com/rynfar/meridian/pull/1296),
merged `133bb918e02c7cf3a3a2ed4fb212df47a1c6895b` with the exact validated tree,
verified contributor credit, and unchanged source/issue closure.
[Meridian 1.80.0](https://github.com/rynfar/meridian/releases/tag/meridian-v1.80.0)
is published from `c2052aac759c74d8ab0910809009b478ddfce243` through the normal
Release Please workflow. npm integrity/provenance, versioned Docker platforms,
mac-arm64 desktop assets and fresh registry-installed actual Pi/Opus behavior
are verified; complete receipts and runnable harness are in
[release PR #1202](https://github.com/rynfar/meridian/pull/1202).

[Source #1295](https://github.com/rynfar/meridian/pull/1295) was delivered by
[#1298](https://github.com/rynfar/meridian/pull/1298), normally squash-merged as
`097530c824c7c2096c82b89de85fd6550479b603`. Landed tree
`b5c452be66706875bc848b9887e29ca6f403cb38` equals the validated tree;
Nowaker credit is verified and unchanged source `9d932c846afbb19b92d1a8f516772b3cd2552491`
was closed. [Qualified local and live proof](evidence/1295-live.md) covers actual
Linux JSON/SSE before/after, all four E41 modes, concurrent publication lifetime,
real/recurrent timer controls and built native OpenCode with both plugins.
Required final-head CI passed; the closed PR's final body retains the receipt.

Auth-status [source #1285](https://github.com/rynfar/meridian/pull/1285),
unchanged `08ddd8b061a2d271f8af397b83baf2a33f4deb4c`, was delivered by
[#1300](https://github.com/rynfar/meridian/pull/1300), merged as
`30c738d77d5e7839577ebc5d144b74da4590e319`. The landed tree
`0fef592183db00ce0bc81c988d51124b76bd374a` equals the validated delivery tree;
contributor credit and unchanged-source closure are verified. The authored incorporation
is `b67c2f8a6e20aaa3e0ee0b7aa0ea792f1d09351b`, with separate maintainer
ownership/resolver/diagnostic corrections. Tested executable `065e7c7f620f871774a4fe0caa2497950818fd6e`
passes npm **5,433 / 35 skip / 0 fail**, standalone typecheck/build, both same-native
baseline REDs, eight actual source controls and seven independently installed
package controls. [Durable proof and limitations](evidence/1285-auth-status.md)
include the committed auth-only harness, Darwin arm64 CLI 2.1.284/SDK 0.2.141
identity, joined cleanup and retained first failures. Independent scoped review
accepts the production, source/package proof, final local checks and documents
with no remaining material finding. All six executed checks passed on delivery
head `ae470d511f1f170168c7b95140ba0bb56d99d179`, including required `test`,
with the expected changelog skip. This auth-only flow makes no model/client claim;
older whole-OS/controller holds are separate.

[Transcript source #1261](https://github.com/rynfar/meridian/pull/1261) remains
open at new head `b999654d0b5562c067dbc376b4d578ff9168be68` on the October 7
refresh. Its prior head `7475d08c652332aa1b9b23cbc525024bef83ab28` was deferred:
[the concrete review](evidence/1261-transcript-sweep-review.md) retains pin/lease,
admission-race and destructive-child join findings. That old review does not
validate the new head. Revisit the full current ownership, pin/admission/join
design with real affected-flow proof when its place in the oldest-first queue
is reached. Its watcher is removed.
Other historical Sonnet/MCP/SQLite/backlog holds retain their own scopes;
preparation completion does not grant their outstanding live acceptance.

## Current continuation — 2026-10-06 (delivery)

[The current delivery record](BACKLOG_DELIVERY_2026-10-06.md) records #1223's
unchanged-head closure and #1286's authored integration with startup/profile
timing corrections. It supersedes earlier recommendations to retain #1223's
excluded recovery as an open PR; the underlying crash problem remains unresolved.
#1286's actual native timing proof and independent review pass; typecheck/build
pass. Its full local run retains an unchanged store benchmark failure, with
byte-identical baseline/current checks and the remaining stages completed.
Delivery [PR #1287](https://github.com/rynfar/meridian/pull/1287) passed all
executed final-head checks, including `test`, and merged as
`ca6a5c0a4eddb87da52d83993f8f9e105712f0f6`. Its tree matches the validated
head exactly, human contributor credit is present, and unchanged source #1286
was closed as incorporated. The current focused delivery is #1290/#1289;
its production review corrections, actual Pi/Opus and four-mode E41 evidence
are complete. Final evidence review and final-head CI remain before merge;
#1295 is being corrected in parallel. See the linked delivery record and
its durable evidence receipts.
Other historical dispositions below remain qualified by
their own recorded scopes and dates.

## Current continuation — 2026-10-04 (Claude auxiliary model and observer witnesses)

The [current #1211 correction record](evidence/1211-claude-auxiliary-20261004/README.md)
escrows the official 29-slice classifier-model audit, historical requested-model
controls, metadata-first grant snapshots, role-aware per-request model witnesses
and joined HTTP observer cleanup. Both independent final reviews pass for script
`e2f58e5a`, test `b58d12c7` and E71 instructions `f4410422`. The maintained
focused gate passes 34 tests / 1,124 assertions / no skips with real source and
existing certified `80d1ce81` compiled request plumbing plus mocked SDK/auth.
Entered permanent cancellation has same-preload before/after proof; the corrected
harness truthfully retains its logger/private runtime until cloned readers join.
Historical prejoin, pending-read and compiled-skip runs remain explicit.

The first full gate at clean `72b766b4` stopped during pretest typecheck
before any suite. Its raw TS2769 failures are preserved. A separate explicit
artifact-hash string guard corrects test typing without changing digest/model/
ownership expectations; `64f2cba2` passes standalone typecheck and the actual
source/compiled subset (2 tests / 72 assertions). The 34/1,124 result above
is historical `b58d12c7` proof. The [final local gates](evidence/1211-claude-auxiliary-20261004/final-role-local-gates/REPORT.md)
pass at clean `a088de329febb62b147eb4af82f570ccf3b879bc`: 5,431 pass / 36 skip /
0 fail, 28,123 assertions, all 19 batches, standalone typecheck and fresh build.
Verified build provenance names that exact source and 409 checked artifacts.
The current source/current certified compiled HTTP subset also passes 2 tests /
72 assertions over eight ownership cases with mocked SDK/auth/executable paths.
Older compiled `80d1ce81` evidence remains historical; the ordinary full suite
skips the opt-in compiled case, separately executed in this final subset.

All five Noah Passalacqua source Author/AuthorDate/subject tuples remain exact;
this is a separate maintainer harness correction with no production/public-API
change. Root's fresh current-main read is `74d0a499`; no rebase is needed.
Draft [#1279](https://github.com/rynfar/meridian/pull/1279) at prior `cd8b5063`
has all six executed checks passing plus expected changelog skip, with no
comments/reviews. That CI and the earlier `80d1ce81` full gates apply only to
those historical heads. The final evidence-only delivery follows source-stable
`a088de32`; new-head CI remains required. Node/Bun report macOS arm64; the first
immutable Python freeze
reports x86_64 and the current Python observation arm64, retained as distinct
process observations rather than native-client proof.
Actual Linux/client/model E71, E55 and all four E41 acceptance gates remain open,
including selector/policy/entitlement/probe/demotion and separate retry limits.
No native/auth/model call, source closure, release or external message is
authorized by this checkpoint. The lower continuation entries remain historical.

## Current continuation — 2026-10-04 (approved SQLite and Claude auxiliary corrections)

The owner approved [#1277](https://github.com/rynfar/meridian/issues/1277),
and the issue records that approval. [Review #1278](https://github.com/rynfar/meridian/pull/1278)
merged as `74d0a49953211eb8e2c1ccae275971aa0d624c1c` from exact reviewed
`ef4b629977b7705efd00459acd457c66ca58dc7a`, matching tree
`fabaf59afb96133c43bf1aa6f7c182d61c307fa2`. All six executed final-head
checks passed, including [test](https://github.com/rynfar/meridian/actions/runs/37250864506),
plus the expected changelog skip; human authorship and blank squash body were
verified. This merge contains maintenance documentation only. The earlier
#1278 final-head CI/review-pending statements below are historical.

The approved opt-in SQL corrections are active in an isolated worktree. Four
actual Aleksey-authored SQL commits are preserved; the uncorrected inherited
SSE layer is explicitly excluded. Opaque ownership, joined shutdown, exact
JSON codec, exclusive maintenance and cleanup corrections have focused controls.
Profile-pruning parity, bounded GC work, historical SQL stages, guarded native
carrier packaging and actual platform/client/model proof remain gates. Both
submitted SQL heads stay held; approval does not establish their acceptance.

[#1211](https://github.com/rynfar/meridian/pull/1211) is being incorporated with
[durable correction evidence](evidence/1211-claude-auxiliary-20261004/README.md).
Its earlier public-API hold inferred too much from internal TypeScript exports:
the adapter hooks are outside the published package interface and no owner
defer was given. All five Noah-authored commits preserve Author/AuthorDate;
maintainer corrections are separate. Complete source and production correction
reviews resolve mapping/checkpoint authority, cancellation, priority affinity,
classifier false positives and adjacent retry accounting. The actual-client
harness resolves all five independent receipt/containment findings; final
correction review passes. Frozen `80d1ce81` passes all 19 npm stages:
5,417 pass / 35 skips / 0 failures, plus standalone typecheck/build. The first
full-stage failure in the new body-cancellation test is preserved; a reviewed
test-only correction now observes actual finalizer retirement before all
original survival assertions. Delivery-head CI remains pending. Native Linux Claude
Code/Sonnet E71, E55 parity and all four E41 modes remain acceptance gates.
This correction of #1211's internal scope approves no other public proposal.

Draft [#1276](https://github.com/rynfar/meridian/pull/1276) at `e47fbb28` has
all six executed checks passing, including
[test](https://github.com/rynfar/meridian/actions/runs/37245344327), plus the
expected changelog skip. Actual SDK/client/native Windows proof remains open;
green CI does not permit landing it. Sonnet #1267's actual Meridian OpenCode
V2 plugin setup is verified; its working owner inference gate remains open.
Source PRs/issues remain open. No release or external-comment authority is
inferred; the user's dirty root checkout remains preserved.

## Current continuation — 2026-10-04 (complete SQLite review)

The [new review checkpoint](BACKLOG_SQLITE_REVIEW_2026-10-04.md) records #1274's
verified merge, Sonnet #1267's fresh passing local gates and pushed `fe93ce44`,
and the bounded post-merge paginated queue refresh. Earlier Sonnet local-suite
running/push-pending statements are historical; its real Linux/OpenCode/Sonnet
baseline/fixed/resume gate remains open despite actual Meridian V2 plugin proof.

[Complete SQLite review and durable probes](evidence/sqlite-semantic-review-20261004/README.md)
cover all 176 #1219 paths and all 38 #1243 SQL-delta paths. Whole semantic review
is complete for the recorded immutable scopes; both submitted heads are deferred
for material corrections, native-engine/topology compatibility and actual
accepted-flow evidence. Review completion is not implementation acceptance.

The owner approved the SQL public/operator contract on **2026-10-04** in
[#1277](https://github.com/rynfar/meridian/issues/1277): explicit opt-in, JSON
default, opaque embedding ownership, truthful joined close and guarded offline
migration/latest-state export/rollback. Approval authorizes a corrected opt-in
implementation; both submitted heads remain held for corrections and native
engine/platform/actual-flow proof. #1244's async cleanup remains already
approved. Source PRs/issues remain open; release and
community-comment authorization remain absent. Earlier extraction-only and
no-contract-issue or approval-pending statements are superseded only by this
exact review/approved issue.

[Review delivery #1278](https://github.com/rynfar/meridian/pull/1278) at former
head `4477a61245c146e4231d4d9ade510cc93fef476c` passed all six executed CI
checks, including [required test](https://github.com/rynfar/meridian/actions/runs/37249439495),
plus the expected changelog skip. Those checks cover that former head only;
this status correction requires new final-head CI and independent review.


## Current continuation — 2026-10-04 (after #1269)

The [current continuation record](BACKLOG_CONTINUATION_2026-10-04.md) supersedes
specific earlier October 4 statuses while preserving the logs below. Root remains
the sole queue owner; no release or community-comment authority is inferred.

[Checkpoint #1269](https://github.com/rynfar/meridian/pull/1269) merged as
`0369441786b082aadeb31689dcbce41d7e8574d9`, validated head
`65b7793001e9982296459a7e33b85813bc2e8509`, matching tree
`e6ea7edcea9a81aeba9dd7b13cfed32f60eef4a2`; required
[test run 37238890010](https://github.com/rynfar/meridian/actions/runs/37238890010)
passed. #1228 closed at unchanged `cee10174` at 22:45 UTC because its private
SDK transcript mutation is declined; the original symptom remains unresolved.

The owner approved #1270's four current-expiry fields and shared UI; #1260
remains open with its five history fields/storage/listeners/auth logs excluded.
The [bounded #1219 record](evidence/1219-sqlite-scope-review.md) resolves complete
extraction, not whole-stack semantic review or SQL contract approval. #1244's
async cleanup approval already exists; its implementation evidence stays open.

Draft #1271 (`7de8cf5f`) retains safe fsync/publication durability, separate
maintainer corrections and Nowaker credit; historical full suite is
5,349 pass / 35 skips / 0 failures. Independent review passes, but live/native
proof remains required; submitted-head CI passes. #1223's excluded recovery stays open.
Draft [SSE #1273](https://github.com/rynfar/meridian/pull/1273), final `8e1bf53b`,
retains fully tested product `bb33d26d`: 5,406 / 35 skips / 0 failures across
19 stages. Test-only synchronization at `dabb2165` has discriminating controls
and typecheck/build; final evidence-only commit preserves product/harness blobs.
Native flow evidence remains open; submitted-head CI passes.

E41 [#1272](https://github.com/rynfar/meridian/pull/1272) merged as `d3be0c62`
from exact reviewed `8a08d3d4` after all six executed CI checks passed, including
test, plus the expected changelog skip. Merge tree `56d1b172` exactly matches
reviewed content; human authorship and blank squash body were verified. Local
proof: 5,354 / 35 skips / 0 failures, typecheck/build and independent review.
Original #1245/#1220 causality stays open. Approved expiry draft
[#1275](https://github.com/rynfar/meridian/pull/1275), final `1856ee65`, retains
fully tested executable `b386b148`: 5,374 / 35 skips / 0 failures and actual
inactive-browser DOM retention/blur/in-flight success/failure controls on both
pages. Visible keyboard and screen-reader proof remain unavailable; current
native screenshot coverage is limited. Positive native/provider login and
client/package acceptance remains open; submitted-head CI passes.

Transcript enrollment's corrected harness observes the exact target-installed
SDK and cleans setup failures. Its first full run at `ab9bb9ae` failed an
existing third-replacement test that would discard an unfenced predecessor.
The fixture now obtains modern locators through actual metadata registration,
retaining every original assertion and the production guard. The necessary full
rerun at frozen `b20a0e66` passes 5,392 / 35 skips / 0 failures across
19 batches. Draft [#1276](https://github.com/rynfar/meridian/pull/1276) is now
delivered at `e47fbb28` on current main `d3be0c62`, with all eight replayed
patches and product/harness/test blobs preserved. Focused checks, typecheck and
build pass; native/client/Windows and final-head CI remain open. The source
stays open; this does not collect the untracked backlog.

The exact submitted heads of drafts #1271 (`7de8cf5f`), #1273 (`8e1bf53b`)
and #1275 (`1856ee65`) now have all six executed CI checks passing, including
test, plus the expected changelog skip. Earlier CI-pending wording is superseded
for those heads; refresh after any head/base change. Their actual affected-flow
evidence remains open, so CI alone does not permit landing them.

Sonnet draft #1267's verified local terminal head is `5a8097c3`. Default-native
401/zero-query and round-two personal 200 followed by one `<synthetic>` query
with zero input and normalized subscription refusal remain retained separately.
Round three's distinct work snapshot returned usage 200, but its tiny actual
Linux/V2/SDK/Sonnet control made one SDK query: `<synthetic>`, zero input,
`is_error=true`, provider HTTP 400/API Error mentioning extra usage, no receipt.
The precise entitlement cause remains unproven. Large baseline/fixed/resume
were NOT RUN; retained rounds total two SDK query attempts and zero valid
required-model completions. Package/client identities and each arm's 409
installed dist files match; credentialless/syntax/privacy/content checks pass. Root verified
terminal completion, zero owned children and removal of owned runtime/container
with source unchanged. Native acceptance and fresh local/base/head/CI remain
open; controller owns the requested working-login follow-up. Independent review
approved the production/harness; local evidence head `73b2d122` clarifies actual
package-installed Meridian V2 plugin execution through setup/config assertions,
catalog discovery and the plugin-generated attested primary request. It records
later controller snapshot cleanup without claiming successful inference. The
fresh Sonnet full suite is running at frozen `73b2d122` after GC released
the slot. Refresh active
source/delivery evidence before integration; this checkpoint does not itself
establish whole-stack acceptance. A single paginated post-E41 queue/discovery
refresh at 23:38:04 UTC found the same six managed repositories and permissions,
27 open PRs / 12 issues, unchanged contributor heads, and no coverage gaps or
unexpected source work. Held Release Please #1202 is now `ebbc22e7`; separate
release authorization remains absent. The continuation records exact counts
and scope.

## Current continuation — 2026-10-04

The owner authorized a managed PR/issue backlog pass after reviewing repository
rules. The [current queue and exact source dispositions](BACKLOG_REVIEW_2026-10-04.md)
cover Meridian and the five managed scrub repositories. Paginated account and
organization discovery found no additional managed scrub candidates. The dirty
user checkout is preserved; implementation uses isolated branches/worktrees.
No release or community-comment authorization is inferred.

The October 3 sections below are historical records. Their delivery- or
approval-pending statements are superseded by this continuation and the current
standalone backlog record wherever a later disposition is supplied. In
particular, #1258 merged as `f299fe06e72411b786380b5212edea79cd13966a` and
#1257 closed; #1259 now has owner approval. Older records remain intact for
traceability, and outstanding deferrals still apply as recorded in the current
queue. Refresh live status before relying on any checkpoint.

[Header delivery #1264](https://github.com/rynfar/meridian/pull/1264) is merged as
`9d77d8e282cb9c58d99b8962b900777e9f4b0803`, from validated head
`72ebaad447ee769aaac390833d5c4d8a1d1fc132`. Exact tree
`93c72e883b0e43043a3e31e0e0844892a8218c37` and Nowaker co-author credit were
verified. All six executed final-head CI checks passed, including
[test run 37234609333/job 111531118342](https://github.com/rynfar/meridian/actions/runs/37234609333/job/111531118342).
Source #1262 was refreshed unchanged at
`b7bea911ecf41cdeeed34d5cc6d7f08c9936fe5f` and closed after verified delivery.
Local gates: 5,304 pass / 35 platform skips / 0 failures, standalone
typecheck/build and actual native-browser hover, negative and width controls.
[Durable header proof](evidence/1262-header-separator.md) is delivered on main.

Bounded reviews of new sources remain explicit deferrals:

- [#1260 login lifetime](evidence/1260-login-lifetime-review.md), source
  `99b8f0c46fbf8ce0b7f28cb14d2bdce4929948ef`: nine new profile response fields
  require new tracked owner approval. Concurrent history loss, false logout,
  unknown-store/replacement state errors and contradictory UI are reproduced.
  Corrections plus native/browser/client proof remain gates.
- [#1261 transcript sweep](evidence/1261-transcript-sweep-review.md), source
  `7475d08c652332aa1b9b23cbc525024bef83ab28`: disk-growth purpose fits, but
  root-wide deletion bypasses pins and reproduces a busy-root admission race; unjoined-child hazards are supported
  by inspection, with that shutdown proof still open. Require durable ownership/admission/join authority
  through supported APIs and actual affected-client proof.

[Test scratch cleanup #1265](https://github.com/rynfar/meridian/pull/1265) is
accepted with corrections, rebased delivery head
`904eba426c571974503a31268ae805ce93018bcd` on header merge `9d77d8e2`.
Authored incorporation `19334b24e762249628821a76ddc0b3bec83c3c9f` preserves
source `3a959e12569d72db44be9f868ea25fdf54fde49a`; separate correction
`c169e46d80cd20689990e5276900f14f6655f215` addresses ownership/deletion and
harness safety. Historical full suite at `fb795476ef9be300c9be4960c639e003ea3e366c`:
5,316 pass / 35 skips / 0 failures. Rebased focused checks: 71 pass; standalone
typecheck/build pass, with zero per-process scratch residue. Delivery #1265
merged as `5bd6b765fc7507780e1e9238b6d48a99f3d44810`; exact merged tree
`e416d35b5b291f11da09f1b8c66d1803381dcac5` matches the validated head. All
six executed final-head checks passed, including
[test run 37235880525/job 111534755311](https://github.com/rynfar/meridian/actions/runs/37235880525/job/111534755311).
Nowaker co-author credit verified; source #1263 refreshed unchanged and closed.

[Process diagnostics #1266](https://github.com/rynfar/meridian/pull/1266) is a
**diagnostics-only draft** at `9a1793729fa1f09ee643f646ca3221c738d5ab00` on
`9d77d8e2`. Known probe path and bounded errno/exit metadata now reach the proxy
log while admission stays fail closed and the HTTP body stays generic 500.
Historical full suite at original product head
`3a5291e345532cae895bd93127171d4ff4e064fa`: 5,305 pass / 35 skips / 0 failures.
After rebase/harness loader correction: 16 focused checks and all five headless
matrix arms pass, as do standalone typecheck/build. All six executed CI checks
passed at `9a179372`, including
[test](https://github.com/rynfar/meridian/actions/runs/37235975680/job/111535029225).
A fresh base/head/check review remains necessary before any future integration. Exact
macOS 27.0.1 / nono 0.79.0 / OpenCode 2.0.21 / plugin 1.11.1 native/client/model/
installed-package proof remain open. #1229 stays open; synthetic denial does
not establish that the native sandbox operation is fixed.

The owner-approved hostname contract under
[issue #1259](https://github.com/rynfar/meridian/issues/1259) is delivered through
[#1268](https://github.com/rynfar/meridian/pull/1268). Validated head
`78ba26a88cff1885c1c3876970543289a0d2278a` merged as
`3afca1f5a0d51d74f8c7437b90f43d5686cf4163`; exact tree
`852b4e66d06f93d62b8a32f80f2ded364859a6d6` and Nowaker co-author verified.
All ten executed final-head checks passed, including
[test](https://github.com/rynfar/meridian/actions/runs/37237523641/job/111539518710);
two workflow-conditional checks skipped as expected. Source #1233 was refreshed
unchanged at `322d3af68691eb41552b53c010d1996e9474c130` and closed;
approval issue #1259 closed through the validated merge. Authored incorporation
`3055d6b3` preserves Author/AuthorDate; correction `6fb37564` remains separate.
Default-off settings/health/shared header behavior has independent final review,
10/10 actual Settings/standalone browser controls and local proof: 5,333 tests /
35 skips / 0 failures at `f33f93a1` on `9d77d8e2`, across 19 stages. After
rebase, identical product/harness blobs, 100 focused checks and standalone
typecheck/build pass. [Durable proof](evidence/1233-hostname-contract.md).
The October 3 approval-pending note is superseded. The owned fixture stopped;
consent was confirmed off before removing its exact private configuration.

Sonnet source `553fd5c386de5e18e531a1d0101d64ef3a3b1792` is prepared in
[draft delivery #1267](https://github.com/rynfar/meridian/pull/1267), head
`259b152609269386e8494b8fc277230b0638ad64`. Supported Sonnet 5/5.5 native 1M
context and inherited SDK opt-out have focused coverage and independent review.
Full suite at `74e50774`: 5,321 pass / 35 skips / 0 failures. Typecheck and
macOS/Linux builds pass. All six executed final-head CI checks passed, including
[test](https://github.com/rynfar/meridian/actions/runs/37236867721/job/111537621268).
Actual installed Linux/OpenCode 2.0.16 catalog/import rehearsal retains all
15 messages with zero generations. Native readiness remains expired/401;
the specifically owned macOS credential fixture is absent. Exact affected-model
before/after generation and resume proof remain open; source #1213/#1212 stay
open. Recheck base/head/CI before any future integration.

The post-hostname paginated queue refresh at 22:00 UTC found 25 open PRs /
11 issues, including [checkpoint #1269](https://github.com/rynfar/meridian/pull/1269).
No new issue, unexpected PR or contributor head change appeared. Prepared drafts
#1266/#1267 remain unchanged; held release #1202 now leads at
`0b50bedabb1887297c63e562f425374c1dcd5030`. All six API coverages succeeded.
Separate release authorization remains absent. The checkpoint is rebased onto
`3afca1f5`; fresh final-head CI remains its own integration gate.

## Current continuation — 2026-10-03

Browser-login #1217 is delivered as 93d6c5c97daf9f21778cf5e6ecf90f12d53f40cb,
validated head e80b68adc99d2a0e7ccc3f6a86fb7b8ec3b0f94a. All six executed
final-head CI checks passed, including test run 37174543121/job 111354323110.
Exact merged tree and Nowaker co-author verified; unchanged #792 a9abcce8
closed and approval issue #1215 closed. Fresh automatic native re-authentication
and actual OpenCode/Opus receipt/resume proof supersede the older pending notes.

#1251/#1252 are delivered through [#1255](https://github.com/rynfar/meridian/pull/1255).
Validated head cc8b0634cf2369ee4c2e07b54b36065fd1996be8 merged as
240287e809cb57f675e7919de76f6d867a3d3352; exact tree
edffe0fb5327863fe006600fe524a3fb50bd4040 and Nowaker co-author verified.
All six executed final-head checks passed, including test run
37176043204/job 111358731010. Final local gates 5,296 / 0 / 35 platform skips,
typecheck/build. The owner approved the layout API contract under #1254;
issue closed. Both unchanged source heads (1251 74ac9017, 1252 3d02224d)
were refreshed and closed after delivery. Native browser matrices, actual
settings persistence, authenticated API controls, every HTML route including
standalone provider pages, reversible phone fitting, 169 unchanged desktop
elements and real browser grid flows pass. [Durable review/source maps](evidence/1251-1252-responsive-layout.md).

The #1243 retirement fault now has a maintained credentialless harness and
[bounded review record](evidence/1243-migration-retirement-review.md). Exact
source 6558c209f8bddf8e59b554d16c9834381c7817c2 still retires an unimported
older-writer replacement. Expected-hazard mode is a negative control, not fix
acceptance; parent #1245/cache and full migration acceptance remain open.

Paginated owner and both accessible organization repository discovery was
refreshed after the layout merge. The same six managed repositories are in
scope; no additional managed scrub repo appeared. Meridian has 18 open PRs
and 11 open issues; OpenCode scrub has #18 plus release #20, Pi scrub release
#15, and the other three scrubs have no open PRs/issues. Separate release
approval remains absent. Existing dispositions below continue to apply to
unchanged sources; release heads are live leads, never permission to publish.

#1257 API/setup-token credential metadata isolation is corrected in isolated
branch codex/api-profile-credential-isolation-20261003, base a079dc94b,
product commit 68a614ecd68a02467d693de39b4838dbba746447. Unchanged main
reproduces the metadata leak and wrong API logged-out demotion; actual CLI
2.1.289 + owned macOS Keychain + actual HTTP after controls make zero native
store reads. Eight isolated HTTP regression controls retain stored-Claude
plan/renewal/presence and unknown-store behavior. Native browser confirms the
API card no longer shows Max 20x or wrong logged-out status. SDK/model calls
are fenced. Final local gates 5,304 / 0 / 35 platform skips across 18 stages,
standalone typecheck/build pass. Integration [#1258](https://github.com/rynfar/meridian/pull/1258)
awaits final-head CI/merge.
[Durable proof](evidence/1257-profile-credential-isolation.md).

#1233 source c609e8d1a82b7c98114d65376474dcde5ed3ff56 is completely
reviewed for its opt-in hostname contract. [Issue #1259](https://github.com/rynfar/meridian/issues/1259)
records authenticated GET/PUT /settings/api/header and optional hostname on
unauthenticated /health while enabled. Owner decision is pending; no source
incorporation or new contract is authorized yet. After approval, compose the
current responsive header and verify all API/width/privacy controls. The source
PR remains reviewable and unchanged; no external comment was sent.

#1256 retirement-harness checkpoint delivered as
a079dc94bd313a830a318215d760baf7c984e695 from exact validated head
e189e454c7332868f8da22aa1a44b1445b408c2a; merged tree verified. All six
executed checks passed, including test 37176523505/job 111360151539.

#1246 is delivered through [#1250](https://github.com/rynfar/meridian/pull/1250).
Validated head `29799ce68a72e4f71ce77f9ba965e9d6b5ee0a91` merged as
`4170a8a7f30c98de99d411321158b41a71098b6f`; exact tree match and maintainer
credit verified. All six executed CI checks passed, including
[test](https://github.com/rynfar/meridian/actions/runs/37110676264/job/111167808247).
Issue #1246 closed through the validated merge. The older pending lead below
is historical; no release was authorized.

#1238 is delivered through [#1253](https://github.com/rynfar/meridian/pull/1253).
Validated head 5aa8c029abcbe54f4ede905d0686312070616f95 merged as
e2b09669b9140ba0eb8ebbec54cc504907e82cad, exact merged tree verified.
All six executed final-head CI checks passed, including
[test](https://github.com/rynfar/meridian/actions/runs/37173240035/job/111350364392);
issue #1238 is closed. Official agy 1.2.7 / actual OpenCode 1.18.30 / native
Gemini 3.8 Flash High pass 129/256 MCP catalogs, tail-tool receipts, client
results, negative controls and joined cleanup. Final local 5,154 / 0 / 4 skips,
typecheck/build. [Durable proof](evidence/1238-antigravity-tool-catalog.md).

#1230 is delivered through [#1249](https://github.com/rynfar/meridian/pull/1249),
validated head `af7a6a4020de4ef3eaae6d6b1abeb6f129e9c400`, merge
`67a19e50c743942ab0ed62d340d1caf143c6140b`. All six executed final-head
CI checks passed, including [test](https://github.com/rynfar/meridian/actions/runs/37107099227/job/111157663187);
5,144 local tests / 0 failures / 4 skips, typecheck/build. Merged tree exactly
equals the validated head and Noah Passalacqua credit is verified. Unchanged
source `d50e28062bad5b98f93359e268ce53aa8facd868` is closed. The later pending
#1230 leads below are historical.

#1246 executable selection is implemented on current main in isolated branch
`codex/claude-path-resolution-1246-20261003`. Published and current-main
Linux/OpenCode/mise before controls reproduce the exact 2.1.268 model refusal;
corrected Opus 5.5 selects 2.1.288, returns its receipt and leaves no owned
processes. Override and missing/broken PATH controls are retained. A real missing
native binary behind a mise shim required a version-probe fallback correction;
cold readiness now uses asynchronous resolution to keep liveness responsive.
Final local gates pass 5,151 / 0 / 4 skips, typecheck/build. Exact-head CI and
merged-tree gates remain. [Durable proof](evidence/1246-claude-path-resolution.md).

This checkpoint supersedes the pending #1242 and #1230 leads below.
#1248 is merged as `928bddc42b684680bc58f31a0aab18034197e8f3`; final local
and CI gates, exact merged tree and Nowaker credit were verified before closing
the unchanged #1242 source. No release was authorized.

#1230 source `d50e28062bad5b98f93359e268ce53aa8facd868` is accepted with
maintainer correction on current main. Actual Claude Code 2.1.287 PTY before/
after now reproduces native argument failure and verifies a rendered receipt
on macOS arm64 and Linux x86_64, with SDK 0.2.141/CLI 2.1.284 and native Sonnet 5.
Source-only code exposed a second live-prompt framing bug from trailing system
metadata; failing HTTP controls and source-only actual-client failures precede
the correction. Supported/off and print-mode omitted controls plus all four E41
modes pass. [Durable evidence](evidence/1230-interactive-thinking-display.md).
Final local/CI and delivery state must be refreshed before landing.

Browser-login #1217 current head `cc3dee1140d84cc5bc59476138e64c345504f977`
has 5,248 passing local tests / 35 platform skips, typecheck/build and all six
executed final-head CI checks passing (test run 37102721775). Its existing-account
assisted grant exchange is proved, but fresh automatic browser callback and
post-grant client proof remain open. The preview currently requires account
sign-in; no fresh authorization completion is claimed. #1245's owner-approved
async cleanup (#1244) still waits for the unexplained original 200-token
canonical prefix loss, not renewed public-contract approval.

Bounded review of #1243 current source
`6558c209f8bddf8e59b554d16c9834381c7817c2` reproduces a legacy migration
retirement race: an older writer atomically replaces sessions.json after the
digest read, then retirement renames that unimported replacement away from the
active path. Fault-control result: 0 pass / 1 fail. Bytes survive in the retired
file, but automatic restart cannot recover those unimported mappings. Legacy
writer-lock participation or an equivalent crash-safe protocol, composition
with #1245's caller snapshots/revocation fences, and the parent acceptance gate
are prerequisites. This is not a completed full SQLite acceptance review.

#1223 current source `537ccad864336a4f4dc25f925e92177cd12fe6b2` still grants
a second lease while the synthetic original holder is kernel-confirmed SIGSTOP
and alive; current main refuses. The maintained ownerless fault harness was
rerun on both exact heads. Decline age-only same-boot recovery; reconsider with
affirmative owner-death/boot evidence or actual write fencing.

## Goal-backed backlog continuation — 2026-10-03 UTC

Owner explicitly requested a goal and continuing through whatever open PRs can
be completed. The active goal covers the managed Meridian/scrub queue, with
no release authorization or external community comments. Owner's dirty main
checkout remains untouched; all new work uses isolated feature worktrees.

Paginated account + accessible organization discovery refreshed the live queue
across six managed repositories: Meridian, hudscrub, and Hermes/OpenClaw/
OpenCode/Pi scrub. The plugin-doc links match the discovered repositories.
No additional accessible scrub repositories were found. New source items
#1242 and #1243 and issue #1246 are added to the current queue. #1213 is now
ready for review (same `553fd5c` head, no longer draft); its actual V2 catalog/
large-replay evidence gate remains and draft status is no longer a blocker.

- **#1240 / #1239:** accept with a separate fixture correction. Source
  `d868637455387e0359f1b3f4975caaf5fb1399ac` → authored cherry `cbdd5d17`;
  robertn702's Author/AuthorDate retained. Integration
  [#1247](https://github.com/rynfar/meridian/pull/1247), current head
  `c1a345e2b5f44b33b118e56036517e5660b9255e`, branch
  `codex/replay-budget-isolation-1240-20261002`, worktree
  `/Users/rynfar/repos/meridian-replay-budget-1240`. Exact ordered-load
  reproduction: 11 pass / 2 budget failures; isolated original assertions
  13/13. Initial full local gates 5,125 pass / 0 fail / 4 skips, typecheck/build
  pass. Initial CI exposed an SDK gate test readiness race, reproduced with
  300 ms delayed real gate fsync; worker-ready preceded asynchronous publication.
  Maintainer commit `c1a345e2` adds actual-executor startup and controlled-release
  handshakes. Delayed control and all five lifecycle process tests pass.
  Corrected full local gates pass 5,125 / 0 fail / 4 skips across 17 stages,
  typecheck/build pass, and all ten executed final CI checks pass. Merged as
  `802d9398f609eb49b4c93fe34c306b872ebeb647`; merged tree exactly equals the
  validated head and its human co-author trailer is verified. Unchanged source
  #1240 is closed; #1239 closed through the validated integration.
  [Durable evidence](evidence/1240-replay-budget-isolation.md).
- **#1242:** delivered with narrowing correction.
  Source `a2408b82ca4c05e8ed1c770b1ac72615ef1bdd85` → authored cherry
  `6912ec9f`, now rebased as `37ade6ab` (Nowaker / original authored date
  retained). Maintainer correction `f11c355b`, now `a42c696e`, preserves recovery wording before a tool result or beside meaningful
  user text; recognize only the actual synthetic tail. Source regression control
  16 pass / 1 fail → corrected 18/18. Merged integration
  [#1248](https://github.com/rynfar/meridian/pull/1248), worktree
  `/Users/rynfar/repos/meridian-prefill-lineage-1242`, branch
  `codex/opencode-prefill-lineage-1242-20261002`. Real OpenCode 1.18.34 + released
  oh-my-openagent 5.1.12 transform + independent scrub 0.2.3 + SDK 0.2.141 /
  bundled CLI 2.1.284 + native Sonnet 4.6, macOS arm64, Bun 1.4.2:
  three actual tool recovery rounds caused two replays on unchanged `d57388724`
  and zero replays after the fix; both return the tool receipt and join cleanup.
  Source + correction full local npm test 5,130 pass / 0 fail / 4 skips,
  typecheck/build pass. All four E41 chain/parallel JSON/SSE modes pass
  unchanged cache/history assertions. Final client harness also passes joined
  cleanup with four observed recovery rounds / zero replays. Rebased onto
  test-only main `802d9398f`; product code equals the live-tested tree. Fresh
  full local gates pass 5,130 / 0 fail / 4 skips across 17 stages,
  standalone typecheck/build pass, and all six executed final-head CI checks
  pass. Final head `ae5eb07cf5e2f1284903e73086f4baec8bb61f17` merged as
  `928bddc42b684680bc58f31a0aab18034197e8f3`, with exact merged-tree and
  Nowaker human co-author verification. Unchanged source #1242 is closed.
  [Durable evidence and maintained harness](evidence/1242-opencode-prefill-lineage.md).
- **#1243 `6558c209f8bddf8e59b554d16c9834381c7817c2`:** queued, not yet fully
  reviewed; contributor explicitly stacks its SQLite store/journal migration
  after #1220. Respect that dependency. The full diff is retained locally; do
  not treat contributor production measurements or green CI as completed
  migration/rollback/cross-process/live-client review.
- **#1245 / #1220:** remain draft/pending the unexplained original 200-token
  canonical prefix reduction. The user-approved async cleanup contract is
  recorded in #1244 and the integration PR; do not ask again. All corrected
  local gates and prior final-head CI pass. Real encrypted-transport retry
  control proves aggregate billing can overstate a canonical cached prompt;
  it does not explain the residual 200 tokens in the original fixture. Baseline
  retry control confirms aggregate accounting before this source change, but
  its continuation was interrupted, so do not claim a complete baseline E41
  result. Latest facts live in #1245's PR body. Persistent valid owned native
  fixture is available; the earlier temporary re-authentication directory has
  been removed. Never print grant values or authorization codes.

- **#1217 / #792 — next active delivery:** recovered the existing integration
  into a fresh isolated branch from main `928bddc42`, preserving all four
  authored Nowaker commits and separate prior corrections. Current authored
  SHAs: `13e8e349`, `fa431b65`, `fb6e2ae3`, `072669a9`; refreshed source remains
  `a9abcce8c693dae018ff73872051a9dfeabe21b6`. Worktree
  `/Users/rynfar/repos/meridian-browser-login-finalize-792`, local branch
  `codex/browser-login-finalize-792-20261003`; the existing draft #1217 is reused,
  not duplicated. Documentation conflicts retained both E2E flows and the
  current main handoff. Old detached recovery worktree is left intact.
  Standalone typecheck/build passed before the final test-only/main-adapter
  rebase; fresh full gates are next. Assisted re-authentication completed as
  recorded below and in the corrected PR body. Automatic browser callback is
  still an explicit gate. Product-native preview tab `tab_4` is available,
  currently hidden/about:blank; its first open returned not-yet-ready and a
  corrected status call confirmed availability. No alternate browser was used.
  Prior scoped owner authorization covers these selected profile contracts.
  Keep all authorization URLs/codes/grants private. The persistent owned native
  credential fixture is available; do not depend on removed temporary roots.
- **New issues:** #1246 requests PATH Claude precedence in Linux x86_64 /
  OpenCode 1.18.34 / opencode-with-claude 1.10.1, with an older cached 2.1.268
  CLI hiding a newer mise 2.1.288 install. #1238 requests relaxing Antigravity's
  128-tool cap with actual OpenCode 1.18.30 / agy 1.2.7 / Gemini 3.8 Flash-high.
  Their bodies are read and retained as queued issues; no delivered fix is
  claimed. Match the exact affected platform/client/model when reaching them.

Remaining earlier dispositions below are dated leads. Refresh live heads before
acting, continue independently actionable PRs while these wait, and use exact
head matching and required CI for every merge. Release Please PRs remain held
for separate release authorization.

## Additional Nowaker work (2026-10-02)

Owner authorized continuing more Nowaker work. #1222 source `1bffa43fe` is
cherry-picked on fresh main `f443faee0` as `66d6d2cc`, with separate ping-report
and independent-process probe corrections. [Evidence](evidence/1222-late-idle-deadline.md).
Actual macOS/Linux OpenCode/Opus baseline false stalls and corrected
receipts/resume pass, as do independent Node/Bun socket controls, all four E41
modes and final local tests/typecheck/build. Integration is [#1241](https://github.com/rynfar/meridian/pull/1241); its live
state and final-head check links are the authority for CI/merge disposition.
Required final-head CI remains a merge gate. #792 existing-account re-authentication now completed and its native
grant changed with the same profile mapping. The preview blanked at its
localhost callback; replaying that original callback privately to the same
server via 127.0.0.1 completed exchange. This is assisted callback evidence,
not automatic loopback proof. Draft #1217 remains unfinished. Other public
contract/deferred gates remain in the takeover record.

## Takeover checkpoint (2026-10-02)

[Current dispositions and proof](BACKLOG_TAKEOVER_2026-10-02.md) supersede the
October 1 status leads below. #1187 incorporated with corrections as #1235,
merge `c0af34eaa`, verified exact tree/CI/Nowaker credit and source closure.
#1221 correction and actual macOS/Linux proof merged as #1236, `e1f8bc473`;
exact tested tree/CI/Nowaker credit and source closure verified. #1217 rebased head `eb0c2b9e` has all executed
CI passing, but remains draft pending real existing-account re-authentication.
#1234 exact plugin pins and a reproduced `/inflight` queue-fixture correction
are in #1237; final-head checks remain required before merge. General CI flake
issues remain open. #1176 is deferred until a supported OpenAI-serving backend exists. #1175 already
merged as #1227 (`3cb65df0c`). No release or external community messages.

## Prior active authorized backlog (2026-10-01)

**Nowaker priority checkpoint (2026-10-01).** #1171 incorporated with corrections
as [#1225](https://github.com/rynfar/meridian/pull/1225), merge
`bd00c164d198a368956c79658897a6360a0cd5ea`; #1190 incorporated with corrections
as [#1218](https://github.com/rynfar/meridian/pull/1218), merge
`310dd95698b27484ff5bc0feb88f59f365ef58c0`. Both merged trees equal their
validated heads, all executed exact-head CI passed, Nowaker co-author credit
verified, original heads unchanged before closure. Durable records:
[evidence/1171-build-provenance.md](evidence/1171-build-provenance.md) and
[evidence/1190-request-activity.md](evidence/1190-request-activity.md).
#792 draft [#1217](https://github.com/rynfar/meridian/pull/1217) proves new-account
creation and real OpenCode use; re-authentication still awaits a completed
human Claude authorization. #1187 is being completed in an isolated takeover branch;
#1176 is deferred until Meridian has a supported OpenAI-serving path. #1175 correction and
actual bundled HTTP/browser proof are recorded in
[evidence/1175-update-setting.md](evidence/1175-update-setting.md); merged as #1227 at `3cb65df0c`; final-head CI and human credit were verified.
No release authorized.

Owner requested a persistent goal covering PRs/issues, authored cherry-picks,
maintainer corrections and headless actual-client evidence. Initial paginated
inventory: Meridian 18 PRs / 11 issues; OpenCode scrub 2 PRs; Pi scrub issue #13;
Hermes scrub, OpenClaw scrub and hudscrub empty. Accessible owner/org repository
discovery found no additional scrub candidates. No release or community-message
authorization. Preserve the dirty desktop checkout at `446a0f163`.

**#1191 accepted and integrated as #1196.** Refreshed exact source/base/head and
all required CI before squash. Merge `c04a861ba8a4fb71d105065afa9b73019d9985f4`
has tree `0f62d771d385bcbd619725072a449811524177c8`, identical to validated
`84902f520bfa70f85227369b40f1cde0518070e5`. Explicit verified Nowaker human
co-author trailer present. Source head unchanged at closure. Existing independent
browser proof and local/CI gates remain valid: base did not change before merge.
The collaborative preview initially failed, then recovered. Its repeated live
phone/desktop probe matched the retained measurements exactly: 375px page/client
360/360, internal table scroll 311px; desktop 1265/1265 with no inner scroll;
rule-removal control 626/360. No unrelated model calls for CSS.

**#1197 accepted and delivered as [#1203](https://github.com/rynfar/meridian/pull/1203).**
Source `3baf6f59` cherry-picked as `e97c6f61`; Author/AuthorDate preserved.
[Durable proof](evidence/1197-auth-refresh.md) includes the committed real-CLI
delay harness: unchanged baseline health probes 2258 ms, fixed 2–4 ms, one
refresh. Actual headless OpenCode 1.18.33 / Opus 5.5 / SDK 0.2.141 / scrub
0.2.3 same-session continuation passes. Final local suite and exact-head CI
passed: final npm test 4949 pass / 0 fail / 4 skip, standalone typecheck and build;
all six executed CI checks passed, including
[test](https://github.com/rynfar/meridian/actions/runs/36820232911/job/110234024099).
Merge `98c48c03ff65f0b8ce428c8b60718655c49f85dd`, tree
`40110cc03377380c1a9ef4568ef28a4079880e89`, identical to validated head
`96aaac51`. Nowaker co-author trailer verified; source unchanged at closure.

**#1186 corrected and incorporated in #1204, merged.** Source `9d33e45f` maps
to authored cherry `3849868f`; ownership/immutability correction `1ec6f47e`,
proof `e74eb796`, process-isolated timing gate `1cefadb3`.
Merge `2404eae1eafbc530e472a0bf28b775f2b7956689`, tree
`167c4031cb95ca8e6113c2279909d322bc0b3936` equals validated tree.
4967 tests, all ten executed CI checks, typecheck/build and two real OpenCode
1.18.33 / Opus 5.5 clients with independent tool-result receipts/continuations
pass on final rebased tree. Four-mode E41 passes on the identical store blob.
Nowaker credit verified; source unchanged at closure.
[Evidence](evidence/1186-store-mutation.md) records failing shallow-freeze tests,
lazy exposure, benchmark noise and initial full-suite isolation failure.

**#1198/#1199 incorporated with correction in #1205, merged.** Source SHAs
`959dc6c5`/`b6cb22e0` map to authored cherries `01d37638`/`503ba3c0`.
Maintainer sort-control correction and probes `5851f8d1`. Merge
`dedb55564aedccb9e207167f4ae148aeac112e0d`, tree
`eb04d210092729c37e2e52ea44f8a765772a6729` equals validated tree. 4958 tests,
all six executed CI checks, 28 real browser baseline/final cases and compiled
Node asset HTTP gate pass. Nowaker credit verified; both sources unchanged at
closure. [Evidence](evidence/1198-1199-mobile-layout.md); local media captured,
no durable GitHub media upload claimed because no uploader was available.

**#1189 accepted with correction and merged as #1206.**
Source `c2f4b67f` maps to authored cherry `6baaf143`; correction `632445c4`.
Real Node processes confirm authored reporter makes warn/none fatal and aborts
warn-with-error-code before its timer. Error.name leaks a synthetic Bearer value.
Corrected policy preserves all five modes, CLI-over-NODE_OPTIONS precedence
and strict-mode exact-once reporting; names scrubbed/bounded before spool.
Retained headless gate: 22 Node/Bun paired configurations and four actual
compiled test-error-report CLI cases pass against local collector.
[Evidence](evidence/1189-error-reporting.md). Final npm test 4985 pass / 0 fail / 4 skip, typecheck/build and all six
executed CI checks pass. Merge `cc74cd2dd65ec3a246512179fc7958a79a1bccd6`, tree
`aace784e254fe63e4646563c06d9174aac41ac94` matches validated head `a9d1112d`.
Nowaker co-author credit verified; source unchanged at closure. No third-party collector claimed.

**Pi scrub issue #13 resolved by merged plugin PR #14.**
Exact Pi 0.87.1 found under renamed package @earendil-works/pi-coding-agent.
Published scrub 0.2.2 and current scrub main `23c98fac` reproduce two test
failures. Complete header-scoped <docs> removal corrects both (17 pass/0 fail),
preserving adjacent foreign documentation and project context.
Actual headless Pi 0.87.1 / Opus 5.5 / SDK 0.2.141 macOS flow through an
independently installed fixed tarball removes all docs, retains project
instructions and completes a read with random client-only tool-result receipt
and a continuation. Both turns have zero errors. Pi arrives as adapter=opencode
in this real custom-provider flow; content-scoped scrubbing correctly applies.
Baseline also observed billing_error, which is not claimed as universal billing
causation or a guaranteed billing remedy. Final-head build CI passes; merge
`188115f355f423cbff50b20a2e5fd7d932ec1746` tree
`e4002e54eb2ed3c9822f27425befabf9a8a9b347` matches tested head `adc3b140`.
Issue closed. No publication authorized.

**#1200 accepted with design corrections and merged as #1207.**
Source `517c91bd` maps to authored cherry `f90db029`. Shared-header profile
anchors/search preserve routing. Restore DESIGN.md section micro-labels, bound
pulse tint and add reduced-motion CSS. Actual browser matrix with 14 synthetic
accounts passes 320/375/800/1280 widths, header content growth, aliases, polling
focus/scroll, filter/reorder controls and zero mutations following a home link.
[Evidence](evidence/1200-profile-find.md) explicitly corrects an initial padding
probe: no application timing defect claimed, speculative timing change removed.
Final full local gates: 5010 pass / 0 fail / 4 skip, typecheck/build. All six
executed CI checks pass. Merge `4c5e602e2640348a0fa32668e30e2e621eea700c`,
tree `6256b0e41b9171250164acc895373ae67be371e0`, matches validated head
`8aef41ba`. Nowaker credit and unchanged source head verified before closure.
An unchanged Antigravity one-second probe failed once under full-suite load;
baseline/final focused probes pass and the repeated full suite passes.

**#1192 delivered as #1208, merged.** Source `4e55f7de` unchanged at
closure. Authored cherry `b636e878` and maintainer harnesses preserve credit.
Merge `b4d23428ea6b7dd9d7f4878e3fd59ad92bcb4e9f`, tree
`152e52dac326451533d7e8636111ebc75d4352b5`, equals validated head
`72a82eaabe32a52b52d7fb05d47d06ee4dc5f208`. All six executed CI checks pass,
including [test](https://github.com/rynfar/meridian/actions/runs/36829379659/job/110262244694).
5014 local tests / zero failures / four skips, typecheck/build and actual
macOS/Linux headless OpenCode controlled rejection plus live Opus 5.5 receipts
and continuations pass. Nowaker co-author verified. Detailed proof in
[evidence](evidence/1192-deferred-tool-recovery.md) after rebasing this checkpoint.

**#1177 critical idle regression advanced ahead of remaining feature proposals.**
Reason: ping-only SDK events can indefinitely postpone a stalled client's error.
Fresh issue/discussion confirms reported macOS arm64, SDK 0.2.141, Claude Code
2.1.283 and Pi; exact Pi/model version omitted. Fork checkpoint `b004b952` is
only packaging; actual authored fix is `f261fc9e0259f6ac92157051e1bec38a19eeac77`
by Nate Berkopec, cherry-picked as `5f488d8e` with Author/AuthorDate retained.
Resolve conflicting fork version metadata by retaining main 1.79.0; separate
maintainer commit `70385c83` removes fork-only packaging workflow. Current main
and published 1.76.5 share guard blob `b93ea333e1263b903dac074baf30942a480f5607`.
Authored reproduction exits 1 before (120 seconds of ping-only events), 0 after
(timeout at 90 seconds); focused controls pass 8 tests. Full suite and actual
client/model evidence are recorded below; a unit replay alone is insufficient.
A disposable real SDK / CLI 2.1.284 local API probe filters transport pings
before message_start and ends with no_events, rather than reproducing the nested
SDK event. The longer 2.1.283 probe observed six actual nested SDK pings. Its duration
differs from the short 2.1.284 probe, so no version-dependent fix is inferred.
The compiled real Pi 0.87.1 / SDK 0.2.141 / Claude Code 2.1.283 / Node 26.8.2
on macOS arm64 before/after passes: unchanged 15-second idle limit waits
35178 ms for synthetic output; corrected times out at 15007 ms, zero completed
answers. Separate actual Opus 5.5 read result and same Pi session continuation
pass with that CLI/platform. [Durable proof](evidence/1177-sdk-ping-idle.md). Initial probe used a nonexistent
cli.js and then misclassified /messages?beta=true; corrected pathname/binary
selection, no product defect claimed for those setup errors.

**#1201 pending actual-client proof.** Source `30e01969`. Public implicated
client is `XInTheDark/meowbert-ai-agent`. Its own commit `08e771a9` (2026-10-01
01:07:50 UTC) identifies Opus and fixes interleaving by recording all response
calls before outputs. Current client already uses that ordering. Original
affected model/version and before-code live path still need establishing;
owner does not know them. Do not call a synthetic HTTP-only success actual
Meowbert E2E. Continue independent work while that gate is open.

**Final behavior deliveries and queue dispositions (2026-10-01).**
#1177 merged as [#1209](https://github.com/rynfar/meridian/pull/1209), merge
`0f2a4a541b3b7b14022317ecd9ffe14c149b8f1d`, tree
`d1250b1c059860ff994ef0cf9b86f046eee64788` equals tested head
`d08011f8624d62ef8f66d261cc9b1295eaf7883d`. Final local suite 5017 pass /
zero fail / four skip, standalone typecheck/build and all six executed CI checks
including [test](https://github.com/rynfar/meridian/actions/runs/36831203611/job/110267982115)
pass. Nate Berkopec co-author trailer verified; issue closed by validated fix.

OpenCode scrub #5 accepted with correction in merged
[scrub #19](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/19).
Source `40094cd9adaef32456befa54c1b969d611785395` retained as authored cherry
`eddcf85a40701b94c6b95cfbe16b7cd644d57350`, maintainer correction `a2c479c`.
Restore current guards/OMO fixes and remove environment preamble in minimal
mode while keeping cwd, policy and optional identity rewrite. 28 tests / zero
fail, typecheck/build/pack, two default fixtures byte-identical to main; actual
OpenCode 1.18.33 / Opus 5.5 / SDK 0.2.141 / Code 2.1.284 on macOS arm64 passes
actual read receipts/same-session continuation in both modes, independent
installed tarball. Final escrowed minimal harness rerun also passes. Final-head
[build CI](https://github.com/rynfar/meridian-plugin-opencode-scrub/actions/runs/36832792431/job/110273021200)
passes. Merge `77316d2ba4ed77ef3d5f12e40256ba1c3699d85a`, tree
`fbb9c0a4e44ab2161a0854fe93c305db30cc3b2d` equals tested `a2c479c`.
briankeefe human co-author verified; source unchanged before closure. No
publication. [Durable plugin proof](https://github.com/rynfar/meridian-plugin-opencode-scrub/blob/main/docs/evidence/5-minimal-mode.md).

[Complete refreshed dispositions](BACKLOG_DISPOSITIONS_2026-10-01.md) record
all remaining source heads, product-fit/regression findings and observable
revisit triggers, including reproduced #792 prototype-dictionary skip. Current
owner closure of #1009 does not supply historical missing abort-window proof.
No release or external message performed. The queue retains explicit public
contract, actual-client evidence, dedicated-lane and credential gates; it is not
empty. Refresh live status before resuming any deferred item.

## Historical PR review and plan (2026-09-29)

Live inventory: 12 Meridian PRs and two OpenCode scrub PRs, refreshed against
`0ec52a28d9c70d0f9aa84767613c7a08125d25e4`. See the
[prioritized plan](PR_REVIEW_PLAN_2026-09-29.md) for each source head,
disposition, correction and E2E gate. This supersedes historical ready/draft
status for #792 (now ready); #1192 remains draft under author observation.

Delivery [#1196](https://github.com/rynfar/meridian/pull/1196) was open at this checkpoint; it is now merged as recorded above.
Local gates passed: 4,943 tests, 0 failures, 4 skips; typecheck/build and the
retained browser probe passed. Required final-head CI remains tracked on the PR.

#1191 is incorporated as authored commit `de0f00329ce0468e3b3bc274e197fbbd199fa407`
in `/tmp/meridian-review-20260929`, branch `codex/pr-review-plan-20260929`.
[Independent browser evidence](evidence/1191-settings-overflow.md) proves the
pricing overflow fix at 375px with a failing rule-removal control and desktop
parity. Other viewport overflow remains outside the pricing table. The larger
PRs have a triage plan, not completed independent acceptance validation.
No merge/release/comment/source closure is authorized or performed by this entry.


## Contributor fix batch #1174/#1178/#1172/#1173/#1169 (2026-09-28)

Live queue at start: 9 contributor PRs plus release PR #1167 and own #1050, from
`origin/main` `8d4c88ce`. Bug fixes were taken before the four feature proposals
(#1176, #1175, #1171, #792), which remain untriaged and are not approved by this
entry. Worktrees `/private/tmp/mer-117{2,3,4,8}` and `/private/tmp/mer-1169`.

**#1174 session retirement backlog — accepted with maintainer corrections.**
Delivered as [#1179](https://github.com/rynfar/meridian/pull/1179), merged
`074c44b8f116fa546e6c18df28292492c5a85b2d`, tree
`826f06ecc9e37d1fd936b51b60558c013daae3aa` identical to the validated head
`e4f97c93`. Source `389f3c543ab3b7fec6c9bbf86e3fe49fc807ccbd` by Nowaker
(`spam@nowaker.net`, 2026-09-27) retained as `20058f649` with Author/AuthorDate;
`Co-authored-by` present on the squash. Source head unchanged at closure.
Reproduced first: contributor tests alone on unmodified main returned the exact
`overloaded_error` "retirement backlog is full" 503 in both modes (baseline
49 pass/0 fail on those files beforehand), 53 pass/0 fail after. Verified that
`retired → live` cannot resurrect a transcript for resume: the gc sidecar has no
state readers outside `sessionLifecycle.ts`, resume authority is `sessionStore`,
and reconcile's pin rescue already performs that transition.
Known limitations recorded in the PR: sustained saturation defers the newest
retirements so the effective ceiling becomes the larger `maxOwned` one, and
demotion clears `lastError`/`nextAttemptAt`, resetting a persistently failing
deletion's backoff from up to 1 h to the 11 min grace (caused by reconcile's
pre-existing re-stamp, newly reachable).

**Broken #923 gate repaired in the same PR.** `scripts/e2e-retirement-admission.mjs`
had failed on main since `6ecfbaa7` (2026-09-23) made a profile switch retain
session mappings: it asserted the switch emptied the store, so it aborted before
any retirement assertion and the documented gate could not pass. On current main a
switch leaves both transcripts `live` with `pending: 0`. It now unpins explicitly,
as cache eviction and a proxy restart do, and passes both modes. **Worth auditing
whether other documented gates drifted the same way.**
New gate `scripts/e2e-retirement-concurrent-admission.mjs` (E2E.md "Concurrent
retirement admission"): the sequential gate cannot reach this refusal. With the fix
reverted on the same tree, 2 of 3 concurrent real turns took that 503; with it,
both modes passed with per-turn transcript isolation and no overbooking.

**#1178 client tool-change blocks — accepted as proposed.** Delivered as
[#1180](https://github.com/rynfar/meridian/pull/1180), merged
`e8e74434a395e32314a5664cc867e39892f10127`, tree `5f8266f0` identical to validated
head `33ad5229`. Source `175e6bb969b0571c5b11bb739534171f28318faf` was authored by
the placeholder `Preview User <preview@example.invalid>`, a preview-tool default;
recorded under the verified identity `Mate Remias <materemias@gmail.com>` (owner
decision) with AuthorDate preserved, `Co-authored-by` present. Live RED on
unmodified main returned `500` carrying `API Error: 400 messages.0.content.8: Input
tag 'tool_addition' ...`; GREEN answered `PONG` in both modes with `lineage=new`.
New gate E68 `scripts/e2e-replay-tool-change-blocks.mjs`.
Verified the fix is correctly scoped: on resume only `role === "user"` messages pass
through `normalizeStructuredUserContent`, so tool-change blocks never reach the SDK
there. **Open limitation:** the structured path still forwards every unknown block
type while the text path drops them, so another non-standard block in a client
`system` message fails identically. A block-type allowlist would close the class
but could swallow legitimately new types; left as a product decision.

**#1172 windowsHide — accepted with a maintainer correction.** Delivered as
[#1181](https://github.com/rynfar/meridian/pull/1181), merged
`2a502b7a7ba9c49384343f5a1391192f17603404`, tree `eea504a2` identical to validated
head `1542b5b4`. Source `8afda574` by `arch <arch@not.me>` preserved verbatim — a
self-chosen pseudonym, unlike #1178's tool default — `Co-authored-by` present,
source head unchanged at closure. The fix shipped with no test; the maintainer
commit asserts the probe's `windowsHide` through `models-auth-status.test.ts`'s
existing `child_process` mock, verified RED (`Expected: true, Received: undefined`)
against the unfixed probe. **The Windows symptom was not independently reproduced**
— this review ran on macOS arm64, where it cannot occur. The behavioural evidence
is the contributor's window watcher (0 windows over 150s with two prompts 71s
apart, versus one per ~100s before). Owner accepted that evidence explicitly.

**#1173 OpenCode skill_content — accepted as proposed.** Delivery
[#1182](https://github.com/rynfar/meridian/pull/1182) on
`codex/opencode-skill-content`, source `0c80a42c281f65fb0f1c599146634eb978df8b5a`
by `arch <arch@not.me>` preserved. Contributor tests alone on unmodified main gave
the reported 7 failures; 42 pass/0 fail after. The client gate needs OpenCode V2
and the scrub plugin and could not run here (host has 1.18.33 V1), so a portable
HTTP arm sends V2's composer shape against the real SDK: reverting only
`sanitize.ts` fails with "The skill body did not reach the SDK prompt" in both
modes, all four arms pass with it. Renumbered to E69 in a maintainer commit because
E68 went to #1180.
**Behavioural caveat, repeatedly observed:** Haiku called the `<skill_content>`
block "a prompt injection attempt" and declined it, including with an explicit
typed request. The fix provably delivers the body to the model; it does not make
the model act on it, so a bare `/skill` may still not do what the user expects.
The gate therefore asserts structure (receipt, wrapper and nested `skill_files` in
supported SDK history) and only *records* `complied` versus `quotedReceipt` — an
earlier reply-based assertion passed on a refusal that quoted the receipt.

**#1169 bounded fresh replay — accepted, corrected by us on owner instruction.**
Delivered as [#1183](https://github.com/rynfar/meridian/pull/1183), merged
`4e845f29f800283dc21b2c0c24f156961b6fb680`, tree `d1e1b397` identical to the
validated head `4910ee10`; `Co-authored-by` present and source head `cec690477`
unchanged at closure. Sources `324a37f290`, `653be40358`, `cec6904775`
by Aleksey Proshutinskiy (`alexey.prosh@fluence.one`, 2026-09-26) cherry-picked
with Author/AuthorDate; correction in a separate commit.
Verified as correct: lineage, message hashing and the SDK UUID map all see full
history (the trim sits after that work, and `buildToolUseIndex` uses full
`allMessages`); `replaySource` holds the untrimmed array by reference so re-trims
do not compound; `freshReplay = !isResume && !resumeSessionId` really excludes
resumed attempts; a message of only `tool_result` blocks cannot start a droppable
group.
**The defect we corrected:** the flat 64k reserve is 6.4% of a 1M window but 32% of
a 200k one. Stacked on the 0.9 factor and an estimator that overestimates Latin
text, the 200k budget was 58% of the window, dropping history from about 101k real
English tokens (~70k Cyrillic). Only the 1M case was analysed upstream, while
extended context is opt-in. Capping the reserve at a tenth of the window leaves the
1M budget byte-for-byte at 836_000 and lifts 200k models to 160_000, the same ~80%
share; the 1M figures reproduce the contributor's own stated 730k/500k thresholds,
which is what validates the 200k measurement.
Two fixtures changed deliberately: `replayBudgetFor("sonnet")` 116_000 → 160_000,
and the "indivisible live tail" case, whose literal `"я".repeat(200_000)` (133k
estimated) stopped overflowing once the budget rose and so quietly tested nothing —
now derived from the budget with an explicit overflow assertion.
Added `MERIDIAN_REPLAY_BUDGET_TOKENS` (test-only, opt-in, ignored when unusable)
because the trim cannot otherwise be proven against a real model at any affordable
conversation size, plus gate E70 `scripts/e2e-replay-budget.mjs`: both modes trimmed
12 messages (~3114 estimated tokens), kept the live tail, carried the omission
marker and answered from the surviving tail; the control with the override disabled
fails the oldest-turn assertion, so the gate is not passing by construction.
**Not proven:** the original `context_overflow` 400 and the reactive retry were not
reproduced live — both need a genuine overflow from the model and remain covered
only by the mocked envelope tests. Recorded in E2E.md.

**`npm ci` is broken on main — still open.** `package-lock.json` pins
`@anthropic-ai/claude-code-win32-x64@2.1.257` while `claude-code` resolves to
`^2.1.280`/`2.1.283`, so `npm ci` fails outright. CI runs only `bun install`, so no
gate catches it; any clean install or contributor using `npm ci` fails. Not bundled
into a contributor PR.

**#1173 delivery merged.** [#1182](https://github.com/rynfar/meridian/pull/1182) is
`26c41f9f09806db9c95fa2805b642983b3c059f1`; `Co-authored-by: arch` present, source
head `0c80a42c2` unchanged at closure. Its branch predated #1181, so the squash
layered the validated diff onto a newer base and the merged tree legitimately
differs from the validated head by exactly #1181's three files. That combination had
been tested by neither the branch nor CI, so merged main was verified separately:
4903 pass / 0 fail / 4 skip.

**`npm ci` fix delivered.** [#1184](https://github.com/rynfar/meridian/pull/1184)
regenerates the lockfile. `package.json` was bumped to `^2.1.280` without
regenerating it, so the lockfile kept the `^2.1.257` range and pinned every platform
package at `2.1.257`. Regeneration aligns it with the range `bun install` already
resolved rather than introducing a version. `npm ci` fails on the parent and exits 0
after; 4903 pass / 0 fail.

**E2E gate audit (bounded).** All 78 scripts referenced by E2E.md exist; the 8
unreferenced scripts are `-host.mjs` helpers and probes invoked by parent gates. The
#923 drift class is isolated: no other gate assumes a profile switch empties the
mapping store. A "gates with no assert" heuristic flagged ~30 scripts and was
disproved — they use a failure-counter plus `process.exit(1)` idiom and do verify.
**This audit did not execute the gates**, which needs real models at prohibitive
cost, so it rules out dangling references and that one drift class, not gate rot in
general.

**Feature PRs triaged, none incorporated, none approved by this entry.**
[#1175](https://github.com/rynfar/meridian/pull/1175) version display and opt-in
update check: recommend accept, but it deliberately changes `/health` — `build.latest`
and `build.updateAvailable` become absent until `checkForUpdates` is enabled, and
`/health` is on the stable-API list, so drift monitors need the setting.
[#1176](https://github.com/rynfar/meridian/pull/1176) OpenAI list pricing: accept
with reservations — a daily PR-opening workflow needing an Actions setting, a
hand-maintained second-vendor price table as a standing obligation, and the
actually-served-by-OpenAI path unit-tested only (no ChatGPT backend upstream).
[#1171](https://github.com/rynfar/meridian/pull/1171) build provenance: defer pending
a scope decision — 27 files, a new authenticated `/build-status`, a per-worktree
counter ledger and an observation worker, with no full `npm test` claimed, on top of
already-shipped #866 provenance.
[#792](https://github.com/rynfar/meridian/pull/792) web profile login: defer, needs a
dedicated security review — it makes `/callback` deliberately public and holds
server-side PKCE verifiers; largest of the four and will need rebasing.

Next actions: triage the remaining feature PRs on their own terms, and consider
whether the two drifted-gate findings warrant executing high-value gates
periodically rather than only on change. No release is authorized by this entry, and
no contributor comment has been posted on any of these PRs.

## #1165 interrupted OpenCode checkpoint review (2026-09-26)

Disposition: accepted [source #1165](https://github.com/rynfar/meridian/pull/1165)
with a maintainer safety correction in [delivery #1166](https://github.com/rynfar/meridian/pull/1166).
Source head
`758d80b86ea744f0eeadb6a28e8bf1f546cd3ade` by Nikita Bige
(`wargloom@gmail.com`, authored 2026-09-26) was unchanged at closure; its
unsigned commit blocked direct merge. The signed cherry-pick `965bef6c` from
base `cd1ada92057926ee0bceeddaeca42318d0f06b07` retains Author and
AuthorDate. Maintainer correction and evidence are separate commit `cf48561a`
on `codex/review-resume-1165-20260926` in isolated worktree
`/private/tmp/meridian-review-resume-1165-20260926`.

The source helper verified the first complete tool-result batch but ignored
later messages once it found an assistant turn. Direct tests proved it would
resume after later unknown or duplicate tool results, tool calls, or system
reminders. The correction accepts the observed text-only partial assistant
turn followed by ordinary user turns, and keeps those mismatches on replay.
Focused pure and HTTP tests pass. Full local `npm test` (isolated test HOME),
standalone typecheck, build, and diff validation pass. E66 baseline on unchanged
main used `isResume=false`; the correction resumed and answered with the tool
result while its unknown-result control still replayed. Real Opus 5.5 E41
chain/parallel, stream/nonstream and E56 namespaced resume gates pass.

The [E67 actual-client gate](../../scripts/e2e-opencode-checkpoint-fault.mjs)
uses OpenCode 2.0.16 with the installed Meridian V2 client plugin, independent
OpenCode scrub 0.2.3, SDK 0.2.141, Claude Code 2.1.280 and Opus 5.5. It
injects one partial SSE response after a real client tool call. On unchanged
main, the real client sent `[tool_result, assistant text, user]` in its retry
but Meridian took `isResume=false`; the corrected branch took `isResume=true`
on macOS arm64 and Linux x64, and the next same-session client turn answered.
The [sanitized evidence](evidence/1165-opencode-interrupted-checkpoint.json)
records versions, checks, and limits. The original 1,345-message session was
unavailable; the injected error does not establish that the SDK itself emitted
the reporter's `upstream_idle`. Raw client logs remain in private temporary
artifacts.

Delivery final head `561d0939` passed required
[CI/test](https://github.com/rynfar/meridian/actions/runs/36253279248/job/108435205698),
Windows smoke, Docker smoke/build and both desktop builds. Squash merge
`7e157aa24421c91dbc47fa520058f6d268ae121e` has the same tree as the
validated head and credits Nikita as co-author. Source #1165 was rechecked at
the reviewed SHA and closed as incorporated; no issue was closed based on this
gate. The owned remote review branch was deleted; the isolated worktree remains
under `/private/tmp`.

## Issue-comment follow-up (2026-09-26)

This checkpoint follows the merged [Meridian 1.77.1 release](https://github.com/rynfar/meridian/releases/tag/meridian-v1.77.1).
Refresh GitHub and the affected account/client state before acting on it. The
audit covered open Meridian issues with comments, recent closed issues with
post-closure comments, and all five owner-controlled scrub repositories.

- [#1094](https://github.com/rynfar/meridian/issues/1094): setup and V2 plugin
  compatibility for **exact** OpenCode 2.0.16 shipped in #1148. Its separate
  content-specific `billing_error` remains unverified: the reporter's failing
  10,357-character system block is unavailable to maintainers, and a different
  large passing block does not prove a fix. The [follow-up](https://github.com/rynfar/meridian/issues/1094#issuecomment-5844310560)
  asks for a locally minimized, sanitized fragment that still fails, plus the
  independent scrub plugin status. Keep the issue open until that affected
  request can be reproduced and retested.
- [#1068](https://github.com/rynfar/meridian/issues/1068): verified the Pi
  comment's existing-text-block `<system-reminder>` behavior against lineage
  hashing and the SDK retention path. [#1163](https://github.com/rynfar/meridian/pull/1163)
  documents exact tag/whitespace limits and append-only snapshots; final-head
  CI passed and its merge tree matched the reviewed head. The
  [reply](https://github.com/rynfar/meridian/issues/1068#issuecomment-5844359601)
  keeps the explicit request-scoped context contract open: stable hashing does
  not remove text from a resumed SDK session.
- [#933](https://github.com/rynfar/meridian/issues/933): one new Windows CWD
  smoke failure on `main` was a measured 5,313 ms expiry of Bun's 5-second
  default after the mocked HTTP response completed. [#1162](https://github.com/rynfar/meridian/pull/1162)
  applies the existing 30-second suite bound only to those three Windows CWD
  files, retaining assertions. The focused 28 tests, full local gates, and
  final-head Windows, `test`, desktop, and Docker checks passed before merge.
  The [issue update](https://github.com/rynfar/meridian/issues/933#issuecomment-5844318842)
  separates this timeout from the unexplained fast assertion failures in
  [#917](https://github.com/rynfar/meridian/issues/917); both issues remain open.
- [#769](https://github.com/rynfar/meridian/issues/769): the September OpenClaw
  production commenter reported a moving, undisclosed prompt trigger. The
  [openclaw-scrub #3](https://github.com/rynfar/meridian-plugin-openclaw-scrub/pull/3)
  README correction passed CI and merged; it scopes current rules and explains
  same-window off/on/off, auth, and private minimization controls. The
  [reply](https://github.com/rynfar/meridian/issues/769#issuecomment-5844308652)
  does not claim a new scrub rule works without the new failing prompt. Issue
  stays open for affected-flow evidence.
- [#650](https://github.com/rynfar/meridian/issues/650): receiver and three
  sender workflows are merged, but `MERIDIAN_DISPATCH_TOKEN` was absent from
  all three sender repo secret lists on this audit. Only the owner can mint
  and install the narrowly scoped credential, then trigger a sender and verify
  the receiver. Do not substitute a broad existing CLI token.
- The [closed #495 follow-up](https://github.com/rynfar/meridian/issues/495#issuecomment-5844366647)
  answers the September request for a current tool-bearing Max control. The
  published 1.77.1/OpenCode 1.18.32/Opus 5.5 path with both required plugins
  completed a real `bash` tool call on the initial turn and same-session
  continuation with zero client or billing errors. A fresh usage read on that
  Max 20x account showed Extra Usage disabled. The
  [sanitized evidence](evidence/495-max-tool-control-20260926.json) records the
  measured scope; it does not replay the historic failing OpenClaw body.
- The [closed OpenCode scrub #1 follow-up](https://github.com/rynfar/meridian-plugin-opencode-scrub/issues/1#issuecomment-5844328374)
  fulfilled the earlier promise to report a published fix: npm scrub 0.2.3
  installed as a Meridian server plugin passed the current real client gate.
  It does not assert the original client/version tuple was retested.

At this checkpoint Meridian has nine open issues: #1094, #1073, #1068, #1011,
#1009, #933, #917, #769, and #650. #1073, #1011, and #1009 have no comment
threads yet; they were outside this comment follow-up. The Meridian PR queue
contains draft #1050 and #792 (author requested no review). All five scrub
repos have zero open issues. OpenCode scrub #5 is the sole open scrub PR; its
unchanged July head remains conflicted and its minimal-mode behavior remains
unverified against newer prompt variants. No further release was cut for this
documentation and Windows CI-budget work.

## Live queue snapshot (2026-09-25; #1152 updated 2026-09-26)

- [#1113](https://github.com/rynfar/meridian/pull/1113) merged as `aedb9b25`
  after final-head CI, full local gates, a Sonnet 5 E57 cache/control run, and
  all four E41 modes. Chris Wilson's ten authored cherry-picks remain in the
  integration history; the squash commit credits him as co-author. The
  contributor supplied an actual Letta Code 0.32.18 cloud-client run on the
  same feature code; it included two unrelated effort-routing commits, and the
  maintainer could not repeat cloud login locally (401). Source #1105 was
  rechecked at `5f2a9a9e` and closed unchanged.
- New issue [#1155](https://github.com/rynfar/meridian/issues/1155) was fixed by
  [#1156](https://github.com/rynfar/meridian/pull/1156), merged as `16834f25`.
  Unchanged 1.76.6,
  actual Oh My Pi 13.18.0, Agent SDK 0.2.141, Haiku 4.5 and a historical
  agent-owned image produced the false current-attachment answer. The fix's
  matching headless client run attributed it to history; a Sonnet 5 Pi-protocol
  control distinguished no new image from a genuine new red image. The PR
  added E65 and a pure regression test. Release Please
  [#1157](https://github.com/rynfar/meridian/pull/1157) merged, and npm
  `@rynfar/meridian` 1.77.0 is published.
- [#1152](https://github.com/rynfar/meridian/pull/1152) was incorporated by
  [#1159](https://github.com/rynfar/meridian/pull/1159), merged as `da28f1e8`
  after the corrected Linux client/model gate and final-head CI. The unchanged
  source head was closed. #1050 and #792 remain draft.
  The five scrub repos had no newly opened issues or PRs; OpenCode scrub #5 is
  still deferred.
- The older #1151/#1153 checkpoint below predates their successful merge and
  1.76.6 release. Its pending language is historical.

## #1152 corrected live gate and merge (2026-09-26)

- User identified the missing OpenCode Meridian plugin in the earlier failed
  live gate. The new headless harness
  [`scripts/e2e-opencode-lifecycle-admission.mjs`](../../scripts/e2e-opencode-lifecycle-admission.mjs)
  loads both the built Meridian OpenCode client plugin and independently
  installed OpenCode scrub 0.2.3. With the scrub plugin absent on Linux, the
  same OpenCode 1.18.32 / Opus 5.5 path produced one `billing_error`, no text,
  and retained both reported system fingerprints. With both plugins present,
  six concurrent Linux client processes each completed an initial turn and
  same-session continuation: 12/12 text responses, zero client errors;
  `/plugins/list` recorded 18 scrub invocations and zero hook errors. The
  fingerprint was present before the scrub hook and absent after it. The
  Linux run used Bun 1.4.0, Node 24.20.0 and Agent SDK 0.2.141, with a
  privately passed Claude Max OAuth credential. A macOS arm64 six-client
  control also passed. Raw client logs are private temporary artifacts;
  the runnable gate and [sanitized Linux evidence](evidence/1152-opencode-admission.json)
  are escrowed here and in the delivery PR.
- Linux physical-disk contention on the integrated code passed 24/24
  durable registrations with zero timeouts, both with and without GC, using
  1,400 resources and 800 pins. Adversarial review found that the new test
  failed on macOS because `/var` resolves to `/private/var`; a separate
  maintainer correction canonicalizes the fixture path before constructing
  resource keys. The corrected focused test passed both modes on macOS and
  Linux. All four live E41 chain/parallel × stream/non-stream modes passed,
  including exact tool-result pairing and cache continuity. The clean-exit
  local `npm test` rerun passed 4,885 tests with four skips and zero failures;
  standalone typecheck, build and diff validation passed. Final-head
  [CI/test](https://github.com/rynfar/meridian/actions/runs/36222150845/job/108349302263),
  Windows smoke, both desktop builds, Docker smoke and Docker build/push all
  passed on `8ca37345`; changelog duplication was skipped by its workflow.
- Source head `51bcec4f` by Nowaker is unchanged. The four authored
  cherry-picks onto `ddb23e17` are `e5e4b22` → `3869cc4b`, `2f3e944` →
  `c5ee3b5d`, `bee4e7d` → `70e4d1e2`, and `51bcec4` → `9874881b`.
  The test correction, proof harness and E2E documentation were committed
  separately as `8ca37345`. Delivery [#1159](https://github.com/rynfar/meridian/pull/1159)
  squash-merged as `da28f1e81fc3a0c9b0e8abe159a9e0153d88534f`; its tree
  matches the validated head exactly and the squash commit credits Nowaker
  with a co-author trailer. Source #1152 was rechecked at unchanged head
  `51bcec4f` and closed as incorporated. The owned remote delivery branch
  was deleted; the private review worktree remains under `/private/tmp`.

## Earlier contributor PR review checkpoint (2026-09-25)

- [#1152](https://github.com/rynfar/meridian/pull/1152), head `51bcec4f`,
  separates local lifecycle queue residence from the external lock deadline.
  Its physical-disk stress and CI pass, but the contributor's affected Linux
  OpenCode 1.18.32 / Opus 5.5 live batches completed no primary turns:
  requests ended in HTTP 402 `billing_error` (one batch also reached 500 after
  fallback). This was the state before the missing OpenCode plugin was
  identified; the corrected Linux live gate above supersedes this hold.
- [#1151](https://github.com/rynfar/meridian/pull/1151), source head
  `79ee7d59` from @builder-main, fixes the Windows OpenCode V2 SDK gate using
  an actual Node executable. Its commit author is `arch <arch@not.me>`; the
  fork head is unsigned and GitHub held its workflow runs for approval.
  Signed cherry-pick `9899e46b` on `codex/windows-sdk-gate-1151` preserves
  Author and AuthorDate in delivery [#1153](https://github.com/rynfar/meridian/pull/1153).
  The contributor reports published-1.76.5 failure and fixed Windows 11,
  OpenCode 2.0.16, Claude Code 2.1.281, Opus 5.5 success. The integration
  passed 13 focused process tests, full local `npm test`, typecheck, build,
  and native Windows CI smoke on its first head. The final delivery head,
  affected-client regression control, remaining CI, merge and source closure
  must be checked in #1153; this is a dated checkpoint, not their verdict.

## Cross-repository scrub review (2026-09-24)

Live discovery found five owner-controlled scrub repositories:
`meridian-plugin-pi-scrub`, `meridian-plugin-opencode-scrub`,
`meridian-plugin-hermes-scrub`, `meridian-plugin-openclaw-scrub`, and
`hudscrub`. Refresh the owner's repository list and each queue on continuation.

- **Pi scrub:** Serge Baranov's source #7 `fa9366c3` was cherry-picked as
  `8732fd2d` with Author and AuthorDate preserved, corrected in a separate
  maintainer commit, and delivered by [#10](https://github.com/rynfar/meridian-plugin-pi-scrub/pull/10)
  (`54e0706a`, Serge credited on the squash commit). The unchanged main failed
  two foreign-prompt exact-byte tests; the delivery passed 13 tests and real Pi
  0.72.1 → Meridian 1.76.3 → Haiku 4.5 E2E. Original #7 closed at its unchanged
  head. Release [#5](https://github.com/rynfar/meridian-plugin-pi-scrub/pull/5)
  merged/tagged at `ae3d2ac7`; npm 0.2.1 integrity
  `sha512-luYfyF84gt8AxNKpzqbqR00Lw7F2GwQS1NdxIZigb6tjFLt2nQbxtlRuGHHiybZp1LeChJ92h2+vrcyY1SatNA==`
  has matching provenance. A fresh registry-installed Pi live run passed.
- **OpenCode scrub:** Brian Keefe's [#5](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/5)
  remains open; its minimal mode conflicts with later OMO 4.x and cwd fixes,
  leaves a metering trigger, and lacks tests. Revisit on an amended head or a
  reproducible prompt-stability case. Newest issue #10 was reproduced on npm
  0.2.1 (real OpenCode 1.18.32 → LiteLLM 1.81.10 → Meridian 1.76.3 → Opus 5.5
  reached the billing gate), fixed by [#14](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/14)
  (`c517a2c3`), and passed the same client flow, 21 tests and final-head CI.
  Release [#15](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/15)
  merged/tagged at `46383730`; npm 0.2.2 integrity
  `sha512-w522x+6UWSKoXXPdvEY6vAwe4rur8r15GpwB3UUYixSvjVYhMzJayiONxqtd2N2HzNARS+SbCisqo6ovTmCgTQ==`
  has matching provenance. A fresh registry-installed Opus flow passed; issues
  #10, #9 and #1 are closed on this evidence.
- **Hermes scrub:** Documentation [#10](https://github.com/rynfar/meridian-plugin-hermes-scrub/pull/10)
  corrected the current identifier-neutralization behavior. Adversarial release
  review found the 0.2.0 package would report plugin version 0.1.0; [#11](https://github.com/rynfar/meridian-plugin-hermes-scrub/pull/11)
  derives it from the shipped package metadata, with a version assertion and
  real Hermes 0.21.4 → Meridian 1.76.3 → Opus 5.5 validation. Release
  [#2](https://github.com/rynfar/meridian-plugin-hermes-scrub/pull/2) merged/tagged
  at `06bbe816`; final-head CI, 14 tests, build and packed install passed.
  Actual Hermes parent and delegated child prompts contained targeted tokens
  before the plugin and none after; the guidance remained. Fresh npm 0.2.0
  installed-package E2E passed (local artifact `hermes-scrub-live-LvJRNp`).
  Registry integrity is
  `sha512-SSjCvjw3QQk8vOALdIMONUrntWs4MCQjCbxtYvgkbp7dwSXzOwRJYMFXUFt/ZEW5yTnhadZVsua1/88d81H2AA==`;
  provenance resolves to `06bbe816`. Publication issue #5 is closed.
- **OpenClaw scrub and HUDScrub:** No open PRs or issues in the refreshed queue.
  Meridian's live open PRs at this checkpoint are #1113 (draft Letta delivery,
  blocked on the real cloud flow), #1105 (source Letta PR), #1050 (draft
  Antigravity research), and #792 (author explicitly requested no review).
  Its live open issues are #1094, #1073, #1068, #1011, #1009, #933, #917,
  #769, and #650. The older Meridian notes below are historical; refresh their
  status and revisit triggers before acting.

The Pi, OpenCode and Hermes live probes are now escrowed as
[`scripts/e2e-pi-scrub-live.mjs`](../../scripts/e2e-pi-scrub-live.mjs) and
[`scripts/e2e-opencode-scrub-live.mjs`](../../scripts/e2e-opencode-scrub-live.mjs),
and [`scripts/e2e-hermes-scrub-live.mjs`](../../scripts/e2e-hermes-scrub-live.mjs),
with the repeatable commands in [`E2E.md`](../../E2E.md). No community comments
were sent.

### Package metadata patch releases and Nix integration

- Adversarial review found published Pi 0.2.1 reporting plugin version 0.2.0.
  [Pi #11](https://github.com/rynfar/meridian-plugin-pi-scrub/pull/11)
  (`a6f1b3e7`) adds a package-version assertion (failing on unchanged main),
  derives runtime metadata from the shipped package, and passed 14 tests,
  build, packed install and real Pi 0.72.1 → Meridian 1.76.3 → Haiku 4.5.
  Release [Pi #12](https://github.com/rynfar/meridian-plugin-pi-scrub/pull/12)
  had final-head CI and candidate E2E, merged at `23c98fac`, and published
  0.2.2 through [run 35975618398](https://github.com/rynfar/meridian-plugin-pi-scrub/actions/runs/35975618398).
  Registry integrity is
  `sha512-ksw4pOQdz54DTg2YkG06KB39EIIY5u0pH8VCPh9Se/+ONIzNx2PqbRJECvZ2Ti5j63wVagAYr2kTJ+/V6uKcRA==`;
  its signed provenance digest and source commit match the registry and
  `23c98fac`. `npm audit signatures` verified the attestation and a fresh
  registry-installed Pi run passed (`pi-scrub-live-H5bdwW`).
- Published OpenCode 0.2.2 reported plugin version 0.1.0.
  [OpenCode #16](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/16)
  (`015d373d`) adds the corresponding failing-baseline assertion and package
  metadata import. It passed 22 tests, build, packed install and real OpenCode
  1.18.32 → LiteLLM 1.81.10 → Meridian 1.76.3 → Opus 5.5.
  Release [OpenCode #17](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/17)
  had final-head CI and candidate E2E, merged at `4b410c5a`, and published
  0.2.3 through [run 35975742509](https://github.com/rynfar/meridian-plugin-opencode-scrub/actions/runs/35975742509).
  Registry integrity is
  `sha512-JOlxV0VAbWcXGTC+bsi4K2d4g3vb2UG5y8s1HzKjWkeAm7kmdIYcHbPie+ror2HTaNaRKIpzGOkPqqonEgs5YA==`;
  its signed provenance digest and source commit match the registry and
  `4b410c5a`. `npm audit signatures` verified the attestation and a fresh
  registry-installed Opus 5.5 run passed (`opencode-scrub-live-aYHjqK`).
- Meridian [#1144](https://github.com/rynfar/meridian/pull/1144) advances
  `flake.lock` to Hermes 0.2.0 (`06bbe816`), Pi 0.2.2 (`23c98fac`), and
  OpenCode 0.2.3 (`4b410c5a`). Its separate Nix fix retains the source
  `package.json` at the relative path imported by all three plugins and runs
  a Node import and plugin/package version equality check inside each package
  build. Before the fix, the old Nix output reproduced
  `ERR_MODULE_NOT_FOUND`. On the corrected final pins, all three Linux arm64
  Nix plugin builds, imports and version assertions passed.
  The Pi and OpenCode headless harnesses also passed against independently
  packed final packages in the real macOS clients: `pi-scrub-live-v3rHYL`
  and `opencode-scrub-live-F7CpFW`. The Pi probe observed both identity and
  docs markers before the plugin; the SDK call had neither and retained the
  generic coding identity. The OpenCode passthrough probe observed both
  metering-trigger markers before the plugin, neither afterward, retained
  the client working directory, and the client exited successfully.
  Actual exported Nix outputs also passed Hermes 0.21.4 → Opus 5.5
  (`hermes-scrub-live-XVeNQ5`) and Pi 0.72.1 → Haiku 4.5
  (`pi-scrub-live-Qa4NtE`) through the same isolated Meridian runtime.
  The OpenCode 1.18.32 → LiteLLM 1.81.10 → Opus 5.5 Nix-output run passed
  (`opencode-scrub-live-9TiJfp`), with the passthrough markers removed and
  the client working directory preserved.

### Final integration and remaining gates

- Meridian [#1144](https://github.com/rynfar/meridian/pull/1144) passed its
  exact-head `test`, Ubuntu/macOS Nix builds, Windows smoke, Docker, desktop,
  and bun.nix verification checks, then squash-merged as `f8830dee35450898af64f26c3e37d7de32c132c2`
  at 08:54 UTC. The merge tree matches the locally validated branch. The
  original workflow-authored pin commit retains its Author and AuthorDate in
  the delivery history; the squash credits both author identities.
  Local `npm test`, standalone typecheck/build, all three final-pin Linux arm64
  plugin Nix builds, script syntax, skill validation and local links passed.
  The three actual Nix outputs passed the client/model flows recorded above.
- Release Please [run 35978034021](https://github.com/rynfar/meridian/actions/runs/35978034021)
  found no user-facing conventional commit after the `chore:` squash and made
  no release candidate. The explicit `Release-As: 1.76.4` intent in
  [#1145](https://github.com/rynfar/meridian/pull/1145) produced
  [#1146](https://github.com/rynfar/meridian/pull/1146). Adversarial review
  of that candidate caught three E2E scripts hardcoding Meridian 1.76.3 in
  their logs; the separate maintainer commit `cabbc75a` reads the installed
  version and can assert it with `E2E_EXPECT_MERIDIAN_VERSION`. A negative
  control failed before any model call. All three corrected scripts passed on
  the 1.76.4 candidate through their real clients and models (Hermes
  `hermes-scrub-live-qz94pi`, Pi `pi-scrub-live-b4d5As`, OpenCode
  `opencode-scrub-live-kKregc`). The corrected final head passed full local
  `npm test`, typecheck and build and required final-head CI `test`, both Nix
  builds, Windows, Docker and desktop checks. The release PR merged with the
  required merge method as `076922f58dbf2c58637501339b2b2526c71af687`;
  its merge tree equals the validated candidate.
- [Meridian 1.76.4](https://github.com/rynfar/meridian/releases/tag/meridian-v1.76.4)
  tags that merge commit. The registry's `latest` is 1.76.4 with integrity
  `sha512-yGzy9EU5q9F3uFeQ6kDTCA4oHX8BABbKBKrI18IonOVyfkRb9jWQsv+0LGUKIgPWme1MnFz5JUZ2Z/bRV6CJXw==`.
  Its SLSA provenance subject digest matches the registry integrity and its
  resolved Git commit matches `076922f5`; `npm audit signatures` verified the
  installed dependency signatures and attestations. A fresh registry install
  passed real HTTP → SDK Opus 5.5 fresh and resumed conversations, preserving
  the fixture marker (`meridian-release-live-kGx3Zh`). The published tarball
  differs from the local candidate pack only in three bundle files: a baked
  build-machine path in `libsql`, two Bun optimizer no-op branches, and the
  resulting chunk filename/imports. The actual published package passed the
  installed-package E2E, so validation covers that final artifact directly.
  [Release run 35981302861](https://github.com/rynfar/meridian/actions/runs/35981302861)
  published the package and signed/notarized macOS DMG and ZIP. The release's
  `BUILD-INFO.txt` identifies `076922f5`; its `SHA256SUMS.txt` records DMG
  `8a010a7f55ee2f0aab53eb2b91802931e69c6ab07f1087c95ce8e38515e276e6`
  and ZIP `8a724c4cdb2de98c10ac446536ac12ef6a2aad31aeddd10e57bf9433ed3cc404`.
  The completed release workflow also published
  `ghcr.io/rynfar/meridian:1.76.4` as OCI index
  `sha256:1d1e8c33c55ec40b38aa65a224d79073cbf8f14f98c6dd87c205f446de8a9056`
  with both `linux/amd64` and `linux/arm64` manifests and attestations.
- Meridian [#1148](https://github.com/rynfar/meridian/pull/1148) delivered the
  OpenCode 2.0.16 compatibility port as `1a5e1a2b43311527650fc834d7d777abc5620141`.
  The published 1.76.4 baseline failed the committed headless gate at setup
  before a model call; manually loading its V2 plugin reproduced the missing
  `context.catalog.transform` error. The corrected source and fresh npm-pack
  candidate each passed the 15-request OpenCode 2.0.16 → Meridian SDK → Sonnet 5
  gate on macOS. A Linux arm64 OpenCode 2.0.16 / Node 22.23.1 client passed
  the same installed-pack gate against a macOS candidate proxy. All three
  pinned beta extended live gates passed. Local `npm test`, typecheck and build
  passed, as did final-head CI `test`, Windows, desktop and Docker checks. The
  signed head `8d06fd5c` had the same tree as the squash merge.
- Release Please [#1149](https://github.com/rynfar/meridian/pull/1149) made only
  the expected 1.76.5 manifest/package/lockfile bumps and changelog entry.
  Its head `858de1fc15f82c9e2c28bca3ab0399f210f6981c` passed final-head
  `test`, Nix builds, Windows, Docker and desktop CI; the local full suite,
  standalone typecheck and build also passed. The independently installed
  1.76.5 pack passed the same 15-request real Sonnet 5 gate on macOS and with
  the Linux arm64 client. The release PR merged at
  `9170c68feeddae4bee438939b7587647f2275123`, with a tree identical to the
  tested candidate. The tag `meridian-v1.76.5` points to that commit.
  [Release run 35989239706](https://github.com/rynfar/meridian/actions/runs/35989239706)
  completed all four jobs successfully. Its signed/notarized macOS DMG and ZIP
  have release-asset SHA-256 digests
  `3ae56de7c38420da786674b31a5b632d6acecea82df4c4ada14d132eaaab7fca`
  and `f3463f0aa3fbe6b4f919df02acc39d18c50a910b0247320fd8c445ac9820b6b0`,
  matching `SHA256SUMS.txt`; `BUILD-INFO.txt` names the release commit. The
  versioned Docker index is
  `sha256:17f84fc60f3090e02f159b78b915f3932155a97cc71b456a584d21d94af40899`
  with `linux/amd64` and `linux/arm64` images and attestations. The separate
  main-branch Docker workflow also passed for `latest`.
  npm `latest` is 1.76.5 with registry integrity
  `sha512-4pDqR1ZRtyCV1NBpdf+6ddYQTs55lVUUD9ZRN7ryeGO+J1uv4rD+IdyZc7WH4BARSQTwMLbiJwrmRwIhyL7ngw==`
  and shasum `5fa0f21d50fdc8fad74ef8e88b599d73818a8663`.
  Its SLSA provenance subject digest equals that integrity and names source
  commit `9170c68f` and release run `35989239706`; `npm audit signatures`
  verified 108 signatures and 14 attestations. A fresh registry-installed
  1.76.5 package passed the 15-request real OpenCode 2.0.16 → Sonnet 5 gate
  on macOS (`meridian-opencode-v2-stable-ruagkV`). A separate fresh registry
  install in Linux arm64 / Node 22.23.1 passed the same client gate
  (`meridian-opencode-v2-stable-HQEd88`) against the published macOS proxy.
  The reporter's exact content-sensitive system block is unavailable and the
  full Linux proxy/SDK path has not been replayed; keep #1094 open for that
  narrower `billing_error` claim.
- An additional headless probe for [issue #1009](https://github.com/rynfar/meridian/issues/1009)
  confirmed the existing `--case=unhandled --stream` fixture still passes with
  the flag off and an undeclared tool. Substituting a declared tool makes the
  real SDK invoke `PreToolUse` before the tool's `content_block_stop` becomes
  observable to the harness, so that substitution does not reproduce the
  missing-hook abort window. Leave the flag off until a dedicated fault
  injection and the affected deployment's canary establish the positive path.
- A fresh owner/organization repo and queue scan found the same five managed
  scrub repositories and no new PRs or issues. Pi, Hermes, OpenClaw scrub and
  HUDScrub are clear. OpenCode contributor #5 is unchanged and deferred for
  its documented regression. Meridian #1113/#1105, #1050 and #792 remain as
  above; its nine open issues have unchanged dispositions except #1094.
  An issue update at 09:16 UTC reports that `@opencode/cli@2.0.16` is released,
  even though `@opencode-ai/plugin` still has `latest=1.18.32`. The official
  `v2.0.16` Git tag and npm CLI version were verified. On that exact binary,
  `meridian setup --v2` rejects the version, and manually loading the bundled
  V2 plugin logs `context.catalog.transform` undefined. The 2.0.16 plugin
  interface moved catalog work into separate `provider` and `model` domains.
  #1094 is now an actionable compatibility port, not a safe unpin. Preserve
  the beta gates while adapting it, and require real 2.0.16 client/package E2E
  plus the reported billing-payload path before declaring the issue resolved.
  The isolated compatibility candidate now supports the released 2.0.16 host
  while retaining the three beta APIs. The committed headless probe is
  [`scripts/e2e-opencode-v2-stable-live.mjs`](../../scripts/e2e-opencode-v2-stable-live.mjs).
  Against a fresh registry install of the published 1.76.4 baseline, that
  probe fails before a model call because setup rejects 2.0.16.
  Its real 2.0.16 → Meridian → Sonnet 5 source and independently installed
  npm-pack runs each passed 15 requests on macOS. They assert setup/loading,
  signed primary and detached title/generate requests, resumed context,
  discovered `#xhigh`, an actual read-tool result, fork isolation, and attached
  compaction. The final pack integrity was
  `sha512-sWEY3wvTqQUCsqjjT4qx2xVsrjcKLRhqvcJ64HDFh6xyzetEpAqLDnHJvZYmOMxk+ybEEcQrJL1xTkQe5NJScg==`.
  An installed-pack Linux arm64 OpenCode 2.0.16 and Node 22.23.1 run passed
  the same 15-request gate against the candidate Meridian proxy on macOS;
  this checks the reported client platform but is a split-platform run, not
  an all-Linux proxy deployment. The three pinned beta live extended gates
  passed separately on the candidate. Full `npm test`, standalone typecheck,
  and build passed. The reporter's exact content-sensitive system block is
  still unavailable, so these results do not resolve the specific
  `billing_error` replay. Leave #1094 open for that payload and a full Linux
  proxy replay; do not describe the narrower compatibility port as a complete
  billing fix.

## Follow-up review: PR #1139 (2026-09-24)

Refresh GitHub and `origin/main` before resuming this queue. The newest ready contributor
PR was reviewed first. The older Letta and draft PRs retain the dispositions below.

### Session GC lock contention #1139 → maintainer delivery #1140

- Source head `e8d1333ffbf59c93b8ddb60d9e2b3d13db99c33c` by Aaron Masover
  <amasover@gmail.com> (authored 2026-09-24 01:47:42 UTC) was cherry-picked with
  Author and AuthorDate intact as signed `340f36befbbba03df410c9342b03accae410f2eb`
  in `/tmp/meridian-pr1139-review`, branch `codex/review-1139`. The cherry-pick
  has the exact source tree. A separate signed maintainer commit
  `3b5f3ed3d10d49d18b258f5986490a6dd79f0af1` retains the existing
  `pinProvider?.() ?? pins` fallback when a GC snapshot is unavailable; the
  source-only branch threw a `TypeError` in that case, while the corrected
  branch returned a healthy `GcResult`.
- The change moves session GC reconciliation away from the lifecycle lock's
  expensive scan while retaining lock-protected state updates and pin safety.
  A synthetic 1,438-resource/810-pin case measured about 450–457 ms on the
  previous main and 6–7 ms on the candidate, with the same 810 pins. A forced
  lifecycle-lock collision in a real macOS Opus 5.5 HTTP → SDK request returned
  HTTP 503 on previous main and HTTP 200 after the fix, with the retry observed
  and zero leaked active leases. Logs:
  `/tmp/meridian-pr1139-{baseline,candidate}-bench.log`,
  `/tmp/meridian-pr1139-live-busy-{before,after}.log`, and
  `/tmp/meridian-pr1139-pin-fallback-{before,after}.log`.
- Focused lifecycle/process tests (56), typecheck, build and full `npm test`
  passed on the corrected final head. Real macOS Opus 5.5 publication E2E passed
  nonstreaming and streaming: four competing sweeps per mode deleted nothing,
  both conversations retained their fixture identifiers and source transcripts.
  The real SDK transcript pin/retire/delete gate passed; Docker boot and host
  identity gates E51/E52 passed. Real Oh My Pi 18.2.11 through Meridian on macOS
  passed transcript GC with Haiku 4.5. The Opus 5.5 Oh My Pi 18.2.11 macOS run
  encountered the same `Claude Code 2.1.141 does not support this model` error
  on unchanged main and the candidate. Native Windows 11 Oh My Pi 18.2.11 Opus
  5.5 comparison in #1139 reported six concurrent sessions taking 881 s with
  44 client-visible errors on 1.76.2 versus 86 s with zero errors on the
  branch; this is contributor evidence, not an independently repeated
  maintainer run. Logs:
  `/tmp/meridian-pr1139-final-{typecheck,build,npm-test,publication,publication-stream}.log`,
  `/tmp/meridian-pr1139-gc-sdk.log`,
  `/tmp/meridian-pr1139-gc-omp-haiku.log`, and
  `/tmp/meridian-pr1139-{e51,e52}.log`.
- Delivery [#1140](https://github.com/rynfar/meridian/pull/1140) passed all
  final-head CI including `test`, Docker, desktop and Windows smoke. After
  rechecking unchanged head `3b5f3ed3`, base `398006fe`, and green checks, it
  was squash-merged as `f30b22f9a99a73b723ced39aa1fab263a84272a8`.
  The merged tree exactly matches the validated branch; its commit credits
  Aaron as co-author. Source #1139 was rechecked at unchanged `e8d1333f`
  and closed without comment.

### Release 1.76.3 publication

- The previous tag is `meridian-v1.76.2`; the product release range contains
  #1140, plus the earlier documentation-only #1138. Release Please
  [#1141](https://github.com/rynfar/meridian/pull/1141) changes only
  `.release-please-manifest.json`, `CHANGELOG.md`, `package-lock.json`, and
  `package.json`. It raises all root version fields to 1.76.3 and has one
  Bug Fixes entry for #1140. The bot's original `20eac8fe` head was signed
  as `8e65087996e8fd47665d928cbd39e8ff7a04f514` with the exact same
  tree and bot Author/AuthorDate; GitHub verifies the signed replacement.
- On macOS with Bun 1.3.14, Node 22.22.3, Agent SDK 0.2.141, and Claude Code
  2.1.280, frozen Bun install, full `npm test`, standalone typecheck, build,
  version consistency and diff check passed. Logs:
  `/tmp/meridian-release-1141-{npm-test,typecheck,build}.log`.
  Real Opus 5.5 publication E2E passed nonstreaming and streaming, each with
  four competing sweeps, durable mappings, preserved identifiers, and unchanged
  source transcripts. The forced lifecycle-lock collision returned HTTP 200
  with no leaked lease. Logs:
  `/tmp/meridian-release-1141-publication-opus{,-stream}.log` and
  `/tmp/meridian-release-1141-busy-opus.log`.
- A 1.76.3 tarball was packed with candidate integrity
  `sha512-OZ4zKucyQvZ3F0ReB08A4TVGVZll7vWx0uvZcfGIaei9lkHEdS9Vv+HFj8FdQ0YrVZAnv1patnbuji1i8meU8w==`.
  An independent npm install in `/tmp/meridian-release-1141-packed` reported
  CLI version 1.76.3 and passed a real Opus 5.5 fresh and resumed HTTP turn
  through its installed Node server, preserving the fixture identifier. That
  consumer resolved Agent SDK 0.2.141 and Claude Code 2.1.281. Logs:
  `/tmp/meridian-release-1141-packed-{install,live}.log`.
- All exact-head CI passed, including `test`, both Nix builds, Windows, desktop
  and Docker. After rechecking unchanged head/base, #1141 was merged with
  `--merge --match-head-commit 8e650879` as
  `df6523e953076c361c5b7ca2d5fbb50107db6190`; the merged tree exactly
  matches the validated candidate. Release Please created tag and GitHub release
  `meridian-v1.76.3` at that SHA. Publication workflow:
  [run 35959542289](https://github.com/rynfar/meridian/actions/runs/35959542289).
  All four jobs passed. The signed/notarized macOS ARM64 DMG and ZIP, checksums
  and build info are attached. The release Docker job pushed
  `ghcr.io/rynfar/meridian:1.76.3` for `linux/amd64` and `linux/arm64` at index
  digest `sha256:7a0b9e9f3155182041188f7df1bb7d1ec7e161cd0189470f77a16e6a14e0ce1c`.
  The main-branch [Docker workflow](https://github.com/rynfar/meridian/actions/runs/35959542024)
  passed and pushed `latest` for the same commit and architectures, index digest
  `sha256:e781adf9774cf8919a23a8521ea345f1f94176523e3f16a265d5a12c81635b99`.
- The npm publish job reported `+ @rynfar/meridian@1.76.3` with signed
  provenance at Sigstore index `2932371200` on 2026-09-24 05:27 UTC.
  The public registry's `latest` is 1.76.3; tarball integrity is
  `sha512-jDB06dshmgGc2XFdSnYyeBP2jOITuQ7ca25cAP/45kgy9QgzEGqGCSy7PFLFzlfZm08TTkQawQIUkM4GkqS3rQ==`
  and shasum `859c5a78414597fc42f8a3b15f738dee2f8f11bc`. The provenance
  subject's SHA-512 digest matches the registry integrity and identifies
  release commit `df6523e9` and run `35959542289`. A clean public-registry
  install in `/tmp/meridian-release-1.76.3-registry` reported CLI 1.76.3 and
  passed a real Opus 5.5 fresh and resumed HTTP turn with the fixture marker
  preserved. Its lockfile integrity matches the registry; `npm audit signatures`
  verified all 108 registry signatures and 14 attestations. Logs:
  `/tmp/meridian-release-1.76.3-registry-{install,live}.log`.
- `npm ci` on the source tree fails because the root npm lockfile still records
  Claude Code 2.1.257 while `package.json` requests `^2.1.280`, a mismatch
  inherited from #1102; the repository CI and frozen release gate use
  `bun.lock` and Bun. This did not prevent the verified public-registry install.

### Queue after publication

- Live GitHub refresh shows four open PRs: Letta source #1105 remains at
  `5f2a9a9e` and draft delivery #1113 at `52a3f914`, waiting for actual Letta
  cloud-client verification. #1050 remains draft Antigravity research; #792
  remains draft at its contributor's request. There is no newer ready PR.
- Nine issues remain open: #1094, #1073, #1068, #1011, #1009, #933, #917,
  #769, and #650. #1094's newest comment asks for a defined OpenCode v2
  compatibility goal and notes that npm's plugin `latest` still points to 1.x;
  its implementation target is not established. The prior dispositions and
  owner/client prerequisites for the other issues are recorded below. This
  release does not imply those issues are resolved.

## Follow-up review: PRs #1134 and #1133 (2026-09-23)

The previous authorized batch shipped Meridian v1.76.1. Refresh GitHub before acting on any
status here. Two newer PRs were reviewed newest first; the existing open issues and draft PRs
below retain their prior dispositions.

### Bot plugin pin #1134 → maintainer delivery #1135

- Source head `e6fb700b` (rynfar, authored 2026-09-23 10:36:41 UTC) was cherry-picked with
  Author and AuthorDate intact as signed `df695864` in `/tmp/meridian-pr1134-review`, branch
  `codex/plugin-pin-1134`. One input changed: `meridian-plugin-opencode-scrub` in `flake.lock`
  now points to `18e36c14` (published plugin v0.2.1). The source fix was previously validated
  under issue #1101 with real Meridian HTTP → SDK → Claude Max in both response modes and a
  fresh npm install; the scheduled plugin workflow `35849737110` rebuilt all plugin outputs
  with this pin.
- Local frozen install, typecheck, build, full `npm test` and diff check passed. Delivery
  [#1135](https://github.com/rynfar/meridian/pull/1135) passed final-head `test`, Nix verify
  and Ubuntu/macOS builds, desktop, Windows and container checks. The macOS Nix build and
  binary check passed before its optional cache upload took about 20 minutes. CI:
  `https://github.com/rynfar/meridian/actions/runs/35927258693` (Nix) and
  `https://github.com/rynfar/meridian/actions/runs/35927258663` (test).
- After rechecking head `df695864`, base `cce20b96`, and every check, #1135 was squash-merged
  as `2f5c0bfd64bf9aa432d11bdf27fdaa8911421b23`. The merged tree exactly matches the validated
  branch. The resulting commit credits rynfar as co-author. Original #1134 was rechecked at
  unchanged head `e6fb700b` and closed without comment.

### Contributor schema #1133 → maintainer delivery #1136

- Source head `08e8accc` (groundnuty <groundnuty@gmail.com>, authored 2026-09-23 09:51:29 UTC)
  became signed authored cherry-pick `9500fd8c`, then rebased onto merged #1135 as `8834d31f`,
  in `/tmp/meridian-pr1133-review`, branch `codex/review-1133`. Author and AuthorDate remain
  unchanged. Signed commit verification is green on GitHub. The patch advertises declared
  nested JSON Schema through the pinned Agent SDK's MCP renderer while keeping input
  validation/repair and `$` reference fallback.
- Running the contributor's three real-SDK MCP tests unchanged against `main` gave 1 pass / 2
  fail; after the cherry-pick, 3 pass. The built proxy's live Sonnet 5 nonce probe failed on
  unchanged code at both nested locations and passed on the candidate at both locations:
  `/tmp/meridian-pr1133-schema-live-before.log`, `/tmp/meridian-pr1133-schema-live-after.log`.
  A freshly installed tarball built from the PR passed the same live nonce probe
  (`/tmp/meridian-pr1133-schema-live-packed.log`); the rebased built proxy passed again
  (`/tmp/meridian-pr1133-schema-live-postrebase.log`).
- On macOS Bun 1.3.14 / Agent SDK 0.2.141 / Claude Code 2.1.280, all four live E41
  chain/parallel × stream/nonstream modes passed with Sonnet 5, plus a Pi parallel-stream
  control; logs `/tmp/meridian-pr1133-e41-*.log`. The real built-package OpenCode client gate
  passed on all pinned betas 18314/18866/19271 with Claude Haiku 4.5 and separate proxy/client
  CWD; logs `/tmp/meridian-pr1133-e42-*-core.log`. The extended beta 18314 `#xhigh` variant
  probe failed with the same `session advanced` HTTP 400 on unchanged built main and the
  candidate, after file call and continuation succeeded. Retain both failed logs
  (`/tmp/meridian-pr1133-e42-18314-extended-baseline.log`,
  `/tmp/meridian-pr1133-e42-18314.log`); do not claim that V2 variant issue is fixed.
- Local typecheck, build, and full isolated `npm test` passed (4,551 main tests plus every
  isolated segment). An earlier full run overlapped another suite and live model run and hit
  two cross-process Pi timeouts; the same 11-case file then passed in isolation, followed by
  the complete green suite. Logs: `/tmp/meridian-pr1133-test.log`,
  `/tmp/meridian-pr1133-cross-process-isolated.log`, `/tmp/meridian-pr1133-test-isolated.log`.
  No production correction was needed. After the lockfile-only rebase, 11 focused schema/input
  tests, typecheck and build passed; logs `/tmp/meridian-pr1133-postrebase-*`. Delivery
  [#1136](https://github.com/rynfar/meridian/pull/1136) on signed head `8834d31f` passed all
  final-head checks, including `test`, desktop, Windows and container. Its squash merge is
  `2922970e8c5d0657b74edddb044554239af80c63`; the merged tree exactly matches the validated
  head and credits groundnuty as co-author. Original #1133 was rechecked at unchanged head
  `08e8accc` and closed without comment.
- Open work after these two merges consists of previously reviewed draft/held PRs and issues.
  Refresh the queue before claiming it is empty.

### Release 1.76.2 publication

- Previous tag `meridian-v1.76.1` is at `cce20b96`. The product commits in the release range
  are #1135 (`2f5c0bfd`) and #1136 (`2922970e`). Release Please PR
  [#1137](https://github.com/rynfar/meridian/pull/1137) changed only
  `.release-please-manifest.json`, `CHANGELOG.md`, `package-lock.json`, and `package.json`;
  the changelog has one Bug Fixes entry for #1136 and no duplicate chore entry. The bot's
  original candidate head `403ed493` was re-signed with the exact same tree as signed
  `d9430a7edd110c01ab08b55e578a5e55d04edf3f`, preserving bot Author and AuthorDate, to trigger
  the required PR checks.
- Local frozen install, typecheck, build, full `npm test`, release metadata consistency and
  diff checks passed on that tree. Logs `/tmp/meridian-release-1137-*.log`. The built
  candidate passed a real Sonnet 5 nested-schema tool call. Live E41 passed chain/parallel ×
  stream/nonstream with exact results, durable forks and cache continuity
  (`/tmp/meridian-release-1137-e41-*.log`). The built package passed the real beta 18314
  OpenCode client flow (`/tmp/meridian-release-1137-opencode-18314.log`).
- An independently packed 1.76.2 tarball was freshly installed; its CLI reported 1.76.2 and
  the installed proxy passed the real Sonnet nested-schema tool call
  (`/tmp/meridian-release-1137-packed-live.log`). Candidate tarball integrity is
  `sha512-SADLZ4H4QiEM602MULxohrSLx90FAUctGU0Ap2P4eFJSu9o3cCuwIsFoGsZ//GYoW3pAuZSEypgSSwHJ/yPAAw==`.
  This is candidate evidence, not registry publication.
- All final-head CI passed, including `test`, both Nix builds, desktop, Windows, and
  container. After rechecking unchanged head/base and checks, #1137 was merged with
  `--merge --match-head-commit d9430a7e` as
  `8cd3e9ee57f30df015e6a6ceea0fc544bd3842e7`. Its merged tree exactly matches the validated
  candidate. Release Please created GitHub release `meridian-v1.76.2` at that SHA on
  2026-09-23 23:10:12 UTC. The publication workflow is
  [run 35932196039](https://github.com/rynfar/meridian/actions/runs/35932196039).
- The publication workflow's Docker job pushed `ghcr.io/rynfar/meridian:1.76.2` with
  `linux/amd64` and `linux/arm64` manifests (index digest
  `sha256:9fffe485041b730d5faba464be56cf7c1383071955e798dde787bac6ab237424`). The
  separate main-branch [Docker workflow](https://github.com/rynfar/meridian/actions/runs/35932195787)
  passed and pushed `latest` for the same release commit, with both architectures and index
  digest `sha256:2be03d3f603cb5373ea09dab011287a3f2e0ddec264eeec6f66d3a602f765a83`.
  The desktop job passed and attached the signed/notarized 1.76.2 macOS ARM64 DMG and ZIP,
  checksums, and build info to the GitHub release. All four release workflow jobs passed.
- The npm publish job reported `+ @rynfar/meridian@1.76.2` and published signed provenance to
  Sigstore index `2927534032` at 2026-09-23 23:16 UTC. After npm's processing delay, registry
  `latest` became 1.76.2. Its tarball integrity is
  `sha512-FXkpUwBZUlVfwrAGjXTvNxnshhXnWNwaLQcePo+JT5XUKU9iUzfuQa3Otf7ED/VxTxROo3QSo9kigbtf+tDZAQ==`,
  shasum `bbfd12a2c349ef6142e32611b95baf5727726c15`. Registry provenance identifies
  `pkg:npm/%40rynfar/meridian@1.76.2`, the same SHA-512 digest, release commit
  `8cd3e9ee57f30df015e6a6ceea0fc544bd3842e7`, and workflow run `35932196039`.
- A clean install from the public registry in `/tmp/meridian-release-1.76.2-registry` reported
  CLI version 1.76.2. Its installed proxy passed the real Sonnet 5 nested-schema nonce flow:
  HTTP 200, one `report` call, and exact object-field and array-item values. Log:
  `/tmp/meridian-release-1.76.2-registry-live.log`. Publication is complete; no manual
  versioning, tag push or npm publish was used.

### Queue after publication

- Refreshed live GitHub status after release: four open PRs, all with previously reviewed
  dispositions. Letta source #1105 is unchanged at `5f2a9a9e`; delivery #1113 is still draft
  at `52a3f914`, waiting for actual Letta cloud-client verification. #1050 remains draft
  Antigravity research; #792 remains draft at the contributor's request. No newer ready PR
  is waiting for review.
- Nine issues remain open: #1094, #1073, #1068, #1011, #1009, #933, #917, #769, and #650.
  Their previously reviewed holds and owner/client prerequisites are recorded below. This
  queue is not empty and no unsupported closure is implied by the 1.76.2 release.

## Active review batch (2026-09-23)

The owner asked for PR review first, newest issues next, author-preserving
cherry-picks, validation before merge, and an authorized release after the
autonomous queue is as far along as it can get. Refresh live GitHub state and
`origin/main` before continuing; this section is a checkpoint, not a claim that
the queue is complete. This batch has one owner and no delegated agents.

### #1104 incorporated as #1108: Profiles page script

- Source head `3af1a952` (Nowaker) became authored cherry-pick `7040f8e6`
  (Author and AuthorDate preserved) on `fix/profile-page-script-1104`.
  Delivery [#1108](https://github.com/rynfar/meridian/pull/1108) merged to main
  as `6b25c5a1`; source #1104 was rechecked and closed without comment.
- The fix closes the missing `renderSpentNote` brace, repairs the nested quote
  escaping, and adds a five-page inline-script parse test. The new test passed
  5/5; typecheck, build, full `npm test` and final-head CI `test` passed.
  CI: `https://github.com/rynfar/meridian/actions/runs/35825319080`.
- Live shared-browser check on macOS served `/profiles` from an isolated local
  proxy: the page reached the "No profiles configured" state rather than
  staying blank. With a sample profile rendered through the page's own script,
  the Rename button opened a focused input with Save/Cancel controls; Cancel
  restored the card. This exercises the repaired inline script and markup,
  but does not claim a backend profile rename or OAuth flow was exercised.

### #1106 accepted with a maintainer comment as #1110: OpenAI tool-loop identity

- Source head `6cbdae64` (Chris Wilson), base main `6b25c5a1`. All ten source
  commits were cherry-picked with Author and AuthorDate preserved onto
  `fix/openai-tool-loop-1106`. Source-to-incorporated abbreviated SHA mapping,
  in order: `208ce890→1b0892f7`, `9be41c40→2ac19c6a`,
  `d91447bd→8a80c0b1`, `7ec5024f→5b975c0c`, `992dce3a→01d1de99`,
  `9b149295→6446ad01`, `8059e07a→d7bcfaf0`, `fa18b475→d4eb5457`,
  `b1ce70aa→6b425810`, `6cbdae64→0fcf2137`. Maintainer marker
  `f8e197a8` is separate. Delivery [#1110](https://github.com/rynfar/meridian/pull/1110)
  merged as `73d98d14` with authored commits intact; source #1106 was rechecked
  at the same head and closed without comment.
- Focused tests 70/70, typecheck and build passed. First full `npm test` run
  failed two unrelated Polytoken concurrency/multimodal cases; both passed
  together in isolation (15/15), then the second full command passed. Treat
  the initial run as unresolved suite instability under #933/#917, not a fix.
- Live E58 on macOS, Bun 1.3.14, Agent SDK 0.2.141, Claude Code 2.1.280,
  Haiku 4.5 passed after unsetting this shell's local `MERIDIAN_API_KEY` only
  for the isolated probe. Turns 3–5 resumed with 96/97/99% cached input and
  two unsettled checkpoints preferred continuation; the unkeyed control had
  no cache reads. The first attempt returned 401 at the local auth gate and
  supplied no model evidence. Live E41 with Sonnet 5 passed all four
  sequential/parallel × stream/non-stream modes, including exact results,
  durable forks and cache continuity. Local logs:
  `/tmp/meridian-1106-e58-authless.log` and `/tmp/meridian-1106-e41-*.log`.
- The first delivery CI `test` run (`35827093158`) failed two assertions that
  captured debug events through the process-global logger mock, even though
  the same tests' direct SDK resume/replay assertions passed. The logger mock
  is documented as susceptible to load-order races (#917). A separate
  maintainer test correction removes those log-capture assertions and keeps
  the direct SDK decisions as the behavioral regression gate; no production
  branch or telemetry call changed. Corrected final head `6b355328` passed
  local full tests, typecheck, build and all relevant CI jobs (CI run
  `35828305778`, Docker `35828305721`, desktop `35828305756`).

### #1105 held as draft #1113; #1100 incorporated as #1111

- #1105 source `5f2a9a9e` (Chris Wilson) was cherry-picked as ten authored
  commits on `/tmp/meridian-letta-1105`, branch `codex/letta-identity-1105`.
  On current main, the first authored cherry-pick is `b30fc617`; maintainer
  commits `15c01ba5` remove prohibited casts and guard malformed Letta bodies,
  and `52a3f914` requires the label inside a system reminder. Delivery
  [#1113](https://github.com/rynfar/meridian/pull/1113) is draft. Rebasing
  preserved both Letta and OpenAI identity documentation. Focused 69/69,
  typecheck, build, full `npm test`, and every CI check on the draft head
  passed (`35830427471`, Docker `35830427507`, desktop `35830427622`). Actual Letta Code
  0.32.18 local backend requests use `local-conv-*`, not the `conv-<uuid>`
  reminder path being fixed. A cloud backend connect returned 401; the real
  affected-client acceptance gate remains unavailable. E57's wire-shape
  probe must not be presented as Letta binary evidence. Hold merge and source
  closure until the client gate is satisfied.
- #1100 source `0823b361` (Guy Addadi) was cherry-picked to
  `/tmp/meridian-cwd-1100`, branch `codex/cwd-no-client-1100`, and rebased onto
  `73d98d14` as `72dbaab4` (author and AuthorDate intact). Maintainer test
  commit `cad81819` proves an HTTP bare Pi request keeps the proxy fallback
  out of the client CWD claim and moves a misplaced JSDoc to its function.
  Current main's `buildCwdNote` returns an empty addendum for that case;
  corrected focused 123/123 and typecheck/build pass. Live macOS/Bun 1.3.14,
  SDK 0.2.141, Claude Code 2.1.280, Haiku 4.5 E2E passed Pi client-path
  controls in both response modes and bare no-CWD Pi in both modes (real SDK
  query observer and model response). Logs `/tmp/meridian-1100-e2e-pi.log` and
  `/tmp/meridian-1100-e2e-no-cwd.log`. Full `npm test` exited 0; all four
  distinct E41 modes passed, including an explicit parallel+stream rerun after
  a shell argument grouping mistake. Logs `/tmp/meridian-1100-e41-*.log`.
  All three pinned OpenCode V2 betas (`18314`, `18866`, `19271`) passed extended
  live E42 with separate proxy CWD; logs `/tmp/meridian-1100-e42*.log`.
  Delivery [#1111](https://github.com/rynfar/meridian/pull/1111) passed all
  final-head CI jobs (`35829422423`, Docker `35829422455`, desktop
  `35829422393`), merged as `bfede92b` with Guy's authored commit intact;
  unchanged source #1100 was closed without comment.

### #1097 incorporated as #1115; #1112 incorporated as #1117

- #1097 source `73ba641a` (Guy Addadi) was cherry-picked as authored commit
  `d81be56b` onto `/tmp/meridian-systemd-1097`, branch
  `codex/systemd-1097`. Separate maintainer commits `9dbb3b82` and
  `7e0dadfd` make numeric parsing strict, reset the idle clock on completed
  model HTTP requests, clear the timer on manual close, add the E59 process
  gate and document Node/systemd use. Focused 13/13, typecheck and build pass.
  E59 passed with an inherited fd and real Haiku response on macOS Node
  22.22.3 (`/tmp/meridian-1097-macos-live.log`); Linux Node 24.20.0 passed
  fd adoption, idle exit and reactivation without a model call
  (`/tmp/meridian-1097-linux.log`). The first Linux attempt failed solely
  because the minimal container lacked `/etc/machine-id`; a generated
  container-local ID enabled the successful rerun. Full `npm test` and all
  final-head CI passed (`35830800049`, Docker `35830799848`, desktop
  `35830799897`). Delivery [#1115](https://github.com/rynfar/meridian/pull/1115)
  merged as `79e14d7f` with Guy's authored commit intact; unchanged source
  #1097 was closed without comment.
- #1112 source `b5c485a8` (Nowaker) was cherry-picked onto
  `/tmp/meridian-gc-1112`, branch `codex/session-gc-lock-1112`. On current
  main the authored commit is `7d809138`; maintainer test correction is
  `98db8278`. Focused 43/43 and typecheck/build pass. On unchanged
  main, the source's sampling-based candidate-reuse test passed despite the
  old implementation; its FIFO test failed with `late, early`, whereas the
  cherry-picked code passes. The maintainer correction replaces the sampling
  test with a direct candidate lifetime assertion. Full `npm test` exited 0
  before rebasing onto #1115. Real E2E publication lifetime passed both
  nonstream and stream on that base,
  preserving markers, sources and zero unsafe deletions; logs
  `/tmp/meridian-1112-publication*.log`. Delivery
  [#1117](https://github.com/rynfar/meridian/pull/1117) merged as `a3640f0d`
  with Nowaker's authored cherry-pick intact; unchanged source #1112 was
  closed without comment. After the
  #1115 rebase, focused 43/43, typecheck/build and both real publication E2E
  modes passed again (`/tmp/meridian-1112-publication*-rebase.log`). Full
  final-head CI passed (`35831709077`, Docker `35831709065`, desktop
  `35831709066`).

### Issue #1107: fresh replay tool names

- On unchanged main, a real HTTP regression reproduced a fresh Pi replay
  containing the bare historical names `bash` and `mcp__oc__read`; the SDK
  registers prefixed aliases. The first baseline test run unexpectedly passed
  under shared process mocks, but an instrumented rerun and a clean rerun
  both failed as expected (`/tmp/meridian-1107-before.log`).
- Branch `fix/replay-tool-names-1107` renders historical calls with the same
  aliases used for current MCP registration, including collision handling,
  and threads the renderer through text and structured fresh replay and
  resume-fallback paths. Ordinary non-passthrough flattening is unchanged.
  Focused 34/34, typecheck, build and full `npm test` passed before rebase.
  Real Opus 5.5 E60 passed nonstream and stream, returning a new `bash` call
  after twelve old calls; existing Haiku replay-history control passed both
  modes. Logs `/tmp/meridian-1107-opus-live*.log` and
  `/tmp/meridian-1107-replay-control*.log`. After rebasing onto #1117,
  focused 34/34, typecheck/build, all four live E41 modes, and both live
  Opus E60 modes passed again. E41 logs are
  `/tmp/meridian-1107-e41-*.log`; E60 logs are
  `/tmp/meridian-1107-e60-*.log`. The real E43 namespaced-tool control
  also passed in both response modes (`/tmp/meridian-1107-e43-*.log`).
  Full final-head `npm test` and all CI passed (`35832749521`, Docker
  `35832749546`, desktop `35832749543`). Delivery
  [#1120](https://github.com/rynfar/meridian/pull/1120) merged as
  `253c0fcc`; issue #1107 closed automatically.

### Issue #1101: client-side OpenCode scrub drops cwd

- The exported scrub function in companion repository
  `rynfar/meridian-plugin-opencode-scrub` removed the entire duplicate
  `<env>` block before Meridian could extract the client's working directory.
  On unchanged plugin code, three new regression assertions failed. PR
  [#13](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/13)
  retains a bare `Working directory` field without the duplicate preamble or
  other fields; all 17 tests and build passed, as did final-head CI. A real
  Meridian HTTP → SDK → Claude Max check using the built scrub package passed
  both response modes with SDK `cwd` equal to the client project, distinct
  from the proxy directory (`/tmp/meridian-1101-live.log`).
- The plugin's Release Please [#7](https://github.com/rynfar/meridian-plugin-opencode-scrub/pull/7)
  was updated to include the fix. Its duplicate merge-commit changelog entry
  was removed in a separate maintainer commit; the exact release diff has
  three distinct fixes, version `0.2.1`, and a passing build/test/pack gate.
  The release workflow `35833345705` published the tagged GitHub release and
  npm package with provenance. Registry `latest` and version are `0.2.1`,
  integrity is `sha512-DOLXcZzuH0dXmL3i+2ENIc/x7WTLC0rmOJ757z5nZGIbxmNIVOhUWgmvamWK+ivklvDUPApqy1D+Emfc9/slTQ==`.
  A fresh registry install executed the exported scrub and preserved the cwd.
  Issue #1101 is closed.

### Issue #1098: unstreamed SDK fallback delivered

- Source illustration [#1099](https://github.com/rynfar/meridian/pull/1099)
  head `7043fa93` (Magnus Schmidt Rasmussen) is cherry-picked as authored
  commit `7137eb71` onto `fix/unstreamed-fallback-1098`. The source explicitly
  asks not to merge its draft as-is; maintainer corrections and gates are
  separate. An actual SDK/CLI request with a local API fixture reproduced
  unchanged main's HTTP 200 with no `message_start`, despite Claude Code's
  successful nonstreaming retry (`/tmp/meridian-1098-e2e-before.log`). The
  cherry-picked code plus corrections passed the same fixture's text, client
  tool-call and normal-stream controls (`/tmp/meridian-1098-e2e-corrected.log`).
  New HTTP tests exercise assistant-only turns; a pure helper and direct tests
  preserve thinking blocks for clients that support them. Focused 14/14 and
  typecheck/build pass. The unchanged-main streaming control also passed;
  all 14 real-SDK local-fixture capped-turn cases passed, and live E41 passed
  all four chain/parallel × plain/stream modes. Logs:
  `/tmp/meridian-1098-capped-*.log` and `/tmp/meridian-1098-e41-*.log`.
  Full `npm test` and all final-head CI passed (`35834431194`, Docker
  `35834431188`, desktop `35834431167`). Delivery
  [#1121](https://github.com/rynfar/meridian/pull/1121) merged as `31d8560f`
  with Magnus's authored commit intact. Issue #1098 closed automatically;
  unchanged source illustration #1099 was closed without comment.

### Issue #1095: single-step abort delivered

- Source illustration [#1096](https://github.com/rynfar/meridian/pull/1096)
  head `38bc082f` (Magnus Schmidt Rasmussen) was cherry-picked with Author
  and AuthorDate intact as `a012b4f7` onto `fix/single-step-abort-1095`.
  The source explicitly
  asked not to merge as-is. A new HTTP regression makes a self-aborted SDK
  iterator complete normally. It fails on unchanged main with a client error
  and passes with a separate cause-aware correction; source wording alone
  still failed because an earlier durability guard can throw a cancellation
  error before the final-envelope guard. Baseline log:
  `/tmp/meridian-1095-before.log`.
- The real SDK/CLI E62 local fixture passed a repeated same-tool call on both
  unchanged main and the fix. It checks the surrounding delivery contract but
  does not force the normal-completion abort timing. Focused HTTP and error tests
  passed 233/233; typecheck and build passed. Live E41 passed all four
  chain/parallel by stream/non-stream modes. E34 delivered three intact
  parallel tool batches, but its separate #742 intermittent race did not occur
  in three attempts, so that race gate is inconclusive for #742. Full `npm test`
  and all final-head CI jobs passed (`35835762270`, desktop `35835762260`,
  Docker `35835762353`). Delivery
  [#1122](https://github.com/rynfar/meridian/pull/1122) merged as `71495332`
  with Magnus's authored commit intact. Issue #1095 closed automatically;
  unchanged source #1096 was closed without comment.

### PR #1119: implicit attachment suppression delivered

- Source head `8a7aec9c` (Nowaker) was cherry-picked with Author and
  AuthorDate intact. Its AI attribution lines were removed from the copied
  commit message to match project format; the implementation is unchanged.
  On `fix/implicit-attachments-1119` rebased onto #1122, the authored commit
  is `5dae08e4`.
- The credential-free real CLI probe passed native expansion, passthrough
  suppression, resume, fork, exact explicit media, and inherited opt-out.
  Its negative control failed at the expected canary assertion. Focused query
  tests passed 92/92; full `npm test`, typecheck, build, and live E53 all
  passed before rebase. E41 passed all four chain/parallel by stream modes.
  After rebase, focused query/abort tests passed 108/108 and the real CLI
  probe passed again. All final-head CI jobs passed (`35836546338`, desktop
  `35836546319`, Docker `35836546387`). Delivery
  [#1123](https://github.com/rynfar/meridian/pull/1123) merged as `25a46612`
  with Nowaker's authored commit intact; unchanged source #1119 was closed
  without comment.

### PR #1118: Pi trailing reminder checkpoint delivered

- Source commits `7f3ecf48` and `756c3037` (Mate Remias) were cherry-picked
  with Author and AuthorDate intact. Rebased onto #1123 as `885791ab` and
  `6f92793e` on `fix/pi-trailing-reminder-1118`.
- Focused passthrough tests passed 159/159 before rebase and 175/175 after
  #1095 landed. Live Pi E2E passed plain and streaming checkpoint resumes;
  a revised-history streaming image case fresh-replayed with the reminder and
  image result intact. Typecheck, build, and full `npm test` passed on #1122.
  After rebase onto #1123, focused tests passed 175/175 and live Pi streaming
  resume passed again. All final-head CI jobs passed (`35837311983`, desktop
  `35837311976`, Docker `35837312005`). Delivery
  [#1124](https://github.com/rynfar/meridian/pull/1124) merged as `bace62f9`
  with Mate's authored commits intact. Source #1118 added an empty CI-retry
  commit `893348c8` without file changes; after recheck it was closed without
  comment.

### PR #1116 and follow-up #1126: CLI-rejected client tools delivered

- Source `f501cf9d` (Mate Remias) was cherry-picked with Author and AuthorDate
  intact as `14a47c34` onto `fix/rejected-tools-1116`, rebased through #1124.
  Its copied headline was normalized to `fix:` for this repository. Separate
  maintainer commit `d1420779` adds E63, a credential-free real SDK/CLI gate
  in Linux CI.
- E63's bare `read` refusal fails on unchanged #1122 main with an SSE API
  error after `max_tokens`; it passes with #1116 as one complete `tool_use`
  handoff. The registered-name control passes before and after. Focused
  tests passed 125/125 before rebase; full `npm test`, typecheck and build
  passed on #1122. After rebase onto #1124, focused tests passed 137/137,
  both real SDK/CLI E63 cases passed, and E41 passed all four
  chain/parallel by stream modes. Final-head Linux test, Windows smoke,
  desktop and Docker checks passed (`35838259252`, `35838259244`,
  `35838259072`). Delivery [#1125](https://github.com/rynfar/meridian/pull/1125)
  merged as `ec7c9c39` with Mate's authored commit intact.
- The source added a follow-up commit after #1125 merged. Commit `8bce3b4d`
  and #1126's extra assertion `7d02c432` were cherry-picked with Author and
  AuthorDate intact as `c6b0bc54` and `0a502cc5` on
  `fix/rejected-tools-continuation-1116`. The #1120 tool-selection move made
  one cherry-pick conflict; tool restoration was placed before the fresh
  replay renderer so the replay and MCP registration see the same schema.
  A separate maintainer commit runs the real SDK/CLI refusal-to-result-turn
  fixture in Linux CI. The fixture failed on #1125 main and passed on the
  follow-up, including a fresh SDK session, omitted client tools, and the
  registered MCP name in replay. Focused integration 104/104, full
  `npm test`, typecheck, build, E63 controls, and live Pi parallel streaming
  E41 all passed. Final-head Linux, Windows, desktop and Docker checks passed
  (`35839354306`, `35839354302`, `35839354294`). Delivery
  [#1127](https://github.com/rynfar/meridian/pull/1127) merged as `438b2bf9`;
  unchanged source #1116 and follow-up #1126 were closed without comment.

### PR #1114: preserve in-flight profile turns delivered

- Source head `464c3c87` (Nowaker) is cherry-picked as `6ecfbaa7` with Author
  and AuthorDate intact on `fix/profile-switch-inflight-1114`; the copied
  headline was normalized to `fix:`. The source's HTTP fixture reproduced
  the in-flight failure on unchanged #1122 main in both response modes.
  The fix removes the global session-cache clear during profile switching;
  existing profile-scoped keys keep the mappings isolated. A separate
  maintainer test checks another profile's durable resume state. Focused
  17/17, full `npm test`, typecheck and build passed on the final branch.
  Final-head Linux, Windows, desktop and Docker checks passed
  (`35840110191`, `35840110130`, `35840110184`). Delivery
  [#1128](https://github.com/rynfar/meridian/pull/1128) merged as `69bcf6de`
  with Nowaker's authored commit intact; unchanged source #1114 was closed
  without comment.

### Issue #1089: client summary compaction replay under review

- The old suffix-overlap classifier resumed the stored SDK session after a
  client replaced a long head with a short summary. A new pure-lineage
  regression fails on unchanged main; the real SDK/CLI E64 local fixture
  confirms the summary never reached the model on #1124. The correction
  fresh-replays only a shortened head, keeps equal-length pruning on the
  existing checkpoint, and has explicit legacy opt-in
  `MERIDIAN_COMPACTION_SURVIVAL=1`. The lineage helper remains pure.
- Focused lineage/HTTP tests passed 180/180, full `npm test`, typecheck and
  build passed before the latest rebases. After #1127, focused 110/110 and
  both real SDK/CLI E64 modes passed: default delivered the summary and
  omitted the removed head; legacy resumed. E64 runs both modes in Linux CI.
  Delivery [#1129](https://github.com/rynfar/meridian/pull/1129) is open;
  final-head validation after #1128 remains. Its first final-head Linux CI
  run passed the full main test pass but failed one of 73 isolated priority
  tests: a fixed 5s quota reset expired during the test's own retry ladder,
  causing the 10-minute fallback mark. This is unrelated to compaction and
  reproduced only under that runner's timing. A separate test correction
  shortens the mock retry delay and waits until the recorded reset rather
  than sleeping 3.6s; all three affected cases and the entire 73-case
  priority file pass locally. The corrected CI rerun remains.

### Issue #1094: stable OpenCode V2 compatibility hold

- [Official OpenCode V2 installation](https://opencode.ai/v2/docs) now uses
  `@opencode/cli`; npm `latest` was 2.0.15
  when checked September 23. The isolated binary reports `opencode v2.0.15`.
  Current Meridian setup correctly rejects it and leaves the beta-only
  plugin uninstalled (`/tmp/meridian-1094-setup.log`). The plugin imports
  `@opencode-ai/plugin/promise`, while the
  [stable V2 migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
  requires `@opencode/plugin` and a changed setup/hook API. Unpinning the
  version gate alone would load
  an incompatible plugin. Leave #1094 open for a port and full E42-style host
  qualification; do not claim stable V2 support in this release.
- #1050 is Antigravity research with no production
  behavior. #792 explicitly asks not to be reviewed or merged yet.
- The Release Please PR remains open until the issue pass and all affected
  flow gates are complete.

## Delivered: Review and Autonomous Processing Batch (2026-09-19)

### PR #1060 (Issue #1027): OpenCode V2 beta-19271 Qualification
- Base: `d8516bea`
- Delivery PR: [#1060](https://github.com/rynfar/meridian/pull/1060), merged as `303ce0d0`.
- Problem: `@opencode-ai/cli@0.0.0-beta-19271` was published upstream, and Meridian's `SUPPORTED_OPENCODE_V2_VERSIONS` only accepted `beta-18314` and `beta-18866`.
- Fix: Qualified `0.0.0-beta-19271` in `SUPPORTED_OPENCODE_V2_VERSIONS`, updated test assertions in `scripts/e2e-opencode-v2-package.mjs` and `scripts/e2e-idle-stall-clients.mjs`, and documented OpenCode V2 host qualification policy in `docs/agents.md`.
- Validation:
  - Real offline package E42 gate: PASSED.
  - Real extended live E42 gate (`bun scripts/e2e-opencode-v2-package.mjs --live --extended --separate-proxy-cwd`): PASSED.
  - Full test suite (`npm test`) 100% pass across 76 suites.
  - CI: all 6 workflows green. Issue #1027 closed.

### PR #1061 (Contributor PR #771): Profile Login Unknown ID Auto-Creation
- Base: `303ce0d0`
- Contributor PR: [#771](https://github.com/rynfar/meridian/pull/771) by @Nowaker (`19cf472a8380e5c814fd05d6d14b091c172b1994`).
- Delivery PR: [#1061](https://github.com/rynfar/meridian/pull/1061), merged as `96a75ac5`.
- Problem: `meridian profile login <id>` exited with code 1 if `<id>` was unknown, forcing a separate `meridian profile add` invocation for the same user intent.
- Fix: Cherry-picked contributor commit preserving author and date. Extracted pure `isValidProfileId` and `planProfileLogin` decision helper in `src/proxy/profileCli.ts`. When an unknown ID is provided, warns with standard yellow warning notice and invokes `profileAdd(id, options)` to create and authenticate the profile. Path traversal attempts are rejected before touching disk.
- Validation:
  - Unit tests: `bun test src/__tests__/profile-login-plan.test.ts` (8/8 pass).
  - Production build: `bun run build` and `npm run typecheck` clean.
  - Full test suite: `npm test` 100% pass.
  - CI: all 6 workflows green. PR #771 closed.

### PR #1062 (PR #765): Plugin Flake Inputs Update
- Base: `96a75ac5`
- Contributor PR: [#765](https://github.com/rynfar/meridian/pull/765) (`ce320144ed2034c92669094bc108dcc58fb581e7`).
- Delivery PR: [#1062](https://github.com/rynfar/meridian/pull/1062), merged as `865b8331`.
- Problem: Nix `flake.lock` had outdated revisions for `meridian-plugin-hermes-scrub`, `meridian-plugin-opencode-scrub`, and `meridian-plugin-pi-scrub`.
- Fix: Cherry-picked updated flake revisions.
- Validation:
  - Nix CI workflows (`build (macos-latest)`, `build (ubuntu-latest)`, `verify`) and all main repository CI workflows passed. PR #765 closed.

## Delivered: Claude Code Headless Concurrent Turns #1043 (2026-09-18)

- Base: `75d0c507` (incorporation of contributor PR #1048 as #1055).
- Worktree: `/Users/rynfar/repos/meridian/.claude/worktrees/claude-code-headless`, branch `fix/claude-code-headless-concurrency`.
- Problem: Claude Code CLI in headless mode (`claude -p "..."`) fires a session-start side request (`tools=0`, single user message) and the primary prompt (`tools=24`, message count 2) concurrently under the same session ID in `metadata.user_id: {"session_id": "..."}`. Meridian serialized both turns via the turn lease, but when the second turn acquired the lease after the first committed, `lostRaceWhileWaiting` fired and rejected the turn with HTTP 400 "This session advanced while the request was waiting" because Claude Code has no per-flow plugin headers.
- Fix: Set `runsConcurrentTurnsPerSessionKey: true` on `claudeCodeAdapter` in `src/proxy/adapters/claudecode.ts`. This activates `declaresConcurrentFlow`, allowing the loser of the race to be safely admitted as a fresh replay while preserving serialized turn execution (`maxActiveQueries: 1`).
- Verification:
  - Unit test in `src/__tests__/claude-code-adapter.test.ts`.
  - Concurrency test in `src/__tests__/proxy-concurrency-coordination.test.ts`.
  - Real Claude Code 2.1.277 live CLI execution in headless mode (`claude -p "Reply with OK"`) confirming 0 turn conflicts and clean exit code 0.
  - Full test suite (1243 tests) and typecheck pass cleanly.

## Current bounded work: Windows GC #896 (2026-09-14)

This entry supersedes the historical "nothing is in progress" statements below
for **#896 only**. The owner requested native Windows review, then authorized
fixing the Bun/Volta failure found in that review. Disposition: accept with the
correction implemented; hold integration pending the Pi live gate and final CI.
No release, community comment, original-PR closure, or unrelated backlog work
is authorized by this task.

- Base: `1d7544b6`; source PR head: `7fe1acaf9a9ab34f7d76ee4d9360a9f69ce24eb6`.
- Worktree: `/tmp/meridian-windows-gc-fix`, branch `codex/windows-session-gc`.
- Author-preserving cherry-picks (Aaron Masover, `amasover@gmail.com`):
  `4b712fd` → `0b7b985`, `defdad3` → `8d58432`, `7fe1aca` → `acd19f4`.
  The CI conflict preserved both the existing CWD checks and the added GC job;
  the resulting contributor tree exactly matched the reviewed PR head.
- Maintainer correction resolves the actual Node executable under Bun with a
  bounded single-line probe, caches successful resolution, and launches that
  binary directly. This avoids Volta's multiline eval corruption and fences
  the actual executor PID. The new regression asserts both multiline execution
  and exact child/executor PID equality.
- Native Windows 11 26200.8037, Bun 1.3.11, Node 24.18.0, SDK 0.2.141,
  Claude Code 2.1.259. Original main reproduces backlog-full; uncorrected PR
  with normal Volta PATH fails 4/5 GC tests; corrected normal PATH passes 6/6.
  Windows typecheck and build pass. Linux `npm test` (with pretest typecheck)
  passes 3950 tests, 0 failures, 1 skip; build passes.
- Real SDK creation/pin/deletion gate passes on Windows with the corrected
  code, including `result.is_error === false`. The temporary before/after
  probe also observed main defer a real transcript and corrected GC delete it.
  Directory-less exact-ID SDK inspection is intentional: project-scoped reads
  failed to find the Windows transcript while supported exact-ID lookup found
  it. No private transcript files were inspected.
- The initial live request failures were due to Windows' inherited
  `ANTHROPIC_BASE_URL`; it was removed only in disposable test processes.
  Actual Pi 0.73.1 through the isolated proxy reaches the Pi adapter but the
  upstream returns HTTP 400, "You're out of extra usage." This is a failed
  acceptance gate, not a GC success or a demonstrated GC defect. No quota or
  billing settings were changed.
- An initial diagnostic accepted SDK subtype `success` alone. That can mask
  `is_error:true`; the committed gate now rejects it. The stricter direct-SDK
  gate passed; the Pi gate remains blocked by the explicit API refusal.
- Reproducible live gate: `scripts/e2e-windows-session-gc.mjs`, documented in
  `E2E.md`, optionally with `PI_CLI_PATH` for the actual client. Raw logs:
  `/home/trevorwalker/.local/share/meridian-reviews/pr-896/` and Windows temp
  `meridian-pr896-fix`. A separate broader Windows suite hit preexisting POSIX
  mode expectations and a Bun crash; it is not counted as a pass (see prior
  review record).

Next: consult the integration PR linked to #896 for final-head CI, rerun the
actual Pi gate when the upstream account accepts requests, then assess merge.
Do not infer permission to release. The original contributor PR remains open.

Checkpoint: 2026-09-11, after publishing Meridian 1.70.0 and then 1.71.0,
repairing the E42 gate (#1014), closing the V2 cold-start gap (#1008), landing
two of the three #980 splits (#1011, #1009), and triaging #1024 to
configuration.
Refresh
GitHub and origin/main before continuing; this is a dated checkpoint, not a
live queue.
The owner requested portable skills and agent instructions so either Claude,
Codex, or another repository agent can resume this work.

## Read first

Follow [meridian-upstream-review](../../.agents/skills/meridian-upstream-review/SKILL.md)
and [AGENTS.md](../../AGENTS.md). The last delivered item is contributor PR
#1005, incorporated as #1012 and merged as `c3dc2279`. Before that: #980 as
#1010 (`3db622fa`), #1003 as #1004 (`7028c697`), issue #820
(PRs #994 and #995), the OpenCode V1 plugin packaging fix (#988) and a
race-harness deflake (#997), plus #996 — a regression in our own #983, found
while validating #820 and fixed in #998.

The last delivered items are the **#980 splits**: abort-cause diagnostics
(#1022, `0fd59403`) and uncaptured-tool recovery (#1025, `d8516bea`, off by
default). Before them: #1008 (#1018, `52b581b6`), #1014 (#1016, `1519f8d8`) and
the probe-discipline rules in #1019 (`619bbe70`).

**Nothing is in progress.** Held by explicit owner decision: the third #980
split, `fix: recover visible empty capped streams` — see #1011. Still open for a
canary and a live gate: #1009.

**1.71.1 is published**, authorized explicitly by the owner: tag `ea5e9845`,
npm `latest`, provenance `gitCommit` equal to the tag commit, Docker on both
architectures, and the published artifact driven from the registry. It carries
the #1024 fix the reporter was waiting on.

**Unreleased on `main`:** the typecheck hook (#1035) and the session bookkeeping
incorporation (#1036). A release needs its own explicit authorization.

**1.70.0 is published.** The owner authorized it explicitly; PR #1006 was merged
as `0acf3b19` and the publication is verified below — npm, provenance by
content, Docker and a registry-install run of the real client flow. Nothing is
in progress and nothing is held. A future release still needs its own explicit
authorization — this one does not carry forward. 1.69.0's section has been
demoted to "Previous checkpoint"; do not republish either.

An earlier version of this block said PR #977 was "green on everything and
held for owner review". That was already stale when it was written: #977 merged
at 2026-09-09T03:18Z as `03fe5716` and appears in #970's changelog. The claim
was carried forward from the previous checkpoint without being rechecked, which
is the specific failure the "Read first" instruction above warns about — refresh
live GitHub state, do not trust the dated text.

Continue when the owner asks; this document does not start background work or
authorize two agents to work the same queue. A prior agent's
paused/blocked goal is not a claim that the backlog is complete.

Keep this checkpoint current after a delivered ticket or meaningful pause.
Record the item, disposition, original/delivery/base SHAs, author mapping,
worktree/branch, before/after proof, tests and E2E versions, CI URLs, merge and
closure status, limitations, and the exact next action. Put portable evidence in
the PR or linked review record; optional private local logs are not prerequisites
for discovering the workflow. Never invent test evidence if those logs are absent.

## Standing instruction, 2026-09-10: file a ticket

The owner asked that anything flagged as a real problem needing a fix becomes a
GitHub issue, not a line in a PR body or a doc: "i cant keep up with all of
this." Applied retroactively to the V2 cold-start race as #1008. Observations
that need no fix stay observations; a "known limitation" note is not a ticket.

Tickets opened under this instruction so far: #1008 (V2 cold-start race),
#1009 (deferred uncaptured-tool recovery), #1011 (the held passthrough
commits on `codex/polytoken-extras`), #1014 (the E42 gate's exit code and its
missing discovery coverage), #1027 (supported V2 betas have drifted, and #1023's
version does not exist) and #1028 (E42 can exit 1 after PASS when a straggler
hits the fixture during teardown). All six came out of validation runs, not
from reading code.

## Completed checkpoint: Meridian 1.71.0

[Meridian 1.71.0](https://github.com/rynfar/meridian/releases/tag/meridian-v1.71.0)
shipped through [release PR #1020](https://github.com/rynfar/meridian/pull/1020),
authorized explicitly by the owner. **Published and installed-package
validated.** Do not republish it.

| | |
|---|---|
| Candidate tree | `a6ae7050` (parent `d8516bea`), all four checks green after approval |
| Release/tag commit | `60722ad95983e0518d60378b5e0fdcce89b1e765` |
| npm | `1.71.0`, `latest` → `1.71.0` |
| Tarball integrity | `sha512-ugp+7bC9e0owstbxr7rnda3/8vlSc1iWRrGbXNDeS8u3B+FjtzC1juLpnyTTxnYPDOapQ8WlU25c3j4iYLBH6A==` |
| SLSA provenance | `gitCommit: 60722ad9…` equals the tag commit; workflow `release-please.yml` |
| Docker | `1.71.0` and `latest`, `linux/amd64` + `linux/arm64` |
| Post-release on `60722ad9` | CI, Release Please, Docker — success |

Changelog: `feat` abort-cause diagnostics (#1022) and uncaptured-tool recovery
(#1025); `fix` V2 catalog cold-start seed (#1018).

**Gates before the merge.** `npm test` 3922 pass / 1 skip / 0 fail on bun
1.3.14, typecheck, build. Live: E42 `--live --extended --separate-proxy-cwd`
against **both** pinned betas using the packed 1.71.0 consumer, plus the
`--no-discovery` and `--v1` controls; all 14 capped-turn controls with the
uncaptured-recovery flag off and four more with it on; all four E41 modes; both
`e2e-opencode-package-integrity.mjs` variants. Installed-package validation ran
twice — packed tarball and then the registry download — with
`toolRounds=3 resumed=3` on `pi`, `passthrough`, `opencode` and `polytoken`.

The candidate's CI again arrived `action_required` and had to be approved run by
run, as the 1.70.0 section warns. One approval returned
`403 This workflow run is not waiting for approval` because it had already
started — that is success, not a failure.

**A flaky gate found during this release, ticketed as #1028.** The first E42 run
against `0.0.0-beta-18314` printed `{"result":"PASS"}` with every probe green and
then exited **1**. Cause is in the log, not a guess: a straggler client request
reached the fixture during teardown, after `proxy.close()`, and the fixture's
**live POST forward is unguarded**, so the rejection set the exit code —
`ConnectionRefused`/`ECONNRESET` at `scripts/e2e-opencode-v2-package.mjs:128`.
#1016 hardened the non-POST branch for exactly this and the POST branch was
never given the same treatment. A second run exited 0 with identical
assertions. The release was not held: the artifact under test passed everything,
and the defect is in the harness. **This was not written off as "a rerun
passed"** — it is root-caused to a named code path and tracked.

## Delivered: session bookkeeping off the request path, #1030 as #1036

Contributor PR by @justprosh, incorporated as `596a0d83` with Aleksey
Proshutinskiy's authorship preserved (`ba3792b8` → `2a524584`, `8b573a3c` →
`cf1aac50`) and a `Co-authored-by` trailer on the squash. Both commits applied
cleanly to current `main` — no conflicts. Branch `codex/session-bookkeeping`,
worktree `/tmp/meridian-1030`.

**#1030 is still OPEN.** Its head was rechecked as `8b573a3c`, unchanged, so
nothing of theirs was lost. Closing it notifies the contributor, so that is left
to the owner along with a note.

**What it fixes.** A ~500 turns/hour deployment losing **13–16% of turns** to a
504 that blamed the request. Four independent bookkeeping defects: a deletion
backlog that never drained (254 attempts on one resource, then
`ownership backlog is full` for every *new* conversation); a 26 MiB store parsed
synchronously (135 ms) several times per request and once under the lifecycle
lock; unarmed leases with no TTL fencing conversations until restart (30 leaked,
28 older than 15 minutes); and pretty-printed machine-only files costing ~20–25%
of bytes and CPU under the lock. Saturation now answers 503 `overloaded_error`
naming the reason instead of a 504.

**How it was reviewed, and the one thing that mattered.** The new tests were run
against the **pre-fix** tree, which is the only way to tell evidence from
decoration:

| new tests | pre-fix |
|---|---|
| `classifyError` saturation | 3 of 4 fail (the 4th is a control) |
| read-cache identity reuse | fails |
| read-cache safety properties | pass — regression guards, not demonstrations |
| lease TTL | could not run (imports a symbol absent pre-fix) |
| **deletion verdict** | **pass** |

The headline defect's tests pass pre-fix. Their fixture's child output is short
enough that the old `output.slice(-4_000)` still contained the verdict, so they
prove the new mechanism works but not that it fixes the reported failure — only
an output larger than the tail budget separates them. `cd753c73` pins that shape
directly. **This is the fourth time this month a test passed while covering
nothing** (#1025, the plugin-less 400, #1004's missing gate, now this one);
running a PR's own tests against the pre-fix tree is the cheapest way to catch
it and should be routine.

**The read cache's premise was checked, not taken.** Identity keying by
`{path, ino, mtimeMs, size}` is exact only if every writer publishes through
`rename`. `writeStore` writes a unique temp, fsyncs, renames — new inode per
publish — and re-takes identity from the same fd it reads bytes from, closing
the stat/read race. The other two `writeFileSync` calls in that module target
lock and claim paths, never the store.

`3d2a8755` documents `MERIDIAN_SESSION_GC_LOCK_WAIT_MS`, which shipped
undocumented — the knob an operator reaches for when the new 503 says a lock is
busy. Env names verified against `src/env.ts`, not assumed.

**Validation.** `npm test` 3948 pass / 1 skip / 0 fail, build. Live E41 all four
modes plus `publication-lifetime`, `settlement-proof` and `duplicate-checkpoint`
— run twice, on the incorporated tree and again after the two maintainer
commits.

**Not verified, deliberately:** the three quantitative claims (254 attempts,
135 ms under lock, 30 leaked leases) are the reporter's measurements. The
mechanisms and their guards were verified; the load was not reproduced. A
synthetic 26 MiB store is the obvious next gate if the performance claim should
be pinned rather than argued.

## Delivered: #1024, plugin-less OpenCode concurrency, as #1031

Root cause is configuration; the fix shipped anyway because failing a user's
first turn is the wrong response to a client that cannot send the signal.

Merged as `2e118a92`, branch `codex/opencode-pluginless-concurrent-flow`,
worktree `/tmp/meridian-1024fix`. **#1024 deliberately stays open** until
@calebdw confirms on their machine.

**The decision, and why it was narrow.** The owner had no strong view, so the
options were priced against the code. The conflict guard already skips when
`declaresConcurrentFlow` is true, and `adapters/pi.ts` already sets
`runsConcurrentTurnsPerSessionKey: true` for exactly this reason — the in-code
rationale reads "an adapter can declare the same fact for its whole protocol
when the client has no per-flow signal to send". A plugin-less OpenCode request
*is* such a client. So the change reuses that mechanism and applies it only to
requests carrying no plugin signal, via a pure predicate
(`isPluginlessOpenCodeRequest`) that the existing warning already computed.

Rejected: setting `runsConcurrentTurnsPerSessionKey` on the whole OpenCode
adapter. One line shorter, but it would relax the guard for plugin-equipped
users too, where a collision is a real defect and should stay loud.

Also rejected, and previously tried and reverted — see the header of
`pluginless-opencode-warning.test.ts`: inferring which stream is the title from
request shape. "Tool-less, one message" is equally the first turn of an ordinary
chat.

**Before / after, live, reporter's models:**

| headerless, Opus primary + Haiku title | before | after |
|---|---|---|
| primary | 200 | 200 |
| title | **400** | **200** |

Plugin-equipped control unchanged at 200/200 with no warning. Serialization is
untouched (`maxActiveQueries` still 1) and the loser still runs fresh; the cost
is a cold prompt cache, which the warning text now states instead of predicting
a 400 that no longer happens.

**Coverage added, because none existed.** The full suite passed *before* the
change too — no test pinned the plugin-less 400, which is why the behaviour
could be relaxed silently. Added: predicate unit tests (UA case, both agent
modes, and negatives including `opencode2`, `crush`, `Polytoken`,
`my-opencode/1.0` as a prefix-not-substring check); an HTTP-layer test that a
plugin-less pair is admitted, still serialized, runs fresh and emits no
`session_turn_conflict`, **verified to fail on the tree without the one-line
condition**; and an HTTP-layer control that a plugin-equipped pair still takes
the 400 — that control passes with *and* without the fix, which is what proves
the scoping.

`npm test` 3927 pass / 1 skip / 0 fail, typecheck, build, all four E41 modes.

**A reply to @calebdw is drafted and NOT posted**; sending still needs owner
authorization.

## Superseded triage note: #1024 was first read as configuration only

Reported by @calebdw against Meridian 1.68.0 through the third-party
`opencode-with-claude@1.10.1`: the first message of every new session fails with
`This session advanced while the request was waiting`. OpenCode fires a Haiku
`agent=title` stream and the Opus primary turn concurrently on one OpenCode
session id.

Reproduced on the 1.71.0 candidate with the reporter's models, firing the title
one second after the primary:

| setup | primary | title |
|---|---|---|
| no Meridian agent headers (reporter's shape) | 200 | **400** `This session advanced while the request was waiting` |
| Meridian's plugin headers present | 200 | 200 |

In the passing control the log shows `source=subagent-title agent=subagent`
running concurrently with `agent=primary` (`sdkActive=1/10`) — the title is
detached exactly as designed. In the failing variant the proxy prints its own
warning, which describes this failure precisely: "OpenCode request without the
Meridian plugin's agent headers … the first turn of each session can fail with a
400 … Fix: meridian setup".

So the reporter is missing Meridian's own plugin; the third-party one does not
stamp those headers. Their observation that 1.62.1 worked is consistent: the
stricter session-advance check landed later, so the same collision was
previously silent — replaying against a cold cache instead of failing.

Note one difference from the report: in our reproduction the **title** took the
400 and the primary completed, where theirs lost the Opus stream. Which side
loses is timing-dependent; the mechanism is identical.

**A reply is drafted but NOT posted** — sending needs owner authorization. The
open product question, which is the owner's: should Meridian absorb header-less
concurrency by serialising or forking per mapped session instead of returning
400, which is what a drop-in Anthropic API would do? Today it fails the turn.

## Open: supported V2 betas have drifted, #1027

Surfaced triaging #1023 (@Ardumine), which adds `0.0.0-beta-19425` to
`SUPPORTED_OPENCODE_V2_VERSIONS`. **That version does not exist on npm** — 404;
the 5-digit beta series ends at `0.0.0-beta-19271`. A supported beta must pass
E42 against that exact binary, so #1023 cannot be accepted as written whatever
its merits. Upstream has also moved to date-based versioning
(`0.0.0-beta-202608110357`, 1107 betas total), leaving our newest supported host
`18866` roughly 400 revisions behind. #1027 asks for a policy — how many hosts,
a set or a floor — before any bump is worth validating.

## Delivered: two of three #980 splits (#1011 partly, #1009 landed off by default)

Both cherry-picked from preserved contributor commits by @jakewimmer, authorship
and AuthorDate intact, each with maintainer corrections in separate commits.

| split | original | incorporated | delivery | disposition |
|---|---|---|---|---|
| abort-cause diagnostics | `016eb53c` → `77667583` | `8f362e18` | `0fd59403` (#1022) | landed |
| uncaptured-tool recovery | `f185e76e` | `929d351f` | `d8516bea` (#1025) | landed, flag off |
| visible empty capped streams | `c5804275` | — | — | **deferred by owner** |

Both squashes carry `Co-authored-by: Jake Wimmer`. `c5804275` remains on
`codex/polytoken-extras`; do not retype it.

**Deferred by owner decision: `fix: recover visible empty capped streams`.** It
changes a documented, gate-defended guarantee and introduces a stream/non-stream
asymmetry. `E2E.md` says "empty output, thinking alone and unhandled calls must
fail" (#926); with the commit applied, live:

| case | non-stream | stream |
|---|---|---|
| `empty` capped turn | 1 cap query — fails, as documented | **2** — lifts the cap and retries |
| `thinking`-only capped turn | 1 — fails | **2** — retries |

`--case=empty --stream` and `--case=thinking --stream` both fail on
`assert.equal(capQueries.length, retry ? 2 : 1)`. Everything else was green,
including all four E41 modes and the #925 `--drop-stop` control — the
contributor's own validation was the unit suite, which never runs these gates.
The owner chose to defer rather than rewrite the contract; the full evidence and
the two ways to pick it up are in #1011's body.

**Two maintainer corrections worth remembering.**

`1cf83e46` (in #1022): the contributor's message said all five
`formatSdkTermination` call sites pass the abort snapshot. Four did. The missing
one was `sdk_termination_recovered` on the captured-tool recovery path — the
diagnostic closest to the incident the field exists for. Nothing failed, because
an omitted context field simply does not render. Fixed, with a source invariant
that fails without it, because the capped-turn fixtures never reach that site.
Observed live afterwards: `sdk_termination reason=max_turns turns=1 abort=none`.

`012103f0` (in #1025): the uncaptured-recovery feature's **central test had
never executed**. It called `parseSSE` without importing it — `tsc` reports
`TS2304`, bun throws `ReferenceError`. So the behaviour the commit exists for
had no running coverage. `bun test` does not typecheck; this is the second time
that trap appeared today, the first being my own new test file caught by CI in
#1018. With the import fixed (and four forbidden `as any` casts replaced) the
test passes.

**Why #1025 was safe to land while #1011's sibling was not.** #1025 is
`MERIDIAN_PASSTHROUGH_UNCAPTURED_TOOL_RECOVERY`, off by default, every new path
flag-gated. All 14 capped-turn controls and all four E41 modes pass with it off;
with it **on**, `unhandled`, `empty`, `partial` and `retry` (stream) still behave
exactly as documented, so the refusal boundary holds live. The deferred commit
changed default behaviour and broke two of those same controls.

**What #1009 still needs** (it is deliberately still open): a live gate for the
positive abort-window shape — the fixture streams a complete `tool_use` block
but for an *undeclared* tool, so it exercises refusal, not recovery; reproducing
the real shape needs an abort injected between a declared tool's
`content_block_stop` and hook dispatch, which the fixture cannot do and which is
racy to time. Plus the non-streaming parity decision, documented as a
flag-scoped limitation rather than decided. Plus the canary itself.

**A hazard that nearly fired.** #1025's PR body originally read "why this does
not close #1009". GitHub's linked-issue parser ignores the negation, so merging
would have shut the ticket that tracks the remaining work — the same failure as
#997/#917 and #969/#967. The pre-creation grep caught it; `closingIssuesReferences`
was verified empty before merging. **Grep the PR body for keyword-then-number
before creating it, and check `closingIssuesReferences` before merging.**

## Delivered: OpenCode V2 cold-start catalog, #1008 as #1018

Maintainer-originated, filed by us while validating #1004. Base `00b41a6f`,
branch `codex/v2-catalog-cold-start`, worktree `/tmp/meridian-1008`, delivery
commit `eabd78dd`, merged as `52b581b6`. #1008 closed by the PR body.

**Before / after**, same new gate assertion, same host:

| tree | coldStartProbe | exit |
|---|---|---|
| pre-fix (`00b41a6f` + gate only) | `{"errors":["provider.no-route"],"efforts":[]}` | 1 |
| fixed | `{"errors":[],"efforts":[null,"xhigh"]}` | 0 |

**The fix.** Each successful discovery is cached in
`~/.config/meridian/opencode-v2-catalog.json`; the plugin reads it
*synchronously* in `setup`, before the first transform can run. The seed cannot
be a catalog read — awaiting the catalog in `setup` deadlocks the server, which
is why discovery is driven off `catalog.updated` at all.

**The finding that changed the design.** The plan was to validate a cached entry
against the provider's configured base URL so a repointed provider could never
apply another Meridian's models. That is impossible inside a transform: a draft
`Provider.Info` exposes only
`["id","name","activation","package","integrationID","headers"]`, and the whole
record contains **no URL anywhere** — observed by instrumenting the real host on
beta-18866, after the types suggested otherwise. So the guarantee is self-healing
rather than preventive:

- the seed is applied optimistically to any Meridian provider still in the catalog;
- when discovery finds no Meridian-shaped base URL the provider has been
  repointed, so the cache is deleted and the catalog rebuilt without it;
- a provider that is configured but unreachable keeps its seed, because the last
  catalog Meridian served beats models.dev's 1M Sonnet.

**Behaviour narrowed, deliberately.** "Meridian unreachable leaves the catalog
exactly as OpenCode built it" now holds only when no cache is present. Recorded
in `docs/agents.md` with how to clear the file. The `--no-discovery` control
still passes because it runs with an isolated config directory. A brand-new
install's very first request still has no cache; no plugin API allows better —
`@opencode-ai/plugin@0.0.0-beta-19271` still has a synchronous `Transform` and no
config domain.

**New gate coverage** in `e2e-opencode-v2-package.mjs`: a cold-start probe that
spawns a fresh `--standalone` process rather than reusing the warm server, and a
non-live invalidation probe that repoints the provider, requires the cache file
to be deleted and the next cold run to reject the variant. The first repointed
run is recorded but not asserted — whether it still offers the variant depends on
how far model resolution gets before discovery lands.

**Validation.** `npm test` 3890 pass / 1 skip / 0 fail on bun 1.3.14 (10 new),
typecheck, build. Exit 0 for: live `--extended --separate-proxy-cwd` on
beta-18866 and beta-18314; the same against an independently `npm pack`-installed
consumer; non-live; `--no-discovery`; and the `--v1` control on pinned
`opencode@1.18.11` with `discoveryTrace: []`. Exit 1 with one new assertion
deliberately broken. `e2e-opencode-package-integrity.mjs` passes both variants.
The merged tree was confirmed file-by-file identical to the validated tree.

**Two process notes from this ticket.**

`npm test` does **not** typecheck, and CI runs `npm run typecheck` inside the
`test` job. A new test file typechecked fine locally only because typecheck was
last run before it existed; CI caught four `TS2345` errors from a hand-rolled
`CatalogDraft` stand-in. Run `npm run typecheck` *after* adding or editing test
files, not before. The fix was to narrow the function's parameter to the
`CatalogProviderProbe` interface it actually needs, which is better typing than
the stub it replaced.

A `--v1` control failed with `ENOENT` on the pinned binary, which looked like a
regression and was not: the previous ticket's cleanup had deleted
`/tmp/opencode-v1-11`. Reinstall `opencode-ai@1.18.11` before reading anything
into a V1 failure.

## Delivered: the E42 gate's exit code and its missing discovery coverage, #1014 as #1016

Maintainer-originated, filed by us during 1.70.0 release validation under the
owner's standing ticket instruction. Base `3145fc49`, branch
`codex/e42-discovery-gate`, worktree `/tmp/meridian-1014`, delivery commit
`36362440`, merged as `1519f8d8`. #1014 closed by the PR body. No external
contributor is involved, so no author mapping applies. Test infrastructure only:
no source, plugin or configuration change.

**The defect.** `scripts/e2e-opencode-v2-package.mjs` recorded traffic through a
`Bun.serve` fixture that called `request.json()` on every request. The
`GET /v1/models` that #1004's model discovery issues has no body, so it threw.
Discovery failed closed, and the unhandled rejection set the process exit code —
the gate printed `{"result":"PASS"}` and exited **1**. So the mandatory V2 gate
had a meaningless exit code *and* the feature released in 1.70.0 had no
automated coverage. Causality established by A/B before changing anything:

| fixture | `result` | `GET - /v1/models failed` | exit |
|---|---|---|---|
| as shipped | `PASS` | 5 | **1** |
| patched to answer non-POST | `PASS` | 0 | **0** |

A second instance of the same class surfaced only once the first fix let the run
get far enough: the live forward hardcoded `method: 'POST'`, and an abort
mid-forward threw out of the handler. A one-shot client process exiting with
discovery in flight does exactly that; it appeared as `status: null`. Both are
now caught and recorded rather than thrown.

**What the gate now asserts.** A `GET` to *exactly* `/v1/models` — the original
contributor version requested `/v1/v1/models`, because the Anthropic provider
carries the API version in its base URL, and that 404 disabled discovery
silently. Then the response must carry `claude-haiku-4-5` with a 200k window and
a supported `xhigh` effort, the two values OpenCode's own models.dev entry gets
wrong. In `--live --extended` it selects `anthropic/claude-haiku-4-5#xhigh` and
requires the effort to reach the proxy; that variant is
`provider.no-route — Variant unavailable` without discovery, so a pass can only
come from the applied catalog. `--no-discovery` is the new negative control.

**A flaky assertion caught before it shipped.** The variant probe first asserted
the model emitted a literal sentinel. That was true on one run and false on the
next — same code, same host. It is now recorded but not asserted; the
deterministic facts are asserted instead (no error events, the effort observed
at the proxy, the request completing upstream). Both live hosts show
`answered` disagreeing between runs, which is exactly why.

**Validation.** `npm test` 3880 pass / 1 skip / 0 fail on bun 1.3.14, typecheck,
build. Exit codes, which are the point of this ticket:

| run | exit |
|---|---|
| `--live --extended --separate-proxy-cwd`, `0.0.0-beta-18866` | 0 |
| `--live --extended --separate-proxy-cwd`, `0.0.0-beta-18314` | 0 |
| non-live, beta-18866 | 0 |
| `--no-discovery` negative control | 0 |
| `--v1` control, pinned `opencode@1.18.11` | 0, `discoveryTrace: []` |
| one assertion deliberately broken | 1, no `PASS` printed |

Both live runs: variant selected, `effort: "xhigh"` observed at the proxy, 100%
cache reuse on ordinary continuation and process restart.
`e2e-opencode-package-integrity.mjs` passes with and without `--manifest`.
The merged tree was confirmed byte-identical to the validated tree.

**An hour lost to a bad probe, worth not repeating.** Before using the real
gate, an ad-hoc harness was built to answer "does the applied catalog actually
expose the variant?" It reported `provider.no-route` even with discovery
returning 200 and a valid catalog, which looked like a product defect in #1004.
It was not — the probe's own client/server wiring was wrong. The real gate,
which already has correct port reservation, `OPENCODE_SERVER_PASSWORD` auth and
a warm server, showed the variant working on the first try. **Reach for the
existing gate before building a probe**; if a probe contradicts a hand-verified
live result, suspect the probe.

`opencode2 models` lists model ids without variants, and `/api/provider/{id}`
and `/api/model` return empty unless the provider is fully active, so neither is
a usable catalog assertion. The tap-observed traffic is.

## Delivered: disabled subscription entitlement, contributor PR #1005 as #1012

**Item.** [PR #1005](https://github.com/rynfar/meridian/pull/1005) by
StanChmielewski — an org admin can switch Claude Code subscription access off;
the refusal named no limit and no payment method, so `classifyError` fell
through to `api_error`, `isAccountFailoverError` said no, and priority routing
kept selecting an account that could serve nothing.

**Disposition.** Accepted with one maintainer correction. Merged 2026-09-10 as
`c3dc2279` with `Co-authored-by: Stan Chmielewski <s.chmielewski@it-tower.pl>`.
Author mapping `06a44e2a` → `2b6681e5`, AuthorDate preserved; maintainer commit
`0560d4a7`. Base `3db622fa`, worktree
`/Users/rynfar/repos/meridian-wt/org-entitlement`. #1005 head rechecked as
`06a44e2a` immediately before merge, then auto-closed.

**Reproduced on main before changing anything**: `sdk result` → 500 `api_error`,
`stderr exit1` → **401 `authentication_error`**, `api 403` → 500 `api_error`,
all with `failover=false`. The 401 is the sharp edge — a bare code-1 exit reads
as an expired login, so the operator is told to run `claude login` for an
entitlement only an admin can restore.

**The maintainer correction, and the lesson.** The PR claimed to cover the
API-key/gateway shape with `API Error: 403 Your organization has disabled ...`.
That string is not what reaches `classifyError`. The CLI actually emits:

```
Claude Code returned an error result: Failed to authenticate. API Error: 403
Your organization has disabled Claude subscription access for Claude Code · ...
```

A bare `Failed to authenticate.` sits between the CLI's wrapper and the upstream
status. It ends in a period, so it is not one of the recognised colon-wrappers,
and the anchored pattern never reached the entitlement string — that path was
still `api_error` and still did not fail over. **A hand-written example of a
wire string is not the wire string.** It was found by driving a real refusal
through the failover harness, not by reading the report.

**Evidence.** Ten adversarial classification cases pass, including the negatives
`has not disabled`, a mid-line quote, `disabled MCP servers`, the authenticate
notice alone, and the notice before a different capability. Live E2E through the
#836/#829 error-telemetry harness with only the refusal fixture swapped to the
org-disabled message at HTTP 403: pinned 402 `billing_error` (streaming and not),
failover 200 from real Claude Max with the receipt, `PASS`. That harness FAILED
at the pinned assertion before the maintainer fix. Gates: `npm test` 3880 pass /
0 fail / 1 pre-existing skip, typecheck, build; CI green on all four checks.

**Limitation.** An actual org-disabled account could not be reproduced here; the
contributor's own run against one is the primary evidence for the real-world
shape, and the harness drives the refusal instead.

## Delivered: Polytoken harness adapter, contributor PR #980 as #1010

**Item.** [PR #980](https://github.com/rynfar/meridian/pull/980) by jakewimmer —
a native adapter for [Polytoken](https://polytoken.dev), an Anthropic-Messages
coding agent that owns its tool loop.

**Disposition.** Accepted in part. Merged 2026-09-10 as `3db622fa` with
`Co-authored-by: Jake Wimmer`. Base `fb06c924`, worktree
`/Users/rynfar/repos/meridian-wt/polytoken`. #980 head rechecked as `f185e76e`
before merge, then auto-closed. Author mapping, all AuthorDates preserved:
`68a0092e`→`6878e515`, `1bbf7a4b`→`64fc6e68`, `f22856f4`→`639af5e2`,
`9b7b21d4`→`dd84557e`, `0edf2c63`→`58518d61`, `76f30fa9`→`58e307a8`,
`acc0c661`→`2a878eea`. Maintainer commit `1dff13fd`.

**Three commits were split out**, all preserved with authorship on the pushed
branch `codex/polytoken-extras` — do not retype them:

- `f185e76e` uncaptured-tool recovery. The only commit that does not apply to
  current main; conflicts with #998's rework of the same early-stop region. The
  contributor states it is "default OFF until canaried" with non-streaming
  parity deferred. Tracked in **#1009**.
- `1b2ba3a9` recover visible empty capped streams, and `016eb53c` classify abort
  causes in `sdk_termination`. Both clean and green, held so each gets its own
  changelog line and its own gate; the first lands in the #983 → #996 → #998
  path. Tracked in **#1011**.

The contributor's reported "1 failed" full suite does not reproduce — that flake
was fixed by #997, now in the base.

**Maintainer correction: a gate anyone can run.** #980's E2E was a manual Docker
image swap plus a personal systemd unit and a budget gateway, driven by scripts
deliberately not committed, and it overshot its own request budget (14 against a
cap of 12). Replaced with this repository's existing mechanism: Polytoken added
to `scripts/e2e-client-detection.mjs` (honouring `E2E_POLYTOKEN_BIN`) with its
real 0.8.6 headers recorded in `client-headers.json`, so
`client-detection-fixtures` pins the adapter in CI and a client-side change is a
git diff. This is the #733 class of bug, and a PR whose detection keys on a UA
plus a native header is exactly what that fixture protects.
`x-polytoken-session` joined the redacted-value set, or every re-capture would
churn on a fresh session id.

**Evidence, live against the real client.** Polytoken 0.8.6 macos-arm64
(sha256 `71353a6d…0793e7`, verified against the published `SHA256SUMS.macos`),
installed to `/tmp/pt`, real Claude Max on `claude-haiku-4-5`, disposable
Meridian on port 3468. A `polytoken exec` client-owned read returned `LINES=4`
in **four** client round-trips, `adapter=polytoken` throughout, `lineage=new`
then `lineage=continuation` on a stable `x-polytoken-session`. The read ran on
the Polytoken side — the proxy's own workdir has no such fixture. Repeated with
`MERIDIAN_PASSTHROUGH=0`: identical, so the global setting cannot hand the loop
to the SDK. Detection controls: `PolytokenImpostor/1.0` → `opencode`, blank
header → `opencode`, valid header → `polytoken`, UA alone → `polytoken`.
Captured wire identity: `user-agent: Polytoken v0.8.6`, `x-polytoken-session`,
`accept: text/event-stream`. Gates 3871 pass / 0 fail / 1 skip, typecheck,
build; CI green.

**Behavior change to remember.** A valid `x-polytoken-session` now outranks
automatic adapter-instance match rules (#476). Explicit `x-meridian-agent` still
wins over both.

**Polytoken install, for the next run.** `https://get.polytoken.dev` shell
installer, or `https://dl.polytoken.dev/<version>/<platform>/polytoken.zip` with
`SHA256SUMS.<os>`. Config is `config.yaml` in `--config-dir`; a Meridian
provider needs `kind.type: custom_anthropic_compatible`, `protocol:
anthropic_messages`, `auth.type: static_key`, and a model entry with both
`provider` (instance name) and `provider_name` (wire id) plus a `class`.

## Delivered: OpenCode V2 model discovery, contributor PR #1003 as #1004

**Item.** [PR #1003](https://github.com/rynfar/meridian/pull/1003) by
martinmiglio — read Meridian's `/v1/models` from the V2 plugin and write the
result into OpenCode V2's model catalog.

**Disposition.** Accepted with maintainer corrections. Delivered as
[PR #1004](https://github.com/rynfar/meridian/pull/1004), squash-merged
2026-09-10T14:46Z as `7028c697` with
`Co-authored-by: Martin Miglio <marmig0404@gmail.com>`. #1003 auto-closed at the
same second; its head was still `a6657962`, rechecked immediately before merge,
so no later contributor work was discarded.

Base `a1f04df6`. Branch `codex/opencode-v2-model-discovery` (deleted on merge),
worktree `/Users/rynfar/repos/meridian-wt/v2-model-discovery`. Author mapping:
`a6657962` → `9a25b773`, Author and AuthorDate (2026-09-02) preserved.
Maintainer commits `b98de38f`, `50b16f3c`, `a63b27a2`.

**Half the PR was already on main.** #1003 also packaged the V2 plugin as a
directory package. #988 landed that first, byte-for-byte for
`plugin/meridian-v2/`, plus a generalized `scripts/package-opencode-plugins.mjs`
covering V1 too. #1003 branched from `1ea97d01` and predates it, which is why it
was `CONFLICTING`. That half was dropped as superseded during the cherry-pick.

**The discovery half did not work, in two independent ways.** Both were found
live against the pinned `opencode2 0.0.0-beta-18866`, not by reading the diff.

- V2's Anthropic provider carries the API version in its base URL, so
  `http://127.0.0.1:3466/v1` was turned into a request for `/v1/v1/models`. That
  path answers 404 and `/v1/models` answers 200, so the fetch always failed.
- The skip guard read `catalog.provider.get(id).models` and treated a hit as
  user configuration. Inside a transform that map is the assembled models.dev
  catalog, which already lists all nine models Meridian serves — so every model
  was skipped even once the URL was fixed.

**What made the second fix safe, and it is worth remembering.** V2 layers
`providers.<id>.models` on top of plugin transforms. Verified directly: a
configured `claude-opus-5` override (`name: "USER OVERRIDE"`, context 12345)
survived a transform that wrote a different name and context to the same model,
while a model the user had not configured took the transform's value. A plugin
can therefore write authoritative values without clobbering user overrides — the
opposite of what #1003 assumed.

That correction matters beyond the variants: beta-18866 advertises a 1M Sonnet,
while Meridian deliberately serves Sonnet at 200k so a long turn is not billed
as Extra Usage.

**Evidence.** Same isolated config, Meridian unreachable versus reachable:

```
unreachable (= the pre-fix result)
  claude-sonnet-5    ctx=1000000  ['none','low','medium','high','xhigh','max']
  claude-haiku-4-5   ctx=200000   ['high','max']
reachable, fix applied
  claude-sonnet-5    ctx=200000   ['low','medium','high','xhigh','max']
  claude-haiku-4-5   ctx=200000   ['low','medium','high','xhigh','max']
  claude-sonnet-4-5  ctx=1000000  ['high','max']   <- not served by Meridian, untouched
```

Live E2E: `opencode2 0.0.0-beta-18866` (installed to `/tmp/oc2pin`, not the
user's global `~/.local/bin/opencode2`, which had self-updated to 19242 and is
outside the supported set), Meridian from source on isolated port 3466 with an
isolated session store, isolated `OPENCODE_CONFIG_DIR` and all four `XDG_*`
dirs, real Claude Max (`max`, profile `work`). Through a logging tap in front of
the proxy, `--model 'anthropic/claude-haiku-4-5#xhigh'` produced
`POST /v1/messages?beta=true model=claude-haiku-4-5 effort="xhigh" stream=true`
→ 200, and Meridian logged `agent=primary model=haiku` with
`source=subagent-title` detached separately. Negative control with the base URL
on a dead port: catalog untouched, nothing logged as an error.

Gates at head `a63b27a2`: `npm test` 3803 pass / 0 fail / 1 pre-existing skip
(bun 1.3.14), `npm run typecheck`, `npm run build`. CI green on `test`, `smoke`,
`windows-smoke`, `build-push`; `changelog-duplication` skipped. Failed-before /
passed-after retained for both new plugin regressions.

**Known limitation, documented in `docs/agents.md` and accepted by the owner.**
Discovery cannot read the catalog until OpenCode has assembled it — awaiting
`context.catalog.provider.get()` inside `setup` deadlocks the server, confirmed
by a probe plugin that hung the process with no output. So the first request
against a freshly started server still sees the built-in entries, and naming a
Meridian-only variant there (`anthropic/claude-haiku-4-5#xhigh`) fails with
`provider.no-route`; the next request succeeds. Reproducible, not intermittent.
The TUI picker is unaffected because it renders after discovery lands.

No OpenCode release fixes this. `@opencode-ai/plugin@0.0.0-beta-19271`, the
newest published beta, still declares `Transform` with a synchronous callback
(`CatalogDraft` merely renamed to `CatalogEditor`) and still exposes no config
domain. Closing the race would need a persisted catalog cache seeded during
setup — a separate design decision, not started.

**Also fixed while validating this.** `docs/agents.md` documented a V1-shaped
provider block for the V2 section. V2 reads `providers` and `settings`;
`provider` and `options` are silently ignored, which points the client at the
real Anthropic API instead of Meridian. The base URL also needs its `/v1`
suffix. The same section listed only beta-18314 while
`SUPPORTED_OPENCODE_V2_VERSIONS` accepts 18866 as well.

**Next action.** None outstanding for this item. 1.69.0 is published and a
release for `7028c697` needs its own explicit authorization.

## Delivered: OpenCode Desktop cannot load the V1 plugin, PR #988

Maintainer-originated fix, not a contributor PR. Owner-reported: OpenCode
Desktop on macOS could not use Meridian after a normal `meridian setup`.

Base `d3bfe795`, branch `codex/ship-compiled-opencode-v1-plugin`, worktree
`/Users/rynfar/repos/meridian-wt/opencode-v1-compiled-plugin`, delivery commit
`12ae3f74`. Disposition: accept as maintainer fix. **Rebased onto `ac8bd6c2`
and revalidated before merge** (3775 pass / 1 skip / 0 fail on bun 1.3.11,
typecheck, build, tarball rebuilt); merged as `d075cc7c`. No external
contributor is involved, so no author mapping or co-author trailer applies.

Cause: `findPluginPath` returned `plugin/meridian.ts` for every install. The Bun
CLI loads TypeScript, but OpenCode Desktop (`ai.opencode.desktop` 1.18.23,
Electron 42 / Node 24) runs the OpenCode server in-process under Node and ships
no Bun binary; its native modules are Node-ABI. Node refuses type stripping
under node_modules, so an installed package wrote a path the desktop client
cannot import: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Relocating the
`.ts` does not help either — `plugin/meridian.ts` imports
`./priority-attestation` without an extension, which is `ERR_MODULE_NOT_FOUND`
under Node ESM. OpenCode's loader dynamic-imports the spec with no
transpile step.

**Correction to an earlier version of this note.** It said the loader
"resolves a file spec to `pathToFileURL(...)`" full stop. That is only true for
a FILE spec. For a directory it reads the directory's `package.json` and
imports its `main`: `resolvePathPluginTarget` returns the directory URL when a
`package.json` exists, `readPluginPackage` reads it, `resolvePackageEntrypoint`
takes `packageMain(pkg)` for kind `server`, and `resolvePackagePath` returns
`pathToFileURL(join(dir, main)).href`. Read out of the Desktop server bundle
(`app.asar` → `out/main/chunks/node-BOFfwe6w.js`). This matters: a probe that
imports the bare directory gets `ERR_UNSUPPORTED_DIR_IMPORT` and reports a
false failure for a plugin that actually loads. That happened here before the
loader was read.

### Verified against the desktop runtime

#988 was already green and validated live against the OpenCode 1.18.29 Bun CLI,
but carried a recorded limitation: "not yet exercised through the OpenCode
Desktop GUI". That is now closed without a click-through, and the method is
worth reusing.

**OpenCode Desktop runs its server in an Electron utility process, not a Bun
sidecar.** `app.asar` → `out/main/sidecar.js` takes a `process.parentPort`
message, `await import("./chunks/node-BOFfwe6w.js")`, then `Server.listen(...)`.
No spawned `opencode` binary, so the plugin is loaded by Electron's bundled
Node — which is the premise the PR rests on, now verified rather than assumed.

**How that server resolves a directory plugin**, read out of the same bundle:
`resolvePathPluginTarget` returns the directory URL when the directory has a
`package.json`; `readPluginPackage` reads it; `resolvePackageEntrypoint` takes
`packageMain(pkg)` for kind `server`; `resolvePackagePath` returns
`pathToFileURL(join(dir, main)).href`. So the shim's `"main": "./index.js"` is
precisely what makes `dist/meridian` importable — and a probe that imports the
bare directory reports a false `ERR_UNSUPPORTED_DIR_IMPORT`. Mine did, before I
read the loader. Read the loader.

Replicating that resolution against an installed tarball:

```
runtime node=22.22.3 electron=none            (plain Node)
  OLD (plugin/meridian.ts)   => FAILED: ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
  NEW (dist/meridian)        => LOADED via meridian/index.js, default is function: true

runtime node=24.15.0 electron=42.3.3          (OpenCode Desktop 1.18.30's server runtime)
  OLD (plugin/meridian.ts)   => FAILED: ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
  NEW (dist/meridian)        => LOADED via meridian/index.js, default is function: true
```

Rebased onto `ac8bd6c2` and revalidated: 3775 pass / 1 skip / 0 fail, typecheck
and build clean, tarball rebuilt.

Still open on that item: `isMeridianEntry`'s `endsWith("/meridian-v2")` is
POSIX-separator-only, so source-install detection on Windows is a pre-existing
gap, deliberately left out of scope.


Fix mirrors the existing V2 shape: `plugin/meridian/` shim package compiled to
`dist/meridian/`, `findPluginPath` mirroring `findV2PluginPath` (source keeps
source, installed selects compiled, fail closed), `MissingV1PluginError`,
shared `hasPluginPackageEntry`, generalized
`scripts/package-opencode-plugins.mjs`, and `node --check dist/meridian/index.js`
in postbuild. Detection still matches legacy `meridian.ts` entries so older
installs keep reporting configured.

Proof, from an independently packed and installed tarball:
old path `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, new path imports with a
function default. `meridian setup` from that installed CLI writes
`node_modules/@rynfar/meridian/dist/meridian`.

Live E2E: OpenCode 1.18.29, `claude-opus-4-6`, isolated proxy port 3466,
isolated `XDG_CONFIG_HOME` and workdir, plugin loaded from the installed
tarball. Returned the expected sentinel; proxy recorded
`agent=primary model=opus[1m]` and `agent=subagent model=haiku`, no pluginless
warning. Gates: `npm test` 3713 pass / 0 fail / 1 pre-existing skip, typecheck,
build. All PR #988 checks green at head `12ae3f74`, mergeState CLEAN.

NOT YET DONE — do not merge until this is closed: no run through the OpenCode
Desktop GUI itself. The desktop runtime constraint is proven by the Node import
reproduction, not by a click-through. The desktop app would not stay running
when launched from the agent shell (`Contents/MacOS/OpenCode` is a launcher stub
and `open -a` did not survive), and screen capture is unavailable, so this needs
the owner to launch the app and send one message while watching for
`agent=primary` in the proxy log.

Unrelated observations from the same session, not addressed here: the OpenCode
client stalls on a repeating design-MCP OAuth discovery loop against the proxy
(`/.well-known/oauth-*`, `POST /register` logged as UNHANDLED); and
`isMeridianEntry`'s `endsWith("/meridian-v2")` is POSIX-separator-only, so V2
source-install detection on Windows is a pre-existing gap.

## Delivered: issue #967 triage, delivered as PR #969

**Item.** [Issue #967](https://github.com/rynfar/meridian/issues/967) —
"Passthrough tool forwards are undeliverable for headless bg-job subagents →
compounding respawn loop", reported by filipporovelli against 1.68.0.

**Disposition.** Accepted in part, as a maintainer fix from triage. Triage found
a real and distinct Meridian defect that produces the reported symptom exactly,
and it is fixed in
[PR #969](https://github.com/rynfar/meridian/pull/969) (branch
`codex/fix-oc-prefixed-client-tools`, worktree
`/Users/rynfar/repos/meridian-wt/oc-prefixed-client-tools`). Base
`38c1db2b25de70be873f4b1b6436334566107bff`; delivery commits
`4646b932` (fix + tests), `8ec39e41` (E43 gate + E2E.md), `6823b687` (this
checkpoint) and `9447f8a7` (doubled-name hardening). No contributor commits exist for
this item, so there is no cherry-pick author mapping; the reporter is credited
in the PR body. **#967 is NOT resolved and must stay open** — see below.

**The defect that was fixed.** Client tools are registered inside Meridian's own
`oc` MCP server, so a client whose tool names already start with `mcp__oc__` —
a Claude Code CLI job with an `oc` MCP server configured, for instance —
collides with that namespace. Registration advertised
`mcp__oc__mcp__oc__read`, which SDK 0.2.141 / CLI 2.1.263 lists but never
dispatches: the PreToolUse hook never fired, nothing was captured
(`tools=0/1`), non-streaming returned HTTP 500, and streaming ended
`stop_reason: max_tokens` with an inline `error` event while leaking a tool_use
the blind reverse strip had renamed to `read`. Fixed by registering colliding
tools under a collision-free alias and reversing through an explicit map.
Ordinary tool sets alias to themselves, so model-visible names and the prompt
cache are unchanged. Only the exact `mcp__oc__` collision was affected; a
foreign `mcp__*` namespace was and remains fine.

**Two of the issue's inferences were refuted. Do not chase them again.**

- A nested SDK transcript terminating at the forward stub is the **designed
  steady state** of every passthrough tool step, on every client — not evidence
  of a stall. `PASSTHROUGH_DENY_REASON` has exactly one call site, inside
  Meridian's own PreToolUse hook, and is never sent to a client as a
  `tool_result`; Meridian then resumes the checkpoint with `forkSession`, so the
  denial branch is deliberately dead history. E41 already asserts the active
  fork holds exactly one real answer and zero denials per delivered call. The
  issue's "18 of 20 newest transcripts terminate at the forward stub" therefore
  describes Meridian's own nested sessions.
- The compounding "strict prefix-extension" replay is
  [#767](https://github.com/rynfar/meridian/issues/767)'s signature: a fresh
  replay opens a new SDK session, hence a new transcript that is a
  prefix-extension of the last.

  **This bullet originally claimed the trailing-block shape was still unfixed
  on main via `hasOnlyNewToolResults`. That was wrong.** That symbol no longer
  exists: `9d283288` (2026-09-04, shipped in 1.68.0, incorporating #872 with
  Serge Baranov's credit) replaced it with `appendedBlocksAreNew`, which
  permits non-`tool_result` blocks appended to a slot that is already a
  tool-result turn. Verified directly against main: `user[tool_result,text]`
  returns `continuation`, and a plain `user[text]` turn gaining appended text
  returns `diverged / modified-history` by deliberate design ("the user edited
  their own turn").

  **Process lesson worth more than the fact:** the error came from reading
  `src/proxy/session/lineage.ts` out of the owner's checkout, which sits on a
  divergent feature branch (`237acbf7`, not an ancestor of main), and then
  asserting it as main's state. Read source for a claim about main from a
  worktree on main, or via `git show origin/main:<path>`; `git log -S <symbol>`
  settles when a rule changed in seconds.

The respawn decision itself is above Meridian — the reporter's own job records
show `respawnFlags: []`.

**Validation.** `npm test` 3624 pass / 0 fail / 1 pre-existing skip;
`npm run typecheck` and `npm run build` clean. Failed-before/passed-after on the
same assertions: `src/__tests__/proxy-passthrough-oc-prefixed-tools.test.ts`
fails 6/8 on the parent commit (delivering `read` and `read_2` where
`mcp__oc__read` was declared) and passes 8/8 with the fix; the 2 that pass
either way are the no-regression controls. New **E43** live gate
(`scripts/e2e-passthrough-namespaced-tools.mjs`) passed all four combinations —
haiku and `claude-opus-5`, streaming and non-streaming, subject plus an ordinary
and a foreign-namespace control. **E41 all four modes** (chain/parallel ×
stream/non-stream) PASS. Post-fix live accounting shows `captured=1` and
`sdk_termination_recovered` where the same probe previously logged `tools=0/1`
with `envelope=open`. Versions: SDK 0.2.141, bundled Claude Code 2.1.259, system
CLI 2.1.263, OpenCode 1.18.29, Node v22.22.3, macOS arm64.

The Opus E43 runs were made before `9447f8a7`, which only changes names
carrying two or more leading copies of the prefix — a shape the gate does not
exercise and whose single-prefix behavior is byte-identical. E43 was re-run on
haiku in both modes after that commit and stayed green.

**Known limitations and next action.**

- Attribution of the reporter's incident to this defect is **not established**,
  and is now actively doubtful. `opencode-with-claude` 1.10.1 was unpacked from
  npm and checked rather than assumed: ~7.7 KB, one exported OpenCode `Plugin`,
  no `mcp__` strings, no MCP server registration, no `child_process`/`spawn`,
  no task/subagent bridging. It starts Meridian and resolves profiles. So it
  does not bridge subagents to bg jobs as the report assumes, and the `oc`-named
  MCP server in that environment is Meridian's own passthrough registration —
  meaning the transcripts sampled there are Meridian's nested sessions.
  Findings and a correction were posted to #967; nothing was asked of the
  reporter. Determining a contributor's environment is our job, not theirs.
- #967 stays open. Closing it needs both the attribution above and #767's
  replay driver.
- #893 (the `oc` namespace ignoring `getMcpServerName()`) stays open and is
  untouched. If it lands, `buildPassthroughToolAliases` and the
  `passthroughEarlyStop.ts` prefix mirror must follow the same value.
- A pre-existing gap deliberately left alone: `isClientForwardedToolUse` treats
  a bare `mcp__*` name as an internal SDK tool, so a foreign-namespace client
  tool would not arm the early-stop tracker if the SDK emitted its bare form.
  It does not today; the E43 foreign-namespace control passes in both modes.
**Merge and closure status (verified after the fact).** PR #969 reached green
final-head CI on `3a83560d2af620b92ec176eddead25e442c2b192` (`test`, `smoke`,
`windows-smoke`, `build-push` success; `changelog-duplication` skipped) and was
squash-merged with `--match-head-commit` on that verified head as
[`282cbb0b`](https://github.com/rynfar/meridian/commit/282cbb0bd314b935195dc40bc209acb07131dfe0).
The merged tree `b3a853a0830bc227bdbb47948672e00a4989a99d` is byte-identical to
the validated tree, the squash body is blank and the subject is the PR title, so
the `PR_TITLE` / `BLANK` settings are intact. Post-merge CI on main was green
across `test`, `smoke`, `windows-smoke`, `build-push`, `changelog-duplication`
and `release-please`, with `docker` and `publish` correctly skipped. The
delivery branch `codex/fix-oc-prefixed-client-tools` was deleted; the worktree
was retained.

**Issue #967 is OPEN and must stay open.** It was auto-closed on merge and then
reopened. Cause worth knowing before writing another PR body: that body's
limitation line paired a closing keyword with the issue number in order to deny
it, and GitHub's closing-keyword parser does not read negation — it linked that
as a closing reference. **Never put a closing keyword next to an issue number
in a PR body or commit message, even to deny it**; write "issue NNN stays open"
instead. This paragraph deliberately does not quote the offending phrase, since
a verbatim copy carries the same hazard wherever it is pasted. Verify with
`grep -niE '(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+#[0-9]+'` before
merging. The bodies have been corrected.

**Two fresh data points for #917 / #933, both timeout expiries rather than
logic failures.** Collected incidentally: each appeared on a *docs-only* diff
that cannot influence it, which is what makes them clean observations.

| where | test | duration | mechanism |
|---|---|---|---|
| `windows-smoke` | `process-incarnation.test.ts:123` | 10265 ms | `WINDOWS_PROBE_TIMEOUT_MS` is 10 s. The `powershell.exe` probe in `src/proxy/session/processIncarnation.ts` exceeded it, so `captureProcessIncarnation()` **failed closed and returned `undefined`** — which is the module's documented behavior — while the test asserts the capture is always defined on win32. |
| `test` | `failover-request-id.test.ts:76` | 5002.97 ms | No explicit `it` timeout, so bun's default 5 s applied and expired. An assertion failure would not land on the default boundary to the millisecond. |

Both went green on a later run of the same tree, so they are intermittent, not
newly broken. #917 describes "concurrency tests fail fast, never the same one
twice" — a pool of tests with fixed time budgets on a contended runner produces
exactly that: whichever one is unlucky trips, so the name changes every time.

This is a **candidate mechanism for part of** #917 / #933, not a proof of all of
it, and no frequency has been measured. Two distinct sub-problems if picked up:

- The incarnation test asserts something the module may legitimately not
  provide. That is a genuine test defect and should be corrected by accepting a
  fail-closed capture, not by widening the probe timeout.
- The failover test simply lacks a CI-realistic timeout.

Resist the reflex to loosen assertions across the suite to make CI quiet; that
would mask the concurrency failures #917 is actually about. Start by measuring
which tests run closest to their budget.

**Release Please opened [PR #970](https://github.com/rynfar/meridian/pull/970)
(`chore(main): release meridian 1.68.1`) automatically.** It is NOT authorized
by this review and was not merged. A release needs the owner's explicit
authorization and the release reference in the skill.

**New lead found while landing this checkpoint: `windows-smoke` is
intermittently red for a characterizable reason.** On the checkpoint PR — a
docs-only diff that cannot influence it — `windows-smoke` failed at
`src/__tests__/process-incarnation.test.ts:123`, with
`captureProcessIncarnation()` returning `undefined` after **10265 ms**. That
duration is exactly `WINDOWS_PROBE_TIMEOUT_MS` (10 s) in
`src/proxy/session/processIncarnation.ts`, whose Windows path shells out to
`powershell.exe` via `spawnSync`. The test's own comment budgets "two cold
PowerShell probes at up to 10s each" under a 25 s test timeout.

So the module did what it is designed to do — fail closed when the host probe
is uncertain — while the test asserts the capture is *always* defined on
win32. On a cold or contended GitHub Windows runner the probe exceeds its
timeout and the assertion fails. This is a test-strictness problem, not a
proven product defect, and it is a concrete candidate mechanism for part of
#917 / #933 ("intermittent CI failures", "flaky ~1 in 3").

Scope and honesty limits: this is **one** observation, not a measured
frequency, and it does not explain the concurrency-test failures #917
describes. `windows-smoke` was green on `3a83560d` and on main's `282cbb0b`
immediately before, so it is intermittent rather than newly broken. No fix was
attempted here — that is a separate bounded item, and it should start by
reproducing the timeout rather than by loosening the assertion.

- **Next action:** the remaining issues, in this order of tractability —
  **#861** (auto-defer threshold invalidating the prompt cache mid-session:
  #975 turned auto-defer off for Codex only, the general case stands),
  **#889** (`extractClientCwd` parsing an `<env>` block a plugin may legally
  remove), **#865** (suppressing one startup log, small), then **#820** (pi
  adapter divergence, the highest user impact and the least diagnosed).
  **#895** has a contributor patch in PR #896 that cannot be validated here: a
  real Windows E2E is impossible on this macOS host, and POSIX fixtures are not
  a Windows run. **#769** and **#650** are feature/infra asks needing a product
  decision. Issues **#967** and **#767** are carried with their evidence
  recorded; neither reproduces on main from here. The 21 open `feat` PRs still
  need a product decision each.

## Investigated: #767 does not reproduce live on main

Ran the original report's own recipe against main (`a0ee33f2`) rather than
reasoning from code: real `opencode` 1.18.29 → real Meridian on an isolated
port, isolated `XDG_*`/config/session-store/project dirs, `claude-opus-5`,
genuine read/edit/write/bash tool use, one continuous session per config.

| config | plugins | turns | msgs | opus lineage | `Stale session detected` |
|---|---|---|---|---|---|
| stock | Meridian only | 12 | 49 | 24 continuation / 1 new | 0 |
| plugin stack | + oh-my-openagent, opencode-memory, opencode-worktree, opencode-history-search, openslimedit | 7 | 31 | 15 continuation / 1 new | 0 |

The lone `new` in each is that session's first turn. Zero divergence
diagnostics fired. Cache shape is inverted from the report's fresh-replay
signature — `cacheRead` climbs with the transcript while `cacheCreation` stays
in the low hundreds per turn:

```
stock         cacheCreation  31,199   cacheRead   367,589   ratio 11.8x
plugin stack  cacheCreation  95,707   cacheRead 1,630,777   ratio 17.0x
```

The plugin stack pinned ~67.6k of cache-read on turn one, close to the report's
~54.5k, which is the evidence the stack was genuinely loaded and shaping the
prompt rather than silently absent.

Consistent with `9d283288` (in 1.68.0) having addressed the mechanism:
connor-grady's captures were on 1.62.7, and four of their six were the
`user[tool_result,text]` shape that `appendedBlocksAreNew` now permits. It also
fits tetipong2542's own correction that Opus alone was 82% clean and the failure
required a plugin interaction.

**Do not read this as resolved.** Bounded by: session scale (49 and 31 messages
versus overlaps of 776–797 in the captures); agent profile (default agent, not
oh-my-openagent's "Sisyphus - ultraworker", which drives far longer reasoning);
`opencode-pty` and `opencode-quota` not installed; and one run per config, which
is not a measured rate. Evidence and these limits were posted to #767, which
stays open. Nothing was asked of the reporters — reproduction is our job.

Reproduce with: `/tmp/e767` (stock) and `/tmp/e767b` (plugin stack) harness
layout, Meridian on ports 3499 / 3498. Both are disposable; recreate from the
recipe rather than trusting leftover dirs.

## Delivered: the Codex contributor cluster (#962-#966), all by @justprosh

Five contributor PRs, each cherry-picked with Author/AuthorDate preserved, each
with a separate maintainer commit where live validation demanded one, and each
carrying an explicit `Co-authored-by` trailer in the squash body.

| original | integration | on main | disposition |
|---|---|---|---|
| #962 tier refusal ending in prose | #974 | `94e88cf0` | merged, original closed |
| #963 Codex auto-defer | #975 | `dabd969b` | merged, original closed |
| #964 namespace/custom tools | #976 | `907a00ee` | merged, original closed |
| #965 thread session identity | #977 | — | OPEN, held for owner review |
| #966 mid-conversation developer message | #978 | `4a031b97` | merged, original closed |

**Credit mechanics matter here and are easy to get wrong.** Repository settings
are `PR_TITLE` / `BLANK`, so a plain squash **drops the cherry-picked author
entirely**. Every merge above passed
`--body "Co-authored-by: Aleksey Proshutinskiy <alexey.prosh@fluence.one>"`.
Verify that trailer on the resulting commit; do not assume it appears.

The inverse error also happened once and was caught: a maintainer gate commit
created immediately after a multi-commit cherry-pick **inherited the
contributor's author line**. Falsely crediting a contributor for maintainer test
code is the same class of fault as dropping their credit. Check
`git log --format='%an'` over the series before pushing.

**Two contributor branches track a `node_modules` symlink** pointing at
`/Users/aleksei/dev/meridian/node_modules` (#963 `b9bca255`, #964 `432bead6`).
Both authors' own follow-up commits remove it, so their heads are clean, but
cherry-picking *through* the middle commit replaces a local install with a
dangling link. It happened once here. Only final commits were incorporated where
possible, and main is unaffected.

**Live validation added five gates**, all real proxy plus real SDK: E44
tier-refusal failover, E45 Codex auto-defer, E46 Codex namespace/MCP round-trip,
E47 Codex thread identity (on the #977 branch, not yet on main), E48 Responses
developer-note cache.

**Where live E2E changed the outcome rather than confirming it.** Twice:

- The #962 change was correct for the banner as quoted but insufficient for the
  deployment it was reported from. A gateway profile never delivers the banner
  bare — the SDK splices `API Error: 400` in front, and that numeric status
  defeated the line anchor for every suffix, including the two that already
  worked. `classifyError` returned 429 for the bare string while a live request
  still 500'd. A separate maintainer commit allows exactly three digits.
- A real Codex capture showed the #964 report was understated: the dropped
  namespaces include Codex's own `multi_agent_v1`, so sub-agents were
  unavailable, not only user MCP servers.

**Two of my own gates initially proved nothing and were corrected before
landing.** Recorded because the failure mode is seductive — a check that passes
both before and after looks like evidence. E45's digest-turn count passes either
way at probe scale, so it is reported rather than asserted. E48's first version
asserted cache hit percentage, which barely moves in a 6.5k probe even when the
prefix is re-written; the invariant is the ratio of re-written tokens, 7.8x
pre-fix against 1.2x after. Always confirm a new gate fails against pre-fix
code.

**Verifying contributor claims by capture rather than by reading.** codex-cli
0.153.4 was driven against a recording endpoint under an isolated `CODEX_HOME`
with a real stdio MCP server. That settled the tool shapes
(`{"function":10,"namespace":2,"web_search":1}`), the metadata schema, and the
critical safety property behind #965: for a user-driven thread `thread_id`
equals `prompt_cache_key`, so keying on the thread cannot re-anchor an existing
session. Reproduce with the recipe in E2E.md E46 and E47.

**PR #977 is held, not blocked.** Green on everything: 3665 tests, E47's nine
checks, E41 all four modes, and E46 still 8/8 alongside it. Two honest gaps: a
genuine `thread_source: subagent` request could not be produced locally
(`codex exec` offers `multi_agent_v1.spawn_agent` but does not spawn, so it needs
Codex Desktop), and two of E47's nine checks are guards rather than
discriminators. Its conflict resolution against #976 also merits a second
reader: both conflicting regions were purely additive and both blocks were kept.

## Delivered: issue sweep

Ten issues addressed, each proven live before merge. Eight are now closed, two
(#917 and #933) left open deliberately.

| issue | PR | on main | note |
|---|---|---|---|
| #886 lineage mismatch diagnostic | #981 | `c3ea178b` | closed |
| #874 `max_tokens` not enforced | #982 + #984 | `15529b12`, `14fc9395` | closed, opt-in |
| #893 `mcp__oc__` on every adapter | #983 | `99fc2d7a` | closed |
| #917 / #933 CI flakiness | #986 | `d3bfe795` | left OPEN |
| #906 `/health` lies | #985 | `264cfc3a` | closed |
| #905 container `hostId` | #987 | `b5f73aed` | closed |
| #861 auto-defer flip mid-session | #991 | `68c0eca6` | closed |
| #889 degraded fingerprint invisible | #992 | `824bbbfa` | closed |
| #865 startup banner under MERIDIAN_QUIET | #993 | `0e773b56` | closed |
| #842 + #847 first-turn 400 | none | none | closed on evidence, no code change |

**#842 and #847 were retired on evidence rather than code.** Five fresh
real-OpenCode sessions on current main: 0 client-side 400s, 0 proxy
`session_turn_conflict`, and a maximum `sessionWait` of **7 ms** against the
6360 ms the report measured. The title agent now runs as `agent=subagent` with
its own key, so the collision those reports describe cannot occur — the #845
agent-scoping work already handled them. Limit stated on both: haiku for primary
and small; an Opus primary could not be dispatched under the isolated config.

**Three new Docker-based gates**, which this repo had none of before. E51 (boot
identity) and E52 (host identity) reproduce failures that are properties of the
HOST and unreachable from a single process; both skip cleanly without Docker and
cost no tokens. `oven/bun:1-slim` ships with no `/etc/machine-id`, which is
issue #906's environment verbatim.

**Where proving it changed the answer rather than confirming it.** Three times:

- Issue #874: the SDK exposes no output cap at all, and the CLI's
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` **throws** instead of truncating. Wiring it
  naively converts a satisfiable request into a hard error. It works only
  because the API really stops generating first — probed at a cap of 64, the
  turn produced real text and *then* threw.
- Issue #874 again: enforcing it broke the E44 gate at `max_tokens: 128`,
  because the cap counts thinking plus text. An A/B against pre-change source
  confirmed the regression was mine, which is why it shipped **off by default**.
- Issue #906: the first revision refused to start on the first failed probe.
  That is right for Linux, where identity is read from files, but darwin and
  win32 derive it from a subprocess with a 10s budget — and a 10265 ms expiry
  was recorded on Windows CI during this very run. Refusing on a transient
  timeout would turn a slow host into a dead one, so startup retries three times
  first.

**Issues #917 and #933 stay open on purpose.** Two sightings were diagnosed and
corrected — both time-budget expiries, and `failover-request-id` measured at
**4.05 s against bun's 5 s default**. A scan of every I/O test without an
explicit timeout found no other single test near the boundary. But neither is a
concurrency test, and #917 is specifically about concurrency tests failing fast
and never the same one twice. **Do not widen timeouts across the suite** to
quiet CI: that would mask exactly what #917 is about.

**Gate quality discipline, because it bit repeatedly.** Four gates written this
session initially asserted something that passed both before and after the
change, which reads as evidence and is not:

- E45's digest-turn count (now reported, not asserted).
- E48's cache **hit percentage** — barely moves in a 6.5k probe; the invariant
  is the **ratio of re-written tokens**, 7.8x pre-change against 1.2x after.
- E49's default-off check used an absolute token threshold; now relative to the
  capped run.
- E44 asserted the model echoed a receipt verbatim and was flaky at ~1 in 3.
  Instrumented: the model complied once in five runs while the fallback answered
  every time. It now asserts the fallback produced text.

**Always confirm a new gate fails against pre-change source.** Every gate above
has its measured before/after recorded in E2E.md.

## Delivered: issue #820, both halves

**Item.** [Issue #820](https://github.com/rynfar/meridian/issues/820) — "pi
adapter: 99.8% of long conversations diverge to `lineage=new` with no
diagnostic", reported by @odfalik, with independent reproductions from
@RobertoNegro and a second adapter's case from @StanChmielewski, plus a
structural analysis of the missing diagnostics from @connor-grady.

**Disposition.** Accepted, delivered as two maintainer PRs. No contributor
commits existed, so there is no cherry-pick author mapping; all four are
credited in the PR bodies and three carry `Co-authored-by` trailers on the
diagnostic commit (their extension code ships in the docs, and the
request-line design is @connor-grady's proposal).

| PR | on main | what |
|---|---|---|
| [#994](https://github.com/rynfar/meridian/pull/994) | `ac8bd6c2` | every divergence names itself; the bypass advice; docs; gate E54 |
| [#995](https://github.com/rynfar/meridian/pull/995) | `7375351` | the gateway-fronted Claude Code exemption; gate E55 |

#994 was based on `0e773b56`; #995 was rebased forward twice as main moved and
merged from `d075cc7c`. Worktrees
`/Users/rynfar/repos/meridian-wt/lineage-divergence-reasons` and
`/Users/rynfar/repos/meridian-wt/passthrough-cc-session`; the before-code
baseline is `/Users/rynfar/repos/meridian-wt/divergence-reason-baseline`
(detached at `0e773b56` — do not delete, it is the failed-before evidence).

**#994 — the diagnostic half.** The request line now carries `diverged=<reason>`
on every divergence, and `independent-request` names which of its four rules
fired. `isIndependentSession` is *derived* from the new pure
`independentRequestCause` rather than computed beside it, so the printed label
cannot drift from the decision it explains. `classifyLineage` also names
`unverifiable`, `replayed-request` and `unrelated-history`; `not-found` stays on
the request line only, because it is the first turn of every conversation. The
headerless tool-result bypass warns once per process, matching the
degraded-fingerprint precedent.

`diverged=` is a separate field rather than a wider `lineage=` value on purpose:
`e2e-passthrough-turns.mjs` and field log analysis match
`lineage=<value> session=` as one unit, and a test pins that adjacency.

**#995 — the gateway half.** The tool-loop exemption follows the *client* now,
not the adapter: `adapterBase === "claude-code" || isClaudeCodeClient(c)`, where
`isClaudeCodeClient` reads `x-claude-code-session-id`. Behind LiteLLM the
passthrough heuristic claims the request first, so Claude Code lost the
exemption, and LiteLLM does not forward `x-litellm-session-id` upstream on the
`anthropic/` provider route, so it had no key either.

**The live gate changed this fix — read this before revisiting it.** The obvious
change was to read `x-claude-code-session-id` as a session key in
`passthroughAdapter.getSessionId`. That was built first, and the header is
genuine: verified against Claude Code 2.1.266 that it is the CLI session UUID,
pinned exactly by `--session-id`. Driving the **real CLI** showed it makes
auxiliary requests under the same session id, so two unrelated first messages
land under one key — `unrelated-history`, then `HTTP 400 This session advanced
while the request was waiting`. That converts a silent inefficiency into a hard
client failure. Two of E55's ten checks exist solely to guard that approach.
Suggestion 2 from the report (routing on the header in `detect.ts`) was declined:
it would swap tool handling, MCP naming and prompt shape for every existing
LiteLLM user and move their cache prefix.

**Evidence.** `npm test` 3765 pass / 1 skip / 0 fail for #994 and 3775 / 1 / 0
for #995, both on bun 1.3.11 to match CI; typecheck and build clean; E41 all
four modes on both; E54 and E55 pass. Failed-before runs are recorded in each PR
body with the exact assertion output.

**Gates added.** E54 `e2e-lineage-divergence-reason.mjs` — a real headerless pi
tool loop against the same loop with `x-session-affinity`, asserting that no
divergence is silent and that the remedy the log names works. It reproduces the
report's cache signature at probe scale: `cache_read` pinned at 5789 while the
conversation grows against 6562 → 6811 → 6919 when keyed, and a per-round
cache-write ratio of 6.5x-7.2x across three runs. E55
`e2e-passthrough-claude-code-session.mjs` — the **real Claude Code CLI** as the
client against a passthrough Meridian, skipping cleanly when `claude` is absent.

**Two things E54 taught that are not in the report.** A headerless passthrough
loop recovers through the durable checkpoint *exactly once*: the checkpoint
upgrade rewrites the lineage result but leaves the request independent, so the
end-of-turn store is skipped and the checkpoint never advances past the first
tool call. That explains the reporter's 10 continuations against 6,019 `new` at
1000+ messages. And the bypass cannot be safely relaxed to "resume when lineage
verification passes": several identical concurrent loops match at the prefix,
which is the collision the guard exists to prevent.

**Found while validating, and it was ours: [#996](https://github.com/rynfar/meridian/issues/996).**
The passthrough adapter never resumed a client-driven tool round even with a
session key it does read. Filed as an unexplained asymmetry, then diagnosed as
a regression from #983 and fixed — see its own section below. #820 is closed on
its own asks.

**Local environment note for whoever runs the suite next.** CI uses bun 1.3.11
(`oven-sh/setup-bun@v2`). Two test files are bun-version-sensitive and will
report false failures on other versions: `dependency-uri-resolution.test.ts`
fails 4 on bun 1.3.14, and `fix-bun-exports.test.ts` fails 1 on bun 1.4.2. Both
pass on 1.3.11 and on unmodified main. Match CI's version before attributing a
failure to a change.

## Delivered: #996, a regression from our own #983

**Item.** [#996](https://github.com/rynfar/meridian/issues/996), filed during
the #820 validation: the `passthrough` adapter never resumed a client-driven
tool round, even with the session key it reads. `pi` and `opencode` resumed the
identical shape.

**Disposition.** Accepted as a maintainer fix. Delivered in
[PR #998](https://github.com/rynfar/meridian/pull/998), merged `0538a98b`, worktree
`/Users/rynfar/repos/meridian-wt/early-stop-namespace`, base `7375351`. The
before-code baseline is `/Users/rynfar/repos/meridian-wt/pre-983-baseline`
(detached at `15529b12` — do not delete, it is the bisect evidence).

**Cause, and it is ours.** #983 gave each adapter its own passthrough
client-tool namespace, so the LiteLLM adapter registers client tools as
`mcp__litellm__*`. The early-stop tracker freezes the resume checkpoint and
arms by matching those names, but `noteAssistantMessage` called
`noteAssistantContent` **without a prefix parameter**, so it only ever matched
the default `mcp__oc__`. `server.ts` threads `clientToolPrefix` into the two
`isClientForwardedToolUse` sites and could not thread it here. On the
passthrough adapter nothing entered `expected`: no checkpoint UUID, no stored
`passthroughToolCallIds`, so `advancesDurableCheckpoint` could never fire.

`isClientForwardedToolUse` is strict about foreign `mcp__*` names by design,
which is what made the missed call site silent. #983's own test file pins the
hazard — `it("would reject that same tool under the default prefix")` — so the
assertion existed and a call site that trips it was still missed.

**Bisect, `pi` as the control:**

```
15529b12 (pre-#983)   pi 3/3 continuation   passthrough 3/3 continuation
96dc5605 (main)       pi 3/3 continuation   passthrough 0/3
with the fix          pi 3/3 continuation   passthrough 3/3 continuation
```

**Gate E56** drives an identical keyed tool loop on `pi`, `passthrough` and
`opencode`. Its load-bearing assertion is that all three **agree** on the
tool-round shape. That is the transferable lesson: a single-adapter gate passed
throughout this entire regression, because each adapter looks self-consistent
on its own. Anything that makes behaviour per-adapter needs a cross-adapter
gate, not a deeper one.

Six unit tests in `early-stop-namespace.test.ts` pin the threading; three of
them fail on `main`.

## Delivered: race-harness deflake (#997), and what #917/#933 still need

PR #995's `test` check failed on
`does not refuse the user's turn that queued behind an in-flight title turn`.
Causality was established before anything was changed: for a request carrying
`x-opencode-session` the new term in `isClientDrivenLoop` cannot alter the
decision, and **the same test had already failed on main** at `264cfc3a`
([run 34315620193](https://github.com/rynfar/meridian/actions/runs/34315620193)),
hours before that branch existed.

**The shape, now named.** Poll to a short wall-clock deadline, then assert on
what the poll observed. The title-lease harness gave the user's turn 100 ms to
traverse the route handler and then asserted a boolean, so a loaded runner
fails with `Expected: true, Received: false` and says nothing about timing. It
occurs three times, all fixed in #997:

| file | was | now |
|---|---|---|
| `opencode-title-agent-collision` | 100 ms poll | a signal from the SDK mock |
| `proxy-stream-deny-hold` | 1.5 s, then `toContain` | 5 s, timeout names itself |
| `concurrency-hardening` | 3 s, then `toEqual` | 5 s, timeout names itself |

Two controls were added and **verified by inverting them**, because raising a
ceiling from 100 ms to 10 s could otherwise make the assertion unfalsifiable: a
non-title prompt in the title lease scope (contends, must report `false`), and a
second title turn on one session (must not reach the SDK call while the first is
held).

**#917 and #933 stay open, deliberately.** The same CI run also failed
`Session tool cache > updates cached tools when client sends a new set`, which
has no timing bound at all — three sequential requests and an assertion that the
third inherits the cached tool set — so this diagnosis does not cover it, and it
did not reproduce locally. Run 34315145910 failed
`Extra usage required fallback > does not use exponential backoff`, also
unexplained. **Leave #917 and #933 open; #997 does not settle them.**

## Previous checkpoint: Meridian 1.70.0

[Meridian 1.70.0](https://github.com/rynfar/meridian/releases/tag/meridian-v1.70.0)
shipped through [release PR #1006](https://github.com/rynfar/meridian/pull/1006),
authorized explicitly by the owner. **Published and installed-package
validated** — not merely merged. Do not republish it.

| | |
|---|---|
| Candidate tree | `c925dbba` (parent `c3dc2279`), all four checks green |
| Release PR head | `c925dbba`, merged with `--merge --match-head-commit` |
| Release/tag commit | `0acf3b1906f7b16a9bf507925bf1998b9931cd2f` |
| npm | `1.70.0`, `latest` → `1.70.0` |
| Tarball integrity | `sha512-/EqHIcKAv7TvlScooHmGxePSmrOpXehtY8fh433NBBoNh+UKjNtyIfKPxIOo0X+n/zoCf5iGrYUwO3TH5gxQHA==` (shasum `184f4eb5…866f`) |
| SLSA provenance | `gitCommit: 0acf3b19…`, workflow `.github/workflows/release-please.yml`, subject `pkg:npm/@rynfar/meridian@1.70.0` |
| Docker | `1.70.0` and `latest`, `linux/amd64` + `linux/arm64` |
| Post-release workflows on `0acf3b19` | CI, Release Please, Docker, Sync bun.nix — all success |

Provenance was verified by **content, not presence**: the attestation's
`resolvedDependencies.digest.gitCommit` equals the tag commit.

Changelog, one entry per PR: `feat` Polytoken harness adapter (#1010) and
OpenCode V2 model discovery (#1004); `fix(errors)` disabled subscription
entitlement classified as billing (#1012).

**The candidate's own CI had to be approved to run at all.** Release Please
branches arrive as bot pull requests whose workflows sit at `action_required`.
For 1.69.0 nobody approved them and all four expired as `failure`; that release
merged on the strength of CI on `main` instead. This time the four runs on
`c925dbba` were approved and all four came back green before the merge. **Do
this every release** — `gh api -X POST repos/rynfar/meridian/actions/runs/<id>/approve`
for each run on the release head — otherwise the candidate tree is never
actually built.

**Gates run before the merge, all green.** `npm test` 3880 pass / 1 skip / 0
fail on bun 1.3.14; typecheck; build; `e2e-client-detection.mjs` with three real
clients and no fixture drift (opencode 1.18.29, crush 0.87.0, Polytoken 0.8.6);
`e2e-error-telemetry.mjs` PASS on all four cases with live Claude Max failover;
`e2e-opencode-package-integrity.mjs` with and without `--manifest`; **E42
`--live --extended --separate-proxy-cwd` against both pinned betas**
(`0.0.0-beta-18314` and `0.0.0-beta-18866`), each self-verifying its own version,
each run against the **packed 1.70.0 consumer** rather than the source tree, both
reporting 100% cache reuse on ordinary continuation and on process restart.

Note on `npm ci` in this repo: it fails. `bun2nix`'s postinstall runs with its
own package directory as cwd and cannot find `bun.lock`, so dependencies never
install and `tsc` is absent. Use `bun install --frozen-lockfile`.

**Installed-package validation** drove the published artifact, not the source
tree: a clean `npm install @rynfar/meridian@1.70.0`, the installed CLI started
as a real `node` subprocess, `/health` reporting `1.70.0` with
`build.source=npm`, and a keyed client-driven tool loop on every adapter that
keys its own sessions:

```
  PASS  pi           toolRounds=3 resumed=3
  PASS  passthrough  toolRounds=3 resumed=3
  PASS  opencode     toolRounds=3 resumed=3
  PASS  polytoken    toolRounds=3 resumed=3
```

`polytoken resumed=3` is the new line this release: #1010's adapter resumes its
own keyed tool rounds in the shipped artifact, not only in the source gate. The
same loop was run first against the locally packed tarball and then against the
registry download, with identical results.

**An environment trap that will cost the next agent an hour.** On this machine
the `personal` profile's OAuth has expired. A run with an isolated
`MERIDIAN_CONFIG_DIR` defaults to that profile and every request fails with
`Failed to authenticate: OAuth session expired and could not be refreshed`,
which looks exactly like a release regression. It is not: seed the disposable
config from `~/.config/meridian` and send `x-meridian-profile: work`. For the
same reason `/health` reports `status: degraded` / `Could not verify auth
status` — **confirmed pre-existing by installing published 1.69.0 and getting
the byte-identical response**. Run that control before believing a health
regression.

**Known limitation, ticketed as
[#1014](https://github.com/rynfar/meridian/issues/1014).** The E42 gate
now always exits 1, even on a fully passing run, and it cannot exercise #1004's
model discovery at all. Its recording fixture calls `request.json()`
unconditionally, so the body-less `GET /v1/models` that discovery issues throws
`SyntaxError: Unexpected end of JSON input`; in live mode the same handler also
forwards with a hardcoded `method: 'POST'`. Causality was established by A/B on
an otherwise identical tree:

| fixture | `result` | `GET - /v1/models failed` | exit |
|---|---|---|---|
| as shipped | `PASS` | 5 | **1** |
| patched to answer non-POST | `PASS` | 0 | **0** |

This is test infrastructure only — 1.70.0 ships the feature unaffected, and
discovery against a real Meridian was verified by hand during #1004. But the
gate's exit code is now meaningless, and the feature has no automated live
coverage. The probe patch was reverted; the candidate tree was confirmed
pristine at `c925dbba` before the merge.

## Earlier checkpoint: Meridian 1.69.0

[Meridian 1.69.0](https://github.com/rynfar/meridian/releases/tag/meridian-v1.69.0)
shipped through [release PR #970](https://github.com/rynfar/meridian/pull/970),
authorized explicitly by the owner. **Published and installed-package
validated** — not merely merged. Do not republish it.

| | |
|---|---|
| Candidate tree | `04f65101` ([CI success](https://github.com/rynfar/meridian/actions/runs/34394242824)) |
| Release PR head | `e52f453c`, merged with `--merge --match-head-commit` |
| Release/tag commit | `3d38f6987632cd798b092c4d1dd83231f8ea3280` |
| npm | `1.69.0`, `latest` → `1.69.0` |
| Tarball integrity | `sha512-4ZN4BR9lFMRqFjzWdldT2+Z4weaDJVZWLGov6nW0xJBvVU3yn+jFywGMzPAnsPvljvOhpbCvacja79/Ca82iKg==` |
| SLSA provenance | `gitCommit: 3d38f698…`, workflow `.github/workflows/release-please.yml`, subject `pkg:npm/@rynfar/meridian@1.69.0` |
| Docker | `1.69.0` and `latest`, `linux/amd64` + `linux/arm64` |
| Post-release workflows on `3d38f698` | CI, Release Please, Docker, Sync bun.nix — all success |

Provenance was verified by **content, not presence**: the attestation's
`resolvedDependencies.digest.gitCommit` equals the tag commit. An attestation
that merely exists says nothing about what was built.

**Gates run before the merge, all green.** `npm test` 3793 pass / 1 skip / 0
fail on bun 1.3.11; typecheck; build; E41 all four modes; E54; E55 three runs;
E56; **E42 live+extended against both pinned betas** (`0.0.0-beta-18314` and
`0.0.0-beta-18866`, each verifying its own version in-output because the beta
CLI can self-update); `e2e-opencode-package-integrity.mjs` with and without
`--manifest`.

E42 was required here for a non-obvious reason worth remembering: this release
looks V1-only, but #988 generalized `package-meridian-v2-plugin.mjs` into
`package-opencode-plugins.mjs`, which also emits the **V2** manifest. The
pinned betas had to be reinstalled because the gate's isolated installs live
under `/tmp`.

**Installed-package validation** drove the published tarball, not the source
tree: a clean `npm install @rynfar/meridian@1.69.0`, the installed CLI started
as a real subprocess, `/health` reporting `1.69.0`, and the keyed tool loop run
on all three adapters:

```
  PASS  pi           toolRounds=3 resumed=3
  PASS  passthrough  toolRounds=3 resumed=3
  PASS  opencode     toolRounds=3 resumed=3
```

`passthrough resumed=3` is the load-bearing line: it proves #998's fix is in
the shipped artifact. #983 introduced that regression during this same cycle,
so no released version ever carried it — which is why both entries appear in
one changelog.

**One gate had to be corrected mid-validation.** E55 was asserting pre-#998
behaviour and failed on correct behaviour; fixed in #1001 before the release
merge. The process miss: #998 changed the passthrough tool loop and only the
new gate (E56) was re-run, not the existing gates on the same path. Re-run
every gate that touches a changed path, not just the one written for it.

## Earlier checkpoint: Meridian 1.68.0

[Meridian 1.68.0](https://github.com/rynfar/meridian/releases/tag/meridian-v1.68.0)
shipped through [release PR #937](https://github.com/rynfar/meridian/pull/937).
Its release/main commit at this checkpoint was
`58f8a70402fce471712cd4650f721afcb80f05d7`, tree
`427fbc82761e163d6fbf9621a8fb2e88ac260081`. Do not republish it.

- [Release Please, npm and semver Docker publication](https://github.com/rynfar/meridian/actions/runs/33998609223): successful.
- [Post-merge CI](https://github.com/rynfar/meridian/actions/runs/33998609125),
  [Docker latest](https://github.com/rynfar/meridian/actions/runs/33998609160) and
  [Nix builds/cache uploads](https://github.com/rynfar/meridian/actions/runs/33998609115): successful, including the formerly pending cache uploads (rechecked September 8).
- Recorded release validation: 3601 tests passed, one existing skip, no failures;
  typecheck/build; all four real E41 modes; installed-package OpenCode V1 and
  extended V2 flows; structured output and package-integrity gates; published
  package live V2; verified registry signatures and SLSA provenance matching the
  release commit. This is historical evidence for that candidate, not a substitute
  for tests on future changes.
- Frozen install used SDK0.2.141/Claude Code2.1.259; fresh npm package gates used
  SDK0.2.141/Claude Code2.1.261. Actual clients: V1 1.18.11 and V2 beta18866
  (extended live, separate working directories), plus beta18314 scripted package
  compatibility. Do not describe the beta18314 release check as extended live.

Last completed implementation: [#961](https://github.com/rynfar/meridian/pull/961),
merged `1ae1810dc2a24250c4a3f4d21546b03e56b9b388`, incorporating original #836 and
resolving #829. Original `57e3091c` retained as
`abd410192cfcb706c7649ce3e0f65f5fa73e6008` with Trevor Walker's author/date;
maintainer corrections `25b895a6ccb9e1182257bd3089d7b055d4085132`. The final tree
`19ecf09794f9545b93f5119af35255ab9fecd99d` matched the merge. Actual SDK billing
refusal/failover and account/model telemetry were verified in both response modes.
Original #836 and issue #829 are closed.

Immediately preceding it, [#960](https://github.com/rynfar/meridian/pull/960)
incorporated #868 and merged `6365ae0ed5445fbf6ea5c89055919570a7c76406`.
Actual V1/beta18866 idle retry bounds and recovery, beta18314 compatibility,
four E41 modes and full tests passed. Original #868 is closed.

Earlier delivered integration PRs in this review run: #938, #939, #940, #941,
#944, #945, #948, #949, #950, #952, #953, #954, #955, #956, #957, #958 and #959.
Inspect their final diffs and linked original PRs before redoing overlapping
work. In particular, #953 did **not** establish that #917/#933 were fixed.
The already-merged structured-output implementation #930 was validated and
released; original #898 was closed as superseded.

## Next item to triage on resumption

Live at this checkpoint: refresh the counts; do not act on any written here.
#820 and #996 are both fully addressed and were closed once #998 merged, so the
live issue list should be shorter than this table.

#1014 (#1016), #1008 (#1018), #1011's two landable commits (#1022) and #1009's
commit (#1025) are all **delivered**; their sections are above. #1011 and #1009
both stay open with narrowed scope recorded in their own bodies. The contributor
backlog below is now the whole remaining queue. They are
ours, fully diagnosed, and each carries a reproduction and acceptance criteria —
so they are cheaper to pick up than any contributor report below.

| ticket | state at this checkpoint |
|---|---|
| #1009 uncaptured-tool recovery | **landed off by default** (#1025). Open for a live abort-window gate, the non-streaming parity decision, and the canary |
| #1011 the last held passthrough commit | two of three landed (#1022); `c5804275` deferred by owner — it changes a gate-defended contract and adds a stream/non-stream asymmetry. Evidence in the ticket body |

| issue | state at this checkpoint |
|---|---|
| #996 passthrough never resumes a tool round | filed, bisected to our own #983, fixed in [#998](https://github.com/rynfar/meridian/pull/998), `0538a98b` |
| #917 / #933 CI flakiness | one mechanism removed in #997; two failures still unexplained. Do NOT close on #997 |
| #967 headless bg-job respawn loop | Meridian half fixed in #969; the rest needs the reporter's tool list |
| #895 Windows session GC | contributor PR #896 exists and **cannot be validated here** — no Windows host, and POSIX path fixtures are not a Windows run |
| #820 pi/gateway lineage | both halves delivered (#994, #995); remainder is #996 |
| #767 Opus resume divergence | investigated, does not reproduce live on main; evidence recorded above |
| #769 OpenClaw scrub plugin | feature proposal, needs a product decision |
| #650 plugin-input bumps | infrastructure proposal, needs a product decision |

Contributor backlog still untouched: #896 (Windows session GC, cannot be
validated here), #849, and roughly 21 `feat` proposals, mostly from one
contributor, each needing a product decision before technical review.

**#917/#933 is the strongest remaining contributor-reported item**, and it needs a
different approach from the one that has been tried. #997 removed one confirmed
mechanism; the two remaining failures
(`Session tool cache > updates cached tools when client sends a new set`, and
`Extra usage required fallback > does not use exponential backoff`) have no
timing bound and did not reproduce locally. Neither is a concurrency test in
the sense #917's title claims, which is itself worth noting: the issue's own
framing may be wrong. Consider capturing a failing CI run's full ordering
rather than reasoning from the assertion text.

**A caution from #996, which was our own regression.** Anything that makes
behaviour per-adapter needs a **cross-adapter** gate. A single-adapter gate
passed through that entire regression because each adapter looked
self-consistent on its own, and the defect was only visible as an asymmetry.

Roughly 21 of the open PRs are `feat` proposals, mostly from one contributor.
The owner asked to skip those during the issue sweep; each still needs a
per-PR product decision about whether the behavior is wanted before any
technical review is worth doing.

Pick one bounded item. Each is a report or proposal, **not a verified root
cause, a proven regression, or an approved implementation**. Reproduce with
bounded attempts and isolated fixtures, establish which component owns the
behavior, and validate the affected model/client versions — a passing Haiku run
neither disproves nor resolves an Opus report. Do not read private SDK
transcript files referenced in an issue; use supported APIs and controlled
reproduction.

### A closing keyword closed an issue this checkpoint was told to keep open

PR #997's body contained a sentence of the form "It does not `resolve` `#917`",
written specifically to say the issue stays open. GitHub's linked-issue parser
matches the keyword-then-number pattern and ignores the negation, so merging
merging #997 shut #917. #933 survived only because the second number in the
same sentence had no keyword in front of it. #917 has been reopened, the phrasing is
edited out of #997's body, and the issue carries a comment explaining that its
status did not change.

This is the second occurrence of the same hazard in this backlog — #969 shut #967 with a
"Does not `close` `#967`" line. The guard exists and was not applied at the
right moment: it had been run against issue comments and not against PR bodies.

**Before creating or merging any PR whose body discusses an issue it does not
fix**, grep the body for
`(?i)(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*:?[[:space:]]*#[0-9]+`
and require zero hits. Prefer "issue NNN stays open"; never place the keyword
adjacent to a number, even inside a quotation documenting the hazard.

### Two environment facts that will otherwise cost an hour

**Match CI's bun version before attributing a test failure to a change.** CI
uses bun 1.3.11 (`oven-sh/setup-bun@v2`). Two files are bun-version-sensitive
and report false failures elsewhere: `dependency-uri-resolution.test.ts` fails
4 on bun 1.3.14, and `fix-bun-exports.test.ts` fails 1 on bun 1.4.2. Both pass
on 1.3.11 and on unmodified main.

**Commit as the repository's configured identity.** `main` has
`required_signatures` enabled. A commit authored under an email that is not on
the GitHub account verifies as `no_user`, and the merge is refused with "the
base branch policy prohibits the merge" with no mention of signatures. Use the
repo's `user.email`; do not substitute one from the environment.

## Checkpoint: 2026-09-18 (Autonomous Review Session)

### Completed items in this review session

1. **Issue #1027 (`Supported OpenCode V2 betas are ~400 revisions behind`)**:
   - Delivered in PR #1060 (`303ce0d0`).
   - Extended pinned OpenCode V2 beta range through `0.0.0-beta-18866`.
   - Closed Issue #1027.

2. **Contributor PR #771 (`feat(profile): create the profile when profile login names an unknown one`) by @Nowaker**:
   - Delivered in PR #1061 (`96a75ac5`).
   - Auto-creates profile on login if named profile does not exist.
   - Closed PR #771 as incorporated.

3. **Contributor PR #765 (`chore: update plugin flake inputs`) by @Nowaker**:
   - Delivered in PR #1062 (`865b8331`).
   - Updated Nix flake inputs for plugins and flake-parts.
   - Closed PR #765 as incorporated.

4. **Contributor PR #772 (`feat(dev): MERIDIAN_CREDENTIALS_READONLY, for a second instance on shared credentials`) by @Nowaker**:
   - Delivered in PR #1064 (`b7b820e9`).
   - Adds `MERIDIAN_CREDENTIALS_READONLY=1` support preventing secondary instances from modifying shared credential stores.
   - Closed PR #772 as incorporated.

5. **Contributor PR #773 (`feat(cli): print the dashboard when the port is already serving Meridian`) by @Nowaker**:
   - Delivered in PR #1065 (`a80a15e2`).
   - Adds pre-flight port probing: when port is already running Meridian, displays terminal dashboard and exits 0 instead of failing `EADDRINUSE`.
   - Added `meridian status` command.
   - Closed PR #773 as incorporated.

6. **Contributor PR #774 (`fix(config): make MERIDIAN_CONFIG_DIR relocate the directory, not one file in it`) by @Nowaker**:
   - Delivered in PR #1066 (`c07cefd4`).
   - Relocates all Meridian configuration files (`profiles.json`, `profiles/<id>`, `adapter-instances.json`, `sdk-features.json`, `model-pricing.json`, `telemetry.db`) under `MERIDIAN_CONFIG_DIR`.
   - Keys 5s disk caches by resolved path.
   - Stabilized `desktop-manager.test.ts` shutdown race under recovery.
   - Closed PR #774 as incorporated.

7. **Contributor PR #818 (`fix(profiles): loggedIn is not true if the profile has no token`) by @Nowaker**:
   - Delivered in PR #1069 (`1cfd9805`).
   - Fixes `readCredentialFile` and `discoverProfiles` to verify that a profile's credential file contains a valid, non-empty access token before marking `loggedIn: true`.
   - Surfaces "Sign-in required" on cards and tray if a credential file exists without a valid token.
   - Desktop parity in `apps/desktop/src/renderer.ts` and `apps/desktop/src/trayRenderer.ts`.
   - Closed PR #818 as incorporated.

8. **Contributor PR #795 & #804 (`fix(profiles): remember the account's plan at headless login` & `fix(profiles): backfill the plan on token refresh`) by @Nowaker**:
   - Delivered in PR #1070 (`85f87f74`).
   - Persists account plan fields (`subscriptionType`, `rateLimitTier`) returned by Anthropic OAuth during headless profile login.
   - Backfills missing plan fields during background OAuth token refresh into `profiles.json`.
   - Adds unit tests in `src/__tests__/profile-login-plan-fields.test.ts` and `src/__tests__/token-refresh-plan-backfill.test.ts`.
   - Closed PR #795 and #804 as incorporated.

9. **Contributor PR #824 (`feat(usage): keep the last good usage reading when rate-limited, and mark cached facts`) by @Nowaker**:
   - Delivered in PR #1071 (`46c10563`).
   - Retains the last successful quota and usage reading when upstream rate limits (`429`) occur, preventing quota displays from flipping to blank/missing.
   - Tags cached facts with provenance (`cached: true`) in web telemetry and desktop UI.
   - Closed PR #824 as incorporated.

10. **Contributor PR #819 (`feat(health): /livez and /readyz liveness and readiness probes`) by @Nowaker**:
    - Delivered in PR #1072 (`0d3d30c2`).
    - Implemented `/livez` (lightweight process health) and `/readyz` (full subsystem readiness) probe routes for Kubernetes and supervisor environments.
    - Verified route auth auditing and added unit tests in `src/__tests__/health-probes.test.ts`.
    - Closed PR #819 as incorporated.

11. **Contributor PR #826 (`feat(routing): say when an account is refusing, and route around it`) by @Nowaker**:
    - Delivered in PR #1075 (`a5596f25`).
    - Proactive allowance refusal routing: detects 5h vs 7d quota bucket exhaustion and preemptively routes around spent profiles to prevent avoidable upstream 429s.
    - Exposes refusal rationale in `/quota` and UI cards.
    - Closed PR #826 as incorporated.

12. **Contributor PR #833 (`feat(telemetry): show the route chain, refusal load, and telemetry retention`) by @Nowaker**:
    - Delivered in PR #1076 (`cfe13038`).
    - Telemetry route attribution: exposes the full failover hop chain, per-profile served/refused tallies, and refusal metrics across web and desktop.
    - Closed PR #833 as incorporated.

13. **Contributor PR #776 & #777 (`feat(dashboard): dim spent accounts and offer a sort that sinks them` & `feat(profiles): also dim spent accounts on /profiles`) by @Nowaker**:
    - Delivered in PR #1077 (`f1bb2d5f`).
    - Visual dimming/fading of spent accounts and view sorting tabs (`Configured`, `Most used`, `Least used`) on both web dashboard and desktop manager.
    - Closed PR #776 and #777 as incorporated.

14. **Contributor PR #775 (`feat(profiles): reorder the profile pool by drag or keyboard, on both pages`) by @Nowaker**:
    - Delivered in PR #1078 (`2268eef0`).
    - Drag-and-drop and keyboard reordering (`Alt+Up` / `Alt+Down`) for profile failover priority in the pool, synced with desktop ordering.
    - Closed PR #775 as incorporated.

15. **Contributor PR #841 (`feat(profiles): rename a profile from the CLI and web UI`) by @Nowaker**:
    - Delivered in PR #1079 (`fe9c69d1`).
    - Profile renaming CLI (`meridian profile rename <old> <new>`) and Web UI modal. Automatically manages legacy alias redirects and updates desktop state.
    - Closed PR #841 as incorporated.

16. **Contributor PR #778, #779, #849 (`feat(settings): overhaul settings layout with routing first, harness tabs, and telemetry storage`) by @Nowaker**:
    - Delivered in PR #1080 (`1ff2c678`).
    - Settings reorganization into dedicated tabs (Routing, Telemetry retention, Harnesses/Adapters), plus sqlite telemetry retention tuning.
    - Closed PR #778, #779, and #849 as incorporated.

17. **Contributor PR #803 (`feat(profiles): say what plan an account is on, and how much usage it buys`) by @Nowaker**:
    - Delivered in PR #1081 (`ce68af8f`).
    - Visual plan badges and dynamic multiplier chips (`1x`, `5x`, `20x`) based on tier allowance across web dashboard, desktop manager, and tray renderer.
    - Closed PR #803 as incorporated.

18. **Contributor PR #822 (`feat(profiles): show the organization an account belongs to, and its details on hover`) by @Nowaker**:
    - Delivered in PR #1082 (`7651b3ea`).
    - Discovers Anthropic organization name and surfaces it with hover detail in web cards, desktop manager, and tray tooltips.
    - Closed PR #822 as incorporated.

19. **Contributor PR #805 (`feat(auth): log every property Anthropic returns during authentication`) by @Nowaker**:
    - Delivered in PR #1083 (`944e7971`).
    - Safe property logging during Anthropic authentication exchange with safe string key allowlisting.
    - Closed PR #805 as incorporated.

20. **Contributor PR #780 (`chore(opencode): pre-approve Meridian's own directories, refuse its credentials`) by @Nowaker**:
    - Delivered in PR #1084 (`a93da86c`).
    - OpenCode pre-approved project permissions in `.opencode/opencode.json`, explicitly denying access to credential storage while granting proxy cache/config.
    - Closed PR #780 as incorporated.

21. **Contributor PR #782 & #806 (`feat(profiles): follow mode with active profile and roster adoption`) by @Nowaker**:
    - Delivered in PR #1085 (`dacc1b1b`).
    - `MERIDIAN_FOLLOW_ACTIVE` engine allowing follower instances to mirror a primary instance's active profile and adopt shareable file-backed profiles.
    - Desktop Parity: Desktop header notice surfaces followed status and stale alerts; active card and tray reflect follow state; local switching is gracefully disabled with explanatory tooltips.
    - Closed PR #782 and #806 as incorporated.

22. **Release 1.73.0 (PR #1053) & Test Isolation (PR #1087)**:
    - Delivered and published in Release Please workflow run `35468508440`.
    - Candidate head SHA: `58a563b4845ffc771cd5eb4e787fc2feb7a4509f`.
    - Merged with exact match to `main`: `0cfda823e418a5560e33c33f63f831ed92973bbf`.
    - Scope included PR #1087 (`8eac9254`) isolating Claude SDK mock in follow-active tests to eliminate global mock leakage across test files.
    - All 4 release workflow jobs passed:
      - `release-please` (tag `meridian-v1.73.0`, release `meridian: v1.73.0`)
      - `desktop / mac` (signed/notarized DMGs and ZIPs attached to release)
      - `docker` (multi-arch images pushed to GHCR `ghcr.io/rynfar/meridian:1.73.0`, `:1.73`, `:latest`)
      - `publish` (`npm publish --provenance --access public` via OIDC trusted publishing, Sigstore index `2893429092`, integrity `sha512-vJPtgC6wv72nBdkre3vCUtZG3Nnz8rAGavdVKzk2KZOZeuoYSh9pQbMULdKm07Qy8EM10PpXdu5pscauiBsDyw==`)
    - Installed-package validation: verified `npm view @rynfar/meridian version` -> `1.73.0`, executed clean install in isolated temporary directory and verified `npx @rynfar/meridian --version` -> `1.73.0`.

### Current Backlog Status & Open Issue Triage

- **Antigravity Integration (PR #1074, PR #1050, Issue #1073)**:
  - Excluded from this review workflow; handled by a dedicated agent per owner directive.

- **Contributor PR #792 (`feat(profiles): complete a profile login from the web UI`) by @Nowaker**:
  - Status: DRAFT. Contributor requested in PR description: `# DRAFT - please do not review or merge yet`. Deferred until author marks ready.

- **Issue #1068 (`feat: define an opt-in contract for request-scoped context in passthrough sessions`)**:
  - RFC / Design inquiry from Pydantic AI Harness maintainers regarding client request-scoped context (planning reminders, context-limit warnings) that are sent with one request and removed on subsequent requests, triggering `modified-history` fresh replays.
  - Action / Status: Needs architectural guidance from repository owner before any patch. Options proposed by reporter: (1) advisory-context envelope eligible for lineage normalization, (2) separate request-context field, or (3) documented append-only requirement.

- **Issue #1024 (`OpenCode title + primary turn collide on one SDK session`)**:
  - Root cause resolved in PR #1031 (`2e118a92`) by admitting plugin-less OpenCode concurrent turns and degrading gracefully instead of returning 400.
  - Status: Resolved in codebase; kept open pending confirmation from reporter (@calebdw).

- **Issue #1011 (`Land the two passthrough commits held back from #980`)**:
  - Commit 2 (`feat(proxy): classify abort causes`) landed in PR #1022 (`0fd59403`).
  - Commit 1 (`fix: recover visible empty capped streams`, `c5804275`) deferred by owner decision because it introduced stream/non-stream asymmetry and altered gate-defended guarantees in `E2E.md`.

- **Issue #1009 (`Uncaptured-tool recovery for capped passthrough turns`)**:
  - Implementation landed behind opt-in flag `MERIDIAN_PASSTHROUGH_UNCAPTURED_TOOL_RECOVERY=1` in PR #1025 (`d8516bea`).
  - Status: Stays open pending canary validation on affected deployment and a positive fault-injection live gate.

- **Issues #933 & #917 (`npm test is flaky on CI` / `Intermittent CI failures: concurrency tests fail fast`)**:
  - Transcripts backlog saturation fixed in #935; test timeouts widened to 30s in #990; global Claude SDK mock pollution fixed in PR #1087.
  - Status: Tracked. Singleton concurrency test races under high runner CPU load and potential ordering dependencies remain under observation.

- **Issue #769 (`Official OpenClaw scrub plugin (meridian-plugin-openclaw-scrub)`)**:
  - Official plugin repository built at `https://github.com/rynfar/meridian-plugin-openclaw-scrub` and listed via PR #799.
  - Status: Tracking upstream OpenClaw changes and moving fingerprint targets with community contributors.

- **Issue #767 (`OpenCode + Opus: turns diverge as modified-history with overlap messageCount - 1`)**:
  - Investigated and mitigated in 1.61.0 (#784) and #872. Tested on current `main` across 80+ Opus requests with 0 divergences.
  - Status: Main verified clean; awaiting reporter closure or reproduction with new mismatch diagnostic.

- **Issue #650 (`Wire event-driven plugin-input bumps`)**:
  - Repository dispatch receiver merged in #653; notification workflows merged in plugin repos.
  - Status: Waiting for owner to mint fine-grained PAT and set `MERIDIAN_DISPATCH_TOKEN` secret across plugin repos.

## Restart safely

Fetch origin/main and refresh the selected PR/issue, its exact head and related
merged work. Preserve the user's current checkout; use a new isolated worktree
from current main. Existing worktrees may be completed deliveries or deliberate
before-code baselines. Do not reset or delete them on the assumption they are
abandoned. Verify current tool/client versions and use the current E2E.md.

Then work one bounded item through the skill: decide whether we want the behavior,
reproduce, retain contributor authorship, correct separately, run real affected-flow
E2E plus npm test/typecheck/build, inspect exact-head CI and finish only within the
owner's authorized scope. If the required model/platform/environment or product
decision is missing, record the precise blocker and leave that item incomplete.


## Current continuation — 2026-10-08 (current Claude side-call stack)

[#1292](https://github.com/rynfar/meridian/pull/1292) is reconciled from current
`21e028a5` on main `74ee5515`, with the corrected original #1211/#1231 parent
subset. The expanded current #1231 proposal is excluded. [Current review and
proof](evidence/1292-current-main-20261008/REVIEW.md) records seventeen exact
raw Author/AuthorDate/full-message mappings, separate maintainer corrections,
492 unchanged inherited escrow files, six corrected source/control findings
and passing focused preservation controls. The mapping WeakMap is private
ownership bookkeeping; classification uses an internal adapter hook. The
executable-selection approval in #1319 supplies no authority for other public
proposals.

The first full local gates pass at `50923ff0`; a subsequent direct control
reproduced a protected-legacy-slot fresh-retry failure in both response modes.
Separate correction `b6a1c6eb` retains that slot's CAS fence without pretending
it was evicted, passes all four collision/fallback controls and preserves
namespace, auxiliary and canonical recovery controls. The repeated final local
gates now pass at clean `3cd230cc`: 21 npm batches, 5,663 pass / 36 skip /
0 fail, standalone typecheck and build, all joined. Native E71/E72 caption and
state-card proof, both overlap orders, cancellation custody, E41/E55 parity,
installed-package proof and final delivery-head CI remain open. The older
caption harness must observe the actual namespaced agent mapping before reuse;
#1288's reporter tuple remains unspecified, and #1283's separately recorded
shared SDK MCP-instance limitation still qualifies retries/main followups.
Historical login/runtime/custody failures remain recorded. Source PRs/issues
stay open. No model call, credential grant/refresh, delegation, push, merge,
source closure, release or community message occurred in this correction turn.

The first repeated gate at `a022326a` fails only the two new extended-context
goldens under unrelated global model mocks; both checkpoint collision controls
pass. The failed run is retained. The concurrency file is now an isolated final
process in `npm test` (21 batches), with all 42 controls/assertions intact. The new
complete gates pass at `3cd230cc`; no production change accompanies this isolation.
Both exact owned local fixtures were removed after all commands joined. The
owner checkout, index and twelve dirty/untracked files remain unchanged. Current
local receipts and logs are escrowed with the historical PASS and causal FAIL.
The native caption mapping observer now has an actual adapter-key correction
and root review, with six focused controls and exact-function false-pass/false-fail
causality proof. The changed harness/test requires new full local checks. Exact
native runtime/custody and all inherited native/product/package/CI holds remain.


Current #1292 native checkpoint: one baseline attempt is terminal, with the
original failure preserved. Actual native 2.1.292 emitted its caption followed
by an exact system task-budget frame. Both observer and headerless fallback
missed it. A separate bounded source correction now passes focused classification
and HTTP checkpoint-preservation controls; see
[evidence](evidence/1292-current-main-20261008/REVIEW.md) and the explicit root
adversarial receipt. Prior full local PASS at `f41a6524` is historical; new full
checks remain required. All observed source gates, direct processes and parent
pipes joined, and the private access grant was removed after the supplemental
root custody audit. Model-label and accepted-socket observers require correction
before another native attempt. Baseline/candidate acceptance and inherited
package/client/final-head CI gates remain open.


The current #1292 full npm run is **FAIL**, not accepted: first batch 5,233 pass /
36 skip / 1 E71 custody failure; remaining 20 batches unexecuted. All runner
processes joined. The new diagnostic preserves concrete client-signal/unjoined
work/runtime-retention failures without weakening cleanup assertions. Typecheck
and build pass. See the latest [review](evidence/1292-current-main-20261008/REVIEW.md)
for the failed receipts, separate post-close signal concern and executed pinned
Bun socket control. Fix the exact E71 ownership failure and remaining native
model/socket observer issues before relying on a green rerun or a new live arm.
The executable #1319 approval and #1321 final-head CI hold remain unchanged.


E71 ownership correction: exact observed birth PID, signaling retirement at
exit, explicit child/pipe joins and sticky signal failures. Root review and
reproducible prior/current refusal control are
[escrowed](evidence/1292-current-main-20261008/E71_OWNED_CLIENT_ROOT_ADVERSARIAL_REVIEW.json).
38 E71/ownership controls pass, one compiled control skips, typecheck/syntax
pass and all runners join. The original full FAIL and unknown historical OS
errno remain qualified. New full local gates and native model/socket observer
corrections still precede another live attempt. No merge or gate waiver.


Native caption model/socket observer corrections are now statically reviewed
and credential-free controlled. Exact wire/SDK/env-pin/native-context labels
and a canonical helper row are required; model acceptance remains independent
of physical source/client custody. The exact old/new cleanup snippets reproduce
old socket deadlines and witness all current closures on pinned Bun/Node, with
all four peers joined. See the
[root review](evidence/1292-current-main-20261008/NATIVE_MODEL_CUSTODY_OBSERVER_ROOT_REVIEW.json).
Ten controls, typecheck, syntax and existing causality controls pass. No new
model call or grant. New full local gates and fresh invocation/provenance
qualification still precede actual before/after proof; inherited holds remain.


Current combined #1292 correction passes complete local gates at
`465c35895cbef922669a6bb745d86438f9941c4d`: all 21 npm batches, 5,684 pass / 36 skip /
0 fail, pretest and standalone typecheck, build and all three causality controls.
All commands and session 19888 join; source/head stay clean and exact.
[Summary](evidence/1292-current-main-20261008/OWNED_OBSERVER_FINAL_LOCAL_SUMMARY.json)
retains earlier failures and separate acceptance holds. Source/SDK/helper/Hono/
runtime plans and read-only access readiness are prepared; no new native call
or grant. Refresh provenance to the evidence-checkpoint head before a new
unique baseline attempt, then actual candidate proof. Reporter tuple, shared
MCP, overlap/cancellation/native parity, package and final-head CI remain open.
The owner checkout remains exact; #1320/#1321 CI watches are retained.


Latest #1292 native status: **R2 baseline MISSING / candidate unexecuted**.
Actual caption and exact model/context witnesses now work; all scoped physical
joins are positive and the private access-only input has been removed after
review. The observed baseline caption replaced the working session and cleared
its checkpoint; the replacement has two messages through public SDK reads but
is absent from discovery. A separately reviewed bounded observer correction
records this defect only in the pinned baseline after-caption phase, retains all
fixed/working/nonempty-history assertions, and strengthens baseline replacement
requirements. See [root review](evidence/1292-current-main-20261008/LISTED_CAPTION_HISTORY_ROOT_REVIEW.json).
New full local gates and fresh provenance/native baseline/candidate proof remain
required. Earlier local PASS is historical after this harness-only change.
No active jobs or staged grant; the owner checkout remains exact. CI watches
were stopped on the manual approval handback; #1320/#1321 gates remain open.


Latest #1292 integration checkpoint: **full local PASS and actual native
sequential/hints1 candidate PASS at `6585b66a`**, draft delivery permitted with
all remaining native/package/final-head CI holds. The real caption preserves
working mapping/generation/history; the next query resumes the exact checkpoint;
three Read results are durable once, source history immutable and all scoped
physical joins positive. The baseline remains MISSING at final discovery, with
core replacement/replay concretely witnessed and source integrity independently
confirmed. See the [draft root review](evidence/1292-current-main-20261008/DRAFT_INTEGRATION_ROOT_REVIEW.json)
and preserved before/after reports. No staged grant or active jobs remain.
All seventeen raw contributor identities/messages match; the owner checkout is
exact. Expanded current #1231 remains excluded. No source closure or merge.
Fresh whole-queue discovery still covers six managed repositories / 31 PRs /
22 issues; #1315's model-specific advertisement defect is confirmed at source
and recorded with implementation/actual Pro-client holds.


Draft delivery is now [#1322](https://github.com/rynfar/meridian/pull/1322),
branch `codex/claude-sidecalls-stack-1292-20261008`, from exact current main
`74ee5515cde58a4df03a48c0ca38abb20ccad648`. Initial remote head is
`a9d3501e93835a82cb5a415f5ee0c248bc076ad5`; tested local/native source is
`6585b66a01e26244381709e6db78825cd4056e18`, with only documentation afterward.
The PR is linked to the active thread, remains draft, and contains the root
adversarial review, committed runnable harness, immutable failures and scoped
actual candidate proof. #1211/#1231/#1292 and #1288 stay open. Expanded #1231
is excluded. No merge, source closure, release or community comment occurred.
Next native/package invocation must refresh commit/tree provenance to the actual
current head; no old compiled build or green CI is promoted to a new-head claim.
