# Hermes Agent integration plugin

[Hermes](https://hermes-agent.nousresearch.com) is a multi-profile agent
harness with a kanban task board. This user plugin wires Hermes to Meridian
so that agentic runs keep **prompt-cache continuity** and expose per-request
cost levers.

Without it, every turn that ends with a `tool_result` (i.e. virtually every
turn of an agentic run) is treated by Meridian as an independent session:
client `cache_control` blocks are stripped, the whole history is replayed
into a fresh SDK session, and cache creation is re-billed on every turn.
With the plugin, Meridian resumes the SDK session (`claude --resume`):
measured effect on a real workload went from `cache=47%` average with
multi-million-token cache writes per run, to `cache=100%` with ~150-token
deltas per turn.

## What it injects (per LLM request)

| Header | Value | Effect in Meridian |
|---|---|---|
| `x-session-affinity` | `hermes-<session_id>` | session/lineage continuity → prompt cache reuse |
| `x-request-id` | current kanban task id | correlation in `/telemetry/requests` |
| `x-meridian-source` | `hermes-<profile>` | per-profile filtering in logs/telemetry |
| `x-opencode-effort` | per-profile default, `HERMES_EFFORT` override | reasoning-effort (cost) control per task |

## What it exposes back to the agent

| Tool | Returns |
|---|---|
| `usage_status` | each quota window (`five_hour`, `seven_day`, ...): percentage used, status, minutes until reset |

Reads `GET /v1/usage/quota`. Without it, an agent has no way to know how much
of the subscription window it has left: it discovers the wall by hitting it,
mid-task. With it, an orchestrator can check before unparking long work, and
a human asking "how much budget is left?" over Telegram gets an answer from
the agent itself. The tool hides itself when Meridian is unreachable, so an
offline fleet is not offered a tool that would fail on every call.

## Install

```bash
mkdir -p $HERMES_HOME/plugins/meridian-affinity
cp plugin.yaml __init__.py $HERMES_HOME/plugins/meridian-affinity/
```

Enable it in `$HERMES_HOME/config.yaml`:

```yaml
plugins:
  enabled:
    - meridian-affinity
```

Point Hermes at Meridian (any key value works, Meridian handles auth):

```yaml
model:
  provider: anthropic
  base_url: http://127.0.0.1:3456
```

The plugin also registers a `usage_status` tool in a `usage` toolset. A
plugin toolset that is not listed in `toolsets:` is loaded but **never
offered to the model** — the agent simply reports that no such tool exists,
with nothing in the logs to explain why. Add it explicitly:

```yaml
toolsets:
  - usage      # exposes usage_status to the agent
```

Then enable it per platform if your agents run outside the CLI (Telegram,
Discord, ...), and restart the gateway so long-lived agent processes reload
the plugin:

```bash
hermes tools enable usage --platform telegram
hermes tools list --platform telegram   # expect: ✓ enabled  usage
```

Repeat for every Hermes profile that should route through Meridian
(profiles have isolated `HERMES_HOME` directories and do not inherit
plugins or config).

## Tuning

Edit `EFFORT_BY_PROFILE` in `__init__.py` to match your profiles, or set
`HERMES_EFFORT=low|medium|high|xhigh|max` in a worker's environment to
override per task.
