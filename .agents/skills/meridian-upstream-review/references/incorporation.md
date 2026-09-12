# Contributor review and incorporation

Use the sections for the current phase.

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

## Merge only what was validated

- Finish all local required gates, push the integration branch and wait for all relevant final-head CI checks. Any source change, rebase or changed base requires impact-appropriate revalidation; obsolete green runs do not validate a new head.
- Immediately before merge, re-read PR head/base and merge state. Use `--match-head-commit` with the verified head. Normal PRs use `--squash`; Release Please PRs use `--merge`. Confirm the merged tree corresponds to the validated tree.
- After successful integration, recheck the original contributor PR head before closing it as incorporated. Do not discard new contributor commits that arrived during review. Close linked issues only when the evidence supports their resolution.
- Do not post GitHub comments, email, Slack or other messages to people without explicit authorization. Draft any explanation locally. PR creation/editing and authorized integration are separate from permission to send community messages.

## Checkpoint and hand off

Update [docs/maintenance/REVIEW_HANDOFF.md](../../../../docs/maintenance/REVIEW_HANDOFF.md) as the portable checkpoint and keep per-item evidence in the PR or a linked review record. Local logs can supplement these records but must not be the only way another agent learns the status. Record item/disposition, original and delivery commits, author mapping, worktree, changes, commands, before/after failures, E2E versions, CI links, merge/closure status, known limitations and the next action. Keep historical logs, but replace contradictory status in the current handoff.

The owner may pause after the current ticket. Finish only that ticket, save a checkpoint and stop. A handoff to another agent is not authority for two agents to resume the same queue concurrently. On continuation, the receiving agent refreshes GitHub and chooses one bounded item using this process. Do not treat a release as completion of the whole backlog.
