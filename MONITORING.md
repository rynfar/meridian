# Token Monitoring Guide

Meridian tracks token usage and prompt cache efficiency on every request. This guide explains what the numbers mean and how to spot problems.

## Where to Look

- **Dashboard**: `http://127.0.0.1:3456/telemetry` — Requests tab shows Tokens and Cache columns, Overview tab shows aggregate token stats
- **Stderr log**: `tail -f ~/.cache/meridian/proxy.err` — every request logs `cache=XX%`, anomalies show as `TOKEN ALERT` or `TOKEN WARN`
- **API**: `GET /telemetry/requests` for per-request data, `GET /telemetry/logs?category=token` for anomaly alerts

## What's Normal

| Metric | Healthy Value | What It Means |
|--------|--------------|---------------|
| Cache % on first request (`new`) | 0% | Cache is being primed — nothing to read from yet |
| Cache % on 2nd request | 60–80% | System prompt + tools are now cached, warming up |
| Cache % on 3rd+ request (`continuation`) | 93–100% | Steady state — only your new message costs fresh tokens |
| Input tokens (`in`) | 3–15 per turn | Just the new message delta, everything else is cached |
| Output tokens (`out`) | Varies | Depends on what Claude is doing — file writes are large, short answers are small |

## What's Bad

| Symptom | What It Means | Likely Cause |
|---------|---------------|--------------|
| Cache 0% on a `continuation` | Prompt cache invalidated — full context re-read every turn | Tool list changed between requests, system prompt changed, or SDK cache expired (5 min TTL) |
| Input tokens suddenly jumps to thousands | Full conversation history being re-sent instead of delta | Session resume failed, lineage classified as `diverged` instead of `continuation` |
| `TOKEN ALERT: cache hit rate 0% on resume` in logs | Anomaly detector caught a cache miss | Same as cache 0% above — check if tool ordering or system prompt changed |
| `TOKEN ALERT: Input tokens grew XX%` in logs | Context grew more than 60% in one turn | Possible context leak, full replay, or very large tool result |
| Cache % declining over time (99% → 80% → 60%) | Cache is being partially invalidated each turn | Something is changing in the prompt prefix between turns |

## How Caching Works

The SDK uses 5-minute TTL prompt caching. On each turn, the system prompt + tool definitions + conversation history form a prefix. If that prefix is identical to the previous turn, it's a cache hit (cheap). If anything changes — even tool ordering — it's a cache miss (expensive, full re-read).

Meridian sorts tools alphabetically before registration to keep the prefix stable. If you see cache misses on continuations, something is changing the prefix between turns.

## Estimated Cost

The Overview tab shows an **Estimated Cost** section: a headline card with the window's total, per-model cards, and a table breaking down input/output/cache-read/cache-write tokens with the estimated USD per model. The same data is available on the API as `costEstimate` in `GET /telemetry/summary`.

What the number means:

- It is the **equivalent Anthropic API list price** for the window's token usage. Claude Max requests are covered by the subscription and are never billed per token. Use it to gauge how much value the subscription is delivering, not as a bill.
- Rates are a static table in [`src/telemetry/pricing.ts`](./src/telemetry/pricing.ts) (cache reads at 0.1x input, cache writes at the 5-minute TTL rate of 1.25x input, the TTL the SDK uses). Verify against [claude.com/pricing](https://claude.com/pricing) after model launches or price changes.
- Models without a pricing entry are **excluded from the total** and flagged "no pricing" in the table rather than silently counted as $0.
- The landing page also shows an **Est. Cost (24h)** card next to Median TTFB and Error Rate.

### Overriding rates

The **Model Pricing** section on the Settings page (`/settings`) edits the rates without code changes:

- Edit any built-in model's rates to override them (marked "Override" with a Reset button).
- Add models the built-in table doesn't know about; they are priced immediately and stop showing as "no pricing".
- Cache read/write rates are optional when adding a model; they default to 0.1x and 1.25x of the input rate.

Overrides persist to `~/.config/meridian/model-pricing.json` (override the path with `MERIDIAN_PRICING_CONFIG`) and take effect on the next dashboard refresh, no restart needed. The API surface is `GET /settings/api/pricing`, `PUT /settings/api/pricing/:model`, and `DELETE /settings/api/pricing/:model`.

## Quick Health Check

```bash
# Live monitoring
tail -f ~/.cache/meridian/proxy.err | grep -E "cache=|TOKEN"

# Check last 10 requests
curl -s http://127.0.0.1:3456/telemetry/requests?limit=10 | \
  python3 -c "import sys,json; [print(f'{r[\"lineageType\"]:13} cache={r.get(\"cacheHitRate\",0)*100:.0f}% in={r.get(\"inputTokens\",\"?\")} out={r.get(\"outputTokens\",\"?\")}') for r in json.load(sys.stdin)]"

# Check for anomaly alerts
curl -s http://127.0.0.1:3456/telemetry/logs?category=token | python3 -m json.tool
```

## Anomaly Detection

Meridian automatically detects and alerts on three types of anomalies:

| Anomaly | Threshold | Severity | What to Do |
|---------|-----------|----------|------------|
| **Context spike** | Input tokens grew >60% in one turn | warn/critical | Check if session resume failed or a large tool result was injected |
| **Cache miss on resume** | Cache hit rate <5% on a continuation request | critical | Check tool ordering, system prompt changes, or SDK cache TTL expiry |
| **Output explosion** | Output tokens >2x the previous turn and >2000 | warn | Usually harmless (large file write), but investigate if unexpected |

Alerts appear in:
- Stderr: `[PROXY] <requestId> TOKEN ALERT: ...`
- Dashboard: Logs tab → Token filter
- API: `GET /telemetry/logs?category=token`
