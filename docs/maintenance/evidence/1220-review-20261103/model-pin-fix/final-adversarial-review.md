# Explicit-model refusal-fallback fix — independent adversarial review

Reviewed 2026-11-03T20:07:51.708924+00:00. Read-only review; no source edits, tests, model calls, commits, pushes, or external comments by this reviewer. This change is separate from contributor #1220.

## Verdict and exact claim

**No material production-code defect found in the final narrow fix. Installed-package actual-client happy-path and native-env evidence now passes; final-head local/CI gates remain parent-owned and open at this review checkpoint.**

Supported static claim: for a model ID already recognized by `explicitModelPin`, Meridian adds `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` to the same per-request tier override. On the supplied native Claude Code 2.1.296 implementation, this turns off the refusal alternate-model switch gate. Bare aliases keep their prior behavior. No refusal, same-model retry, or safety-bypass control is added.

Do **not** claim a universal no-model-substitution guarantee, all model-access fallback protection, a demonstrated cause of the earlier identity mismatch, or that E41 is fixed. Those conclusions exceed this patch and the available evidence.

## Frozen scope and source custody

- Worktree: `/Volumes/DevSSD/meridian/fix-explicit-model-fallback-20261103`
- Branch: `fix/explicit-model-fallback-20261103`
- Initial base/HEAD: `697f9482c23865e9d9a02095e35d79b0922047a7`.
- Final reviewed PR #1505 head: `93b188f68d9664c46df62aa3249b4defffd884af`, compared with merged main `1e24a969` (PR #1504). Final worktree is clean; the comparison contains only the four intended files (48 insertions / 13 deletions).
- Independently rechecked final production/test/spec SHA256 values: all match the reviewed values below. Installed-tested head `41df72d664301d235df190a5afe2563aaf458c68` differs from final head only in `src/__tests__/antigravity-probe.test.ts` and `src/__tests__/build-source-recovery.test.ts`; no runtime, dependency or owning-spec changes lie between them.
- Initial frozen working diff: `models.ts` and the two test files below; 42 insertions / 13 deletions. Parent subsequently added the reviewed owning-spec decision in `src/proxy/SPEC.md:89-94`; source/tests remain byte-identical. No dependency, public configuration, header, route, model constant, timeout, or adapter-interface change.
- Worker explicitly declared the implementation frozen. Reviewer independently recomputed all three SHA256 values and matched the worker's test-source declaration. Tests were not rerun by reviewer.

### Exact tested/independently inspected changed bytes

| Path | SHA256 |
|---|---|
| `src/proxy/models.ts` | `d6216e56b0034a3182e6aaf270dc8977ea130ffee58025fa76a39fbace34769f` |
| `src/__tests__/explicit-model-pins.test.ts` | `02f7faece3a34083f8b4febf1c41bdb8d7692b68a8a3cdd4e0d9908ba48bb1f4` |
| `src/__tests__/proxy-env-stripping.test.ts` | `c3416da794bb3c36d81f6bc281d927036fbad3aac210bb26a47164cca8bd026a` |

### Inspected boundary bytes (owning spec updated after initial review)

| Path | SHA256 |
|---|---|
| `src/proxy/query.ts` | `df3daea3233505fd435a98c2764ff6c4b0ac3fe4cbfd3bd6e8838acc24cd7893` |
| `src/proxy/server.ts` | `311a90ba30ceff30af8530caa526f321931f26ddb2f24933083d968b04c00c25` |
| `src/proxy/sdkFeatures.ts` | `c81a7ba9315ae063bb253231094e02175e46d27a8f3bf342dae28aa5bdecf6be` |
| `src/proxy/SPEC.md` | `113dea856134c4e9104fe46962f993e0f088fc521b12425982bf4bffd7608725` |
| `ARCHITECTURE.md` | `0d961a6ab2dc6e324741f4b73f99f2e855db5e5f67f9c6623eec22ed77d9444c` |
| `.agents/references/api-contract.md` | `51339a394df1b07e827a5f75586287128f38ab4a550db3eb030b406d88a8b792` |
| `src/proxy/session/sdkProcessGate.ts` | `d23e1adabc906a413c7f6186631dfd4343c00cfe9648705b5703dfa938a3af3d` |

## Concrete findings and limits

### 1. Broad fallback claims would be incorrect; narrow claim is appropriate

`query.ts:913` still forwards the independently configured SDK `fallbackModel`. Every one of the seven request/recovery call sites passes `sdkFeatures.fallbackModel`; `sdkFeatures.ts` defaults it to an empty string. The installed SDK declaration describes it as the model used when the primary fails or is unavailable (`sdk.d.ts:1269-1272`). This fix deliberately neither removes nor scopes that setting. It is not proof against access/overload or other native model-selection mechanisms.

Resolution: parent explicitly agreed to limit the change to refusal-switch fallback, not universal substitution. No unrelated fallback policy change is recommended in this patch. Custom/older/future selected Claude executables also need separate compatibility evidence before a broader support claim.

### 2. Env ownership and delivery are correct at the existing common boundary

- The recognition regex, normalization, `[1m]` removal, and Mythos-to-Fable tier mapping are unchanged (`models.ts:111-119`). The new field is returned only after the existing versioned-ID match; bare alias/family requests return `undefined` as before.
- `server.ts:2875-2877` creates one request-local override. Auxiliary requests add only their pre-existing cache-TTL override alongside it.
- `server.ts:2935-2962` strips loopback/auth and incompatible host-tool variables, not the refusal-fallback switch. Profile/default/inherited env is constructed separately.
- All seven `buildQueryOptions` sites carry the same override: `server.ts:4922`, `5029`, `5090` (nonstream main/resume replay/fresh retry), `6358`, `6445`, `6502` (stream equivalents), and `7419` (silent-turn recovery). There is only one actual SDK `query(params)` invocation, in the shared runner at `1354`.
- `query.ts:836` copies inherited/profile env; `stripConfigDir` removes only the config-dir field (and preserves OAuth isolation). `query.ts:890` spreads the explicit override last, so shell/profile values cannot unset it for an explicit request.
- The process gate publishes all defined SDK environment entries for POSIX and Windows (`session/sdkProcessGate.ts:56-76`, `257-282`); it does not filter this flag.

This is common Claude model-selection behavior, not OpenCode-only logic. Keeping it in the existing leaf `models.ts` helper avoids a new client special case, adapter dependency, or orchestration branch. `ARCHITECTURE.md`, adapter boundaries, and API contract are preserved.

### 3. Native semantics have bounded, version-specific support, not a live trigger proof

Parent-supplied artifact:
`/Volumes/DevSSD/meridian/evidence/review-1220-20261103/resume-1953/native-fallback-static.json`

Reviewer independently verified artifact SHA256 `b92a8b4d56b043886112bd6e8904785cfce51405f8788a8b1562b32ad0e100fb`. It identifies native version `2.1.296`, binary SHA256 `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937`, and bounded offsets/excerpts:

- `Z1()` at byte `191064257`: `return !a.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK && !kQ()`.
- `P_s()` at byte `191064324`: calls `Z1()` and gates `switchModelsOnFlag`.
- Separate same-model retry predicate `Va` at byte `203786996`: tests `!a.CLAUDE_CODE_DISABLE_REFUSAL_RETRY` plus query-source/auxiliary restrictions. Its nearby refusal predicate still recognizes assistant API errors with `stop_reason === "refusal"`.

Setting the fallback field to nonempty `"1"` makes the shown `Z1` and dependent `P_s` gates false. The patch never sets `CLAUDE_CODE_DISABLE_REFUSAL_RETRY`, alters refusal recognition, or injects a policy/safety override. These excerpts support preserving refusals and distinct same-model retry configuration while disabling the shown alternate-model switch feature. They are **not** an enumeration of every native switch/access call site, a public CLI contract, or a triggered real-model before/after proof. This reviewer did not inspect or execute the binary.

### 4. Tests discriminate env propagation, not actual serving identity

Reviewed the complete test diff, red/green logs, and worker report in:
`/Volumes/DevSSD/meridian/explicit-model-fallback-20261103-validation/`.

- Reported pre-production red: 36 pass / 5 fail; four exact override-object groups plus explicit-request env precedence fail.
- Reported frozen focused green: 41 pass / 0 fail / 82 expects.
- Reported model-regression green: 99 pass / 0 fail / 188 expects.
- Reported typecheck and diff-check: exit 0. The typecheck log contains the expected `tsc --noEmit` invocation and no diagnostics.
- Unit assertions cover Sonnet/Opus/Haiku/Fable/Mythos versions, date and `[1m]` suffixes, and negative alias/unversioned controls. Exact returned objects exclude unrelated retry/safety fields.
- Mocked HTTP checks cover explicit override precedence over inherited `"false"`, unset/inherited alias preservation, streaming propagation, and inherited same-model-retry env equality.

Important qualification: inherited `"false"` is an env-merge precedence control, **not** proof that native fallback was enabled; the supplied native expression uses raw negation, not a string-boolean parser. Also, these SDK mocks return canned model annotations unrelated to the requested model. They cannot prove actual native serving identity or refusal behavior. Parent acknowledged both limits. The unchanged suite plus static inspection provide useful regression coverage, not live acceptance.

### 5. Spec documentation recommendation resolved

The current worktree's `AGENTS.md` treats the module spec graph as ground truth and asks decisions/invariant changes to be recorded in the owning spec. Parent added `src/proxy/SPEC.md:89-94`; reviewer inspected the final text. It describes recognized versioned Claude IDs, the request-local refusal-fallback switch, inherited bare-alias behavior, unchanged refusals/same-model retry, and the independent SDK `fallbackModel` limit. It does not claim universal substitution protection. Recommendation resolved; updated spec SHA256 is recorded above. Reviewer rechecked all three tested source/test SHA256 values and confirmed they are unchanged. No tests or live work were added for this documentation-only follow-up.

## Final installed-package live evidence and remaining limits

Reviewer read the final receipt without rerunning any test or live call:
`/Volumes/DevSSD/meridian/explicit-model-fallback-20261103-validation/actual-client-final-receipt.json`

- Receipt SHA256: `da63b7e40207497562b18be6b516f16eda7a96c7fe09d8fea2c9525038156b04`.
- Tested package head: `41df72d664301d235df190a5afe2563aaf458c68`; tarball SHA256 `e21796bec14257f286334a3baf1eaa6f2d9094e910fddf2fd160708b8c3c68ff`.
- Actual tuple: Node `22.22.3`, OpenCode `1.18.34`, SDK `0.2.141`, native Claude Code `2.1.296`, Darwin arm64, explicit `claude-opus-5-5`.
- Receipt result `PASS`: four requests all HTTP 200; actual client-read result delivered; same-session continuation succeeded; all children joined; observer errors empty.
- Four published native-gate witnesses contain exactly the allowlisted values `explicitOpusPin=claude-opus-5-5` and `refusalFallbackDisabled=1`. Parent reports no externally injected refusal-fallback opt-out. Supported SDK history model sets contain only `claude-opus-5-5` before and after continuation.
- Generation-V1 installed bundled Meridian client plugin is recorded as configured exactly once, with actual session/agent routing witness. Scrub plugin `0.3.0` ran four times with zero errors; the receipt records its package/runtime identity and hash.
- Billing/auth scope: included-only read-only access-only grant, Extra Usage false, no refresh or credential writes.
- Harness SHA256 `ffcf54ca7091abae02cf1f83e9b0c81a98dbd5ecb8f50732a518180adeb746c7`; final observer SHA256 `75af2733bc17362a4dd69c895113426b38658ee25dff0fdff1a048bac6f5bc5a` matches the separately reviewed bounded parser.

Durable escrow, identified by parent at evidence commit `1138f91a`:
`/Volumes/DevSSD/meridian/review-1220-evidence-20261103/docs/maintenance/evidence/1220-review-20261103/model-pin-fix/proof.tar.gz`

Reviewer confirmed the archive exists (33,793 bytes) and independently computed SHA256 `49fee77c3b6f53faac1eb14cf0630392bbb33a603f4983ee4e51d8fabdd042ed`. Archive contents were not expanded in this final bounded review.

This establishes the actual-client installed-package happy path and the published native-env contract on this exact tuple. It does **not** force a refusal-switch trigger, prove the earlier model mismatch's cause, qualify all historical cache behavior, or clear E41. The earlier nofallback candidate/baseline comparison remains halted after a genuine baseline query-4 refusal. The first installed-client observer run used Node 25.6.1 and failed because it watched wrapper spawn rather than native gate publication; that run is not promoted to a Node-22 pass or product env-absence finding. The final run uses Node 22.22.3 and the corrected, independently reviewed gate observer.

Observer integrity review: the initial substring scanner was rejected because malformed/decoy assignments could produce a positive witness. The final helper parses top-level shell-quoted env tokens, checks exact assignment keys/duplicates, limits observation to owned-root gate publications, retains only two values, and separates observer failures from original rename results/errors. Parent's offline-v2 controls include real gate forwarding/joining, quoted decoy and malformed input, missing/wrong/duplicate fields, unrelated renames, original rejection and secret absence. This reviewer inspected helper/tests but did not execute them.

Remaining parent-owned gates:

1. Final `93b188f68d9664c46df62aa3249b4defffd884af` full `npm test`, typecheck and build (parent reports running at PID 32238), plus final-head required CI. The parent reports PR #1504/main's prior full gate at 26 groups, 8,819 pass / 65 skip / 0 fail; that is not substituted for PR #1505 final-head verification.
2. Keep claims scoped to versioned-ID refusal-switch env enforcement and the measured happy path. Configured SDK `fallbackModel`, other native executables/platforms, a causally triggered refusal-switch before/after comparison, and E41 remain outside this proof.
3. Preserve the receipt, exact sanitized harness and prior failed/limited attempts in durable PR/handoff evidence. Do not silently retry or switch account/model to turn a refusal into acceptance.
4. No release or merge authorization is implied by this review. No remaining material production finding was found in the final four-file diff versus `1e24a969`.

## Initial implementation evidence log checksums (historical snapshot; not final-head gate results)

- `build.log`: `e3cfdbdb68b8f8b019cd0a17b2b7414c6408ae9b1c8c20c1dea9c0975eb83c37`
- `focused-tests.log`: `11f89a97429527d1cc2ca09f32112ac2a32d8287a18e1e39859c168712c8357f`
- `models-tests.log`: `89188588ce80ece89a35b9dbd1089482d58815838c818af26485d56d763bee86`
- `red-tests.log`: `16b8729594d99e4190a22c5c2b2c5e0957b4aea5c903610d34af057bd16a03ed`
- `typecheck.log`: `2e9f88f0e09751747d0e75007b430974347da5bcdb4af27d7c363c94f5490199`
