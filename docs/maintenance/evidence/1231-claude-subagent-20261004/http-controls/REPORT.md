# #1231 credentialless HTTP regression controls

Owned repository change: `src/__tests__/claude-subagent-isolation.test.ts` only.
No native calls, credential discovery/refresh, full suite, typecheck, build, push, PR, merge, or source closure was performed in this lane.

## Exact before/after

Baseline source: `076b249fd55db84ffde546a4f6bf5211efffbf69`, extracted via `git archive` into a separate immutable source directory. The final test file was copied into that snapshot; dependency symlink is read-only. Each process has fresh owned config/Claude/session fixtures and a synthetic API profile with the SDK mocked.

The initial HTTP-lane test SHA-256 is `763458afb412e8aab18140b4ec7db062bf1277836cbb923859fbfe6e2ba0ee22` in both baseline and corrected runs below.

Baseline command: `bun test --timeout 15000 --test-name-pattern 'explicit root cancellation|separates a native agent|replays an unmarked' src/__tests__/claude-subagent-isolation.test.ts`

Baseline result: exit 1, 3 intentional failures, 25 assertions. Root cancellation omitted both native agents and both agent classifiers. Native key collision replaced the unrelated bare-main SDK/transcript mapping. Unmarked legacy collision inherited `previousClaudeSessionId=legacy-unmarked-sdk` after replay. All cleanup assertions completed; these were behavioral failures, not timeouts or stranded queries.

Corrected command: `bun test --timeout 15000 src/__tests__/claude-subagent-isolation.test.ts`

Corrected result: exit 0, 8 tests passed, 144 assertions. All tested production/test file hashes remained unchanged during the final run; exact hashes are in `corrected-focused-manifest.json`. Correction snapshot was dirty atop the baseline source head, not a claim about a final committed/CI head.

## Controls

- Explicit raw-root cancellation: main + two undeclared native Agent turns + three official classifier calls abort; unrelated seventh held request survives. Exact request-ID census, permit and registry cleanup, and freed turn leases are checked.
- Main request-signal and streaming-body aborts: main classifier plus declared raw-main child/grandchild abort; undeclared native agents and their classifier survive and finish normally.
- Scoped agent cancellation: own auxiliary self-abort is a private leaf; explicit scoped cancel reaches only own agent/auxiliary. Main/sibling durable mappings remain byte-equivalent, interrupted own mapping is evicted, restarted agent replays fresh.
- Ordinary arbitrary raw main ID resumes its unmarked legacy checkpoint. SDK `resume`/`resumeSessionAt` are asserted; a managed checkpoint fork publishes the returned SDK ID while retaining previous lineage.
- Bare main ID equal to the old `<root>:agent:<id>` string has separate mapping and concurrent turn lease from the native Agent; each later turn resumes its own SDK history.
- Agent auxiliary checkpoint refusal recovers independently without borrowing resume/checkpoint authority or modifying main, sibling, or own mapping; normal agent continuation still resumes the intact checkpoint.
- Unmarked mapping occupying a new reserved slot is replayed fresh; previous SDK ID/checkpoint/locator are not adopted, unrelated mapping survives, newly marked mapping resumes.

Every test joins HTTP/mock SDK work and checks SDK active/queued permits, live cancellation registry, and per-proxy in-flight count return to zero. Cleanup is separate from the behavior assertions and can settle a faulty baseline.

## Fixture correction provenance

`fixture-assertion-correction-initial.log` preserves an initial 7-pass/1-fail run whose additional legacy-main assertion incorrectly required a checkpoint resume to publish the old SDK ID. The SDK received the correct old resume ID/checkpoint and returned a managed fork target; that assertion was corrected to require the actual returned SDK ID and retained previous ID. This was a test correction, not a production finding. Earlier baseline logs/manifests are retained as `initial-*`.

Standalone typecheck later caught a missing required index in the synthetic SDK `blockStop()` helper. The committed fixture now calls `blockStop(0)`; production assertions are unchanged. The exact final typed test SHA-256 is `1ac8d3d5266dc2082fa8e6a8c68d7d3aed90c1ec61feb2b3f23c9bbe58743940`. [The same corrected fixture](final-typed-before-after-manifest.json) again reproduces all three defects against a fresh immutable `076b249f` archive (**3 failures / 25 assertions**, joined cleanup) and passes the corrected code (**8 passed / 144 assertions**). [Final typed baseline log](final-typed-http-baseline.log) and [corrected log](final-typed-http-corrected.log) preserve the result; standalone typecheck also passes at `6e7ee9f4`.

## Limits

These controls use mock SDK traffic and do not establish affected native Linux Claude CLI 2.1.287/SDK/model identity, native background overlap, auto-mode interaction, or cancellation acceptance. Native gates remain open. Scoped agent-parent ancestry is not invented: declared `parent_session_id` continues to identify a raw main session, because no emitted native parent-agent identity has been established. This record and the selected sanitized logs are escrowed beside this file in the delivery repository; their original temporary paths are provenance, not the only evidence dependency.
