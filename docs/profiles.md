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

Or add one from the Profiles page without a terminal at all — see [From the web UI: add a profile](#from-the-web-ui-add-a-profile).

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

#### From the web UI: re-authenticate a profile without a terminal

A profile whose credentials expired can be logged in again from the Profiles page, with no shell on the Meridian host. Click **Log in from browser** on the profile's card, sign in to that profile's Claude account, and you are done — Claude sends you back to Meridian, which finishes the login and updates the card. There is nothing to copy and paste.

**It is an ordinary link, and that is deliberate.** If you are signed into several Claude accounts, the session your main browser offers is often the wrong one for the profile you are re-authenticating. Because the control is a real `<a href>` carrying the authorize URL, the browser's own context menu applies: **Open Link in Incognito Window**, **Open Link in New Private Window**, or **Copy Link Address** to paste into a different browser or browser profile. The login still lands on the profile it was started for — the PKCE verifier and `state` live on the server, keyed by `state`, so the browser that finishes the sign-in does not have to be the one that started it, and the page you started from notices and updates itself. Nothing secret is in the link: the authorize URL is public by design, and the verifier never leaves the server.

That works whenever the **browser** is on the machine Meridian runs on — including through an SSH port-forward, and including when you reached the UI by some other name such as a LAN or tailnet hostname. What matters is the browser's position, not the URL in its address bar, so the page settles it by measurement: before opening the sign-in tab it asks the browser to reach Meridian on loopback, and takes the redirect flow only if that answers.

A browser on a *different* machine cannot reach it, the check fails in under two seconds, and the panel asks for the code instead. Either form is accepted: the **bare code** Claude shows you, or the **whole callback URL** from the address bar (`https://platform.claude.com/oauth/code/callback?code=…&state=…`), which is usually easier to copy. The redirect flow also offers **Paste a code instead** as a manual fallback, which does not restart anything — both sign-in URLs belong to the same login.

**Why the browser sometimes has to be on the same host.** Anthropic publishes the Claude Code client's registration at [`https://claude.ai/oauth/claude-code-client-metadata`](https://claude.ai/oauth/claude-code-client-metadata), and it declares exactly three ways back:

```json
"redirect_uris": ["http://localhost/callback", "http://127.0.0.1/callback"]
```

plus the hosted code-display page, `https://platform.claude.com/oauth/code/callback`. The loopback pair is the [RFC 8252 §7.3](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3) convention, where the port is not part of the match — which is why Meridian can use whichever port you reached it on. A redirect URI belonging to *your* hostname cannot be added to Anthropic's registration, so it would be rejected at the authorize step; the paste flow is what remains for that case.

For scripting, the same login is three routes:

```bash
# mode is "redirect" when the Host you call with is a loopback address, else "paste".
# In "paste" mode the reply also carries loopbackAuthorizeUrl + loopbackProbeUrl:
# fetch the probe, and if it answers {"status":"waiting"} you can use the
# loopback URL after all — that is exactly what the web UI does.
# → {"loginId":"…","mode":"redirect","authorizeUrl":"…","pasteAuthorizeUrl":"…","expiresAt":…,"profile":"work"}
curl -X POST http://127.0.0.1:3456/profiles/login/start \
  -H 'Content-Type: application/json' -d '{"profile":"work"}'

# → {"status":"waiting"|"completed"|"failed", "profileId":"work", …}
curl 'http://127.0.0.1:3456/profiles/login/status?loginId=…'

# only needed for the paste path; `code` accepts the bare code or the full callback URL
curl -X POST http://127.0.0.1:3456/profiles/login/complete \
  -H 'Content-Type: application/json' -d '{"loginId":"…","code":"…"}'
```

Details worth knowing:

- The PKCE verifier never leaves the server. The browser only ever holds an opaque login id.
- The loopback check the page runs is that login's own `/profiles/login/status` URL, so a reply proves both that the browser can reach loopback *and* that what answered is the instance holding this login. Anything else listening on the port answers 410 and the paste flow stands.
- A login is **single-use** and expires **10 minutes** after it starts. `state` must match the login it was started with, exactly as the CLI requires; on the redirect path that `state` is what identifies the login at all.
- `GET /callback` is deliberately **not** behind `MERIDIAN_API_KEY` — Anthropic's redirect carries no key. It acts only on an unguessable, single-use `state` minted by `/profiles/login/start`, which *is* gated, and answers 410 to anything else.
- Only **claude-max** profiles have this flow. `api` and `oauth-token` profiles are refused with the reason — replace an OAuth token with `meridian profile remove <name> && meridian profile add <name> --oauth-token`.
- An unknown profile name is refused here rather than created — a typo in a re-authentication must not quietly produce a second account slot. Creating one is a separate, explicit act: see [Add a profile from the web UI](#from-the-web-ui-add-a-profile) below.
- An instance told not to write credential files (`MERIDIAN_CREDENTIALS_READONLY=1` — set on a second instance that shares another's credentials) refuses **before** opening the sign-in tab, and names where the login can be completed instead. Refusing after sign-in would have burned a one-time code for nothing.

#### From the web UI: add a profile

A new Claude account can be added from the Profiles page without a shell on the Meridian host. Under **Add a profile**, type a name and click **Add profile**:

1. Meridian validates the name, refuses it if anything is wrong, then mints the PKCE login and opens Claude's sign-in in a new tab.
2. Sign in to the Claude account this profile should use. Claude shows you a code.
3. Paste it back — the **bare code** or the **whole callback URL**, exactly as for a re-login.

The profile appears in the list, with its own config directory under `~/.config/meridian/profiles/<name>/`, ready to use with no restart.

```bash
# → {"addId":"…","authorizeUrl":"https://claude.com/cai/oauth/authorize?…","expiresAt":…,"profile":"work"}
curl -X POST http://127.0.0.1:3456/profiles/add/start \
  -H 'Content-Type: application/json' -d '{"profile":"work"}'

# `code` accepts the bare code or the full callback URL
curl -X POST http://127.0.0.1:3456/profiles/add/complete \
  -H 'Content-Type: application/json' -d '{"addId":"…","code":"…"}'
```

**Nothing is written until the credentials are in hand.** The exchange with Anthropic happens first; the `profiles.json` entry is written only once it succeeds. A sign-in that is abandoned, rejected or never finished therefore leaves no profile behind at all — there is no half-made account slot stuck at "not logged in" to notice and clean up. Just add it again with the same name.

**Who can do this.** These routes inherit `/profiles/*`'s `requireAuth`, so they are behind `MERIDIAN_API_KEY` **when that key is set**. When it is not set — the default — the only thing standing between this page and a new profile is whatever reaches the port: bind Meridian to loopback, or to a private network you trust. Adding a profile is the most privileged thing the Profiles page does, so treat an unauthenticated instance on a shared network accordingly. There is deliberately no delete, rename or edit here; removal stays `meridian profile remove <name>` on the host.

Details worth knowing:

- Names may use only letters, numbers, hyphens and underscores. The name becomes a directory, and the check is the same one `meridian profile add` applies.
- An existing name is refused and points you at **Log in from browser** on that profile's card — re-authenticating an account is what that button is for.
- One open sign-in per name at a time, so two people cannot both be part-way through creating the same one. Starting another for the same name **replaces** the first rather than being refused — cancelling the panel, reloading the page and closing the tab all abandon a sign-in without telling the server, and a name you could not retry until the 10-minute expiry would be worse than the race it prevents. Only the most recently started sign-in can be completed.
- `MERIDIAN_CREDENTIALS_READONLY=1` refuses **before** the sign-in tab opens, and names `meridian profile add <name>` as the alternative.
- Only **claude-max** profiles are created this way. `api` and `oauth-token` profiles are CLI-only — neither has an OAuth flow to drive from a page.
- **The `~/.claude` import offer is CLI-only.** `meridian profile add` on a host whose default config dir is already signed in offers to adopt those credentials as the new profile. The UI never does: clicking **Add profile** always signs in fresh. Silently claiming the account you happen to be logged in as on that machine is not something a button press should be able to do.

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
```

- **Conversations keep their account** while it's healthy — a session never flips accounts just because the pool preference changed (protects per-account prompt caches). A session on an exhausted account fails over and then stays on its new account. A conversation is identified by its session header when the client sends one, and otherwise by a fingerprint of its opening message and project directory — so keyless clients get the same affinity.
- **Drain-back is new-sessions-only**: when the preferred account's window resets, new sessions prefer it again immediately; existing conversations finish where they are.
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
