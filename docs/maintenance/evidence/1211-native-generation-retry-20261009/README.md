# Native malformed tool-use generation retry (2026-10-09)

Existing draft [#1322](https://github.com/rynfar/meridian/pull/1322) continues
oldest original #1211. This increment changes only public-event diagnostics and
their tests at `0cf7aa708bf55c459109537bf84c468e72f91c1a`; production remains
`15f44351bbc8ddfd669db3254eac86736b61a02e` on main `11dc1556`.

## Directly measured native behavior

SDK 0.2.141 with Linux/x64 native 2.1.284 and independently installed native
2.1.295 both reproduce a **five-request success at maxTurns four**. The local
scripted API returns three single-tool generations, then a text-only response
marked `tool_use`. The native client retries that malformed fourth response and
makes a fifth API request. Replacing only its stop reason with `end_turn` ends
normally after four requests. Both partial-event modes reproduce this difference;
every scripted API response ID matches the public SDK generation-ID set.

[Final source qualification](round3/source/QUALIFICATION.json) and
[installed qualification](round3/installed/QUALIFICATION.json) each cover four
SDK queries / 18 directly counted local API requests. The existing versioned
Read generation guard accepts both normal cases and rejects both overflows.
No production cap, original foreground/TaskOutput predicate or Read acceptance
assertion changes. The simulated hook fates are controlled fixture data; these
are source options with source/installed SDK/native, not installed proxy proof.
No real credentials, provider model calls or actual client invocations occur.
Containers have networking disabled and read-only roots; immutable probes mount
read-only. All original native processes/pipes, SDK iterators, loopback listeners,
private runtimes and stopped containers join and are removed.

## Diagnostic correction and limits

The maintained observer now retains fixed stop-reason enums, text/thinking
presence booleans, orphan stop observations and overlapping stream starts. IDs,
response text, prompts and unrecognized stop values never leave its private maps.
Fragments and streamed starts still deduplicate by original model-message ID;
a malformed generation remains counted even if the native client retries it.
Snapshot arrays cannot mutate the observer. Unknown reasons stay `other`.

The [source round2 failure](round2/source/output/COUNTER_DISCOVERY.json) is
preserved: the probe assumed terminal stop reasons exist without partial events.
Actual SDK assistant fragments omit them. Final controls explicitly preserve
empty stop-reason sets in that mode; partial events provide the diagnostic
sequence. A causal diagnosis needs exactly one recognized terminal stop per
generation and no orphan or overlapping stop observations; empty, mixed or
`other` reasons remain uncertainty. The prepared installed round2 was [unexecuted](ROUND2_INSTALLED_UNEXECUTED.json).
All five executed discovery cohorts together make 19 SDK queries / 85 local API
requests, including that failed diagnostic cohort. None is real model traffic.

The historical real-model baseline has the same five-generation/tool-count
pattern, but its frozen observer did not retain terminal stop reasons. These
controls establish a possible native cause, **not causal attribution of that
historical query**. Its [failure and four named lineage defects](../1211-background-read-v2-20261009/round2/BASELINE_FAILURE_QUALIFICATION.json)
remain unchanged. No retrospective PASS, new budget or full before/after
acceptance is claimed. Future diagnosis requires correlated partial stop events
and owned native API-request evidence; do not repeat an uninstrumented baseline.

## Reproduction and gates

The exact [runnable probe](round3/source/probe/native-turn-counter.mjs), its
[dependencies](round3/source/probe/), [source controller](round3/source/run-control.py)
and [installed controller](round3/installed/run-control.py) are escrowed. Controllers
record the immutable image and explicit Linux source/options/native paths.
For another prepared Linux environment, preserve networking disabled and an
isolated HOME/config/tmp tree; invoke the same probe with explicit inputs:

```sh
bun native-turn-counter.mjs --source-root=/prepared/source \
  --options-root=/prepared/source --evidence-dir=/empty/owned-proof \
  --claude-executable=/prepared/source/node_modules/@anthropic-ai/claude-code/bin/claude.exe \
  --expected-cli-version=2.1.284
```

The installed tuple uses its SDK root/native executable and separately explicit
source options root, with expected native version 2.1.295. The probe erases the
inherited environment before spawning native, uses only a noncredential fixture
API key, and opens no private SDK transcript/session files. Scripted response and
request bodies remain in memory; saved observations are enums/counts/booleans.

[Final local gates](FULL_LOCAL_GATES.json): **5,854 pass / 36 skip / zero fail**
in all 22 npm-isolated batches, including pretest typecheck. Standalone typecheck
and build pass. The separately enabled certified-build Node control passes its
positive/swapped/unmatched/duplicate request-model cases; 14 focused diagnostic
and generation-bound controls pass. All original gate processes are terminal
and joined at the unchanged code head. The [root adversarial review](ROOT_ADVERSARIAL_REVIEW.json)
accepts only this diagnostic increment with inherited holds. No delegated review
or whole-change merge acceptance is asserted. [Prior delivery-head CI](PRIOR_HEAD_CI.json)
at `021bfe2e` is terminal with required test SUCCESS; it cannot validate a new head.
Owner checkout/index/twelve dirty files and all eighteen raw contributor records
remain exact. Baseline causality, mixed-auto, cancellation, caption/reporter,
broader client/platform/package, historical wait and new final-head CI remain
held. No new PR, worktree, merge, source closure, release or community comment.
