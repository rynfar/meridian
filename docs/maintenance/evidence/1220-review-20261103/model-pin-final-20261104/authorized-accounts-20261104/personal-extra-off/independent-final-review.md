# PR #1505 — personal Extra Usage OFF final acceptance review

Reviewed 2026-11-04T16:30:22.095262+00:00.

**Verdict: no material product-fit, regression or evidence defect found for the narrow #1505 qualification.** The settled, final-head installed-package actual OpenCode flow passes on the admitted tuple. No required live result is missing for that narrow qualification. This is not acceptance of #1220 E41, historical cache behavior, a historical native-scope cause, or a release.

## Exact scope and custody

- Head: `19bf2128916c6aefc9e7128011bc9c201de27a07`.
- Accepted comparison main: `2297d61e4f157ad6448dc787c64849f565f4377f`.
- Inspected the complete committed comparison: exactly five paths, 56 insertions / 16 deletions. It matches `evidence/model-pin-final-20261104/corrected-final.diff` byte-for-byte, SHA256 `a913ed6ecec3a1bac98305e797c113b53b6d493f13164bf23608f854e09200ac`. No hidden runtime, dependency, packaging, adapter, public-interface or session/history change appears in this comparison.
- The four explicit-model product/test/spec files retain the exact bytes reviewed in `model-pin-final-review-20261104.md`. The fifth path is only the final Node hook fixture correction reviewed in `hook-node-fixture-review.md`.

| Changed path | Independently checked SHA256 |
|---|---|
| `src/proxy/models.ts` | `d6216e56b0034a3182e6aaf270dc8977ea130ffee58025fa76a39fbace34769f` |
| `src/__tests__/explicit-model-pins.test.ts` | `02f7faece3a34083f8b4febf1c41bdb8d7692b68a8a3cdd4e0d9908ba48bb1f4` |
| `src/__tests__/proxy-env-stripping.test.ts` | `c3416da794bb3c36d81f6bc281d927036fbad3aac210bb26a47164cca8bd026a` |
| `src/proxy/SPEC.md` | `113dea856134c4e9104fe46962f993e0f088fc521b12425982bf4bffd7608725` |
| `src/__tests__/antigravity-expansion.test.ts` | `921f8d765b5ac60e8f2532e8835d72a35413bedbc9276d3b83ad870cf997900c` |

## Product and regression checks

1. `explicitModelPin` adds only `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK="1"` after the existing recognized-version match. Normalization, `[1m]` removal, tier defaults and Mythos-to-Fable mapping are unchanged. Bare aliases and unversioned family names still receive no request override. No model or timeout constant changes.
2. The override remains request-local at the existing common Claude boundary. All seven main/recovery call sites forward it. `query.ts` spreads it after inherited/profile environment, and the unchanged process gate publishes the defined SDK environment. These inspected boundary files retain the prior review's exact hashes. No new client special case, global state or dependency cycle is introduced.
3. Refusal recognition and delivery, `CLAUDE_CODE_DISABLE_REFUSAL_RETRY`, and same-model retry behavior are not changed. The separate configured SDK `fallbackModel` still passes through. The owning spec correctly limits the decision to the native refusal alternate-model switch. The version-specific native-semantics review remains bounded; no universal no-substitution claim is justified.
4. Pure helper expectations and mocked HTTP assertions discriminate flag presence, inherited-value precedence, stream propagation and negative alias behavior. They would fail if the production flag were removed. Their canned SDK model annotations are not treated as serving-identity evidence. Inherited `"false"` tests merge precedence, not the native switch's string-boolean semantics.
5. The hook fixture now resolves `Bun.which('node')`, explicitly rejects missing Node, and exercises the real platform shell with the path-with-spaces script. Its structured witness requires Node and no Bun. The existing 5,000 ms bound, cleanup and Windows percent negative remain. Production hook code is unchanged. Prior red/green distinguishes interpreters, not the cause of the earlier blank-output timeout; that failure is not erased or called explained. No new Windows execution claim follows from this review.

## Installed artifact, client and selected native identity

- Installed Meridian build provenance identifies clean exact head `19bf2128`, source hash `c5fa73d84ef83806c5cc7a9bc212b592a906c468ff15f68e8024c2cc0debfcc0`, certification `verified`, attempt `88af520f-8432-4aab-8efc-8b511cf5ea78`.
- Independently recomputed **all 701 installed artifact hashes** listed in that provenance: no mismatch. The independently installed tarball SHA256 is `e0eaeccb0a4f7a4973a2837c11fbcbcf9cef5b5245787b1e40ebac4df3812122`. Its SHA1 and SHA512 match `npm-pack.json`; its SHA512 also matches the installed lockfile's local tarball integrity. This is not a fresh registry-install or release claim.
- Runtime/client tuple: Node `22.22.3`, actual OpenCode `1.18.34`, installed SDK `0.2.141`, selected Claude Code `2.1.296`, Darwin arm64, exact `claude-opus-5-5`. Client executable realpath/hash match `launcher-identity.json`; SHA256 `7b63b34fafabded7d9231f6a9032755d0cdeaf8b9d2b70df8e25535471469eea`.
- **Native identity clarification resolved:** the installed package's default Claude dependency is `2.1.318`, but it was not selected. The admitted `E2E_NATIVE_BIN` is `/Volumes/DevSSD/meridian/review-1220-20261103/node_modules/@anthropic-ai/claude-code/bin/claude.exe`. Independently read binary SHA256 `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937`, matching the prior 2.1.296 native-semantics artifact. The sanitized launcher retains the bounded version output. The frozen helper assigns this override to `MERIDIAN_CLAUDE_PATH` before server import/start, after its default assignment; source resolution gives it precedence. The exact eight actor commands match the launcher receipt. This review does not qualify default 2.1.318 semantics.

## Frozen helper and plugin validity

The three actual-client helper files match `source-manifest.json`, admission and launcher hashes, and are mode `0444`:

- Actual helper: `ffcf54ca7091abae02cf1f83e9b0c81a98dbd5ecb8f50732a518180adeb746c7`.
- Gate observer: `75af2733bc17362a4dd69c895113426b38658ee25dff0fdff1a048bac6f5bc5a`.
- Scrub preflight: `d981812fc4ba442e24cb2c869ad363993d5c85ac6642bd6803a5f0890da71514`.

The settled report's self-recorded helper hash matches these frozen bytes. The gate observer waits for a successful original rename into the owned gate root, parses top-level shell-quoted exact assignment keys, rejects duplicates/wrong/missing fields, and retains only the two allowlisted values. It does not replace the SDK, supply the flag, edit native gate contents or turn original rename failures into success. The helper clears ambient Claude/Anthropic/Meridian flags before setting the admitted test configuration. Its observer is POSIX-specific; the admitted platform is POSIX.

I read the effective isolated client config's safe fields: exactly one V1 Meridian plugin, resolved to the same installed package's `dist/meridian`, and the Anthropic provider points at the selected loopback proxy. The helper requires successful installed-CLI `setup --v1` and exact config resolution before starting inference. The actual client version independently records generation 1. The installed entry is package `@rynfar/meridian-opencode-v1-plugin`, SHA256 `c640cc02817d9ad05d5b61f6bd906fdccdb4ef71be42d11981aecaeb84bc434e`, covered by the verified artifact manifest.

Runtime requests observed by that proxy carry the V1 plugin's session and agent headers, including `build` on the real `read` flow and the same session on its result and continuation; the helper does not manufacture these headers. Thus a configured but inert/wrong-generation plugin is not substituted for actual plugin use. This flow does not claim priority-attestation or V2 catalog qualification. The separate server scrub `0.3.0` is checked active before inference, then has four onRequest invocations and zero errors; its installed/package/runtime identity is retained, not mistaken for the client plugin.

## Settled live evidence

Reviewed the sanitized `authorized-accounts-20261104/personal-extra-off/actual-client-receipt.json` and the parent-provided settled `report.json`, not raw client output or customer logs. All 13 overlapping result fields match, including actors, requests, histories, scrub identities and native evidence.

- Parent-owned run: **PASS / exit 0**, about 35 seconds; one admitted run, personal account, read-only access-only grant. The retained read-only usage preflight says Extra Usage is **OFF** and weekly use was 67%. No refresh or owner credential writes are reported. These authorization/billing facts are receipt evidence, not credential probes performed by this reviewer.
- Four actual proxy requests are HTTP 200, all request `claude-opus-5-5`, with a primary `read`, its real random file receipt in a tool-result request, and a successful same-session follow-up that repeats that receipt. `continued=true`; no observed provider error is hidden by the PASS.
- Supported Agent SDK `getSessionMessages` inspection runs after both the read flow and continuation, stays within the owned fixture, requires nonempty assistant model sets, and finds **only `claude-opus-5-5`** in every retained set. This is real supported history evidence, not client-request labels or mocked response identity.
- Four owned published native-gate witnesses all show `explicitOpusPin=claude-opus-5-5` and `refusalFallbackDisabled=1`; observer errors are empty. This reaches the actual native launch boundary rather than merely observing the shell wrapper's inherited environment.
- All **eight observed actors** have process close plus stdout/stderr close witnesses; `joined=true`. The helper would change the result to FAIL if those joins were missing. One observed shell actor exits 1, so I do not claim every child exits 0 or diagnose that exit's cause. The required client commands, HTTP responses, receipt continuation and supported-history checks succeed. Join evidence is for the observed owned actors, not an unbounded claim about every OS descendant.
- The unchanged helper uses the admitted 90,000 ms upstream-idle setting and bounded client commands; the plan records a 600-second outer bound. No relaxed timeout, model switch, retry injection or retrospective redefinition of this run is used to qualify it.

Evidence SHA256 at review:

| File | SHA256 |
|---|---|
| Settled sanitized actual-client receipt | `299f3e94be2736ef888f055c85160c69e300ffbd542c4b27d3ac2791564b3a1f` |
| Settled safe report | `1f834689cb86d56a6840f1e2d56b27aab547c336fb178a7f859f68d2f0912788` |
| Sanitized launcher identity | `5eeeb36a692b78888f4c577d9d62dc9731ac2435cdc95c2fd810666a1b18eba5` |

## Qualification boundary and handoff

**No missing #1505 live result remains in this reviewed tuple.** The successful actual-client flow proves final installed artifact integration, the exact native env contract, real read/result continuation and observed serving identity. It does **not** causally trigger a refusal-switch before/after, establish why the earlier model mismatch occurred, qualify arbitrary native versions/platforms or configured SDK fallback, clear final-source #1220 E41's four-mode history/cache matrix, or dispose of historical cache/native-scope holds. Those are separate unresolved claims, not new #1505 barriers and not silently removed by this supporting fix. The earlier revoked-grant attempt remains separate; this new authorized grant is not described as a demonstrated causal credential cure.

Parent-owned verification evidence now includes final-head CI run `41798125923` with `test` and `windows-smoke` successful, and successful local full-test/typecheck/certified-build records. I read those records but ran none of their checks. Parent retains responsibility for current merge gates, exact-head protection, durable PR/handoff escrow of this final receipt/launcher/frozen helper alongside the earlier failures, and any missing repository-owned harness follow-up already recorded in the evidence handoff. The local evidence directory alone is not publication or release acceptance.

Only this requested report was written. No project source edits, tests, builds, model calls, credential reads, network calls, commits, pushes or external comments were performed by this reviewer. A local read-only Git comparison preceded the parent's final no-command request; subsequent review used file reads/hashes only. Assumptions: the sanitized parent launcher/admission faithfully records the run's invocation and authorized account policy. The reviewer changed no constants.
