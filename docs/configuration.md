# Configuration

[← Back to README](../README.md)

Environment variables, endpoints, authentication, SDK feature toggles, passthrough mode, and CLI commands.

## Configuration

| Variable | Alias | Default | Description |
|----------|-------|---------|-------------|
| `MERIDIAN_API_KEY` | — | unset | Shared secret for API key authentication. When set, all API and admin routes require a matching `x-api-key` or `Authorization: Bearer` header. `/` and `/health` remain open. |
| `MERIDIAN_PORT` | `CLAUDE_PROXY_PORT` | `3456` | Port to listen on |
| `MERIDIAN_HOST` | `CLAUDE_PROXY_HOST` | `127.0.0.1` | Host to bind to |
| `MERIDIAN_PASSTHROUGH` | `CLAUDE_PROXY_PASSTHROUGH` | unset | Forward tool calls to client instead of executing |
| `MERIDIAN_MAX_CONCURRENT` | `CLAUDE_PROXY_MAX_CONCURRENT` | `10` | Maximum SDK queries running concurrently within one Meridian process |
| `MERIDIAN_MAX_SESSIONS` | `CLAUDE_PROXY_MAX_SESSIONS` | `1000` | In-memory LRU session cache size |
| `MERIDIAN_MAX_STORED_SESSIONS` | `CLAUDE_PROXY_MAX_STORED_SESSIONS` | `10000` | File-based session store capacity |
| `MERIDIAN_WORKDIR` | `CLAUDE_PROXY_WORKDIR` | `cwd()` | Default working directory for SDK |
| `MERIDIAN_IDLE_TIMEOUT_SECONDS` | `CLAUDE_PROXY_IDLE_TIMEOUT_SECONDS` | `120` | HTTP keep-alive timeout |
| `MERIDIAN_SHUTDOWN_GRACE_MS` | `CLAUDE_PROXY_SHUTDOWN_GRACE_MS` | `30000` | Milliseconds `close()` waits for in-flight `/v1/messages` requests to finish after it stops admitting new ones, before closing the port. See [Graceful shutdown](#graceful-shutdown). |
| `MERIDIAN_SESSION_TURN_MAX_HOLD_MS` | `CLAUDE_PROXY_SESSION_TURN_MAX_HOLD_MS` | `600000` | Hard ceiling on how long one turn may hold its session's serialization lease. On timeout the lease is force-released with a warning and queued turns for that session proceed concurrently. See [Concurrent requests to the same session](#concurrent-requests-to-the-same-session). |
| `MERIDIAN_TELEMETRY_SIZE` | `CLAUDE_PROXY_TELEMETRY_SIZE` | `1000` | Telemetry ring buffer size |
| `MERIDIAN_NO_FILE_CHANGES` | `CLAUDE_PROXY_NO_FILE_CHANGES` | unset | Disable "Files changed" summary in responses |
| `MERIDIAN_STRIP_THINKING` | `CLAUDE_PROXY_STRIP_THINKING` | unset | Set to `1` to strip raw `<thinking>` tags from user-authored prompt text. Off by default — `<thinking>` is a common chain-of-thought convention in hand-written prompts (#720); enable only if your harness is observed leaking it verbatim. |
| `MERIDIAN_SONNET_MODEL` | `CLAUDE_PROXY_SONNET_MODEL` | `sonnet` | Sonnet context tier: `sonnet` (200k, default) or `sonnet[1m]` (1M, requires Extra Usage†). Not to be confused with `MERIDIAN_DEFAULT_SONNET_MODEL` below, which pins a concrete model id, not a context tier. |
| `MERIDIAN_FABLE_MODEL` | `CLAUDE_PROXY_FABLE_MODEL` | `fable[1m]` | Fable context tier opt-out: set to `fable` to disable the 1M extended context window and stay on the 200k base variant (also governs Mythos, which rides the Fable tier). `fable[1m]` is a documented no-op. Not to be confused with `MERIDIAN_DEFAULT_FABLE_MODEL` below, which pins a concrete model id, not a context tier. |
| `MERIDIAN_OPUS_MODEL` | `CLAUDE_PROXY_OPUS_MODEL` | `opus[1m]` | Opus context tier opt-out: set to `opus` to disable the 1M extended context window and stay on the 200k base variant. `opus[1m]` is a documented no-op. Not to be confused with `MERIDIAN_DEFAULT_OPUS_MODEL` below, which pins a concrete model id, not a context tier. |
| `MERIDIAN_1M_CONTEXT_SUPPORT` | `CLAUDE_PROXY_1M_CONTEXT_SUPPORT` | unset | Set to `0`/`false`/`no` to disable 1M context entirely — every model resolves to its 200k base variant, so Meridian never requests the extended window (avoids Extra Usage on 1M). To opt out a single tier instead, use `MERIDIAN_FABLE_MODEL` or `MERIDIAN_OPUS_MODEL` above. |
| `MERIDIAN_DEFAULT_AGENT` | — | `opencode` | Default adapter for unrecognized agents: `opencode`, `forgecode`, `pi`, `crush`, `droid`, `cherry`, `claudecode`, `passthrough`. Requires restart. |
| `MERIDIAN_ROUTING` | — | `active` | Session-to-profile routing: `active` (all traffic to the active profile), `sticky` ([sticky session routing](profiles.md#sticky-session-routing)), or `priority` ([priority failover](profiles.md#priority-failover-routing)) |
| `MERIDIAN_PROFILE_ORDER` | — | *(config order)* | Priority-mode pool order, comma-separated, highest priority first (e.g. `work,personal`). Also editable at `/settings`. |
| `MERIDIAN_PASSTHROUGH_EARLY_STOP` | — | `1` | Set to `0` to disable [digest-turn elimination](#how-tool-calling-works-in-passthrough) and restore the old end-of-turn behavior |
| `MERIDIAN_SILENT_TURN_RECOVERY` | `CLAUDE_PROXY_SILENT_TURN_RECOVERY` | `1` | Set to `0` to stop spending a recovery turn on a [silent turn](#silent-turns). Detection and telemetry stay on either way |
| `MERIDIAN_UPSTREAM_IDLE_MS` | `CLAUDE_PROXY_UPSTREAM_IDLE_MS` | `90000` | Milliseconds the upstream stream may go quiet before the turn is treated as stalled. Raise it for long-thinking turns that were being killed mid-flight; `0` disables the guard entirely. Applies to the recovery turn too. |
| `MERIDIAN_SUPPRESS_SCRATCHPAD` | — | `1` | Set to `0` to let the SDK advertise its proxy-host scratchpad directory in passthrough mode |
| `MERIDIAN_PRICING_CONFIG` | `CLAUDE_PROXY_PRICING_CONFIG` | `~/.config/meridian/model-pricing.json` | Path to the model pricing overrides file used by cost estimation |
| `MERIDIAN_PROFILES` | — | unset | JSON array of profile configs (overrides disk discovery). See [Multi-Profile Support](profiles.md). |
| `MERIDIAN_DEFER_TOOL_THRESHOLD` | — | `15` | Number of tools before non-core tools are deferred via ToolSearch. Set to `0` to disable. |
| `MERIDIAN_TELEMETRY_PERSIST` | `CLAUDE_PROXY_TELEMETRY_PERSIST` | unset | Enable SQLite telemetry persistence. Data survives proxy restarts. |
| `MERIDIAN_TELEMETRY_DB` | `CLAUDE_PROXY_TELEMETRY_DB` | `~/.config/meridian/telemetry.db` | SQLite database path (when persistence is enabled) |
| `MERIDIAN_TELEMETRY_RETENTION_DAYS` | `CLAUDE_PROXY_TELEMETRY_RETENTION_DAYS` | `7` | Days to retain telemetry data before cleanup |
| `MERIDIAN_DEFAULT_PROFILE` | — | *(first profile)* | Default profile ID when no header is sent |
| `MERIDIAN_ADAPTER_INSTANCES` | — | unset | JSON [adapter instance](agents.md#adapter-instances) definitions, overriding `~/.config/meridian/adapter-instances.json` |
| `MERIDIAN_BETA_POLICY` | — | `allow-safe` | Client `anthropic-beta` header handling: `allow-safe`, `strip-all`, or `allow-all` |
| `MERIDIAN_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL` | — | canonical ids | Pin the model id the SDK resolves for each tier alias (e.g. `MERIDIAN_DEFAULT_OPUS_MODEL`) |
| `MERIDIAN_SESSION_DIR` | `CLAUDE_PROXY_SESSION_DIR` | `~/.cache/meridian` | Directory for the persisted session store |
| `MERIDIAN_DEBUG` | `CLAUDE_PROXY_DEBUG` | unset | Set to `1` for verbose request/session logging |
| `MERIDIAN_SILENT` | `CLAUDE_PROXY_SILENT` | unset | Set to `1` to suppress startup output (used by embedding plugins) |
| `MERIDIAN_PLUGIN_DIR` | — | `~/.config/meridian/plugins` | Plugin auto-discovery directory |
| `MERIDIAN_PLUGIN_CONFIG` | — | `~/.config/meridian/plugins.json` | Plugin manifest path |

†Sonnet 1M requires Extra Usage on all plans including Max ([docs](https://code.claude.com/docs/en/model-config#extended-context)). Opus 1M is included with Max/Team/Enterprise at no extra cost. Fable 1M is also included at no Extra Usage cost, verified live on both Max and Team.

### Subprocess traffic

Meridian runs the Claude Code CLI as a headless subprocess, so it sets these
on that process by default:

| Variable | Effect |
|---|---|
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Usage metrics, error reports, feedback uploads, session-quality surveys |
| `DISABLE_TELEMETRY` | Usage metrics |
| `DISABLE_ERROR_REPORTING` | Crash reports to the third-party error tracker |
| `DISABLE_FEEDBACK_COMMAND` | `/feedback`, `/bug`, `/share` uploads |
| `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` | Session-quality survey |
| `DISABLE_AUTOUPDATER` | CLI self-update underneath a running proxy |
| `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` | Plugin marketplace auto-install |

Nobody reads a headless subprocess's usage metrics, its crash reports describe
a process the operator never launched by hand, and the feedback commands have
no interactive session to report on. An auto-update mid-run is version skew,
not a feature.

Any value set in Meridian's own environment wins, including setting one of
these to `0` to opt back in.

One thing these do not cover: before WebFetch retrieves a URL, the subprocess
sends the target hostname to `api.anthropic.com` to check it against a safety
blocklist. That check is deliberately exempt from
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` upstream and is unaffected here.
It has its own per-adapter switch — see [WebFetch preflight](#webfetch-preflight)
— though it only reaches the wire on the `cherry` adapter, since no other
adapter lets the subprocess run the built-in WebFetch at all.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Landing page |
| `POST /v1/messages` | Anthropic Messages API |
| `POST /messages` | Alias for `/v1/messages` |
| `POST /v1/chat/completions` | OpenAI-compatible chat completions |
| `POST /v1/responses` | OpenAI Responses API (Codex CLI ≥ 0.96) |
| `GET /v1/models` | OpenAI-compatible model list |
| `GET/POST /v1/design/*` | Claude Design MCP proxy (see [Claude Design MCP](agents.md#claude-design-mcp)) |
| `GET/POST /design-login` | OAuth flow for the design scopes |
| `GET /health` | Auth status, mode, plugin status |
| `POST /auth/refresh` | Manually refresh the OAuth token |
| `GET /telemetry` | Performance dashboard |
| `GET /telemetry/requests` | Recent request metrics (JSON) |
| `GET /telemetry/summary` | Aggregate statistics (JSON) |
| `GET /telemetry/logs` | Diagnostic logs (JSON) |
| `GET /metrics` | Prometheus exposition format metrics |
| `GET /profiles` | Profile management page |
| `GET /profiles/list` | List profiles with auth status (JSON) |
| `POST /profiles/active` | Switch the active profile |
| `GET /v1/usage/quota` | Usage windows for the active profile (JSON) |
| `GET /v1/usage/quota/all` | Usage windows for every profile (JSON) |
| `GET /settings` | SDK feature toggles + model pricing UI |
| `GET /plugins` | Plugin management page (`/plugins/list`, `POST /plugins/reload` for JSON/actions) |

Health response example:

```json
{
  "status": "healthy",
  "version": "1.50.0",
  "auth": { "loggedIn": true, "email": "you@example.com", "subscriptionType": "max" },
  "mode": "internal",
  "plugin": { "opencode": "configured" }
}
```

`plugin.opencode` is `"configured"` when `meridian setup` has been run, `"not-configured"` otherwise.

## Graceful shutdown

`meridian`'s CLI entry point calls `ProxyInstance.close()` on `SIGTERM`/`SIGINT`
before exiting. `close()` stops admitting new requests immediately, then waits
up to `MERIDIAN_SHUTDOWN_GRACE_MS` (default 30s) for whatever is already
in-flight to finish naturally before closing the port. Library consumers that
already call `close()` for their own shutdown handling (see the Stable API
Contract) get this drain behavior automatically — no code change needed.

While draining:

- `GET /health` returns `503` with `{ "status": "draining", ... }` immediately,
  ahead of the usual auth-status check, so a fleet manager or load balancer
  polling this endpoint learns to stop routing here as fast as possible.
- New `/v1/messages` requests (and `/v1/chat/completions`, `/v1/responses`,
  which route through the same handler) are rejected with `503` and header
  `x-meridian-draining: 1`:

  ```json
  HTTP/1.1 503
  x-meridian-draining: 1
  Content-Type: application/json

  {
    "type": "error",
    "error": {
      "type": "overloaded_error",
      "message": "Meridian is shutting down and is not accepting new requests. Retry against another instance."
    }
  }
  ```

- Requests already in flight when draining started are left to finish; the
  port only closes once they're all done or the grace period elapses,
  whichever comes first. If the grace period elapses first, a warning is
  logged and any remaining HTTP connections are forcibly closed.

## Concurrent requests to the same session

Requests that share a reliable session identity supplied by the client
(currently a session header) are serialized: a request queued behind another
one for the *same* session waits for the in-flight one to finish before its
own conversation lineage is checked. Headerless requests are not strictly
serialized because a conversation fingerprint is not unique enough to prove
that two requests belong to the same logical chat.

If, by the time it's dequeued, the earlier request has already committed a
new turn *in the same profile's session scope* — and the waiting request's
message history is no longer a valid continuation or compaction of that new
state — Meridian returns:

```json
HTTP/1.1 400
Content-Type: application/json

{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "This session advanced while the request was waiting. Retry with the latest conversation history or use a distinct session ID."
  }
}
```

The response uses the Anthropic-compatible `400 invalid_request_error`
contract. Gateways and adapters should treat the message as a stale-session
signal, not as account exhaustion:

- **Do not treat it like `429 rate_limit_error`.** It never means the
  account/profile is exhausted — the account is healthy, two requests just
  raced for the same session. Failing over to a different account or profile
  does not fix it and wastes a hop.
- **Do not blindly retry the identical request body.** The message history
  it was sent with is the thing that's stale; resending the same bytes will
  usually just be reclassified as a fresh/diverged session on retry (a full
  replay) rather than conflict again. Re-fetch the conversation's current
  state from your own source of truth before resubmitting, or route the
  follow-up to a distinct session ID if the two requests represent genuinely
  independent turns.

This only fires for requests that share a reliable session identity —
unrelated and headerless sessions are never strictly serialized against each
other and never see this concurrency error. Three further exemptions:

- **Scoped per profile.** One session id backs an independent conversation
  per profile, each with its own resume cache. Turns under different profiles
  still serialize against each other (they share one id), but a commit under
  one profile never refuses a queued turn from another.
- **Declared concurrent flows are never refused.** A request whose
  `x-meridian-source` starts with `fork-` or `subagent-` has told Meridian it
  is knowingly running a parallel turn under a shared session key. Those
  turns are still serialized, but a stale lineage costs them a replay rather
  than a `400` — the behavior they had before serialization existed.
- **The lease cannot wedge a session forever.** A turn holds its session's
  serialization lease until its response body completes. If that never
  happens, the lease is force-released after
  `MERIDIAN_SESSION_TURN_MAX_HOLD_MS` (default 10 minutes) with a logged
  warning, and queued turns for that session proceed concurrently.

## API Key Authentication

By default, Meridian binds to `127.0.0.1` and requires no authentication — anyone on localhost can use it. If you expose Meridian over a network (Tailscale, LAN, Docker with port mapping), you can enable API key authentication to prevent unauthorized access.

```bash
MERIDIAN_API_KEY=your-secret-key meridian
```

When set:
- All API routes (`/v1/messages`, `/v1/chat/completions`, etc.) and admin routes (`/telemetry`, `/metrics`, `/profiles`) require a matching key
- `/` and `/health` remain open (monitoring tools need unauthenticated health checks)
- Keys are accepted via `x-api-key` header or `Authorization: Bearer` header

Clients just set their `ANTHROPIC_API_KEY` to the shared secret — since most tools already send this header, no workflow changes are needed:

```bash
ANTHROPIC_API_KEY=your-secret-key ANTHROPIC_BASE_URL=http://meridian-host:3456 opencode
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `meridian` | Start the proxy server |
| `meridian setup` | Configure the OpenCode plugin in `~/.config/opencode/opencode.json` |
| `meridian profile add <name> [--headless]` | Add a profile and authenticate via Claude OAuth; `--headless` prints a URL, prompts for the returned code, and stores the exchanged credentials |
| `meridian profile add <name> --oauth-token [TOKEN]` | Add a headless profile from a `claude setup-token` value (prompts when `TOKEN` is omitted) |
| `meridian profile list` (alias `profile ls`) | List all profiles and their auth status |
| `meridian profile switch <name>` | Switch the active profile (requires running proxy) |
| `meridian profile login <name> [--headless]` | Re-authenticate an expired profile (browser-login profiles only); `--headless` uses the URL/code flow |
| `meridian profile remove <name>` | Remove a profile and its credentials |
| `meridian refresh-token` | Manually refresh the Claude OAuth token (exits 0/1) |

## SDK Feature Toggles (Experimental)

Meridian can expose Claude Code features to any connected agent. Capabilities like auto-memory, dreaming, and CLAUDE.md — normally exclusive to Claude Code — become available to OpenCode, Crush, Droid, and any other harness routed through Meridian. Each agent keeps its own toolchain while gaining access to these additional features.

Configure per-adapter at **`/settings`** in the Meridian web UI. Changes take effect on the next request — no restart needed. Config is persisted to `~/.config/meridian/sdk-features.json`.

Every adapter Meridian can route to appears on that page — the list is derived from the adapter registry, so adding an adapter makes it configurable with no second edit. Alias names (`cherrystudio`, `claudecode`) collapse into their canonical adapter rather than appearing twice.

### Available features

| Setting | Options | Description |
|---|---|---|
| **Claude Code Prompt** | on / off | Include the SDK's built-in system prompt (tool usage rules, safety guidelines, coding best practices) |
| **Client Prompt** | on / off | Include the system prompt sent by the connecting agent (e.g. OpenCode or Crush instructions) |
| **CLAUDE.md** | off / project / full | Load instruction files — `off`: none, `project`: `./CLAUDE.md` only, `full`: `~/.claude/CLAUDE.md` + `./CLAUDE.md` |
| **Memory** | on / off | Auto-memory: read and write memories across sessions |
| **Auto-Dream** | on / off | Background memory consolidation between sessions |
| **Thinking** | disabled / adaptive / enabled | Extended thinking mode for complex reasoning |
| **Thinking Passthrough** | on / off | Forward thinking blocks to the client for display |
| **Shared Memory** | on / off | Share memory directory with Claude Code (`~/.claude`) instead of isolated storage |
| **WebFetch Preflight** | on / off | Check each WebFetch hostname against the Anthropic blocklist before fetching (default on, `cherry` only — see below) |
| **claude.ai Connectors** | on / off | Load the MCP connectors attached to your claude.ai account (default off) |

### WebFetch preflight

Before the WebFetch tool retrieves a URL, the subprocess sends the target
hostname to `api.anthropic.com/api/web/domain_info` to check it against a
safety blocklist. Only the hostname goes — not the path or the page — and the
result is cached per host for five minutes.

The check is not covered by `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` — it is
the one exception to everything under [Subprocess traffic](#subprocess-traffic)
— so turning it off here is the only way to keep fetch targets local. With it
off, WebFetch retrieves any URL without consulting the blocklist; if that
matters for your deployment, pair it with WebFetch tool permissions on the
calling agent.

**Scope: this only affects the `cherry` adapter.** The preflight runs inside
the SDK's built-in `WebFetch`, so it only fires when the Meridian-spawned
subprocess executes that tool itself. Every other adapter prevents that:
passthrough-mode adapters (OpenCode, LiteLLM/Passthrough, OpenAI, Codex) send
`tools: []`, which disables all built-ins, and the internal-mode adapters put
`WebFetch` in `disallowedTools`. Cherry Studio is the sole adapter that
unblocks the built-in web tools so Claude can browse for itself (#481), and it
is therefore the only place this toggle changes behaviour.

If your *client* runs its own WebFetch — the usual case in passthrough mode —
that fetch and its preflight happen in the client process, under the client's
own settings. Meridian cannot turn it off from here.

### claude.ai connectors

If your claude.ai account has connectors attached — Drive, Gmail, Calendar —
the subprocess can fetch them from `/v1/mcp_servers` and connect each one
through `mcp-proxy.anthropic.com`. Their tools then appear in the session
alongside the ones Meridian registered.

That is rarely what you want from a proxy: the calling agent negotiated a tool
surface, and this adds third-party tools it never asked for, plus an outbound
fetch describing the account. So it is **off by default**.

Passthrough mode keeps it off regardless of this setting. There the client
executes tools, and it has no way to run one that exists only inside the
subprocess.

> **Upgrading to 1.60.0 — this turns something off that used to be on.**
>
> Before 1.60.0, connectors loaded for any adapter *not* running in
> passthrough mode. In practice that meant **`cherry`, `droid`, and anything
> started with `MERIDIAN_PASSTHROUGH=0`** — those sessions silently lose
> connector tools on upgrade until you switch this on at `/settings`.
>
> Adapters that default to passthrough, `opencode` included, are unaffected:
> connectors were already disabled for them.
>
> Nothing errors when a connector tool disappears — the model simply stops
> having it, and answers as if the data were unavailable. If a session that
> used to reach your Drive or Gmail stops doing so after upgrading, this
> setting is why.

### System prompts

The system prompt controls are independent — any combination works:

- **Both enabled** (recommended): Claude Code instructions come first, followed by your agent's specific instructions. This gives Claude the full context it needs for features like memory and tool use to work correctly.
- **Claude Code only**: Just the base Claude Code prompt without agent-specific instructions.
- **Client only**: Just your agent's prompt, passed through as a raw string.
- **Neither**: No system prompt at all — Claude operates with just the user message.

> **Note:** For features like memory and dreaming to work well, the Claude Code system prompt should be enabled — it contains the instructions Claude needs to read and write memories correctly.

## Passthrough Mode and Tool Calling

The core question is **who executes the tools** — the SDK or the client?

- **Passthrough mode** (default for OpenCode and Pi) — Claude generates tool calls, but Meridian captures them and sends them back to the client for execution. The client runs the tool using its own implementation, with its own sandboxing, file tracking, and UI, then sends the result in the next request. This is how OpenCode, oh-my-opencagent (OMO), and most coding agents work — they have their own read/write/bash tools and need to stay in control of what runs on the user's machine.
- **Internal mode** — Claude Code handles everything. The SDK executes tools directly on the host, runs its full agent loop, and returns the final result. This is for clients that are purely chat interfaces (Open WebUI, simple API consumers) with no tool execution of their own.

Most users don't need to configure anything — the adapter sets the right mode automatically. To override:

```bash
MERIDIAN_PASSTHROUGH=1 meridian   # force passthrough
MERIDIAN_PASSTHROUGH=0 meridian   # force internal
```

### How tool calling works in passthrough

1. The client sends a request with tool definitions (read, write, edit, bash, glob, grep)
2. Meridian registers these as MCP tools so the SDK can generate proper `tool_use` blocks
3. The SDK produces a tool call → Meridian captures it and returns it to the client
4. The client executes the tool locally and sends the result back

For large tool sets (>15 tools), non-core tools are automatically deferred via the SDK's ToolSearch mechanism. Core tools (read, write, edit, bash, glob, grep) are always loaded eagerly. The deferral threshold is configurable with `MERIDIAN_DEFER_TOOL_THRESHOLD`.

**Digest-turn elimination** — after a tool call is captured, the SDK would normally invoke the model one more time to "digest" the denial before ending the turn. That extra invocation is discarded by the proxy but fully billed — measured at ~400+ wasted output tokens and 2–3× extra latency per tool step (and on always-thinking models like Fable, a full thinking pass each time). Meridian now aborts the SDK query the moment every tool call's denial is persisted, so the digest turn never generates. Sessions remain resumable and tool-result attribution is unaffected. Kill switch: `MERIDIAN_PASSTHROUGH_EARLY_STOP=0` restores the old behavior.

### Silent turns

A **silent turn** is a completed turn whose terminal envelope carries nothing the client can act on: no text, no tool call. On the wire it is indistinguishable from success — `stop_reason: "end_turn"`, HTTP 200, `error: null` — so a client does not retry, and an autonomous run treats a lost turn as a finished one.

Three separate defects have produced this shape (all fixed in rynfar/meridian#768): a session resumed from an interrupted tail, a client abort that never settled its session, and a spent `end your turn now` deny landing immediately before a boundary continuation. They have nothing in common but their outcome, so Meridian now guards the outcome directly:

- **Detection.** Every completed turn is classified: text or a tool call means productive, anything else is silent. `thinking` deliberately does not count — thinking plus an empty text block *is* the defect's signature. Silent turns are recorded as `response.silent_turn` in `/telemetry/logs` and named at session level, because an autonomous run has nobody to notice a quiet telemetry row.
- **Recovery.** One extra turn, in the same session, forked from the deny boundary rather than appended to the silent tail — appending is what compounds one empty turn into an empty session. The nudge names the contradiction and discharges it, rather than just asking again like the CLI's own no-visible-output prompt, which failed on all three observed cases because the offending instruction was still standing. At most one attempt; never when the client has already disconnected. A recovery that itself fails leaves the original envelope intact and never turns a delivered turn into a failed request. Kill switch: `MERIDIAN_SILENT_TURN_RECOVERY=0` keeps detection and telemetry, skips the spend.
- **Honest failure envelopes.** When a turn dies mid-stream, the `error` event now precedes `message_stop` — clients stop reading at `message_stop`, so an error queued behind it was written into a stream nobody was consuming. A failed turn that produced no text also reports `stop_reason: "max_tokens"` (truncated) instead of `"end_turn"` (finished), which is what lets a client tell a crash from a completed answer.

Coverage: `E38` in [E2E.md](../E2E.md), with `MERIDIAN_DEBUG_FORCE_SILENT_TURN=1` reproducing the shape on demand — the live rate is roughly three in five hundred requests, far too rare for a test run to wait for.

### Known limitations

- **Single tool round-trip per request** — in passthrough mode, the SDK is configured with `maxTurns=3` (or 4 for deferred tools). Multi-step agentic loops where Claude needs several consecutive tool calls require the client to re-send after each round.
- **Blocked tools** — 10 built-in SDK tools (Read, Write, Bash, etc.) are blocked to prevent conflicts with the client's own tools. 19 additional Claude Code-only tools (CronCreate, EnterWorktree, Agent, etc.) are blocked because they require capabilities that external clients don't support.
- **Subagent extraction** — Meridian parses the client's Task tool description to extract subagent names and build SDK AgentDefinitions. If the client's agent framework uses a non-standard format, subagent routing may not work automatically.
- **Scratchpad suppression (passthrough)** — the Claude CLI advertises a proxy-host scratchpad directory that clients can't use; OpenCode 1.18+ permission-blocks writes to it. Meridian suppresses it in passthrough mode (`CLAUDE_CODE_SESSION_KIND=bg` on the subprocess). Kill switch: `MERIDIAN_SUPPRESS_SCRATCHPAD=0`.
- **Anthropic server tools not supported** — native server-side tools (`web_search_*`, `web_fetch_*`) are a raw Anthropic API feature (billed to an API key) that emits `server_tool_use` / `web_search_tool_result` blocks the Claude Max / Agent SDK path cannot produce. A request carrying one is rejected with a `400` explaining the fix. If a plugin needs server-side web search (e.g. [`opencode-websearch`](https://github.com/emilsvennesson/opencode-websearch)), give it its **own** provider pointed at `https://api.anthropic.com` with your `ANTHROPIC_API_KEY` — don't route that call through Meridian.

### Troubleshooting: "aborted" tool calls

Two very different things can carry the word "abort" — one is normal, one is always a bug:

- **Normal (invisible):** Meridian intentionally stops its internal SDK subprocess after your tool calls are captured — this is the optimization that avoids a wasted, billed model turn per tool call. It never appears in your client; log lines like `passthrough.early_stop` or `sdk_termination reason=aborted` in Meridian's own logs are calm, expected bookkeeping.
- **A bug (report it):** an **empty tool call in your client UI** — `tool {}` with "Tool execution aborted" — is never expected behavior, on any version. It means a call was cut off in transit.

**The definitive check:** the `/telemetry` dashboard's **Envelope** card. Meridian audits its own output on every response — green "wire contract clean" means every tool call was delivered intact regardless of what internal logs say. If it shows red, the logs contain `ENVELOPE VIOLATION` lines with request IDs — include those in a bug report and it can usually be root-caused directly.
