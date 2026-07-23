# Priority Profile Routing (`routing: "priority"`) — Design

**Status:** Approved (owner decisions: only-new-session drain-back; last-tried error surfaced; pool order editable in /settings) and implemented — live-verified against real account exhaustion (non-stream and streaming failover).
**Owner ask:** "Use my work account first to consume its usage, then auto-switch when it runs out." Explicitly **opt-in**: several users have said they do not want automatic account switching; nothing changes for anyone who doesn't enable it.

## Summary

A third routing mode alongside the existing two:

| Mode | Behavior | Status |
|---|---|---|
| `active` (default) | All unpinned traffic uses the manually selected active profile | Shipped |
| `sticky` | Sessions distributed across profiles by rendezvous hash (even burn, cache-affine) | Shipped |
| `priority` | Ordered pool: unpinned traffic prefers the highest-priority profile that isn't exhausted; fails over per request on quota errors; drains back after reset | **This spec** |

`x-meridian-profile` request-header pinning outranks every mode, unchanged — per-session pins (e.g. pylon's) are never overridden by the pool.

## Opt-in surface

- `MERIDIAN_ROUTING=priority` env, or `"routing": "priority"` in `~/.config/meridian/settings.json` (same switch that already selects `sticky`). Default remains `active`.
- Pool order: `MERIDIAN_PROFILE_ORDER=work,personal` env, or `"profileOrder": ["work","personal"]` in settings.json. Default when unset: the order profiles appear in `profiles.json`. Unknown ids in the order are ignored with a startup warning; profiles missing from the order sort last in config order.
- No other behavior changes when the mode is off. The exhaustion tracker (below) only runs in priority mode.

## Semantics

### 1. Session-affine selection (reuse the sticky machinery)

Priority mode reuses sticky's session-assignment seam with a different chooser:

- **A session that already has an assignment keeps it** while its profile is healthy — ongoing conversations never bounce between accounts just because the pool head changed (protects warm prompt caches; this is the same affinity argument that motivated sticky).
- **New sessions** (and sessions whose assigned profile is exhausted) get the highest-priority non-exhausted profile.
- Meridian's resume keys are already profile-scoped, so any reassignment lands as a clean fresh-replay under the new account — the continuity mechanics proven in the pylon failover work.

### 2. Exhaustion signal (per profile)

A profile is *exhausted* when any of:
- A request through it just failed with the rate-limit/out-of-quota error class (`errors.ts` already classifies these, including the out-of-extra-usage detector with its existing cool-down pattern) — mark immediately, in-band.
- The SDK rate-limit event store reports `five_hour` `rejected` / utilization ≥ 1.
- The OAuth usage cache reports `five_hour` utilization ≥ 1.

Exhaustion carries an expiry: the bucket's `resetsAt` when known, else a conservative default (10 min) so a mis-marked profile self-heals. State is in-memory (this is routing hygiene, not durable truth — after a restart the first failing request re-marks it).

### 3. Reactive per-request failover

When an unpinned request fails with the quota error class:
1. Mark the profile exhausted (with expiry).
2. Retry the same request on the next non-exhausted profile in the order — **each profile at most once per request**, then surface the final error unchanged.
3. Reassign the session to the profile that succeeded.

Ordering with the existing retry ladder: the current `[1m]`-strip fallback handles context-tier limit errors and stays first for its specific signature; account-quota errors go to profile failover. The two must not loop: one profile-failover pass per request, after which the existing ladder applies on the new profile.

### 4. Drain-back

When a higher-priority profile's exhaustion expires, it becomes eligible again — new sessions prefer it immediately; existing sessions finish where they are and drain back naturally as conversations end. No proactive migration.

### 5. Threshold steering (small, optional refinement)

New sessions avoid a profile already at ≥ 97% of `five_hour` (from the usage cache) even before a request fails — don't start a conversation two turns before the wall. Constant, not configurable, revisit only if field data argues.

## Observability

- `profile.failover` log event: `{ from, to, reason (error class or threshold), requestId, sessionKey }` — same diagnostic stream as `profile.switched`.
- Request log lines already print `profile=<id>`; priority assignments render as `profile=work(priority)` mirroring the `(sticky)` suffix.
- Home page in priority mode: the Accounts section shows pool order (1., 2. badges) and an `exhausted · resets in Xm` badge instead of the ACTIVE pill; `GET /profiles/list` reports `routing: "priority"`, the order, and per-profile exhaustion state so pylon's switcher can render an "Auto (pool)" entry.

## Non-goals

- **Not default.** No auto-enabling, no prompts suggesting it.
- No cross-account token budgeting or spend optimization — order is the user's policy, verbatim.
- No pylon-side changes required: pylon composes via header pinning (its per-session plan) and reads pool state from `/profiles/list`.
- No durable exhaustion state across restarts.
- `seven_day` windows are surfaced in UI badges but do **not** gate routing in v1 (the 5h window is the operative wall; weekly exhaustion also manifests as the same in-band error class and is handled reactively).

## Testing

- **Unit (pure):** the chooser as a new leaf module `src/proxy/routing.ts` — `choosePriorityProfile(order, assignments, exhaustion, now)` — covering preference order, affinity retention, exhausted-skip, expiry healing, threshold steering, empty/degenerate pools. Sticky's existing chooser moves beside it (shared types), preserving its tests.
- **Integration (mocked SDK):** limit-error on profile A → request retried once on B, response OK, session reassigned; second failure on B → original error surfaced; pinned header never rerouted; mode off → byte-identical current behavior (regression gate).
- **Live (E34-style, mandatory before merge):** the streaming path's failover retry touches the tool-loop seam — verify against the live harness. Real-world case available: the owner's `work` profile regularly saturates its 5h window, giving an authentic exhausted-account fixture; verify a real conversation fails over mid-stream and continues, and that telemetry shows `profile.failover` with correct attribution.

## Owner decisions (2026-07-23)

1. **Only new sessions drain back** after reset — never migrate a conversation mid-flight; caches break only when necessary (failover), never for preference.
2. **The last-tried profile's error surfaces** when the whole pool is exhausted.
3. **Pool order and mode are editable in the `/settings` UI** (GET/PUT `/settings/api/routing`), with env overrides reported.

## Live-verification record

The classifier gap this feature's live smoke caught: the CLI phrases real 5h exhaustion as "You've hit your session limit · resets <time>", which classified as generic `api_error` — failover never triggered on real exhaustion until `classifyError` learned the phrasing (now 429/rate_limit_error for every meridian path). Verified against a genuinely exhausted account: non-stream and streaming requests both failed over work → personal with a single clean message, `profile.failover` logged, exhaustion visible in `/profiles/list` with the real reset time.
