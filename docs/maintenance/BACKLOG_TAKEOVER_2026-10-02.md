# Backlog takeover — 2026-10-02

Recovered thread `7c2df8ca-6e51-4577-9b0e-788f92abe61c` and continued its
authorized Nowaker-first implementation/review queue. Preserve the dirty owner
checkout at `446a0f163`; all work used isolated branches. No release or external
community-message authorization was inferred. Earlier deliveries and their
proof remain in [REVIEW_HANDOFF.md](REVIEW_HANDOFF.md). The October 1 disposition
file is historical, not current status.

## Delivered and verified

- #1175 already merged as #1227, `3cb65df0c`; its old pending-CI checkpoint
  was stale. #1171/#1190 delivery/credit records remain verified on main.
- #1187 accepted with concurrency and policy corrections, delivered as
  [#1235](https://github.com/rynfar/meridian/pull/1235), merge
  `c0af34eaafefdd454fca1252ed5b9ae1b1f13e8f`. Source
  `8fa90cbcef8b039b5b95ac0df022e405f229f624` → authored cherry `ec5a107d`.
  Validated and merged trees are equal; Nowaker co-author trailer verified;
  original head unchanged before closure. All six executed exact-head CI checks
  passed, including [test](https://github.com/rynfar/meridian/actions/runs/36972696697/job/110729839626).
  [Durable proof](evidence/1187-profile-copy-pruning.md): actual OpenCode/Opus
  enabled/disabled native-resume versus deletion/replay controls and all four E41
  modes; 5,116 local tests, zero failures, typecheck/build. Default is disabled.
- #1221 accepted with a reproduced bounded-cleanup correction, delivered in
  [#1236](https://github.com/rynfar/meridian/pull/1236). Source
  `c81959314dc2aa58802322913b69caa749e2c0b8` → authored cherry `5b490e9f`;
  maintainer timeout/cleanup correction `e49a9229`, live probe correction
  `252b6629`, proof `19dfc855`. [Evidence](evidence/1221-async-sdk-gate.md):
  actual macOS/Linux OpenCode/Opus flows with held real gate fsyncs, 69/47
  concurrent liveness answers, tool receipt and resume; all four E41 modes;
  5,120 local tests, zero failures, typecheck/build. All six executed final-head
  CI checks passed, including [test](https://github.com/rynfar/meridian/actions/runs/36974174582/job/110734303264).
  Merged `e1f8bc473ba7a4dbbd643eaf6290e8ccc4e1f335`; exact tree and Nowaker
  co-author trailer verified, original head unchanged before closure.

## Explicit dispositions and acceptance gates

The heads below were refreshed from GitHub. Static integration findings are
labeled; no synthetic HTTP shape is advertised as an actual affected client.
Deferred acceptance reviews do not claim a completed full-diff or live review
of an unaccepted architecture/contract. Source branches remain available.

| PR / source head | Disposition and concrete gate |
| --- | --- |
| #792 `a9abcce8c693dae018ff73872051a9dfeabe21b6`; draft #1217 `eb0c2b9e1fc3a7ded32268c8537fbf931aaad521` | Accept with corrections, hold acceptance for real existing-account re-authentication. Rebased draft has 5,218 passing tests, 35 platform skips, typecheck/build and all six final-head CI checks passed. New-account creation and actual account-backed OpenCode/Opus use already pass. Fresh Claude authorization reached a disabled Authorize control; no grant/callback success claimed. The maintained server can resume an owned fixture without overwriting its profile file. [Evidence on the validated draft](https://github.com/rynfar/meridian/blob/eb0c2b9e1fc3a7ded32268c8537fbf931aaad521/docs/maintenance/evidence/792-browser-account-login.md). |
| #1176 `f552804e061a9aaca8ef371779f1c9e093e2ec5f` | Defer unsupported OpenAI backend. Preserve authored work and rate corrections in the existing isolated branch. Actual Codex requested GPT but upstream served Claude; this is no proof of GPT list-price valuation. Revisit after a supported OpenAI-serving path exists, with exact served-model usage and authoritative rate checks. |
| #1220 `c159bf9befc49c823a94f48c8d554236115e827e` | Current-main authored incorporation and corrections in [draft #1245](https://github.com/rynfar/meridian/pull/1245). Rebased source now awaits pruning under lifecycle/turn ownership; old `edf29520` concern is superseded. Corrected queued caller-input aliasing, revoked publication during fsync and old local-cache publication after awaited cleanup. Final local gates after cache-epoch correction: 5,138 pass, zero failures, typecheck/build; Linux focused 42 pass. Real macOS/Linux OpenCode/Opus disk-wait responsiveness, receipt/resume and four E41 modes pass; actual cancellation passes on implicated Bun 1.4.2. Mac Bun 1.3.14 missed disconnects even in the plain-server control; retain that runtime limitation. Owner approved asynchronous cleanup in [#1244](https://github.com/rynfar/meridian/issues/1244) on 2026-10-02. An earlier unexplained thinking/tool cache-prefix failure and final-head CI remain gates. [Evidence](evidence/1220-async-session-store.md). Source stays open; no merge or natural 106-second outage-rate claim. |
| #1222 `1bffa43fe95037df7ac3c32fb818d01a6c3877d5` | Reopened with owner authorization and accepted with correction in [#1241](https://github.com/rynfar/meridian/pull/1241). Preserved authored cherry `66d6d2cc`; corrected misleading ping-resume telemetry and replaced the same-process writer with an independent upstream. Actual macOS/Linux OpenCode/Opus before/after freezes reproduce baseline answer failures and fixed progress/receipt/resume, with all four E41 modes and 5,125 local tests passing. Node/Bun independent socket and silent/ping/on-time controls pass. [Durable proof](evidence/1222-late-idle-deadline.md). Refresh the integration PR for final-head CI/merge state; no natural disk-saturation or production outage-rate reduction claim. |
| #1223 `d119fce208b919226092730f51519e614ee9be4c` | Decline age-only ownerless recovery as implemented; consider durable owner flush separately. A real-process fault probe pauses a live holder, corrupts only its synthetic owner record and ages heartbeats: main refuses; source grants a second lease while the original PID is alive. No fencing token prevents the old writer resuming. Revisit with affirmative owner-death/boot proof or a real write-fencing protocol. [Probe](../../scripts/e2e-turn-lock-ownerless-review.mjs). |
| #1224 `d12431edacec89f43ef42c4ddd3c80cd32e742ae` | Defer new public admission-hold contract. Existing #1216 approves HTTP observation only. This changes `/inflight`, adds POST/DELETE `/drain`, and allows zero active count with held callers that receive shutdown 503. Origin refusal is appropriate. Revisit on an approved tracked hold/restart/cancel contract and actual client shutdown/retry proof including detached jobs and pending tool continuations. |
| #1232 `28e176e919e39f070d6c678325b71154e0832d1c` | Defer public readiness/health/control contract and classifier proof. Static findings: one process-global tracker pools profiles with different upstream URLs; null retry status alone is not evidence of a DNS/connect failure; loopback mutating override lacks the Origin guard used by `/drain`. Revisit on approved tracked readiness scope, endpoint-aware evidence, origin/transport controls and actual SDK connection failure versus slow response/HTTP refusal/recovery. No browser exploit or provider retry misclassification is claimed reproduced. |
| #1233 `c609e8d1a82b7c98114d65376474dcde5ed3ff56` | Defer tracked public hostname/settings contract. Opt-in shared-header identity fits multi-instance use, but adds health data and GET/PUT settings routes. Source browser proof combines #1232, rather than independently validating this head. Revisit with owner-approved exposure scope, default-off/API-key/no-key controls and standalone compiled-page mobile/desktop/polling evidence. |
| #1219 `5355aefceabf00ee1746d2329bf26d891ca807b9` | Defer architecture/embedding contract acceptance. This is a 176-file SQLite/offline-migration change stacked on #1214, with new initialization/export APIs, native dependency, rollback barriers and permanent migration authority. Source explicitly lacks real clients, Windows maintenance and long GC soak. Read its scope/architecture/contract before acceptance; a full implementation review is still outstanding. Revisit after tracked owner approval of startup/rollback/embedding semantics, a split current-main review and actual installed-package multi-process client/GC/crash migration proof. No entire-branch approval claimed. |
| #1228 `cee10174bb1fa500cd85d5937ec0c99339e8374d` | Decline private-transcript rewriting as implemented. Opt-in retention savings do not justify depending on CLI-private project names, JSONL schemas/UUID links and rewriting signed thinking history. Its synthetic Pi-shaped harness does not satisfy E2E.md's supported-API-only history rule or actual Pi proof. Revisit if the SDK exposes a supported retention operation, with actual implicated Pi/Opus before/after, rollback/tool-loop/undo/cancellation and off controls. |
| #1230 `d50e28062bad5b98f93359e268ce53aa8facd868` | Accept SDK-display compatibility direction; defer actual affected interactive-client proof. Full bounded implementation was read: central sanitizer retains the bundled CLI's three known values and drops unsupported values. SDK 0.2.141 source confirms it forwards display only for non-disabled thinking. E73 explicitly posts a Claude Code-shaped HTTP request because headless Claude sends a different display; that is subprocess proof, not the reported interactive 2.1.287 flow. Revisit on actual interactive connector-mode before/after plus supported-display/off controls and final CI. |
| #1211 `55b31103c5edc2f83ab9543e51b17aabbbfbcae8` | Defer classifier-hook contract/independence correction. Adapter-scoped classification fits the architecture; current proposal adds an exported hook and changes lease/session semantics. Source acknowledges a full-history auxiliary header can be promoted by the durable-checkpoint override, despite its “never publishes” contract. Revisit after tracked approved hook scope, irrevocable auxiliary independence and actual same-client/model main/classifier/concurrent/cancel/recovery controls on current main. Contributor live evidence is retained, not independently repeated here. |
| Draft #1231 `b03e0042399adac6f8922592656fe68c06a35ee2` | Defer as requested stack on #1211. Adds root routing identity and changes parent cancellation reach, with first-turn replay for backgrounded main/fork-of-main documented. Revisit after #1211, source rebase/ready declaration, approved exported routing/cancel semantics and actual background overlap plus account-affinity/1m-limit controls. Do not merge draft stack out of order. |
| Draft #1213 `553fd5c386de5e18e531a1d0101d64ef3a3b1792`, issue #1212 | Defer draft acceptance for actual OpenCode V2 catalog/fresh replay proof. Official model-config documentation now confirms native Sonnet 5/5.5 context, and contributor >200k HTTP proof is recorded. It still lacks the actual V2 catalog selection/large replay and old-model negative controls on the reviewed tree. Respect draft and exact resolved-model budgets; do not infer future Sonnet versions solely from a numeric prefix. |
| #1214 `1c8f17099ad62dbd2a511f69c12e5b4e15d9da7f` | Defer actual priority-client failover/cancel/exposure proof. Source admits installed-package evidence uses local transport fixtures only. Static boundedness finding: the non-SSE fallback branch accumulates response chunks until EOF with no byte cap. Revisit with bounded fallback and an actual SDK/client keepalive-before-refusal plus successful account, no replay after tool/content, pending write/cancel/join and pool-exhaustion controls. |
| #1234 `56b387d9271426d48ab69d2bade5a832083b31aa` | Accept flake-pin refresh for already delivered OpenCode/Pi changes. Automated [Nix rebuild](https://github.com/rynfar/meridian/actions/runs/36972456724) verified every plugin before creating it. GITHUB_TOKEN-created PR has no normal CI; incorporated as authored cherry `7762e74d` into this maintainer checkpoint branch so all required checks run. The exact pins are already merged scrub OpenCode #19 `77316d2b` and Pi #14 `188115f3`, whose independent installed-client proof is retained in the handoff. This publishes no package/release. |
| #1201 `30e01969c4511cc21e3a46c76d35c615a5ac6466`, #1193 `7c9308968f760119e1b9f3ba8d74497af39d4a85` | Existing affected-client/model and cache-lifecycle/contract deferrals remain. See the historical disposition record for exact original-worker and joined-shutdown gates; current Meowbert ordering fix does not reproduce its old report. |
| Draft #1050 `72c1ca91105a595b37dcf3e201cb93e523a8381f`, issue #1073 | Existing dedicated Antigravity lane; do not duplicate or land its explicitly unmergeable research draft. |
| Meridian #1202, Pi #15, OpenCode scrub #20 | Release authorization absent. No release PR merge, tag or package publication. |

[Official model configuration](https://code.claude.com/docs/en/model-config#extended-context)
was checked October 2 for #1212/#1213. Model context is a separate factual
question from actual V2 adoption and acceptance of the draft change.

## Checkpoint CI correction (#1237)

The first exact-head test job on `4de343242c445915dd44671db271459d5588ac98`
[failed](https://github.com/rynfar/meridian/actions/runs/36975696547/job/110738930838)
waiting for “the remaining SDK waiter” in `inflight.test.ts`. No application or
unit-test code differed from main at that head. The same Linux arm64/Bun 1.3.11
fixture failed in an isolated 30-file-repetition run: 359 tests passed, one
failed. Diagnostic runs captured the same-session request already completed
with HTTP 400 and a snapshot of two requests, zero queued, after two SDK calls.

The fixture sent an undeclared duplicate of the original user turn. Once the
first turn published, the existing `session_turn_conflict` guard correctly
refused its stale history instead of starting an SDK waiter. This is an invalid
fixture for a test that expects three successfully admitted queries. The
correction declares `x-meridian-source: fork-inflight-test` for that concurrent
request, retaining its shared turn key, and requires both buffered responses to
return 200. The application's guard, admission and public contracts are
unchanged. The corrected Linux arm64 fixture passes 100 repetitions / 1,200
tests, zero failures. All 17 existing concurrency controls pass, including
refusal of an undeclared plugin-equipped loser and acceptance of a declared
concurrent flow. Full final-head checks remain merge gates; a green rerun of
the original fixture is not the claimed fix. General #933/#917
flake reports remain open.

## Reproduce the torn-owner finding

The maintained harness creates and deletes its own synthetic lease fixture;
it does not launch a model or inspect SDK persistence. Run the main control,
then point the same harness at an isolated checkout of the exact source head:

```sh
npm exec --yes --package=bun@1.3.11 -- bun scripts/e2e-turn-lock-ownerless-review.mjs --expect-refusal
git fetch origin pull/1223/head:refs/remotes/origin/pr-1223
git worktree add --detach /tmp/meridian-turn-recovery-review d119fce208b919226092730f51519e614ee9be4c
E2E_TURN_COORDINATOR_MODULE=/tmp/meridian-turn-recovery-review/src/proxy/session/crossProcessTurnCoordinator.ts npm exec --yes --package=bun@1.3.11 -- bun scripts/e2e-turn-lock-ownerless-review.mjs --expect-acquisition
```

On macOS arm64 the first prints `contenderAcquired:false` with
`CrossProcessTurnAcquireTimeoutError`; the second prints
`contenderAcquired:true`. Both confirm a live, kernel-stopped original holder,
corrupted synthetic owner metadata and stale heartbeats. The source diagnostic
reports `grace-expired`. The implication is simultaneous ownership after the
original process resumes, not a demonstrated private-SDK transcript corruption.

## Issues, newest first

| Issue | Disposition and revisit trigger |
| --- | --- |
| #1229 | Defer exact nono/macOS sandbox reproduction. `/bin/ps` EPERM is credible; this host lacks nono 0.79.0 and the reported macOS/OpenCode 2.0.21/plugin environment. No unsandboxed ps exception installed. Revisit with that environment and a native identity/diagnostic proposal preserving fail-closed recovery, actual SDK launch and PID reuse/death controls. |
| #1215 | Browser login tracked in draft #1217; keep open until real existing-account re-authentication completes. |
| #1212 | Linked draft #1213; factual docs checked, actual V2/catalog/replay gate above remains. |
| #1094 | Existing 2.0.16 qualification partly covers host support; defer separate unknown billing fragment. Require same-window failing scrub control and exact new client host qualification before broad unpin. |
| #1073 | Existing authorized dedicated Antigravity lane. |
| #1068 | Append-only snapshot guidance exists; defer new advisory/removal contract pending explicit retention semantics and actual Pydantic AI flow/rollback/tool controls. |
| #1011 | Respect owner hold on capped-stream recovery; abort diagnostics already delivered. Require explicit parity/failure-contract decision and both-mode live cap proof. |
| #933, #917 | One `/inflight` fixture failure is reproduced and corrected in #1237 as documented above; general CI flake reports remain unresolved. Multiple successful final suites do not establish general resolution; preserve same-platform failing order/error capture and deterministic regression trigger. |
| #769 | Existing OpenClaw plugin present; new fingerprint requires sanitized affected fragment, versions/auth/model and still-failing same-window off/on/off control. |
| #650 | Dispatch workflows exist but scoped sender credential remains missing; owner credential provisioning then sender→receiver dispatch proof. No secret generated or value printed. |

## Coverage and limits

Fresh paginated owned/collaborator/member repository discovery plus Centeva and
pylon-code org listings found Meridian and the same five ADMIN-owned scrub
repositories, no new accessible candidates. All open scrub PR/issues refreshed:
OpenCode retains #18 (unsupported non-Claude flow gate) and release #20; Pi only
release #15; Hermes/OpenClaw/hudscrub empty. No scrub issues. Earlier plugin
fixes and their actual installed-client proof remain verified; no publication
claimed.

The queue is not empty. This checkpoint completes the accepted implementation
work and preserves explicit gates for deferred/declined proposals. It does not
claim full acceptance review of deferred SQLite architecture, actual interactive
Claude/Meowbert/nono proof, human OAuth completion or release authorization.
