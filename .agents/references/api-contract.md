---
id: api-contract
type: architecture-design
title: Stable public API and plugin contract
status: active
parent: architecture
---

# Plugin API boundaries

## Stable API Contract

External plugins depend on these interfaces. **Changes require project owner approval; an explicit request for that contract change supplies it.**

| Interface | Location | Used by |
|-----------|----------|---------|
| `startProxyServer(config)` → `ProxyInstance` | `server.ts` | Plugins that spawn proxy instances |
| `ProxyInstance.close()` | `types.ts` | Plugins for graceful shutdown |
| `initializeProxyBookkeeping()` → opaque `ProxyBookkeepingHandle` with `close(): Promise<void>` | `session/bookkeeping/embedding.ts`, exported by `server.ts` | Owner-approved #1277 opt-in SQL embedding; JSON returns undefined, native SQL/path/readers stay private, successful close joins admitted durable work |
| `clearSessionCache(): Promise<void>` | `session/cache.ts`, exported by `server.ts` | Owner-approved #1244/#1277 cleanup: reset memory immediately; await ordered durable cleanup, retaining its best-effort error policy |
| `ProxyConfig` type | `types.ts` | Plugin configuration |
| `x-opencode-session` header | `adapters/opencode.ts` | Session tracking from agent plugins |
| Generic OpenAI `x-session-id` on `/v1/chat/completions` | `adapters/openai.ts`, `server.ts` | Owner-approved #1441: distinct conversation identity after the existing OpenCode/session-affinity keys and agent scoping; blank values keep the headerless path |
| `x-meridian-profile` header | `server.ts`, `profiles.ts` | Per-request profile selection. A name matching no profile, alias or ChatGPT seat is answered `400 unknown_profile`; `default` keeps its old resolution (owner-approved 2026-11-16, #1529) |
| `GET /health` response shape | `server.ts` | Plugin health checks |
| `/health` `backend` field | `server.ts` / `backends/antigravity.ts` | Desktop provider compatibility check (#1073) |
| Antigravity `/v1/responses` and `/v1/responses/:id` | `backends/antigravityOpenai.ts`, `backends/antigravityResponses.ts` | OpenAI clients; bounded continuation/retrieval/deletion, optional durable state, background cancellation/event replay/input listing and input-token estimates (#1073) |
| `/providers/status` and `/antigravity/*` | `server.ts` / `backends/` | Shared provider UI and Antigravity clients (#1073) |
| `/health` `build` block | `buildInfo.ts` | Version/provenance drift detection |
| `/health` optional `build.latest` / `build.updateAvailable`, authenticated `GET` / `PUT /settings/api/updates` | `server.ts`, `updateCheck.ts`, `pluginUpdateCheck.ts` | Explicit opt-in registry checks and shared settings UI (#1226). Owner-approved 2026-10-26 (#1445): the response adds `plugins[]`, one entry per loaded plugin with `name`, `path`, `status`, `checkable`, `reason`, `package`, `installed`, `latest`, `updateAvailable`, `checkedAt`, `error` (optional fields absent when unknown); the list is present while the check is off, and the same `checkForUpdates` toggle governs sending plugin package names to the registry |
| `/health` optional `hostname`, authenticated `GET` / `PUT /settings/api/header` | `headerSettings.ts`, `server.ts`, `backends/antigravity.ts` | Default-off `showHostname` setting naming the machine in the shared header; owner-approved in #1259 |
| Authenticated `GET` / `PUT /settings/api/layout` | `server.ts`, `telemetry/pageLayout.ts` | Contained/wide page layout setting and shared settings UI |
| Authenticated `GET` / `PUT /settings/api/claude-executable`; `/health` `claudeExecutable.source` value `custom` | `claudeExecutableSettings.ts`, `claudeExecutablePreference.ts`, `models.ts` | System/bundled/custom Claude Code executable choice, applied to the next turn; same-origin browser writes; `MERIDIAN_CLAUDE_PATH` still wins |
| Authenticated `GET` / `PUT /settings/api/transcripts`; `transcriptRetentionDays` setting and `MERIDIAN_TRANSCRIPT_RETENTION_DAYS` | `transcriptRetentionSettings.ts`, `transcriptRetention.ts`, `query.ts` | Owner-approved 2026-10-27 (#1261). Opt-in, default off: unset passes no `cleanupPeriodDays`, so request children get exactly the pre-#1261 settings. 1-3650 passes that period to Claude Code's own cleanup in request children (never `0`); PUT accepts 1-3650, or `0`/`null` to turn it off; env `0` pins off. GET/PUT answer `{saved,effective{days,source},envOverride,envSources{transcriptRetentionDays},default,limits}` with `Cache-Control: no-store`; same-origin browser writes (403 otherwise). Owner-approved 2026-11-20 (#1551): with retention on, a Meridian-owned idle sweep runs Claude Code's cleanup in idle config roots every `MERIDIAN_TRANSCRIPT_SWEEP_INTERVAL_MS` (default 3 h, `0` off), none under `MERIDIAN_FOLLOW_ACTIVE`. No `ProxyServer`/`ProxyInstance` member; [behavior](../../docs/configuration.md#transcript-retention) |
| `POST /v1/sessions/:key/cache-beat`; `cacheKeepalive` setting value `"client"` and `MERIDIAN_CACHE_KEEPALIVE=client`; `MERIDIAN_CACHE_KEEPALIVE_MAX_BEATS` | `server.ts`, `cacheKeepalive.ts`, `settings.ts` | Owner-approved 2026-11-19 (#1518). Operator-chosen client mode: Meridian tracks keepalive-eligible sessions but beats only when a client asks. Answers `{session,outcome}` with `reached`, `retry`, `busy`, `stop`, `early`, `expired`, `untracked` or `disabled` (any mode other than `client`). Same per-period cap as automatic mode (default 3, `MAX_BEATS` at least 1), at least 20 minutes after the latest turn or beat, and the retry backoff after a failed beat. The session key must match exactly; [behavior](../../docs/configuration.md#client-requested-beats) |
| `GET /build-status` | `buildRuntime.ts` | Local/dev runtime versus disk provenance (#1170); optional API-key protection, npm returns 404 |
| `POST /v1/messages` request/response format | `server.ts` | All agents (Anthropic API contract) |
| `GET /v1/usage/quota/all` `bankedResets`; `POST /v1/usage/quota/reset` | `server.ts`, `oauthUsage.ts` | Owner-approved 2026-10-26 (#1429). Inventory: per profile `bankedResets{eligible,nextGrantId,ineligibleReason,grants[{id,resetsLeft,expiresAt,startsAt,paused,usableNow}]}` (epoch ms, unreadable values `null`; `null` block when unavailable or not OAuth). Redemption is explicit-only, never automatic or retried: body `{profile,grantId,requestId}` (all required, strict), API-key auth, same-origin browser writes, `Cache-Control: no-store`. 200 returns the IDs plus `result,reason,resetsLeft,cleared,weeklyResetsAt,cooldownUntil,replayed`; failures return `{code,error,indeterminate}`, plus `replayed` on every failure from a redemption attempt (validation, not-found, origin and 409 responses omit it; `replayed: true` only for a remembered outcome) with codes `invalid_request`, `profile_not_found`, `not_oauth`, `forbidden_origin`, `no_token`, `no_organization`, `upstream_auth`, `rate_limited`, `upstream_error`, `reset_indeterminate`, `invalid_response`, 409 `reset_in_progress` (another redemption for the profile in flight, nothing sent), 409 `request_id_conflict` (same requestId, different grantId). `indeterminate: true` means the grant may have been spent. Dispatched outcomes, uncertain ones included, are remembered per (profile, requestId) for 15 min (256 max) and replayed with `replayed: true` without an upstream call. Behavior corrections: inferred/mislabelled token profiles report type `oauth-token` / `not_oauth` on quota routes, and `/v1/usage/quota` returns `oauth: null` for non-`claude-max` targets; [contract](../../MONITORING.md#redeeming-a-banked-reset) |
| `GET /v1/usage/quota/all` per-grant scope metadata | `oauthResetGrants.ts`, `oauthUsage.ts` | Additive inventory fields: `kind` (`full`, `fable` or `unknown`), `providerType` (raw `type`), `clears` (provider window IDs), `givesBackWeekly` (raw flag), `description` (raw `label`) and `percentUsed` (per-window numbers in 0..100, not ratios). Provider fields are omitted when absent or unreadable; older followed instances may omit all six fields. See [banked reset scope](../../src/proxy/profiles-routing.spec.md#banked-reset-scope). Redemption and eligibility are unchanged. |
| `GET /v1/usage/quota/all` and `GET /v1/usage/quota` `extraUsage` amounts | `oauthUsage.ts`, `followUsage.ts`, `server.ts` | **Awaiting owner approval.** `monthlyLimit` and `usedCredits` are major units of `currency` (dollars for USD), converted from Anthropic's minor units; the added `exponent` (decimal places applied, normally 2) marks the converted shape, so a consumer that finds no `exponent` is reading an older Meridian that served cents. `usedCredits` may exceed `monthlyLimit`. |
| `GET /profiles/list` response shape | `server.ts` | Profile management UI and CLI |
| `GET /profiles/list` entries' `duplicateOf`, `duplicateBasis` and `factsRefresh` (`{state,since,at,error}` or `null`); a Claude entry's `email` from the account read | `server.ts`, `duplicateProfiles.ts`, `profileFactsRefresh.ts`, `organizationName.ts` | Owner-approved 2026-10-26 (#1446): additive, informational duplicate-account and post-sign-in status on every entry |
| `GET /profiles/list` owned ChatGPT entries' `renewalRetryAt` (epoch ms or `null`) | `chatgpt/owned.ts`, `chatgpt/profiles.ts`, `chatgpt/profileSurface.ts` | Owner-approved 2026-11-22 (#1523): additive; when Meridian next renews a seat whose access token chatgpt.com refused, `null` otherwise, including once renewing stops a day after the first refusal |
| `GET /profiles/list` entries' `authObtainedAt`, `authObtainedVia` (`login`/`observed`), `lastRefreshAt`, `firstUnauthedAt`, `unauthedReason` (`refresh_rejected`/`credentials_cleared`), each `null` when unknown; `loggedIn: false` once a refused grant's access token has expired; persistent `auth-lifecycle.json` and diagnostics category `auth` | `server.ts`, `authLifecycle.ts`, `tokenRefresh.ts` | Owner-approved 2026-11-22 (#1543, #1545): per-credential login history and logout records; history writes are best-effort and never awaited by a request; removing a profile deletes the history of the credential directories it removes; semantics in [profiles](../../docs/profiles.md#login-history) |
| `seatRenewalHours` in `GET` / `PATCH /settings/api/chatgpt` `features` (seat id -> hours 6-240; a PATCH names profiles, `null` removes) and each `seats[]` entry's `renewalHours`; `/profiles/list` ChatGPT entries' `renewalHours` (number or `null`) and `renewals` (`[{at, outcome, cause?, issuedAt?, expiresAt?}]`, oldest first) | `chatgpt/features.ts`, `chatgpt/profileSurface.ts`, `chatgpt/refresh.ts`, `server.ts` | Owner-approved 2026-11-22 (#1546), with a six-hour minimum interval. Additive and present only where ChatGPT is enabled. `outcome` is `rotated`, `kept`, `refused` or `unverified`; a seat Meridian does not own lists `null` and `[]`. Nothing changes for a seat without an interval |
| `GET /inflight` response shape and loopback-only access | `server.ts`, `inflight.ts` | Loopback supervisors observing `scope: client-http`; not a restart/admission barrier (#1216) |
| `POST`/`DELETE /drain` request/response and local operator access | `server.ts`, `admissionHold.ts` | Owner-approved #1282: bounded per-instance generation delay; actual loopback/no forwarding/no Origin, configured API key required; aggregate `draining`/`drain` in `GET /inflight`, no restart guarantee |
| `GET /readyz` status and `upstream-claude` check, `/health` `upstream.claude` block, loopback-only `PUT /upstream-reachability` | `server.ts`, `probes.ts`, `upstreamReachability.ts` | Instance-local native-Claude transport failure observations, default readiness policy and bounded operator override; owner-approved in #1281 |
| `POST /profiles/active` request/response | `server.ts` | Profile switching from CLI and UI |
| `POST /profiles/claude/remove` request/response | `server.ts`, `profileRemove.ts` | Profile management UI; same removal as `meridian profile remove`. Proposed in #1488, owner-approved 2026-11-16: body `{profile}`; same-origin browser writes and `MERIDIAN_CREDENTIALS_READONLY` (403); 400 invalid body; 409 `owned_elsewhere` for a configured or followed profile; 404 `unknown_profile`; 503 `store_write_failed`. 200 returns `success, profile, provider: "claude", activeProfile` (only when the pointer moved, `null` when none remain), `remaining`, `dirsOrphaned[{dir,reason}]` |
| ChatGPT additions: OpenAI model ids on `/v1/responses` routed to ChatGPT seats; new `POST /v1/images/generations` and `/v1/images/edits` (ChatGPT only, 404 without it); `/health` `chatgpt` and `backends`; `/profiles/list` entries with `type: "chatgpt"`, `activeProfiles`, `chatgpt.owner`; `provider` on `POST /profiles/active`; `chatgpt` in `GET /inflight`; `/profiles/chatgpt/*`, `/settings/api/chatgpt` | `server.ts`, `upstream/`, `backends/chatgpt.ts`, `chatgpt/` | Additive and absent unless `MERIDIAN_CHATGPT_CREDENTIALS` (or a populated owned store) enables ChatGPT; existing fields keep their meaning: `activeProfile` stays the Claude pointer wherever Claude profiles exist |
If you need to modify any of these, open an issue first — breaking changes affect downstream plugin authors.

The owner approved #1446's `/profiles/list` additions on 2026-10-26. Every
entry gains `duplicateOf` (ids of other profiles signed in to the same account,
`[]` when none), `duplicateBasis` (`account-organization`, `email-organization`,
`seat`, `workspace-email` or `null`) and `factsRefresh` (`null` when idle,
`{ state: "updating", since }` after a finished sign-in, or
`{ state: "failed", since, at, error }` for five minutes after its re-read
failed). A Claude entry's existing `email` now prefers the email
`GET /api/oauth/profile` reported for the credential the profile stores now
over `claude auth status`, which can still name the account signed in before.
The fields are informational: they do not change routing, cooldowns or any
other entry field.

The owner approved the generic OpenAI conversation-header contract in #1441
on 2026-10-21. `x-opencode-session` and `x-session-affinity` retain precedence
over `x-session-id`, including their existing agent scoping. A nonblank
`x-session-id` must be distinct per conversation and follows the same serialized,
append-only history, fork and retry behavior as the other explicit keys.
Other adapters retain their identity rules; request-body and CORS policy are
unchanged. Actual affected-flow evidence and final-head checks remain required.

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

The Pi extension (#1408, owner-approved) adds three client contracts: the
`pi1` generation on the existing `x-meridian-opencode-turn` header, signed with
the same `opencode-turn.key`/`MERIDIAN_OPENCODE_ATTESTATION_KEY` and accepted
only by the Pi adapter (OpenCode rejects it, and Pi rejects OpenCode
generations); `plugin.pi` (`"configured"`/`"not-configured"`) beside
`plugin.opencode` in `/health`; and `MERIDIAN_SOURCE` in a child Pi process's
environment, which the extension sends as `x-meridian-source`.

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

Antigravity token counts are planning estimates. `estimation.method` now
identifies the ASCII byte/4 estimate plus a conservative non-ASCII UTF-8 byte
allowance. Dense Unicode input can return a higher estimate and hit the per-step
guard at a lower byte count than under the previous byte-only policy. The
estimate does not include hidden CLI context or establish an exact tokenizer.
Owner-approved 2026-11-22 (#1567), together with cold replay dropping whole older
completed turns by default (with a note to the model) when history exceeds the
budget, and one default 480,000-token context budget (`MERIDIAN_AGY_MAX_CONTEXT_TOKENS`) for every model until it is
sized per model.

When Antigravity Messages (`/v1/messages`, `/v1/messages/count_tokens`) drops
unsupported hosted server tools without `input_schema` (`web_search_*`,
`web_fetch_*`, `code_execution_*`), the response exposes the comma-separated
`x-meridian-dropped-tools` header (the first 16 names) and total in
`x-meridian-dropped-tools-count` (and emits one bounded warning per request) without
changing `contractKey` or prompt rendering. Owner-approved 2026-11-22 (#1562),
together with accepting and ignoring numeric `temperature`, `top_p` and `top_k`
on the Antigravity path rather than rejecting them as #1074 did.

`antigravity.turnMaxDurationMs` (environment `MERIDIAN_AGY_TURN_MAX_DURATION_MS`,
default 7,200,000 ms) is an absolute per-turn deadline that includes client tool
waits and is passed to agy as `--print-timeout`; `turnTimeoutMs` now bounds each
model phase and pauses while client tools run. An agy process orphaned by a
Meridian crash may therefore survive up to this cap (previously 300 s).
Owner-approved 2026-11-22 (#1560).

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

Antigravity intentionally relaxes #1074's changed-delivered-history/batch rule:
a validated complete client history may retire and join its single idle owner
before cold replay, with matching model/session/execution controls and native
grants disabled. Known completed IDs without live owners may be included; active
responses and mixed live owners still conflict. This recovers production Claude
Code dropped-stream histories without re-executing the old pending call.
Exact consumed-result continuations can retry after joined 401/408/429/499/5xx
failures, before another client tool was delivered. Other deterministic failures
remain 409; failed fingerprint persistence logs an error and preserves the
original status and Retry-After. This is not exactly-once external execution. Owner-approved
2026-11-22 (#1561), on the condition that the recovery never re-executes a client
tool.

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
