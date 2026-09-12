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

The same login also records the account's plan (`subscriptionType`, `rateLimitTier`), read from Anthropic's OAuth profile endpoint — the token exchange itself returns no plan information. That is what lets `meridian profile list`, `/profiles/list`, `/health` and the dashboard tell a Max account from a Team one, and what makes `/v1/models` advertise the larger context window Max accounts actually have. If the lookup fails the login still succeeds and the plan simply stays unknown.

> **⚠ A profile created by an older Meridian has no plan recorded, and a token refresh cannot backfill it** — the value is only ever written at login, and Anthropic's usage endpoint does not carry it. Re-run `meridian profile login <name> --headless` to repair such a profile.

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

### Priority failover routing

**Opt-in.** With multiple profiles, `routing = "priority"` drains an ordered account pool: unpinned requests prefer the highest-priority account, and when it can no longer serve (a spent quota window, or a subscription the account can't bill), the request **fails over automatically** to the next account in the order — usually before the client sees any error:

```bash
MERIDIAN_ROUTING=priority MERIDIAN_PROFILE_ORDER=work,personal meridian
# or set "routing": "priority" and "profileOrder": ["work","personal"] in
# ~/.config/meridian/settings.json — both editable live at /settings
# Set "priorityFailback": "next-user-turn" in the settings file to change
# failback behavior. MERIDIAN_PRIORITY_FAILBACK overrides the settings value.
```

- **Conversations keep their account** while it's healthy — a session never flips accounts just because the pool preference changed (protects per-account prompt caches). A session on an exhausted account fails over and then stays on its new account. A conversation is identified by its session header when the client sends one, and otherwise by a fingerprint of its opening message and project directory — so keyless clients get the same affinity.
- **Failback policy**: `new-conversation` is the default and current behavior. When the preferred account recovers, new conversations use it while existing conversations stay on their fallback. With `next-user-turn`, Meridian switches an existing OpenCode conversation only on a fresh HMAC-attested, visible primary human turn, using a full-history fresh backing session on the preferred account. Hidden/title/summary/compaction, fork, subagent, keyless, malformed, replayed, and explicitly pinned requests cannot promote. Tool-loop continuations retain and atomically refresh the current route. If the preferred account refuses before content, the fallback session is retained. After assistant content, structured output, or a tool side effect, Meridian never replays the turn on another account. Other adapters retain `new-conversation` behavior.
- **One-time setup for `next-user-turn`**: rerun `meridian setup` after upgrading. Setup creates `~/.config/meridian/opencode-turn.key` as a 32-byte key with mode `0600` and configures the matching V1 or V2 plugin. Missing or invalid keys fail closed: requests still work, but they cannot promote. If OpenCode and Meridian run in separate hosts or config homes, set the same 32-byte base64url `MERIDIAN_OPENCODE_ATTESTATION_KEY` in both environments instead of relying on the shared file. Attestations bind the immutable OpenCode user-message creation time and are accepted only for the short freshness window; an old A-B-A replay keeps A's old time even after a restart and cannot cross B's durable high-water mark.
- **Exposed turns are replay-fenced durably.** Meridian records an exact attempt claim before SDK work starts and clears it only with terminal route/session finalization or a proven pre-exposure account failure. A crash, cancellation, assistant output, structured output, or tool execution leaves the claim fail-closed. Retrying the same, older, missing, or invalid attestation then returns `503` before any SDK call; only a strictly newer trusted human turn can supersede the uncertain attempt.
- **Exhaustion is tracked in-memory.** A quota refusal uses that account's own reported reset time (conservative 10-minute default when unknown), refined shortly after by an authoritative check against the usage API that can extend — never shorten — the cooldown once that account's five-hour window is confirmed exhausted. A billing refusal has no reset to wait for, so it takes the conservative default unrefined — the account is simply re-probed later, since only a human can fix a subscription. The home page shows `#n in pool` and `exhausted · resets in …` badges per account.
- When **every** account is exhausted, the last-tried account's error is surfaced unchanged, with its own status — a pool that ran out of billing is not reported as a rate limit.
- An explicit `x-meridian-profile` header always bypasses the pool (per-session pinning keeps working).
- Failovers are logged (`profile.failover` in the diagnostic stream; `profile=<id>(priority)` in request lines).

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
