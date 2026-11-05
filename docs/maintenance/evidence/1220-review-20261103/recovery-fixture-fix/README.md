# Deterministic recovery fixture — #1504

Signed final test-only head `813cac6cb48c33cbc3bb5f42d0b7c37067010ba8` adds the independently
reviewed frozen source `f4b9e510928500b7567f9d8b37354e0cba82337ec16d5146e2e1a4933e4c8bfd`. No production change.

Original local suite:8270pass/65skip/1fail; all Antigravity probes pass. The
remaining test delays mandatory root/SHA600ms each, leaving scheduling-dependent
budget exhaustion. Exact original native failure cause is not recoverable.

Replacement: real mandatory subprocesses return immediately; child-local logical
clock charges800+800ms, then real optional native SIGKILL timeouts250/150ms.
Exact timeouts[2000,1200,250,150], actual root/SHA, unknown optional facts,
no config call after exhaustion, and dead native PIDs pass. Focused10/0,
75assertions; typecheck passes. Production2000ms total/250ms optional deadlines
and separate real exhausted-root/TERM-resistant/fingerprint controls are unchanged.
The800ms charges are test inputs, not sleeps or production deadline changes.

Both shadow negatives fail: fresh per-command deadline gives
[2000,2000,250,250,250]; allowing a post-exhaustion call gives
[2000,1200,250,150,250]. All native child PIDs are dead. One invalid shadow
build-root attempt is retained separately, not counted as discrimination.

Independent review found no material source issue. Final combined local
npm test passes all26 groups (8819pass/65skip/0fail); typecheck/build and
exact-head CI pass. PR #1504 merged normally at `1e24a969cc8aba8c62ad3fcea87a4f3da69c6e52`.
The signed landed tree equals the reviewed tree; no production code changed.
[proof.tar.gz](proof.tar.gz)/[manifest.json](manifest.json) retain exact source,
logs, mutation receipts, negative controls and independent review; hashes verified.
