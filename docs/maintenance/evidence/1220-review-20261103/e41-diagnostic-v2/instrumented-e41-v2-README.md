# Instrumented qualified E41 v2 — PR #1220

This is a **new evidence helper correcting a proven observer defect**. It does not
correct or explain the historical product/cache event. V1 and its readonly copy,
failed run, hashes and diagnosis remain unchanged. This file describes v2 only.
No tracked Meridian source or response-fidelity helper is changed.

## Portable record status

Only offline qualification ran. **No v2 live result is claimed or authorized by
this record.** This version fixes proven observer defects, not the historical
cache residual or the exact earlier live rejection. From a compatible Meridian
checkout, the archived helper can be checked with:

```sh
E2E_MERIDIAN_ROOT=<absolute-checkout> bun <this-directory>/instrumented-e41-v2.mjs --self-test
```

The retained source-helper paths below describe the original private run. The
archived helper has identical SHA256; no code or assertions were changed for
escrow. Use an isolated output copy if this evidence directory is read-only.

## Offline self-test

```sh
E2E_MERIDIAN_ROOT=/Volumes/DevSSD/meridian/review-1220-20261103 \
  bun /Volumes/DevSSD/meridian/evidence/review-1220-20261103/instrumented-e41-v2.mjs --self-test
```

The finalized result is `instrumented-e41-v2-self-test.json` beside this file.
No original SDK query, model request, or grant read occurs in this mode. The SDK
module is imported only to spy on the export and invoke that **mock** through a
second module alias. Only the actual pure `guardUpstreamIdle` module is imported
for guarded iterator tests. Two owned Bun subprocesses have an empty environment
and test sanitized output capture and a failing deadline.

Controls cover:

- Self-iterating and **distinct-iterator** Query shapes, selected iterator and
  original Query method custody, exact step/message identity and order.
- Bound Query `close` and `interrupt`; original `next`, `return`, and `throw`
  method calls and rejection object identity.
- A synthetic inner-iterator cleanup rejection swallowed by the real idle guard
  is recorded with exact method/target/phase, without native stopped state or
  invalid evidence. The original Query.return/cleanup is **not substituted**.
- `onValue`, `onDone`, and actual report-write failures invalidate evidence only;
  they do not replace a step, throw a fabricated product error, or set native
  stop state. Underlying method rejections are propagated unchanged.
- Full-fidelity object pass-through, ordered `api_retry`/assistant/message_start,
  async prompt consumption, no raw sentinel/env/getter serialization.
- Normal maxTurns=1 + observed tool_use + result/error_max_turns remains an
  original-fixture-adjudicated tool-boundary candidate. Cap-without-tool,
  unrelated native result errors and native refusal metadata stop further SDK
  queries. Original HTTP/provider error guards remain unchanged.

The tests are synthetic diagnostic controls. A PASS does not establish the exact
exception behind V1's live `query-iterator-error`; that error was not retained.

## Live contract — only the parent may coordinate

V2 imports the **unchanged current**
`scripts/e2e-qualified-passthrough-turns.mjs` from `E2E_MERIDIAN_ROOT` after SDK
spies are installed. It never copies/rewrites the fixture, alters its assertions,
cache floor, options or response replay, injects a retry/fault, or performs an
extra model arm. The existing installed client-plugin and server-scrub preflight
must pass before grant loading. The selected checkout/installed plugins are
assumed trusted.

```sh
E2E_MERIDIAN_ROOT=<absolute-selected-checkout> \
E2E_ALLOW_LIVE_MODEL=1 \
E2E_LIVE_PROFILE_FILE=<private-task-owned-access-only-profile.json> \
E2E_CLIENT_PLUGIN_PATH=<installed-matching-Meridian-V1>/dist/meridian/index.js \
E2E_CLIENT_VERSION=<installed-Meridian-version> \
E2E_PLUGIN_PATH=<installed-opencode-scrub>/dist/index.js \
E2E_SCRUB_VERSION=<installed-scrub-version> \
PROBE_MODEL=claude-opus-5-5 PROBE_PARALLEL=0 PROBE_PORT=<unused-loopback-port> \
  <approved-bun> /Volumes/DevSSD/meridian/evidence/review-1220-20261103/instrumented-e41-v2.mjs --run
```

Use approved real paths/versions and the task's pinned runtime tuple; do not put
credentials on the command line. Start with sequential JSON (no `--stream`).
`--stream` or `PROBE_PARALLEL=1` selects another existing mode only when separately
admitted. There is no automatic rerun or encrypted retry/fault arm. Stop an arm
on failure; an unexplained green rerun cannot explain earlier failures.
`--worker` is internal and must not be invoked directly.

Final READY is delivered only after the helper, README and offline result are
complete and the helper hash is frozen. Parent must execute an immutable copy
matching that hash. Any later change must be a separately named/versioned helper,
never an edit of a running or frozen artifact.

## V2 correction and error semantics

The installed SDK0.2.141 Query returns `this.sdkMessages` from
`Symbol.asyncIterator`, but Query.return calls cleanup first. V1 incorrectly
returned its Query proxy and therefore substituted Query.return for the selected
inner iterator's return. V2 calls the original Symbol.asyncIterator and wraps
**that exact selected iterator**. When it returns itself the proxy is reused;
when distinct, the distinct iterator is wrapped and its methods retain their
own receiver. Other Query methods remain bound to the original Query.

Iteration records query/iterator/call IDs, exact method, operation target
(`query` or `query-returned-iterator`), start/selection/settlement, done state,
UTC/monotonic timestamps and safe failures. Underlying method or result-shape
errors are recorded separately and propagated as the **same exception object**.
No underlying next/return/throw rejection sets generic native stopped state.
The unchanged owning fixture/idle guard decides how to handle that rejection;
there is no blanket claim that cleanup errors are safe. Native terminal
error/refusal metadata still sets the explicit stop state.

Observer `onValue`/`onDone`/event/report failures set `evidenceValid=false` with a
separate phase and safe error metadata. They do not replace SDK results/errors
or manufacture a product failure. Even if the original fixture later passes,
invalid observation makes the wrapper/supervisor **FAIL**, with
`failureSource=observer-evidence-invalid`. Report-write failure forces nonzero
worker exit; it cannot leave an accepted stale PASS report. This is an evidence
failure, not proof of a Meridian product failure. The fixture is still allowed
to complete/close its owned children through its unchanged control flow.

Safe error metadata uses allowlisted error names/codes, numeric errno/status,
and bounded SHA256/length of message/stack/unknown name/code. It never emits raw
message/stack, nested cause, env, transport, request or response objects. Error
getters are not invoked. If metadata capture itself fails, that fact is recorded
without replacing the original error.

## Capture, scope and bounds

Same metadata scope as V1: each query's options digest and consumed prompt/item
and completed ordered-prompt digests; requested/checkpoint/fork/target IDs and
start times; native assistant and message_start usage **separately**; result and
api_retry order; supported history row/block digests from the existing fixture's
calls only. Allowlisted requested/actual `claude-opus-5-5` model labels are kept
alongside hashes. Repeated assistant/message IDs are not separate billable prefix
observations and must not be summed without identifying duplicates.

No history scan or private transcript read occurs. All query/history directories
must canonicalize to the newly created owned `meridian-probe-proxy-*` fixture;
config must remain below it. Missing owned config leaves are allowed before SDK
creation only after existing ancestors canonicalize within the fixture. Default
owner config is never allowed. oauth-token profiles set config to
`WORKDIR/meridian-config/profiles/<owned-profile>` in current `profiles.ts`.

Digests exclude env maps and credential-named fields, do not invoke getters,
and hash function source rather than closures/opaque state. Hashes are equality
witnesses, not a raw replay archive. No raw model text/thinking/signatures/tool
inputs, prompts or grants are written by this wrapper. Root/relative owned config
locators and SDK IDs are intentional fixture metadata.

Supervisor drains original stdout/stderr, including captured console/say/direct
writes, counts and hashes bytes only, and emits private JSON paths plus verdict.
It creates one owned POSIX process group. Default deadline **1000 s**, configurable
integer **30..1200 s** via `E2E_INSTRUMENTED_TIMEOUT_SECONDS`; **8 MiB** captured
output bound; TERM then **5 s** to KILL plus **1 s** hard pipe-join bound. Timeout,
interrupt, missing child join or evidence invalidity cannot PASS. Windows is not
supported. Normal child/process-gate custody remains the fixture's.

Bounds are unchanged from V1: 16 queries, 4096 events, 1024 rows/history call,
256 blocks/message, 256 prompt items, 100000 fingerprint nodes, 64 levels and
4 MiB/report. V2 adds method events, so event capacity is consumed faster; a
bound/report failure invalidates evidence, never relaxes a product assertion.

Reports are timestamp/PID `instrumented-e41-v2-*.json` beside the helper. The
original private qualified fixture report and plugin witnesses remain in its
owned fixture. Keep evidence until parent escrows it. No original product or
fixture constants/assertions are modified; all listed limits are wrapper safety
constants.

## Remaining acceptance limits

The protocol host runs the installed V1 Meridian header plugin and server scrub;
it is **not the OpenCode executable** and does not qualify V2. Actual affected
OpenCode generation/plugin/runtime verification remains separate under `E2E.md`.

This helper does not recover the missing original fixture, encrypted fault,
transient transport/cache-breakpoint/request-start/cache-lifetime evidence or
signed generated history, and does not add the old 200 ms store hold. SDK
observation times are not API request-start times. Hash/report writes add timing
overhead. Preserve all before/after artifacts; do not equate a current green with
reproduction or explanation of the historical 3332→3132 cache residual.
