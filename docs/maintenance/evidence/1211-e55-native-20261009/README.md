# Bounded native E55 source and installed parity

This packet continues original #1211 through existing draft #1322. It qualifies
only the maintained E55 real Claude Code client flow under passthrough default.
It does not establish actual LiteLLM, a historical reporter tuple, shared SDK MCP
transport/retry/tool readiness, or whole-change acceptance.

## Native results

| Arm | Original assertions | Actual clients / SDK queries | Result |
| --- | --- | --- | --- |
| Source R1, observer `b126222a` | 11 PASS | 3 / 5 | Observer failed unsupported counter equality; retained |
| Source R2, observer `838d4a29` | 11 PASS | 3 / 5 | PASS, all original observed actors joined |
| Independently installed R1, observer `838d4a29` | 11 PASS | 3 / 5 | PASS, all original observed actors joined |

All native frames use Linux/x64, Bun 1.3.11, system Node 24.21.0, actual client
2.1.287, SDK 0.2.141 and exact requested/served `claude-sonnet-5-5`. Source SDK
backend is 2.1.284; independently installed backend is 2.1.295. Total retained
estimated SDK cost is $0.4144868. The qualified source/installed pair contains ten
queries; fifteen includes the first failed observer frame.

The first observer incorrectly required result `num_turns=1` whenever the option
was `maxTurns=1`. Both tool checkpoints instead returned `num_turns=2`, one
actual assistant response and a canonical `error_max_turns` result. No production
source changed to make the retry pass. The correction retains the positive
integer result counter as a diagnostic and independently requires exactly one
original unique assistant response ID, an actual tool call, the original
one-round option, canonical boolean/result flags, exact target/model/usage and
native termination witnesses. The first failed report and both diagnoses remain
unaltered in this packet. [Official SDK loop documentation](https://code.claude.com/docs/en/agent-sdk/agent-loop)
explains option budgets and result termination; it does not establish a precise
counter formula for this pinned backend.

## Inputs and custody

The compiled production snapshot remains `d3676c64ea16c87d183b551462f9f97b51224df7`.
All nine production files are unchanged. The prior E41 independently installed
tarball SHA256 is `968a08a39715ff7791d864ae52f801865a3e486b38fb176497ac7229be286c6f`;
its 432 compiled files and complete tracked-source snapshot retain that earlier
qualification. The known image is
`sha256:5d1cc1baa71cc21f3a7046811c029b6906b684f52406c73befc5be8f4022dac1`.
The two current maintained harness files were mounted read-only over that image.
They are not claimed to be part of its older image or production Git head.
[Current input receipt](CURRENT_HARNESS_INPUTS.json) and
[sanitized invocation arrays](NATIVE_INVOCATIONS.json) preserve that distinction.
The expiry is intentionally a placeholder, requiring fresh supported credentials.

The observer preserves all eleven existing assertions and all three client argv.
It selects explicit source/installed entrypoints, SDK, client and backend; isolates
runtime state; binds a dynamic loopback port; gives the client dummy authentication;
and admits SDK calls only through the task-owned access-only grant. Admission is
bounded to sixteen SDK queries, SDK-estimated $0.50 per query/$8 total and eight
minutes. Failure retires admission before bounded cleanup. Original native init,
result, exit, stdin/stdout/stderr close, iterator, HTTP listener and socket witnesses
are required. No global descendant-absence claim is made.

All three original attach handles are terminal. Their stopped containers, private
access grants and task-owned private runtime files were removed after sanitized
reports and custody receipts were saved. Supported source credentials remained
unchanged; there was no login, refresh or credential write.

The reusable harness is [scripts/e2e-passthrough-claude-code-native.mjs](../../../../scripts/e2e-passthrough-claude-code-native.mjs),
with direct negative controls in [e55-native-completion.test.ts](../../../../src/__tests__/e55-native-completion.test.ts).
Unknown options/unsupported versions fail before grant access or model calls.
The initial networkless preparations retain their earlier `b126222a` scope;
they are not substituted for the corrected native executions.

## Review and remaining gates

[Root adversarial review](REVIEW.md) covers this increment; prior independent
reviews retain their original scopes. Local checks are qualified separately in
[LOCAL_GATES_CURRENT.json](LOCAL_GATES_CURRENT.json). The first earlier unprofiled
store-performance failure remains unattributed; later green suites are not called
its correction. The owner checkout and all twelve dirty items remained untouched;
all seventeen contributor author/date/full-message records remain exact and in
ancestry. Expanded #1231 remains excluded.

Keep #1322 draft and all unresolved source reports open. MCP transport/retry/tool
readiness, background/mixed-auto children, root/scoped/nested cancellation,
incidental parent abort, caption discovery/hints0/overlap/abort/cache, historical
model/host and #1288 tuple, broader package/client parity, the older undiagnosed
remote E72 PID-zero failure and required final-head CI remain separate holds.
No new PR, merge, release or community comment occurred in this increment.
