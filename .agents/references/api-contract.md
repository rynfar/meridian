# Plugin API boundaries

## Stable API Contract

External plugins depend on these interfaces. **Changes require project owner approval; an explicit request for that contract change supplies it.**

| Interface | Location | Used by |
|-----------|----------|---------|
| `startProxyServer(config)` → `ProxyInstance` | `server.ts` | Plugins that spawn proxy instances |
| `ProxyInstance.close()` | `types.ts` | Plugins for graceful shutdown |
| `ProxyConfig` type | `types.ts` | Plugin configuration |
| `x-opencode-session` header | `adapters/opencode.ts` | Session tracking from agent plugins |
| `x-meridian-profile` header | `server.ts`, `profiles.ts` | Per-request profile selection |
| `GET /health` response shape | `server.ts` | Plugin health checks |
| `/health` `backend` field | `server.ts` / `backends/antigravity.ts` | Desktop provider compatibility check (#1073) |
| Antigravity `/v1/responses` and `/v1/responses/:id` | `backends/antigravityOpenai.ts`, `backends/antigravityResponses.ts` | OpenAI clients; bounded continuation/retrieval/deletion, optional durable state, background cancellation/event replay/input listing and input-token estimates (#1073) |
| `/providers/status` and `/antigravity/*` | `server.ts` / `backends/` | Shared provider UI and Antigravity clients (#1073) |
| `/health` `build` block | `buildInfo.ts` | Version/provenance drift detection |
| `/health` optional `build.latest` / `build.updateAvailable`, authenticated `GET` / `PUT /settings/api/updates` | `server.ts`, `updateCheck.ts` | Explicit opt-in registry checks and shared settings UI (#1226) |
| `/health` optional `hostname`, authenticated `GET` / `PUT /settings/api/header` | `headerSettings.ts`, `server.ts`, `backends/antigravity.ts` | Default-off `showHostname` setting naming the machine in the shared header; owner-approved in #1259 |
| Authenticated `GET` / `PUT /settings/api/layout` | `server.ts`, `telemetry/pageLayout.ts` | Contained/wide page layout setting and shared settings UI |
| Authenticated `GET` / `PUT /settings/api/claude-executable`; `/health` `claudeExecutable.source` value `custom` | `claudeExecutableSettings.ts`, `claudeExecutablePreference.ts`, `models.ts` | System/bundled/custom Claude Code executable choice, applied to the next turn; same-origin browser writes; `MERIDIAN_CLAUDE_PATH` still wins |
| `GET /build-status` | `buildRuntime.ts` | Local/dev runtime versus disk provenance (#1170); optional API-key protection, npm returns 404 |
| `POST /v1/messages` request/response format | `server.ts` | All agents (Anthropic API contract) |
| `GET /v1/usage/quota/all` `bankedResets`; `POST /v1/usage/quota/reset` | `server.ts`, `oauthUsage.ts` | Per-profile grant inventory and explicit redemption; required profile/grant/request IDs, authenticated same-origin browser writes, no automatic mutation retries. Owner-requested in #1429; [contract](../../MONITORING.md#redeeming-a-banked-reset) |
| `GET /profiles/list` response shape | `server.ts` | Profile management UI and CLI |
| `GET /inflight` response shape and loopback-only access | `server.ts`, `inflight.ts` | Loopback supervisors observing `scope: client-http`; not a restart/admission barrier (#1216) |
| `POST`/`DELETE /drain` request/response and local operator access | `server.ts`, `admissionHold.ts` | Owner-approved #1282: bounded per-instance generation delay; actual loopback/no forwarding/no Origin, configured API key required; aggregate `draining`/`drain` in `GET /inflight`, no restart guarantee |
| `GET /readyz` status and `upstream-claude` check, `/health` `upstream.claude` block, loopback-only `PUT /upstream-reachability` | `server.ts`, `probes.ts`, `upstreamReachability.ts` | Instance-local native-Claude transport failure observations, default readiness policy and bounded operator override; owner-approved in #1281 |
| `POST /profiles/active` request/response | `server.ts` | Profile switching from CLI and UI |
| ChatGPT additions: OpenAI model ids on `/v1/responses` routed to ChatGPT seats; new `POST /v1/images/generations` and `/v1/images/edits` (ChatGPT only, 404 without it); `/health` `chatgpt` and `backends`; `/profiles/list` entries with `type: "chatgpt"`, `activeProfiles`, `chatgpt.owner`; `provider` on `POST /profiles/active`; `chatgpt` in `GET /inflight`; `/profiles/chatgpt/*`, `/settings/api/chatgpt` | `server.ts`, `upstream/`, `backends/chatgpt.ts`, `chatgpt/` | Additive and absent unless `MERIDIAN_CHATGPT_CREDENTIALS` (or a populated owned store) enables ChatGPT; existing fields keep their meaning: `activeProfile` stays the Claude pointer wherever Claude profiles exist |
If you need to modify any of these, open an issue first — breaking changes affect downstream plugin authors.

The owner approved executable selection in #1319 on 2026-10-08. System remains
the default; `MERIDIAN_CLAUDE_PATH` has highest priority. The authenticated
GET/PUT uses no-store responses and the existing same-origin browser-write
policy. Custom paths must be absolute and pass a bounded shell-free version
check. Changes apply to subsequent turns; a started turn retains its selected
path through retries. Concurrent selection changes during vetting return 409;
cancelled/unconfirmed path-vetting probes return 503 before saving the choice. The health
contract adds only `custom` to the existing executable-source enum.

As with an HTTP write whose response is interrupted, a completed preference
write is not rolled back if a subsequent state-description probe or disconnect
fails. Read GET to confirm the saved preference after an ambiguous response.

The hostname contract was approved by the owner on 2026-10-04 in #1259's
review conversation. Claude and standalone Antigravity share the persisted
setting and header API behind their existing optional API-key gate. Only an
explicit boolean `true` adds the OS hostname to unauthenticated `/health`;
`false` hides it, `null` removes the stored field, and an omitted field is a
no-op. `/livez` and `/readyz` retain their existing contracts. Header settings
and health use `Cache-Control: no-store`, and consent is re-read after health
probes. Browser writes require the same origin, with a bounded HTTPS-origin
bridge for an HTTP TLS-termination hop that preserves public Host/port
(including explicit default 443). Foreign/opaque/malformed origins and
different ports are rejected; forwarding headers confer no trust.

Antigravity additionally accepts `statePath`, `plugins` and `pluginPaths` under its
backend options. These are provider-specific and do not change Claude plugin
contracts. Persistence is opt-in and bounded; background jobs are not restart
resumable. `AntigravityPlugin` request results are revalidated and response/telemetry
observers cannot mutate saved responses. Owner authorization is tracked in #1073.

`antigravity.adaptThinkingBudgets` (environment
`MERIDIAN_AGY_ADAPT_THINKING_BUDGETS=1`) explicitly enables approximate mapping
of Anthropic numeric thinking budgets to Gemini effort variants. Response headers
and health expose adaptation; effective model IDs appear in responses and telemetry.
Strict rejection remains the default; this does not provide native token limits.

Antigravity Messages exact tool-result retries may return a bounded saved terminal
text answer with `x-meridian-response-replayed: true`, preserving message ID and
usage without a new model invocation. This cache is separate from OpenAI Responses
storage and does not change `store: false`. Explicit `idempotency-key` headers or
`meridian_request_id` body fields additionally enable scoped tool-batch/ordinary-turn
replay. Reusing an ID for a changed request is 409; consumed/in-progress tool
results prohibit redelivery of the old call. IDs are bounded and snapshots share
the existing answer budget. Native-grant requests are excluded. This is bounded
request idempotency, not an exactly-once client-tool execution contract; see the
backend guide and integrations for supported retry boundaries (#1073).

Identified Antigravity Messages requests may set `x-meridian-replay-only: true`
to recover a saved response without starting generation. The same fingerprint,
credential scope and consumed-tool checks apply; a missing snapshot returns 404.
The header requires an explicit request ID and native grants disabled; invalid
values and non-Anthropic use are rejected. JSON/SSE selection may change.
This supports the OpenCode incremental-text recovery integration (#1073).

With Antigravity state persistence, identified Messages requests without a saved
response after an unclean restart return HTTP 409 with recovery guidance. A
hash-only unfinished-request journal is bounded to 128 entries/30 minutes; clean
cleanup removes entries, and full admission returns 429 rather than evicting an
unresolved guard. This is not active-process restoration or client-tool execution
journaling. Failed official read-only probes impose a five-second readiness
cooldown with HTTP 503 and Retry-After. Both changes are within #1073's recovery
and failure-handling scope.

The owner approved #1281's corrected full reachability contract on 2026-10-05.
Claude/combined health adds aggregate `upstream.claude` observations without raw
errors or account identities. The state is local and ephemeral; configured-egress
transport answers do not prove Anthropic origin, account validity or inference.
Default readiness requires three definite connection failures spanning 120 seconds
and holds until 300 seconds after the latest failure; the subsequent probing state
is passive. Null retry statuses and generic read timeouts do not establish failure.
The loopback override has optional configured-key protection, the exact existing
hostname Origin policy and a bounded TTL; no public ProxyConfig or global CORS
expansion is approved. Standalone/mounted Antigravity probes remain unchanged.
Correctness, actual affected-flow evidence and final-head CI remain acceptance
gates distinct from this approval. No release is authorized.
