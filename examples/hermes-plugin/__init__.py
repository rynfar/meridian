"""Meridian integration plugin for Hermes Agent.

Injects the request headers Meridian understands so that agentic runs keep
prompt-cache continuity (session affinity) and expose per-request cost and
observability levers. See README.md for details and measured impact.
"""
import os

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


def register(ctx):
    _register(ctx)
