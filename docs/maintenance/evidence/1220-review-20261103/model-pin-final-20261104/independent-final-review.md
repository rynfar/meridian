# PR #1505 final read-only adversarial review

Reviewed 2026-11-04T08:06:23.111788+00:00.

**Verdict: no material finding in the narrow final product diff.** This is a static review, not acceptance of the still-running final verification.

## Frozen scope

- Final head: `5708dfd19062e4aff35d284e7971661fd11d8bf6`.
- Current supplied/locally recorded `origin/main`: `2297d61e4f157ad6448dc787c64849f565f4377f` (includes additive PR #1506).
- Complete comparison: exactly four paths, 48 insertions / 13 deletions. Independently checked committed tree entries and matching Git blob identities using Python filesystem reads. The stale owner checkout was not used as the final main comparison.
- Supplied complete diff: `/Volumes/DevSSD/meridian/evidence/model-pin-final-20261104/complete-final.diff`; SHA256 `00be5d7391ac411119d804f2bf727612602667ba4286567746a99830fb5f7189`.
- Four changed-file SHA256 values match the prior frozen review:

| Path | SHA256 |
|---|---|
| `src/proxy/models.ts` | `d6216e56b0034a3182e6aaf270dc8977ea130ffee58025fa76a39fbace34769f` |
| `src/__tests__/explicit-model-pins.test.ts` | `02f7faece3a34083f8b4febf1c41bdb8d7692b68a8a3cdd4e0d9908ba48bb1f4` |
| `src/__tests__/proxy-env-stripping.test.ts` | `c3416da794bb3c36d81f6bc281d927036fbad3aac210bb26a47164cca8bd026a` |
| `src/proxy/SPEC.md` | `113dea856134c4e9104fe46962f993e0f088fc521b12425982bf4bffd7608725` |

## Concrete checks and limits

1. **Exact pin and aliases:** `models.ts:111-119` adds only `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK="1"` to the existing recognized versioned-ID override. Recognition, normalization, `[1m]` removal, tier values and Mythos-to-Fable mapping are unchanged. Bare aliases/unversioned family requests still return `undefined`; their inherited behavior is preserved. No model constant or timeout changed.
2. **Refusals and retry:** no refusal-recognition, refusal delivery, same-model retry, policy-bypass or safety control is changed. In particular this patch does not set `CLAUDE_CODE_DISABLE_REFUSAL_RETRY`. Native switch semantics remain the version-specific static evidence recorded in `model-pin-adversarial-review.md` (Claude Code 2.1.296), not a newly forced refusal-switch experiment or universal guarantee for every executable.
3. **Independent SDK fallback:** `query.ts:913` still forwards configured `fallbackModel`; `sdkFeatures.ts:73` still defaults it to empty. All seven request/recovery paths still forward it independently. The owning spec explicitly states this limit. No claim of universal model-substitution prevention is justified.
4. **All request/recovery env paths:** `server.ts:2875-2877` creates a request-local override, with the existing auxiliary cache-TTL addition. All seven `buildQueryOptions` sites (4922, 5029, 5090, 6358, 6445, 6502, 7419) carry that override, including stream/nonstream, replay/fresh retry and silent-turn recovery. `query.ts:836,890` inherits profile env then spreads request overrides last. The unchanged process-gate boundary forwards the defined SDK env. These four boundary files have exactly the hashes recorded in the prior frozen review.
5. **Tests are independent of actual serving identity:** pure helper assertions discriminate recognized IDs and negative alias controls. HTTP-to-mocked-SDK checks discriminate propagation, inherited-value precedence, streaming and unchanged retry env; removing the production flag would break the added explicit-env assertions. Their canned SDK model annotations do not prove native serving identity. Inherited `"false"` is a merge-precedence control, not a native boolean-semantics proof.
6. **Integration and public contracts:** the helper remains common Claude model-selection logic, not a new OpenCode/client special case. No exported configuration/lifecycle, header, health, route, adapter interface, dependency, packaging or integration harness changed in this four-file comparison. The change remains independent of contributor #1220 and does not establish E41 resolution. PR #1506 is already in the compared main; it contributes no residual hidden product scope here.

## Remaining parent-owned gates

- Final-head full `npm test`, typecheck, build and required final-head CI, including `test`.
- Final built/independently installed actual OpenCode flow, with generation-matching Meridian plugin preflight and runtime/route witnesses. Earlier installed-client evidence is not relabelled as a final-head run.
- Preserve the narrow claim and durable evidence. A causally triggered refusal-switch before/after, other native executables/platforms and E41 remain outside this static verdict.

No programs, tests, live/model/network calls, credentials, source edits, commits, pushes or external comments were performed by this reviewer. Only this requested report was written. Assumption: the prior native-semantics evidence remains applicable to the same selected native version; this review does not extend it to other versions. No constants were changed by the reviewer.
