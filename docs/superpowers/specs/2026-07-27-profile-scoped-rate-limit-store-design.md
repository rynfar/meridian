# Profile-Scoped Rate-Limit Store — Design

**Status:** Approved (owner decisions: root-cause scoping over a local patch; three-tier reset resolution including the OAuth usage fallback).
**Fixes:** `priorityCooldownUntil` deriving one profile's exhaustion cooldown from another profile's reset time.

## Problem

`priorityCooldownUntil` (`src/proxy/server.ts:481-487`) decides how long to suppress a
profile that just returned `rate_limit_error`. It reads that duration from
`rateLimitStore.getAll()`:

```ts
const fiveHour = rateLimitStore.getAll().find(e => e.rateLimitType === "five_hour" && (e.resetsAt ?? 0) > now)
```

`rateLimitStore` (`src/proxy/rateLimitStore.ts`) is a process-wide singleton holding a
flat `Map<RateLimitBucketKey, RateLimitEntry>` — **no profile dimension**. Its own
doc comment describes the contents as "the active profile's latest known state",
and it is `clear()`ed on profile switch specifically to stop quotas leaking across
accounts.

In priority mode that premise no longer holds. Every profile in the pool records
into the same singleton (`server.ts:1617`, `server.ts:2331`) as requests are
dispatched across accounts, and there is no profile switch to trigger the clear.
So when profile A is marked exhausted, the `five_hour` `resetsAt` used to compute
its cooldown may be **profile B's** reset time.

Consequences:

- **Over-suppression** — A is benched until B's later reset, wasting A's available quota.
- **Under-suppression** — A is un-benched at B's earlier reset, so the next request
  through A fails again and burns a full round-trip before failing over.

The bug self-heals via the 6h `PRIORITY_COOLDOWN_CAP_MS` and `ProfileExhaustion`'s
lazy expiry, so it is not severe — but the mark duration is not reliably A's own,
and priority routing's whole value is spending each account's quota accurately.

### Same bug, second surface

`GET /v1/usage/quota` (`server.ts:4043`) has the identical latent defect. It resolves a
`targetProfileId` (honoring an explicit `?profile=` param), fetches OAuth usage
profile-scoped — and then merges in `rateLimitStore.getAll()`, which is whatever
profile wrote last. Overage details, and any bucket type OAuth does not expose,
can therefore be reported under the wrong account's identity.

## Design

### 1. Profile-scope `RateLimitStore`

Add a profile dimension so every read is explicitly per-account. Storage becomes
nested; the public API takes `profileId` first:

```ts
entries: Map<string, Map<RateLimitBucketKey, RateLimitEntry>>

record(profileId: string, info: SDKRateLimitInfo | undefined | null, observedAt?: number): void
getAll(profileId: string): RateLimitEntry[]     // newest-first, as today
get(profileId: string, key: RateLimitBucketKey): RateLimitEntry | undefined
clear(profileId?: string): void                 // one profile, or all when omitted
size(profileId?: string): number                // one profile's buckets, or total
```

The key is `profile.id`, which is already the literal `"default"` in single-profile
setups — so single-profile behavior is unchanged.

`profileId` is required on `record`/`getAll`/`get` rather than optional. An optional
parameter would let a call site silently read across accounts again, which is
exactly the failure being fixed.

`size` changes from a getter to a method so it can take a `profileId`. Its only
callers are assertions in `rate-limit-store.test.ts`, which this change updates
anyway; nothing in `src/proxy/` reads it.

Bounded growth: one inner map per configured profile. No eviction needed.

### 2. Three-tier reset resolution

Scoping alone exposes a gap. If the failing candidate never emitted a
`rate_limit_event` before erroring, its scoped bucket is empty and the cooldown
falls back to `PRIORITY_DEFAULT_COOLDOWN_MS` (10 min). Today the unscoped store
accidentally yields *some* long value; scoped, it would yield nothing. That would
make cooldowns shorter and churn-ier — profile A retried every 10 minutes through
a 5-hour outage, each retry costing a failed request.

`priorityCooldownUntil(profileId, now)` therefore resolves the reset from three
sources, most authoritative first:

1. **Scoped store** — that profile's own live `five_hour.resetsAt`, when the SDK
   emitted one.
2. **`fetchOAuthUsage({ profileId, claudeConfigDir })`** — authoritative for that
   specific account, straight from Anthropic, but used only when the returned
   `five_hour` window reports `utilization >= 1`. A healthy account always has
   a `five_hour` window with a future `resetsAt` — the rolling window boundary
   exists regardless of consumption — so an ungated read would extend a
   healthy profile's mark out to that boundary on any transient or
   non-five-hour error. A missing or null `utilization` is treated as NOT
   exhausted — under-suppressing is the safe direction; over-suppressing a
   healthy profile is the bug this gate exists to prevent. Already
   profile-scoped, already cached per profile (30s TTL) with in-flight
   sharing, already returns `null` gracefully on failure. This source was
   anticipated by the original priority routing spec
   (`2026-07-23-priority-profile-routing-design.md` §2).
3. **10-minute default** — unchanged last resort.

The result is clamped by `PRIORITY_COOLDOWN_CAP_MS` (6h) exactly as today.

**Tier 2 must not block failover.** The failover path has already burned one failed
request; adding a synchronous network call to it would compound the latency the
user feels. So:

- Mark the profile immediately using tier 1, else tier 3.
- Kick off the tier-2 fetch without awaiting it. When it resolves, re-`mark()` with
  the authoritative value.

This refinement is safe by construction: `ProfileExhaustion.mark` already ignores a
new `until` that is not later than the existing one (`routing.ts:145-149`), so a late
refinement can only **extend** a mark, never un-suppress a profile early. A failed
or `null` fetch changes nothing.

### 3. Call-site changes

| Site | Change |
|---|---|
| `server.ts:1617`, `server.ts:2331` | `record(profile.id, info)` — `profile` is already in scope in both generators |
| `priorityCooldownUntil` (`server.ts:481`) | Signature becomes `(profileId, now)`; implements the three tiers |
| `dispatchPriority` (`server.ts:567`) | Passes the failing `candidate`; schedules the tier-2 refinement |
| `GET /v1/usage/quota` (`server.ts:4043`) | `getAll(targetProfileId ?? "default")` |
| `POST /profiles/active` (`server.ts:3676`) | **Delete** the `clear()` call. It existed only to stop cross-profile leakage, which scoping now prevents structurally; other profiles' snapshots are valid and worth keeping. Update the comment. |
| `POST /auth/refresh` (`server.ts:3747`) | `clear(profile.id)` — scoped to the credential actually refreshed |

`ProfileExhaustion`, `routing.ts`, and `session/lineage.ts` are untouched. No new
imports into leaf modules; `rateLimitStore.ts` keeps its single responsibility and
gains no dependencies. `server.ts` gains no computation — the tiering lives in
`priorityCooldownUntil`, which is already a local helper in the priority block.

## Testing

**`src/__tests__/rate-limit-store.test.ts`** (update + extend):
- Two profiles recording the same bucket type do not overwrite each other.
- `getAll(profileId)` returns only that profile's entries, newest-first ordering preserved.
- `getAll` for an unseen profile returns `[]`.
- `clear(profileId)` drops one profile and leaves others intact; `clear()` drops all.
- `"default"` keying behaves identically to the pre-change single-profile flow.

**`src/__tests__/priority-routing-integration.test.ts`** (extend):
- **Regression for this bug:** profile B records a `five_hour` `resetsAt`; profile A
  then fails with `rate_limit_error`; A's exhaustion mark must NOT equal B's reset —
  it must come from A's own entry, or the 10-minute default when A has none.
- Tier ordering: A's own scoped entry wins over the OAuth fallback.
- Tier 2 refinement extends a default-10-minute mark when OAuth reports a later reset.
- Tier 2 returning `null`, or rejecting, leaves the initial mark unchanged.
- A late tier-2 value **earlier** than the existing mark does not shorten it.
- Failover latency: `dispatchPriority` resolves without awaiting the OAuth fetch.

**`src/__tests__/proxy-usage-quota-route.test.ts`** (update + extend):
- `?profile=b` reports B's SDK-sourced buckets while A's snapshot is also in the store.
- A profile with no SDK entries still renders OAuth-sourced buckets (no regression).

OAuth usage is stubbed via the existing `_testOverride` / `fetchImpl` seams in
`oauthUsage.ts` — no network in tests.

## Out of scope

- **Threshold steering** (priority routing spec §5 — avoid a profile at ≥97% of its
  `five_hour` window). Accurate per-profile utilization is a prerequisite and this
  change delivers it, but the steering logic itself is separate work.
- **`priorityAssignments` FIFO eviction** (`server.ts:556-559`) — re-`set`ting a key
  does not reorder a JS `Map`, so a long-lived active conversation can be evicted
  ahead of a newer idle one. Real, unrelated, low impact at current volumes.
- **Persisting rate-limit state across restarts.** Still deliberately in-memory;
  the first request after a restart repopulates.

## Risks

- **Behavior change on `/v1/usage/quota`.** A profile that has recorded no SDK
  events now returns OAuth-only buckets where it previously showed another
  profile's SDK data. This is the fix, not a regression, but it is user-visible in
  the telemetry UI and worth noting in the PR.
- **Removing the profile-switch `clear()`** means snapshots outlive a switch. They
  are correctly attributed now, and `observedAt` already lets consumers judge
  staleness.
