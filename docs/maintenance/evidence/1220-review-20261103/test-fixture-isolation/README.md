# Test fixture isolation — #1506

Final reviewed source: `c2adc2b5784e9bcd6020193cfcc538883f7695ee`, based on main1e24a969.
Only package test-script and three test files change. No production/dependency
change. All source [hashes](source-hashes.json) match independently reviewed files.

- [CLI findings](bookkeeping-cli-fixture-findings.md): behavior tests bundle the
  real Node CLI privately;25/0 and typecheck pass. First wrong-SQLite run22/3 red
  retained. Real privatebundle/dependency/state-path witnesses and cleanup exist.
- [Concurrent findings](concurrent-fixture-isolation-findings.md): two original
  cases moved to one explicit isolated process, all20 original assertion-lines
  and10s/5s/30s budgets preserved; new complete-sidecar/cwd/env isolation checks.
  Corrected2/0, original11/0, typecheck pass. Initial0/2 red was exact macOS
  path-canonicalization mismatch; only realpath root correction explains rerun.
- [Independent review](test-isolation-adversarial-review.md): no material source
  blocker; actualrealentrypoint, no stale dist, same assertions/deadlines,
  testgroup wiring, ownedsettings/Claude/project/sidecar and finaljoins checked.
- [Exact focused logs, snapshots and manifests](focused-evidence.tar.gz),
  [archive/member hashes](focused-manifest.json), including both red attempts.
- Final local npm test/typecheck/build and exact-head CI running/pending.
  These remain merge gates. No live model call for test-only changes.

The old final #1505 local gate stays red and unwaived. These changes fix actual
test isolation/dependency issues, not the proven cause of either historical
failure. Separate [installed package CLI lifecycle](../local-failure-diagnosis/packaged-cli-lifecycle.json)
passes two cycles; narrow fixture bundling does not claim packaging certification.

## One bounded fingerprint diagnostic

[Immutable helper/limitations](../local-failure-diagnosis/fingerprint-diagnostic/README.md),
[phase summary](../local-failure-diagnosis/fingerprint-diagnostic/summary.json),
[complete metadata trace](../local-failure-diagnosis/fingerprint-diagnostic/build-trace.json.gz),
[supervisor](../local-failure-diagnosis/fingerprint-diagnostic/supervisor-receipt.json).
One native build on unchanged93b188f6, exit0, pipes/processgroup joined, all
required source/Git/fs/hash/budget boundaries observed and nine pure-controls pass.
All three snapshots cover2444 paths and25086036 source bytes, no path delta.
Preflight1943.66ms, pre-gates474.15ms, post-gates1975.25ms; read walls1138.73,
30.07,1327.99ms; Git407.44,241.41,276.51ms. Aggregate CPU535.38,219.81,471.36ms.

This run has broad per-file read-wall accumulation rather than one observed
second-long file or hash. Read wall includes I/O and scheduling; no causal
attribution between them is possible. Metadata can explain this observed run's
cost distribution only; helper changes timing/budget-interface identity, and
neither a green build nor observed counters establish the earlier failed run's
cause or transparent fidelity. Production full2s bound and all input caps unchanged.
No second diagnostic run. Historical initializer/cache/E41 holds unchanged.
