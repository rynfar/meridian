# Completion resumed — occupied-lock correction

User requested completion of #1220 and the authorized release, not a stop at the diagnostic. Supporting PR #1506 is corrected at signed head `02554a0a748f695b79982da071145f83c402415c` over main `1e24a969cc8aba8c62ad3fcea87a4f3da69c6e52`.

## Concrete correction and proof

An advisory `lstat` check avoids durable candidate creation/fsync when the store lock path already exists. Hard-link CAS, owner/death/incarnation/age checks, recovery claims and release are unchanged. No production timeout, stale-age, SQLite qualification, dependency or public interface changed. The historical CI timeout cause remains unresolved; this fixes a separately demonstrated occupied-path cost, not a claimed reproduction of the historical event.

Identical focused test: original production **1 pass / 7 expected fail**; corrected **8 pass / 0 fail**. The dead owner comes from a real maintenance-lock child self-SIGKILL; native death probes and durable operations remain real. Synthetic101ms candidate cost is a deterministic policy test, not measured latency. Native atomic EEXIST race control passes both. Adjacent locking **7/0** and exact PREPARED crash-resume **1/0**; typecheck passes. Independent source review found no material blocker. Source and test were frozen read-only and hash-verified before execution.

Parent added an explicit installed-package PREPARED SIGKILL/journal/PID/resumeREADY/export/lock-release check to the existing committed packaged harness. Its execution awaits the certified build. New direct lock tests run in a fresh Bun process with all assertions retained. This provides the same native environment as the focused proof; it is not evidence that group0 would fail. Prior CLI/concurrent fixture corrections remain unchanged.

## Pending final gates

Required [CI41791701869](https://github.com/rynfar/meridian/actions/runs/41791701869) **PASS** on exact corrected head: npm test **8864pass/28skip/0fail across28 processes**, all additional headless probes and build pass. Windows smoke and the other current checks pass. [CI receipt](ci-receipt.json) distinguishes npm totals from later probes; full job/watch logs are retained compressed. [Complete seven-file independent review](complete-pr-review.md) finds no material integration issue and verifies the old test command is recovered by removing only the two new isolated test groups and their ignores.

Full local npm test **8827pass/65skip/0fail across28 processes** and typecheck pass. Normal build exits0 but explicitly produces an **uncertified archive**, so the certification gate remains OPEN, not passed. A bounded direct snapshot fails the unchanged2s fingerprint budget in `hashFileInto→consume`. A minimal fingerprint resource-use correction is being evaluated independently; no deadline/cap is increased. [Local receipt](final-local-receipt.json), full logs and preflight are retained.

Independently installed Node22 packaged gate first fails a new harness assertion: export legitimately adds canonical metadata to a raw empty store. Earlier SIGKILL/PREPARED/PID/resume assertions reached the export equality; no full-pass credit for that red. Fixture now seeds canonical metadata and still asserts the exact full original object after export; all other assertions/deadlines remain. Independent correction review passes. The **same product tarball with corrected fixture passes the full original package/HTTP/restart/barrier/bootstrap suite**, all original children/pipes joined. [Failed receipt](packaged-attempt1-receipt.json), [corrected pass](packaged-attempt2-receipt.json) and [review](packaged-fixture-review.md) are retained. This tarball came from the uncertified archive build; certified final corrected head and its local/CI/package gates remain necessary.

The first local launch omitted Bun from PATH and exited127 before tests; it remains separately retained. No merge before certification and subsequent corrected final-head gates. No claim that the old hosted timeout is explained.

Old required CI failure and the one-shot diagnostic pass remain separate, durable and unwaived. No second lock diagnostic. #1505 and #1220 remain unmerged. Final-source live E41 qualification follows accepted supporting fixes on matched artifacts with every existing exact-model/95%/history/plugin/join assertion unchanged; no prompt change or green-seeking retry. Missing historical causal/scope evidence remains an explicit acceptance decision, not proof inferred from prospective passes.

[Focused proof, sources, reviews, failure launch and receipts](focused-proof.tar.gz) ([per-member hashes](focused-proof-manifest.json)). Full in-progress logs will be escrowed on completion.


## Final corrected head: certification passed in isolated validation checkout

Final head `effa8bf33dfe85bfd4975a90cd276a3bab728bb8` commits only the independently reviewed canonical-store fixture correction after the previous head. Normal certification **PASS** with unchanged production fingerprint code and2s/caps in a fresh clean detached checkout under `validation.noindex`. [Receipt](certified-build-receipt.json) and [exact provenance manifest](certified-build-provenance.json) record identity/source/artifact hashes. No system indexing settings or daemons were changed. This is environment-qualified final-artifact evidence; it does not explain or fix the original worktree timeout.

The proposed fingerprint allocation patch is **rejected and absent from PR1506**. Real allocation savings did not produce persuasive timing improvement (copied-corpus medians57.10→56.17ms), and its initial form amplified growing-file reads. No further comparator runs. [Rejected investigation and review](rejected-fingerprint-investigation.tar.gz) ([member manifest](rejected-fingerprint-manifest.json)) retain the limitation rather than landing speculative performance code.

Independently installed **certified-package PASS** on Node22.22.3/Darwinarm64: PREPARED SIGKILL/journal/PID/resumeREADY/exportexact/lockgone and full original runtime/twoHTTPprocess/restart/export/baseline/barrier/bootstrap cases; all children/pipes joined. [Exact package integrity/provenance receipt](certified-package-receipt.json). Final-head [required CI41794707547](https://github.com/rynfar/meridian/actions/runs/41794707547) **PASS**, npm **8864pass/28skip/0fail across28 processes**, additional probes and build pass. [Final CI receipt](final-head-ci-receipt.json) and compressed logs preserve exact-head identity. Fresh final-head local fullsuite/typecheck is still running. [State](final-head-gates.json). Nothing merged or released; #1505/#1220 still await accepted supporting fixes and their own acceptance.
