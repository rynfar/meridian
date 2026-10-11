# Per-query native MCP readiness

This continues older #1211 through existing draft #1322. The newer #1283 remains
its necessary MCP transport dependency. Combined original creation date governs
priority; the delivery inherits #1211's age. Older owner deferrals, no-review and
missing-evidence holds remain. No new PR, source closure, merge or release.

The maintained E71/E72 observers now accept `--require-mcp-readiness`. Each real
SDK query copies its declared MCP namespaces/tools and observes the original
public `system/init` and result events without modifying them. Exactly one init
and one canonical result must share that query's own session; every declared
server must be connected with its full catalog. Failed, pending, missing or extra
servers, empty/changed/duplicate catalogs, malformed/duplicate receipts and
borrowed sessions fail. Existing model, usage, hooks, admission, history and
physical cleanup gates remain required. Default/historical controls without the
option retain their original assertion set.

A model success cannot hide the previously reproduced disconnected second
server. Twenty-seven pure controls exercise these failures, immutable per-query
expectations, summary-mutation resistance and privacy. Sixty-nine original E71/
E72 ownership, request-model, hook and containment controls pass; the standalone
compiled-context control skips and is enabled in the required complete npm run.
Root review corrected the returned-summary mutation issue before these invocations.

| Flow | Target | Actual client | SDK/backend | Queries | Assertions |
| --- | --- | --- | --- | ---: | --- |
| E71 auto classifier | Source | 2.1.286 | 0.2.141 / 2.1.284 | 10 | 19 PASS |
| E71 auto classifier | Installed | 2.1.286 | 0.2.141 / 2.1.295 | 10 | 19 PASS |
| E72 foreground Agent | Source | 2.1.287 | 0.2.141 / 2.1.284 | 9 | 19 PASS |
| E72 foreground Agent | Installed | 2.1.287 | 0.2.141 / 2.1.295 | 9 | 19 PASS |

All 38 real queries have matching public init/final receipts. Thirty-two declare
`oc` and retain its connected status and exact catalog digest/count. Six E71
classifier calls deliberately declare no MCP server; their own empty declaration
and init/final identity are still required. Catalogs contain 20 working tools or
18 child tools where declared. Main requested/served model is `claude-sonnet-5-5`;
classifier requested/served model is `claude-sonnet-5`. Four readiness responses
are 200. E71 retains independent header/shape auxiliary identity, logger ownership,
working resume and zero collisions. E72 retains two parallel foreground Agent
children, four exact Bash results and distinct resumable chains. Later SDK calls
canonically denied as already handled remain visible: seven source/five installed
in this execution. They are not counted as forwarded HTTP/client results.

All original four native attaches, four auditors and both sequential cohort
drivers joined. Each next case was admitted only after auditing its original
predecessor. Access expiry covered two complete 600-second case bounds before
each independently admitted cohort, and each case rechecked its own complete
bound. No extension, login, refresh or source write. The same task access-only
grant stayed exact and was removed after final audit; the supported credential
source stayed exact. Original SDK iterators and maintained-harness client/HTTP/
owned Linux process-census/private-runtime witnesses qualify their recorded scope.
All owned stopped containers were inspected and removed. E71 original client
pipes/logger descriptor are explicit; no extra unpublished E72 per-pipe or global
descendant-absence claim is made.

The runtime is the existing independently qualified Linux/x64 image
`sha256:f1db2086f5f9bec7a0ad7bc034288d18093d943ba444d7f8d47e12792b421eb5`,
source head `15f44351bbc8ddfd669db3254eac86736b61a02e`. Installed tarball SHA256
`9196379796dcc354115dbe0f4772308551e4100d48fa2c703afb1839ffe5e9c0`.
Bun 1.3.11 runs actual x64 guest binaries under ARM-host Docker. The new observer
commit is `2595d05db52bef6ee22bdf6dce9f218893119425`, mounted read-only outside
the clean runtime target. It is not claimed to be embedded in that earlier image.
All four observer/helper/denial inputs match committed bytes before/after. All
production source stays byte-identical to that image; source cases check its clean
Git head/certified build, installed cases resolve their own SDK/backend.
[Prior full image/package qualification](../1211-mcp-transport-20261009/README.md)
binds all 1,849 tracked source and 432 compiled source/installed files.

Reproduce from `TEMPLATES.json` and original `*_INVOCATION.json`, using maintained
[E71](../../../../scripts/e2e-claude-code-auto-mode.mjs),
[E72](../../../../scripts/e2e-claude-code-subagent-session.mjs) and
[public event witness](../../../../scripts/lib/e2eMcpReadiness.mjs). Mount exact
committed observer inputs read-only outside the target. Actual proof requires a
private immutable access-only grant with inference scope, sufficient expiry and
unchanged live readiness. These artifacts supply no credentials/refresh authority.
Only declared namespace names, counts, statuses and digests are added to public
reports; raw session IDs, config and provider diagnostics remain in memory.
Private SDK transcripts are neither inspected nor escrowed.

Whole-change acceptance remains held: historical reporter tuple and actual
OpenCode/OpenClaw gateway where implicated; background/mixed-auto children;
root/scoped/nested cancellation and incidental parent abort; caption baseline
request discovery/hints0/overlap/abort/cache requirements; broader package/registry
parity; older unattributed local/CI failures; required final-head CI including test.
Current readiness qualifies only these explicit E71/E72 tuples, not every native
inference in other cases. Prior independent production reviews retain their
original scopes; this increment receives root adversarial review, no delegation.

New full local gates at immutable observer/test commit 2595 pass: **5,801 pass /
35 skip / 0 fail in 22 npm-isolated batches**, pretest plus standalone typecheck
and build. The compiled E71 HTTP/request-model control executes and passes.
Original full npm PID 86838 exits 0 after 673.396 seconds and is joined; original
standalone commands join. Only documentation/evidence changes after these gates.
`FINAL_LOCAL_RECEIPT.json` and `local-gates/` preserve exact command/head/terminal/
log-digest custody. `full-test-summary.log` escrows original batch counts and the
compiled-control line; the complete unedited full log remains in the durable local
evidence packet, bound by SHA256 278523f0e0caf0089a7e5f59c4f085939385cce06cda2da85aa4983a73de9bf4.
Native total SDK-estimated cost is $2.533308, not subscription billing.
[Root adversarial review](REVIEW.md) and `ROOT_ADVERSARIAL_REVIEW.json` record
scope, concrete corrected finding, controls, physical custody and remaining gates.
`MANIFEST.json` binds every selected public artifact. The owner checkout/index/
all 12 dirty files and all 18 raw contributor records remain exact. Fresh pagination
covers six previously discovered managed repos, 29 open PRs and 22 open issues;
this refresh is not new repository discovery or new behavior acceptance.
