# Oh My Pi side calls sent while a turn is in flight fork the session

Live runs on 2026-11-25, Linux x64, Node 24.22.3, omp 19.1.1, Claude Code
2.1.322, model `opus` (`claude-opus-5-5`). Each run used an isolated Meridian
with its own `MERIDIAN_CONFIG_DIR` and `MERIDIAN_SESSION_DIR`,
`MERIDIAN_CREDENTIALS_READONLY=1`, and an omp agent dir whose `models.yml`
points the anthropic provider at it with `x-meridian-agent: pi`.

    node scripts/e2e-omp-side-call-in-flight.mjs --omp=$(command -v omp) \
      --agent-dir=<dir> --log=<meridian log> --model=opus [--expect=replay]

The harness (see `E2E.md`, Oh My Pi side calls) runs a turn that calls one
`sleep` tool, sends side call A through omp's `runEphemeralTurn` when the tool
starts and side call B once the reply after the tool has streamed some text.

| Build | Side call A (tool running) | Side call B (reply streaming) | Next turn |
|---|---|---|---|
| upstream main `d065fb02` (`before-meridian-requests.log`) | `auxiliary=replay:pending-tool`, read 9k, wrote 7k | `auxiliary=replay:pending-tool`, read 16k, wrote 331 | `lineage=continuation` |
| this branch, first head (`after-meridian-requests.log`) | `auxiliary=fork:checkpoint`, read 16k, wrote 251 | `auxiliary=fork:checkpoint+in-flight`, read 16k, wrote 77 | `lineage=continuation` |
| this branch, final head (`final-meridian-requests.log`) | `auxiliary=fork:checkpoint`, read 16k, wrote 270 | `auxiliary=fork:checkpoint+in-flight`, read 16k, wrote 77 | `lineage=continuation` |

On main, B's replay read 16k only because A's replay had just cached the same
prefix; on a long conversation each such replay rewrites the whole history.

The final head adds the review fixes: stricter checkpoint and in-flight
checks, the fork's delta computed once, a `structured-system-note` refusal,
and a harness that requires omp to receive both side answers.

`after-meridian-requests.log` holds two runs. In the first (requests
`5d54139c…`, `7d534511…`, `6a9e681a…`) the hook sent B on the first streaming
update after the tool, before any reply text reached omp's history, so B had
the same shape as A and forked as `checkpoint`; the harness now waits for
streamed text. The second run (`b16689a8…` onwards) is the one in the table.

The logs hold Meridian's request and usage lines for the conversation's
requests only, with the concurrency counters removed. No credentials appear in
them.
