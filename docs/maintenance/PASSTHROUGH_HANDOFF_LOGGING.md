# Recovered passthrough streaming outcome logs

## Defect and bounded correction

The streaming SDK catch logged `upstream.failed` and `proxy.anthropic.error`
before checking whether a capped passthrough turn had recovered. A usable
client tool handoff or capped-turn truncation therefore appeared as a failure
in debug logs even though the client received no error.

The correction captures the original failure fields, classifies the error as
before, and wraps the post-classification handling in `try/finally`. Only the
two successful recovery returns set `streamRecovery`. The finalizer logs either
one `upstream.completed` with normal streaming fields plus `sdkTermination`
and `recovery`, or the original failure pair once each with unchanged fields.
Failure duration is still captured at catch entry; recovered duration includes
recovery settlement, like normal streaming completion. No recovery predicate,
wire frame, telemetry record, idle-streak policy or durable publication changes.

## Upstream exit audit

Audited against unchanged main `a4b0f8b592f842a135af3e4c73f09886b2b3ef57`,
not inferred from another branch's catch layout. These are all exits between
classification and the error frame, plus its final fallthrough:

| Exit | Outcome logging |
| --- | --- |
| Tool recovery return, captured or uncaptured | Sets `tool_use` or `tool_use_uncaptured` only after publication/invalidation, priority settlement, terminal emission and success bookkeeping; finalizer emits one completion, no failure events. |
| Capped-turn/output-cap truncation return | Sets `max_tokens` after existing terminal emission and success bookkeeping; one completion, no failure events. |
| Throw: shared mapping changed before recovery invalidation | Recovery unset; original failure pair. |
| Throw: shared mapping changed after canceled recovery publication | Recovery unset; original failure pair. |
| Throw: request canceled after recovery publication | Recovery unset; original failure pair. |
| Throw: shared mapping changed before recovery publication | Recovery unset; original failure pair. |
| Rejected awaited eviction, managed-fork commit, pinned publication (including its callback), canceled-publication eviction or priority finalization | Recovery unset; original failure pair. The existing outer error handler remains responsible for the client error. |
| Other synchronous exception before a recovered return, including validation/publication guards, diagnostics, serialization, cache or telemetry work | Recovery unset; original failure pair. |
| Unrecovered path through error frame and stream close | Recovery unset; original failure pair. Existing diagnostic/telemetry error and SSE ordering remain intact. |

Nested returns are not handler exits. The uncaptured-veto IIFE returns the
predicate veto, `envelope_unopened`, `stream_closed`, `terminal_delta`,
`durable_writes_revoked`, `aborted`, block veto, `undeclared_tool`,
`untracked_block`, or `undefined`; all continue classification inside the
same `try`. The pinned-publication callback returns `mapStoreMutation(...)`
and its mapping callback returns `stored`; these continue publication, and
any exception/rejection reaches the same finalizer. There are no other handler
returns or explicit throws in this span. Earlier intentional-stop/client-abort
branches and later outer cleanup are outside this span and unchanged.

## Reproducible actual-provider gate

Build both trees with their frozen-lockfile dependencies. Before starting any
server, inspect the tested source and record that its port, HOME/config,
native credential/transcript root, session store, turn locks, SDK/deletion gates,
GC sidecar, bookkeeping database/guard, telemetry database, plugin paths,
update caches and every other writable path are separate from any running
instance. Do not copy production settings or session data. Stop if isolation
cannot be established.

Use a fresh private scratch directory with an `evidence/` subdirectory. Supply
an access-only, unexpired credential snapshot for an authorized account; the
harness removes refresh capability and configures read-only credentials. It
never logs credential bytes, refreshes an account or enables paid usage.

```sh
E2E_ALLOW_LIVE_MODEL=1 \
E2E_BASELINE_ROOT=<absolute-unchanged-built-tree> \
E2E_MERIDIAN_ROOT=<absolute-candidate-built-tree> \
E2E_PI_AI_ROOT=<absolute-installed-pi-ai-package> \
E2E_CLAUDE_BIN=<absolute-native-claude> \
E2E_CREDENTIALS_FILE=<private-access-only-snapshot> \
E2E_SCRATCH_ROOT=<fresh-private-scratch> \
E2E_PROTECTED_PID=<running-instance-pid> \
E2E_PROTECTED_PORT=<running-instance-port> \
E2E_ISOLATION_PROOF=<source-reviewed-proof-file> \
node scripts/e2e-passthrough-handoff-logging.mjs
```

The proof file must name the independently checked protected PID. This is an
operator/source-review gate, not an automatic sandbox. Each owned CLI gets an
explicit minimal environment, fresh writable roots, loopback ephemeral port,
`OPENCODE_CLAUDE_PROVIDER_DEBUG=1` and `MERIDIAN_PASSTHROUGH=1`. The provider's
HTTP origin and single non-deferred tool are asserted. Only the exact owned
server receives shutdown SIGTERM; its close and pipes are joined, observed
descendants must be absent, then private case state is removed. On a custody
failure retain state rather than killing by process name. Remove the private
credential snapshot after joined completion. Keep sanitized logs, SSE and
`report.json` as evidence; publish no private grants or host-specific paths.

## Before/after receipts and limits

Verified on Linux x64 with Node 22.23.4, Pi AI 1.5.2, Agent SDK 0.2.141 and
Claude Code 2.1.322, requesting Haiku 5.5. Two calls total through the actual
Pi provider, not a headless Pi session or mocked SDK. Both HTTP responses were
200, ended with `stop_reason: tool_use` / `message_stop`, contained one
`handoff_probe` call with the requested marker and had no SSE error. Pi returned
`toolUse` in both arms. Both owned servers exited 0; zero observed residuals.

- **Unchanged main:** one `upstream.failed` containing
  `Reached maximum number of turns (1)`, plus one `proxy.anthropic.error`
  classified `api_error` despite the clean client handoff.
- **Candidate:** only `upstream.completed`, `sdkTermination: max_turns`,
  `recovery: tool_use`, `streamEventsSeen: 8`, `eventsForwarded: 7`.
- **Harness exit:** 0; its baseline arm asserts reproduction of the defect,
  not acceptance of baseline logging.

`bun test src/__tests__/passthrough-early-stop-integration.test.ts`: unchanged
server with new tests: 165 pass / 3 fail, exit 1 (captured, uncaptured,
truncated); candidate: 168 pass / 0 fail, exit 0. Empty turn, process-exit
stderr, rate-limit refusal and publication-conflict controls pass on both.
`npm run typecheck` and `npm run build`: exit 0.

`npm test` used default TMPDIR and exited 1: candidate 8433 pass / 28 skip /
2 fail; unchanged production/test source in the same worktree 8426 pass /
28 skip / 2 fail. Both fail the same pre-existing tests:
`matches actual legacy mutation durability/order, rather than the one-sync comparison`
and `does not import legacy data implicitly and permits only explicit offline migration`
(the latter reports a live session-GC lock candidate). All 28 remaining test
commands after the short-circuited first group were run separately on the
candidate and exited 0. This is not a green full-suite claim or a waiver.

This gate proves the direct provider streaming handoff/log distinction only:
not interactive Pi, plugin discovery/attestation, tool-result continuation,
other platforms, an independently installed package or a release. The seven
mocked HTTP regressions cover the adjacent failure/recovery log contracts.
Final-head CI, including `test`, remains required before merge.
