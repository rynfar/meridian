# Independent cancellation settlement review

No material findings in the complete test-only correction from frozen `c237ab9a` to test SHA-256 `3324e04a68416c06f65673c59fa7d65a7d94033d412b67db3165c0b2955b1485`.

The preserved full-run failure is first-stage **5,069 pass / 35 skip / 1 fail**, 26,138 assertions; later isolated stages did not run. Its assertion observed tracked3 instead of2 after the auxiliary SDK abort and main/child survival assertions passed. All six retained artifact hashes/lengths match their identity record.

Actual source explains the boundary: response-body cancel aborts the SDK but does not return streamCompletion. Asynchronous fork-retirement finalizers precede streamCompletion settlement, then responseCompletion.finally(finishRequest) releases the request's registry entry. The original fixed ticks did not observe retirement.

The corrected predicate terminates on the required count or a monotonic two-second timeout, with no detached raced polling task. It proves initial tracked3, observes tracked2 **before every original survival assertion**, and observes teardown tracked0 before the original zero assertion. Existing expectations, legacy settle and unrelated timing checks remain unchanged; direct mock abort remains cleanup after the subject assertions. Production is unchanged. The inspected focused receipts record5/47 and whole-file17/95, both zero failures.

Fresh parent-controlled full npm/typecheck/build gates remain required. Actual Linux Claude Code/installed SDK+CLI/exact served Sonnet E71, E55 and all four E41 are open. No reviewer tests, probes, models, credentials, source edits or network/GitHub mutation occurred. The auth-boundary qualification is appropriate: explicitly fenced shutdown interception does not extend to every older SDK-mocked fixture or prove whether an earlier real refresh occurred.
