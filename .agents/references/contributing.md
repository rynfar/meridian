# Contribution workflow

Paths are relative to repository root. Read when committing, opening a PR, or integrating.

## Git & Workflow

### Commit format

- Format: `type: brief description`
- Types: feat, fix, refactor, perf, test, docs, chore
- No AI attribution lines

### Development workflow — NEVER push directly to main

1. Use a feature branch from current main, preferably in a fresh isolated
   worktree, preserving the user's checkout. For upstream reviews, use the
   `meridian-upstream-review` skill to assess desirability and preserve contributor
   Author/AuthorDate through cherry-picks and separate maintainer corrections.
2. Commit, push the feature branch, and create a PR targeting main. Use
   Conventional Commits and describe the final behavior and validation.
3. Run the required local checks (and affected-flow live E2E for behavior changes), then wait for all
   relevant final-head CI checks, including `test`. Recheck the head, base and
   merge state immediately before merging; a changed head invalidates old checks.
4. Normal PRs use `gh pr merge <N> --squash --match-head-commit <verified-SHA>`.
   Delete only branches owned by this workflow after they are no longer needed.
   Release Please PRs use `--merge` instead.
5. Verify the merged tree and contributor credit. Recheck an incorporated
   original PR's head before closing it, so newer contributor work is not lost.
   Only close an issue when the validated behavior actually resolves it.

Squash keeps changelog entries one per PR. Preserve repository settings
`squash_merge_commit_title=PR_TITLE` and `squash_merge_commit_message=BLANK`;
do not paste intermediate conventional-commit subjects into the squash body.
Verify human contributor credit instead of assuming every maintainer integration
PR automatically receives all needed co-author trailers. No AI attribution.

Signed-commit requirements can block a contributor PR. Inspect the actual block;
use an authored cherry-pick in a maintainer integration PR when needed, with
separate maintainer fixes. Never retype a contribution under your own authorship.
Do not routinely use `--admin` or bypass checks.

Do not post comments or send messages to others without explicit authorization;
draft explanations locally. Never run `git push origin main` directly.
