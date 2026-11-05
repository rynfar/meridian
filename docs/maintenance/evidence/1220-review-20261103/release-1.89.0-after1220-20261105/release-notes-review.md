# Release 1.89.0 notes review — 2026-11-05

## Scope and result

- Candidate before notes edit: `7902c2faeadff82534cf4177fe5b28b2dead7d7f`; release PR #1486, base `41d7b3e3a2ead7e95e2790cc473b469bd3e9b567` (merged contributor PR #1220), from the supplied local PR receipt. No live status refresh was performed in this delegated notes-only review.
- Reviewed the complete supplied `release-range-commits.txt`, `release-version-diff.patch`, and relevant source/doc sections of `full-release-range.diff` plus the candidate's architecture and direct cache regression tests.
- Corrected only candidate `CHANGELOG.md`; no source, version/manifest, dependency, release flag, historical release note, commit, or branch change. This evidence file is the separately authorized review artifact.
- No shell/test execution, model calls, network access, commits, or pushes. Parent retains all final-head CI, test/build, E2E, publication and installed-package gates. Source/test inspection is not an execution pass or proof of release readiness.

## Findings and resolution

1. **Missing release purpose / contributor credit (fixed).** The generated 1.89.0 section omitted original `63f54197` despite the supplied range including it and merge #1220. Added the JSON async lock-wait/filesystem-write benefit, direct #1220 and source-commit links, and explicit [@Nowaker](https://github.com/Nowaker) credit. An old author date may explain the generator omission, but this review did not verify generator/date causality and does not state it as fact.
2. **Cache-clear follow-up missing from generated notes (fixed without repetitive entries).** Folded `5721c3db` (clear repopulated cache entries at store commit) into the existing `67d02f56` eviction note. The note describes those concrete boundaries, not universal cache correctness.
3. **Scope accuracy (checked).** `ARCHITECTURE.md` and `src/proxy/sessionStore.ts` distinguish async JSON lock retry/filesystem writes from synchronous reads, parsing and serialization; SQLite transaction callbacks remain synchronous. The new bullet says this explicitly and makes no async-SQLite claim. Existing #1505 remains about preserving explicitly selected models on refusal fallback, not fixing model refusals.
4. **Existing supported changes (preserved).** Feature #1480, explicit-model support fix #1505 and lock/test-fixture fix #1506 retain their generated text and links unchanged. All notes from 1.88.0 onward remain byte-identical.

## Complete conventional-range coverage

- User-facing feature: `3a700e36` (#1480), preserved.
- Independent fixes: `16c21494` (#1505) and `2297d61e` (#1506), preserved.
- Async JSON writer and safety follow-ups: `63f54197`, `7506dd4c` (own queued inputs / fence revoked publication), `70b77be5` (capture rollback identity before async writes), covered under #1220's bounded JSON writer entry; no separate feature or cache guarantee invented for those implementation safeguards.
- Cache fixes: `5721c3db` and `67d02f56`, grouped in one specific cache bullet.
- Test-only subjects: `1e24a969`, `bb2e18a3`, `826ff5ce`, `8f0b86b8`, `92222508`, `eaee8d82`, `3ea2bf7a`, `8d90e79f`, `82ff117d`, `949fe89f`, `f7aead13`, `27d830a0`, `b1fffe4a`; no extra product claims required.
- Documentation/chore: `697f9482`, `bf91d7ad`, `0961dacb`; no additional user-facing change omitted. Remaining range entries are merges and do not create separate release claims.

## Internal validation

- Exact unique replacement succeeded; read-back equals the expected single replacement.
- All earlier release sections byte-identical; #1480/#1505/#1506 text and links retained.
- Changed section has no trailing whitespace; new links use existing GitHub PR/commit/profile URL forms. Links were checked structurally, not fetched.
- No assumptions about universal event-loop responsiveness, universal cache hits, refusal resolution, or asynchronous SQLite behavior were added. No constants changed.
- Final `CHANGELOG.md` SHA256: `4a55e192dae814ef797e17cd53f105f615e86d8a0a10a93a893fcc9148b5e0a2`.

## Exact delta

```diff
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -12,7 +12,8 @@
 
 * avoid occupied store-lock writes and isolate native test fixtures ([#1506](https://github.com/rynfar/meridian/issues/1506)) ([2297d61](https://github.com/rynfar/meridian/commit/2297d61e4f157ad6448dc787c64849f565f4377f))
 * keep explicit models on refusal fallback ([#1505](https://github.com/rynfar/meridian/issues/1505)) ([16c2149](https://github.com/rynfar/meridian/commit/16c214941bf3f05aa4015a70d8b81bd94857a88f))
-* **session:** invalidate evicted JSON cache after durable commit ([67d02f5](https://github.com/rynfar/meridian/commit/67d02f56ba69b7e738aea67119ba5b1376ef0db0))
+* **session:** make JSON session-store lock waits and durable filesystem writes asynchronous to reduce stalls for other requests; reads, parsing and serialization remain synchronous ([#1220](https://github.com/rynfar/meridian/pull/1220)) ([63f5419](https://github.com/rynfar/meridian/commit/63f54197)); thanks to [@Nowaker](https://github.com/Nowaker).
+* **session:** clear repopulated cache entries at the durable cleanup boundary and invalidate evicted JSON cache entries after durable commit ([5721c3d](https://github.com/rynfar/meridian/commit/5721c3db)) ([67d02f5](https://github.com/rynfar/meridian/commit/67d02f56ba69b7e738aea67119ba5b1376ef0db0))
 
 ## [1.88.0](https://github.com/rynfar/meridian/compare/meridian-v1.87.0...meridian-v1.88.0) (2026-11-02)
 
```
