# Resumed verification — 2026-11-03 19:53 UTC

## 20:35 UTC update

Test-only #1504 is **merged** at `1e24a969cc8aba8c62ad3fcea87a4f3da69c6e52` after all26 local
suite groups pass (8819pass/65skip/0fail), typecheck/build and final-head CI.
The signed landed tree equals the reviewed tree. It does not change production
code or establish the exact historical failure causes. #1505 now includes that
test-only main through an additive merge at `93b188f68d9664c46df62aa3249b4defffd884af`;
its product source is unchanged and its final suite/CI are running. #1220 remains
unmerged, its E41 matrix halted, and release authorization remains conditional.

This supplements the earlier checkpoint. #1220 is still **unmerged** at
`67d02f56ba69b7e738aea67119ba5b1376ef0db0`; main remains `697f9482`.
No release, historical acceptance-gate supersession or external comment occurred.

## Qualified v2 E41 attempts

All runs used the same immutable observer SHA256
`3dee3502128271672a68cb074205f9cc06d2b45572a955511008c1490100f4ff`.
The unchanged committed E41 protocol fixture loads the generation-matching
Meridian V1 plugin and server scrub0.3.0. It is **not an OpenCode executable run**.
The earlier independently installed actual OpenCode1.18.34 run remains separate.
SDK0.2.141, Darwin arm64, Bun1.3.14/Node22.22.3, included usage only,
access-only read-only grant, no refresh/write, Extra Usage disabled.

| Source / native / setting | Result |
| --- | --- |
| Main /2.1.284 /default | FAIL: query2 starts twice on5.5, then4.8; strict model guard stops. |
| Main /2.1.296 /default | PASS: exact5.5, cache, history, batching, forks, follow-up and joined children. |
| Candidate /2.1.296 /default | FAIL: query1 starts on5.5, then supported history exposes4.8; matrix stops. |
| Candidate /2.1.296 /no refusal model switching | PASS chainJSON: all original predicates and exact5.5, valid observer, joined children. |
| Main /2.1.296 /same no-switch setting | FAIL: query4 native refusal on5.5; no substitution; valid observer, all children/pipes joined. |

The last two arms use test-only
`CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1`, pinned to the installed native's
static feature predicate. It blocks alternate-model refusal fallback, not the
refusal itself or same-model retry. It is an internal capability, not a claimed
stable public CLI interface. SDK `fallbackModel` is separate and untouched.
No next matrix arm or green retry was launched after the failed paired control.

The five model messages in the passing candidate arm report native cache reads
763,2951,3079,3207,3335. The first creates2188, so its published prefix is2951;
the next reads exactly2951. Subsequent reads include the preceding published
prefix in full. These are **native per-message** counters, not inflated HTTP
aggregate totals. The original fixture's unchanged95% floor also passes.
The baseline's first three messages match those usage values, then refusal
prevents completion. This is not a completed paired matrix.

These observations establish model drift and a working no-switch setting,
**not** the exact trigger of earlier drift: v2 did not retain native fallback
notices. No causal async-store regression is inferred. The historical3332→3132
residual, fingerprint stall and initializer[0,1] causes remain unresolved.
No prospective criteria have been accepted as replacements by the owner.

## Independent fixes

- [#1504](https://github.com/rynfar/meridian/pull/1504), signed head`e1413322`:
  synthetic Antigravity fixtures launch through explicit Node argv; readiness
  failures abort/join before root deletion. Production untouched, original
  deadlines/readiness counts unchanged. Exact frozen focused41/0/167 assertions,
  typecheck/build and independent final-hash review pass. Exact-head CI test
  passes. Local full suite exits1: group0 has8270pass/65skip/1fail,
  8336tests/485files in736.83s. All Antigravity probes pass; the unchanged
  source-recovery timing fixture fails. Groups1–25 do not run. A deterministic
  test-only deadline fixture is under review; no deadline is increased.
- Separate explicit-model refusal-switch fix under review: existing per-request
  version pins add the no-switch flag; aliases and same-model retry stay as-is.
  No contributor commits are carried into either maintainer branch. Its unit
  tests and native static evidence do not substitute for actual affected-flow
  live validation, full suite or final CI.

## Custody

[proof.tar.gz](proof.tar.gz) contains metadata-only worker/supervisor reports,
original qualified verdicts, invocation/status receipts, quota admission and the
exact frozen observer. [manifest.json](manifest.json) records every byte/hash;
the archive was reopened and every member verified. No grant, native binary,
raw SDK transcript, raw client output or private conversation is included.
The [acceptance plan](acceptance-plan.md) retains explicit limits and owner gates.

Next: finish the two independent fixes and their required gates; keep the E41
matrix halted unless a specific new discriminator justifies a separately declared
attempt. No merge or release follows from this checkpoint.
