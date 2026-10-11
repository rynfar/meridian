# Slow auth-status delivery (#1285)

Disposition: accept with maintainer corrections. A cold Claude executable can
take longer than the five-second HTTP caller wait. Killing every first check at
that boundary leaves health degraded and profiles without an observation. The
check now has its own 90-second limit; callers retain their five-second wait,
share one check, and can use its late result. Existing known-good observations
remain available while refreshing. Pending or failed first checks retain
`authProvenance: "never"`; nonzero CLI exit does not become verified logout.
Public route shapes, headers and proxy configuration/lifecycle signatures stay
unchanged. This is an internal correction, not a new public contract.

## Identity and contributor credit

- Base: `097530c824c7c2096c82b89de85fd6550479b603`, including delivered #1298.
- Original #1285: `08ddd8b061a2d271f8af397b83baf2a33f4deb4c` by Nowaker
  `<spam@nowaker.net>`, authored `2026-10-04T16:21:04-05:00`.
- Authored incorporation: `b67c2f8a6e20aaa3e0ee0b7aa0ea792f1d09351b`.
  Author, date and full message are preserved; corrections are separate
  maintainer commits. The squash must retain verified human credit.
- Tested executable head: `065e7c7f620f871774a4fe0caa2497950818fd6e`,
  tree `d239e864f2611616830215860a17549b9c1bcd29`.
- Baseline: clean `2b85aa502ebe709e01ed28fbba82ab3d6f78634f`, whose full tree
  `b5c452be66706875bc848b9887e29ca6f403cb38` equals the base's landed tree.

## Concrete review corrections

Independent review inspected the complete production/test diff, neighboring
callers, shutdown, error paths, module boundaries and original review objections.
Auth refreshes now retain ownership until callback, exit, close and both captured
pipes join. Closing one instance releases only its lease; siblings and independent
direct users remain usable. Closing the last owner cancels and joins its check
before admitting a replacement. Missing joins retain the slot and fail cleanup.

The current-main executable preference and shared 45-second PATH lookup/probe
budget are preserved. A regression requires 43 seconds remaining after a
two-second lookup, rather than restarting the budget. The new ownership/process
leaves import neither server nor session modules.

Actual native testing exposed a diagnostic regression: an exec callback error
carried exit code 1 but lost its separately captured stdout, so the safe
`loggedIn: false` diagnostic disappeared. The original mock pre-attached stdout
and missed it. A corrected fixture fails unchanged production (0 pass / 1 fail).
The process leaf now attaches captured stdout to the original callback error;
error identity/code and unknown-auth classification are preserved. The warning
includes only the numeric exit and parsed boolean. Strengthened tests reject raw
JSON, field markers and the synthetic email in warnings.

## Actual native before/after

The identical committed [native harness](../../../scripts/e2e-auth-status-native.mjs)
has SHA256 `fe89d335a8dec9eef9b30587e580f86da36a2e6a85e96be77780dff183e08fdf`.
It uses Darwin arm64, Bun 1.3.11 (Node compatibility 24.3.0), actual imported SDK
0.2.141 and the public native Claude CLI **2.1.284**. Native binary SHA256:
`50a14c2f50f56668380fdda490167f1d3630d5cc18fb8aed3073c2c7ea7314fe`.
The exact native child is paused eight seconds, then resumed. Its original
stdout buffers are forwarded privately to the production auth parser; public
health/list routes exercise the parsed status. A query observer refuses and
counts SDK generations; every run requires zero queries.

| Control | Baseline | Corrected source |
| --- | --- | --- |
| Cold default cache slot | RED `LATE_NOT_HEALTHY`; native cancelled before answer | First degraded/never after about 5 s; late healthy/live in 0–1 ms; one native check |
| Cold named profile | Same causal RED | Same bounded first wait and usable late result; one native check |
| Real 61-second cache expiry, both contexts | Not asserted | Healthy/live stale response in 2 ms during one refresh; healthy after refresh |
| Close one sibling | Not asserted | Remaining owner's shared native check finishes |
| Close last owner | Not asserted | Actual cancelled check joins; replacement check succeeds |
| Independent direct user | Not asserted | Source-only direct lease survives instance close |
| Absent token | Not asserted | Actual false/exit 1 stays unknown/degraded/never; numeric/boolean warning present |

All eight corrected source cases are overall PASS, including native/wrapper/worker
exit, close and captured pipe joins; 11 actual native auth invocations, zero SDK
queries. Both baseline REDs also have complete observed joins. All 999 tracked
source files were independently reconciled to the frozen commit's bytes/modes
and unchanged after the controls. The root all-file checkpoint was taken during
controls; the author's frozen pre-test identity and direct commit inspection are
separate earlier evidence, not a retrospective pre-first-arm snapshot.

Use a new private task directory and supported access-only input for each arm;
do not point the retained contributor prototype at an owner credential store.
The actual command shape is:

```sh
bun scripts/e2e-auth-status-native.mjs \
  --task-root=/absolute/private-task-root \
  --case=cold --context=profile \
  --entry=/absolute/checkout/src/proxy/server.ts \
  --native=/absolute/verified-2.1.284/package/claude \
  --input-dir=/absolute/private-task-root/runtime-input \
  --token-file=/absolute/private-task-root/runtime-input/access-token.txt \
  --output=/absolute/private-task-root/new-cold-arm
```

Other cases are `stale`, `sibling`, `last-owner`, `logged-out`, and source-only
`direct`. Logged-out omits input/token arguments; direct additionally supplies
`--models=/absolute/checkout/src/proxy/models.ts`. Installed arms replace entry
with the independently installed package's `dist/server.js`.

## Final checks and installed package

Frozen executable 065: `npm test` (including pretest/typecheck) **5,433 pass,
35 skip, 0 fail**, 27,100 expectations across 19 processes; standalone typecheck
and build exit 0. Focused checks pass 195 / 662 expectations. A same-head
priority-store supplement passes 22 / 226, covering the one test file omitted by
the existing full runner's literal split. Earlier-head gates remain historical.

Independent `npm pack --ignore-scripts` and a fresh consumer install used empty
npm user/global configs, a new cache, explicit public registry and pinned SDK
0.2.141. All **418** installed dist files equal built source and tarball bytes.
Tarball SHA256: `a2bb2ce397008690bc9d27acd25352fddfc6e21866ec484c6894528d6593059a`.
Its unchanged package version is 1.80.0; this is a local test package, not a
publication. The ranged, unused installed Claude Code package resolves 2.1.292;
all actual auth runs explicitly use the reviewed 2.1.284 binary above.

The identical harness also passes all **seven** installed public-flow cases:
both cold contexts, both real 61-second expiry contexts, sibling closure,
last-owner cancellation/replacement and absent-token diagnostics. Ten actual
native auth invocations; zero SDK queries. All observed native/wrapper/worker
roles join, and all 418 built/installed dist files and pinned SDK metadata remain
unchanged afterward. The direct-user control is source-only. The temporary
access-only test input was removed after the current source/installed roles
joined; private comparison found no grant copy in 443 task runtime files.

[Sanitized result projections](1285-auth-status-results.json) retain all 17
baseline/source/installed HTTP, native and join observations plus exact receipt
hashes. Independent review accepts the scoped production, source/package native,
final local and documentation evidence with no remaining material finding.
Required final-head CI still gates the credited integration and fresh
unchanged-source closure.

## Retained failures and limits

The original/diagnostic baseline attempts failed harness cleanup before a result
was published. They remain HARNESS_FAILURE, not product reproduction. Optional
baseline cleanup was corrected; the subsequent same-assertion RED is separate.
The first fixed cold run passed product assertions but failed its two-second HTTP
close callback. A four-variant real HTTP toy did not reproduce it; its individual
cause remains UNKNOWN. The prospective harness drains the livez body and starts
close before forced connection closure, without relaxing the original deadline.
Later complete joins do not retroactively erase that timeout. The first actual
logged-out warning failure and its causal mock RED are also retained separately.
The initial package metadata validator failed only on traversal-versus-string
path ordering; exact path sets/bytes matched and the same tarball was reused.

This proves controlled native auth-subprocess delay on the reported Mac tuple.
It does not reproduce memory paging, validate all owner accounts, or settle the
source body's Linux CLI 2.1.289 versus E2E note 2.1.284 discrepancy. The default
arm is a task oauth-token profile with ID `default`, exercising its cache slot;
owner claude-max/default-store enrichment and raw default helpers are separate.
Native `loggedIn` means local credential-source readiness, not token validity,
subscription entitlement or inference. No coding-client/model/plugin flow is
claimed. Full startup/timers, Windows and whole-OS custody remain outside this
bounded proof; old generic controller/VM/capture holds are not adopted here.

Sanitized source/native/package receipts are retained under the October 6 review
evidence root in the `pr1285-native-live-preparation-20261007`,
`pr1285-native-callback-correction-local-gates-20261007` and
`pr1285-independent-package-preparation-20261007` namespaces. This committed
record and runnable harness preserve the acceptance facts beyond those local
paths. The owner checkout and its 12 dirty paths remain unchanged.

## Later logout correction

The absent-token behavior above is historical. The #1323 correction records a
joined CLI exit 1 with complete `loggedIn: false` as an observed logout. The
current native harness now asserts that behavior; its process ownership, delay
and positive-login controls are retained. See [the logout proof](1323-auth-logout.md).
