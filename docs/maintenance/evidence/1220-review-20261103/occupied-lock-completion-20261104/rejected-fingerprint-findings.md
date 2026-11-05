# Fingerprint allocation investigation — rejected proposal

## Outcome

**No certification fix was demonstrated or integrated.** The requested size-capped allocation proposal is rejected. The isolated worktree source was restored to its original content, the untracked test was removed, and the temporary dependency symlink was removed. Nothing was committed, pushed, installed or published. No full suite, application build, model call or repeated old instrumented build diagnostic was run.

- Worktree: `/Volumes/DevSSD/meridian/fix-fingerprint-cost-20261104`
- Branch: `perf/fingerprint-cost-20261104`
- Fresh `origin/main` base/head: `1e24a969cc8aba8c62ad3fcea87a4f3da69c6e52`
- Restored `src/proxy/buildFingerprint.ts` SHA256: `ae10e49aa2c8a216820c899c52e182a6c63e3eaca931d669883e4f4d705b8b83`
- Evidence root: `/Volumes/DevSSD/meridian/evidence/fingerprint-cost-20261104`
- Artifact hashes, exact frozen paths and owned-handle exits: `/Volumes/DevSSD/meridian/evidence/fingerprint-cost-20261104/artifact-manifest.json`

The historical two-second failure remains unexplained. Existing evidence read, not rerun: `/Volumes/DevSSD/meridian/evidence/occupied-lock-completion-20261104/build-certification-preflight.log` records `BuildProvenanceError("invalid")` in `fingerprintBudget.consume` during `hashFileInto` / `snapshotSource`.

## Proposal and deterministic resource evidence

The original code allocates a 64KiB scratch buffer for every regular file. The first proposal changed only that allocation to `Buffer.allocUnsafe(Math.max(1, Math.min(stat.size, 64 * 1024)))`. Its two-second deadline, 64MiB file cap, 256MiB aggregate cap, 10,000-entry cap, content/EOF handling, close/error handling and caches were not changed.

The frozen resource test used real files and intercepted `Buffer.allocUnsafe` requests. Cases were 0, 7, 4,097 and 65,539 bytes. It also checked exact hashes and files growing after `fstat`.

| Frozen test target | Result | Log |
| --- | --- | --- |
| Unchanged baseline | 3 pass / 3 expected allocation failures | `baseline-resource.log` |
| First size-capped proposal | 6 pass | `fixed-resource.log` |
| Repository focused resource + existing budget tests, first proposal | 10 pass / 0 fail | `focused-tests.log` |
| `npm run typecheck`, first proposal | exit 0 | `typecheck.log` |

Baseline requests were 65,536 bytes for each small/empty case. The proposal requested 1, 7 and 4,097 bytes. The large case remained capped at 65,536 bytes. These are real allocation-request observations, not RSS or retained-memory measurements and not evidence of the historical cause.

For the copied benchmark inventory, the one-allocation-per-stable-file calculation was 160,169,984 requested scratch bytes before versus 20,568,012 after (87.16% fewer). This calculation excludes metadata reads and does not describe allocator slab/resident-memory behavior.

### Growing-file finding: rejection was justified

A small initial buffer remains small if a file grows after `fstat`. A stronger deterministic control appended 128KiB after that size check. The floor-1 proposal made **131,073 read attempts** for an initially empty file and **18,727** for an initially seven-byte file. The original 64KiB loop passed a bound of at most 4 and 5 attempts, respectively. The tests count the per-read `budget.check` invocation, including EOF.

This establishes a real resource regression in the proposed optimization, even though its content hash remains complete when it finishes. Under a fixed two-second deadline, it could reject inputs the original loop would hash in time.

After the parent's growth caution, an adaptive candidate was prepared: start size-capped, then allocate the existing 64KiB buffer once observed bytes exceed the original size. Its deterministic controls had already started before the parent's stop instruction arrived. They finished before cleanup:

- `final-resource.log`: adaptive candidate 6 pass.
- `rejected-naive-growth-control.log`: floor-1 proposal 4 pass / 2 growing-file read-count failures.
- `baseline-final-resource.log`: original code 3 pass / 3 allocation-expectation failures; the growing-file controls passed.

The adaptive candidate is **also rejected and not integrated**. No timing or typecheck claim is made for it. Filenames containing `final` are retained custody labels, not acceptance. Its frozen source and tests are listed in the artifact manifest.

## Native comparison: exact scope and limitations

**The inventory root was `/Volumes/DevSSD/meridian/evidence/fingerprint-cost-20261104/corpus`.** It was a new read-only copy on `/Volumes/DevSSD`, **not the original worktree paths and not `/tmp`**. The inventory contained 2,444 regular tracked files / 25,083,508 bytes. It was copied after the first one-line edit, so that source file's changed bytes were included equally for both algorithms; the untracked resource test was excluded.

This was an algorithm-cost comparison, **not** a `snapshotSource` or certification test. It did not run Git, reproduce the original file placement/cache state, enumerate the tree, or preserve the original Git/file environment. It verified every copied file's SHA256 before timing, which warmed the corpus. Each pass used the original two-second budget plus entry accounting, real open/fstat/read/hash/close operations and identical path/content inputs. All passes completed all 2,444 files and returned the same digest:

`ef23ae45677d592a7515d87754cf9fe14557b2ac758bdd9eb2d893a14d1287c7`

Platform: macOS Darwin 25.6.0, arm64, Apple M5 Pro; native Bun 1.3.14 at `/Users/rynfar/.bun/bin/bun`. One warmup per variant preceded six pairs with alternating order. No allocation/read instrumentation was added to timed passes.

| Pair | Order | Baseline ms | Size-capped ms |
| --- | --- | ---: | ---: |
| 0 | baseline → proposal | 110.6635 | 81.8724 |
| 1 | proposal → baseline | 74.7318 | 61.6587 |
| 2 | baseline → proposal | 55.3597 | 52.1645 |
| 3 | proposal → baseline | 47.3354 | 46.9827 |
| 4 | baseline → proposal | 44.3088 | 56.7282 |
| 5 | proposal → baseline | 58.8466 | 55.6132 |
| **Median** | | **57.1032** | **56.1707** |

The roughly 0.93ms median difference is not a persuasive fix for the two-second certification gate. The ranges overlap and one pair was slower. These samples do **not** establish historical causation, a reliable speedup, or guaranteed two-second fit. The adaptive candidate was not benchmarked. No comparator rerun was performed.

- Raw native records: `/Volumes/DevSSD/meridian/evidence/fingerprint-cost-20261104/native-comparison.jsonl`
- Native stderr: `/Volumes/DevSSD/meridian/evidence/fingerprint-cost-20261104/native-comparison.stderr` (empty)
- Frozen helper: `/Volumes/DevSSD/meridian/evidence/fingerprint-cost-20261104/frozen/native-comparison-8b974f39e7faaf026900bdc55cbb30bcbc0a1f5aa111db6be942987dc22e3ca5.mjs`
- Frozen inventory manifest: `/Volumes/DevSSD/meridian/evidence/fingerprint-cost-20261104/frozen/corpus-manifest-46cd09dfc99502084e0901fdc5a003080ee7dae4f1e7a1e2f48711c9d5d0399e.json`
- Baseline source: `/Volumes/DevSSD/meridian/evidence/fingerprint-cost-20261104/frozen/baseline-buildFingerprint-ae10e49aa2c8a216820c899c52e182a6c63e3eaca931d669883e4f4d705b8b83.ts`
- First proposal source: `/Volumes/DevSSD/meridian/evidence/fingerprint-cost-20261104/frozen/fixed-buildFingerprint-4f3b43127b7da5d04cab19b459fe40b18dc9c32b1101f1bddea385061714be93.ts`
- Rejected adaptive source: `/Volumes/DevSSD/meridian/evidence/fingerprint-cost-20261104/frozen/final-buildFingerprint-a8c01473c5eba083d20b69bc90eb6908308a405b837afc2e7694af54b293b184.ts`

The helper and its imported source copies were hash-named, made read-only and SHA256-verified before execution. The native comparison used one owned shell handle (PID 70430) and completed with exit 0 in 1.031s. It had the unchanged per-pass two-second guards but **no external outer watchdog**: the parent's explicit outer-deadline follow-up arrived after that run completed. This is preserved as a limitation, not silently repaired by another run. Later focused/typecheck/control commands used explicit 60s/120s outer deadlines with TERM then KILL escalation.

## Stop and custody

All eight owned test/benchmark/typecheck handles have final results in the artifact manifest. The expected nonzero controls are preserved; there are no running handles owned by this investigation. The final three deterministic controls were launched before the stop message and had already settled when collected. No new runtime program was started after that stop.

No production constant was changed in the retained worktree. The working assumption that per-file 64KiB allocation was a useful place to inspect proved useful only for resource accounting; it did not justify a certification correction. Missing acceptance evidence remains explicit: the actual affected worktree/Git snapshot and the parent's next normal certified build at a combined corrected head were not run by this worker.
