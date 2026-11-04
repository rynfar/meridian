# Completion resumed — occupied-lock correction

User requested completion of #1220 and the authorized release, not a stop at the diagnostic. Supporting PR #1506 is corrected at signed head `02554a0a748f695b79982da071145f83c402415c` over main `1e24a969cc8aba8c62ad3fcea87a4f3da69c6e52`.

## Concrete correction and proof

An advisory `lstat` check avoids durable candidate creation/fsync when the store lock path already exists. Hard-link CAS, owner/death/incarnation/age checks, recovery claims and release are unchanged. No production timeout, stale-age, SQLite qualification, dependency or public interface changed. The historical CI timeout cause remains unresolved; this fixes a separately demonstrated occupied-path cost, not a claimed reproduction of the historical event.

Identical focused test: original production **1 pass / 7 expected fail**; corrected **8 pass / 0 fail**. The dead owner comes from a real maintenance-lock child self-SIGKILL; native death probes and durable operations remain real. Synthetic101ms candidate cost is a deterministic policy test, not measured latency. Native atomic EEXIST race control passes both. Adjacent locking **7/0** and exact PREPARED crash-resume **1/0**; typecheck passes. Independent source review found no material blocker. Source and test were frozen read-only and hash-verified before execution.

Parent added an explicit installed-package PREPARED SIGKILL/journal/PID/resumeREADY/export/lock-release check to the existing committed packaged harness. Its execution awaits the certified build. New direct lock tests run in a fresh Bun process with all assertions retained. This provides the same native environment as the focused proof; it is not evidence that group0 would fail. Prior CLI/concurrent fixture corrections remain unchanged.

## Pending final gates

Full corrected local npm test → typecheck → certified build is running. First launch omitted Bun from PATH and exited127 before any test; exact failed launch retained separately, corrected invocation uses the actual installed Bun path without source change. New required [CI41791701869](https://github.com/rynfar/meridian/actions/runs/41791701869) is running against the corrected head. No merge before both required/local gates, independently installed package acceptance and final review pass.

Old required CI failure and the one-shot diagnostic pass remain separate, durable and unwaived. No second lock diagnostic. #1505 and #1220 remain unmerged. Final-source live E41 qualification follows accepted supporting fixes on matched artifacts with every existing exact-model/95%/history/plugin/join assertion unchanged; no prompt change or green-seeking retry. Missing historical causal/scope evidence remains an explicit acceptance decision, not proof inferred from prospective passes.

[Focused proof, sources, reviews, failure launch and receipts](focused-proof.tar.gz) ([per-member hashes](focused-proof-manifest.json)). Full in-progress logs will be escrowed on completion.
