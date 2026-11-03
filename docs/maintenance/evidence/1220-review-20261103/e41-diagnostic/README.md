# Instrumented qualified E41 helper — PR #1220

## Portable archive names

This directory preserves the failed frozen observer as `helper.mjs`; it is
**not fidelity-qualified**. See `iterator-diagnosis.md` and the worker receipts.
Do not use it for live acceptance. The read-only offline control is runnable:

```sh
E2E_MERIDIAN_ROOT=<absolute Meridian checkout> bun <this-directory>/offline-iterator-diagnosis.mjs
```

Its only path adjustment points to the archived `helper.mjs` filename; original
assertions and immutable helper SHA256 remain unchanged. The result is written
beside the control. The original source-helper paths below identify the earlier
private invocation, not a claim that they are portable checkout paths.


This is an external diagnostic wrapper, not a source change or acceptance result.
It imports the selected checkout's **unchanged**
`scripts/e2e-qualified-passthrough-turns.mjs` after installing Bun SDK spies.
The current client-plugin and server-scrub preflight, original assertions,
95% cache floor, six-round bound, response-fidelity parser, and child custody stay
in the original fixture. No retry/fault arm is added.

## Offline verification (safe; no credentials or model requests)

```sh
E2E_MERIDIAN_ROOT=/Volumes/DevSSD/meridian/review-1220-20261103 \
  bun /Volumes/DevSSD/meridian/evidence/review-1220-20261103/instrumented-e41.mjs --self-test
```

The persisted result is `instrumented-e41-self-test.json` beside this file.
The test uses a controlled iterator, not the SDK's original query implementation.
It verifies every message/result retains identity and order, bound
`close`/`interrupt`/`return`/`throw`, prompt consumption order, assistant and
`message_start` accounting, `api_retry` ordering, refusal stop state, omitted env
values, no getter invocation, and no sentinel serialization. The SDK is imported
only to test a mocked export alias; the original query is never
called. Two owned short-lived Bun children test stdout/stderr suppression and a
failing bounded timeout. The timeout child has no credential-bearing environment.

## Live invocation contract — parent coordinates; NOT executed here

Use the parent-approved Bun executable and pinned SDK/native/model/platform tuple.
The first diagnostic arm is sequential JSON (`PROBE_PARALLEL=0`, no `--stream`).
After the task-owned grant and both installed plugins have been admitted:

```sh
E2E_MERIDIAN_ROOT=<absolute-selected-checkout> \
E2E_ALLOW_LIVE_MODEL=1 \
E2E_LIVE_PROFILE_FILE=<private-task-owned-access-only-profile.json> \
E2E_CLIENT_PLUGIN_PATH=<installed-matching-Meridian-V1>/dist/meridian/index.js \
E2E_CLIENT_VERSION=<installed-Meridian-version> \
E2E_PLUGIN_PATH=<installed-opencode-scrub>/dist/index.js \
E2E_SCRUB_VERSION=<installed-scrub-version> \
PROBE_MODEL=claude-opus-5-5 PROBE_PARALLEL=0 PROBE_PORT=<unused-loopback-port> \
  <approved-bun> /Volumes/DevSSD/meridian/evidence/review-1220-20261103/instrumented-e41.mjs --run
```

Substitute real approved paths/versions; do not paste grants into the command.
`PROBE_MODEL` must be explicit. `--stream` and `PROBE_PARALLEL=1` select the other
existing fixture modes; they are separate runs, not automatically retried arms.
No run should continue or be rerun to turn an unexplained failure green.
The current qualified fixture hosts the installed V1 header plugin; it does not
run the OpenCode executable or qualify V2. Actual affected-client E2E and all
applicable plugin-generation preflight remain separate gates in `E2E.md`.

Only `--self-test` or `--run` is public. Do not call the internal `--worker` mode.
Run output names private timestamp/PID JSON reports beside this helper. The worker
report gives the one owned temporary fixture root. The original private
`qualified-e41-report.json` remains there with full original plugin witnesses;
the wrapper retains only bounded allowlisted verdict/plugin facts. Keep both
reports and the owned fixture until the parent escrows approved evidence.

## Captured evidence and safety

- SHA256 of the selected original fixture and response-fidelity helper, checked
  unchanged again at successful completion. No tracked files are edited.
- Every SDK query's canonical options digest, per-prompt/item digests and completed
  prompt digest, selected resume checkpoint and fork/target session IDs, and query
  start time. Async prompts are observed only when the SDK consumes them; never
  preconsumed. A prematurely returned prompt is marked incomplete.
- Native assistant and `message_start` usage separately; assistant/message UUIDs,
  block types/digests, result usage, session init, and `system/api_retry` attempts,
  delays/status in global observed message order. Duplicate assistant/message IDs
  remain separate observations: do not sum repeated usage as separate prefixes.
- The existing fixture's supported `getSessionMessages` calls only. No extra
  recovery scan or private transcript access. Requests must name an observed or
  requested owned SDK session, exact fixture project, and config directory below
  that fixture. Rows retain UUIDs, message IDs, usage and row/block digests.
- UTC and process-monotonic observation timestamps. Owned fixture root and
  relative config locators are intentional metadata, not ambient account paths.
- Environment maps and secret-named fields are excluded from fingerprints;
  functions are source-hashed, getters are not invoked. Content is digested in
  memory, never written as raw prompts/thinking/signatures/tool inputs/text.
  Closures, non-enumerable fields and opaque internal state are not fingerprinted.
  Digests are equality witnesses, not reversible replay archives or proof that
  all transient transport bytes are known.
- Original stdout/stderr (including its captured `say` and direct
  `process.stdout.write`) are drained by the supervisor, counted and hashed only;
  no raw output is re-emitted or saved by this wrapper. Plugin package/version,
  artifact hashes, runtime invocation/error counters are allowlisted. External
  plugin paths are hashed in the wrapper report; original private fixture witness
  is retained separately.
- SDK native error/refusal metadata or iterator failure stops further queries.
  The original result is still delivered unchanged to the fixture. One documented
  current Meridian handoff is not a terminal error: `result/error_max_turns` with
  `maxTurns=1` after the same query actually emitted `tool_use`. It is recorded as
  a **tool-boundary candidate**, including its unchanged `is_error` value; only the
  original fixture can establish successful forwarding/checkpoint/history. A cap
  without tool-use or any other result error still stops. Offline positive and
  negative controls cover this distinction. A retry notice is recorded, not
  treated as a terminal error. Free-form refusal text without
  native refusal metadata is not semantically classified; original fixture
  assertions still apply. HTTP/provider errors stop in the original fixture.

The supervisor owns one new POSIX process group. Default deadline: **1000 s**;
`E2E_INSTRUMENTED_TIMEOUT_SECONDS` may select an integer **30..1200 s**. On timeout,
interrupt or excess raw output (**8 MiB**), terminate only that owned group,
escalate after **5 s**, then bound pipe joining by one further second. Such a run
is **FAIL**, never a normal-custody PASS. The fixture's own normal child joins
remain required. Windows is not supported by this supervisor.

Other added bounds: 16 SDK queries, 4096 recorded events, 1024 rows per supported
history call, 256 blocks per message, 256 prompt items, 100000 fingerprint nodes,
64 levels, 4 MiB per report. Exceeding a bound fails the arm. These are wrapper
safety limits, not changed product constants. No original assertion, deadline,
cache floor or full-response fidelity helper was modified.

## Limits and unresolved historical evidence

The historical observer source is
`1cb9e53cb4ded92b8589177265cb736eb0978011:scripts/e2e-session-store-turns.mjs`
and its bound-method observer. This wrapper does **not** reproduce its 200 ms
store hold. It does not recover or invent the missing encrypted retry/fault
transport, original failing fixture locator, original cache breakpoints, API
request-start/cache-lifetime facts, or original signed generated history.

Observation times are SDK-boundary times, not proof of actual API request times.
Hashing and bounded synchronous report writes add overhead; compare like-for-like
instrumented arms and do not infer original cache lifetime from them. The fixture's
own source-history reads occur after its unchanged 1.5 s drain wait.

A PASS means this selected current fixture execution passed its existing gates
and this observer's bounds/custody checks. It does **not** mean the historical
3332→3132 residual (200 tokens, below the unchanged 95% floor) was reproduced or
explained, and it cannot establish that #1220 caused or fixed that event.
No exact retained encrypted-fault harness was found. A green unchanged-main
control or newer tuple cannot close the old causal evidence gap.

Assumptions: the selected checkout and installed plugins are trusted; only its
newly created `meridian-probe-proxy-*` directory is eligible for history capture;
SDK query options carry an isolated config locator beneath it. Missing config
leaf directories are allowed before SDK creation, but existing ancestors are
canonicalized and must remain owned. No ambient credentials are inspected here.
