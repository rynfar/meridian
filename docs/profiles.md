# Multi-Profile Support

[← Back to README](../README.md)

Meridian can route requests to different Claude accounts. Each **profile** is a named auth context — a separate Claude login with its own OAuth tokens. Switch between personal and work accounts, or share a single Meridian instance across teams.

### Adding profiles

```bash
# Add your personal account
meridian profile add personal
# → Opens browser for Claude login

# Add your work account (sign out of claude.ai first, then sign into the work account)
meridian profile add work
```

> **⚠ Important:** Claude's OAuth reuses your browser session. Before adding a second account, sign out of claude.ai and sign into the other account first.

#### Headless / SSH: complete Claude OAuth with a pasted code

When you still want a normal Claude Max browser-login profile but the Meridian host cannot open a browser (SSH, WSL, containers, remote servers), use `--headless`. Meridian prints a Claude OAuth URL, prompts for the returned code, exchanges it with PKCE, and saves the resulting credentials into the profile's isolated `CLAUDE_CONFIG_DIR`:

```bash
meridian profile add work --headless
```

Open the printed URL in a browser, sign in to the target Claude account, then paste the returned code at Meridian's `Paste code:` prompt. For an existing browser-login profile:

```bash
meridian profile login work --headless
```

#### Headless / CI: register an OAuth token

When a browser isn't available (containers, CI runners, remote shells), generate a long-lived OAuth token with `claude setup-token` and register it as a profile:

```bash
# Prompt for the token (input is hidden — paste the value from `claude setup-token`)
meridian profile add ci --oauth-token

# Or pass it inline
meridian profile add ci --oauth-token sk-ant-oat01-...
```

OAuth-token profiles store the token in `profiles.json` and feed it to the SDK via `CLAUDE_CODE_OAUTH_TOKEN` — no Keychain entry, no browser handshake. To prevent the SDK's 401-recovery from silently falling back to the host's `~/.claude` credentials, OAuth-token profiles also pin `CLAUDE_CONFIG_DIR` to an isolated per-profile directory under `~/.config/meridian/profiles/<name>/`. That directory holds only SDK state (sessions, settings) — never `.credentials.json`, since the token is delivered through the env.

### Switching profiles

```bash
# CLI (while proxy is running)
meridian profile switch work

# Per-request header (any agent)
curl -H "x-meridian-profile: work" ...
```

You can also switch profiles from the web UI — click an account card on the home page (`http://127.0.0.1:3456/`) or use the Profiles page at `/profiles`. The site header on every page shows which profile is active.

### Sticky session routing

With multiple profiles (e.g. two Claude Max subscriptions), Meridian can distribute sessions across profiles automatically while preserving **session affinity** — Anthropic's prompt caching is per-account, so a session must stay on one account to keep its ~99% cache hit rate:

```bash
MERIDIAN_ROUTING=sticky meridian     # or set "routing": "sticky" in ~/.config/meridian/settings.json
```

- Each session is assigned to a profile by rendezvous hashing of its session id — **deterministic and stateless**, so assignments survive proxy restarts with no state to lose
- Adding/removing a profile only reassigns the sessions belonging to the changed arm — everything else keeps its warm cache
- A session's subagent/fork requests share its assignment (same session id → same account)
- The `x-meridian-profile` header still overrides everything, per request
- Default is `active` (all traffic to the active profile — the pre-existing behavior); sticky is opt-in

Request logs show the assignment (`profile=work(sticky)`), and `GET /profiles/list` reports the current `routing` mode.

### Profile commands

| Command | Description |
|---------|-------------|
| `meridian profile add <name> [--headless]` | Add a profile and authenticate via Claude OAuth; `--headless` prints a URL, prompts for the returned code, and stores the exchanged credentials |
| `meridian profile add <name> --oauth-token [TOKEN]` | Add a headless profile from a `claude setup-token` value (prompts when `TOKEN` is omitted) |
| `meridian profile list` | List profiles and auth status |
| `meridian profile switch <name>` | Switch the active profile (requires running proxy) |
| `meridian profile login <name> [--headless]` | Re-authenticate an expired profile (browser-login profiles only); `--headless` uses the URL/code flow |
| `meridian profile remove <name>` | Remove a profile and its credentials |

### How it works

Each profile stores its credentials in an isolated `CLAUDE_CONFIG_DIR` under `~/.config/meridian/profiles/<name>/`. OAuth-token profiles use the same isolated directory layout — but the token itself lives in `~/.config/meridian/profiles.json` and is fed to the SDK via `CLAUDE_CODE_OAUTH_TOKEN`, so the per-profile dir holds only SDK state (sessions, settings) and never the credential. When a request arrives, Meridian resolves the profile in priority order:

1. `x-meridian-profile` request header (per-request override)
2. Active profile (set via `meridian profile switch` or the web UI)
3. First configured profile

Session state is scoped per profile — switching accounts won't cross-contaminate conversation history.

### Environment variable configuration

For advanced setups (CI, Docker), profiles can also be provided via environment variable:

```bash
export MERIDIAN_PROFILES='[
  {"id":"personal","claudeConfigDir":"/path/to/config1"},
  {"id":"work","claudeConfigDir":"/path/to/config2"},
  {"id":"ci","oauthToken":"sk-ant-oat01-..."}
]'
export MERIDIAN_DEFAULT_PROFILE=personal
meridian
```

Profile shapes:

- `claudeConfigDir` — points at a `~/.claude`-style directory; uses Claude Max OAuth from that dir
- `apiKey` (with optional `baseUrl`) — direct Anthropic API access; sets `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`
- `oauthToken` — long-lived token from `claude setup-token`; sets `CLAUDE_CODE_OAUTH_TOKEN`, no config dir needed

When `MERIDIAN_PROFILES` is set, it takes precedence over disk-configured profiles. When unset, Meridian auto-discovers profiles from `~/.config/meridian/profiles.json` on each request.

Related environment variables:

- `MERIDIAN_ROUTING=sticky` — enable [sticky session routing](#sticky-session-routing) across profiles (default `active`)
- `MERIDIAN_ADAPTER_INSTANCES='{...}'` — define [adapter instances](agents.md#adapter-instances) inline instead of via `~/.config/meridian/adapter-instances.json`
