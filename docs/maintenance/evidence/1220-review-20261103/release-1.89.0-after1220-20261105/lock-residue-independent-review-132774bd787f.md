# Independent review: live lifecycle-lock residue during contract migration

## Finding

The unchanged full local suite failed closed in `bookkeeping-store-contract.test.ts:98`: migration found `session-gc.json.lock.candidate-92039-b7d48221-25ff-4db8-bdb7-562c04dbeb09` still owned by the live suite process. The isolated contract file passing 6/0 does not explain or clear that full-suite failure.

There is a concrete cross-fixture custody gap:

- `src/proxy/server.ts:896` builds `sessionGcOptions` without `storeDir`.
- Managed-request completion starts opportunistic `void sweepSessionGc()` calls (for example lines 5838/5844 and 7300/7306). Consuming an HTTP response does not join those sweeps.
- `src/proxy/sessionLifecycle.ts:1336` resolves an omitted `storeDir` through the mutable global `getSessionStoreDir()`. `runGcOwned` crosses awaits between reconciliation and later deletion claims; each `withSidecarLock` resolves the directory again (line 1408).
- `proxy-session-resume.test.ts:68-70` and `proxy-replay-tool-history.test.ts:34` keep only `app`, discard their proxy cleanup handle, and never await `closeBackend`. Therefore their request-triggered sweeps may remain in flight when another fixture changes the global directory.
- The contract fixture changes that global in `beforeEach` and immediately performs migration after its store mutation. A previous sweep can consequently begin new lifecycle-lock acquisition in the contract fixture's directory.

This is not evidence of a periodic timer in those two fixtures: periodic scheduling belongs to `startProxyServer` (server lines 12394-12397), whereas these fixtures use `createProxyServer` only. `proxy-agent-definitions.test.ts` imports pure agent-definition helpers and does not originate lifecycle work.

## Deterministic discriminating witness

The frozen helper below runs the release worktree's actual lifecycle code on Bun 1.4.3. Its synchronous pin provider switches the global directory after reconciliation has already captured its first lock path. This deliberately controls the same mutable-default boundary without depending on timing, source edits, real SDK calls, or a broad-suite rerun.

Observed lock targets within a single `runGc`:

```
storeDir omitted: first/session-gc.json.lock, second/session-gc.json.lock, second/session-gc.json.lock
storeDir explicit: first/session-gc.json.lock, first/session-gc.json.lock, first/session-gc.json.lock
```

Both cases completed (2 tests, 4 assertions). These assertions establish directory drift with omitted options and its absence with a fixed directory; they do not attribute the historical full-suite candidate to a particular fixture.

Helper: `lock-residue-default-dir-51a0f123f9f6.test.ts`
SHA256: `51a0f123f9f6def505916dc8405ba968b5d6091a5b8f61d564d9d84901f7f471`
Output: `lock-residue-default-dir-witness.log`

## Narrow next action / limits

The shortest actual-suite attribution probes are unchanged `proxy-replay-tool-history + bookkeeping-store-contract` and `proxy-session-resume + bookkeeping-store-contract` runs, with candidate-creation stack/context witnesses if they reproduce. A green pair is not causal disproof: the full suite can add queue depth and scheduling delay. `bookkeeping-proxy-close` uses joined child processes, not same-process proxies; its wall time can delay a pending parent continuation but does not itself establish the lock's caller.

A narrow fixture-custody correction is to retain each app-only proxy and await its `closeBackend()` in `afterEach`, before any directory switch or removal. The production close path already joins `sessionGcRunning` (server line 12218). Add a regression that holds an opportunistic sweep across response completion, verifies cleanup waits for it, then switches the fixture directory and checks that no predecessor lock candidate appears there. Do not relax migration's live-residue refusal, add sleeps, or treat an isolated green rerun as proof.

No source changes were made. No actual originating fixture is attributed. The local full-suite failure remains unresolved; publication remains blocked pending a causal correction and final-head evidence.
