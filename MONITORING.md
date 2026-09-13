# Monitoring and Usage

[← Back to README](README.md)

Meridian records request metrics, diagnostic events, and token/cache anomalies. These explain traffic through this proxy; account quota comes from upstream and can include usage outside Meridian.

## Where to Look

| Surface | What it shows |
|---------|---------------|
| `/` | Account usage, active profile, and recent aggregate metrics |
| `/profiles` | Profile authentication and usage |
| `/telemetry` | Requests, timings, token/cache metrics, diagnostic logs, and envelope audits |
| `/health` | Health, authentication, build provenance, and available renewal information |
| `/metrics` | Prometheus request counters and duration histograms |

The default URL is `http://127.0.0.1:3456`. Protected routes require `x-api-key` or a Bearer token when `MERIDIAN_API_KEY` is set; `/` and `/health` remain open, but the landing page's protected data requests still require authentication.

## Usage Limits

- `GET /v1/usage/quota` returns usage information for the selected profile; use `?profile=<id>` to select a particular account.
- `GET /v1/usage/quota/all` returns per-profile snapshots. Available windows depend on the account and may include five-hour, weekly, or model-specific limits.
- Read utilization together with the reset time and snapshot freshness. An unavailable or stale value is **not zero usage**. `no_token`, `rate_limited`, and `upstream_error` mean different things; an API-key profile may report `not_oauth`.
- Quota reads use a cached upstream OAuth endpoint (normally a 30-second cache), not a local conversion from tokens to subscription percentage. SDK rate-limit events provide additional information when available. Frequent polling cannot make missing upstream data authoritative.

Subscription limits, context occupancy, and API-equivalent cost are different measures. A cache hit does not mean zero subscription usage, and a large context window does not mean that much quota remains.

## Reading Token and Cache Metrics

The SDK separates uncached input, cache reads, and cache creation. Meridian calculates:

```text
cache hit rate = cache-read tokens /
                 (uncached input + cache-read tokens + cache-creation tokens)
```

With no measured input, there is no defined rate. A low `inputTokens` value alone does not mean a small prompt: most of it may have been served from cache.

| Pattern | How to interpret it |
|---------|---------------------|
| First request has no cache reads | Usually normal warm-up |
| Repeated continuations have high cache reuse | Expected for a stable prefix and short gaps; no fixed percentage is guaranteed |
| One miss after a restart, account/model switch, or long gap | Investigate in context; it does not by itself prove a bug |
| Repeated low reuse on a stable conversation | Check identity, lineage, prompt/tool changes, account routing, and replay events |
| Large uncached input or cache writes | May be a large tool result, changed prefix, or full-history replay |

Prompt caching is controlled upstream. Session persistence preserves conversation mappings and SDK transcripts; it does not guarantee that an upstream prompt cache stays warm. Meridian stabilizes tool registration order, but changes to the prompt, model, account, or history can still reduce reuse.

## Anomaly Detection

Thresholds come from [`src/proxy/tokenHealth.ts`](src/proxy/tokenHealth.ts):

| Anomaly | Trigger | Severity |
|---------|---------|----------|
| Context spike | Uncached input grows more than 60% from a previous baseline of at least 1,000 tokens | Warning; critical above 200% growth |
| Cache miss on resume | Cache hit rate ≤5%, with positive uncached input | Warning without a previous session metric; otherwise critical |
| Output explosion | Output exceeds twice the previous turn and 2,000 tokens | Warning |

These are investigation signals, not proof of cache corruption. Alerts appear in stderr as `TOKEN WARN` / `TOKEN ALERT`, in the dashboard's token logs, and at `/telemetry/logs?category=token`. Meridian currently exposes these in logs and the web UI; it does not send native desktop notifications.

For malformed or undelivered responses, inspect the dashboard's **Envelope** card and correlate its diagnostic events with the request ID. Silent-turn and upstream-idle events help distinguish empty responses, stalls, and client cancellation from successful completion.

## Diagnostic Queries

These examples assume local proxy authentication is disabled. Add `-H "x-api-key: $MERIDIAN_API_KEY"` when enabled.

```bash
curl -s 'http://127.0.0.1:3456/health' | python3 -m json.tool
curl -s 'http://127.0.0.1:3456/v1/usage/quota/all' | python3 -m json.tool
curl -s 'http://127.0.0.1:3456/telemetry/requests?limit=10' | python3 -m json.tool
curl -s 'http://127.0.0.1:3456/telemetry/logs?category=token' | python3 -m json.tool
curl -s 'http://127.0.0.1:3456/telemetry/summary?window=3600000' | python3 -m json.tool
```

Request queries support `limit` (up to 500), `since` (epoch milliseconds), and `model`. Logs support `limit` (up to 500), `since`, and `category`. Summary `window` is milliseconds and defaults to one hour.

The CLI writes logs to stderr. The supervisor/service may redirect them to `~/.cache/meridian/proxy.err`; this is not a universal CLI log file. Use `docker logs <container>` or `journalctl --user -u meridian` for those deployments.

## Persistence

By default, request metrics and diagnostic logs live in bounded memory stores and disappear on restart. Enable SQLite history before starting Meridian:

```bash
MERIDIAN_TELEMETRY_PERSIST=1 meridian
```

The default database is `~/.config/meridian/telemetry.db`, with seven-day retention. Override these with `MERIDIAN_TELEMETRY_DB` and `MERIDIAN_TELEMETRY_RETENTION_DAYS`. Check startup output: initialization failure falls back to memory. Containers must persist the database directory to retain history across recreation.

## Estimated Cost

The dashboard and `/telemetry/summary` expose `costEstimate`: an **API-equivalent estimate**, not an invoice or remaining subscription budget. Actual billing depends on the configured authentication profile, plan, and upstream rules.

Rates come from [`src/telemetry/pricing.ts`](src/telemetry/pricing.ts), plus local overrides. They are not fetched live. Models without a pricing entry are excluded from the total and shown as unpriced; totals can therefore be incomplete.

Edit rates under **Model Pricing** at `/settings`. Overrides persist to `~/.config/meridian/model-pricing.json` (`MERIDIAN_PRICING_CONFIG` overrides the path), and apply on the next refresh. The API is `GET /settings/api/pricing`, `PUT /settings/api/pricing/:model`, and `DELETE /settings/api/pricing/:model`.
