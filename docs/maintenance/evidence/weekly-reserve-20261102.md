# Weekly reserve — live OpenCode evidence (2026-11-02)

Feature: `MERIDIAN_WEEKLY_RESERVE` / `weeklyReserve` removes a profile from
priority routing once its observed weekly (`seven_day`) usage reaches 100% minus
the reserve.

## Setup

- Harness: [`scripts/e2e-weekly-reserve-opencode.sh`](../../../scripts/e2e-weekly-reserve-opencode.sh)
- Meridian: this branch's `dist/` at `808db83e2`, Node v22.22.3, Darwin arm64,
  separate instance on port 3477 with the operator's real profiles and server
  plugins (including `opencode-scrub` 0.3.0). The operator's running instance
  was not touched.
- Client: OpenCode **2.2.0** (`opencode run --standalone`), disposable
  HOME/XDG directories, Meridian V2 plugin installed by this build's
  `setup --v2`. The effective config had exactly one Meridian entry
  (`dist/meridian-v2`) and `baseURL http://127.0.0.1:3477/v1`.
- Plugin witness: every counted request line carries `agent=primary` or
  `agent=subagent`, which only the client plugin's agent-mode header produces.
- Model: `anthropic/claude-haiku-5-5`, prompt "Reply with the single word: ok".
- Pool: `MERIDIAN_ROUTING=priority`, `MERIDIAN_PROFILE_ORDER=personal,<fallback>`.
  A 99% reserve was used so that `personal`'s actual usage (6–7%) was already
  past the line.

## Results

| Arm | Reserve | personal weekly reading | Routed to | Reply | Result |
|-----|---------|-------------------------|-----------|-------|--------|
| control | unset | 0.06 | `personal` (primary) | ok | PASS |
| held | `personal=99` | 0.07 | fallback A (primary and title); `personal` never attempted | ok | PASS |

Held-arm log (sanitized):

```
priority.weekly_reserve_held profile=personal utilization=0.07 until=1794157200378
[PROXY] … adapter=opencode profile=<fallback-A>(priority) model=haiku … agent=primary …
[PROXY] … adapter=opencode source=subagent-title profile=<fallback-A>(priority) … agent=subagent …
```

## Other observations

- **Cold-start dependence.** A fresh instance has no weekly reading until a usage
  read succeeds. In the first held attempt every usage read returned 429
  (`oauth_usage.upstream_error status=429`), so nothing was held and the request
  went to `personal`. This is the documented behavior ("an account Meridian has
  not measured yet is not held"). In these runs the SDK did not report weekly
  utilization on ordinary requests. The harness now retries the read (bounded)
  and reports INCONCLUSIVE when no reading arrives.
- An earlier held attempt with a different fallback skipped `personal` correctly,
  then that fallback refused with "You've hit your 5-hour limit" and the next
  pool member had an expired OAuth token. Account state only; not counted as a
  pass.
- One client run stalled before sending any request (OpenCode transport reset
  after 40 minutes). The harness now bounds the client at 300 s.
