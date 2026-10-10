# Current caption overlap and input-boundary proof

Existing draft #1322 continues oldest original #1211. The tested code head is
`537c4c8740c23d58d3835884d00b1143e5ac7366`. It changes the maintained caption
observer, its pure observations/tests and README; tracked production application,
public interfaces and package/dependency versions are unchanged from `34b49d82`.

The former observer at `960e7337` passes work-first/hints1 native MCP overlap
([R29 report](round29/report.json)). That branch did not enforce working lineage,
so its PASS supplies no checkpoint/history acceptance. Root review corrects the
omission: both overlap orders must prove selected forwarding order, two live
native queries with two public MCP samples each, one independent caption query,
exact saved checkpoint fork/resume, immutable original supported SDK history and
all three owned Read results exactly once. Duplicate/error/mismatched results and
wrong/missing/in-place resumes are refused; at most24 backend Queries are admitted.
The initial TS2532 result is retained in [focused qualification](round30/FOCUSED_QUALIFICATION.json);
the explicit missing-result guard passes typecheck before the unpushed maintainer
commit is amended. Twelve focused tests/78 assertions and causal controls pass.

Current complete local gates pass [6,020 tests/36 skips/zero failures](round30/final-local-gates/LOCAL_GATES_COUNTS.json)
across all22 isolated npm batches plus pretest. Standalone typecheck/build exit0;
the [original controller and all commands join](round30/final-local-gates/TERMINAL.json).
The [native sequence](round30/NATIVE_SEQUENCE_TERMINAL.json) admits four selected
source arms only after these exact-head gates pass, stopping on any failure:

| Arm | Backend Queries | Native result |
| --- | ---: | --- |
| [work-first/hints1](round31/report.json) |7|PASS: both MCP samples, independent caption, exact checkpoint fork, all3 durable Reads once, original history unchanged|
| [caption-first/hints1](round32/report.json) |7|PASS: same assertions, opposite actual forwarding order|
| [sequential/hints0](round33/report.json) |7|PASS: authentic caption without gateway hint, exact mapping/generation/history retention, checkpoint continuation and all3 durable Reads once|
| [disabled/hints1](round34/report.json) |6|PASS: long genuine worker and all3 Reads, no caption emitted, including after completion|

All use actual native Claude Code2.1.292/SDK0.2.141, Darwin arm64, pinned Bun1.3.11
and Node22.22.3. Client label is exact `claude-opus-5-5`; every backend separately
confirms SDK `opus[1m]`, environment pin `claude-opus-5-5` and native
`claude-opus-5-5[1m]`. These source invocations execute source modules, not a
bundled package. Original parent/worker, observed source gate publication/executor,
direct native/sidecheck handles, iterators, stdio/callbacks, accepted sockets,
listeners and private writers join. Source and access-only task inputs stay
unchanged; task grants are removed after scoped custody audit. Private runtime,
config/history/raw output and grants are excluded from this packet. Secondary and
global descendant absence remain UNKNOWN. No agent login/refresh/source writes.

**New material source hold:** [R35 review](round35/REVIEW.md) and
[finding](round35/findings.json) reproduce a valid-input refusal. The production
checkpoint observer's16,384-node budget throws before intent for a plain87KB
JSON array. A credential-free native source/HTTP control on the certified
`34b49d82` Linux artifact passes both smaller complete-input/fork/history controls,
then returns HTTP500 for16,384 items. Original controllers/container/body/request/
backend/listener/native custody join and the runtime/container are removed.
Five scripted Queries, no grants/models/coding clients. Its original control
classification remains false because the expected failure literal omitted the
Node assertion suffix; [separate qualification](round35/OWNED_FAILURE_CLASSIFICATION_CORRECTION.json)
preserves and classifies the actual500 without rerunning or rewriting evidence.
The guard-off legacy attempt remains a fixture FAIL: its legitimate second API
generation was rejected400 by the one-generation provider. Its one Query and
cleanup remain retained; it establishes no main/published baseline success.

The frozen component image remains at34b49d82, core
`2bb9025ee1c122a541e0c9f9c17df733f3f752a985776501bc69ea5ad31440d9`.
The later host537c4c87 build produces separate core
`1f8783a4b2f8dde06deb84724a13115b64774e765567f5038548175e1a452e87`.
No compiled-byte equivalence or current installed-caption acceptance is asserted.

Use the committed `scripts/e2e-claude-code-progress-captions/caption-native-gate.mjs`
and its README with fresh exact source provenance, private access-only task grant
and the pinned tuple. Select one of the four arms above; do not substitute a
model/platform or source singleton for a living package registry. Preserved
controllers record exact invocations but their canonical paths need qualifying
on another host. R35's sanitized diagnostic overlay is retained verbatim under
`round35/probe`; the eventual critical correction must escrow its maintained
repository control before acceptance.

See [root review](ROOT_REVIEW.md), [holds](ACCEPTANCE_HOLDS.md) and
[manifest](MANIFEST.json). No new PR/worktree, merge, source closure, release or
community comment. #1288 was refreshed OPEN with no reporter tuple supplied.
