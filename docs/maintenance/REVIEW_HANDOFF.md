# Upstream review handoff

Checkpoint: 2026-09-08, after PR #969 merged (issue #967 triage). Refresh GitHub and
origin/main before continuing; this is a dated checkpoint, not a live queue.
The owner requested portable skills and agent instructions so either Claude,
Codex, or another repository agent can resume this work.

## Read first

Follow [meridian-upstream-review](../../.agents/skills/meridian-upstream-review/SKILL.md)
and [AGENTS.md](../../AGENTS.md). The last delivered item was
[PR #969](https://github.com/rynfar/meridian/pull/969), merged. No new backlog
fix is in progress. Continue when the owner asks; this document does not start
background work or authorize two agents to work the same queue. A prior agent's
paused/blocked goal is not a claim that the backlog is complete.

Keep this checkpoint current after a delivered ticket or meaningful pause.
Record the item, disposition, original/delivery/base SHAs, author mapping,
worktree/branch, before/after proof, tests and E2E versions, CI URLs, merge and
closure status, limitations, and the exact next action. Put portable evidence in
the PR or linked review record; optional private local logs are not prerequisites
for discovering the workflow. Never invent test evidence if those logs are absent.

## Current item: issue #967 triage, delivered as PR #969

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

- **Next action:** #767's remaining surface is smaller and murkier than this
  handoff first claimed. Four of connor-grady's six captures
  (`user[tool_result,text]`) now continue. The other two were `user[text]` with
  a *single* text block, which cannot be an append — so the stored text block's
  own hash changes between requests, which lineage can only read as a turn
  edit. Why a stock client's user text re-hashes at all is the open question;
  it needs live reproduction with the per-index diagnostic from #797, not more
  code reading. Treat it as an investigation, not a known fix. The five
  unreviewed Codex-adapter PRs (#962–#966) are the better-defined next batch.

## Completed checkpoint

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

The September 8 snapshot had **32 open PRs and 18 open issues** before the
workflow-documentation PR. Refresh both lists; do not act solely on this count.

Issue #967 has been triaged and its Meridian half fixed in PR #969. Read the
current-item section above before touching it again, and do not re-derive the
two refuted inferences recorded there. The unresolved half of that report is
#767's replay driver, plus attribution that needs the reporter's tool list.

Pick one bounded item from the refreshed lists. Each is a report or proposal,
**not a verified root cause, a proven regression, or an approved
implementation**. Reproduce with bounded attempts and isolated fixtures,
establish which component owns the behavior, and validate the affected
model/client versions — a passing Haiku run neither disproves nor resolves an
Opus report. Do not read private SDK transcript files referenced in an issue;
use supported APIs and controlled reproduction.

New unreviewed contributor PRs since the prior checkpoint:

| PR | Proposed change |
|---|---|
| [#962](https://github.com/rynfar/meridian/pull/962) | Per-tier refusal ending in prose |
| [#963](https://github.com/rynfar/meridian/pull/963) | Disable auto-defer for Codex requests |
| [#964](https://github.com/rynfar/meridian/pull/964) | Codex namespace/custom tool forwarding |
| [#965](https://github.com/rynfar/meridian/pull/965) | Codex thread session identity |
| [#966](https://github.com/rynfar/meridian/pull/966) | Mid-conversation developer messages |

Existing unresolved priorities: #896/#895 (Windows session GC), #765 (Nix plugin
inputs; its head changed after the prior snapshot), #917/#933 (historical
concurrency failures), #767 (Opus-specific resume divergence), #905 (container
incarnation) and #889 (missing client environment). The full live backlog also
contains feature proposals and other issues; these lists do not approve them.

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
