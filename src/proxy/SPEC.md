---
id: proxy-core
type: module-design
status: active
title: Proxy core (HTTP orchestration and Claude request path)
parent: architecture
depends-on: [adapters, session, profiles-routing, plugins, antigravity-backend, chatgpt-backend, telemetry-ui]
references: [api-contract]
---

## Responsibility

The server and the default Claude request path:

- `server.ts` — owns the public listener and route registration (it mounts the
  Hono sub-app built in `telemetry/routes.ts`; adapters and `auth` use Hono's
  `Context` type only), backend selection
  (`claude` / `antigravity` / `combined`), request orchestration, SSE
  streaming, health/readiness, settings and operator routes;
- the Claude turn: SDK query options (`query.ts`), model mapping (`models.ts`),
  content normalization and sanitizing, passthrough tool forwarding, replay
  rendering, structured output, idle/stall guards;
- admission and lifecycle: concurrency semaphore, generation admission and the
  `/drain` hold, per-request abort, `sessionTree.ts` subtree cancellation,
  shutdown drain, upstream reachability;
- errors and throttling (`errors.ts`, `retryAfter.ts`, `sseFailureSniff.ts`);
- protocol translation (`openai.ts`, `openaiResponses.ts`) and build
  provenance / update check (`build*.ts`, `updateCheck.ts`, and
  `pluginUpdateCheck.ts` for loaded plugins' npm packages in the same opt-in
  pass — see [`plugins`](plugins/SPEC.md));
- process-level services beside it: settings/config (`src/settings.ts`,
  `src/configDir.ts`, `src/headerSettings.ts`, `src/sameOrigin.ts`), logging,
  MCP tool definitions (`src/mcpTools.ts`) and opt-in crash reporting
  (`src/errorReporting/`, off without a DSN and never changes whether the
  process dies).

## Boundary

- `server.ts` **orchestrates**; route handlers stay thin and delegate to
  extracted modules. New pure logic becomes a new leaf module with unit tests.
- Leaf modules (`errors`, `retryAfter`, `toolInputJson`, `models`, `tools`,
  `messages`, `profiles`, `profileCli`, `buildInfo`, `updateCheck`,
  `pluginUpdateCheck`, `sseFailureSniff`) never import `server.ts`, `session/` or `adapter.ts`;
  `buildInfo`, `retryAfter`, `toolInputJson` are additionally pure.
- `query.ts` builds SDK options **through the adapter interface**, never from
  tool constants directly.
- No `as any`, `@ts-ignore`, `@ts-expect-error` or empty catch blocks.

The full file-level rules, throttling and cancellation contracts are in
[`architecture`](../../ARCHITECTURE.md) → *Dependency Rules*, *Throttling
Contract*, *Cancellation Contract*; public routes and headers are in
[`api-contract`](../../.agents/references/api-contract.md).

## Decisions

- **OpenAI Responses (`/v1/responses`) for Codex** is pure translation
  forwarded in-process to `/v1/messages`, reusing auth, model mapping, sessions
  and the tool loop.
  - Only developer messages **before** the conversation starts fold into
    `system`; later ones stay in history, because rewriting `system` invalidated
    the whole prompt cache (observed 14/14 collapses).
  - Incoming reasoning items are dropped; when reasoning is requested an empty
    placeholder reasoning item is emitted, because Codex 0.144 hangs without
    one. Cross-turn thinking comes from SDK session resume, one session per
    Codex thread: turn metadata comes from the `x-codex-turn-metadata` header,
    else the body's `client_metadata`; the key is its `thread_id`, else
    `prompt_cache_key`. Spawned subagent threads (which inherit the parent's
    `prompt_cache_key`) and side requests such as `compact` or `title` get
    keys of their own, because keying them on the thread alone made them
    rewrite the live conversation's session.
  - A mid-stream upstream error emits `response.failed` so Codex does not hang.
  - Codex is a tool-driving client, so this path always runs in passthrough.
- **OpenAI Chat Completions:** unkeyed clients get prior turns packed into one
  history block (full history every turn would otherwise read as undo or
  divergence); clients with a recognized session key keep real history so
  lineage can resume.
- **Per-model 1M override.** `[1m]` stays the default for Opus and Fable;
  `MERIDIAN_OPUS_MODEL=opus` / `MERIDIAN_FABLE_MODEL=fable` opt a tier out
  (Mythos follows Fable). Values are normalized; an unrecognized value warns
  once and keeps the default, because with Extra Usage enabled a silent 1M
  choice is silently billed. A generic multi-tier switch was rejected.
- **Passthrough tool sets are shared by content, never by lifetime.** Sessions
  sending identical tools share one built definition set (#1410) and one raw
  tool list (#1444), found through process-wide indexes keyed by a digest of
  the exact bytes (tool, key and schema property order included) and held by
  `WeakRef`: an index never keeps anything alive, so the session caches alone
  bound memory. Measured with a 230-tool OpenCode list in isolated harnesses
  (not whole-server memory): built sets from about 20 MiB per session to one
  shared set; the remaining per-session heap from about 1 MiB to about 80 KiB. Shared values are read-only; each query still
  builds its own MCP server from them.
- **A client that defers tools is never auto-deferred; one that also brings
  its own `ToolSearch` gets the only search path.** The session pin holds the
  auto-defer answer (#861), so a threshold crossing cannot flip the tool
  block, `ENABLE_TOOL_SEARCH` or `maxTurns` mid-session. With a client
  `ToolSearch` (Claude Code): eager tools stay registered, a deferred tool
  joins them eagerly once referenced, unreferenced ones stay unregistered,
  Meridian adds no inner ToolSearch, `tool_reference` blocks reach the model
  as text naming the registered tool (a copied client name is undispatchable,
  #1107), and each discovery re-primes the prompt cache by changing the
  registered set. Other client-deferral keeps the inner ToolSearch and maps
  `tool_reference` names to the registered names at a checkpoint.
- **Transcript retention is opt-in and delegated to Claude Code (#1261,
  owner decision 2026-10-27).** Meridian's empty `settingSources` (#490/#634)
  also skips Claude Code's retention cleanup, so transcripts Meridian's own GC
  no longer tracks accumulate. `MERIDIAN_TRANSCRIPT_RETENTION_DAYS` /
  `transcriptRetentionDays` (1-3650; env `0` pins off) pass `cleanupPeriodDays`
  as a flag setting to request children; unset passes nothing, so an
  unconfigured instance sends exactly what it did before. `0` is never sent:
  Claude Code validates the key as a positive integer and older versions read
  `0` as "write no transcripts".
  - *Why opt-in:* the cleanup deletes every file of its kind older than the
    period in the whole config directory (transcripts Meridian still maps or
    pins, file history, plans, tasks, uploads, shell snapshots, debug logs,
    backups…), by mtime only, and can race a resume (`session` → *Known
    limitations*). That is a data-deletion choice for the operator.
  - *Why no Meridian-owned sweep yet:* the proposed idle sweep launched a
    promptless Claude Code child per profile root without process custody (its
    SDK slot was released before the child was joined, `close()` could succeed
    with it unjoined, root reservation raced) and exported
    `ProxyServer.transcriptSweep` without contract approval. Retention
    therefore runs only inside request children; a profile that serves no
    requests is not cleaned.
  - *Follow-ups:* a pin-aware transcript GC that honors durable mappings and
    publication leases, then an idle sweep with full process custody (slot held
    until the child is joined, joined on close, atomic root reservation).
  - Settings writes are same-origin only (`transcriptRetentionSettings.ts`).
- **`max_tokens` is not enforced by default:** the Agent SDK exposes no output
  cap, and the CLI's cap counts thinking plus text, so an answer-sized cap can
  leave no room for an answer. `MERIDIAN_ENFORCE_MAX_TOKENS=1` honors it exactly.
- **Prompt-cache keepalive** (#1193, contributed by @XInTheDark, redesigned
  with the owner 2026-10-26; `cacheKeepalive.ts` schedules, pure;
  `cacheKeepaliveRunner.ts` sends one beat).
  - *Measured TTL.* On the owner's Max account through the Agent SDK, turn 1
    wrote 42,663 tokens to the one-hour tier (`ephemeral_1h_input_tokens`,
    `ephemeral_5m_input_tokens: 0`) and turn 2, after 7 idle minutes, read all
    of them from cache (evidence `1193-cache-ttl-20261026`). The contributor's
    five-minute model therefore beat subscription sessions twelve times an
    hour for nothing; the benefit is only for idles longer than an hour.
  - *Operator switch, no header.* Off by default; `MERIDIAN_CACHE_KEEPALIVE`
    (wins) or the `cacheKeepalive` setting, re-read per turn and per tick. A
    beat is billed background traffic, so the operator decides; the
    contributor's `x-meridian-cache-keepalive` header was dropped rather than
    added to the public contract.
  - *Eligibility from usage.* Only a real turn of a keyed passthrough session
    on a `claude-max` profile is tracked, and only while its latest turn wrote
    the one-hour tier (any five-minute write, no tier breakdown, or a failed
    turn stops tracking; a pure cache read keeps the current period). A
    five-minute prefix would expire long before a beat.
  - *55 minutes, 3 beats.* One beat 55 minutes after the latest real turn
    started, and 55 minutes after each reached beat: five minutes of margin
    under the hour for tick jitter (10 s), the 15 s settle after a new
    mapping, a retry, and SDK start-up. At most three per idle period (≈3 h)
    bounds the cost of a session that never comes back. A real turn ends the
    period (and no beat runs while one is running); auxiliary/independent
    requests never touch the schedule.
  - *Main conversations only.* Subagent and one-shot requests (OpenCode's
    title and summary, delegated children) are never tracked: the live A/B
    showed OpenCode's title request keyed apart and carrying the full prefix,
    so a beat on it cost as much as the useful one for a conversation never
    resumed. They do not forget the key either, because an older V2 plugin
    sends compaction as a subagent source under the primary key.
  - *Measured* (2026-10-27, OpenCode 1.18.34, Sonnet 5.5, Max account, ~90k
    token unique prefix, 65 min idle): without keepalive the next turn
    rewrote 86,385 tokens; with it, one beat at 55.3 min read 90,018 and the
    next turn read 90,018 and wrote 340, about 89% cheaper in input-token
    equivalents net of the beat.
  - *Never on someone's money or an exhausted window.* No beat on API-key or
    token profiles, while any live window reports `isUsingOverage`, a
    rejected or fully used window, priority cooldown, a spent refusal, or a
    `[1m]` bench for the session's model. A beat always uses the profile the
    mapping was published under (the mapping key is profile-scoped) and never
    routes or fails over; a blocked beat retries 30 s later.
  - *Same lifecycle as a turn.* Beats run through `runGatedSdkQuery`, the
    gated, joined core of `runSdkQueryAttempt`: process gate, close and join,
    permit released only after the join. A beat takes no writer lease (it
    writes nothing and must not refuse a real turn on the same transcript);
    it pins the source transcript against GC until joined. Beats count in
    `getInFlightCount`, `beginDrain` aborts them, and `closeBackend` waits for
    them, so no CLI child is orphaned.
  - *Never ahead of real turns.* A beat takes an SDK permit only with
    `tryAcquire(1)`: never queued, never ahead of a waiter, never the last free
    permit; otherwise it is skipped and retried. A global in-flight cap
    (default 1, at most 2) bounds beats across sessions.
  - *Read-only.* `forkSession: true`, `persistSession: false`, `maxTurns: 1`,
    `DISABLE_AUTO_COMPACT`, stopped at `message_start`: no transcript, mapping
    or lineage change. A beat that read nothing (cache already gone) or wrote
    the five-minute tier stops tracking instead of paying again.
  - *The tier is a fact of the request upstream received.* A turn's tier is
    read from the usage it reported, whatever ended it: a tool-boundary stop
    (the single-turn cap's `max_turns`, the single-step abort) keeps the
    session tracked, since an agent waiting at a tool call is the main case.
    Only a client abort, which evicts the session, drops tracking.

## Codex Responses wire contract

Captured from real Codex 0.143 traffic; a stand-in server emitting exactly these
events drove a clean Codex turn. Tests mirror these shapes.

```
request  model, instructions (~21KB), input[ message(developer|user|assistant,
         input_text|output_text) | function_call | function_call_output |
         reasoning ], tools[function, strict, parameters], tool_choice:"auto",
         parallel_tool_calls:true, reasoning{effort}, text{verbosity},
         stream:true, store:false, include:["reasoning.encrypted_content"],
         prompt_cache_key, client_metadata (carries the x-codex-turn-metadata
         fallback used for thread keying)
response response.created → response.in_progress → output_item.added →
         content_part.added → output_text.delta* → output_text.done →
         content_part.done → output_item.done → response.completed{usage}
         tool call: output_item.added(function_call) →
         function_call_arguments.delta*/.done → output_item.done
```

## Known limitations

- **Keepalive needs two SDK slots.** A beat never takes the last free permit,
  so with `MERIDIAN_MAX_CONCURRENT=1` keepalive never runs.
- **Keepalive tracking is unbounded in count.** Each tracked session holds its
  latest request recipe (system prompt, tool definitions) for up to about
  three idle hours; a busy shared instance with keepalive on holds one per
  active session.
- **Bun misses early disconnects:** under Bun the HTTP server does not notice a
  client that leaves before the first byte (a startup warning says so).
- **Anthropic server tools** (`web_search_*`, `web_fetch_*`) cannot be produced
  through the subscription path and are rejected with a 400.
- **Implicit SDK attachments** in passthrough are suppressed by default
  (`CLAUDE_CODE_DISABLE_ATTACHMENTS=1`), which also bypasses the CLI's
  kept-deferred-tools optimization.
- **Passthrough turns default to `maxTurns=1`** to stop at the tool boundary;
  the client must send another request after executing tools.

Further user-visible limitations: `docs/configuration.md` → *Known
limitations*.
