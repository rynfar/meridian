# Oh My Pi side calls on a regrouped history fork the session

Live runs on 2026-11-26, Linux x64, Node 24.22.3, omp 19.2.1, Claude Code
2.1.322, model `opus` (`claude-opus-5-5`). Each run used an isolated Meridian
with its own `MERIDIAN_CONFIG_DIR` and `MERIDIAN_SESSION_DIR`,
`MERIDIAN_CREDENTIALS_READONLY=1`, and an omp agent dir whose `models.yml`
points the anthropic provider at it with `x-meridian-agent: pi`.

    node scripts/e2e-omp-side-call.mjs --omp=$(command -v omp) \
      --agent-dir=<dir> --log=<meridian log> --model=opus --reminder \
      [--expect=auxiliary]

`--reminder` gives the first user message of the conversation's turns one
reminder-only block the side call's copy lacks, the shape a production side
call had on 2026-11-26 (`user[text,text]` in the turns, `user[text]` in the
side call, on a 447-message conversation, where each replay wrote 175k).

| Build | Side call | Cache read / write | Next turn |
|---|---|---|---|
| upstream main `d065fb02` (`before-meridian-requests.log`) | `diverged=independent-request:auxiliary-request auxiliary=replay:regrouped` | 15k / 1k | `lineage=continuation` |
| this branch (`after-meridian-requests.log`, first run) | `lineage=continuation … auxiliary=fork` | 17k / 127 | `lineage=continuation`, same session |

On main the side call's replay read 15k only because the conversation was two
messages long and the system prompt was cached; on a long conversation it
writes the whole history.

`after-meridian-requests.log` also holds a second run without `--reminder`,
which still forked (`PASS (fork)`).

The logs hold Meridian's request and usage lines for the conversation's
requests only, with the concurrency counters removed. No credentials appear in
them.
