# #1553: Oh My Pi side calls answered from an unpublished fork

Live runs on 2026-11-16, Linux x64, Node 24.22.3, omp 18.20.3, Claude Code
2.1.316, model `opus` (`claude-opus-5-5`). Each run used an isolated Meridian
on port 3791 or 3792 with its own `MERIDIAN_CONFIG_DIR` and
`MERIDIAN_SESSION_DIR` and `MERIDIAN_CREDENTIALS_READONLY=1`, driven by
`node scripts/e2e-omp-side-call.mjs --omp=<omp> --agent-dir=<dir> --log=<log> --model=opus --expect=<fork|auxiliary>`
(see `E2E.md`, *Oh My Pi side calls*).

## Retained raw records (head `59568fb1`)

- [after-harness.log](after-harness.log): the harness output, `PASS (fork)`.
- [after-meridian-requests.log](after-meridian-requests.log): Meridian's
  request and usage lines for the conversation's three requests, copied from
  that run's log (message summaries and SDK queue counters removed).

The side call `6a7418eb` is logged as `lineage=continuation session=21cabaca
auxiliary=fork` and read 15k cache tokens while writing 125. The second turn
`c8a6f1f9` was logged before the side call's usage line, so it started while
the fork was still answering; it resumed the same session `21cabaca` (the side
call published nothing) and read 15k, wrote 63.

## Earlier runs (reconstructed, raw logs not retained)

The scratch logs of these runs were deleted after the session; the values below
were copied from the harness and log output shown during it.

| Run | Head | Side call | Side cache read / write | Second turn |
|---|---|---|---|---|
| Before: fresh-replay side calls | `0bdbbacf` (previous PR head) | `68601c71`, `diverged=independent-request:auxiliary-request` | 14k / 2k | `continuation`, `PASS (auxiliary)` |
| First fork build, source leased | working tree | `64a9e376`, `auxiliary=fork` | 15k / 123 | failed: `transcript … already has an active SDK writer` |
| Fork build, target-only lease | working tree | `54a7a1f3`, `auxiliary=fork` | 15k / 121 | `continuation`, same session, started during the fork |
| After the review fixes | working tree = `59568fb1` | `98bf6ebd`, `auxiliary=fork` | 15k / 124 | `continuation`, same session |

The second row is the failure the live run found: every SDK attempt took an
exclusive writer lease on both the fork source and target, so a side call's
fork and the conversation's next turn could not run at the same time. The
fork now leases its target only. The HTTP test *let the conversation's next
turn run while a side call's fork is still answering* covers it: with the
source back in the fork's lease set it fails, and it passes without it.

In this five-message conversation the fresh replay wrote 2k; it writes the
whole history, so on long conversations the difference grows with it.

## Local gates (head `59568fb1`)

`npm test`: 8,491 pass, 4 fail. The 4 are the real-Node bookkeeping tests that
need Node 22 (`bookkeeping-lifecycle-deletion`, `-publication`), the known
failures on this Node 24 host. `npm run typecheck` and `npm run build` pass.
