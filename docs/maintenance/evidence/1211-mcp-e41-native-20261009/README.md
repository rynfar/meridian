# Current MCP-corrected E41 source/installed matrix

All four chain/parallel × JSON/SSE modes pass on both source and independently
installed package. This continues original older #1211 through existing draft
#1322 after the necessary #1283 MCP dependency. No new PR or integration.

Production/source image head is15f44351bbc8ddfd669db3254eac86736b61a02e; current code/test
head 69374acc changes only the caption test. Incoming delivery4535e09a is
documentation only. The unchanged maintained
[observer](../../../../scripts/e2e-openclaw-native.mjs) is an owned OpenCode
protocol fixture with real native SDK queries, **not an actual OpenCode or
OpenClaw client**. The sidecars are prerequisites, not this fixture's actors.

| Target | Mode | Real SDK queries | Exact read batches | Result |
| --- | --- | ---: | --- | --- |
| Source | Chain JSON | 5 | 1, 1, 1 | PASS |
| Source | Chain SSE | 5 | 1, 1, 1 | PASS |
| Source | Parallel JSON | 3 | 3 | PASS |
| Source | Parallel SSE | 3 | 3 | PASS |
| Installed | Chain JSON | 5 | 1, 1, 1 | PASS |
| Installed | Chain SSE | 5 | 1, 1, 1 | PASS |
| Installed | Parallel JSON | 3 | 3 | PASS |
| Installed | Parallel SSE | 3 | 3 | PASS |

Exact requested/served model is `claude-sonnet-5-5`, SDK 0.2.141,
source backend 2.1.284/installed2.1.295, Bun 1.3.11, Linux/x64 guest on ARM Docker.
Every case checks three actual uniquely paired read answers, distinct
continuations, unchanged original parent histories, preceding working-session
resume, saved-fork follow-up and at least 95% reuse of the preceding cached prefix.
Canonical native result, public supported history, native init, actual assistant
model and positive usage agree. Capped tool checkpoints are canonical
`error_max_turns` with boolean true, an HTTP tool terminal and original leader
exit 1; final success has boolean false and exit 0. A tool checkpoint's exit 1
is not a cleanup failure.

All eight original attach handles, 64 observed original children/stdio,
SDK factories/iterators/close, public history reads, HTTP responses and
socket/listener resources joined. Sixteen original matrix-driver children and
the original matrix driver joined. Every stopped container was inspected before
owned removal. The access-only task grant and supported credential serialization
remained exact throughout all eight cases; no login/refresh/source write. Grant
and task-owned private SDK/runtime directories were removed after sanitized
report retention. Global descendant absence remains unknown beyond this scope.

The 32 queries cost approximately$0.437776 by SDK estimates,
not a billing receipt. Each case permits at most 8 queries, $0.50 per query/$4
case and 480 seconds; credential expiry covered all eight complete bounds before
admission. Driver launches and audits each case before starting the next and
stops on first failure. There was no failed case or rerun in this matrix.

Fresh immutable image is
`sha256:f1db2086f5f9bec7a0ad7bc034288d18093d943ba444d7f8d47e12792b421eb5`.
The independently installed tarball SHA256 is
`9196379796dcc354115dbe0f4772308551e4100d48fa2c703afb1839ffe5e9c0`.
The preceding [complete source/package qualification](../1211-mcp-transport-20261009/README.md)
binds all 1,849 tracked source files and 432 compiled files. Preparation reports
recheck actual entry/SDK/native/sidecar hashes for each arm with disabled network,
zero grant reads and zero model queries. Native harness, process helper and
production files match the certified image bytes. No fresh build or code change
was needed for this proof-only increment.

Reproduce the exact argv in each `*_INVOCATION.json`; source/installed paths,
model and platform are explicit. Start with credential-free `--prepare-only`.
The harness itself is committed at the linked script. Use a private read-only
access-only grant; do not infer refresh or login authority from these invocations.
Reports and original attaches/receipts are bound by `MANIFEST.json`. Provider
raw diagnostics and private SDK transcript files are not included.

The prior two read-only usage-endpoint429 responses remain recorded in the
older E41 packet; no new usage-endpoint recovery is claimed. The previously
qualified E41 prerequisite permits actual model access to be established by
these real queries. E71/E72 readiness rules are not changed here.

Root [adversarial increment review](REVIEW.md) confirms all required assertion
and closure facts and preserves limitations. Final local code 693 remains
5,774 pass/35 skip/zero fail across 22 npm-isolated batches, plus standalone
typecheck/build. The earlier concrete caption test failure was corrected and
retained in the MCP packet; earlier unprofiled store-performance/remote E72
failures remain unattributed. This increment changes evidence/documentation only.

**Still held:** impact-appropriate current-code E71/E72/caption and
background/mixed/root/scoped/nested cancellation/incidental parent abort;
actual historical reporter/client/model/host tuple and gateway; native MCP
readiness per real model query; broader package/registry parity; older
unattributed CI failures; required final-head CI including `test`. Earlier
E71/E72 evidence remains qualified only at its earlier explicit heads. Current
bounded E55 and this E41 matrix qualify their exact current scopes.
Keep #1322 draft and source reports open; no release or community comment.
