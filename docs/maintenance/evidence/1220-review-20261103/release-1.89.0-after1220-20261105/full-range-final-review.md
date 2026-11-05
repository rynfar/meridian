# Meridian 1.89.0 / #1486 — complete-range independent final-source review

2026-11-05. **No new material runtime defect established by this bounded static review. This is not an E2E pass or permission to bypass remaining release gates.** The owner has now explicitly authorized release after the disclosed-risk #1220 merge; the obsolete “#1220 absent/unaccepted” premise in the preliminary review no longer applies. Parent reports the release runtime is identical to the accepted #1220 landing; subsequent version/notes changes are metadata-only. **No further worker probes or expanded matrix are recommended by a newly discovered product defect: none was found.** The named unqualified live flows below are coverage limits to disclose in the authorized release decision, not newly reproduced regressions.

## Identity and scope

- Supplied candidate: `7902c2faeadff82534cf4177fe5b28b2dead7d7f`; base/main: `41d7b3e3a2ead7e95e2790cc473b469bd3e9b567`.
- Complete release scope: `meridian-v1.88.0` (`cdca353924556acdc00eca8f4162f296f2dab875`) to that candidate, **111 paths**, including #1480, the actual #1220 landing, and #1504/#1506/#1505. The production delta contains 13 TypeScript paths; all production diffs were inspected, with full-source context at cancellation/publication boundaries. Test additions/changed assertions, release metadata and affected documentation were also inspected. This is not a claim to have executed the tests.
- Inputs: `full-release-range.diff` SHA256 `25b3c7856ef354ca10e1a25530f2213f7db87a1dcb011570a441342189c0728e` and `release-version-diff.patch` SHA256 `772a31859698fafb65060186a05c1610496530e8bf97636e6c5528fc3b3ea445`, supplied worktree source, the preliminary `review-1220-release-findings.md`, committed #1480 record and safe existing #1220 merge/risk receipts.
- Parent reports a notes-only correction is underway to restore the main asynchronous-JSON benefit and Nowaker credit omitted by Release Please. That is appropriate; validate its exact diff and new head. This report covers the runtime of the supplied candidate, not unseen future source changes.

## Product and regression findings

### #1480 + #1220: interruption, asynchronous marking and publication

No concrete new silent-resume, FIFO inversion or premature-turn-release defect was established. The important combined safeguards are present:

1. `server.ts:2237–2358` serializes each request's publish/evict/rollback work with its state changes. Publication guards run again immediately before JSON rename dispatch (`sessionStore.ts:946–1020`), after disk waits can expose cancellation. JSON mapping generation/published flags are set before that queued publication completes; SQL flags still wait for its outer COMMIT. Cancellation thus decides against the state the preceding write actually left.
2. `server.ts:3989` accepts interrupted candidates only for a plain continuation that resumed its exact published source. Side/auxiliary requests and priority publication are excluded. Tool exposure, explicit cancel, watchdog/shutdown and nonstream paths retain destructive behavior. A fresh-target retry or superseded fork cannot become a source-preserving interruption.
3. `server.ts:5938` decides preserve/mark/evict **inside** that same queue. `markSessionInterrupted` (`cache.ts:774`) does an exact-generation CAS and withholds durable SDK-prefix proof. It publishes the process-local claim only after success, under the captured cache epoch. If marking fails, cleanup falls back to eviction. Another process/restart or a competing generation cannot restore the proof; the next local request takes its claim only once and checks unchanged prefix/reply, user-only additions and known tool results.
4. Stream cleanup (`server.ts:8763–8776`) joins pending marking and a changing durable tail, including rollback retirement, before releasing the turn. Arrival revision capture awaits previously started local writes (`9171`). Clear resets interruption records at its ordered commit boundary; epoch fences prevent older completion hooks from restoring them. Eviction invalidates fallback again after durable success, addressing #1220's reviewed repopulation defect.
5. SQL remains distinct: `mapStoreMutation` preserves native synchronous continuations; `lifecyclePublicationSql.ts:68` still invokes publication inside the transaction, whose engine rejects thenables. Merely widening callback types did not add an await inside the native transaction. SQL clear attaches memory reset to COMMIT.

Discriminating tests inspected include held real JSON fsync with zero canceled renames, in-flight retention during delayed eviction, FIFO/foreign-process/crash-before-rename controls, forced store-read-error fallback after eviction/clear, later-writer preservation, and SQL false/rollback/COMMIT/busy/uncertain authority assertions. The interruption tests additionally cover retained/discarded output, body cancel, strict waiting clients, consecutive stops, restart, side requests, parallel claims and tool exposure. These controls are useful; mocks do not establish native SDK history/cache behavior.

### Supporting changes

- **#1504:** changes are test-fixture stabilization, not a product backend modification. Synthetic probe routes alone launch through explicit Node; real deadlines/cancellation/retries stay in production. Cleanup joins real children before removing fixtures. The recovery-budget fixture separates logical deadline charging from process startup while retaining actual child timeout/signal/exit and joined-PID checks. No production timeout relaxation was found.
- **#1506:** legacy offline maintenance checks occupancy before paying for a staged fsync. Atomic no-replace hard-link publication still handles the check/link race; live, malformed, barrier and dangling-symlink owners remain protected. Normal async acquisition initializes once and relinks its candidate; it does not revert to blocking retries. The two specially isolated test files remain explicitly invoked by `npm test`, not silently excluded.
- **#1505:** fully versioned recognized Claude IDs add `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` after inherited environment settings. Bare aliases retain their prior settings; same-model refusal retry is not disabled. This fits explicit model identity and does **not** fix a provider refusal or establish the missing original Opus cache gate. Direct pin and captured-SDK-environment tests protect these controls. Actual selected native-version behavior still needs an existing live receipt or explicit unresolved qualification; environment assertions alone do not prove native implementation.

## Release fit, API and provenance

- Version, manifest and both lockfile version fields agree at **1.89.0**; the minor feature is #1480. The pending #1220 note/credit correction should describe yielding JSON filesystem work, not guaranteed latency, universal cancellation correctness or resolved E41 failures.
- No new public config/header/route/exported lifecycle contract was found. The public `clearSessionCache(): Promise<void>` completion contract is retained. Internal store functions now return JSON promises/native synchronous values; supported exports remain rooted at `dist/server.js` and its server declarations. Pure interruption decisions import only lineage; no leaf-to-server dependency expansion was found.
- Dependencies/resolutions/integrities do not change in the supplied full diff; no `bun.lock`, Nix, workflow, Docker, package exports/files/postinstall or plugin-source change. **Unlike the old preliminary candidate, package.json also changes test-script isolation**, not just version. That is not dependency drift. Nix's unchanged dependency hash is consistent with unchanged dependencies; no Nix build was run here.
- The existing postmerge receipt verifies #1220's contributor commit objects/Authors remain on main, including `63f54197`, under merge `41d7b3e3`. No maintainer re-land was identified. This is receipt-based, not a fresh network audit.

## Gates and limitations that remain visible

The available `latest-release-ci.json` snapshot has no candidate checks. Parent reports workflow approval/queued checks; neither state establishes final-head success. Final notes-head `npm test`, typecheck/build, required CI including `test`, independent installed tarball and normal Release Please exact-head merge remain gates. Main-side success is not candidate-head CI.

Account for these **additional explicit affected-flow requirements**, not just a green E79 fixture:

- **E79** final source and independent package: all four HTTP variants plus real Pi/OpenCode fixtures with generation-matching Meridian integrations. Fixture upstream is not a real-model stop run. Keep the final live discard/keep/strict qualification separate from its model-free result.
- **Concurrent transcript publication**, both modes: E2E.md explicitly requires this after lifecycle/publication changes. #1220 now holds lifecycle ownership across awaited JSON CAS. Preserve no-deletion/pins/durable-mapping/source-immutability proof; use the previous collector too if claiming rolling-upgrade safety.
- **E71/E72** classifier/subagent controls: E2E.md marks these pre-release checks for turn-lease changes. The combined change alters when a turn releases during durable cleanup, so account for the real-client controls or state their absence. The supplied receipts do not establish candidate coverage. Do not infer them from the single-session E79 fixture.
- **E41 and cleanup:** keep sequential/parallel × stream/nonstream, history/tool pairing, forks and unchanged 95% continuation-cache floor distinct. The awaited-clear affected-flow extension is specified separately in E2E.md. Relevant E42 actual-client flows require their own pinned-host/plugin witnesses; no new host support is introduced here.

The owner's `owner-risk-approval.json` is **OWNER_ACCEPTED_RESIDUAL_VERIFICATION_RISK**, not a full E41 PASS: candidate SSE provider `cyber` refusal, unrun parallel modes, baseline control blocked by 429, historical 3332→3132 cache shortfall/native .284 scope, initializer/fingerprint causes and old Bun AG503 remain disclosed. New Bun 1.4.3 or adjacent-model success does not causally clear them. Do not silently extend that #1220 acceptance into an unreported success for other missing release flows; link existing qualification or record each remaining gap in the release decision.

Previously documented #1480 limits survive unchanged: signed priority-routed stopped turns are not checked; priority prepublication abort/upstream-failure follow-ups remain; a real-model OpenCode stop and Claude Code/Codex stop shapes were not established by its earlier fixture evidence. No new defect was found here, and none of those limits is being represented as fixed.

After publication, verify exact release/tag SHA, npm latest/integrity/provenance, fresh registry-installed affected flow, both Docker architectures/tags/digests and desktop assets/notarization separately. The earlier desktop 401 is historical, not proof of the next result. No current supplied receipt establishes publication or installed-registry success.

## Method and assumptions

File reads and this new report only: no shell commands, project imports, network, model calls, credentials, source edits or constants changed. Supplied candidate identity, parent-provided owner authorization and immutable existing receipts are assumed accurate; live GitHub state remains parent-owned. This independent source review does not waive required checks or grant broader release/support claims.
