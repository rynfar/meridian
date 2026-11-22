# Contribution workflow

Paths are relative to repository root. Read when committing, opening a PR, or integrating.

## Git & Workflow

### Commit format

- Format: `type: brief description`
- Types: feat, fix, refactor, perf, test, docs, chore
- No AI attribution lines

### Development workflow — NEVER push directly to main

1. Use a feature branch from current main, preferably in a fresh isolated
   worktree, preserving the user's checkout. This is for maintainer work only;
   a contributor's change lands through their own PR (see
   [Contributor pull requests](#contributor-pull-requests)).
2. Commit, push the feature branch, and create a PR targeting main. Use
   Conventional Commits and describe the final behavior and validation.
3. Run the required local checks (and affected-flow live E2E for behavior changes), then wait for all
   relevant final-head CI checks, including `test`. Recheck the head, base and
   merge state immediately before merging; a changed head invalidates old checks.
4. Normal PRs use `gh pr merge <N> --squash --match-head-commit <verified-SHA>`.
   Delete only branches owned by this workflow after they are no longer needed.
   Qualified [forwarded contributions](#forwarded-contributions) and Release
   Please PRs use `--merge` instead.
5. Verify the merged tree. Only close an issue when the validated behavior
   actually resolves it.

Squash keeps changelog entries one per PR. Preserve repository settings
`squash_merge_commit_title=PR_TITLE` and `squash_merge_commit_message=BLANK`;
do not paste intermediate conventional-commit subjects into the squash body.
No AI attribution. Do not use `--admin` or bypass checks, except for the
signing cases in step 3 below. Never run `git push origin main` directly.

### Contributor pull requests

Credit means contributors remain the Git `Author` of the commits carrying their
work on `main`, and the PR that lands that work shows as merged. A
`Co-authored-by` trailer is not credit for work they wrote.
GitHub names the PR opener as Author of a squash, so a maintainer PR that
carries a contributor's commits lands their work under the maintainer's name.
From March to October 2026 that happened to 137 contributor PRs
([#1363](https://github.com/rynfar/meridian/issues/1363),
[ledger](../../docs/maintenance/ATTRIBUTION_LEDGER.md)). Do not repeat it.

1. By default, land a contributor's change by squash-merging **their own PR**:
   `gh pr merge <their-PR> --squash --match-head-commit <verified-SHA>`.
   Never cherry-pick, rebase or retype it into a maintainer PR. The
   `Attribution` check fails any maintainer PR that carries someone else's
   commits; do not work around it. For an already-open contribution forwarded
   by another contributor, use only the [forwarded route](#forwarded-contributions)
   below; do not squash away its source authors.
2. Do not wait on the contributor for work the maintainer can do. Put
   maintainer corrections on their branch as separate signed commits
   (`gh pr checkout <their-PR>`, commit, push; every open contributor PR allows
   maintainer edits), and resolve conflicts by merging `main` into their branch.
   A normal squash then names the contributor as Author and the maintainer as
   co-author; a qualified forwarded merge retains each correction author on
   their own commit. Add commits; do not rewrite or force-push theirs.
   Co-author has to mean the maintainer changed what shipped. Put a commit on
   their branch only when it changes the fix or is needed to merge it: a
   correction, a conflict resolution, a test the change broke. Live harnesses,
   evidence records, handoff notes and unrelated cleanup go in a separate
   maintainer PR. When the only maintainer commit is a conflict-free merge of
   `main`, merge with an explicit `--body` so the squash carries no maintainer
   `Co-authored-by` line, and check the landed message.
3. `main` requires signed commits, which blocks a PR only when it holds an
   unsigned commit. Check `mergeStateStatus` before assuming a block: a fully
   signed fork PR is `CLEAN` and merges directly. When unsigned commits are the
   **only** block, merge with
   `gh pr merge <their-PR> --squash --admin --match-head-commit <verified-SHA>`.
   GitHub signs the squash and names the contributor as Author, so nobody has
   to re-sign anything. The same applies when the only block is commits that
   are signed but that GitHub cannot verify (for example `bad_email`, where the
   signing key's email is not on the contributor's account; owner-approved
   2026-10-26, #1429). `--admin` is allowed for these cases alone, and only
   after every check on that exact head is green: nothing else stops it from
   merging a red or untested head. It is never a way past a failing check, a
   missing gate or the `Attribution` check. This exception is for a signed
   squash only; it never authorizes `--admin` for a commit-preserving merge.
4. If their PR cannot be used at all (fork deleted, maintainer edits
   disabled), stop and ask the owner. Any fallback must keep the contributor as
   Author on `main`; a squashed maintainer PR never does.
5. After a normal squash, confirm that
   `git log -1 --format='%an <%ae>' <landed-SHA>` on `origin/main` names the
   source contributor. A forwarded merge requires the per-commit verification
   below; inspecting only its merge commit names the merger, not the source
   authors. Report preserved authorship only after the applicable check passes.
6. Never close a contributor PR whose work shipped; it must show as merged.
   Close a contributor PR only for work that is declined or superseded, and only
   with a posted explanation the owner approved. Comments still need the owner's
   authorization: when it has not been given, leave the PR open and put the
   draft explanation in the handoff. A silent close is never the fallback.
7. If a contributor's idea is reimplemented instead of merged, say so plainly
   in their PR and in the maintainer PR. Do not describe it as their commit.

### Forwarded contributions

Use this narrow exception only for an owner-approved, already-open PR (or
bounded batch) forwarded by another contributor whose branch retains the
source contributors' authored commits. Record that authorization before use.
Prefer an existing source-author-owned PR when one exists. This does not permit
new maintainer integration PRs, cherry-picking, rebasing, retyping, changing
Authors, or silently closing a source PR. A coauthor trailer cannot replace an
existing source author's commit in this route.

1. Record the complete commit set introduced by the exact PR head over fresh
   `origin/main`, checking paginated GitHub data against local ancestry. Record
   each SHA, Author name/email, AuthorDate, Committer and verified signature,
   plus source provenance. Compare accessible earlier source objects when the
   branch already contains copied commits. State what was copied and changed;
   preserving today's forwarded objects does not restore earlier source SHAs
   or authenticate them with the forwarding contributor's signature.
2. Complete the same product review, corrections, local checks, affected-flow
   live E2E and exact-head CI as every other contributor PR. Recheck the head,
   base, full introduced commit set, signatures, protection and mergeability.
   Merge commits must be allowed, and every retained commit must satisfy the
   signature requirement. Never use `--admin`, disable protection, rewrite or
   re-sign source commits to force this path. If it is blocked, retain the gate
   and ask the owner for an attribution-preserving alternative.
3. Merge that existing PR with
   `gh pr merge <N> --merge --match-head-commit <verified-head>`.
   Supply an explicit neutral `--subject` beginning `Merge pull request #<N>`
   and `--body-file` without conventional commit lines or release directives.
   Do not squash, rebase, copy the work to a maintainer PR or delete another
   contributor's branch.
4. Fetch the result and verify the same PR is `MERGED`, the merge commit is
   signed, its two parents are the reviewed base and exact head, and its tree
   matches the reviewed combined tree. `--match-head-commit` guards the head,
   not a concurrent base advance: re-review and validate a changed combination.
   Verify every recorded introduced author commit remains reachable unchanged
   on `origin/main` with `git merge-base --is-ancestor <SHA> origin/main`, and
   inspect its actual Author/AuthorDate with `git show --no-patch --format=fuller <SHA>`.
   Preserve the manifest and results in the review handoff. The merge commit's
   Author alone and a green Attribution check are not proof of these facts.
   Audit summaries must resolve actual commit Authors, not assign every carried
   email to the PR opener. Until a reporting tool supports mixed authors, use
   the per-commit manifest and do not present its aggregate as credit proof.
5. Preserved conventional commits may produce multiple release-note entries.
   Inspect the next generated Release Please PR for duplicates, missing work
   and unintended version directives; do not rewrite author history to tidy
   release notes. Normal squash settings remain unchanged. This route does not
   authorize release publication or external comments.

`node scripts/attribution-audit.mjs` rebuilds the ledger from git and GitHub.
Rerun it after any batch of contributor merges; a new row under "Re-landed with
the maintainer as Author" is a defect to report to the owner, not to explain away.
