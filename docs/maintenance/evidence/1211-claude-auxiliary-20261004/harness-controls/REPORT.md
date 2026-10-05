# E71 harness correction packet — synthetic verification

Base freeze: `f11e60e5b2480bd76a6d5921b8386f58ae53856c`. Corrections are uncommitted working-tree maintainer changes for the parent to commit. Only the harness, its synthetic tests and E71 instructions were edited.

Final direct process logs: `focused-final-H1-H5.log` reports 19 tests PASS, 0 failures, 501 assertions (34.34s). `typecheck-final-H1-H5.log`, `syntax-final-H1-H5.log`, `docs-final-H1-H5.log` and `diff-final-H1-H5.log` pass. The preceding full-run pretest failure is copied unchanged in `full-pretest-initial.log`; no suite ran there. An explicit runtime guard now narrows the retained-runtime account path without a cast or suppression.

## Material corrections and causal evidence

- H1: SDK tool IDs have one query owner and complete HTTP terminals cannot reuse tool IDs. `H1-H2-before-controls.log` runs the new controls against the exact frozen script (`harness-before-H1-H2.mjs`) and shows duplicate-query receipt borrowing and duplicate HTTP terminals were accepted (expected exit 1, received 0). Both now fail while canonical JSON/SSE controls pass.
- H2: canonical result error flags must be boolean, false for success and true for the narrowly accepted one-turn max-turns result. The same before log shows a missing success error flag was accepted. Final tests reject missing success and false max-turns flags. The before test stops at its first failing loop element; it does not claim a separate before execution of the latter flag case.
- H3: proxy logging is enabled (`silent: false`) and the fixture honors/asserts the actual switch. `H3-H4-before-controls.log` shows the prior switch fails the positive fixture. Console interception suppresses raw logs and keeps only owned per-request facts.
- H4: the report file is exclusively reserved before imports, probes or grant reads; writing uses a verified owned 0600 single-link descriptor. The before log shows the first existing-output symlink target was overwritten by the frozen harness even after setup failed. Final controls reject symlink, hardlink and regular output before queries and preserve target bytes/inode/link count. The before loop stops at its first failing symlink case; it does not claim separate before executions of hardlink/regular cases.
- H5: narrow SSE tool receipt acceptance requires message start, unique block indices, open-block input, closure before terminal delta and ordered message stop. Subsequent content/error fails; ping remains benign. `H5-before-controls.log` runs against `harness-before-H5.mjs` (H1–H4 corrected, ordered receipt check absent) and shows missing-start SSE was accepted. The final test executes missing start, early stop, post-terminal content, duplicate index and input-after-close controls; canonical JSON/SSE remains passing. The before loop stops at missing start.

The historical first SSE failure and subsequent 14-test containment pass were originally observed in tool output but not separately captured as raw process logs. `SSE-initial-observed-tool-excerpt.log` and `focused-14-pass-observed-tool-excerpt.log` label that provenance and the missing original pre-correction file hash explicitly. The observed discrepancy was resolved by snapshotting response status/content type before Bun transfers the original Response; later cloned-body parsing uses that metadata.

## Limits and authority

All generation-shaped activity used independently generated non-auth SDK/client fixtures. Native generation, real OAuth/API calls, SDK transcript reads and global config changes: NONE. All synthetic acceptance flags remain false. Usual synthetic limits: 20 queries, $10 estimated total / $0.50 per query, 10-second total; deadline/retention controls use 500 ms. Owned fixture grant/state and target identities remain invariant. Joined startup/client ignored-TERM and deliberately unjoinable-startup retention controls pass. The independent test controller removes its generated retained fixture after observing retention; this grants no authority over a real retained runtime.

No full suite/build was run by this lane. Actual Linux x64 / implicated Claude Code / target-installed SDK / exact served Sonnet model emitted-wire proof is still required. Static official-client observations and synthetic controls do not establish affected-flow acceptance.

File fingerprints are escrowed in `final-identities-H1-H5.json`; historical test scripts and baseline scripts are retained solely for credentialless reproduction. No grants or generated fake runtime directories are retained.
