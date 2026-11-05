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
- [Final local gate](final-local-receipt.json):27 processes,8819pass/65skip/0fail,
  typecheck PASS and certified build PASS, combined1015.51s/exit0.
  Exact [test](full-npm-test.log.gz), [typecheck](typecheck-final.log.gz),
  [build](build-final.log.gz) logs preserved.
- [Final-head hosted CI](final-head-ci-failed.json) **test FAIL** at
  run41718313625/job126204064158: group0 8305pass/28skip/1fail;
  SIGKILL migration2/1 PREPARED resume cannot acquire sessions.json.lock within
  unchanged100ms bound. [Complete hosted log](ci-test-failed.log.gz),
  [exact failure excerpt](ci-failure-excerpt.txt). Other groups never ran.
  Failure is post-kill parent migration, not expected snapshot; native child
  SIGKILL/status assertions passed. Exact deadline consumption/dead-owner cause
  remains unobserved. No blind retry, timeout change or merge.
  No live model call for test-only changes.

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

## Bounded hosted failure diagnosis

[Independent static report](fixture-ci-crash-findings.md) localizes the failure
but finds no justified source correction. The resume uses explicit100ms/0stale,
not environment timeout values. Throw atstore512 is after a failed publication
and expired deadline, before the next recovery attempt; it does not establish
which iteration, whether death probing ran, or why recovery was refused. Candidate
publication/fsync/scheduling and fail-closed dead-owner/age checks remain distinct
unobserved possibilities. Bounded earlier-test clock/host/incarnation scan found
no concrete leaked mock; it does not rule out all contamination.

No native operation timing, childPID/incarnation/lockmtime or failure state was
retained by this hosted run, and cleanup removed the fixture. Diagnosis stops:
no speculative correction or green retry is justified. Any new diagnostic run
requires a separately approved bounded plan retaining failure state and original
native timing/probe observations, unchanged100ms/death/engine/assertion gates.
#1506, #1505 and #1220 remain unmerged; release is not authorized by this result.

[Hosted tested merge tree](ci-tested-tree.json) is fetched and equals the reviewed
feature tree; parents match the reviewed base/head. The failure excerpt normalizes
trailing whitespace only; compressed full hosted log retains exact bytes.
