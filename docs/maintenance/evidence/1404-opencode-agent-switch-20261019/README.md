# OpenCode primary-agent switch: issue #1404

**2026-10-20 update:** [Reporter OpenCode 2.0.31 qualification](reporter-2031/README.md)
now supplies the exact reported client/native/Linux/model proof, four live E41
arms and source/installed E42 matrix. The earlier records below remain historical;
their missing reporter-version and adjacent-flow gates are superseded by that
record. The separate historical Opus task remains unresolved.

[Draft PR #1423](https://github.com/rynfar/meridian/pull/1423) contains the fix.
Product source tested: `4e90948a22b6436ed1f4c2b7148f454984f04549`, based on
`d0326e28255d84a8df70e6d2629fb1e2478c79ae`. The issue remains open.

The real SDK/native CLI restores its initial system prompt on ordinary resume
and forks, even when a new prompt accompanies the resume. A primary-agent
switch therefore needs complete client-history replay. The final guard uses
the matching OpenCode plugin's explicit primary-agent identity. It preserves
same-agent dynamic-context resume, headerless clients and existing subagent
scoping. A legacy mapping with no adapter context proof replays once when
explicit primary-agent identity becomes available. Disabled client prompts
do not add this replay trigger. Prompt text is never stored.

## Actual before and after

Both runs used actual OpenCode **2.0.21**, the corresponding installed Meridian
V2 plugin, server scrub **0.2.3**, SDK **0.2.141**, native Claude **2.1.301** and
actual **Haiku 5.5**, on **Debian bookworm Linux arm64** under Node **24.20.0**.
The candidate was independently installed from the clean source build's npm
tarball. [Artifact provenance](artifact-provenance.json) records its hash and
source certification. No private SDK transcript file was read or edited.

The [committed harness](../../../../scripts/e2e-opencode-agent-switch.mjs) starts
an isolated actual OpenCode server, executes real `setup --v2`, checks the
configured plugin path, actual model discovery/catalog adoption, plugin-generated
session/agent identity, required signed build turns and active server-scrub
invocation. The reviewer retains the report's `mode: all`: the plugin deliberately
withholds human-routing attestation for that mode while sending primary-agent
identity. An owned primary-system marker distinguishes hidden title generations.

| Turn | Initial build | Switch to reviewer | Same reviewer | Return to build |
|---|---|---|---|---|
| Baseline model-facing system contains reviewer canary | false | false | false | false |
| Candidate model-facing system contains reviewer canary | false | true | true | false |
| Candidate actual answer contains reviewer canary | false | true | true | false |
| Candidate SDK resume | false | false | true | false |

[Baseline receipt](baseline-live.json): the expected stale-instruction failure.
[Candidate receipt](candidate-live.json): passed. The first user-history marker
survived all four turns in each run. Each run made **five actual Haiku 5.5
generations**, including the detached title generation; every provider response
reported that model and a clean `end_turn`. Neither run observed refusal or a
fallback model. Original subprocess and pipe handles all joined. The access-only
grant was removed; no owner credential was refreshed or changed, and paid extra
usage was disabled.

## Regression review and failed probes

An earlier whole-system-prompt digest was too broad: the unchanged fingerprint
suite requires resume across dynamic file trees and diagnostics. Its
[five failing cases](initial-dynamic-context-failures.txt) are retained. The final
implementation fingerprints only explicit primary-agent identity, and those
original tests pass without edits. The earlier
[legacy-fixture failures](initial-legacy-fixture-failures.txt) are historical;
the final narrowed implementation requires no changes to those fixture files.

The focused **26/26** run covers both response modes, primary-agent switch and
return, unchanged-agent dynamic context, exact pending tool call/result retention,
one-time legacy proof, durable priority publication/reload/rollback and malformed
context proof. Core raw-history ownership/concurrency classification remains in
charge; the new guard only revokes SDK reuse. All four publication paths carry
the digest, and replay does not inherit old rollback/checkpoint UUID authority.

The first live harness attempt failed before a usable generation witness.
[Initial receipt](harness-initial-live-failure.json),
[HEAD-response diagnostic](head-response-diagnostic.json) and
[HEAD-cancellation diagnostic](head-cancel-diagnostic.json) preserve those failures.
The relay had treated a bodyless OAuth startup `HEAD /api/hello` response, and
then cancellation of that optional probe, as fatal. Handling those cases fixed
the harness. A [generation-denied diagnostic](generation-denied-diagnostic.json)
then reached `/v1/messages` and rejected every generation before forwarding;
that diagnostic is not model-acceptance evidence. Only the qualified before/after
receipts above establish the product behavior.

## Final local checks

The final product head passes `npm test`: **6992 pass / 36 skip / 0 fail**,
including the pretest typecheck and all **24** isolated invocations. Standalone
typecheck and build also pass on pinned Bun 1.3.11. [Receipt and log hashes](validation.json).

## Remaining gates and scope

The reporter's **OpenCode 2.0.31** is outside the current setup allowlist. This
proof qualifies the same defect on supported 2.0.21; it does not qualify 2.0.31.
The four live E41 arms, existing unexplained Opus model/cache holds and final-head
CI remain acceptance gates. The new Haiku agent-switch task did not retry or replace the earlier
refused Opus load task. Same-agent instruction hot edits retain the existing
native resume limitation. No release or Mac notarization was attempted.

The [queue refresh](queue-refresh.json) covers 165 visible repositories and all
six managed queues, with no coverage gap. Existing owner/API/platform/draft holds
remain. No issue has been closed on this partial acceptance record.
