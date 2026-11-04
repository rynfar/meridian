# Focused completion investigation — 2026-11-04

#1220 remains open at `ba0f9f5c70f94cebdbd10aa0f5dbd12793f29e2a`, against accepted main `16c214941bf3f05aa4015a70d8b81bd94857a88f`. Fresh GitHub checks are green; head/base are unchanged and CLEAN/MERGEABLE. The owner requests completion and landing for the waiting contributor. No merge or release is inferred from partial evidence. [Prior final-source checkpoint](../final-source-1220-20261104/README.md).

## Native SSE refusal and input integrity

Supported SDK history records native `stop_reason: refusal` and safeguard classification `[cyber]` for the ordinary owned-file read. The provider diagnostic says non-cyber work can be incorrectly flagged. This identifies the refusal class, not its private trigger or a cure.

Independent source/hash reconstruction exactly matches the frozen observer's Q1 and Q2 prompt hashes. Q2 contains only the correctly paired `REALOUTPUT[alpha]` result. There is no error flag, denial, assistant echo, added instruction or missing result. Supported native prefixes match passing JSON after normalizing owned paths, UUIDs and paired tool IDs. Both passthrough transports use the same model-facing query builder and request partial messages. No concrete replay fault or justified source correction was found.

- [Independent findings](focused-sse-refusal-findings-20261104.md)
- [Exact prompt reconstruction](sse-investigation/sdk-prompt-reconstruction.json)
- [Normalized native prefix comparison](normalized-supported-prefix-comparison.json)
- [Native refusal diagnosis](native-refusal-diagnosis.json)

**The candidate SSE arm remains failed; parallel JSON/SSE remain unrun.** No prompt rewording or safeguard bypass was attempted. The one predeclared accepted-main SSE causal control was **not run**: a read-only personal usage preflight returned HTTP 429 and current billing admission was unavailable. Zero model calls, refreshes or owner credential writes. No automated polling or account switch. [Disposition](baseline-SSE-control-disposition.json).

## Antigravity local 503 control

The isolated accepted-main diagnostic changes only the message on the original HTTP-200 assertion to include the response body, matching sibling-test precedent. It changes no production code, fixture, timing, assertions or limits. The exact test was frozen read-only before execution.

- Original first case: **1 pass /0 fail**, original deadlines.
- Accepted-main full suite in suite context: **8,829 pass /65 skip /0 fail**, all **28 groups**, including all six Antigravity idle cases.
- [Independent source finding](focused-antigravity-findings-20261104.md)
- [Plan](antigravity-capture-plan.json), [receipt](accepted-main-suitecontext-receipt.json), [compressed full log](accepted-main-suitecontext.log.gz)

The original contributor failure (HTTP 503 after 20.01 s) was **not reproduced or explained**. These diagnostic passes are not a causal fix.

## Unchanged contributor: CI-matched local qualification

One full `npm test`, standalone typecheck and build is running with isolated **Bun 1.4.3**, matching required CI, on Darwin arm64/Node 22 with qualified SQLite 3.53.4. The candidate head is unchanged; ambient Bun 1.3.14 was not upgraded. Earlier local red remains recorded. A new-runner pass would be environment-qualified, not proof that an old failure was fixed. [Plan and binary hash](ci-matching-local-runtime-plan.json).

No production constants changed. Existing CI, actual installed-client and chain-JSON evidence remain valid at the same final head. Missing E41 modes and historical cache/native/initializer/fingerprint uncertainties are not waived. Contributor commits and the owner's checkout remain untouched.
