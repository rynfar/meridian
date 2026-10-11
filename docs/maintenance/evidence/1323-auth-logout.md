# Explicit logout correction (#1323)

Accept with verification and Windows smoke-check corrections. A joined Claude
CLI exit 1 carrying valid JSON `loggedIn: false` is an observed logout. It must
replace a remembered login and survive a subsequent unavailable probe. Other
exits, killed/signalled processes and malformed answers retain the preceding
observation. The previous successful-check timestamp and account metadata stay
available; logout is not a successful login. Existing health/profile response
shapes, executable selection and process ownership are preserved.

## Source and credit

Base: `11dc1556363ba0b0e5786d999b9fcc30aa169364`. Source #1323:
`5163d99816af7e1de0653e0d352a05904a908286` by Nowaker
`<spam@nowaker.net>`. Actual commits `bd3aa844` and `5163d998` were cherry-picked
as `c9c31091` and `77d0fa76`; raw Author/AuthorDate and complete messages match.
Maintainer controls and native proof are separate. See
[identity receipt](1323-auth-logout/identity.json).

## Failed before and passed after

The four contributor regressions all fail with unchanged main's models.ts and
pass with the correction. The first full focused run passed 57 tests, 192
expectations before the four added unavailable-answer controls. No altered
assertion is used to qualify the correction.

The existing committed native harness now requires an actual negative CLI answer
to become unhealthy/503 on `/health` and false/live on `/profiles/list`, without
advancing the successful-login timestamp. Its unchanged assertion fails against
main in both cache contexts (`EXPLICIT_LOGOUT_NOT_RECORDED`) and passes after
correction in both. Initial pending probes still read degraded/never. Logs
retain original failures; the modified harness supersedes only the historical
#1285 unknown-logout expectation, not its positive/login or ownership controls.

The native input is official Claude Code 2.1.284, Darwin arm64, SHA256
`50a14c2f50f56668380fdda490167f1d3630d5cc18fb8aed3073c2c7ea7314fe`.
SDK 0.2.141 is actually imported and query observation refuses generation.
Both before arms and final default/profile source arms use Bun 1.3.11. A first
default after arm used Bun 1.3.14 and remains separately qualified. All arms
record exit, close, both captured-pipe closure and zero queries. Native config
matches the task-owned empty directory; credential files remain absent.
Sanitized [before/default](1323-auth-logout/native-default-before-result.json),
[before/profile](1323-auth-logout/native-profile-before-result.json),
[after/default](1323-auth-logout/native-default-floor-after-result.json) and
[after/profile](1323-auth-logout/native-profile-after-result.json) receipts retain
assertions and joins. This auth-only flow has no implicated model generation or
coding-client turn. No owner token or customer transcript is used.

Run the committed harness as documented in E2E.md, `--case=logged-out`, both
contexts, no token/input arguments, and new task output directories. The exact
binary hash is checked before execution. The same assertions apply to an
independently installed package entry.

## Adversarial review

Root inspected the complete contribution, current-main cache/resolver/process
leaf, health/profile callers, warning privacy, cache generation and reset,
closure ownership, test isolation and Windows workflow. This is a root review,
not a delegated independent review. No new public contract/module boundary is
introduced. Observed exit/pipe settlement precedes result rejection, so callback
JSON alone cannot qualify logout before join; cancellation/unknown cleanup keep
the unavailable path and retained ownership. Stale answers do not bypass the
generation/cancellation check. Default successful-check time is now tracked
separately and reset with the cache, as named profiles already do.

A Windows smoke-check weakness was corrected: PowerShell string-to-boolean
comparison could admit a string `"false"`. The exact workflow predicate now
requires a boolean false for 503, plus unhealthy status and the existing version
check. Six real PowerShell controls pass: observed logout and healthy pass;
string false, absent auth, true auth and wrong state reject. The HTTP test still
asserts exact unhealthy/degraded/healthy shapes, and mode remains required only
in shapes that define it. No material source finding remains. Native Windows
behavior is for final-head CI's real Windows smoke, not a claim from Mac proof.

## Delivery gates

Final local npm test passes **5,560 / 0 fail / 35 skip**, across 21 isolated
invocations. Standalone typecheck and build pass on Bun 1.3.11 / Node 22.22.3.
All 61 auth-status tests pass, including the four added unavailable-answer
controls. The gate observer captured code head `8bbba602`; subsequent `20664d1c`
adds docs and the separately exercised Windows predicate only. Runtime/test and
native-harness blobs match exactly. See [local verification](1323-auth-logout/LOCAL_VERIFICATION.json).

A certified build from clean `20664d1c` was packed and installed independently,
with lifecycle scripts disabled, empty npm configs and SDK pinned at 0.2.141.
All 428 installed dist files equal the build; the same default/profile native
logout assertions both pass, with joined roles and zero queries. Tarball SHA256:
`08d0202984f6d2fe450daef2a75cbfeefafa84ba194b8b7e33049ca7e1dfd537`.
[Package receipt](1323-auth-logout/PACKAGE_RECEIPT.json),
[default result](1323-auth-logout/installed-default-after-result.json),
[profile result](1323-auth-logout/installed-profile-after-result.json).
This is a local test package, not publication. The final documentation-only
checkpoint preserves tested executable blobs; final-head CI remains required.

Exact-head CI is pending. No merge, source closure, publication or whole-backlog
completion is claimed. Owner HEAD, index, dirty file bytes/modes and status
matched the preserved baseline.

The initial full run under Bun 1.3.11 / Node 22.0.0 failed the unchanged
antigravity attachment test because that Node lacks transform-types. The same
assertion reproduces on exact main; both main and candidate pass it on Node
22.22.3. Its failure log is retained. The complete suite passed under
Bun 1.3.11 / Node 22.22.3; no product test or assertion was weakened.

An attempted parallel package build refused `inputs-changed` because proof
documents changed during source certification. Its tarball/install are retained
as unaccepted diagnostics and were not used for runtime acceptance. Rebuild
only after freezing the checkout. This is an orchestration failure, not a
product correction or a passing build.
