# Oldest #1211 dependency: per-query MCP transport

This remains part of existing draft #1322, inheriting #1211's original
2026-10-01 creation date. The owner requires one combined oldest-first PR/issue
queue. Newer #1283 is incorporated only because the unchanged #1211 candidate
reproduces shared-server tool loss. No new PR, merge, release or community comment.

## Source identity and attribution

Baseline production is d3676c64 (remote documentation head23533332). Complete
original #1283 commit571a6716 is cherry-picked as52965e11, preserving Nowaker's
raw Author/AuthorDate and full message. Maintainer fixture commit15f44351 copies
only the three previously reviewed files from preparationb4306749. None of that
preparation's unrelated production corrections are incorporated.

Final code/test head69374acc changes only the caption concurrency test after15f.
Production and scripts remain byte-identical to the certified Linux image15f.
All seventeen earlier contributor records plus this dependency record (eighteen)
remain exact and in ancestry; expanded #1231 at5afedf10 remains excluded.

## Causal native transport control

The committed `scripts/e2e-passthrough-mcp-overlap.mjs` and
`scripts/lib-passthrough-mcp-fixture.mjs` run against real SDK0.2.141/native2.1.284
on Linux/x64 with a local scripted API and disabled external network. No credential
or external model is used. Baseline and candidate use the same bounded harness,
explicit source overlays and identical first full tool catalog.

Baseline: second overlapping query reports `oc failed` and loses its complete
catalog even though its canonical result says success. Candidate: both report
connected, with identical complete catalogs and witnessed overlap. Deliberately
sharing one server on corrected code reproduces the baseline failure. Cancellation,
pre-request exit42, initialization timeout and TERM-resistant escalation are
retained separately. Seven original attaches and seventeen observed original
children/iterators/listeners joined; all owned containers and sandboxes were removed.
Ten public SDK transport entries are separate from historical E67 counters.

This establishes bounded transport causality, not actual external-model/client
readiness, global descendant custody or a separate per-pipe witness beyond the
original ChildProcess close contract. The immutable transport base image is the
older d367 snapshot; overlay hashes identify the tested15f production files.

## Fresh build, installed package and actual E55

The clone joined before build and all1,849 tracked rows matched. Fresh image
`sha256:f1db2086f5f9bec7a0ad7bc034288d18093d943ba444d7f8d47e12792b421eb5`
contains clean Git head15f44351. Its independent tarball SHA256 is
`9196379796dcc354115dbe0f4772308551e4100d48fa2c703afb1839ffe5e9c0`.
Certified build metadata and all432 compiled source/installed files match.
The first qualifier launcher failed before execution because python3 was absent;
that failure is retained. The corrected Bun qualifier passes. Both original
qualifier attaches joined and their owned stopped containers were removed.

Both current actual E55 source and independently installed arms pass all eleven
original assertions: three real Claude Code2.1.287 invocations and five real exact
Sonnet5-5 SDK0.2.141 queries each. Source backend2.1.284 and installed backend2.1.295
are observed. Reports retain canonical status, positive usage, capped-tool facts,
original process/stdio/iterator and HTTP closure. All eighteen observed original
children and two attaches joined. Access-only task grant, containers and private
SDK/runtime directories were removed after sanitized reports; supported credential
source remained unchanged. Ten queries cost approximately$0.234818 by SDK estimates.
Prepare-only controls made zero model queries and zero actual client invocations.

These are the real original E55 assertions, not an actual OpenCode/OpenClaw or
LiteLLM gateway. This observer does not record MCP readiness per real query.
Native invocations preserve exact argv except the private future-expiry field,
which is redacted. Credentials/private transcripts are never retained here.

## Local gates and review

First full gate15f stopped with5,761 passes/35 skips/one concrete caption test
failure: it expected reused server identity under the new per-query contract.
Correction693 verifies independent server objects while retaining the working
catalog array and separate caption definitions. Corrected42 tests/274 assertions
pass; full `E71_COMPILED_CONTEXT_CONTROL=1 npm test` passes5,774/35/0 in22 isolated
batches, including pretest. Standalone typecheck and build pass. Original handles
joined. First failure excerpts and full-log hashes are preserved.

Root adversarial review covers the complete production increment, every builder
caller and streaming/nonstream retry loop, schemas/catalog/defer/alias continuity,
caption ownership, negative controls, packaging and evidence limitations. No
material scoped source finding survives. Prior independent reviews retain their
explicit source-only scopes; no new delegation occurred.

Whole-change acceptance remains held: current-head E41 four-mode source/package
parity, impact-appropriate E71/E72 and caption/background/mixed/cancellation flows,
actual historical reporter/client/model tuple, native inference MCP readiness,
older unqualified CI failures and required final-head CI. Prior E71/E72/E41 results
remain valid at their recorded earlier heads and do not qualify this changed code.
Keep #1322 draft and source reports open. `MANIFEST.json` binds these sanitized files;
`QUEUE_REFRESH.json` is the freshly paginated six-repository combined queue.
