# Frozen E41 observer: read-only iterator diagnosis

2026-11-03. No helper/source edits, model calls, credential reads, or live rerun.
Frozen helper SHA256 remains
`8514c16b9dd4d93fe3c4425d24eb1eeffe4b60bbfee67b525af4749ef970899c`.

## Observed run, not inferred cause

`instrumented-e41-1793694353443-41015.json` records one query, 20 SDK messages,
`claude-opus-5-5`, a native tool-use assistant and an expected one-turn
`result/error_max_turns` candidate. It records `query-iterator-end` with
`method: return`, then supported history with matching tool block digest. The
final state is `stopped: true`, `stopReason: query-iterator-error`; a second query
was refused by the wrapper. The original fixture failed and joined its children.
There is no recorded iterator error method, call identity, exception, or phase.

**The exact original rejection cause is not established.** In particular, the
recorded `method: return` end event means an underlying return operation reached
`onDone`. One cannot say that this same return operation rejected inside the SDK.
A later/different pull/return/throw rejection, or an observer callback/report-write
failure after that event, are not distinguished by retained evidence.

No cache-prefix continuation was admitted, so this run does not reproduce or
explain the historical 3332→3132 residual. Its one tool-boundary observation is
retained evidence; it is not acceptance for the fixture or #1220.

## Two established observer defects

1. **Distinct iterator custody changes.** SDK0.2.141 `sdk.mjs` around offset 314106
   implements the following shape (supported installed module, not private data):

   ```js
   next(...[$]) { return this.sdkMessages.next(...[$]) }
   async return($) { return await this.cleanup(), this.sdkMessages.return($) }
   async throw($) { return await this.cleanup(), this.sdkMessages.throw($) }
   [Symbol.asyncIterator]() { return this.sdkMessages }
   ```

   The frozen observer instead returns its Query proxy from
   `Symbol.asyncIterator`. A normal consumer now invokes **Query.return**, which
   cleans up first, instead of the actual returned **sdkMessages.return**.
   The original self-test used only a self-iterating object and missed this.

2. **Error provenance is lost and ignored cleanup errors affect the next query.**
   The frozen `observeIterator` has one `try` enclosing the underlying method,
   `step.done` access, `onValue`, and `onDone`. Its catch calls argument-free
   `onError()`, so SDK failures and observer/hash/report failures receive the
   same persistent `query-iterator-error` stop state. The real
   `guardUpstreamIdle` deliberately observes but swallows an abandoned pull's
   late rejection and the finally-return promise rejection. The observer still
   stops subsequent SDK requests when such a swallowed rejection occurs.

## Offline discriminating control

Escrowed script and result:

- `instrumented-e41-offline-iterator-diagnosis.mjs`
- `instrumented-e41-offline-iterator-diagnosis.json`

Invocation (offline):

```sh
E2E_MERIDIAN_ROOT=/Volumes/DevSSD/meridian/review-1220-20261103 \
  bun /Volumes/DevSSD/meridian/evidence/review-1220-20261103/instrumented-e41-offline-iterator-diagnosis.mjs
```

The script copies the frozen observer verbatim, checks its immutable SHA256,
and imports only the actual pure `guardUpstreamIdle` implementation. It never
imports/calls an SDK query, reads a grant, or invokes a model.

A controlled Query returns a **distinct** inner iterator and has a synthetic
cleanup rejection. Results on Bun1.3.14/macOS arm64:

| Arm | Actual method calls | Outcome |
| --- | --- | --- |
| Unwrapped Query | `query.asyncIterator`, `inner.next`, `inner.return` | Completes consumer break; no Query cleanup |
| Frozen observer | `query.next`, `inner.next`, `query.return`, `query.cleanup` | Rejects synthetic cleanup sentinel; observer stops |
| Frozen observer + actual idle guard | same changed calls | Idle guard swallows rejection, observer stop persists |
| Diagnostic-only distinct-iterator-preserving wrapper + actual guard | original method calls | Completes; observer does not stop |

A second controlled case makes `onValue` throw, then makes native `next` throw.
Both call `onError` with **zero arguments**, proving identical report provenance.
The sentinel is synthetic. These controls prove the custody change and its
ability to cause a spurious persistent stop; they do **not** establish that this
synthetic exception or transport sequence was the live run's actual exception.

## Proposed future reporting contract (not implemented here)

Any new helper version should be immutable before readiness and tested offline
with both self-iterating and distinct-iterator Query shapes. Its iteration should
observe the **actual iterator returned by the original Query's**
`Symbol.asyncIterator`; Query `close`/`interrupt` and other methods must remain
bound to the original Query. Do not silently treat all cleanup errors as neutral
or broadly weaken the stop-on-error requirement.

Retain every next/return/throw call and settlement with:

- A globally ordered event, query ID, iterator ID, per-call ID, UTC/monotonic time.
- Exact `method`: `next`, `return`, or `throw`.
- Exact operation target: `query` or `query-returned-iterator`.
- Separate `phase`: `underlying-method`, `result-shape`, `onValue`, or `onDone`.
- Settlement: success/done, observed rejection, or observer exception. Keep the
  original result/error object delivered unchanged to the owning consumer.
- Safe error metadata: allowlisted error name and code, numeric errno/status when
  present, bounded digest of message/stack; hash unknown values rather than emit
  arbitrary strings. Do not serialize `env`, error causes/requests/responses,
  transport objects, prompt text, or raw stack/message. Record metadata-capture
  failure separately rather than replacing the original exception.
- Whether the error was returned to a current consumer or belonged to a pull
  already abandoned/being closed. Only actual owning control flow can establish
  terminality; a background diagnostic observer must not redefine the guard's
  existing handling invisibly.

The retained run lacks this metadata. It cannot be recovered from the current
hashes. A future immutable observer version and its evidence would be a new run,
not a correction that retroactively makes this failed arm green.
