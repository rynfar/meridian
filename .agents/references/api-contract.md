# Plugin API boundaries

## Stable API Contract

External plugins depend on these interfaces. **Changes require project owner approval; an explicit request for that contract change supplies it.**

| Interface | Location | Used by |
|-----------|----------|---------|
| `startProxyServer(config)` → `ProxyInstance` | `server.ts` | Plugins that spawn proxy instances |
| `clearSessionCache(): Promise<void>` | `server.ts` / `session/cache.ts` | Exported cache cleanup; await ordered durable cleanup (owner approved #1244 on 2026-10-02) |
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
| `GET /build-status` | `buildRuntime.ts` | Local/dev runtime versus disk provenance (#1170); optional API-key protection, npm returns 404 |
| `POST /v1/messages` request/response format | `server.ts` | All agents (Anthropic API contract) |
| `GET /profiles/list` response shape | `server.ts` | Profile management UI and CLI |
| `GET /inflight` response shape and loopback-only access | `server.ts`, `inflight.ts` | Loopback supervisors observing `scope: client-http`; not a restart/admission barrier (#1216) |
| `POST /profiles/active` request/response | `server.ts` | Profile switching from CLI and UI |
If you need to modify any of these, open an issue first — breaking changes affect downstream plugin authors.

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

The owner approved asynchronous `clearSessionCache()` completion in #1244 on
2026-10-02. Callers must migrate from `clearSessionCache(); next()` to
`await clearSessionCache(); next()` before depending on durable cleanup.
The in-memory reset starts immediately; the promise joins ordered store cleanup.
The existing best-effort cleanup error policy remains. This approval covers this
completion contract only.
