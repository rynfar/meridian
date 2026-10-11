# Claude auxiliary recovery and idle preservation controls

Owned change: `src/__tests__/proxy-claude-auxiliary-recovery.test.ts` only. No production exports, private-map seeding, real credentials, native clients, or model calls were used. Requests go through the actual HTTP route with a synthetic API profile and the established SDK mock. Every request is collected and joined; cancellation signals and deferred SDK attempts are released in teardown and all captured generators must have stopped before temporary stores are removed.

## Results

The incorporated source at `4cd004cce0da93f5028a63e4a770cb10c3a278fa` has unchanged production bytes; other collaborating agents copied regression test changes into that baseline, which the identity JSON lists explicitly. Running this exact final test file there yields 9 passing and 4 failing cases (202 assertions, exit 1). The current corrected worktree yields 13 passing cases (230 assertions, exit 0). These are focused development results, not frozen-head full-suite or native acceptance evidence. The identity JSON records identical test hashes and the baseline/current-report production server hashes.

The four baseline failures demonstrate idle-accounting coupling in both streaming and nonstreaming modes: after three primary stalls, a successful different auxiliary request erases the primary block, and an identical auxiliary request wrongly inherits the primary block before reaching the SDK. The corrected primary retry stays HTTP 400 without another SDK invocation, while successful and repeatedly stalled auxiliaries remain independent. An ordinary successful main turn still resets its own streak. The idle coupling predates the contribution; it is an adjacent preservation correction, not a newly introduced source failure.

The seven tool-recovery cases pass on both the source and corrected worktree. They establish preservation of the contributor's existing safeguards: the mocked CLI streams a complete declared tool call, emits the correlated `No such tool available` refusal, then reaches its maximum-turns failure. The real HTTP recovery path publishes a terminal `tool_use` and creates its one-shot tool-schema grant. No hook or private cache is simulated. Across auxiliary success/failure/cancel with tools omitted or supplied, the auxiliary receives no main read tool or resume, and the original complete tool-result continuation restores the original registered read schema and never the auxiliary write schema. A separate eligible-continuation failure consumes the grant exactly once; its repeated identical continuation has no read tools and no resume, avoiding successful-branch cache inheritance as a false positive.

## Evidence

- `baseline-final-4cd004cc.log`: final identical-test baseline failure and passing preservation controls.
- `focused-final.log`: final corrected focused pass.
- `identities.json`: baseline production unchanged proof, collaborating baseline test changes, and exact test/server SHA-256 identities.

Remaining gates belong to root: coordinated standalone typecheck, full npm test and build, final adversarial review, and the actual implicated native client/model/platform E2E. No live acceptance is claimed here.
