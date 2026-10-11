# Final E71 local gates after explicit artifact-hash narrowing

The source-stable head is `a088de329febb62b147eb4af82f570ccf3b879bc`, tree
`f8cbaa6e8aca90a62157f68dd66a1c3134aa0cca`. The checkout remained clean and
all three maintained source/instruction hashes were unchanged through every
final gate. This packet adds documentation and evidence after that tested head;
its later delivery commit does not change executable inputs.

- `npm test`: **5,431 pass / 36 skip / 0 fail**, **28,123 assertions**, all
  **19 isolated batches**, exit 0. Its initial pretest ran `tsc --noEmit`.
  The optional compiled E71 context control is one of the 36 skips in this
  ordinary full run; it was then explicitly exercised below.
- Standalone `npm run typecheck`: exit 0.
- `npm run build`: exit 0. The fresh [provenance](build-provenance.json)
  certifies clean `a088de32`, counter 2, **409 artifacts**; every artifact
  hash was checked against its output bytes. The maintained build bundles,
  checks declarations and runs Node syntax checks for six entrypoints.
  No native carrier build/load or model call was performed.
- The current source/current certified compiled ownership subset passes
  **2 tests / 72 assertions / 32 filtered**, exit 0. Eight actual target HTTP
  cases use mocked SDK/auth/executable resolution: main/classifier positive
  receipts return 200/200, swapped pins fail both, and missing/duplicate
  ownership fails exactly one request. All generators join and logger
  descriptors restore, with zero external fetch attempts. Compiled receipts
  identify `a088de32` and the actual fresh entry/model module hashes.

Raw logs: [full npm test](npm-test-rerun.log.gz),
[typecheck](typecheck-final.log.gz), [build](build-final.log.gz),
[current target subset](focused-current-artifact.log.gz).
[Result](result.json), [freeze](freeze-rerun.json) and the adjacent per-command
results retain exact commands, timestamps and raw-log hashes. The
[current target receipts and exact archived runners](current-artifact-context/)
retain all eight cases. Reproduce the subset after a certified build with:

```sh
E71_COMPILED_CONTEXT_CONTROL=1 E71_CONTEXT_EVIDENCE_DIR=/owned/private-proof \
  bun test src/__tests__/claude-auto-mode-harness.test.ts \
  --test-name-pattern 'binds actual source|binds existing certified compiled'
```

The first gate on `72b766b4` failed in pretest with TS2769 and ran no suites.
The [separate typed correction](../typed-artifact-hash-correction/REPORT.md)
preserves that failure, the explicit runtime string guard and its causal
source/compiled controls. Both model/hash assertions remain in force.
Root independently verified the guard, all 305 then-current escrow entries,
140 original gzip mappings and five source author/date/subject tuples in the
[typed escrow review](independent-root-typed-escrow-review.json); its SHA256 is
`bee5d1335d04de396851ef517defe8864d0fe12e917a3b469a5d695d8520e9a1`.
That review predates this new final-gate packet.

The earlier 34/1,124 focused run belongs to test `b58d12c7`; its compiled
controls certify historical `80d1ce81`, not this new build. Compiled-skip,
prejoin 33/1,067 and pending-read 34/1,122 receipts remain separately
qualified. The current typed test is `64f2cba2`, script `e2f58e5a` and E71
instructions `f4410422`.

[Runtime identity](runtime-identity.json) records Node v22.22.3 and Bun 1.3.14
as `darwin/arm64`, plus `uname` arm64. The immutable first Python freeze string
reports x86_64; a separate current login-shell Python observation reports
arm64. Neither Python observation nor these synthetic macOS gates establishes
an actual Linux Claude Code/client execution.

Fresh delivery-head CI and actual Linux E71/E55/all-four-E41 model/client
acceptance remain open. Official selector/config/policy/entitlement/probe/
demotion, retry paths and native emitted model/classifier/tool receipts still
require qualified evidence. These successful synthetic gates do not close a source
PR, accept the affected native flow, or authorize a release.
