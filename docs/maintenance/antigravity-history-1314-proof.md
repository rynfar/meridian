# Antigravity request-focus and bounded-recap proof (#1073 / #1314)

This change preserves the full client history as the final, byte-equivalent JSON
value while restating the newest typed request before it. Tool-result-only tails
continue using that typed request. Cd1s's authored commit
`d1a13085a4f23ec6f93965455e5b2ef4d3169c47` was incorporated as signed commit
`80d4b9667f5be9e25b9a9720935844e2ea02712f`, preserving Author and AuthorDate.
Maintainer corrections are separate commits.

On unchanged main `458cf15c59dc5ff99f50bf4dea4a002ff44b947f`, the contributor's
nine request-focus cases failed; the submitted change passed all nine. Independent
adversarial checks then reproduced two defects in the submitted renderer:

- A 200k assistant string or text block was copied into the added recent-work
  recap. The prefix before authoritative history grew to 202,264 / 202,289 chars.
- A completed large write with `content` before `file_path` lost its target from
  the recap's first-200-character serialized input preview.

The same submitted source was checked locally with the unchanged contributor
nine cases plus nine adversarial cases: **9 passed / 9 failed**, exit 1. The first
maintainer correction passed the identical 18 cases, with 67 assertions and a
separate successful typecheck, using Bun 1.3.11. Full stdout/stderr, exact test and
source bytes, commands and private fixture environments are retained in the
review evidence packet and should accompany the PR review artifact.

Corrections bound recent-work JSON to 4,000 characters including its omission
notice and separately bound earlier-call summaries to 4,000. They clip text and
media representations, select complete latest call/result batches, retain exact
normal IDs, error flags and independently extracted targets, and omit oversized
identities or batches with an explicit partial-recap notice. They never slice a
partial JSON record. Pending/error/partial histories do not receive the generic
"prior tool work is done" reminder. Short ordinary contributor cases retain their
asserted format; the newest request's head/tail and full authoritative history
remain intact. Many-call, parallel/error, long-ID collision, pending, media and
large content-first controls cover these boundaries. Pending/raw-media controls
are pure defenses, not claims of reproduced public-parser or attachment flows.

The reusable opt-in [Pi long-history escrow](../../scripts/e2e-antigravity-pi-history.mjs)
and [E2E instructions](../../E2E.md#antigravity-imported-long-history-replay-1073--1314)
use current isolated Pi 1.1.0, official agy 1.2.7, Gemini 3.8 Flash Low and an
imported public v3 session. Its actual client wire, exact new target/action,
filesystem bytes, correlated read/write results and completed-result-tail
recovery are independent of model prose. Pure fixture/lifecycle tests exercise
rejected import shapes and fake client spawn/error/cap/deadline events without
launching a client or proving native cleanup.

The first added fixture-test typecheck failed because an untyped JS session
entry inferred `unknown`; later lifecycle callback/state inference also failed
typecheck. The preserved failures were corrected through explicit
public-format validation in the test and precise script type annotations, without
casts or ignores. The final focused checks passed **24/24 cases, 266 assertions**
and typecheck on Bun 1.3.11. Deprecated
Pi 0.72.1 and an unavailable unbundled `dist` protocol path were preparation
drafts, never live success. Current escrow selects
a built source checkout with Bun 1.3.11 for its separate pure protocol inspection;
it does not establish installed Meridian package equivalence.

The first independent whole-change review rejected escrow readiness for two
concrete source defects. Its agy 1.3.1 pin contradicted the unchanged baseline
and candidate runtime's exact 1.2.7 guard; the escrow and docs now require 1.2.7
without changing that guard. Version/config/catalog preflight remains distinct
from actual model acceptance.

Its close-only client wait could hang after leader exit with held pipes and
prevent artifact retention. Three new fake-event controls failed on the frozen
escrow (**6 passed / 3 failed**). Client exit/stop now starts a finite close grace;
missing close is a permanently failed/unknown outcome. Failed signal attempts
remain recorded without replacing the first error; no signal uses an exited
leader. Local pipe destruction or late close is explicitly distinct from native
cleanup. Public/relay close waits are finite; artifact checkpoints precede waits
and retain separate cleanup failures before the CLI's nonzero termination. The
fake controls cover held pipes, missing/late close, error then exit before
escalation, failed escalation and unknown/rejected public close. They do not
establish actual OS/native joins.

Root also reproduced a valid long temp path rejected by the escrow's full-path
recap predicate. The corrected advisory predicate accepts only the bounded
target projection on the exact current fixture call. A long-path pure control
retains that original false negative and rejects wrong call/target or altered
full history; actual wire targets, correlated results and file bytes stay exact.
The corrected focused suite passed **30/30 cases, 296 assertions**, plus
typecheck on Bun 1.3.11. A first new typecheck failure from the finite-test
sentinel's inferred `unknown` was retained and corrected by an explicit typed
promise and narrowing; no casts or ignored diagnostics were used. Full final
gates are recorded against the subsequent frozen correction head.

**Live status at preparation: not run.** Official account/catalog preflight is
not inference. Reporter DeepSeekHarness ACP version/OS remain unknown; a supported
Pi import success would remain qualified and would not establish exact reporter
acceptance or complete all of #1073. No OpenCode arm is included; an eventual arm
must load the installed Meridian AGY integration. Required final local checks,
independent review, exact-head CI and affected-flow live evidence remain delivery
gates, recorded against the final candidate rather than inferred from these
focused checks.
