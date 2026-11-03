# PR #1220 historical premerge evidence findings

Date: 2026-11-03. Read-only investigation in `review-1220-20261103`. No tracked edits, model requests, credential inspection, external comments, or test execution. This report does not waive an acceptance gate.

## Bottom line

1. **The residual E41 cache observation remains an evidence blocker, not a demonstrated async-writer regression.** Supported historical metadata confirms a published prefix of 3,332 and the next read of 3,132 (94.00%; unchanged 95% floor is 3,165.4). The original transient request/cache condition is not retained. Two unchanged-main controls and later candidate greens did not reproduce or explain it. They establish neither that the async-writer diff caused it nor that baseline inherited it.
2. **The old fingerprint deadline and initializer exit remain unexplained historical events.** Retained evidence narrows scope but supplies no environmental cause. The initializer correction improves diagnostics, not production bootstrap behavior. Do not relabel either failure fixed by a passing rerun.
3. Several other historical failures **do have discriminating fixture/runtime explanations**. They should not be conflated with those three unresolved observations.
4. The PR body is an October checkpoint naming `92222508`; live read-only GitHub data now names head `bb2e18a3f8362d1a2b3a3529cd50007361bc070b` with all eight executed hosted checks successful and the expected changelog skip. This refresh does not establish original live acceptance or explain the old failures.

## Durable sources recovered and integrity

- **G:** `d4d27e31aad66749413310fc8dfbc5f29888c8b4:docs/maintenance/evidence/1220-gc-fixture-20261021/`
  - [CURRENT.md](https://github.com/rynfar/meridian/blob/d4d27e31aad66749413310fc8dfbc5f29888c8b4/docs/maintenance/evidence/1220-gc-fixture-20261021/CURRENT.md)
  - `checkpoint.tar.xz`, `diagnostic-update.tar.xz`, `capture-scope.tar.xz`, `capture-scope-final-local.tar.xz`, `hosted-final.tar.xz` and their manifests.
- **M:** `702ee488d4ae0ddf234b20e11134d1d498b24617:docs/maintenance/evidence/1220-current-main-20261021/`
  - [CURRENT.md](https://github.com/rynfar/meridian/blob/702ee488d4ae0ddf234b20e11134d1d498b24617/docs/maintenance/evidence/1220-current-main-20261021/CURRENT.md)
  - `checkpoint.tar.xz`, `current-qualified.tar.xz`, manifests and `original-cache-metadata-recovery.json`.
- **O:** `1cb9e53cb4ded92b8589177265cb736eb0978011:docs/maintenance/evidence/1220-async-session-store.md` and `1220-session-store-verdicts.json`, from preserved old delivery draft #1245. This is historical proof only; it is not a proposed route for contributor code.
- Current `E2E.md`, `docs/maintenance/evidence/e41-thinking-fidelity.md`, relevant committed harnesses, and the live PR bodies were read. No old temporary fixture/private SDK persistence was inspected.

All seven archive digests and **173 member byte lengths/SHA256 hashes match their committed manifests**. Archives were read in memory from Git exports outside the checkout. Recovery therefore does not depend on the old `/tmp` paths. A source can be recovered with `git show COMMIT:path`; an archive member can be read with `git show COMMIT:path.tar.xz | tar -xOJf - MEMBER`.

## 1. E41: accounting error and harness fidelity are established; residual cause is not

### Actual recorded numbers

O's `1220-session-store-verdicts.json` → `unresolvedE41` records the original **chain/nonstream** failure:

| Observation | Cache read | Cache creation | Meaning |
| --- | ---: | ---: | --- |
| Original HTTP aggregate for thinking/tool turn | 3,132 | 3,461 | 6,593 combined; the old assertion asked for 6,263.35 next read |
| Published native thinking/tool assistant | 0 | 3,332 | Correct single-message published prefix |
| Next turn | 3,132 | 427 | Still 200 below published prefix; 33.4 below unchanged 95% floor |
| Later turn | 3,559 | 53 | Reads previous turn's 3,132 + 427; does not explain prior 200 |

M's `original-cache-metadata-recovery.json` retains supported-API message IDs and known owned session UUIDs. Its thinking and tool rows share **one message ID and the same counters**: do not double-count them. Earlier native prefixes are 3,003 and then 3,003 + 129 = 3,132. This numerical match is useful context, not proof of why the newest 200 were not read.

The original tool batching, receipts, fork chain and active history passed. A smaller read counter is not by itself evidence of missing history or failed resume. The HTTP aggregate was an invalid proxy for the published single-message prefix in this incident. Correcting that denominator removes the large apparent loss but **does not make the unchanged 95% assertion pass**.

### What is proven about the verification client

Current `e41-thinking-fidelity.md` and committed `scripts/e2e-e41-thinking-fidelity.mjs` document a separate reproducible **offline harness defect** (landed through #1272):

- JSON replay projected thinking/redacted blocks to type-only objects, losing signed thinking/redacted data.
- The old streaming parser ignored thinking/signature deltas.
- The shared `scripts/lib/e41-assistant-response.ts` now preserves full received blocks and opaque fields; it does not manufacture a signature.
- The immutable-baseline offline control has three expected failures before and three successes after, with ordinary tool/text replay and usage controls. This is genuine discriminating evidence for the harness correction, not a live E41 pass.

Native checkpoint resumes restore the SDK assistant history and send new user/tool-result content. Therefore damaged client echo **does not by itself establish native prefix deletion or explain this residual 200**. The same evidence record explicitly leaves the causal gate open. Offline four-mode comparisons at old base `d5738872`, old source `1cb9e53cb4ded92b8589177265cb736eb0978011` and then-main `3afca1f5` matched default initial requests, tool schema, query options, fresh/resume options and lineage. This bounds configuration differences, but cannot recreate original generated history or transient transport bytes.

The old #1245 PR body also reports an encrypted retry control: aggregate 6,666 versus published/next-read prefix 3,333, with aggregate inflation on unchanged main too. That supports an **accounting mechanism**, not the original residual's cause. The exact encrypted-fault script/transport trace is not in the scoped retained Git artifacts found here; the old body says those facts lived in the owned persistent fixture. Do not treat it as a recovered reproducer of the 200-token event.

### Missing original evidence

M records `exactFailingLocatorRecovered: false`; 35 known harness-owned app stores yielded no matching original session. A control-profile locator points to an absent staging directory and is not evidence of the failing locator. The old record says supported recovery once succeeded, but the later retained record preserves only whitelisted metadata, not the original fixture locator.

Known session UUIDs alone do not identify the correct `CLAUDE_CONFIG_DIR` and project workdir. Missing original facts include ordered SDK prompts/options, checkpoint/fork identities, row UUIDs/block hashes/system metadata, native per-message/retry ordering, transient transport transformations/cache breakpoints and request-start/cache-lifetime timing. No retained artifact selects a root cause among those conditions. Neither another model nor a green run on current native/client versions closes this gap.

## 2. Fingerprint deadline: actual retained failure, absent slow-operation trace

G `diagnostic-update.tar.xz` → `final-r6-local.json` and `final-r6-full.log` retain run r6 at `3ea2bf7a884f8ca49881fc1e34d679181e7da915`:

- Standalone typecheck/build exited 0, then the first full-test group failed with **7,573 pass / 36 skip / 2 fail**.
- `bookkeeping-cli.test.ts`'s nested build exited 1. The stack is retained: `buildFingerprint.ts:15 check` → `hashFileInto` → `snapshotSource` → `certifyBuild` → `scripts/build.ts`.
- The actual error is `Build provenance unavailable: invalid` at the unchanged `performance.now() + 2000` deadline. This establishes budget exhaustion, not corrupt source and not the reason the work exceeded budget.
- Later `current-fingerprint-observation.json` records 781.84, 568.86 and 606.09 ms with the same source hash and 11,505 observed operations. Those instrumented later operations passed; the original failed span was not retained.

**Important precision:** original fingerprint stderr/stack is not wholly missing. It is in r6. The missing evidence is the original operation/timing/resource trace that would explain the two-second stall. No retained artifact demonstrates disk contention, CPU load, Git latency, a bad file, or an async-store regression as that cause. The strict limit and implementation were not relaxed. Current greens do not resolve the historical causal hold.

## 3. Initializer [0,1]: diagnostics fixed; cause remains unknown

The same r6 log retains `bookkeeping-review.test.ts` → “two simultaneous initializers publish a complete schema; dead linked bootstrap aliases require exclusive recovery”: expected `[0,0]`, received `[0,1]`, in 393.78 ms. The original child stdout/stderr were discarded.

G `diagnostic-update.tar.xz` contains:

- `diagnostic-source.diff`: bounded 64 KiB stdout/stderr capture; joins each original child and its original pipe closures; bounded teardown. The original `[0,0]` assertion and 10-second startup deadline remain.
- `bootstrap-diagnostic-control.json`, logs and `check-bootstrap-diagnostics.py`: a deliberately forced startup error leaves **both before and after red**, but only after retains the precise child stderr. Thus this is diagnostic sensitivity, not a bootstrap fix.
- `bootstrap-observation-results.json`: twelve later passing attempts. The record explicitly says they do not explain the original discarded stderr.

G `capture-scope.tar.xz` → `bootstrap-bundle-comparison.json` and `compare-bootstrap-bundle.mjs` compile thirty immutable main source objects and candidate objects with the same compiler/dependencies/physical paths. Both emit byte-identical **102,806-byte** Node bootstrap payloads (SHA256 `1932cb941876e27c515ddfba3117f81ee265ede152831cebd6b5e77aae214522`). This is strong evidence that the async-writer production delta did not change those child payload bytes. It does **not** reproduce the original environment, explain child exit 1, exclude parent/resource effects, or turn the event into a resolved baseline defect. No retained environmental cause is established.

## 4. Historical failures that do have supported narrower explanations

| Failure / scope | Discriminating retained evidence | Correct conclusion |
| --- | --- | --- |
| Linux at `82ff`: migration refused live GC candidate | G `checkpoint.tar.xz`: cancellation fixture never closed proxies; pending-work registry baseline `pending=true`/exit1 vs corrected `pending=false`/exit0; ordered pair 13/0 | Fixture teardown defect, corrected by joining real backends before globals/root teardown. Migration guard unchanged. Two earlier spy/provenance attempts are explicitly inconclusive, not proof. |
| Linux at `eaee`: expected reentrancy rejection passed, global capture spy saw one process observation | G `capture-scope.tar.xz`: unrelated real microtask capture fails old global observer, passes scoped observer; real forbidden capture before guard and after await still fail with bounded producer attribution | Observer scope was demonstrably wrong; correction retains invocation-local safety assertion. Original CI producer stack was not retained, so exact original caller remains unproven. |
| Old macOS Bun 1.3.14 kill-during-write test | O: independent plain HTTP disconnect control misses real close on Bun1.3.14; Node22.22.3/Bun1.4.2 observe closes; real same-client check on Bun1.4.2 records aborts/zero canceled renames | Supported runtime limitation, **not a fix by #1220** and not an explanation for E41/fingerprint/initializer. |
| Old Linux pre-write auth failure | O: failed before disk-write proof; replacing only owned grant mirror from still-valid native profile restored receipt/resume/write checks | A specific stale copied grant was supported there. No present auth failure or reason for another login follows. |
| Old Ubuntu desktop lifecycle startup | O: fixture CLI child killed by default five-second test deadline; actual six-second child fails old budget and passes two starts under explicit twenty-second test budget | Separate fixture budget issue; no session-store code executes. Not the later schema initializer `[0,1]` event. |

G's complete r8 and hosted records demonstrate the corrected October candidate passed local **8,102/36/0** and hosted **8,110/28/0** across 26 groups. They qualify those executions only. Later current-head CI is separate and green, but neither set replaces unresolved original evidence.

## 5. Smallest honest next evidence path; existing harness inventory

**Do not invent the original transient fault. No complete instrumented causal encrypted-retry/control harness was recovered in the linked scopes.** An uninstrumented success on native2.1.296/OpenCode2.2.0 is not a substitute for the old native2.1.284/OpenCode1.18.34/SDK0.2.141/Opus5.5 observation.

Reusable existing components:

1. `1cb9e53cb4ded92b8589177265cb736eb0978011:scripts/e2e-session-store-turns.mjs` with `E2E_USAGE_TRACE=1`: real SDK observer, 200 ms asynchronous store holds, thinking/effort options, assistant/result/message-start usage, `system/api_retry` order, session IDs/cwd and supported history counters. It **does not** provide a retained encrypted fault, complete prompt/options fingerprints, block hashes, request-start/cache-lifetime evidence, or a complete before/after causal comparison.
2. Same object `scripts/e2e-session-store-history-usage.mjs`: supported `getSessionMessages` recovery for a **known owned config/workdir/session list**; no inference. It cannot recover unrecorded transient prompts or locate the fixture from UUIDs alone. These two scripts are absent from the present #1220 checkout but recoverable through Git.
3. Current `scripts/e2e-qualified-passthrough-turns.mjs`, `scripts/lib/e41-assistant-response.ts` and `scripts/e2e-e41-thinking-fidelity.mjs`: qualified protocol host and exact replay control. Current E2E rules require both generation-matching Meridian client plugin and server scrub, retained configuration/runtime plugin witnesses, plus a separate actual OpenCode executable check. The old direct wrapper is **not** sufficient under those current plugin requirements.
4. Current `scripts/e2e-mcp-client-opencode.mjs`: actual OpenCode entrypoint referenced by E2E. Its short read/continuation gate does not replace the four-mode E41 matrix.

If the original owned locator/config/workdir can be recovered from task-owned metadata, inspect only via supported history APIs and retain exact row/block identities before deciding on inference. Otherwise a future **causal reproduction** needs an escrowed, instrumented isolated fixture on the original SDK/native/model/platform tuple. Start with original sequential JSON mode and real signed thinking; retain exact prompt/options/lineage/cache-time/retry facts and full-fidelity response replay. A controlled retry arm and an unchanged arm must discriminate the same cache-prefix assertion without making up the original missing fault. Four-mode E41 and actual affected-client acceptance remain separate final gates. A successful control alone is not resolution.

## Assumptions and limits

- The retained evidence is historical observation, not proof that this production diff caused every failure encountered during its review. Conversely, unchanged-main greens do not establish baseline inheritance of the unreproduced cache event.
- No thresholds, deadlines, constants, source or dependencies were changed during this investigation.
- GitHub status was refreshed read-only. Only safe summary facts and immutable object references are included; comment notification links/credential-bearing material are omitted.
