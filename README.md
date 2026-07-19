<p align="center">
  <img src="assets/banner.svg" alt="Meridian" width="800"/>
</p>

<p align="center">
  <a href="https://github.com/rynfar/meridian/releases"><img src="https://img.shields.io/github/v/release/rynfar/meridian?style=flat-square&color=58a6ff&label=release" alt="Release"></a>
  <a href="https://www.npmjs.com/package/@rynfar/meridian"><img src="https://img.shields.io/npm/v/@rynfar/meridian?style=flat-square&color=bc8cff&label=npm" alt="npm"></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-58a6ff?style=flat-square" alt="Platform"></a>
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-bc8cff?style=flat-square" alt="License"></a>
  <a href="https://discord.gg/jP2a2Z92NZ"><img src="https://img.shields.io/badge/discord-join-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord"></a>
</p>

---

Meridian bridges the Claude Agent SDK (formerly the Claude Code SDK) to the standard Anthropic API. No OAuth interception. No binary patches. No hacks. Just pure, documented SDK calls. Any tool that speaks the Anthropic or OpenAI protocol — OpenCode, ForgeCode, Crush, Cline, Aider, Pi, Droid, Open WebUI, Claude Code — connects to Meridian and gets Claude, with session management, streaming, and prompt caching handled natively by the SDK.

> [!NOTE]
> ### How Meridian works with Anthropic
>
> Meridian is built entirely on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). Every request flows through `query()` — the same documented function Anthropic provides for programmatic access. No OAuth tokens are extracted, no binaries are patched, nothing is reverse-engineered.
>
> Because we use the SDK, Anthropic remains in full control of prompt caching, context window management, compaction, rate limiting, and authentication. Meridian doesn't bypass these mechanisms — it depends on them. Max subscription tokens flow through the correct channel, governed by the same guardrails Anthropic built into Claude Code.
>
> What Meridian adds is a **presentation and interoperability layer**. We translate Claude Code's output into the standard Anthropic API format so developers can connect the editors, terminals, and workflows they prefer. The SDK does the work; Meridian formats the result.
>
> **Our philosophy is simple: work within the SDK's constraints, not around them.** The generous limits on Claude Max exist because Anthropic can optimize and manage usage through Claude Code. Meridian respects that by building only on the tools Anthropic provides — no shortcuts, no workarounds that create friction. We believe this is how developers keep the freedom to choose their own frontends while keeping the platform sustainable for everyone.

## Quick Start

```bash
# 1. Install
npm install -g @rynfar/meridian

# 2. Authenticate (one time)
claude login

# 3. Configure OpenCode plugin (one time — OpenCode users only)
meridian setup

# 4. Start
meridian
```

Meridian runs on `http://127.0.0.1:3456`. Point any Anthropic-compatible tool at it:

```bash
ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

The API key value is a placeholder — Meridian authenticates through the Claude Code SDK, not API keys. Most Anthropic-compatible tools require this field to be set, but any value works.

Using a different agent, NixOS, or Docker? See the [documentation](#documentation) below.

## Why Meridian?

The Claude Agent SDK provides programmatic access to Claude. But your favorite coding tools expect an Anthropic API endpoint. Meridian bridges that gap — it runs locally, accepts standard API requests, and routes them through the SDK. Claude Code does the heavy lifting; Meridian translates the output.

<p align="center">
  <img src="assets/how-it-works.svg" alt="How Meridian works" width="920"/>
</p>

## Documentation

| Guide | What's in it |
|-------|--------------|
| [Agent Setup](docs/agents.md) | Per-agent config: OpenCode, Crush, Droid, Cline, Aider, Codex CLI, Open WebUI, Cherry Studio, ForgeCode, Pi, Claude Code, Claude Design MCP, adapter instances |
| [Configuration](docs/configuration.md) | Environment variables, endpoints, API key auth, SDK feature toggles, passthrough mode, CLI commands |
| [Multi-Profile Support](docs/profiles.md) | Multiple Claude accounts, headless login, sticky session routing |
| [Deployment](docs/deployment.md) | NixOS / Nix flake, Home Manager service, Docker |
| [Plugins](docs/plugins.md) | Plugin system and the official scrub plugins |
| [Development](docs/development.md) | Architecture overview, testing, programmatic API |
| [`MONITORING.md`](MONITORING.md) | Telemetry, token usage, and prompt cache health |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Module map and dependency rules |

## Features

- **Standard Anthropic API** — drop-in compatible with any tool that supports a custom `base_url`
- **OpenAI-compatible API** — `/v1/chat/completions` and `/v1/models` for tools that only speak the OpenAI protocol (Open WebUI, Continue, etc.) — no LiteLLM needed, including `image_url` support for data URLs
- **Session management** — conversations persist across requests, survive compaction and undo, resume after proxy restarts
- **Streaming** — full SSE streaming with MCP tool filtering
- **Concurrent sessions** — run parent and subagent requests in parallel
- **Subagent model selection** — primary agents get 1M context; subagents get 200k, preserving rate-limit budget
- **Auto token refresh** — expired OAuth tokens are refreshed automatically; requests continue without interruption
- **Passthrough mode** — forward tool calls to the client instead of executing internally
- **Multimodal** — images, documents, file attachments, and multimodal tool results pass through to Claude
- **Multi-profile** — switch between Claude accounts instantly, no restart needed; opt-in [sticky session routing](docs/profiles.md#sticky-session-routing) distributes sessions across accounts while keeping per-account prompt caches warm
- **Adapter instances** — run several configurations of the same adapter side by side (per-instance thinking, system prompt, passthrough) selected by header or match rules — see [Adapter instances](docs/agents.md#adapter-instances)
- **Telemetry dashboard** — real-time performance metrics at `/telemetry`, including token usage and prompt cache efficiency ([`MONITORING.md`](MONITORING.md))
- **Cost estimation** — estimated API-equivalent value of your traffic, per model and per profile, using current list prices with configurable overrides (`~/.config/meridian/model-pricing.json`, editable at `/settings`)
- **Envelope integrity auditing** — Meridian validates its own wire output on every response (no dangling blocks, no undelivered or empty tool calls) and surfaces violations on the dashboard
- **Telemetry persistence** — opt-in SQLite storage for telemetry data that survives proxy restarts, with configurable retention
- **Prometheus metrics** — `GET /metrics` endpoint for scraping request counters and duration histograms
- **SDK feature toggles** *(experimental)* — unlock Claude Code features (memory, dreaming, CLAUDE.md) for any connected agent

## Tested Agents

| Agent | Status | Notes |
|-------|--------|-------|
| [OpenCode](https://github.com/anomalyco/opencode) | ✅ Verified | Requires `meridian setup` ([setup](docs/agents.md#opencode)) — full tool support, session resume, streaming, subagents |
| [ForgeCode](https://forgecode.dev) | ✅ Verified | Provider config (see [Agent Setup](docs/agents.md)) — passthrough tool execution, session resume, streaming |
| [Droid (Factory AI)](https://factory.ai/product/ide) | ✅ Verified | BYOK config (see [Agent Setup](docs/agents.md)) — full tool support, session resume, streaming |
| [Crush](https://github.com/charmbracelet/crush) | ✅ Verified | Provider config (see [Agent Setup](docs/agents.md)) — full tool support, session resume, headless `crush run` |
| [Cline](https://github.com/cline/cline) | ✅ Verified | Config (see [Agent Setup](docs/agents.md)) — full tool support, file read/write/edit, bash, session resume |
| [Aider](https://github.com/paul-gauthier/aider) | ✅ Verified | Env vars — file editing, streaming; `--no-stream` broken (litellm bug) |
| [Open WebUI](https://github.com/open-webui/open-webui) | ✅ Verified | OpenAI-compatible endpoints — set base URL to `http://127.0.0.1:3456` |
| [Pi](https://github.com/mariozechner/pi-coding-agent) | ✅ Verified | models.json config (see [Agent Setup](docs/agents.md)) — full tool support via passthrough; detected via `x-meridian-agent: pi` header |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | ✅ Verified | `ANTHROPIC_BASE_URL` — remote clients share a Max subscription over the network; client CWD preserved in system prompt |
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio) | ✅ Verified | `cherry` adapter (see [Agent Setup](docs/agents.md)) — chat client with Claude's built-in web search via internal mode |
| [Codex CLI](https://github.com/openai/codex) | ✅ Verified | `/v1/responses` (see [Agent Setup](docs/agents.md)) — Responses-API provider, passthrough tool execution; verified on 0.144 (plain + tool-driving turns) |
| [Continue](https://github.com/continuedev/continue) | 🔲 Untested | OpenAI-compatible endpoints should work — set `apiBase` to `http://127.0.0.1:3456` |

Tested an agent or built a plugin? [Open an issue](https://github.com/rynfar/meridian/issues) and we'll add it.

## FAQ

**Is this allowed by Anthropic's terms?**
Meridian uses the official Claude Agent SDK — the same SDK Anthropic publishes and documents for programmatic access. It does not intercept credentials, modify binaries, or bypass any authentication. All requests flow through the SDK's own authentication and rate-limiting mechanisms.

**How is this different from using an API key?**
API keys provide direct API access billed per token. Claude Max includes programmatic access through the Claude Agent SDK. Meridian translates SDK responses into the standard Anthropic API format, allowing compatible tools to connect through Claude Code.

**What happens if my OAuth token expires?**
Tokens expire roughly every 8 hours. Meridian detects the expiry, refreshes the token automatically, and retries the request — so requests continue transparently. If the refresh fails (e.g. the refresh token has expired after weeks of inactivity), Meridian returns a clear error telling you to run `claude login`.

**Can I trigger a token refresh manually?**

```bash
# CLI — works whether the proxy is running or not
meridian refresh-token

# HTTP — while the proxy is running
curl -X POST http://127.0.0.1:3456/auth/refresh
```

**I'm getting `400 You're out of extra usage` on tool-bearing requests. What do I do?**
This error class ([#516](https://github.com/rynfar/meridian/issues/516), historical) came from Anthropic's server-side classifier gating certain requests behind Extra Usage. It had two distinct triggers, both now addressed:

- **Harness fingerprints** — identity lines in a client's system prompt (e.g. pi's "coding agent harness" line) were metered as Extra Usage. The [official scrub plugins](docs/plugins.md#official-plugins) strip these and remain recommended for the affected harnesses.
- **Tool-definition presence** — reported in mid-2026 as triggering independently of prompt content; as of July 2026 this no longer reproduces on Max accounts (verified with Extra Usage disabled, tools present, and an unscrubbed fingerprint prompt). It appears to have been resolved upstream in Anthropic's billing policy.

If you still hit the error on a current release, first check `GET /v1/usage/quota` to rule out genuinely exhausted quota, then try disabling the connecting client's system prompt for the affected adapter while keeping the Claude Code prompt enabled (in the `/settings` UI under **SDK Feature Toggles**, or `PATCH /settings/api/features/<adapter>` with `{"clientSystemPrompt":false,"codeSystemPrompt":true}`) — and please report it on [#516](https://github.com/rynfar/meridian/issues/516) with your plan type, since remaining occurrences are likely account-cohort specific (Team plans are treated differently by the API).

**I'm hitting rate limits on 1M context. What do I do?**
Meridian defaults Sonnet to 200k context because Sonnet 1M is always billed as Extra Usage on Max plans — even when regular usage isn't exhausted. This is [Anthropic's intended billing model](https://code.claude.com/docs/en/model-config#extended-context), not a bug. Set `MERIDIAN_SONNET_MODEL=sonnet[1m]` to opt in if you have Extra Usage enabled and understand the billing implications. Opus defaults to 1M context, which is included with Max/Team/Enterprise subscriptions at no extra cost. Note: there is a [known upstream bug](https://github.com/anthropics/claude-code/issues/39841) where Claude Code incorrectly gates Opus 1M behind Extra Usage on Max — this is Anthropic's to fix.

To turn off 1M context entirely for **every** model (so Meridian never requests the extended window), set `MERIDIAN_1M_CONTEXT_SUPPORT=0`. Meridian also auto-detects the "out of extra usage" error, falls back to the 200k model, and skips 1M for an hour — so it self-heals after the first occurrence even without the env var.

**Why does the health endpoint show `"plugin": "not-configured"`?**
You haven't run `meridian setup`. Without the plugin, OpenCode requests won't have session tracking or subagent model selection. Run `meridian setup` and restart OpenCode.

## Contributing

Issues and PRs welcome. Join the [Discord](https://discord.gg/jP2a2Z92NZ) to discuss ideas before opening issues. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for module structure and dependency rules, [`CLAUDE.md`](CLAUDE.md) for coding guidelines, [`E2E.md`](E2E.md) for end-to-end test procedures, and [`MONITORING.md`](MONITORING.md) for understanding token usage and prompt cache health.

## License

MIT
