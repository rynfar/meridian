## Summary
- Run the six bookkeeping store-contract tests in their own Bun process, using the existing `npm test` isolation pattern.
- Keep every test, assertion, 30-second deadline and runtime source unchanged. No dependency, lockfile, version or Nix hash change.

## Why
The authorized 1.89.0 release's unchanged final-head local suite failed closed: 8293 pass / 65 skipped / 1 fail. Migration saw a live `session-gc.json.lock.candidate-*` while its fixture attested writers stopped. Exact-head hosted CI was green.

A deterministic actual-source control proves that an unjoined opportunistic GC with omitted `storeDir` can follow the process-global test-directory override across awaits. Same-process migration correctly refuses a held foreign candidate; an independently invoked unchanged contract file passes 6/0 while that candidate remains held; after joining the GC, same-process migration succeeds. The original sweep's caller remains unproven. Unchanged isolated/pair controls (6/0, 10/0 and 29/0) do not explain away the original failure.

This fixes test ownership at the existing process boundary instead of weakening migration's live-residue refusal, mutating production GC, or masking assertions. The contract tests exercise global backend/directory changes and an offline-only migration.

## Validation / adversarial review
- Frozen deterministic held-candidate negative control: 1 pass / 0 fail, 5 assertions; same-process refusal, concurrent child contract 6/0, and post-join migration READY.
- Static parsed-package comparison: only the bulk exclusion and one explicit unchanged contract invocation are added; all prior commands remain in order.
- Full `npm test`, standalone typecheck/build and final-head CI pending on this PR. Release publication remains paused.
- Durable evidence: `docs/maintenance/evidence/1220-review-20261103/release-1.89.0-after1220-20261105/` on evidence draft #1500; exact frozen helper and logs being escrowed there.

No runtime/product behavior or public contract is changed. No live model call is needed to prove this test-process change. No constants changed.
