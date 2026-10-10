# Scoped root adversarial review

Disposition: **FIT_FOR_VERSIONED_OWNED_STOP_OBSERVER_WITH_ACTUAL_CLIENT_MODEL_CI_HOLDS**.
This is a root source/offline review, not a delegated or whole-change approval.
The six-file observer/test change at `052c6449` was inspected against `ef371037`.
Production, package/lock, public interfaces and the strict handback predicate
have no delta in this correction.

Inspected the maintained harness interception and the independent witness:
per-original-query ownership, root session/hook identity, streamed generation and
block closure, semantic JSON input matching, complete tool metadata and final
UUID, retained final hook, single public interrupt, successful raw settlement,
terminal/error exact match, abort/retirement and close. Checked its bounded maps,
input/error limits, scalar-only summaries, helper input identity, explicit native
tuple admission, legacy default behavior and independent HTTP/model/cost/custody
requirements. Checked all synthetic fixture branches and their deliberate broad
consumer catch: the unrelated-error negative still rejects that false success.

Concrete findings and corrections:

1. Native three-tool proof rejected a buffered denial result because the harness
   wrapper had not yet resumed after the original hook. The first eight-query
   run remains FAIL. Final qualification correlates results with eventual exact
   accepted hook outputs, without imposing callback/event scheduling. The same
   response/product assertions remain; unit ordering controls and the final
   native source/installed runs verify the correction.
2. Inspection found that earlier prefix wrappers may still be awaiting while the
   final hook starts its control. Requiring every pending wrapper to wait for
   acknowledgement can reject valid prefix settlement. The witness instead
   requires the latest invoked/final retained hook to remain pending at intent
   and settle after acknowledgement. Earlier wrappers must still settle with
   exact forwarding denials. Direct positive/early-final-release negatives cover
   this distinction; final native arms use the corrected bytes.
3. Terminal errors were held by reference. Copying the bounded string array
   preserves the observed terminal identity through later iterator failure
   matching, avoiding mutable external event-array authority.

Meaningful negatives include no interrupt, missing/early retained hook, wrong
session/input/namespace/hook kind, nested work, changed metadata/UUID, extra
generation, repeated control/result, abort, early close, missing/rejected control
settlement, wrong terminal subtype/flag/reason/counter/errors, unrelated iterator
failure, missing denial result and failed close. HTTP/hook custody, dropped tools,
generation caps and unsupported SDK/native versions independently reject.
Original legacy controls pass; the full final local gates are escrowed separately.

No material scoped finding remains. Real affected client/model acceptance is
still missing; none of these offline or synthetic passes clears that gate. Keep
#1322 draft and source PRs open until all inherited gates and final-head CI are
qualified. The backlog goal remains active.
