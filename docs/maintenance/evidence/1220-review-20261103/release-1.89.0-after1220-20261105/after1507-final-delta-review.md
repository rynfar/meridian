# Meridian 1.89.0 / #1486 — final delta after #1507

2026-11-05. **No concrete material defect found in this bounded final-delta review.** The candidate preserves the previously reviewed product source and corrected release notes. #1507 changes test-process isolation only. This is a static delta review, not a test run, live-flow qualification, publication approval, or waiver of remaining gates. No newly discovered product defect justifies an expanded test matrix.

## Exact inputs and method

| Role | Commit | Tree |
| --- | --- | --- |
| Final candidate | `f4c1dcbcfd8c2d01cfd3c4eaa49479c25560aef2` | `6addd303a448894714a97675bfc87a9f307d53fd` |
| Previously qualified release | `e6c5604309fb9aa870e1200321cde4e1072aa3c8` | `2ecd01440dc2f8f81830ae44a29e15c1d4ef7018` |
| Supplied post-#1507 main | `cafdcf780f1b40c8f0dee17481132f47b4cbb353` | `360f5e0b02016e75a8eaf5ff640251403014f492` |

Candidate worktree: `/Users/rynfar/Library/Caches/meridian-validation.noindex/release-1.89.0-after1507-20261105`. Prior release worktree: `/Users/rynfar/Library/Caches/meridian-validation.noindex/release-1.89.0-after1220-20261105`.

Used Python file reads and standard-library decoding of local Git objects; compared the exact supplied commit trees rather than assuming the owner's checkout represents supplied main. Verified object hashes and reconstructed both release index trees. All **2,447 tracked paths** in each release worktree match its index and supplied commit tree. No commands, network, model calls, project imports, credential access, source edits, or constant changes. This report is the only new file. Live GitHub freshness and authorization remain parent-owned assumptions.

## Final delta and regression review

### Compared with the prior corrected release

Exactly **one tracked file differs: `package.json`**. Its `scripts.test` string has exactly two insertions:

1. `--path-ignore-patterns '**/*bookkeeping-store-contract*'` removes that suite from the shared Bun process.
2. `&& bun test --timeout 30000 src/__tests__/bookkeeping-store-contract.test.ts` invokes the same existing suite in its own process.

Removing these two insertions yields the prior test command byte-for-byte. The separate invocation is joined with `&&`, so its failure still fails `npm test`. No test source/assertion, timeout, `pretest` typecheck, other script, product file, dependency, packaging setting, version field, or documentation changes. Inspection of the existing contract suite confirms it uses process-global session-store/native bookkeeping state and performs CLI fixture work; separating its process is consistent with the existing isolation approach, not a production behavior workaround or a skipped suite.

`CHANGELOG.md` is byte-identical to the prior corrected release, including the accurate #1220 description and **@Nowaker credit**. Full-file SHA256: `4a55e192dae814ef797e17cd53f105f615e86d8a0a10a93a893fcc9148b5e0a2`. The note says JSON lock waits and durable filesystem writes are asynchronous while reads, parsing and serialization remain synchronous. It does not claim universal asynchronous I/O, an E41 pass, or resolved provider failures.

All source, tests, scripts, docs, plugin/client code, desktop code, Nix files and lockfiles are otherwise identical. Thus the complete original-tag-range review in [full-range-final-review.md](full-range-final-review.md) remains the product-source review; this report does not reopen that range.

### Compared with supplied main

Exactly **four tracked files differ**, all release metadata:

- `.release-please-manifest.json`: `1.88.0` → `1.89.0`.
- `package.json`: version only; its full scripts and remaining fields equal main.
- `package-lock.json`: only the top-level and root-package versions change to `1.89.0`.
- `CHANGELOG.md`: the 1.89.0 section is prepended; older notes are unchanged.

The manifest, package and both lockfile version fields agree at **1.89.0**. Dependency declarations, resolved packages and integrities are unchanged. Root-tree comparison proves all other files/subtrees identical to main, including production source, tests, scripts, docs and packaging configuration. No new API, adapter, session lifecycle, cancellation, persistence, credential or unsupported-platform behavior is introduced by this release-only delta. No hidden runtime change or material notes regression was found.

## Evidence boundaries preserved

No new execution evidence was produced here. Final-head local checks, required CI including `test`, artifact identity/installed-package checks and normal exact-head release handling remain parent-owned gates. Existing earlier receipts must retain their exact tested-head and environment qualifications; source identity does not turn an unrun flow into a pass.

The prior full-range review's unqualified live coverage remains explicitly unqualified: real-client/model stop shapes and signed-priority limitations; concurrent transcript publication; E71/E72 controls; E41 modes/cache floor and awaited-clear behavior; and relevant E42 pinned-host/plugin evidence. Existing #1220 owner-accepted residual verification risk is not an E41 PASS and does not silently qualify other missing flows. No expanded matrix was run or requested by this delta review.

The retained `candidate-actualclient-blocked-receipt.json` is for the prior corrected head and records **BLOCKED_BEFORE_MODEL**, usage endpoint **HTTP 429**, **zero model calls**, zero refresh calls and zero credential writes. The final-head freeze retains `liveActualClient: NOTRUNHTTP429`. Actual-client live qualification is therefore **NOT RUN / blocked**, not successful and not a credentials diagnosis. No new attempt was made here. Publication and fresh registry-installed affected-flow success are not established by this review.

## Disposition

**Final delta reviewed; no material finding requiring a correction.** Preserve the existing disclosed live-coverage limits and 429 non-run status in the release decision. Report frozen after writing; follow-up changes, if needed, require a new review/addendum rather than treating unseen content as reviewed.
