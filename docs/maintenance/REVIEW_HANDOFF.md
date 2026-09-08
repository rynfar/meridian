# Upstream review handoff

Checkpoint: 2026-09-08, before the workflow-documentation PR. Refresh GitHub and
origin/main before continuing; this is a dated checkpoint, not a live queue.
The owner requested portable skills and agent instructions so either Claude,
Codex, or another repository agent can resume this work.

## Read first

Follow [meridian-upstream-review](../../.agents/skills/meridian-upstream-review/SKILL.md)
and [AGENTS.md](../../AGENTS.md). The prior review run stopped after its current
ticket and an authorized release. No new backlog fix is in progress. Continue
when the owner asks; this document does not start background work or authorize
two agents to work the same queue. A prior agent's paused/blocked goal is not a
claim that the backlog is complete.

Keep this checkpoint current after a delivered ticket or meaningful pause.
Record the item, disposition, original/delivery/base SHAs, author mapping,
worktree/branch, before/after proof, tests and E2E versions, CI URLs, merge and
closure status, limitations, and the exact next action. Put portable evidence in
the PR or linked review record; optional private local logs are not prerequisites
for discovering the workflow. Never invent test evidence if those logs are absent.

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

Prioritize bounded triage of [issue #967](https://github.com/rynfar/meridian/issues/967),
which reports a growing headless-background-job respawn loop on Meridian1.68.0.
The reporter's environment is OpenCode1.18.29, opencode-with-claude1.10.1,
Claude Code2.1.263 and a resumed Opus session. Headless jobs reportedly receive
client-tool forwarding stubs without a client able to return the result.

This is a report, **not a verified root cause, a proven regression, or an approved
implementation**. Reproduce with bounded attempts and isolated fixtures, establish
which component owns the behavior, and validate the affected model/client versions.
Their fresh Haiku attempts passed; earlier Haiku validation neither disproves the
report nor resolves it. Do not read private SDK transcript files referenced in
an issue; use supported APIs and controlled reproduction.

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
