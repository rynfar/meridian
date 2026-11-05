# Fingerprint allocation proposal — independent read-only review

Date: 2026-11-04. Worktree: `/Volumes/DevSSD/meridian/fix-fingerprint-cost-20261104`. Observed starting head: `1e24a969cc8aba8c62ad3fcea87a4f3da69c6e52` (`origin/main` at creation). Evidence root: `/Volumes/DevSSD/meridian/evidence/fingerprint-cost-20261104`.

## Disposition

**NOT demonstrated as a certification fix. Do not integrate this proposal into PR #1506.** The parent rejected the allocation optimization and further comparator execution. This review agrees: resource allocation is reduced, but the one native comparison does not establish a useful improvement to the failing 2s certification path. The first proposal also has a concrete growth-related read amplification regression. The later adaptive proposal is not the source measured by that native comparison.

Final production fingerprint code is unchanged. The parent reports canonical fixture commit `effa8bf33dfe85bfd4975a90cd276a3bab728bb8` and fresh detached validation tree `/Volumes/DevSSD/meridian/validation.noindex/1506-final-20261104` for normal certification with identical source and the unchanged 2s budget. This is a different file environment, not a causal fingerprint fix; the old red evidence remains retained. I did not execute or validate that separate parent-owned run.

The historical timeout cause remains unresolved. Neither this comparison nor a later green build can explain or establish a fix for that failure. A normal build's exit 0 can also be an archive/fallback build rather than a certified build; the parent retains full-suite, certified-build and final-head CI responsibility.

## Exact inspected proposals and preserved boundaries

The benchmarked frozen proposal (`fixed-buildFingerprint-4f3b43127b7da5d04cab19b459fe40b18dc9c32b1101f1bddea385061714be93.ts`) changes only the hash scratch allocation from `Buffer.allocUnsafe(64 * 1024)` to `Buffer.allocUnsafe(Math.max(1, Math.min(stat.size, 64 * 1024)))`.

The later frozen adaptive proposal (`final-buildFingerprint-a8c01473c5eba083d20b69bc90eb6908308a405b837afc2e7694af54b293b184.ts`) also makes the buffer mutable and expands it to 64KiB once actual cumulative bytes exceed the original fstat size. It is preserved evidence, not an approved landing candidate.

Both retain the existing 2000ms deadline, 64MiB/file, 256MiB/operation and 10,000-entry caps; SHA-256; full read-through-EOF; actual-byte accounting; `try/finally` descriptor closure; and failure propagation. No content cache, metadata-only content substitution, source-set filtering, public interface or dependency change appears in these precise diffs. The 1-byte floor avoids treating an initially empty file as immediate EOF. This preserves the existing TOCTOU treatment, not an atomic snapshot guarantee. Metadata-reading code is untouched.

## Resource evidence: real reduction, not proof of the blocker

`baseline-resource.log` runs the same allocation assertions against frozen old code: 3 failures for sizes 0, 7 and 4097 (all request 65,536 bytes), with the multichunk and growth cases passing. `fixed-resource.log` records 6/6 passing against the size-capped proposal. The tests spy on actual `Buffer.allocUnsafe` calls while hashing real files and compare the resulting SHA-256 with complete contents. They distinguish this resource-policy change from the old code; they do not establish that the old allocation size is itself a production defect.

The frozen manifest contains 2,444 tracked regular files, 25,083,508 content bytes and 2,407 files below 64KiB. Summing requested scratch capacities for one stable-file pass gives 160,169,984 bytes before and 20,568,012 after. These are cumulative requested allocation bytes, **not peak resident memory, retained memory, GC cost or demonstrated elapsed-time savings**.

The initial growth tests append only a short string, proving EOF correctness but missing the read-cost regression. The later deterministic control appends 128KiB after fstat: `rejected-naive-growth-control.log` shows 131,073 read attempts for an initially empty file and 18,727 for an initially 7-byte file. Both fail the small read-count bound; the baseline passes the corresponding growth tests. This establishes read amplification. It does not record an actual 2s timeout for that 128KiB fixture. The adaptive proposal's 6/6 pass in `final-resource.log` addresses this control, but does not supply final-source timing or justify adding it to fix certification.

## Native timing: narrow, copied-corpus comparison only

The frozen runner is `native-comparison-8b974f39e7faaf026900bdc55cbb30bcbc0a1f5aa111db6be942987dc22e3ca5.mjs`; manifest is `corpus-manifest-46cd09dfc99502084e0901fdc5a003080ee7dae4f1e7a1e2f48711c9d5d0399e.json`. Hash-named frozen files' SHA-256 values were independently checked by reading their bytes.

The runner uses real Bun 1.3.14 on Darwin 25.6.0 arm64 / Apple M5 Pro. It verifies the copied corpus, warms each implementation once, then alternates order across six measured pairs. All passes complete the same 2,444 files and produce an equal combined digest. The measured baseline median is 57.10ms; proposal median 56.17ms (about 0.93ms / 1.6% lower). Baseline ranges 44.31–110.66ms; proposal 46.98–81.87ms; one pair is slower after the change. This small set and warmup/cache effects do not support a persuasive certification performance claim.

**Exact input root:** `/Volumes/DevSSD/meridian/evidence/fingerprint-cost-20261104/corpus/`, a copied fixed inventory on the DevSSD volume, not the live worktree and not `/tmp`. The manifest says it captured tracked regular files after the allocation edit and excluded the new untracked resource test. This is a valid same-content algorithm comparison, not a complete `snapshotSource` comparison. It omits Git discovery/status/listing, original-file filesystem behavior, source lstat/mode/symlink handling, and build phase context; it pre-reads every file before timing. It cannot establish the full source budget's margin, the parent's current direct-snapshot failure cause, or the older post-build failure cause. The adaptive source was not benchmarked. No additional execution is requested.

## Custody and scope

I read the exact code/test copies, source/artifact callers, existing budget tests, native runner/manifest/logs and prior fingerprint finding. I performed no source edits, application/runtime execution, tests, benchmark execution or network calls. An initial read-only Git status/log inspection established the starting branch/head. This report is my only written file. Constants changed by me: none. The proposals remain rejected; no integration approval is implied by the passing resource controls.
