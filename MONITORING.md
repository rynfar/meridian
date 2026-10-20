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

Claude profiles in `/v1/usage/quota/all` also include `bankedResets`:

```json
{
  "bankedResets": {
    "eligible": true,
    "grants": [
      {
        "id": "example-reset-grant",
        "resetsLeft": 1,
        "expiresAt": 1792684800000
      }
    ]
  }
}
```

Each grant keeps its own remaining reset count and expiration date.
`expiresAt` is Unix epoch milliseconds, or `null` when the date is unknown.
`id` is the provider's grant identifier, or `null` when unavailable.
The list preserves provider inventory, including exhausted, paused,
not-yet-started and expired grants. It is not a count of resets usable now,
and `eligible` does not establish that a particular grant can be used.
`bankedResets: null` means reset information is unavailable, including for
non-OAuth profiles. A valid empty `grants` list means the provider returned
no grants. Read reset data with the profile's `fetchedAt`, `stale` and `failure`
fields, just like its usage windows. This endpoint only lists grants; it
does not redeem them.

Subscription limits, context occupancy, and API-equivalent cost are different measures. A cache hit does not mean zero subscription usage, and a large context window does not mean that much quota remains.

### Redeeming a banked reset

`POST /v1/usage/quota/reset` consumes a reset if Claude accepts the request.
It is an explicit action, not a quota poll or health check. Send a JSON object:

```json
{
  "profile": "work",
  "grantId": "chosen-grant-id",
  "requestId": "client-operation-uuid"
}
```

All three fields are required. Use the profile and grant IDs from
`/v1/usage/quota/all`; there is no active-profile or next-grant fallback.
Use `profile: "default"` for the single-account entry when no profiles are
configured. API-key and static token-only profiles cannot redeem Claude grants
and report `not_oauth`; token-only profiles also cannot read the host account's
grant inventory under their own profile ID.
`grantId` accepts 1–40 lowercase letters, digits, underscores or hyphens.
`requestId` accepts 1–64 letters, digits, underscores or hyphens.
Generate a request ID once per intentional redemption and retain it with
that operation.

The endpoint uses the selected profile's OAuth token to resolve its organization.
It inherits API-key authentication and rejects cross-origin browser requests.
Responses use `Cache-Control: no-store`.

A parsed provider response returns HTTP 200 with the requested IDs and
`result`, `reason`, `resetsLeft`, `cleared`, `weeklyResetsAt` and `cooldownUntil`.
Only `result: "reset"` confirms redemption. Other results are `already_used`,
`not_limited`, `cooldown`, `ineligible` and `unavailable`.
Times are epoch milliseconds, or `null` when unavailable; timezone-free provider
timestamps are UTC. Invalid optional metadata becomes unknown without hiding
a confirmed `result: "reset"`.
Confirmed resets and `already_used` outcomes invalidate the selected account's
cached usage. Superseded quota polls join the current read rather than reporting
a false upstream failure.

Only a confirmed reset clears local SDK windows explicitly listed in `cleared`
and matching reported refusal state. Uncleared weekly/model limits and independent
overage metadata survive. Unknown, non-quota and unrelated routing exclusions
remain conservative; an uncertain outcome never erases known refusal state.

Missing upstream OAuth credentials return HTTP 503 with `code: "no_token"`.
HTTP 401 remains the Meridian API-key authentication failure.

Meridian sends one redemption POST and does not retry it automatically.
Transport failures or invalid responses after dispatch can return
`indeterminate: true`: the reset may have been consumed even though the response
was lost. Re-read quota and confirm the outcome before another intentional
attempt. Keep the original request ID if reconciling that operation; do not
generate a new one as an automatic retry. Claude's client reuses IDs after
uncertain outcomes, but this is not a guarantee of server-side deduplication.


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

## Prometheus Scope

`/metrics` renders counters and histograms from retained request records (up to 10,000), rather than independent lifetime accumulators. Values can fall as records leave the in-memory buffer or retention window. Treat them as a view of retained traffic; do not assume monotonic lifetime counters for alerting or `rate()` calculations.

## Estimated Cost

The dashboard and `/telemetry/summary` expose `costEstimate`: an **API-equivalent estimate**, not an invoice or remaining subscription budget. Actual billing depends on the configured authentication profile, plan, and upstream rules.

Rates come from [`src/telemetry/pricing.ts`](src/telemetry/pricing.ts), plus local overrides. They are not fetched live. Models without a pricing entry are excluded from the total and shown as unpriced; totals can therefore be incomplete.

OpenAI (GPT/Codex) rates live in the generated [`src/telemetry/openaiPricingData.ts`](src/telemetry/openaiPricingData.ts): Standard tier, with a model's long-context rate for a prompt over its threshold where the table lists one (272K tokens); Fast mode requests are underestimated. They apply only to requests an OpenAI model served, which is every GPT request when [ChatGPT subscriptions](docs/configuration.md#chatgpt-subscriptions) are served. Where they are not, a GPT model id sent to the OpenAI-compatible endpoints is answered by Claude and valued as the Claude model that answered it; a request that recorded no such model stays unpriced unless you add an override for that id. Effort and date suffixes (`gpt-6-sol-high`, `gpt-5.5-2026-04-23`) price as the base model.

`bun scripts/update-openai-pricing.ts` regenerates that table from [models.dev](https://models.dev), cross-checked against LiteLLM, and checks it against the official rates kept by hand in [`src/telemetry/openaiOfficialPricing.ts`](src/telemetry/openaiOfficialPricing.ts). It changes nothing and exits 1 when a model has no cached-input price, a known model disappears, or two sources differ by more than 1%. `--check` exits 2 when the table would change. The `Update OpenAI pricing` workflow runs it daily and opens a PR when rates change.

Edit rates under **Model Pricing** at `/settings`. Overrides persist to `~/.config/meridian/model-pricing.json` (`MERIDIAN_PRICING_CONFIG` overrides the path), and apply on the next refresh. The API is `GET /settings/api/pricing`, `PUT /settings/api/pricing/:model`, and `DELETE /settings/api/pricing/:model`.
