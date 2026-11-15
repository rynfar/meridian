# Parallel-call continuation: upstream port evidence

## Scope and provenance

Baseline: upstream `a4b0f8b592f842a135af3e4c73f09886b2b3ef57` (1.91.0).
The port preserves the fork's first-fragment hybrid design from `c2b7a0a1`
and its non-native-image fail-closed gate from `aebca07f`.

Prerequisites carried from the fork: `4a362bdf`, `096780ff`, `e1c37ba4`,
`e07c2eb0`, `dd5badbc`, `c810a48b`, `27c03fdb` and `fe2e389e`.
These establish canonical checkpoint settlement, capture proof, exact visible
batch publication, safe replay for unproved/legacy checkpoints, and their
regression probes. Only streaming-attempt isolation and matching tests from
`041c3752` are included: failed attempts must not supply a later attempt's
checkpoint proof. Its unrelated thinking/replay-budget changes are excluded.
Upstream's newer SDK-owned prefixed ToolSearch filtering is preserved, including
in the newly added observation paths. No dependencies or public API change.

Original authors, author dates and commit messages are preserved for the
ported commits. Conflict resolutions preserve upstream-only behavior. Historical
fork investigation records are not imported: this portable record contains only
synthetic fixture outcomes and aggregate evidence, not private operational
paths or journal excerpts. The separate JSON-forwarding and cache-gate work
are not integrated. This work opens a PR only, not an upstream merge or release.

## Reproduction

Linux x86_64, Bun 1.3.14, Agent SDK 0.2.141, native Claude Code 2.1.322.
The committed harness uses real Meridian HTTP handling, SDK and CLI with a
scripted loopback Anthropic API, isolated HOME/config/session state and a dummy
key. No installed service or live model is used. Set `CLI` to the executable
for that CLI version and `BASELINE` to unchanged baseline sources with the
baseline's frozen-lockfile dependencies installed:

```sh
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude="$CLI" --source-root="$BASELINE" --observe-upstream --captured --calls=2
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude="$CLI" --source-root="$BASELINE" --observe-upstream --captured --calls=3
```

Repeat each with `--follow-on`. All four baseline rows exit 1 on the delivery
assertion, not on a hybrid implementation marker. Every client-visible call
was delivered to the client. Lineage was `continuation`, telemetry reported
resume, and the complete upstream request prefix held. Real result occurrence
counts were `[1,0]` for two calls and `[1,0,0]` for three calls; the CLI
substituted one/two internal-error placeholders. Follow-on requests retained
those losses even while their own results arrived and lineage/prefix held:

| Baseline sequence | Result occurrence counts at each follow-up | Placeholders |
|---|---|---|
| 2 → 2 → 1 | `[1,0]`; `[1,0,1,1]`; `[1,0,1,1,1]` | 1 throughout |
| 3 → 3 → 1 | `[1,0,0]`; `[1,0,0,1,1,1]`; `[1,0,0,1,1,1,1]` | 2 throughout |

The unmodified fork harness also ran on all four baseline cases, but stopped
at the absent hybrid marker. That result alone is not defect evidence; the
independent observation mode above establishes the actual result loss.

## Fix and limits

Qualified streamed all-captured parallel batches rewind to the first singleton
tool-use fragment. The first result remains a native `tool_result`; subsequent
completed calls/results reuse the existing replay renderers in the same SDK
user input. The original system/tools/message prefix is unchanged. Persisted
hybrid proof distinguishes this safe anchor from legacy last-fragment mappings;
unsafe undo slots are null so an edited hybrid turn replays.

Images in non-native results replay fresh. CLI 2.1.322 can annotate top-level
images and alter following text; passing image-last cases do not qualify the
more general shape. Native first-call images remain eligible. Mixed/uncaptured,
JSON, unstreamed, silent-recovery, ambiguous boundary, legacy multi-call and
incomplete/mismatched-result cases fail closed under the ported safety guards.
The canonical one-call name-dispatch exception stays narrowly bounded.

Prefix comparison ignores cache markers and canonicalizes only equivalent
string/single-text-block content representation. It does not normalize text,
ignore message order, tool definitions or system content. Offline wire checks
prove delivery and content-prefix preservation, not provider billing or model
obedience. The operator reports a deployed fork Pi turn with two parallel
calls followed by `lineage=continuation`, cache read approximately 226k tokens
and cache write 510 tokens. This is fork evidence, not a new upstream live test.

An older SQLite reader rejects the new optional mapping-history field; a
shared-store downgrade needs a compatible export/migration procedure. No live
store was changed. Full replay can lose SDK-only context absent from client
history. JSON missing-call forwarding is separate and is not repaired here.

## Verification

All checks below ran offline on the port. The baseline was archived from the
unchanged upstream commit, using the same SDK version and unchanged lockfile.

| Check | Exit | Result |
|---|---:|---|
| Independent baseline observer: 2/3 calls, each with/without follow-on | 1 each | 4 expected RED delivery assertions |
| Same observer on candidate | 0 each | 4 GREEN; all results once, no placeholders, prefix holds |
| Full fork harness matrix | 0 each | 46 GREEN, including 24 original controls and 22 result-shape rows |
| Focused HTTP/tracker/hybrid helper suites | 0 | 325 pass, 0 fail, 2648 assertions |
| `npm test` (includes pretest typecheck) | 0 | 9110 pass, 28 skip, 0 fail; 50470 assertions, 32 isolated commands |
| `npm run typecheck` | 0 | no diagnostics |
| `npm run build` | 0 | bundled and checked Node entrypoints |
| Harness syntax and whitespace checks | 0 | `node --check`, `git diff --check` |

The 54-row wire run is 4 expected baseline RED + 50 candidate GREEN, with
zero unexpected failures and zero live model calls in every row. The complete
46-row matrix includes two-/three-call capture, follow-on, thinking, deferred
completion, distinct/paced tools, single-call retention, mixed/rejected replay,
JSON/unstreamed controls, error-first/error-later, native-image-first,
non-native-image-later replay, reversed result order and missing-later replay.
Missing results are not fabricated. Follow-on checks retain earlier real
results once as well as checking the current batch.

Two complete full-suite runs passed with the same 9110/28/0 test counts
(50469 and 50470 assertions). Each used a fresh supported-filesystem TMPDIR,
peaked below 1 GiB (119276 and 119264 KiB), and removed it afterward. The 28 existing skips are unavailable
bookkeeping compatibility fixtures and a platform-specific control, not added
exclusions. Three process-global-mock suites run in separate processes using
the existing npm test convention; their assertions still run. No guard bypass.

The first port typecheck/focused run exposed an omitted `streamEvent` fixture
import (308 pass / 4 fail in that focused run); restoring the existing helper
and the attempt-isolation tests corrected it before the final gates. No red
runtime result was accepted as green. The matrix's initial shell wrapper also
misparsed its exit-status expression after all rows finished; an independent
JSON check verified all 54 recorded exit codes and receipts and exited 0.

## Adversarial review and residual gates

Self-review checked client-visible call cardinality versus frozen metadata,
late drain observations, stale-attempt callbacks, canonical result settlement,
legacy mapping read guards, incomplete and duplicate result rejection, error
and image fidelity, hybrid undo replay, JSON/SQLite persistence and clearing,
and upstream-specific SDK ToolSearch filtering. It found and corrected missing
filter arguments in three new observation paths and stale pre-hybrid E2E text.
The focused and full suites and real-CLI matrix above ran after those runtime
corrections. No unrelated fork routing, model catalog, lifecycle-lock,
prior-thinking or replay-budget changes were included. No SDK/CLI patch.

No cross-vendor independent review is claimed: governed reviewer/advisor tools
are not exposed in this engineer session. Opening an unmerged PR is the bounded
publication decision; upstream review and exact-head CI remain required before
landing. Evidence does not establish future CLI versions, provider billing,
actual upstream Pi execution, JSON rejected-call forwarding, or safe downgrade
of an older SQLite reader. The operator's fork live counts are explicitly kept
separate from this task's zero-live-call upstream verification.

Required final-head upstream CI remains a merge gate. No live model calls,
service changes, other PR/issue comments or releases are authorized here.
