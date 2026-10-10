# Completed native tool-stream interruption correction

**Status:** scoped native correction proved; whole integration remains held.
Existing draft [Meridian #1322](https://github.com/rynfar/meridian/pull/1322)
continues oldest original #1211. Source #1211/#1231/#1283/#1292 remain open;
expanded #1231 remains excluded. No new PR/worktree, owner-checkout mutation,
release or community comment.

Unchanged delivery `cfacfd36` rejects a fully generated client tool checkpoint
when the provider’s SSE body remains open during owned interruption. Both SDK
0.2.141/native 2.1.284 source and independent/native 2.1.296 installed package
pass four immediate-EOF controls, then fail the first 150 ms delayed-EOF request
at HTTP 500. The supported public result is `error_during_execution`,
`aborted_streaming`, one exact tool-use diagnostic, and its matching iterator
error. Complete generation, hook/denial custody and acknowledgement are already
present. R20/R21 retain all eighteen original scripted SDK/API queries and
provider/control/terminal timing plus physical cleanup. This does not recover
the missing public diagnostics from historical actual-model R11/R15 failures.

Correction `34b49d82d9f69b1044ccca2d12a082eca05969ca` admits only that exact
tuple behind the original closed-block, tool metadata/input, UUID, session,
generation cap, retained hook, intent/acknowledgement, denial, iterator error,
cancellation and retirement rules. Meaningful negatives reject unrelated or
extra errors, changed diagnostics, wrong session/subtype/counter, missing
custody, absent control and cancellation. The independent observer derives
its witness from public SDK events, binds the observed reason, and qualifies
the new tuple only on native 2.1.284/2.1.296. No cap/override/kill-switch, public
interface, dependency or version changes.

The new certified Linux amd64 runtime is
`sha256:c07ed57b13929b0bc91e0d46da574bb9bfd0bb11f8e62e84b889281394db0e68`.
All 3,607 source Git blobs and executable modes match the clean source commit.
Source and independently installed tarball have matching changed core bytes:
`2bb9025ee1c122a541e0c9f9c17df733f3f752a985776501bc69ea5ad31440d9`.
The exact tested 1.80.0 tarball is retained in round23 with SHA256
`03e92646b80cd60c21ef2fd135b788157d353ed14a69d618d0761ff2ce76cdd4`.
It is a local test artifact; nothing was published.

After correction, source and installed each pass all twelve EOF-delay cases
and 24 native scripted Queries: 0/150/750 ms × one/three tools × HTTP
stream/nonstream. All four 750 ms modes on each target actually exercise the
captured streaming tuple. Exact tools/results, public checkpoint UUID,
distinct durable continuation, unchanged original supported public history,
no denial tail, independent stop qualification and physical cleanup all pass.
This is direct protocol/SDK fixture proof, not actual OpenCode or model proof.

[Scoped root review](ROOT_REVIEW.md) records findings, negatives and preserved
setup/test failures. [Acceptance holds](ACCEPTANCE_HOLDS.json) retain the
separate live, cancellation, reporter, platform, whole-change and CI gates.
Both exact-committed-observer actual-client rehearsals pass with zero queries.
Final clean-head gates at 34b49d82 pass 6,018 tests / 36 skip / zero fail across
all 22 isolated npm batches plus pretest; standalone typecheck/build exit 0.
Original processes join; head/checkout and owner/contributor identities remain
exact. The changed source and independent package each pass all 27 actual Claude Code
2.1.287 mixed-auto-handback-v3 checks with exact committed observers, SDK
0.2.141, native 2.1.284/2.1.296, Sonnet 5 classifiers and Sonnet 5.5 working.
There are 19 Queries per target, 38 combined, estimated $2.1889227 total.
Both original attach/controller handles join; source/task grants stay unchanged,
owned task grants/runtime/containers are removed. Actual stops use
`aborted_tools`; the new streaming tuple is exercised separately by the native
EOF matrix. Historical R11/R15 attribution remains open. Changed E41 source and independent package each pass all four chain/parallel × streaming/nonstreaming modes, 32 real Sonnet 5.5 SDK Queries, exact pairing, cache continuity, immutable parents, saved durable forks and physical cleanup. The thin sidecar image retains every changed application layer; the original zero-query missing-fixture failure is preserved. This is direct HTTP protocol-fixture proof, not actual OpenCode-client acceptance.

The maintained reproducer is [scripts/e2e-native-stop-eof.mjs](../../../../scripts/e2e-native-stop-eof.mjs).
It clears inherited credential state and uses a scripted loopback provider.
Run it with Bun on a qualified Linux amd64 source or independent package
installation, SDK 0.2.141, the pinned native executable, a writable evidence
directory and explicit qualified head/core/SDK SHA256 arguments. Example
inside a read-only, network-none owned container with resource bounds and
writable tmpfs plus evidence mount:

```sh
bun /probe/scripts/e2e-native-stop-eof.mjs \
  --source-root=/qualified/source \
  --target-kind=source \
  --evidence-dir=/proof \
  --claude-executable=/qualified/source/node_modules/@anthropic-ai/claude-code/bin/claude.exe \
  --expected-cli-version=2.1.284 \
  --expected-head=34b49d82d9f69b1044ccca2d12a082eca05969ca \
  --expected-core-sha256=2bb9025ee1c122a541e0c9f9c17df733f3f752a985776501bc69ea5ad31440d9 \
  --expected-sdk-sha256=48bde6aeabf7e71ad5528bf52c8feb1642c21f505ea2495c70f39db7df226d97
```

Use source/package paths and hashes from that build’s qualification receipt;
a rebuilt certified artifact can have different metadata-derived bytes.
The same maintained harness can compare a separately qualified pre-correction
checkout while preserving every meaningful assertion. Generate an owned
synthetic 32-hex machine ID for the container, not the host’s identity. The
exact historical controllers/manifests are receipts of these runs and retain
their original paths; regenerate local input identities for a fresh invocation.
No login/refresh occurs in the harness.

Rounds19–28 preserve setup, baseline, correction, build, after-native and
actual-client preparation receipts. Credential-free controlled public error
text is retained; private grants, source credential metadata, runtime
directories, raw private live errors and synthetic machine-ID files are
excluded. The duplicate build source tree/filtered bundle are not copied;
the clean commit, source manifest and build recipe identify them.
