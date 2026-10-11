# Polytoken conversation identity: PR #1339 evidence

## Scope and provenance

Base: `e68b9bcadd7597d16724a3655b7322cd02a965ad`.
Implementation: `706de2c54c744015bdaafdae3b44b083a0518251` (signed; same source tree as the installed test build).
macOS arm64; Polytoken 0.8.21; locally packed Meridian 1.80.0;
real Claude Haiku 4.5 on an authenticated Team profile. The installation resolved
Claude Code 2.1.296 as an npm dependency but selected the system Claude executable;
its actual version was not recorded. Do not treat the dependency version as a runtime witness.

## Observed live results (2026-10-11)

Two parent sessions ran concurrently. In the first run, each read a synthetic file
three times before delegation. Both exited 1 with HTTP400:

```
This session advanced while the request was waiting. Retry with the latest conversation history or use a distinct session ID.
```

In the second run, parents delegated immediately. Four children completed
successfully across two parents. Every child transcript contained three separate
`file_read` turns followed by `progress_update` and `exit_tool`. Two used the
requested custom worker; the other parent chose the built-in mini worker instead.
Four distinct conversation-keyed SDK mappings were observed, each at revision 5
and messageCount 10. One child summary omitted its marker: marker-preservation
was not fully established. Both parents subsequently exited 1 with the same 400.

**Overall live E2E: FAIL. Child isolation succeeded; parent/title coexistence did not.**
A separate isolated mock-provider capture showed title requests sharing the main
`X-Polytoken-Conversation`, while siblings had stable distinct values. The live
failure at the third iteration is consistent with that collision; title timing
and per-request SDK resume options were not captured in this live run.
No claim is made that this PR fixes title inference, clear, compaction, or the
original Fable-model failure end-to-end. Real-client testing here used Haiku.

## Reproduction

`scripts/e2e-polytoken-conversations.py` is the portable version of the local
harness used above. It has been syntax/CLI checked; the refactored portable version
has not itself been live-run. It requires a running authenticated Meridian and
spends account allowance. It creates isolated HOME/XDG/config/work directories,
uses only a synthetic fixture, and does not modify production client config.

```sh
python3 scripts/e2e-polytoken-conversations.py --profile YOUR_PROFILE
python3 scripts/e2e-polytoken-conversations.py --profile YOUR_PROFILE --title-first
```

Optional `--url` and `--model` select the endpoint/model. `MERIDIAN_API_KEY` supplies
local proxy authentication if needed. The script removes that key from its saved
config after execution. Do not share configs or raw logs without inspection.
Each invocation prints a fresh artifact directory containing parent output/errors,
client transcripts, and `result.json`. Exit 0 requires both parents and four child
completion events to succeed; missing child traffic cannot pass. Inspect child
transcripts for three read rounds and inspect local Meridian mappings for distinct
SDK sessions. The script does not export private SDK transcripts or credentials.

## Automated checks

- Full `npm test` passed with Node 22.23.3, including typecheck and isolated suites.
- Native Node 26 run: 5159 pass, 35 skip, one failure because an unrelated
  Antigravity test invoked unsupported `--experimental-transform-types`.
- Typecheck, build, and diff whitespace check passed.
- Deterministic HTTP integration tests assert sibling parallelism and that each
  continuation resumes its own SDK ID. Another test retains stale-request rejection
  for the same conversation, even when session correlation headers differ.
- Unit/detection tests cover trimmed preference, conversation-only identity,
  blank fallback, absent identity, and unrelated native-header isolation.

## Adversarial review

Reviewed adapter/detection changes, call sites using adapter identity, documentation,
legacy compatibility, same-key guards, capture redaction, and regression assertions.
The patch intentionally leaves session-ID fallback for older clients and keeps the
shared identity machinery rather than adding provider logic to server orchestration.
No authentication trust is added; header values remain untrusted client-selected keys.
Conversation changes intentionally select new resume/routing keys. First use after
upgrade can cold-replay instead of resuming a legacy session-keyed entry.

Findings: (1) title requests still collide and can fail the main turn, not just the
auxiliary task; documented prominently and not masked by weakening the guard.
(2) Claiming that all native headerless requests are fingerprint-free is too broad;
only identity selection is guaranteed here, so the adapter comment now says it
returns no identity. (3) Live evidence was only local; this record and portable
harness preserve the reproducible scenario without publishing private transcripts.
(4) Clear/compact and original-model live coverage remain missing.

No independent second-person review has occurred. This is a separate adversarial
self-review, not a maintainer approval. Final-head CI still needs maintainer approval
for fork workflows and must pass before merge. This is a narrow child-isolation
fix, not certification of the complete Polytoken integration.
