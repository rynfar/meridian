# Bounded Sonnet E41 source and installed proof

All four chain/parallel × JSON/SSE cases pass on both the clean source build
and independently installed tarball at `d3676c64ea16c87d183b551462f9f97b51224df7`.
This continues original #1211 through existing draft #1322 in original-creation
oldest-first order. It creates no new PR and establishes no whole-change acceptance.

The maintained [observer](../../../../scripts/e2e-openclaw-native.mjs)
uses an owned OpenCode protocol fixture, **not an actual OpenCode or OpenClaw
client**. Each query is real Agent SDK 0.2.141 and exact requested/served
`claude-sonnet-5-5`. Source backend is 2.1.284; the independently installed
package uses its own backend 2.1.295. Both execute Linux/x64 binaries with Bun
1.3.11 in an x64 guest on an ARM Docker host. OpenClaw 2026.6.11 and scrub 0.1.0
are prerequisite sidecars, not the E41 actor.

| Target | Mode | Queries | Exact read batches | Result |
| --- | --- | ---: | --- | --- |
| Source | Chain JSON | 5 | 1, 1, 1 | PASS |
| Source | Chain SSE | 5 | 1, 1, 1 | PASS |
| Source | Parallel JSON | 3 | 3 | PASS |
| Source | Parallel SSE | 3 | 3 | PASS |
| Installed | Chain JSON | 5 | 1, 1, 1 | PASS |
| Installed | Chain SSE | 5 | 1, 1, 1 | PASS |
| Installed | Parallel JSON | 3 | 3 | PASS |
| Installed | Parallel SSE | 3 | 3 | PASS |

Every arm proves three actual, uniquely paired file-read answers; four distinct
chain continuations or two parallel continuations; unchanged original parent
histories; resume from the preceding working mapping; saved-fork follow-up;
and at least 95% reuse of the preceding cached prefix. Native init, assistant
model, supported public history, positive usage and canonical original result
must agree. Capped tool checkpoints have `error_max_turns`, boolean error true,
an actual HTTP tool terminal and original leader exit 1. Final success has
boolean error false and leader exit 0. Exit 1 at a tool checkpoint is not a
cleanup failure.

There are 32 original SDK queries, approximately $0.436726 in SDK-estimated
cost, not a subscription billing receipt. The observer admits at most eight
queries per arm, sets $0.50 estimated query budgets and checks $4 total.
All original attach handles, observed children/stdio, iterators, public reads,
HTTP responses and sockets/listeners joined. Each original stopped container
was inspected before removal. The access-only grant was unchanged through
execution, then removed after final source/grant audit. Supported source
credentials remained unchanged; no login or refresh occurred. Task-owned
private runtime files were removed after sanitized report escrow. External
global descendant absence is unknown beyond the recorded actor scope.

The fresh tarball SHA256 is
`968a08a39715ff7791d864ae52f801865a3e486b38fb176497ac7229be286c6f`.
All 1,767 tracked source files and all 432 installed compiled files match the
complete source snapshot. The original clone and build handles joined; an
initial orchestration overlap is qualified by this complete after-build byte
comparison. This is an installed local 1.80.0 tarball, not a publication.

Reproduce with the absolute target, SDK, native, sidecar and private read-only
grant paths in [NATIVE_INVOCATIONS.json](NATIVE_INVOCATIONS.json). First run
`--prepare-only` without credentials. Select `E2E_E41_MODE=chain|parallel`,
`E2E_E41_STREAM=0|1`, `E2E_E41_MODEL=claude-sonnet-5-5`, and native version
2.1.284 for source or 2.1.295 for installed. The executed Docker recipe and
immutable image/base identities are retained. Four malformed-selection
controls fail before target/grant access. Source and installed preparations
pass without networking or model queries.

Two supported read-only usage endpoint reads returned 429. The initial hold
record is retained; its unnecessary E41 usage-200 prerequisite is corrected
in [the qualification](SUPPORTED_READINESS_QUALIFICATION.json). Actual model
access is established by these queries. Usage endpoint recovery is not claimed.
The E71/E72 readiness prerequisites remain unchanged.

At this code head, the full local npm gate passes 5,765 / 35 skipped / zero
failures in 22 isolated batches, with pretest typecheck and the certified
compiled-context lane. Standalone typecheck and build pass. Local gates use
Darwin arm64 / Bun 1.3.14 / Node 22.22.3; original full-suite and build logs are
compressed here. The earlier unchanged store-performance failure remains
retained and unattributed in the separate foreground E72 packet.

[Root adversarial review](REVIEW.md) qualifies this increment only. Historical
reporter tuple, actual affected-client acceptance, E55/MCP, broader caption,
background/mixed-auto/cancellation flows, broader package/registry parity,
the undiagnosed earlier remote E72 PID-zero failure and required final-head CI
remain open. The original source reports and #1322 stay open/draft.
