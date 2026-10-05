# Claude Code auxiliary isolation — 2026-10-04

## Current E71 model and cleanup correction

Draft [#1279](https://github.com/rynfar/meridian/pull/1279) previously submitted
`cd8b5063a1e001f61eb610f82c05e8bd6e20974a`. Root's fresh read records six
executed CI checks passing and the expected changelog skip for that head only.
The new reviewed harness/test/instruction correction below requires fresh local
gates and new-head CI; the earlier `80d1ce81` full-suite/build proof is historical.
No proxy production module or public plugin interface changes in this packet.

The [29-slice official selector audit](classifier-model-selection-audit/REPORT.md)
shows that main and classifier model selection can differ. The final maintained
harness therefore requires separate requested/served main and classifier pins,
one explicit audited classifier arm, and exact per-request logger ownership.
It accepts the SDK `sonnet` tier only with that request's exact version pin.
Actual selector/config/policy/entitlement/probe/demotion and emitted native
models remain gates. Legitimate multiple-query retries conservatively fail the
selected no-retry benchmark; model equality alone cannot distinguish same-model
ownership forged by a hostile target. The original published harness omitted
requested identity checks and used a global served pin; it did not reject
SDK aliases. The [requested-model packet](requested-model-controls/REPORT.md)
is historical and its intermediate universal wire gate is superseded. Its
preliminary after-source/test hashes identify that earlier execution; those
source bytes are not the current maintained files or a claimed final freeze.
The baseline, exact control driver, reports and logs are retained, while the
final authoritative harness/test copies are archived in the role packet.

The [final role witness packet](role-model-witness-controls/FINAL_REPORT.md)
records **34 passing focused tests / 1,124 assertions / no skips**, with actual
source and existing certified `80d1ce81` compiled HTTP controls using mocked SDK,
auth and executable resolution. This is macOS synthetic preparation, not a new
compiled certification or native acceptance. Earlier compiled-skip, prejoin
33/1,067 and pending-read 34/1,122 runs remain separately qualified.

Separate [snapshot containment](snapshot-pre-read-controls/REPORT.md) verifies
grant metadata before content and no-follow/nonblocking descriptor invariance.
[HTTP observer cleanup](role-model-witness-controls/http-receipt-join-controls/REPORT.md)
closes admission and joins handlers then cloned receipts before restoring the
logger or removing private runtime. The same preload proves entered, permanently
pending cancellation on both old and new harnesses: both fail overall acceptance,
but only the correction retains the logger/private runtime and reports the
pending receipt. A settled clone-read failure permits joined teardown while
failing receipt acceptance.

[Independent review](role-model-witness-controls/INDEPENDENT_FINAL_REVIEW.md)
and [root review](role-model-witness-controls/INDEPENDENT_ROOT_FINAL_REVIEW.json)
pass for frozen script `e2f58e5a`, test `b58d12c7` and E71 instructions
`f4410422`. The [escrow record](e71-model-cleanup-escrow.json) and root archive
map preserve raw originals and hashes, including corrected narrative/link
renderings. Historical scripts/tests/logs are deterministic gzip archives so
Bun cannot discover them as maintained tests. Recover exact bytes with
`gzip -dc`; maintained reproduction stays in `scripts/` and `src/__tests__/`.

The first new full gate at clean `72b766b4` stopped in pretest with two
optional artifact-hash type errors; no suite ran. A separate
[explicit typed helper correction](typed-artifact-hash-correction/REPORT.md)
retains both digest assertions after runtime string guards. Test `64f2cba2`
passes standalone typecheck and the actual source/compiled subset (2 tests /
72 assertions); script `e2f58e5a` and E71 instructions `f4410422` are unchanged.
The prior 34/1,124 focus belongs to test `b58d12c7`. Fresh full gates on the
clean correction commit remain pending.

The five contributor mappings remain unchanged. A new clean source commit,
final `npm test`, standalone typecheck/build and new-head CI remain to be
recorded. Actual Linux E71/E55/all-four-E41 proof remains open. No source PR or
issue is closed; no release is authorized.

## Prior production review and initial delivery

Accept [#1211](https://github.com/rynfar/meridian/pull/1211) with maintainer
corrections; keep integration a draft until actual affected-flow proof passes.
Source `22566e8ac0b9e079bb0d28c0eb4aa05207c56070` was independently reviewed
in full: 11 files / 28 hunks. The [source review](source-review/review.md) and
[coverage/hash record](source-review/review.json) preserve all findings and
the captured discussion. Source CI and the author's historical Linux results
do not validate this correction or its eventual final head.

## Public boundary and attribution

The earlier public-API approval hold was an overbroad inference from a
TypeScript `export` keyword. The root package exports only `.` through
`src/proxy/server.ts`; `AgentIdentity` and `AgentAdapter` are internal,
neither package exports nor part of `ProxyConfig`/transform types. The approved
architecture [describes `AgentIdentity` as internal and inaccessible](../../../superpowers/specs/2026-04-17-plugin-system-design.md)
to plugins. Recognizing Claude Code's existing request-class header changes no
Meridian header, health/profile/Messages schema or public lifecycle contract.
This is an authorized internal correction; there was no owner-directed defer
of #1211. No new API approval is assumed or requested.

All five actual source commits were incorporated with **Noah Passalacqua's
Author and AuthorDate preserved**. Maintainer corrections remain separate.
The author ledger is recorded alongside the final integration metadata;
`4cd004cce0da93f5028a63e4a770cb10c3a278fa` is the initial complete authored
incorporation on main `8e1c8bf738d7372ded01f28e99d6ec167acaf76f`, used as the
unchanged production baseline for correction controls. #1278 subsequently
merged documentation only at `74d0a49953211eb8e2c1ccae275971aa0d624c1c`.

## Product corrections and causal controls

- An auxiliary has no durable mapping key, cannot be promoted by complete
  pending tool results, and cannot evict the conversation during resume/model
  fallback. Four JSON/SSE checkpoint controls fail on unchanged `4cd004cc`
  and pass after correction; the refusal variants observe the main mapping
  becoming missing before the fix. An ordinary complete continuation still
  resumes and advances its durable generation.
- Auxiliary cancellation uses a private leaf under its conversation and any
  declared ancestor. Cancelling the main reaches it; cancelling the auxiliary
  reaches no main children. Entry deduplication retains ancestor cancellation
  even with no live subagent main. The same HTTP cancellation tests go from
  **13 pass / 4 fail to 17 pass / 0 fail**, including socket/body controls and
  joined teardown. [Receipts](http-controls/SUMMARY.md) retain exact byte hashes.
- Auxiliary failover may use another account without publishing main affinity,
  promotion, durable route or attempt ownership. Priority controls go from
  **1 pass / 1 fail to 2 pass / 0 fail**. The observed cooldown is allowed to
  expire in a controlled clock before probing affinity; ordinary primary
  failover still adopts the alternative and resumes.
- Headerless detection requires the actual official classifier system prefix
  and a complete permissions envelope in the same system block. Billing may
  prepend a separate block; default non-stream and stage2/fast omitted stops
  are supported, and malformed/unknown supplied stops are rejected. Ordinary
  first-turn and multi-turn XML still publish and resume. A forward linear
  scan avoids repeated suffix scans on long unclosed marker input. This last
  robustness finding is static; no timing or exploited denial claim is made.
- A genuine one-shot recovery grant is produced through the HTTP mocked-SDK
  recovery path and preserved across auxiliary success/failure/cancel with
  tools omitted/provided. It is consumed once by its eligible continuation.
  Auxiliary retry accounting neither inherits nor clears the main ceiling.
  These [13 controls](recovery-idle-controls/REPORT.md) pass with 230 assertions;
  unchanged `4cd004cc` passes the seven existing grant protections and two
  ordinary-reset controls, but fails four idle-isolation cases. The idle
  coupling predates the contribution and is qualified as an adjacent fix.

The [official 2.1.286 static trace](classifier-static/classifier-static-review.md)
records archive/binary identities and 13 verified source intervals. The native
binary was treated only as public data and was not executed. The small inspector
and official retrieval metadata are retained; no multi-megabyte proprietary
binary/source chunk is vendored. Static classifier intent is not authentication
or captured native wire proof.

## Evidence limits and remaining gates

Development checks use Bun 1.3.14 on macOS arm64 with a mocked SDK and private
synthetic state. They consume zero real generations. A mocked SDK alone does not prove
auth/default-native-store isolation. The older shutdown fixture reached those
non-subject boundaries by source inspection; its corrected synthetic fence
intercepts auth/store/proactive/background calls, records zero fixture writes,
and joins owned work before restoring the mocks. Earlier unfenced passes do
not establish whether a real default store was read or refreshed; no credential
contents were inspected or retained by this review. The initial standalone typecheck found missing union narrowing and
Hono `Response | Promise<Response>` normalization in new test helpers; corrected
checks and first failures are retained. One XML/detector capture accidentally
ran in the corrected checkout: it is retained as an **after** capture, and the
separate unchanged-baseline run provides the actual before failures.

The critical E71 harness remains in `scripts/e2e-claude-code-auto-mode.mjs`.
Synthetic harness results are safety/discrimination controls, not Linux/native
acceptance. Frozen full npm suite, standalone typecheck/build and complete independent
correction reviews are recorded below; exact delivery-head CI remains pending.
Actual implicated Linux x64 Claude Code 2.1.286/Sonnet, selected installed SDK
and bundled CLI identities, separately required shape/header classifier paths,
main resume, cancellation/lease behavior and zero owned residue remain open.
Preserve the contributor's historical model alias as an alias; require the
actual served model in new proof. E55 gateway parity and all four E41
chain/parallel × stream/nonstream modes remain gates. Any OpenCode proof must
use the actual Meridian OpenCode plugin. No alternate model/platform or synthetic
receipt supplies missing native evidence. No source issue/PR is closed and no
release is authorized by this record.

The artifact manifest hashes the bounded escrow. Compressed logs and source
patch bytes retain original and gzip hashes in `raw-artifact-archives.json`;
use `gzip -dc` to recover the original bytes. Historical temporary paths identify
the original execution, while corresponding maintained tests/scripts and
durable artifacts provide the correction/reproduction path.

The initial full gate at `c237ab9a` completed its first stage with 5,069 pass /
35 skips / 1 failure; the remaining 18 stages did not run. The new auxiliary
response-body control checked registry retirement after five fixed ticks,
although cancellation returns before asynchronous stream finalizers settle.
The [test-only correction](cancellation-settlement/REPORT.md) observes the
existing bounded completion predicate before every original survival assertion
and exact-zero cleanup check; it changes no production path or latency limit.
Targeted five controls and the full 17-test file pass; the required full rerun
subsequently passed as recorded below. The [final harness review](harness-review-final/review.md)
resolves H1–H5 without a native acceptance claim.

Original child manifests retain historical uncompressed names. The root
`raw-artifact-archives.json` maps those exact bytes to deterministic gzip
archives, including earlier test/script snapshots. They are historical
reproduction evidence; the maintained executable harness and tests live in
`scripts/` and `src/__tests__/`.

## Historical frozen local gates and initial delivery

At clean `80d1ce8158dc7cd466a87863404bf6ea02754c8b` on current main
`74d0a499`, `npm test` (including its initial typecheck) passes all 19 stages:
**5,417 pass / 35 skips / 0 failures, 27,544 assertions**. Standalone typecheck
and build also exit zero; Node entrypoints and clean build certification pass.
The [machine record](local-gates/result.json), raw archived logs and freeze
hashes retain exact inputs. Both earlier failures are retained, including
pretest stopping before any suite and the first-stage cancellation settlement
failure. The fresh passing rerun follows a reviewed test correction; it does
not silently substitute a green rerun for missing causality.

Source #1211 was refreshed before delivery: unchanged `22566e8a`, open, with
no comments/reviews. [Author mappings](author-ledger.json) preserve all five
original Author/AuthorDate/subjects through the documentation-only rebase.
For the initial `80d1ce81` to `cd8b5063` delivery, production, harness and test
blobs remained frozen and only maintenance evidence/handoff metadata was added.
The new E71 correction above changes the harness/tests and requires fresh gates.
Source PR/issues
remain open. The integration stays draft for exact-head CI and the actual
E71/E55/E41 gates above. These local checks establish no native model or
client acceptance and authorize no release.
