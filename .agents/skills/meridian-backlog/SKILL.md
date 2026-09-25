---
name: meridian-backlog
description: Review and resolve an authorized queue of pull requests and issues across Meridian and the owner's scrub repositories, including newly discovered scrub repos.
---

# Meridian and scrub backlog

Use this when the owner asks to work through pending PRs/issues or resume that work. Continue across actionable items without asking for a new instruction after each one. A skill does not itself authorize merges, publication, external comments, or work outside the requested queue; use the authorization in the current conversation and each repository's rules. A wording-only edit does not start this queue.

## Find the whole queue

1. Read repository `AGENTS.md` and the current [review handoff](../../../docs/maintenance/REVIEW_HANDOFF.md) when resuming an active batch. Treat dates and statuses there as leads; refresh GitHub and `origin/main` (or that repo's default branch) before acting.
2. Identify the GitHub owner from Meridian's `origin` and the authenticated account. List that account's repositories and accessible organization repositories with pagination; include `meridian` and every repository whose name contains `scrub` (including `hudscrub`) that the account owns or has management rights to. Follow scrub repository links in Meridian's plugin docs to catch renamed or differently owned repos, and verify permissions before mutation. Do not use a fixed five-repo list: discover new, private, and archived repos, and record inaccessible candidates as coverage gaps.
3. Fetch all open PRs and issues for each repo with pagination. Review PRs first; then work through issues by newest creation date across the repos. Respect a reporter's explicit “do not review” request, drafts, and an existing owner/deferred decision. Escalate an older critical regression ahead of this order only with a recorded reason. Refresh the queue once after merges, since Release Please and follow-up PRs can appear.

## Decide and deliver

- Read the complete PR diff, commits, discussion, linked issue, current main, relevant callers, tests, and the repo's README/product goals. In Meridian, consult `ARCHITECTURE.md`, `DESIGN.md`, the API contract, and `E2E.md` when applicable. A green check, contributor request, or plausible code change is not a product decision.
- Give every reviewed PR and issue an explicit disposition: accept, accept with correction, already covered, defer with an observable revisit trigger, or decline with a concrete reason. Reproduce an issue on the current published version and current main when relevant; avoid fixing a stale report by assumption. Record the exact source/head SHA and why the proposed behavior fits or conflicts with the app.
- For contributor code, follow [meridian-upstream-review](../meridian-upstream-review/SKILL.md): cherry-pick the actual authored commits in an isolated branch from fresh main, preserve Author and AuthorDate, map source to incorporated SHAs, and put maintainer corrections in separate commits. Verify human credit on the final squash commit. Never rewrite a contribution under maintainer authorship merely to clear a PR.
- For a new fix, create a focused PR from an isolated branch. Link the PR to the active thread when that facility is available. Apply the repository's [contribution workflow](../../references/contributing.md) for commits, CI, exact-head merge, and source PR closure. Do not close a report until validated behavior actually resolves it; do not send comments or messages without authorization.
- Before any merge or release, use [meridian-evidence](../meridian-evidence/SKILL.md) for an adversarial review, meaningful regression controls, headless E2E where needed, and a durable evidence record. Recheck PR head, base, source contributor head, checks, and mergeability immediately before integration. Never use stale green CI to validate a changed head or bypass checks routinely.
- Release only under explicit release authorization, through each repo's Release Please workflow and [release guidance](../meridian-upstream-review/references/release.md). Check the exact candidate diff, version metadata, final-head CI, real client flow, published package integrity/provenance, and a fresh registry-installed flow. A merged release PR is not proof that the package published.

Keep the [handoff](../../../docs/maintenance/REVIEW_HANDOFF.md) current with linked PRs, source and delivery SHAs, evidence, blocked gates, and revisit triggers. Continue on independently actionable work while one item waits. Finish the authorized queue when each item has a defensible disposition and all authorized merge/release work is verified; say plainly which items remain blocked and why. Do not claim the whole queue is cleared because a single PR merged.
