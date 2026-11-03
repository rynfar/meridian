# PR #1220 review — 2026-11-03

PR: https://github.com/rynfar/meridian/pull/1220 by Nowaker (Damian Nowak).
Review base: `697f9482c23865e9d9a02095e35d79b0922047a7`.
Contributor update: `bb2e18a3f8362d1a2b3a3529cd50007361bc070b`.
Additive, GitHub-verified signed maintainer correction: `67d02f56ba69b7e738aea67119ba5b1376ef0db0`.

## Latest: #1504 merged; #1505 final verification

Test-only #1504 merged normally at `1e24a969` after all26local test groups
(8819pass/65skip/0fail), typecheck/build, independent review and exact-head CI.
[Tree/signature/local/CI receipt](launcher-fix/merge.json) confirms the landed
reviewed tree. #1505 is still open at`93b188f6`; its final local suite and CI
are running after additive integration of those tests. Its product bytes and
spec are unchanged from the independently installed actual-client PASS.
#1220 remains unmerged, E41 halted, historical holds unresolved, release conditional.
Earlier dated sections below retain their original status, not current approvals.

## Resumed work at 19:53 UTC

The [resumed verification record](resume-1953/README.md) supersedes the stopped-work
status below. Qualified v2 live attempts retain default-model drift failures,
one passing candidate no-model-switch arm, and a failed matched baseline native
refusal. The E41 matrix is halted, not accepted. Test-only launcher PR #1504 and
separate explicit-model refusal-switch PR #1505 are in progress; neither carries
contributor commits. The original local failures and historical holds remain.
No merge or release has occurred.

## Disposition

**Deferred at explicit acceptance blockers; not merged or released.** The owner
asked to find the PR he promised to
merge. His 2026-11-02 reply and Nowaker's conflict-resolution update identify #1220.
This review is bounded to that PR, not the contributor's other open PRs. The owner
subsequently authorized a release **after** review and merge; that authorization
does not waive acceptance gates. No external comment is authorized or claimed.

## Findings fixed on the contributor's branch

- JSON `evictSession` invalidated memory before its asynchronous write but only
  invalidated after commit for SQL. An overlapping lookup could repopulate the
  fallback LRU. The two-line correction applies existing epoch-fenced, successful
  commit invalidation to both backends. Later writer controls pass. Current HTTP
  requests already refuse a store read error before lookup, so this is a proven
  internal fallback contract regression, **not** a demonstrated unsafe HTTP resume.
- Four missed awaits in the Linux locator harness, fixture seeds and cleanup hooks
  now join the new asynchronous mutations.
- Accidental pre-awaits were removed from caller-ownership and cleanup ordering
  tests so those cases exercise pending writes. A shadow-source negative control
  shows the corrected direct store test fails broken ownership where the prior
  pre-awaited version passed. Local-fallback ownership tests rejected the fault
  in both forms; no stronger discrimination is claimed.
- The session spec and stale synchronous-cost description now match async JSON I/O.

Two independent production reviews and one historical-evidence audit are linked
in this directory. No production constants, thresholds, defaults, dependencies
or public interfaces changed in this review.

## Verification so far

- Darwin arm64, Bun1.3.14 / Node22.22.3 / SDK0.2.141 / locked native2.1.296.
- Typecheck and build pass after corrections. Native SQL tests explicitly use
  SQLite3.53.4 through the existing `MERIDIAN_TEST_SQLITE_LIBRARY` test hook; Bun's
  system3.51.0 remains correctly refused, not patched around in production.
- New cache controls: fixed14/14 JSON and14/14 SQLite; original cache source with
  corrected tests12pass/2fail (keyed and fingerprint eviction).
- Independent final coherence + SQL publication72/72. Related cancellation24/24,
  merged interrupted-turn/SQL90/90, fixture19/19 and cleanup117+12 pass.
- Actual Linuxarm64/Bun1.3.14 tmpfs locator: before exit1 (0 vs20 mutations);
  after exit0 (20 real replacements,0 identical replacements in100/900 fixtures).
  Bare Docker image lacks machine-id; a synthetic machine-id fixture satisfies
  unchanged native identity preflight. No guard was bypassed. Initial failed
  image attempts are retained.
- Same19,270,219-byte/856-entry store benchmark: unchanged main median loop delay
  9.345ms/p9516.807ms; candidate1.069ms/p951.158ms,30samples each; history retained.
  This is an observation, not a fixed performance guarantee.
- Initial `npm test`, while independent checks were active and before source freeze:
  8,263pass/65skip/1fail in group0. The failure is the unchanged two-second build
  fingerprint deadline in bookkeeping-cli beforeAll. The exact stack is retained.
  This does not explain the original October failure. Groups1–25 did not run in
  that invocation because `npm test` uses `&&`.
- Frozen-head `npm test` also exits1: group0 has8,287pass/65skip/5fail/1error,
  8,357tests across485files in958.63s; groups1–25 did not run. Five Antigravity
  probe fixture cases fail with timeout/readiness/missing calls files, followed
  by a teardown-related unhandled spawn error. No regression cause is yet
  established. The completed independent investigation isolates pre-JavaScript
  startup on this host's executable-shebang path, not a changed store module.
  [Receipt](final-local-suite.json); sanitized full log
  is `final-npm-test.log.gz`.
- Final-head GitHub CI is **green**, including required `test`, on exactly
  `67d02f56`. [Exact check URLs and results](final-head-ci.json). This does not
  erase the failed local full gate.

## Local probe startup finding — original gate still red

The [independent findings](probe-diagnostic/findings.md) and
[runnable control](probe-diagnostic/README.md) retain all failures and narrow the
local issue without changing tests. Candidate original file:32pass/7fail, then
30pass/9fail; baseline:39pass/0fail. The24-file local import closure is identical.
A standalone built-ins-only harness reproduces before Meridian code or fixture
JavaScript: candidate cwd executable-shebang times out1016ms, minimal PATH1006ms;
explicit `/usr/bin/env node`/absolute Node succeed36–44ms. Baseline cwd's shebang
succeeds279ms, minimal PATH41ms; other argv forms also succeed. An original child
sample stays at `/usr/bin/env`'s `_dyld_start +0` after3.47s.

This establishes a host/Bun1.3.14 executable-shebang startup-path problem and a
real cwd-associated differential, **not** its exact OS/Bun/security cause or an
async-store regression. PATH search and alternate Node selection are not the
demonstrated cause. It does not make the local full suite green. No additional
original reruns, timeout increases or source workaround are proposed here.

## Historical acceptance gates — still open

The supported original Opus5.5/SDK0.2.141/native2.1.284/OpenCode1.18.34 observation
still reads3132 after publishing3332 (94.00%, below unchanged95% floor3165.4).
Accounting inflation and a separate signed-thinking replay bug were demonstrated,
but do not prove the residual cause. The original owned config/project locator
and transient request/cache identity are not retained. A later success alone does
not close this gate. The old fingerprint stall and initializer[0,1] cause are also
not retrospectively established. See the historical-evidence report for exact
immutable artifacts and limits.

## Actual original-client installed-package E2E

OpenCode1.18.34 / SDK0.2.141 / explicit native2.1.284 / Darwinarm64 / Opus5.5
passes the read → tool-result delivery → same-session continuation assertions.
Four requests return200, the access-only profile stays read-only, and every child
and original pipe joins. CLI setup installs exactly one bundled V1 Meridian
plugin; actual session/agent headers and the active0.3.0 server scrub witness the
route. Supported `getSessionMessages` inspection of only the owned fixture
confirms the actual assistant model is `claude-opus-5-5`, not a fallback.

The independently installed candidate tarball contains the corrected runtime.
Its SDK is0.2.141; npm selected native dependency2.1.317 but the test explicitly
executes2.1.284. The only harness delta sets `MERIDIAN_OPUS_MODEL=opus` after its
env reset, avoiding the `[1m]` paid tier. Extra Usage is disabled. No quota/billing
refusal occurred. A first metadata-observer attempt refused the `/var` alias of
the owned `/private/var` temp root; canonicalizing that same root fixed inspection,
without rerunning model requests. This run does not explain the old E41 residual.

The runnable harness, safe before/after controls and reports are escrowed in
`proof.tar.gz`; `manifest.json` lists exact member sizes/hashes. No grant, raw
SDK transcript, raw client output or customer conversation is archived.

## Instrumented E41 diagnostics — not acceptance

The first wrapper attempt failed its server-plugin inventory preflight before any
SDK query: a test-only `MERIDIAN_API_KEY` required auth on the fixture's unkeyed
inventory GET. The helper also changed after READY while HOLD crossed launch;
that attempt has invalid helper custody and is not accepted. The next attempt
removed unrelated inherited environment and that auth setting, using an immutable
hash-named readonly helper copy. No product constant or threshold changed.

The frozen attempt observed one actual Opus5.5 query and its supported owned
history, then the fixture's followup returned500 and stopped. The wrapper set
`query-iterator-error` but retained no error/method detail, so it cannot distinguish
an underlying iterator error from an observer callback/write error. Static review
also proves the wrapper changed the real SDK's iterator selection: SDK0.2.141
returns a separate `sdkMessages` iterator, but the wrapper forced Query to iterate
itself and changed `return`/cleanup routing. The offline self-test only covered
self-iterating objects. Therefore this is **not fidelity-qualified product failure
or acceptance evidence**, and no credential/billing diagnosis is inferred.

[e41-diagnostic](e41-diagnostic/) preserves both worker/supervisor receipts, exact
helper, offline controls, public SDK-shape excerpt and invocation scope. A
read-only [offline discriminating control](e41-diagnostic/offline-iterator-diagnosis.json)
passes: the original distinct iterator avoids Query.cleanup; this observer enters
it, and a synthetic rejection poisons stop state even when the unchanged real
idle guard swallows it. Callback failures and native rejections also lose their
method/phase in the same catch. This establishes observer defects, **not** the
exact live failure cause. The live `return`-end was already recorded, so claiming
that specific return rejected would overstate the proof. The four-mode E41 gate
and historical200-token residual remain open. No blind live rerun is planned.

A [new v2 observer](e41-diagnostic-v2/instrumented-e41-v2-README.md) is qualified
**offline only**. Distinct/self iterator custody, exact step/message/error identity,
method/target/phase, real idle-guard cleanup handling, observer callback/report
failure and native tool-cap/error/refusal controls pass with0 model calls and0
grant reads. Its immutable source SHA256 is
`3dee3502128271672a68cb074205f9cc06d2b45572a955511008c1490100f4ff`.
No v2 live result is claimed, and no current live green would recover the missing
historical transient evidence.

## Preliminary release review

[#1486 /1.89.0](https://github.com/rynfar/meridian/pull/1486), exact head
`296676632c3ff5097b1420a81e41028b3e669f9c`, does not contain #1220. The full range
from1.88.0 was inspected. Versions align; dependencies/lock/Nix hash are unchanged.
No new material static #1480 defect was established. Its final-head CI and actual
installed-package/live-stop proof are not complete; a prior desktop notarization
failure remains recorded. [Full preliminary findings](review-1220-release-findings.md).
Nothing has been merged or published by this review.

## Current gate and next-action summary

- Final source head remains `67d02f56`; CI/typecheck/build pass.
- Local full-suite gate remains failed. Antigravity probe launch controls narrow
  the issue to the pre-JavaScript shebang path on this host; they do not establish
  the exact OS/Bun cause or make the original suite green.
- Four-mode E41 is not accepted. V1 observer results are invalidated by proven
  fidelity defects; v2 has only offline qualification.
- Historical3332→3132 residual and old fingerprint/initializer causal holds remain
  open. Do not infer a cause from a new passing run or substitute another tuple.
- **No merge, contributor-author-on-main claim, release PR merge, tag or
  publication occurred.** The owner's release authorization remains conditional
  on safe acceptance and merge of #1220. No external comment was posted.
- Source and user checkouts are preserved. All bounded diagnostics have stopped
  after final evidence capture. Resume with current GitHub/main refresh, then
  address the missing evidence or seek the owner's disposition; do not continue
  blind live reruns or silently waive the holds.

## Assumptions and unchanged boundaries

The source and installed plugin artifacts are trusted for this test. Live history
inspection is limited to the newly owned fixture through supported SDK APIs.
The original failing fixture's missing transient state cannot be inferred from
hashes in a new run. No product constants, public API, dependency versions,
cache95% threshold, original fixture assertions or billing controls were changed.
The external diagnostic supervisor uses a selected300s safety bound and isolated
loopback ports; those are test settings, not product changes.
