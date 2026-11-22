# Priority routing keeps an Oh My Pi conversation on its account across a restart

Live runs on 2026-11-20, Linux x64, Node 24.22.3, omp 19.0.1, Claude Code
2.1.322, model `opus`, two Claude Max profiles (`mobiwia`, `codecool`).

`node scripts/e2e-priority-restart.mjs --omp=<omp> --profiles=mobiwia,codecool`
starts a built Meridian on port 3791 with its own config and session dirs and
`MERIDIAN_CREDENTIALS_READONLY=1`, priority order `mobiwia,codecool`. omp sends
the first turn, the harness restarts Meridian with the order reversed, and
`omp -c` sends the second turn.

| Build | Second turn | Cache read / write |
|---|---|---|
| upstream main `a9ee3372` (`--expect=move`) | `profile=codecool lineage=new diverged=not-found` | 9k / 7k |
| this branch (`--expect=retain`) | `profile=mobiwia lineage=continuation` | 16k / 72 |

On main the second turn moved to the new head of the order and replayed the
history there. On this branch it stayed on the account that served the first
turn and resumed its SDK session. The test conversation is short; on a real
conversation the replay writes the whole history (177k cache tokens for a
199-message conversation in production on 2026-11-20 15:24).

`before-meridian.log` and `after-meridian.log` hold Meridian's request and
usage lines from each run, with the concurrency counters removed. omp's
tool-less title and probe requests are separate conversations.
