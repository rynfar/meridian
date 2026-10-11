# #1211 complete initial harness/evidence review

Reviewed exact frozen `f11e60e5b2480bd76a6d5921b8386f58ae53856c` against authored incorporation `af0fad6318011520d54460dc2f11075e402a1009`. All four assigned paths covered: entire harness, entire new synthetic test, complete E71 changed narrative/table row, entire evidence README. Root accepted H1–H5 and is correcting them; no final head acceptance or artifact-manifest review is claimed.

## Concrete findings

### H1 (P2): Tool-terminal receipt ownership can be borrowed across query rows

`scripts/e2e-claude-code-auto-mode.mjs:83`. Global httpTools Map overwrites by tool ID. All SDK query rows compare against the final aggregate map, so a broken/missing own terminal can borrow another response with the same ID and canonical arguments. Exact per-request adapter matching does not correct this separate receipt map.

Correction: Reject SDK tool IDs reused across different query rows and HTTP IDs repeated across terminals, or correlate ownership explicitly. Retain same-query tools/input/owned outside-write conditions.

Negative: Synthetic two query rows reuse one ID/arguments, second own HTTP terminal omitted; reject despite another valid matching terminal.

### H2 (P2): Malformed SDK result flags accepted as canonical

`scripts/e2e-claude-code-auto-mode.mjs:343`. Observer coerces missing/nonboolean is_error to false; max-turns exception does not require true. Thus success with absent/nonboolean flag or error_max_turns with false/missing flag can qualify with otherwise complete model/usage/tool facts.

Correction: Record valid boolean flag and require success false or error_max_turns true, alongside existing one-turn cap/num-turn/terminal-reason/tool-terminal checks.

Negative: Missing success is_error and false/missing error_max_turns is_error must fail nativeReceipts while valid JSON/SSE max-turns controls stay positive.

### H3 (P1): silent true suppresses actual decision records required by the harness

`scripts/e2e-claude-code-auto-mode.mjs:296`. Actual server.ts:683 sets proxyLogSilent from config.silent; plog at562 suppresses console output, including requestLogLine at2984. Harness console interception receives no real decisions when startProxyServer(silent:true), while synthetic server ignores silent and prints anyway. Native gate would fail all request-decision assertions after costly calls.

Correction: Use silent false within established contained console interception. Synthetic target must assert or honor the real silent behavior so this integration assumption is discriminated.

Negative: Fixture mirrors actual silent contract; corrected harness must supply false. Static direct caller/callee inspection establishes cause; no native query was run.

### H4 (P2): Late result write can mutate a linked target after invariance was asserted

`scripts/e2e-claude-code-auto-mode.mjs:410`. Private real output directory is checked, but existing result filename may be a symlink/hardlink. Final write follows target/grant invariance checks and follows that link, permitting own harness write to destroy a target after proof.targetIdentityUnchanged was true.

Correction: Reserve result as exclusive owned file before any invocation, hold descriptor, validate private regular/single-link ownership and write via that held descriptor; existing output must be rejected.

Negative: Zero-query existing-output symlink (and hardlink where useful) is rejected; unrelated target bytes unchanged. Do not create unsafe links to real owner stores in the test.

### H5 (P2): SSE max-turns receipt accepts missing start/out-of-order terminal frames

`scripts/e2e-claude-code-auto-mode.mjs:167`. Validator separately tracks stopped, reason and closed booleans; it can accept no message_start or message_stop before tool closure/terminal delta. That is not the complete ordered terminal needed by the exception.

Correction: Require message start, closed complete tool blocks before tool_use terminal delta, then message stop; reject subsequent content/tool/error frames. Scope this to bounded necessary receipt order rather than claiming full Anthropic grammar validation.

Negative: Missing message_start and stop-before-tool-closure/delta must fail nativeReceipts while normal JSON/SSE capped-tool receipts remain accepted.

## Complete path/hash coverage

- `scripts/e2e-claude-code-auto-mode.mjs`: 413 lines, SHA256 `3935a61eb9a6d3b447f5bfefe3dde8324dccaf7a5288bdd87c0f6b39119cab6b`. Entire 413-line frozen harness plus actual server plog/silent/request-line caller, SDK options/model/result observability, target package/source/build identities, isolated mutable account, explicit read-only grant, child groups and Linux incarnation/cwd/ancestry census, deadlines/output/body/query/budget limits, dynamic proxy/relay, all four actual-client invocations, request-ID wire-to-decision matching, positive shape/header occurrence, baseline defects and finally cleanup. Five proof/safety findings identified below.

- `src/__tests__/claude-auto-mode-harness.test.ts`: 156 lines, SHA256 `2f3fd3e774c7f711ae5906fd06582a8ef4a358380945fd7ecd6f4266154a2ac0`. Entire 156-line new test and independently generated target/SDK/client/native/grant fixtures. All non-auth tokens are deliberate synthetic literals. Baseline vs fixed expectation, no-classifier, wrong model, borrowed aggregate per-request decisions, missing tool terminal/input, provider refusal, markers only in user, rehearsal/startup generation fence, copy exception, hung client, ignored-TERM child and unresolved-startup retention controls inspected. Synthetic target ignores silent at this head, which hides H3. Initial full pretest union-narrowing failure remains recorded by root.

- `E2E.md`: 7500 lines, SHA256 `7cf16884845ab2248ce01ad011897154361655c1411b3118c65a670d233887c5`. Complete changed E71 table row and complete E71 narrative/historical source qualification through next E73 section; all changed hunks read. Explicit Linux/client/SDK/native/model/grant target inputs, source clean/build certificate, default stream and omitted stops, exact baseline expectations, bounded cost/query/run, cleanup-retention and no raw token/prose/private transcript output, canonical tool-terminal exception and open live gates reviewed. Historical source CLI/model alias separated from current static/runtime proof.

- `docs/maintenance/evidence/1211-claude-auxiliary-20261004/README.md`: 101 lines, SHA256 `7ecb45150395a08450d48aee7991fcd0af444df01012d867949428979952e468`. Complete 101-line README plus linked current source/correction/static/HTTP/recovery records referenced for narrative consistency. Actual authorship/base identities, internal rather than owner/API gate, all F1-F4+adjacent idle preservation controls, mistaken after-capture qualification, actual-model/platform E71/E55/E41 gates open. Root still preparing final manifest/local-gate update; no final-manifest integrity or full-suite acceptance claim.

## Remaining gates and limits

- Read-only review: no source edits, test/suite/model/auth/native client/probes or network/GitHub mutations performed.
- Actual native Linux x64 Claude Code 2.1.286/Sonnet E71 and gateway E55/all four E41 flows remain product acceptance gates.
- Synthetic subprocess HTTP controls assert non-auth fixture marker and acceptance false. They are not actual installed SDK/client/model proof.
- No final artifact manifest review is claimed: it is not yet created/updated. Current README is reviewed narrative only.
- Initial full-suite pretest stopped before tests at typed audit.account guard; no full-suite pass claimed.
- Target/SDK/client/public executable hashes are permissible provenance; credential-file hashes/inode metadata remain memory-only, public result retains unchanged booleans.
- The README internal-identity architecture premise is corroborated in docs/superpowers/specs/2026-04-17-plugin-system-design.md:24; a direct link is planned.
- Native baseline/fixed receipts unavailable; historical contributor alias sonnet and source platform/version logs stay historical, not current corrected acceptance.
