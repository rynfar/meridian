# Static diagnosis: bookkeeping CLI build / source fingerprint

Date: 2026-11-03. Target supplied by parent: `/Volumes/DevSSD/meridian/fix-explicit-model-fallback-20261103`, head `93b188f6` (not independently rechecked). Evidence: `/Volumes/DevSSD/meridian/explicit-model-fallback-20261103-validation/full-npm-test-final.log`.

## Result

The failure is real build certification refusal, but the log does not establish a production fingerprint algorithm defect, oversized inclusion, or a test-only timing failure. The shortest safe test-layer change is to stop making bookkeeping behavior tests invoke the entire certified application build. That change does **not** explain away a failing standalone certified build; keep the production build gate and its full-fingerprint requirement unchanged.

No repository edits, commands, tests, model calls, or network requests were performed for this diagnosis. Only the named log, the fingerprint/build modules, bookkeeping test/support/entrypoint, the directly referenced build scripts/config, and the existing observer were read. This report is the only written file. Constants changed: none.

## Established from code and log

- `bookkeeping-cli.test.ts:17–20` runs `npm run build` synchronously in `beforeAll` (180s subprocess timeout). This is an unrelated application-wide dependency before any bookkeeping assertion. The recorded hook fails after 15.66s because the build exits 1, not because its 180s timeout expires.
- `scripts/build.ts` performs **three independent source snapshots**: preflight in `canCertifyBuild` (line 31), pre-gates in `certifyBuild` (`buildArtifacts.ts:81`), and post-gates (`buildArtifacts.ts:88`). Each gets its own original 2s budget. The 15.66s hook duration is not the fingerprint budget duration.
- The stack is specifically the **post-gates source snapshot**, line 88. Preflight and pre-gates snapshots therefore completed. Bundling, declaration generation, export repairs, and Node entrypoint checks returned successfully before this failure. Artifact inventory/certification publication had not been reached.
- The throw is `budget.consume(read)` at `buildFingerprint.ts:47`, specifically its deadline `check` (line 15), not either byte-limit test. This proves the immediate refusal was deadline exhaustion. It does not establish the number or sizes of included files, and it does not rule out a large-but-under-cap input contributing to the timeout.
- That loop checks the deadline immediately **before** `readSync`, then again in `consume` **before hashing the current chunk**. The failing read crossed the remaining deadline, or the process was descheduled across it. CPU spent hashing earlier chunks or time spent on earlier Git/metadata calls could have left almost no time for this read. The stack alone cannot label that read intrinsically slow or blame hashing CPU for the current chunk.
- The 2s source budget covers Git discovery/status/listing plus per-entry metadata/read/hash work. `readProvenanceText(package.json)` has its own small read budget, but its wall time also passes inside the outer source snapshot. All indexed files plus nonignored untracked files are included, sorted and deduplicated; this is not restricted to production source. Ignored `dist/`, `node_modules/`, logs, and `.evidence/` do not normally enter the untracked list, but an already tracked file remains included even if it matches an ignore rule.
- The inspected build gates write beneath `dist/`, which is ignored. No inspected gate deliberately adds source inputs outside that directory. This is evidence against an obvious build-generated source inclusion, not proof that the input list was unchanged at runtime. A completed changed snapshot would throw `inputs-changed`; this snapshot never completed that comparison.
- The existing `fingerprint-observer.mjs` runs only one standalone `snapshotSource`, has global filesystem counters and up to 50 slow operations, and has not been executed. As written it cannot reproduce the post-build phase, attribute `readSync` to a file, account bytes/hash CPU, or separate Git time. Do not treat its prospective result as a reproduction of this failure.

## One bounded diagnostic build proposed; parent owns execution

Run **one** real build entrypoint under a frozen external preload observer, not another full suite or repeated snapshot loop. The normal native entry is `bun --preload <frozen-observer.mjs> scripts/build.ts`, in the supplied worktree. This executes the same build implementation as `npm run build`; record that the npm wrapper is omitted. Use the parent's handle-owned runner with a 180s hard outer limit and bounded termination/join of the original process group and pipes. Keep every original fingerprint limit, especially 2000ms, unchanged. Preserve exit status and ordinary build stdout/stderr separately.

Prepare the observer outside the repository, freeze its exact bytes into a SHA256-named read-only file, and record the SHA256 **before** execution. Do not edit it after READY. Do not reuse the current standalone observer unchanged.

Required observer metadata (buffered in memory, written once on normal exit/error; no per-read console/file writes):

1. Label each snapshot call `preflight`, `pre-gates`, `post-gates`; record wall time, `process.cpuUsage()` deltas, budget creation/check/entry/consume counts, completed file count, bytes read, and terminal error/operation. Keep artifact inventory distinct if reached.
2. Record each Git invocation's safe operation label, elapsed time, exit/error, and output **byte/count lengths only**. Never log status contents or file contents. Record `ls-files` entry count and total bytes; compare its returned list between snapshots in memory, emitting only added/removed relative paths and counts.
3. For every included regular file: repository-relative path, indexed/untracked classification if available without another Git pass, stat size, cumulative read bytes/chunks, read wall+CPU total and maximum, hash-update wall+CPU total and bytes/update count, plus open/stat/close wall totals. Record the current file and counters before rethrowing a deadline error. Buffer only up to the existing 10,000-entry limit; retain aggregate counters even if detail is capped. Outside-root paths get opaque labels.
4. Separately total `lstat`/symlink handling, Git, reads, hashes, and unattributed wall time. Count observer calls/overhead and report whether all three snapshot boundaries were captured, so missing interception is visible. Reuse the real snapshot/build/hash functions and forward their exact original arguments/results/errors. Do not replace hashing, skip files, increase timeouts, catch-and-accept failures, or log buffers/digests/source text.

A preload can wrap imported module exports using Bun's `spyOn` (the existing observer already uses it), filesystem calls with fd→relative-path tracking, and crypto hash updates. Verify wiring from the resulting boundary/counter metadata; if interception is absent, report the diagnostic invalid rather than interpreting empty counters. This is a proposal, not an already-validated helper.

### Discriminator

- **Unexpected/large inclusion:** identify the exact under-cap large file(s), count/total growth or changed input list. Remove/move only accidental generated/evidence output at its owning layer, or correct its ignore rule if appropriate. Do not omit legitimate tracked/untracked source from certification. Exceeding 64MiB/file, 256MiB total, or 10,000 entries must still refuse certification.
- **Git/metadata time dominates:** optimize only the measured discovery/metadata bottleneck while preserving the same complete input set and before/after comparison. A deadline crossed during reading does not exclude earlier Git cost.
- **Read wall dominates while read CPU is small:** this supports filesystem latency or host scheduling stalls; it does not distinguish those two by itself. Record the phase/file concentration, do not call it a hash CPU bug or certify a prefix. A single passing trace establishes only that execution's margin, not that the earlier failure was fixed.
- **Hash CPU dominates:** an implementation optimization belongs in `buildFingerprint.ts` only if measured and digest-equivalent over the entire ordered input. Do not cache away the post-gates content read or use size/mtime as a substitute for it.
- **Ordinary unchanged input consistently fits outside the broad suite:** reduce the test's unrelated build dependency; do not change the production 2s policy to accommodate test-suite load.

## Smallest correct test-layer fix (recommended independent dependency cleanup)

`bookkeeping-cli.test.ts` exercises the real Node CLI entrypoint and bookkeeping state transitions; none of its assertions inspect provenance, application bundles, plugin packaging, declarations, or build counters. Its entrypoint is only `bin/session-bookkeeping.ts`, which imports `runBookkeepingCli` and sets `process.exitCode`.

Replace that file's full-build `beforeAll` with an async, narrow `Bun.build` of **the real `bin/session-bookkeeping.ts`** into a fresh private temp build directory, `target: "node"`, `external: ["libsql"]`, and a known `.mjs` filename. Provide a node_modules symlink as the existing `buildNodeFixture` pattern does, invoke that fresh path with Node from `cli()`, and clean it in `afterAll`. Keep the state temp directory separate. Do not reuse old `dist`, bundle a test-only substitute entrypoint, or create a skip-certification production build flag. Change assertions' wording from “packaged” if they no longer exercise the installed dist path.

Retain independent packaged-entry/build verification and the mandatory final `npm run build` gate. If preserving literal package-dist coverage is required, keep that coverage in a dedicated build/package flow rather than silently presenting the narrow bundle as packaging evidence. The existing helper resolves only `src/__tests__/fixtures/<name>`; do not misuse it with a fake filename or broaden it unnecessarily just for this one entrypoint.

This adjustment fixes the test's architectural dependency, not an established production bug. A failed standalone certified build remains a material finding requiring its own measured correction. No blind green rerun or unrelated test-isolation PR proves this timeout fixed.
