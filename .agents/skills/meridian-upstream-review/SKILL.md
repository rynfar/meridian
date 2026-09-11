---
name: meridian-upstream-review
description: Review and incorporate Meridian contributor PRs and issues, validate maintainer fixes with real E2E, prepare authorized releases, and resume the review backlog from its checked-in handoff.
---

# Meridian upstream review

Use this workflow for Meridian PR/issue review and incorporation, an authorized release, or resuming that work. For unrelated tasks, follow AGENTS.md without starting this queue. This skill defines how to perform authorized work; it does not authorize extra merges, releases, messages, delegation or concurrent agents.

Read [AGENTS.md](../../../AGENTS.md) for repository constraints. When continuing earlier work, read [REVIEW_HANDOFF.md](../../../docs/maintenance/REVIEW_HANDOFF.md) first, then refresh live GitHub state. Current user instructions override older memory and checkpoint text. Do not require a private chat, Codex goal, or personal memory directory to proceed.

## Decide whether the change belongs

1. Refresh origin/main and the live PR/issue inventory before selecting work. Record base SHA, contributor head SHA, linked issue, author and authored date. Read the full diff and neighboring code. CI status and PR descriptions are evidence inputs, not approval.
2. Confirm the reported behavior on current main and explain the desired behavior. Assess scope, architecture, stable API compatibility, session/history integrity, cache behavior, error handling, concurrency, affected clients and platforms. A requested feature is not automatically a desirable change.
3. Give each item an explicit disposition: accept as proposed, accept with maintainer corrections, superseded with linked evidence, defer pending a decision/environment, or decline with a concrete reason. Do not merge merely to clear the queue.

## Preserve authorship while fixing it ourselves

- Use a fresh isolated worktree and a `codex/` feature branch based on fetched origin/main unless the owner explicitly chose another branch name. Do not switch or reset the user's checkout, reuse an old delivery branch blindly, or disturb existing worktrees.
- Cherry-pick the contributor's actual commits, preserving Author and AuthorDate; use the repository's signing setup. Record original-to-incorporated SHA mappings. Resolve conflicts against current behavior, then put maintainer corrections in separate commits. Never retype the contribution and claim it as new maintainer work.
- Create a maintainer integration PR targeting main that credits the original author, links the source PR and issue, explains the final behavior and provides validation evidence. Follow Conventional Commits; no AI attribution.
- Normal implementation PRs use squash merging to keep Release Please's changelog to one entry per PR. Confirm the original contributor receives credit on the resulting commit; preserve the source/cherry-pick authorship evidence in the review ledger. Do not assume an unrelated maintainer PR necessarily auto-generates every needed human co-author trailer. If explicit human credit is needed, use only verified contributor identities and avoid conventional-commit subjects in the squash body.
- Repository settings verified 2026-09-08: PR_TITLE / BLANK. Do not bypass checks with routine `--admin`, force-push a contributor branch, push directly to main, or change those settings.

## Prove the fix and protect existing behavior

- Reproduce the actual defect before changing it whenever possible. Retain failed-before and passed-after evidence for the same meaningful assertion. A changed fixture or reduced assertion must be explained; an unreproduced bug stays explicitly unproven.
- Run targeted pure/unit tests and HTTP integration tests through the mocked SDK where appropriate. The full gate is `npm test`, not a bare all-files `bun test`: the npm script isolates process-global SDK/module mocks. Also run `npm run typecheck` and `npm run build`.
- Every accepted behavior change requires live E2E with the real SDK/model and affected client flow before it is called complete. Mocks alone do not prove a fix. Consult current [E2E.md](../../../E2E.md); use the exact installed client/SDK/CLI versions and record them, flags, model, workdir, artifact, exit status and log path.
- For changes to passthrough, lineage, resume, tool hooks, or request identity, run all four E41 modes: sequential/parallel × streaming/nonstreaming. Check exact call/result pairing, durable resume/fork history, unchanged source history and cache continuity. For relevant V2 changes run E42 with each supported pinned beta, live extended flows and separate client/proxy working directories. Test both source and independently installed package when packaging/plugin behavior is involved.
- Include adversarial controls: ordinary success, invalid inputs, retry bounds, cancellation, concurrent sessions, changed requests and retained tool results as relevant. Test the actual implicated model and platform; Haiku success is not Opus validation, and POSIX path fixtures are not a real Windows run.
- Use isolated ports, config/session directories and fixture workdirs. Keep credentials and customer transcripts out of logs. Inspect SDK sessions only through supported APIs such as getSessionMessages/listSessions; never read or edit private SDK transcript files. Preserve failed logs as well as passing logs.
- Reach for an existing gate before building a probe. The committed gates already carry the port reservation, server auth, isolated XDG/HOME state and warm-server setup that an ad-hoc harness gets wrong, and a wrong harness produces a confident false negative: a hand-built probe once reported `provider.no-route` against a working feature and nearly became a fabricated product bug. If you must build one, first run it against a known-good control so a failure means something. When a probe contradicts a hand-verified live result, suspect the probe.
- Do not infer a host or SDK shape from types, docs or memory when the behaviour depends on it. Instrument and read the actual object. A draft `Provider.Info` looked like it carried the configured base URL; printing it showed it carries no URL at all, which changed the design. One debug print is cheaper than a plausible wrong assumption.
- Assert deterministic facts, not model wording. A gate that requires specific generated text fails at random; check the request, header, effort, status or recorded trace instead, and record the prose without asserting it.
- Do not call a flaky failure fixed because a rerun passes. Establish causality, otherwise retain an unresolved status and its limitation. If actual E2E is unavailable, record the missing requirement and leave the item incomplete rather than substituting mocks.
- Aim for no regressions and only useful improvements; state the evidence and remaining uncertainty instead of promising universal absence of bugs.

## Merge only what was validated

- Finish all local required gates, push the integration branch and wait for all relevant final-head CI checks. Any source change, rebase or changed base requires impact-appropriate revalidation; obsolete green runs do not validate a new head.
- Immediately before merge, re-read PR head/base and merge state. Use `--match-head-commit` with the verified head. Normal PRs use `--squash`; Release Please PRs use `--merge`. Confirm the merged tree corresponds to the validated tree.
- After successful integration, recheck the original contributor PR head before closing it as incorporated. Do not discard new contributor commits that arrived during review. Close linked issues only when the evidence supports their resolution.
- Do not post GitHub comments, email, Slack or other messages to people without explicit authorization. Draft any explanation locally. PR creation/editing and authorized integration are separate from permission to send community messages.

## Release

For an authorized release, read [references/release.md](references/release.md).
A backlog review does not itself authorize a release.

## Checkpoint and hand off

Update [docs/maintenance/REVIEW_HANDOFF.md](../../../docs/maintenance/REVIEW_HANDOFF.md) as the portable checkpoint and keep per-item evidence in the PR or a linked review record. Local logs can supplement these records but must not be the only way another agent learns the status. Record item/disposition, original and delivery commits, author mapping, worktree, changes, commands, before/after failures, E2E versions, CI links, merge/closure status, known limitations and the next action. Keep historical logs, but replace contradictory status in the current handoff.

The owner may pause after the current ticket. Finish only that ticket, save a checkpoint and stop. A handoff to another agent is not authority for two agents to resume the same queue concurrently. On continuation, the receiving agent refreshes GitHub and chooses one bounded item using this process. Do not treat a release as completion of the whole backlog.
