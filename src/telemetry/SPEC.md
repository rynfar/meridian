---
id: telemetry-ui
type: module-design
status: active
title: Telemetry and web UI
parent: architecture
references: [design-language]
---

## Responsibility

Record what Meridian did and show it to the operator:

- request metrics (bounded in-memory ring; optional SQLite history via libsql
  with `MERIDIAN_TELEMETRY_PERSIST=1`) and the diagnostic log ring buffer;
- the telemetry JSON API, `/metrics` (Prometheus view of retained records) and
  API-equivalent cost estimates (static Claude rates, generated OpenAI rates,
  user overrides);
- the server-rendered HTML pages (except `/plugins`, owned by `plugins`) — landing, `/telemetry`, `/profiles`,
  `/providers`, `/settings`, login callback, the terminal landing — and the
  shared site header (`profileBar.ts`), which is the single home of the color
  tokens;
- pure presentation shared with the desktop app (`providerView.ts`,
  `providerSetup.ts`, `settingRow.ts`), and the pure cost valuation in
  `pricing.ts`, whose `resolveRequestPricing` the desktop uses to value each
  request exactly as `computeCostEstimate` does;
- the shared `settingRow` presentation (`settingRow.ts`) every `/settings`
  row renders through: label and control on one line, description, status and
  env-override lines below. The override line credits an env var only when the
  resolver used it (`telemetryEnvSources` applies the resolver's own parse); a
  set but unusable variable is named as such.

## Boundary

- **Leaf module:** its only in-repo imports are `src/settings`, `src/env` and
  `src/configDir` (externally: Hono for the route sub-app in `routes.ts` that
  `server.ts` mounts, and libsql for persistence). Never imports `server.ts`, `session/`, adapters or provider backends; callers
  push data in and register its routes.
- Pages are self-contained template strings with **no UI build step**; every
  page follows [`design-language`](../../DESIGN.md) (tokens only, shared header,
  no page-level body background).
- Shared presentation used by `desktop-app` stays **pure** (no I/O, no Electron);
  neither UI executes a generated setup command.
- Cost figures are **estimates**, never an invoice or remaining-budget claim;
  unpriced models are excluded and labeled, never shown as zero.

## Decisions

- **`/` and `/profiles` update in place.** Their polls patch `#content` from
  the fresh markup (`domPatch.ts`) instead of replacing it: nodes are matched
  by `data-key`/`id` (cards by profile id) or by position among unkeyed
  siblings of one tag, and only changed attributes, text and added, moved or
  removed nodes are touched, so find-in-page, a selection, focus and scroll
  survive a refresh. A node marked `data-patch-own` (an open sign-in panel)
  keeps its script-owned children.
- **Card status is shared between both pages** (`profileCardStatus.ts`): the
  informational duplicate badge and the post-sign-in *updating* / *failed*
  line. The page remembers a sign-in it finished, so an answer requested
  before it cannot clear the updating state; `/profiles` polls every 1.5s
  while a card updates, drops an answer older than one already drawn, and
  exempts an updating card from the search (not from the provider chips). An
  updating card dims only its figures; its name row and active border never
  dim.
- **`/`, `/profiles` and `/providers` stop polling while their tab is
  hidden.** All three read `/v1/usage/quota/all` (`/providers` through
  `/providers/view`, whose Claude card re-reads it at most every 10 s), and
  Meridian caches each Claude profile's usage for only 30 s. One forgotten
  background tab polling every 10 s therefore asks Anthropic's OAuth usage
  endpoint for every profile about twice a minute, enough to keep it
  answering 429 for the CLIs and widgets that share it. A hidden tab skips its
  timed polls, and `visibilitychange` refreshes the page as soon as it is
  shown again.

- **Keepalive beats are not requests.** Rows with
  `requestSource: "cache-keepalive"` answered no client, so `computeSummary`
  (both stores), the route summary and Prometheus request series exclude
  them, and `getLastForSession` skips them so token-anomaly checks compare
  turn to turn. They are totalled apart in `TelemetrySummary.cacheKeepalive`
  (beats, reached, not reached, tokens, estimated USD), a dashboard section
  and `meridian_cache_keepalive_beats_total{outcome}`. A beat that never
  reached upstream carries status `0` and its reason in `error`, and is shown
  as skipped, not as an error.

- **`/telemetry/timeseries` buckets what `/summary` counts.** It serves the
  desktop app's history charts: `start`/`end`/`bucket` (or `window` instead of
  `start`), buckets aligned to `start` over `[start, end)` so a client's local
  midnight yields local-hour buckets, every bucket present. Rows are the raw
  store rows with keepalive beats excluded, NOT collapsed route chains, because
  `computeSummary` does not collapse either; a failover's hops count once each,
  so the buckets of a range sum to the summary's requests, errors and token
  totals. Hit rate is summary's mean per-row rate, p50 uses
  `computePercentiles`, cost is `computeCostEstimate` with the user overrides:
  `costUsd` is `null` only when every request in the bucket is unpriced, and
  `unpricedRequests` labels a partial figure (an empty bucket costs `0`).
  Ranges over 31 days or 1,000 buckets are refused, which bounds the response;
  the read goes through `getRecent` with an exclusive `until`, so rows after
  `end` do not spend the 100,000-row bound (summary's SQLite bound).
  `truncated` is set when that bound is hit, when a full memory ring's oldest
  row is newer than `start`, or when `start` reaches past SQLite retention and
  the oldest held row is newer than it. A ring that is not full has dropped
  nothing, so a range before the first request is empty, not truncated. The
  bucketing is pure (`timeseries.ts`); the route only parses and reads.

User-facing behavior is documented in `MONITORING.md`.

## Known limitations

- **History is volatile by default**; without persistence, metrics and logs
  vanish on restart, and a failed SQLite initialization silently falls back to
  memory (announced only at startup).
- **`/metrics` is not monotonic**: values come from up to 10,000 retained
  records and can fall as records age out, so `rate()`-style alerting is
  unreliable.
- **Cost totals can be incomplete** (unpriced models) and OpenAI Fast-mode
  requests are underestimated.
- **The persistence banner cannot be silenced by the `silent` config option**,
  because the stores are created at module load before config exists; only
  `MERIDIAN_QUIET=1` suppresses it.
