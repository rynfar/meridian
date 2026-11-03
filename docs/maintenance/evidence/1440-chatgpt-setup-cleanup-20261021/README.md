# ChatGPT pre-backend setup cleanup: #1440

Accept with maintainer test corrections. Nowaker's signed original `e4bc487e1afeac45bc4b855692dfec147aa2cb43` remains on their own [PR #1440](https://github.com/rynfar/meridian/pull/1440). Final candidate `9b54e3101f06dc4d3096a82a325e38c8d1a3bf36` merges current main `a5a939be8e3bd43e73b8750963900568530e6445` and adds a separate signed test correction. Exactly two files differ from main. No release or public API change is included.

When session-key reading or session-tree registration throws after admitting a ChatGPT turn, the old path never releases its work count, abort listener or shutdown ownership. Both operations now run inside the existing cleanup try/catch. An uninitialized tree handle remains optional; success, streamed completion and cancellation keep the existing cleanup path. There is no known client payload that triggers these throws today; this is a defensive lifecycle correction rather than a claimed production incident.

## Review and exact-head verification

The complete final diff, adjacent dispatcher, response cleanup, drain and cancellation callers were inspected. The correction covers both throw sites and retains error propagation. New tests require the actual admission-count/cleanup capabilities, join owned fixtures, test both sites and verify exact abort-listener removal. Eight direct tests and70 adjacent tests pass. Final local typecheck/build and all26 `npm test` groups pass: **8,098 pass / 36 skip /0 fail**, with qualified SQLite3.53.4, Bun1.4.3, Node22.22.3 and the verified1.84.0 compatibility artifact. All eight executed exact-head hosted checks pass, including `test`; optional changelog check is skipped. All three introduced commit signatures are verified.

## Real local HTTP before/after

The same runnable fault gate sends actual HTTP requests through the real server on Darwin arm64, using synthetic follow-external credentials and blocking external fetch/SDK generation. Both the original composition and final composition reproduce these deterministic facts:

| Boundary | Unchanged main | Candidate |
| --- | --- | --- |
| Session-key reader throws | HTTP500; count1, listener retained, backend cleanup remains pending | HTTP500; count0, exact listener removed, backend cleanup joins |
| Session-tree registration throws | Same leak | Same completed cleanup |

At both sites there are zero SDK queries and zero backend generation requests: the changed boundary precedes provider dispatch. This is the actual affected error flow, not a successful ChatGPT-model response or a client-application interoperability claim. Ordinary stream/drain/abort behavior is protected by the adjacent regression suite. No account login, model inference or actual credential is needed for this gate.

The initial baseline recorder awaited the deliberately stuck cleanup and hit its120s controller timeout without flushing a receipt. That failed recorder is retained. The corrected recorder preserves intermediate state, closes its HTTP transport, records the baseline's unjoined backend owner, joins every actual child and ends only its owned process. It then proves successful backend joining after the fix. This is a recording/termination correction; the failed-before and passed-after count/listener assertions are unchanged. All temporary synthetic fixtures are removed after each terminal controller; no private SDK files were read.

[Exact harness, reports, historical recorder failure and logs](proof.tar.gz), [member hashes](manifest.json). Verify archive/member hashes before extracting. The harness requires an explicit frozen `E2E_MERIDIAN_ROOT` and owned output location; use isolated config and the documented pinned runtime. Dependency installation was reused from completed1426 with its SDK module hash unchanged. Merge/actual-Author/tree verification and final checkout removal are separate post-merge receipts.
