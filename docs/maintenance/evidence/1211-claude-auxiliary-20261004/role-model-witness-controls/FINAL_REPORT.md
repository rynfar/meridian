# E71 role-specific model and cleanup witness packet

The maintained parent E71 harness is frozen with separate main and classifier requested/served pins, exact correlation through the existing logger context, no-follow snapshot reads, and joined relay/HTTP-receipt cleanup. The final focused run passed 34 tests and 1,124 assertions with no skips. This is synthetic harness and actual-target mocked-SDK evidence on Darwin arm64. Linux x64 official-client/model acceptance remains open.

## Final candidate and commands

- Parent worktree: `/Users/rynfar/repos/meridian-claude-auxiliary-1211-20261004`.
- `scripts/e2e-claude-code-auto-mode.mjs`: SHA256 `e2f58e5ace65183ed61be17e107545ab3c63b42635d882cdf2f9cdb9a59e0765`.
- `src/__tests__/claude-auto-mode-harness.test.ts`: SHA256 `b58d12c799865f2213c0eb0fb790e347fba6377256f45bb1f835a30e8292eda5`.
- Exclusive frozen copies: `final-e71-auto-mode.mjs` and `final-claude-auto-mode-harness.test.ts`.
- Authoritative final exec session 53506 exited 0. Exact command: `E71_COMPILED_CONTEXT_CONTROL=1 E71_CONTEXT_EVIDENCE_DIR=/tmp/meridian-backlog-20261004/meridian/1211/role-model-witness-controls/final-cancel-entry-context bun test src/__tests__/claude-auto-mode-harness.test.ts`.
- Log: `final-cancel-entry-focused.log`; 34 pass, 0 fail, 1,124 assertions, 65.11 seconds; source and compiled controls both ran. `node --check scripts/e2e-claude-code-auto-mode.mjs` and `git diff --check` passed.
- Latest clone subset, session 55728: 1 pass, 57 assertions, 7.15 seconds; `cancel-entry-iteration.log`.

No full suite, typecheck, build, native execution, real model/auth calls, installation, commit, push, or GitHub write was performed in this delegated lane. Root owns full final gates and durable repository escrow. Only the two named repository files were edited by this lane; E71 E2E documentation belongs to the parent reviewer.

## Official selector audit and role model verification

The separate read-only audit at `../classifier-model-selection-audit/REPORT.md` identifies the official Linux x64 GNU Claude Code 2.1.286 binary by SHA256 `fe503f65c6289d59c23e5b21ae44f03583f997dd33a2cbfc75ab4f96fb8fc73f`. It records 29 bounded source slices, byte offsets, function/caller relationships, and package/archive identities. The selector can choose permitted Sonnet5 for a Sonnet5-5 main flow, then fall back to the main model after probe/demotion. Runtime feature configuration, policy, entitlement, catalog suppression and provider normalization can affect the result. Static inspection does not establish actual emitted wire traffic or served models.

E71 now requires all four explicit model flags: `--model`, `--served-model`, `--classifier-model`, and `--classifier-served-model`. A run accepts one classifier requested arm, either the exact requested main fallback or audited `claude-sonnet-5`; it never accepts a loose collection of possible models or forces client configuration to avoid the legitimate selector. Each relay request records its exact wire model and role. Each SDK query must use that exact full model ID, or the supported `sonnet` tier with `ANTHROPIC_DEFAULT_SONNET_MODEL` exactly equal to that request's wire model. Served model receipts must equal the explicit served pin for the same role. Main and classifier requested/served identities are saved separately.

The actual server maps the full Sonnet requested model to SDK `sonnet` through `mapModelToClaudeModel` around `src/proxy/server.ts:2171` and writes the explicit version pin through `models.explicitModelPin` around server line 2255. The source/compiled controls exercise those real modules. Original cd8 E71 did not reject tier aliases: it recorded requested IDs while checking served IDs globally. Its unsupported global served-model assumption and missing per-request model ownership are distinct from E72's separate false alias rejection.

## Exact request correlation and limits

The observer uses the target's existing private logger ALS request context, not a new public product/header field or query timing. The actual `handleMessages` caller wraps each request with `logger.withClaudeLogContext({requestId, endpoint})` around server line 1597, and SDK query creation remains inside that context around line 1022. A bounded wrapper on `AsyncLocalStorage.prototype.run`, installed before target import, preserves the original receiver, store, callback arguments, return values, throws and async propagation. It shadows only an owned relay request ID at endpoint `/v1/messages`, pins that actual logger ALS instance, and rejects missing/unmatched/repeated IDs or a second matched logger instance.

Nested malformed/unmatched runs on the pinned logger clear the witness, so they cannot borrow an outer request. Unrelated ALS stores preserve the original context. The observer verifies an exact one-wire/one-query mapping and saves only request ordinals, role, model IDs and match booleans; raw request UUIDs are not saved. Different-model main/classifier swaps are discriminating negatives. Same-model swaps are not independently distinguishable from a hostile target forging the actual logger context. This is provenance of the stable actual logger/relay path, not a general protocol identity attestation.

Existing product retries for refusal, context and rate limits may legitimately create multiple SDK queries under one request ID. This benchmark conservatively fails those retries rather than silently accepting ambiguous ownership. A successful native arm can establish only its bounded no-retry path; retry paths remain a separate gate. Existing query count, cost, child, HTTP body and total deadline limits are retained.

## Actual source and existing compiled controls

`final-cancel-entry-context/` contains eight full sanitized JSON receipts and eight exact isolated runners: source/compiled × positive/swap/unmatched/duplicate. The source control always runs without `dist`. The compiled control is an explicit maintained opt-in; a clean CI checkout can honestly skip it, while the authorized local final run executed it with `E71_COMPILED_CONTEXT_CONTROL=1`.

The compiled target is the existing certified build for source commit `80d1ce8158dc7cd466a87863404bf6ea02754c8b`, not a freshly rebuilt final harness checkout. Production source in the parent is unchanged from that certified production commit; subsequent changes are docs/harness. Runners verify clean certified provenance and declared artifact hashes. The compiled core chunk `dist/cli-b0d2whr6.js` SHA256 is `182e49d4d77499ef7c39a164b9bd3101d5dd6fe83d53a74a8a1bfcebf1120295`. Each receipt independently records the exact entry and model-module hashes it imported.

Positive source and compiled controls returned 200/200 with SDK `sonnet` and exact main Sonnet5-5/classifier Sonnet5 pins. Swapped-role contexts returned 500/500; unmatched and duplicate contexts produced one rejected request. All eight operations joined, restored the exact original descriptor, made zero external fetch attempts, and performed no auth or executable discovery. SDK/auth-status/executable resolution were explicitly mocked; real server, logger and model-mapping modules remained active. Both query entries were released by an explicit shared barrier, so ownership was not inferred from timing.

## Separate historical before/after proof

`before-after-driver.ts`, `before-after.log`, `before-after-summary.json` and the eight full role proof files compare immutable cd8 baseline to the immutable **prejoin** corrected harness `frozen-e71-auto-mode.mjs` SHA256 `8d50248a6a8eaea377a5bd0e55a21a5929ec4ac48c0385c0865b2bf53eace0bd`. Its exact test snapshot is `prejoin-claude-auto-mode-harness.test.ts` SHA256 `9a1cdef732cb15d23d36884322131b00035c8368a72942d62dafd3bc43d263b1`. Do not describe these historical after-files as final e2f/b58 evidence. Session 94233 exited 0.

The same synthetic mixed-model fixture fails baseline's global native-receipt gate and passes the corrected prejoin model witness, both with 10 queries. Missing and unmatched context fixtures pass baseline with 10 queries but fail corrected before the original SDK executes. Duplicate SDK queries for each wire request pass baseline with 20 queries and fail corrected at four admitted first queries. That duplicate failure is a conservative retry limitation, not a claim of malicious client behavior. `independent-review-prejoin.json` is explicitly scoped to this prejoin pair and its 33-test/1,067-assertion run.

Pre-read containment evidence is separately recorded in `../snapshot-pre-read-controls/REPORT.md`. HTTP receipt cleanup and the exact entered-cancellation causal comparison are separately recorded in `http-receipt-join-controls/REPORT.md`.

## Cleanup correctness and remaining gates

The final harness stops relay admission before taking handler/receipt join snapshots, tracks each accepted handler from entry through `finally`, joins handlers before receipts with bounded deadlines, and verifies both sets are empty before restoring the exact original ALS descriptor or removing private runtime. Restorable descriptor drift restores the original descriptor but still fails acceptance; unrestorable drift reports false restoration and retains private runtime. Proof flags are assigned from actual restoration, not from a join predicate.

The maintained clone failure resolves cancellation and proves joined cleanup with a false native-receipt gate. The maintained clone hang immediately rejects the clone read, writes an actual cancellation-entry marker, then leaves cancellation permanently pending. It proves joined handlers/zero processes, one pending receipt, false descriptor restoration and retained private runtime. Independent subprocess caps protect the synthetic controller; only the controller removes the retained fake fixture after its child process has exited.

Historical session 82655's 34-test/1,122-assertion run and session 98415's clone subset used read-never fixtures without cancellation-entry proof. They establish pending-read cleanup handling only. The final session 53506 uses the corrected immediate rejection/entered-cancellation fixture and is the authoritative final file proof. Earlier session 85645's 30-pass/1-skip run did not execute compiled controls because `MERIDIAN_*` opt-in variables were deleted by preload; it must not be cited as compiled proof.

Live native selector/config/policy/entitlement/probe/demotion, exact emitted wire IDs, implicated requested/served models, SDK/client/platform, retries, real execution receipts and affected-flow before/after acceptance remain open. No synthetic or static result here closes those gates.
