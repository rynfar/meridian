---
name: meridian-upstream-review
description: Review and merge Meridian contributor pull requests, resume that review backlog, or validate an authorized release.
---

# Meridian contributor review

This workflow applies to the selected contribution, bounded backlog, or authorized release. It does not start unrelated work or authorize extra merges, releases, external messages, delegation, or concurrent queue owners.

- For contributor assessment, merging a contributor's PR or a durable checkpoint, read [incorporation](references/incorporation.md).
- Before accepting a behavior change, read [verification](references/verification.md) and the applicable cases in repository `E2E.md`. Preserve the actual before/after evidence, tested model/platform, and remaining limitations.
- Before merging a contributor PR or release, perform the adversarial review and evidence capture in [meridian-evidence](../meridian-evidence/SKILL.md). Resolve material findings and keep the result in the PR or handoff.
- For an authorized release, read [release](references/release.md). Completing a backlog item does not authorize publication.
- When continuing earlier review work, read `docs/maintenance/REVIEW_HANDOFF.md`, refresh live GitHub and origin/main, and recover the existing scope before selecting more work.

Merge the contributor's own PR so they are the commit `Author` on `main`; a `Co-authored-by` trailer is not credit. Do not open a maintainer PR that carries their commits. Put maintainer corrections on their branch as separate signed commits. Give each contribution an evidence-backed disposition rather than merging to clear the queue. Follow `AGENTS.md` for public API, merge, identity and communication boundaries.

Complete the authorized scope through verification and corrections. Final-head CI and required live E2E remain acceptance gates. If a gate is unavailable, record the missing evidence rather than substituting mocks or claiming completion. Recheck the contributor's head immediately before merging so new work is not lost. Never close a contributor PR silently or for work that shipped. A request to pause after the current ticket means finish that ticket, checkpoint, and stop.
