---
name: meridian-evidence
description: Adversarially review Meridian or scrub changes and preserve reproducible E2E, headless, and visual proof for PRs, critical fixes, merges, and releases.
---

# Review and proof

Use this for every proposed PR and release in the Meridian family, and for issue fixes whose behavior must be demonstrated. Read the target repo's `AGENTS.md`, its validation scripts, and Meridian's [E2E cases](../../../E2E.md) when affected. Match the test to the reported client, model, SDK, and platform; a nearby model, mock, or different client cannot prove the reported failure is gone.

## Adversarial pass before landing

Independently inspect the complete final diff against current main and try to falsify its claims. Check product intent, stale base or hidden changed files, public contracts, unsupported clients/platforms, history/cache/session integrity, error and cancellation paths, concurrency, packaging/version metadata, and whether tests would pass if the defect remained. Check negative controls so a broad filter does not change unrelated traffic. For docs and instructions, look for contradictory rules, broken links, and unsafe implied authority. Record concrete findings and their resolution, or what was inspected if no finding survives. Re-run affected checks after each material correction; the final-head CI gate still applies.

## Preserve an E2E proof trail

- For a critical defect, first capture the actual failure on the published or unchanged baseline when feasible. Use a headless CLI/API harness with isolated config, session directories, ports, and fixture workdir. Assert deterministic request, response, state, and exit facts; do not rely on generated model wording or a green rerun after an unexplained failure. Escrow the runnable harness itself: commit it in the affected repository or the integration repository that owns the real client path, even if real credentials mean it runs manually rather than in CI. If committing it is infeasible, attach the exact sanitized script as a durable PR/CI artifact, explain the constraint, and keep the missing repository test as an explicit follow-up gate.
- Run the same meaningful assertion after the fix with the actual implicated model, SDK, client, and platform. Include relevant adjacent flows and a negative control. For packages and releases, test an independently installed tarball and then a fresh registry install. Do not call a release complete until publication and installed-package behavior are verified.
- Escrow the proof beyond the agent's temporary files: put a concise evidence record in the PR body or durable review handoff with baseline/final SHAs, client/model/SDK/platform versions, harness command or committed test path, assertion and exit result, CI run, and artifact links. Retain sanitized before/after logs, traces, screenshots, or recordings in a shareable PR/CI artifact location when available. A `/tmp` path alone is not a durable handoff. Never expose tokens, raw customer transcripts, private SDK files, or pairing URLs.
- For visible UI or motion, capture before/after images and a short targeted video when motion or timing matters. Reuse an authorized collaborative browser/device session and its recording/screenshot tools when available; inspect the final media for secrets and upload PR-only media to GitHub rather than committing it to source. For a backend or CLI issue, headless traces and assertions are usually clearer evidence than video.

State missing evidence explicitly. If the real affected flow cannot run, leave the acceptance or release gate open, preserve the runnable probe and failure reason, and continue independent queue work. Do not replace it with a synthetic success claim.
