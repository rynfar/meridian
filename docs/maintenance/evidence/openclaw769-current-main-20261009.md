# #769 current-main correction and client preparation

The oldest actionable item remains [#769](https://github.com/rynfar/meridian/issues/769);
#650 is owner-deferred. This checkpoint creates no PR and does not close #769.

Archived correction `f09cd58653cc6fce2b6923086767512f5cfe03fc` is preserved as
authored cherry-pick `7960fd62bf226cd8707440d9efc7083319614d2e` on current main
`aee79ae3966b8b1d32f8d2a7fde3ec01f7ec2686`, without conflicts. Root reviewed
the complete ten-path production/test/documentation diff and adjacent transform,
lineage, namespace, checkpoint, replay and durable publication callers. This is
a fresh root adversarial review; the archived independent review covers the
older source candidate. No material production finding remains.

The existing modifiable `onRequest.messages` contract now reaches execution.
Raw client history still controls ancestry and ownership. Equivalent clones
retain resumes; changed histories replay fully and withhold raw-offset SDK
resume/undo/checkpoint authority. Internal raw proof survives ordinary/atomic
store/load/rollback, while old readers fail closed and a later unchanged full
replay restores normal SDK-prefix proof. Namespace-qualified tool inheritance
and all four fresh fallback builders retain their scope. Repeated transformations
cost fresh replay and cannot recover hidden SDK thinking absent from client history.

Fresh local `npm test` includes pretest and all 21 isolated groups: 5,552 pass,
35 skip, zero fail. Separate typecheck and build exit zero; tracked source hashes
remain unchanged. The focused suite passes 50 tests. Credential guards remain
scoped local-test evidence. These gates use mocks and make no real model calls.

Independently installed OpenClaw 2026.6.11 (e085fa1), Node 22.22.3, Darwin arm64
passed version, help, configuration and the committed
[`e2e-openclaw-client-protocol.mjs`](../../../scripts/e2e-openclaw-client-protocol.mjs)
loopback fixture. Two actual streaming requests preserve a declared local read
and its matching random result, followed by final client output. Original CLI
exit/close/pipe witnesses and owned listener/socket/handler joins pass.
The first two preparation runs failed a fixture matcher: OpenClaw normalizes
`owned-read` to `ownedread`; the owned read itself succeeded. Their first failures
and logs remain retained. The corrected alphanumeric fixture passes; these
failures are not Meridian before/after evidence. Lifecycle scripts and optional
native client features were omitted; no provider credential was supplied.

The same committed probe at `b356123702c4a50dddcd4538f1cce08d159bfeb4`
also passes on Linux arm64 / Node 22.22.3 in a read-only owned container with
external networking disabled. The independently installed exact client sends
two streaming requests and preserves the read/result pairing and final output.
All original CLI/pipe and owned listener/socket/handler witnesses pass; the
container exits zero, its original Docker wait joins, and the stopped container
is removed. Image identity is
`sha256:53c2c93dc65a0e6bc10009017a06d7d467fb60a79eab601193f63ecb58436174`.
Its qualified public base image and inherited layer prefix match before/after.
This is Linux client preparation, without live Meridian/SDK/model or Kubernetes
acceptance; it does not widen the scope of the mocked core gates.

The native escrow now uses independently built and installed current-main and
candidate tarballs, the same corrected scrub tarball, SDK 0.2.141 and genuine
Claude Code 2.1.284 on Linux arm64. Every tarball-selected installed member was
independently verified: baseline 450 files, candidate 452, OpenClaw 8,944 and
scrub 19. The exact nested dependency lock is retained separately. This proves
selected installation identity, without claiming registry release provenance.

Native baseline R2 failed startup before any SDK query because the owned
container lacked `/etc/machine-id`. R3 adds only a proper read-only fixture
machine-id and completes an actual OpenClaw read/result/reply on
`claude-opus-5-5[1m]`, with two original SDK/native queries. The fixture then
fails `supported-history-tool-receipt-lost-read-canary`; its HTTP join verdict
is also false. Both failures, first causes and custody qualifications remain
retained. Original containers exited, Docker waits joined, stopped containers
were removed, and private access-only inputs were removed after terminal audit.

Public SDK diagnosis reads only those owned sessions, without credentials or
model calls. It finds the actual receipt in the answering branch, while the
saved mapping remains at the initial tool checkpoint. This is the existing
E54 headerless-result limitation: checkpoint recovery changes the lineage but
the request remains independent, so publication is deliberately skipped.
R3 therefore failed an overbroad fixture assertion, not a newly established
production publication defect. The corrected escrow observes the original
query's preallocated, terminal-verified answering branch for that one control;
ordinary subsequent turns still require the working mapping to match the
actual answering branch. No synthetic OpenCode session headers are added.

A separate credentialless Bun 1.3.11 HTTP probe reproduces listener closure
with an unclosed observed socket wrapper. Explicitly destroying the original
owned wrapper produces its required close event. The corrected escrow retains
those witnesses and records granular HTTP custody; it does not erase failed
R3 witnesses. Fresh baseline/candidate contract acceptance remains pending.

The remaining actual affected-flow proof, four E41 modes, broader independently
installed package flows and required final-head CI remain open.
The separately accepted scrub candidate remains unlanded. The undisclosed
September classifier trigger and missing fresh off/on/off controls prevent a
billing/classifier resolution claim or issue closure.

Supplemental source identities, gate logs and all failed/passing preparation
receipts remain in `meridian-review-evidence-20261006/core769-current-main-20261009-round1`
and `core769-current-main-20261009-round2-native`.
No release, community comment, owner-checkout mutation or classifier rule was added.
