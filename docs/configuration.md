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
| `MERIDIAN_MAX_CONCURRENT` | `CLAUDE_PROXY_MAX_CONCURRENT` | `10` | Maximum concurrent SDK sessions |
| `MERIDIAN_MAX_SESSIONS` | `CLAUDE_PROXY_MAX_SESSIONS` | `1000` | In-memory LRU session cache size |
| `MERIDIAN_MAX_STORED_SESSIONS` | `CLAUDE_PROXY_MAX_STORED_SESSIONS` | `10000` | File-based session store capacity |
| `MERIDIAN_WORKDIR` | `CLAUDE_PROXY_WORKDIR` | `cwd()` | Default working directory for SDK |
| `MERIDIAN_IDLE_TIMEOUT_SECONDS` | `CLAUDE_PROXY_IDLE_TIMEOUT_SECONDS` | `120` | HTTP keep-alive timeout |
| `MERIDIAN_TELEMETRY_SIZE` | `CLAUDE_PROXY_TELEMETRY_SIZE` | `1000` | Telemetry ring buffer size |
| `MERIDIAN_NO_FILE_CHANGES` | `CLAUDE_PROXY_NO_FILE_CHANGES` | unset | Disable "Files changed" summary in responses |
| `MERIDIAN_SONNET_MODEL` | `CLAUDE_PROXY_SONNET_MODEL` | `sonnet` | Sonnet context tier: `sonnet` (200k, default) or `sonnet[1m]` (1M, requires Extra Usage†) |
| `MERIDIAN_1M_CONTEXT_SUPPORT` | `CLAUDE_PROXY_1M_CONTEXT_SUPPORT` | unset | Set to `0`/`false`/`no` to disable 1M context entirely — every model resolves to its 200k base variant, so Meridian never requests the extended window (avoids Extra Usage on 1M). |
| `MERIDIAN_DEFAULT_AGENT` | — | `opencode` | Default adapter for unrecognized agents: `opencode`, `forgecode`, `pi`, `crush`, `droid`, `cherry`, `claudecode`, `passthrough`. Requires restart. |
| `MERIDIAN_ROUTING` | — | `active` | Session-to-profile routing: `active` (all traffic to the active profile), `sticky` ([sticky session routing](profiles.md#sticky-session-routing)), or `priority` ([priority failover](profiles.md#priority-failover-routing)) |
| `MERIDIAN_PROFILE_ORDER` | — | *(config order)* | Priority-mode pool order, comma-separated, highest priority first (e.g. `work,personal`). Also editable at `/settings`. |
| `MERIDIAN_PASSTHROUGH_EARLY_STOP` | — | `1` | Set to `0` to disable [digest-turn elimination](#how-tool-calling-works-in-passthrough) and restore the old end-of-turn behavior |
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

†Sonnet 1M requires Extra Usage on all plans including Max ([docs](https://code.claude.com/docs/en/model-config#extended-context)). Opus 1M is included with Max/Team/Enterprise at no extra cost.

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
