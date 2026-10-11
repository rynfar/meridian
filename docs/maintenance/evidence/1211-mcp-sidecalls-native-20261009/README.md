# Current MCP-corrected native classifier and foreground-agent proof

Existing draft #1322 continues older #1211 in original creation-date order.
Newer #1283 remains a documented dependency of that delivery. No new PR, merge
or source closure. All four current native candidate cases pass every original
assertion; this establishes the recorded current scopes, not whole-change acceptance.

| Flow | Target | Actual client | SDK/native backend | Queries | Checks |
| --- | --- | --- | --- | ---: | --- |
| E71 auto classifier | Source | Claude Code 2.1.286 | 0.2.141 / 2.1.284 | 10 | 18 PASS |
| E71 auto classifier | Installed | Claude Code 2.1.286 | 0.2.141 / 2.1.295 | 10 | 18 PASS |
| E72 foreground Agent | Source | Claude Code 2.1.287 | 0.2.141 / 2.1.284 | 9 | 18 PASS |
| E72 foreground Agent | Installed | Claude Code 2.1.287 | 0.2.141 / 2.1.295 | 9 | 18 PASS |

Real Linux/x64 guest binaries run with Bun 1.3.11 under ARM-host Docker. Native
main requests/receipts are exactly `claude-sonnet-5-5`; E71 classifier requests/
receipts exactly `claude-sonnet-5`. The maintained
[E71](../../../../scripts/e2e-claude-code-auto-mode.mjs) and
[E72](../../../../scripts/e2e-claude-code-subagent-session.mjs) harnesses are
unchanged. Every case retains its original 600-second / 20-query / $10 SDK-estimate
bound ($0.50 per query) and required live usage-readiness response. All four
readiness responses are 200. No readiness rule, model selector or assertion was
relaxed. Credential expiry covered all four complete execution bounds before
admission and was rechecked for each case. No native case failed or was rerun.

E71 makes four actual client invocations per arm, with actual outside-project
tool writes and classifier occurrence. Header and shape-only paths are observed.
Request-model logger ownership maps each wire request to one query. Independent
auxiliary state, zero auxiliary lease wait, working-session resume and zero
mapping collisions pass. This covers one explicit native classifier arm;
entitlement/policy/probe/demotion alternatives and the historical served identity
remain separate gates.

E72 makes two actual client invocations per arm. Exactly two foreground Agent
children overlap and perform four Bash calls with exact successful results.
Original public SDK PreToolUse hooks retain ID/name/canonical-input custody and
their unchanged outcomes. Parent/child session mappings are disjoint and resume;
request decisions and lease waits are complete. Each current arm also records
nine later SDK calls explicitly denied as already handled. Those calls are
visible in SDK/hook counters, have exact canonical outcomes after the forwarded
witnesses, and do not pretend to be HTTP/client tool results. Unknown outcomes
remain failures; dropped calls are not hidden from totals.

All original native attaches and original audit processes joined. Maintained
harness SDK iterators, reported client/pipe witnesses, HTTP resources, owned Linux
process census and private-runtime cleanup qualify their recorded scope. E71
logger descriptor restoration and handler/receipt joins are explicit. Every
stopped container was inspected before owned removal. All four rehearsals
passed with a fake access-only fixture, disabled network, zero model queries and
zero real credential reads. The first external audit wrapper expected the wrong
result label (`REHEARSAL_PASS` instead of documented `REHEARSAL`); its failure is
retained and its already-completed original case was audited without rerun.

The actual source credential serialization and task access-only grant stayed
exact through execution. No login, refresh or source write; no refresh authority
was staged. The grant, its private qualification and owned stopped containers
were removed after final audit. Every maintained harness removed its private
runtime. Global/external descendant absence is not claimed beyond these witnesses.

Thirty-eight queries and twelve actual invocations cost approximately
$3.616100 by SDK estimates, not subscription billing receipts.
Original attach/audit receipts and sanitized reports bind these counts.
The original sequential driver admitted each next case only after auditing the
previous original case, and stopped on any failure.

Source build and installed package remain the fresh immutable image
`sha256:f1db2086f5f9bec7a0ad7bc034288d18093d943ba444d7f8d47e12792b421eb5`,
source head `15f44351bbc8ddfd669db3254eac86736b61a02e`; installed tarball SHA256
`9196379796dcc354115dbe0f4772308551e4100d48fa2c703afb1839ffe5e9c0`.
[Complete prior image/package qualification](../1211-mcp-transport-20261009/README.md)
checks all 1,849 tracked source files and 432 compiled source/installed files.
Current code/test 693 and incoming documentation aae2 change no runtime/harness
bytes. Source cases check the clean exact Git head and certified build manifest;
installed cases resolve their own SDK/native backend. Explicit native/client/SDK
hashes are rechecked before and after every arm.

Reproduce with `TEMPLATES.json` and each `*_INVOCATION.json`: absolute target,
client/native/model/SDK choices and bounds are explicit. Start with `--rehearsal`
using a fake access-only fixture and disabled network. Actual execution needs a
private read-only access-only grant and successful live readiness; these records
supply no login/refresh authority. Runnable maintained scripts are committed.
No provider raw diagnostics/private SDK transcripts are included. `MANIFEST.json`
binds every sanitized public artifact.

[Root adversarial evidence review](REVIEW.md) finds no new material source or
proof finding after inspecting all four frames, ownership, canonical receipts,
visible later drops, original closure and immutable source/package identity.
Prior independent reviews retain their scopes. Code gate 693 remains 5,774 pass /
35 skip / zero fail in 22 isolated npm batches plus typecheck/build. This increment
changes proof/documentation only. The first concrete caption test failure and
older unprofiled store-performance/remote E72 failures remain retained.

**Still held:** historical reporter/client/model/host tuple; background/mixed-auto
children; root/scoped/nested cancellation and incidental parent abort; caption
baseline discovery/hints0/overlap/cancellation/cache requirements; MCP readiness
per real inference (not recorded by these observers); broader package/registry
parity; older unattributed CI failures; required final-head CI including `test`.
Current E55 and four-mode E41 scopes are independently qualified in their current
packets. Keep #1322 draft and source reports open. No release/community comment.
