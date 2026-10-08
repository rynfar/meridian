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

The second independent review rejected main orchestration even though the
individual finite helpers were supported. Final cleanup could race the
result-tail replacement, re-observe one cached public close through a second
time window, and write concurrent checkpoints. A new overlapping-window control
on unchanged `96bc5b2` reproduced **12 passed / 1 failed**: the first observer was
unknown while the second resolved the same late promise. This is a source-derived
fake interleaving, not a native/client failure reproduction.

Main now uses one lifecycle owner: retirement forbids new start/forward work,
tracked handlers and starts have finite observations, and each captured proxy
has one immutable bounded close outcome. Already-started late acquisitions stay
tracked and are closed without forwarding. Cleanup drains tracked work; unknown
operations or closes remain failures. Immutable snapshots have one serialized
writer and terminal seal; failed/unknown writes prevent queued overlap. The final
snapshot explicitly precedes its artifact-drain outcome, which the outer command
must retain. Injected controls use these actual main helpers for deferred close,
late close, deferred/late acquisition, no post-retirement forwarding, unknown
drain, and concurrent/failed snapshot writes.

The review also found that asynchronous forwarded-stream errors were destroyed
without preserving their cause. Main's shared forwarding helper now retains the
original upstream error before downstream destruction and checkpoints it through
the serialized writer. Its erroring-Readable control preserves that original
cause alongside later client and cleanup failures; a normal stream-finish control
stays clean. These are credentialless injected streams/promises, not actual Pi,
HTTP/native or model proof. Initial new state/type inference failures are retained
and corrected with precise declarations, without casts or ignored diagnostics. The
corrected focused suite passed **39/39 cases, 355 assertions**, with typecheck
and syntax checks; final full checks are recorded at the frozen correction head.

The third independent review found one remaining main integration window:
client failure was fed into lifecycle retirement only after a physical checkpoint.
A delayed initial or postjoin write could let an already-acquiring replacement
forward despite a failed client. On frozen `0c01c2f`, a source-order fake control
reproduced **21 passed / 1 failed**, admitting one forward before the held writer
completed. This is an injected old-order counterexample, not actual Pi/native or
model reproduction.

Main now installs `observeOwnedClient` before its first artifact await. Its
synchronous observation callback retains client failure and retires admission on
stop/error/exit/close or unknown join. Ordinary clean exit/close retires without
inventing failure. Already-acquiring proxies remain retained and closed by the
existing owner. Connected-observer controls hold initial/postjoin writes and
replacement acquisition, require zero forwarding, and retain the late close.
Other controls cover error/capture/stop/signal, deadline/missing-close, later
writer rejection/timeout and cleanup errors, original-client-cause ordering and
clean completion. They call the actual connection used by main, rather than
manually retiring it. The **45/45 focused cases, 419 assertions**, typecheck and
syntax checks passed; final full checks are recorded on the frozen correction
head. Immutable-close, serial-writer, stream-first-cause, exited-leader guards,
renderer/runtime and contributor bytes remain unchanged.

The first actual supported-client comparison used the same escrow with Pi 1.1.0,
official agy 1.2.7, Gemini 3.8 Flash Low and Darwin. Both unchanged baseline
`458cf15c` and the corrected candidate `dedf4096` failed the exact same assertion:
two successful writes to the latest target rather than one. The first write's
result arrived before the old backend's qualified close and replacement; the
second call repeated its exact target and content. Both actual clients exited
zero with closed captured pipes; public proxy closes resolved and sampled native
groups were absent after join. These failures are retained, not acceptance.

Inspection of the actual candidate replay prompt exposed two concrete weaknesses:
long common-parent paths had identical head-only target previews, and the restated
write instruction followed its completed-work recap. A separate correction keeps
both ends of the bounded 80-character target, places the restatement before recent
results, and ends that recap with brief continuation guidance. Two direct pure
regression controls fail before this correction and pass afterward. All original
contributor tests remain unchanged, including their short recap size bound.
These structural corrections do not establish that Gemini will obey the prompt;
the same actual live assertion must pass on the new candidate before acceptance.
The first paired traces and joined local/native receipts are retained under the
2026-10-08 resumption evidence packet and summarized in the delivery record.

**Live acceptance remains open.** Official account/catalog preflight is
not inference. Reporter DeepSeekHarness ACP version/OS remain unknown; a supported
Pi import success would remain qualified and would not establish exact reporter
acceptance or complete all of #1073. No OpenCode arm is included; an eventual arm
must load the installed Meridian AGY integration. Required final local checks,
independent review, exact-head CI and affected-flow live evidence remain delivery
gates, recorded against the final candidate rather than inferred from these
focused checks.
