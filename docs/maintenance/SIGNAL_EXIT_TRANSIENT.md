# Retryable signal-stopped Claude Code requests

## Problem and boundary

A supervisor's shutdown signal can reach in-flight Claude Code children as well
as Meridian. The SDK then reports exit 143/137 or a null-code SIGTERM/SIGKILL
termination. Previously Meridian treated a numeric signal exit as an unexpected
502 crash with `claude login` advice. Once streaming has started, HTTP status is
already 200; the client receives the error text instead. Pi's text-only retry
classifier rejected that text, ending the turn. Re-authentication cannot remedy
a stopped process.

`classifyError` now returns 503 `api_error` with this message for numeric signal
exits (the parenthesis names the actual code or signal):

> Service temporarily unavailable: the Claude Code process serving this request was stopped by a signal (exit code 143), as happens when Meridian restarts or the process is killed for memory. Retry the request.

Only the text before `Subprocess stderr:` can supply the SDK's null-code signal
name; quoted signal text in appended stderr is not termination evidence.
Earlier global OAuth, entitlement, authentication, quota/billing, context-overflow
and CLI-model branches retain precedence. Other codes and signals are unchanged.
503 `api_error` does not enable account failover.

There is no supervisor, service-unit, shutdown or socket-lifecycle change.
Normal shutdown still drains admitted work; grace expiry can close the socket
before an SSE error can be delivered. This classification fix does not promise
that every interrupted turn can finish, resume or be retried without side effects.

## Reproduction

Build unchanged main and the candidate separately. On Linux, supply explicit
absolute paths to both builds, an actual installed Pi AI package exposing the
Anthropic provider and retry utilities, and the intended native Claude Code
executable. Use an authorized private credential snapshot containing only a
fresh access grant, not a refresh token:

```sh
E2E_ALLOW_LIVE_MODEL=1 \
E2E_BASELINE_ROOT=/absolute/built/main \
E2E_MERIDIAN_ROOT=/absolute/built/candidate \
E2E_PI_AI_ROOT=/absolute/pi-ai-package \
E2E_CLAUDE_BIN=/absolute/native/claude \
E2E_CREDENTIALS_FILE=/private/access-only.json \
E2E_SCRATCH_ROOT=/absolute/private/scratch \
E2E_CASES=baseline-crash,fixed-crash,fixed-drain \
node scripts/e2e-signal-exit.mjs
```

The snapshot uses the native `{ "claudeAiOauth": { ... } }` envelope. Never
publish it. The harness requires expiry at least five minutes in the future,
disables credential writes and copies no usable refresh token. A successful
run removes its per-case private state; retain an unsuccessful fixture until
process custody is established. `fixed-grace` is an optional short-deadline
transport control, not part of the three-case evidence below.

**Before starting**, inspect the harness and the tested installation's path
resolution. Every case must have its own HOME, XDG roots, Claude config,
Meridian config, session store, workdir, temporary directory, plugin paths and
telemetry database. `configDir.ts`, `sessionStore.ts:getSessionStoreDir`,
`query.ts:resolveQueryConfigDir`, `sessionLifecycle.ts` and bookkeeping
`runtime.ts` establish those boundaries. GC sidecars, lifecycle/turn locks and
SDK process gates derive from the private session root; fresh mappings cannot
point deletion at production transcripts. Remaining caches derive from private
HOME/config. The child gets a minimal explicit environment, one private
read-only profile and JSON bookkeeping, not inherited operator configuration.

The harness reads the managed service PID only to exclude it from signal
selection. It binds a fresh loopback port, never port 3456. Signals target only
its scratch server ChildProcess or an executable match proven within that
server's descendant tree. It never starts, stops or restarts a managed service.
It joins the original server close and captured pipes and checks observed
children before disposing of state. Do not use it against a managed instance.

## Evidence (Linux x86_64)

Baseline: upstream `a4b0f8b592f842a135af3e4c73f09886b2b3ef57` (1.91.0).
Candidate: that baseline plus the signal classifier and regression tests in
this contribution.
Tested tuple: Node 22.23.4, Bun 1.3.14 for local gates, Agent SDK 0.2.141,
Claude Code 2.1.322, Pi AI 1.5.2, requested/pinned `claude-haiku-5-5`.
This does not claim an independent provider-served-model receipt.

The harness imports Pi's actual Anthropic provider and retry classifier; it
starts no headless Pi session. Three live model calls were made. Drain-refusal
requests were rejected before model admission.

| Case | Signal after first text | Actual provider outcome | Server/cleanup |
|---|---|---|---|
| Unchanged upstream crash | owned request child, SIGTERM | HTTP 200 stream; code-143 login advice; retryable **false**; first text 2149 ms, error 2575 ms | exit 0; zero observed residual descendants |
| Candidate crash | owned request child, SIGTERM | HTTP 200 stream; transient `api_error`, `retry_after: 5`; retryable **true**; first text 6050 ms, error 6120 ms | exit 0; zero observed residual descendants |
| Candidate drain, 30 s grace | scratch server only, SIGTERM | admitted turn completes with `message_stop` and Pi `stop`; new turns get retryable 503 `overloaded_error`; completion 8632 ms after signal | exit 0; zero observed residual descendants |

Maintainer rerun (2026-11-16, Linux x86_64, Bun 1.4.3, Agent SDK 0.2.141,
Claude Code 2.1.322, `claude-sonnet-5`): a real streaming `/v1/messages`
request whose Claude Code child was signalled after the first text delta.

| Signal | Unchanged main | Candidate |
|---|---|---|
| SIGTERM | `api_error`: "exited unexpectedly (code 143) … try 'claude login'" | `api_error`, `retry_after: 5`, stopped by a signal (exit code 143) |
| SIGKILL | not run | `api_error`, `retry_after: 5`, stopped by a signal (signal SIGKILL) |

This proves the affected provider/error-policy surface, not the interactive Pi
UI, its extension discovery, its outer automatic retry loop, or all supervisor
configurations. Live signal injection exercised SIGTERM/code 143; numeric 137
and null-code signal forms have direct regression coverage.

### Local checks

```sh
bun test src/__tests__/errors.test.ts \
  src/__tests__/cli-model-error-boundaries.test.ts \
  src/__tests__/proxy-stream-error-recovery.test.ts
npm test
npm run typecheck
npm run build
```

- New tests on unchanged upstream code: **259 pass / 9 fail**, exit 1.
- Candidate focused files: **268 pass / 0 fail**, 606 assertions, exit 0.
  Two generic numeric-crash fixtures now use code 2 instead of 137, preserving
  their unrelated 502 assertions. Quoted stderr and other-signal controls pass.
- Typecheck and build: exit **0** each. Dependencies installed using
  `bun install --frozen-lockfile`; no dependency or lockfile changes.
- `npm test`, default temporary directory: initial run **8439 pass / 28 skip /
  1 fail**, exit **1**; repeated run **8438 pass / 28 skip / 2 fail**, exit **1**.
  Both stop in the first 489-file group. The remaining 28 commands were run
  separately: **587 pass / 0 fail**, exit **0**.
- The full-suite failures are the bookkeeping runtime test `does not import
  legacy data implicitly and permits only explicit offline migration` (a live
  GC lock candidate), and `matches actual legacy mutation durability/order,
  rather than the one-sync comparison` (extra asynchronous lifecycle I/O).
  Both were reproduced with unchanged upstream production code and tests.
  An unchanged-source full run in the same ext4 worktree reproduced the
  migration failure: **8427 pass / 28 skip / 1 fail**, exit **1**. A four-file
  unchanged-source neighbor run reproduced the durability failure: **43 pass /
  1 fail**, exit **1**; randomized baseline seeds also reproduce it. Both
  bookkeeping files pass alone on the candidate: **13 pass / 0 fail**.
- An independently extracted unchanged upstream archive passed full `npm test`:
  **9015 pass / 28 skip / 0 fail** across 29 invocations, exit **0**. Archive
  and ext4 worktree have different test discovery order. This is evidence of
  order-sensitive shared-state interference, not proof of a repaired suite.

The `npm test` gate remains **red**, with matching baseline failures. No
bookkeeping behavior, test ordering, test script or filesystem override was
changed to hide them. Final-head CI remains a merge gate.

The accompanying PR preparation record contains the final commit identity,
exact local evidence locations and sanitized command output. This committed
record and runnable harness retain the before/after facts without depending
on a contributor's machine paths. No push, PR publication, deployment or
managed-service action is part of this preparation.
