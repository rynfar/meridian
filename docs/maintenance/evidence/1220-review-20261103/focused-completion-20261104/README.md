# Focused completion investigation — #1220 merged 2026-11-05

**[#1220 is MERGED](https://github.com/rynfar/meridian/pull/1220)** at `41d7b3e3a2ead7e95e2790cc473b469bd3e9b567`, after explicit owner acceptance of the disclosed remaining verification risks. Signed landed parents/tree match the exact reviewed `ba0f9f5c` candidate and `16c21494` base. All22 introduced authored objects remain unchanged and reachable on main. [Merge and credit proof](owner-approved-merge/README.md). No provider contact or release. The investigation below preserves failures and missing evidence; those results are not relabelled PASS. [Prior final-source checkpoint](../final-source-1220-20261104/README.md).

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

One full qualification with isolated **Bun 1.4.3**, matching required CI, on Darwin arm64/Node 22 with qualified SQLite 3.53.4 **PASSED: 8,857 tests /65 skip /0 fail, all 28 groups; standalone typecheck PASS; certified build PASS**. The candidate head/tree and clean worktree were verified after completion. Ambient Bun 1.3.14 was not upgraded. Earlier local red remains recorded. This is environment-qualified, not proof that an old failure was fixed. [Plan and binary hash](ci-matching-local-runtime-plan.json), [result receipt](candidate-bun143-qualification-receipt.json), [build provenance](candidate-bun143-build-provenance.json), [npm log](candidate-bun143-full-npm.log.gz), [typecheck log](candidate-bun143-typecheck.log.gz), [build log](candidate-bun143-build.log.gz).

No local/model jobs are active. Live acceptance and explicit dispositions remain missing. This statement originally blocked merge. It is superseded only by the owner's explicit disclosed-risk approval in [the merge record](owner-approved-merge/owner-risk-approval.json), not by additional live acceptance.

No production constants changed. Existing CI, actual installed-client and chain-JSON evidence remain valid at the same final head. Missing E41 modes and historical cache/native/initializer/fingerprint uncertainties remain unresolved; the owner accepted their disclosed residual risk for this merge. Contributor commits and the owner's checkout remain untouched.
