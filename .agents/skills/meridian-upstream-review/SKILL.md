---
name: meridian-upstream-review
description: Review or incorporate Meridian contributor changes, resume that review backlog, or validate an authorized release.
---

# Meridian contributor review

This workflow applies to the selected contribution, bounded backlog, or authorized release. It does not start unrelated work or authorize extra merges, releases, external messages, delegation, or concurrent queue owners.

- For contributor assessment, authored cherry-picks, integration or a durable checkpoint, read [incorporation](references/incorporation.md).
- Before accepting a behavior change, read [verification](references/verification.md) and the applicable cases in repository `E2E.md`. Preserve the actual before/after evidence, tested model/platform, and remaining limitations.
- For an authorized release, read [release](references/release.md). Completing a backlog item does not authorize publication.
- When continuing earlier review work, read `docs/maintenance/REVIEW_HANDOFF.md`, refresh live GitHub and origin/main, and recover the existing scope before selecting more work.

Use an isolated task branch. Preserve contributor Author/AuthorDate and source-to-incorporated SHA mappings; put maintainer corrections in separate commits. Give each contribution an evidence-backed disposition rather than merging to clear the queue. Follow `AGENTS.md` for public API, merge, identity and communication boundaries.

Complete the authorized scope through verification and corrections. Final-head CI and required live E2E remain acceptance gates. If a gate is unavailable, record the missing evidence rather than substituting mocks or claiming completion. Recheck contributor heads before closing incorporated PRs so new work is not lost. A request to pause after the current ticket means finish that ticket, checkpoint, and stop.
