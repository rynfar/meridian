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

Two wording caveats, learned the hard way. A tool description is read twice
— by the search index that surfaces the tool, and by the model deciding
whether to call it — so it must be written for both:

- **Use the words the user says.** A description that never contains
  "budget", "quota" or "Meridian" means a search for those terms returns
  nothing, and the tool stays invisible even though it is registered.
- **Give triggering conditions only — never announce the result.** With a
  neutral, explanatory description the model answered budget questions from
  the per-request USD cap already in its context (`USD budget: $0/$1.5`)
  and never called the tool: not missing, simply not chosen. A description
  that summarises what the call returns makes this worse, because the model
  can produce that summary from context instead of calling. State when to
  call, and what must *never* be answered instead.

Keep it short (~200 chars): long descriptions dilute the search index and
bury the trigger. Details belong here in the README, not in the schema.

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

Then restart the gateway: plugins load once per process, and long-lived
agent processes keep the old registry until they do. Existing chat sessions
also cache their tool list — start a fresh one (`/new`) after the restart.

### Why `usage_status` lives in a native toolset

The tool registers into `delegation` (a native toolset) rather than a
plugin-defined one. That is not cosmetic:

`gateway/run.py` builds each platform session's tool surface from
`_get_platform_tools()`, which keeps **only native toolset keys** —
plugin-defined toolsets are skipped. A tool registered into a custom
`usage` toolset is therefore loaded, reported as `✓ enabled` by
`hermes tools list --platform telegram`, and still never reaches the model:
the agent answers "I have no such tool", and nothing in the logs says why.
(The kanban tools escape this only because `kanban_show` / `kanban_list`
are hard-coded in `_HERMES_CORE_TOOLS`.)

Override the target with `USAGE_TOOLSET` if a different native toolset fits
your fleet better. Verifying by hand is worth it: ask an agent a plain
question ("what's my budget?") on the platform you actually use — the CLI
resolves toolsets differently and can succeed while Telegram fails.

Repeat for every Hermes profile that should route through Meridian
(profiles have isolated `HERMES_HOME` directories and do not inherit
plugins or config).

## Tuning

Edit `EFFORT_BY_PROFILE` in `__init__.py` to match your profiles, or set
`HERMES_EFFORT=low|medium|high|xhigh|max` in a worker's environment to
override per task.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `MERIDIAN_URL` | `http://127.0.0.1:3456` | where this Hermes install reaches Meridian |
| `MERIDIAN_API_KEY` | unset | required for `usage_status` if the proxy sets `MERIDIAN_API_KEY` — Meridian gates `/v1/*` behind it |
| `HERMES_EFFORT` | per-profile | overrides `x-opencode-effort` for one worker |
| `USAGE_TOOLSET` | `delegation` | native toolset the `usage_status` tool registers into |

If your Meridian sets `MERIDIAN_API_KEY` and you don't set it here,
`usage_status` hides itself rather than appearing and failing on every
call — `/health` is exempt from auth, so the tool's availability check
deliberately probes the quota endpoint instead.

## Adapter note

Hermes sends `User-Agent: python-httpx`, which matches no Meridian
detection heuristic, so plain Hermes traffic resolves to whatever
`MERIDIAN_DEFAULT_AGENT` names. The `x-session-affinity` header this plugin
injects resolves to the **`opencode`** adapter regardless of that default —
usually what you want, since these headers are the ones that adapter reads,
but it is a real switch on any deployment that sets a different default.
