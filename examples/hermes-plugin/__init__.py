"""Meridian integration plugin for Hermes Agent.

Integration runs both ways:

- **agent -> Meridian**: injects the request headers Meridian understands so
  that agentic runs keep prompt-cache continuity (session affinity) and
  expose per-request cost and observability levers.
- **Meridian -> agent**: exposes a ``usage_status`` tool so the agent can
  read its own subscription quota windows and pace long work itself instead
  of discovering the wall mid-task.

See README.md for details and measured impact.
"""
import json
import os
import time
import urllib.request

# Where this Hermes install reaches Meridian. Point it at the same base_url
# as `model.base_url`; the container-network name is the common case for a
# dockerised fleet.
MERIDIAN_URL = os.environ.get("MERIDIAN_URL", "http://127.0.0.1:3456")

# Reasoning-effort defaults per Hermes profile (x-opencode-effort).
# Adjust to your fleet; override per task with the HERMES_EFFORT env var.
EFFORT_BY_PROFILE = {
    "writer": "low",
    "coder": "medium",
    "implementer": "medium",
    "refactorer": "medium",
    "debugger": "medium",
    "orchestrator": "medium",
    "researcher": "high",
    "planner": "high",
    "reviewer": "high",
    "test-architect": "high",
}

_VALID_EFFORT = ("low", "medium", "high", "xhigh", "max")


def _profile():
    home = os.environ.get("HERMES_HOME", "")
    if "/profiles/" in home:
        return home.rstrip("/").rsplit("/", 1)[-1]
    return "main"


def _register(ctx):
    def middleware(request=None, session_id="", task_id="", **_):
        req = dict(request or {})
        extra = dict(req.get("extra_headers") or {})

        sid = (session_id or task_id or "").strip()
        if sid:
            extra["x-session-affinity"] = f"hermes-{sid}"

        task = (os.environ.get("HERMES_KANBAN_TASK") or task_id or "").strip()
        if task:
            extra["x-request-id"] = task

        profile = _profile()
        extra["x-meridian-source"] = f"hermes-{profile}"

        effort = (os.environ.get("HERMES_EFFORT")
                  or EFFORT_BY_PROFILE.get(profile, "")).strip()
        if effort in _VALID_EFFORT:
            extra["x-opencode-effort"] = effort

        if not extra:
            return None
        req["extra_headers"] = extra
        return {"request": req, "middleware": "meridian-affinity"}

    ctx.register_middleware("llm_request", middleware)


# --------------------------------------------------------------------------
# Meridian -> agent: quota visibility as a tool
# --------------------------------------------------------------------------

_USAGE_SCHEMA = {"type": "object", "properties": {}, "required": []}


def _get(path, timeout=4.0):
    with urllib.request.urlopen(MERIDIAN_URL + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _meridian_reachable():
    """check_fn: hide the tool entirely when Meridian is not answering.

    An agent that cannot reach Meridian is better off not seeing a tool that
    would fail on every call.
    """
    try:
        _get("/health", timeout=2.0)
        return True
    except Exception:
        return False


def usage_status(args=None, **kwargs):
    """Return each quota window: % used, status, minutes until reset.

    NOTE: the handler must return a *string* — returning a dict fails at the
    tool-call boundary while still passing a direct unit test, which makes
    the mistake easy to ship.
    """
    try:
        quota = _get("/v1/usage/quota")
    except Exception as exc:
        return json.dumps({"error": "Meridian unreachable: %s" % exc},
                          ensure_ascii=False)
    now_ms = time.time() * 1000
    out = {}
    for bucket in (quota.get("buckets") or []):
        if not isinstance(bucket, dict) or "utilization" not in bucket:
            continue
        reset = bucket.get("resetsAt")
        out[bucket.get("type") or "?"] = {
            "utilization_pct": round((bucket.get("utilization") or 0.0) * 100, 1),
            "status": bucket.get("status"),
            "resets_in_min": round((reset - now_ms) / 60000) if reset else None,
        }
    return json.dumps(out, ensure_ascii=False, indent=2)


def _register_usage_tool(ctx):
    ctx.register_tool(
        name="usage_status",
        toolset="usage",
        schema=_USAGE_SCHEMA,
        handler=usage_status,
        check_fn=_meridian_reachable,
        # Wording matters more than it looks: with a purely descriptive
        # blurb the model answers budget questions from the per-request USD
        # figure already in its context and never calls the tool. Name the
        # user-facing words ("budget", "quota", "how much is left") and say
        # explicitly what NOT to answer with.
        description=(
            "BUDGET / QUOTA of the Claude subscription. CALL THIS for any "
            "question about budget, budget window, quota, usage or 'how much "
            "is left'. Do NOT answer from the per-request USD budget shown "
            "in context: that is the cost cap of the current call, not the "
            "subscription window. Returns, per window (five_hour, "
            "seven_day, ...): percentage used, status, minutes until reset. "
            "Also check it before starting or unparking long work."
        ),
        emoji="⏳",
    )


def register(ctx):
    _register(ctx)
    _register_usage_tool(ctx)
