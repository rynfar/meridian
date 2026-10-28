# Configuration

Claude is the default backend. Set `MERIDIAN_BACKEND=antigravity` to select the
official agy CLI backend; its permissions, models and environment variables are
documented in the [Antigravity guide](antigravity.md). Claude SDK settings below
do not automatically apply to Antigravity.

[← Back to README](../README.md)

Environment variables, endpoints, authentication, SDK feature toggles, passthrough mode, and CLI commands.

## Configuration

| Variable | Alias | Default | Description |
|----------|-------|---------|-------------|
| `MERIDIAN_API_KEY` | — | unset | Shared secret for API key authentication. When set, all API and admin routes require a matching `x-api-key` or `Authorization: Bearer` header. `/` and `/health` remain open. |
| `MERIDIAN_PORT` | `CLAUDE_PROXY_PORT` | `3456` | Port to listen on |
| `MERIDIAN_HOST` | `CLAUDE_PROXY_HOST` | `127.0.0.1` | Host to bind to |
| `MERIDIAN_PASSTHROUGH` | `CLAUDE_PROXY_PASSTHROUGH` | unset | Forward tool calls to client instead of executing |
| `MERIDIAN_MAX_CONCURRENT` | `CLAUDE_PROXY_MAX_CONCURRENT` | `10` | Maximum SDK queries running concurrently within one Meridian process. The budget is shared by every proxy instance in the process, and is re-read whenever an instance starts — so raising or lowering it takes effect for a later instance without a restart. Embedders that need a distinct budget can pass `maxConcurrent` in `ProxyConfig`, which opts that instance out of the shared pool. |
| `MERIDIAN_MAX_SESSIONS` | `CLAUDE_PROXY_MAX_SESSIONS` | `1000` | In-memory LRU session cache size |
| `MERIDIAN_MAX_STORED_SESSIONS` | `CLAUDE_PROXY_MAX_STORED_SESSIONS` | `10000` | File-based session store capacity |
| `MERIDIAN_WORKDIR` | `CLAUDE_PROXY_WORKDIR` | `cwd()` | Default working directory for SDK |
| `MERIDIAN_IDLE_TIMEOUT_SECONDS` | `CLAUDE_PROXY_IDLE_TIMEOUT_SECONDS` | `120` | HTTP keep-alive timeout |
| `MERIDIAN_IDLE_EXIT_SECONDS` | `CLAUDE_PROXY_IDLE_EXIT_SECONDS` | unset | Exit through graceful shutdown after this many seconds without a model request; intended for socket activation. `/health` polls do not reset the timer. |
| `MERIDIAN_SHUTDOWN_GRACE_MS` | `CLAUDE_PROXY_SHUTDOWN_GRACE_MS` | `30000` | Milliseconds `close()` waits for in-flight `/v1/messages` requests to finish after it stops admitting new ones, before closing the port. See [Graceful shutdown](#graceful-shutdown). |
| `MERIDIAN_SESSION_TURN_MAX_HOLD_MS` | `CLAUDE_PROXY_SESSION_TURN_MAX_HOLD_MS` | `600000` | Hard ceiling on how long one turn may hold its session's serialization lease. On timeout the lease is force-released with a warning and queued turns for that session proceed concurrently. See [Concurrent requests to the same session](#concurrent-requests-to-the-same-session). |
| `MERIDIAN_TELEMETRY_SIZE` | `CLAUDE_PROXY_TELEMETRY_SIZE` | `1000` | Telemetry ring buffer size, in rows. Pool routing writes one row **per account attempted**, so a request that failed over twice spends three. `/telemetry` reports what is actually held. |
| `MERIDIAN_DIAGNOSTIC_LOG_SIZE` | `CLAUDE_PROXY_DIAGNOSTIC_LOG_SIZE` | `500` | Diagnostic log ring buffer size (the Logs tab and `GET /telemetry/logs`) |
| `MERIDIAN_NO_FILE_CHANGES` | `CLAUDE_PROXY_NO_FILE_CHANGES` | unset | Disable "Files changed" summary in responses |
| `MERIDIAN_STRIP_THINKING` | `CLAUDE_PROXY_STRIP_THINKING` | unset | Set to `1` to strip raw `<thinking>` tags from user-authored prompt text. Off by default — `<thinking>` is a common chain-of-thought convention in hand-written prompts (#720); enable only if your harness is observed leaking it verbatim. |
| `MERIDIAN_SONNET_MODEL` | `CLAUDE_PROXY_SONNET_MODEL` | `sonnet` | Sonnet 4.x context tier: `sonnet` (200k, default) or `sonnet[1m]` (1M, requires Extra Usage†). No effect on Sonnet 5 and later (the default pin), which run with a native 1M window on every plan without Extra Usage. Not to be confused with `MERIDIAN_DEFAULT_SONNET_MODEL` below, which pins a concrete model id, not a context tier. |
| `MERIDIAN_FABLE_MODEL` | `CLAUDE_PROXY_FABLE_MODEL` | `fable[1m]` | Fable context tier opt-out: set to `fable` to disable the 1M extended context window and stay on the 200k base variant (also governs Mythos, which rides the Fable tier). `fable[1m]` is a documented no-op. Not to be confused with `MERIDIAN_DEFAULT_FABLE_MODEL` below, which pins a concrete model id, not a context tier. |
| `MERIDIAN_OPUS_MODEL` | `CLAUDE_PROXY_OPUS_MODEL` | `opus[1m]` | Opus context tier opt-out: set to `opus` to disable the 1M extended context window and stay on the 200k base variant. `opus[1m]` is a documented no-op. Not to be confused with `MERIDIAN_DEFAULT_OPUS_MODEL` below, which pins a concrete model id, not a context tier. |
| `MERIDIAN_1M_CONTEXT_SUPPORT` | `CLAUDE_PROXY_1M_CONTEXT_SUPPORT` | unset | Set to `0`/`false`/`no` to stop Meridian selecting the optional `[1m]` tier — every model resolves to its base variant, so Meridian never requests the extended window (avoids Extra Usage on 1M). Sonnet 5+ and Haiku 5.5 have a native 1M window with no `[1m]` variant, so this switch does not shrink them. To opt out a single tier instead, use `MERIDIAN_FABLE_MODEL` or `MERIDIAN_OPUS_MODEL` above. |
| `MERIDIAN_DEFAULT_AGENT` | — | `opencode` | Default adapter for unrecognized agents: `opencode`, `forgecode`, `pi`, `prime`, `crush`, `droid`, `cherry`, `claude-code`, `passthrough`, `polytoken`, `openai`, `jcode`, `letta`, `codex`. Aliases: `prime-agent`, `cherrystudio`, `claudecode`. Re-read per request from the process environment — restart the proxy to pick up deployment-level env changes. |
| `MERIDIAN_ROUTING` | — | `active` | Session-to-profile routing: `active` (all traffic to the active profile), `sticky` ([sticky session routing](profiles.md#sticky-session-routing)), or `priority` ([priority failover](profiles.md#priority-failover-routing)) |
| `MERIDIAN_PROFILE_ORDER` | — | *(config order)* | Priority-mode pool order, comma-separated, highest priority first (e.g. `work,personal`). Also editable at `/settings`. |
| `MERIDIAN_PRIORITY_FAILBACK` | — | `new-conversation` | Priority failback policy: `new-conversation` (current behavior) or `next-user-turn`. Environment value overrides `priorityFailback` in the settings JSON. Applies only to priority routing and the turn metadata signed by the OpenCode plugin and the Pi extension; other adapters retain `new-conversation` behavior. |
| `MERIDIAN_FOLLOW_ACTIVE` | `CLAUDE_PROXY_FOLLOW_ACTIVE` | unset | Base URL of another Meridian instance to take the active profile from, e.g. `http://127.0.0.1:3456`. For a development instance running beside a primary one — see [Following another instance's active profile](#following-another-instances-active-profile). |
| `MERIDIAN_PASSTHROUGH_EARLY_STOP` | — | `1` | Set to `0` to disable [digest-turn elimination](#how-tool-calling-works-in-passthrough) and restore the old end-of-turn behavior |
| `MERIDIAN_PASSTHROUGH_MAX_TURNS` | `CLAUDE_PROXY_PASSTHROUGH_MAX_TURNS` | *(unset — capped at 1)* | Pin the passthrough SDK turn budget. An explicit positive value wins over the one-turn cap. With early stop enabled, a budget above one still stops after a batch forwarded to the client (see [digest-turn elimination](#how-tool-calling-works-in-passthrough)), so the pin adds headroom before the tool boundary; structured-output requests retain the normal SDK completion loop. Unset it unless you still need it. |
| `MERIDIAN_PASSTHROUGH_UNCAPTURED_TOOL_RECOVERY` | — | *(unset — confirmed CLI rejection only)* | In streaming passthrough, complete tool calls can be returned as `tool_use` when every call has a CLI dispatch rejection matching its ID and tool name: `No such tool available`, or `InputValidationError: … could not be parsed as JSON`. Input must still form a complete JSON object after the supported control-character/invalid-escape repair; schema validation failures do not count. Explicit rejection can also qualify an undeclared tool name for the client's own invalid-tool response. The rejected SDK session is evicted so the next client result replays against a fresh one. Set to `1` to **also** allow experimental uncaptured abort-window recovery without explicit rejection (no live positive gate yet); every call must then name a declared tool. Set to `0` to disable both recoveries. Non-streaming responses are unaffected. Confirmed-rejection recovery applies at any turn budget, including deferred tools; abort-window recovery requires `maxTurns=1`. Both require a complete open envelope and no cancellation. When neither applies, the `sdk_termination` error log names the blocking condition as `uncaptured_veto=…`. |
| `MERIDIAN_SESSION_GC_LOCK_WAIT_MS` | `CLAUDE_PROXY_SESSION_GC_LOCK_WAIT_MS` | `2000` | External lifecycle-lock acquisition budget, starting only at the head of the local FIFO; minimum 100 ms. Local queue waiting does not consume this budget and is not bounded by two seconds. Each lock allows 256 waiting callers; a holder stalled for 60 seconds rejects queued/new callers without unlocking its transaction, unless the deadline itself ran late because the event loop was blocked. An answered turn whose terminal publication meets any of these errors is still delivered; its next turn replays history. Request cancellation removes queued work or cancels acquisition, never an executing durable transaction; cleanup remains uncanceled. External timeout, queue capacity and stalled-holder failures answer **503 `overloaded_error`** with distinct reasons. |
| `MERIDIAN_SESSION_PROFILE_COPY_PRUNE` | `CLAUDE_PROXY_SESSION_PROFILE_COPY_PRUNE` | `0` | Opt in to removing stale cross-profile session mappings during GC. Off preserves native resume history. Returning to a pruned profile uses flattened, context-trimmed replay, which cannot restore SDK thinking. |
| `MERIDIAN_SESSION_PROFILE_COPY_GRACE_MS` | `CLAUDE_PROXY_SESSION_PROFILE_COPY_GRACE_MS` | `86400000` (24 hours) | With several profiles, the same conversation gets its own stored session under each profile it has run on. When profile-copy pruning is enabled, on every session GC sweep a copy is removed once a newer copy of that conversation exists under another profile and the older copy has not been used for this many milliseconds. The newest copy, copies of a conversation with a request in flight, and mappings a priority route depends on are always kept. A conversation that returns to a profile while its copy exists resumes that profile's own session, unless another profile's copy holds more of the history the client sends (the conversation took turns there since), in which case it is replayed as below; after removal it is replayed into a fresh session on that account, as flattened history trimmed to the model's context window. The default covers an account's 5-hour usage window resetting and a day of switching back and forth. `0` keeps only the newest copy. Removal is paced to leave at least half of `MERIDIAN_SESSION_GC_MAX_PENDING` free for new requests, so a large store is trimmed over several sweeps. |
| `MERIDIAN_SILENT_TURN_RECOVERY` | `CLAUDE_PROXY_SILENT_TURN_RECOVERY` | `1` | Set to `0` to stop spending a recovery turn on a [silent turn](#silent-turns). Detection and telemetry stay on either way |
| `MERIDIAN_UPSTREAM_IDLE_MS` | `CLAUDE_PROXY_UPSTREAM_IDLE_MS` | `90000` | Milliseconds the upstream stream may go quiet before the turn is treated as stalled. Raise it for long-thinking turns that were being killed mid-flight; `0` disables the guard entirely. Applies to the recovery turn too. |
| `MERIDIAN_UPSTREAM_IDLE_MAX_CONSECUTIVE` | `CLAUDE_PROXY_UPSTREAM_IDLE_MAX_CONSECUTIVE` | `3` | Consecutive idle stalls for the same request and session before returning a terminal error. Identical retries are then rejected before another SDK query for one idle window (at least 60 seconds). A changed request or completed turn resets the streak; rejected retries do not extend the pause. `0` disables this ceiling. Tracking is bounded and local to the proxy instance; requests without a correlatable session are not pooled. |
| `MERIDIAN_UPSTREAM_UNREACHABLE_AFTER_MS` | `CLAUDE_PROXY_UPSTREAM_UNREACHABLE_AFTER_MS` | `120000` | How long connection failures must keep arriving, with no observed configured-Claude-egress answer in between, before `/readyz` reports this instance's Claude connection failed. See [Readiness and upstream reachability](#readiness-and-upstream-reachability). Wins over `upstreamUnreachableAfterMs` in `settings.json`. |
| `MERIDIAN_UPSTREAM_UNREACHABLE_HOLD_MS` | `CLAUDE_PROXY_UPSTREAM_UNREACHABLE_HOLD_MS` | `300000` | How long `/readyz` keeps failing after the latest connection failure before it lets traffic back in to observe the configured Claude egress again. `0` never fails readiness. Wins over `upstreamUnreachableHoldMs`. |
| `MERIDIAN_UPSTREAM_UNREACHABLE_MIN_FAILURES` | `CLAUDE_PROXY_UPSTREAM_UNREACHABLE_MIN_FAILURES` | `3` | Connection failures a run needs before it counts, however long it lasted. Wins over `upstreamUnreachableMinFailures`. |
| `MERIDIAN_SUPPRESS_SCRATCHPAD` | — | `1` | Set to `0` to disable prompt-level scratchpad suppression in passthrough mode (#627, #1049) |
| `MERIDIAN_SUPPRESS_SCRATCHPAD_ENV` | — | `0` | Set to `1` to also pass `CLAUDE_CODE_SESSION_KIND=bg` to the SDK subprocess. Disabled by default to prevent CLI 2.1.274+ from registering persistent phantom background jobs under `~/.claude/jobs/` (#1049) |
| `MERIDIAN_SUPPRESS_IMPLICIT_ATTACHMENTS` | — | `1` | Set to `0` to stop defaulting `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` in passthrough mode. Does not clear an explicitly inherited CLI setting. See [known limitations](#known-limitations). |
| `MERIDIAN_CACHE_KEEPALIVE` | — | unset (off) | Set to `1` to keep idle one-hour-cache sessions warm with a few small cache-read requests; `0` forces it off. Wins over `cacheKeepalive` in `settings.json`. See [Prompt-cache keepalive](#prompt-cache-keepalive). |
| `MERIDIAN_CACHE_KEEPALIVE_MAX_IN_FLIGHT` | — | `1` | Keepalive requests allowed to run at once across all sessions, clamped to `1`–`2`. |
| `MERIDIAN_COMPACTION_SURVIVAL` | — | `0` | Set to `1` to resume the old SDK session after a client shortens its history head into a summary. By default Meridian replays the supplied summary in a fresh SDK session so the removed context is released. Equal-length pruning still resumes. |
| `MERIDIAN_CONFIG_DIR` | — | `~/.config/meridian` | Meridian's own config directory. Moving it moves everything inside it — see [below](#relocating-the-config-directory). |
| `MERIDIAN_PRICING_CONFIG` | `CLAUDE_PROXY_PRICING_CONFIG` | `~/.config/meridian/model-pricing.json` | Path to the model pricing overrides file used by cost estimation |
| `MERIDIAN_PROFILES` | — | unset | JSON array of profile configs (overrides disk discovery). See [Multi-Profile Support](profiles.md). |
| `MERIDIAN_DEFER_TOOL_THRESHOLD` | — | `15` | Number of tools before non-core tools are deferred via ToolSearch. Set to `0` to disable. |
| `MERIDIAN_TELEMETRY_PERSIST` | `CLAUDE_PROXY_TELEMETRY_PERSIST` | unset | Enable SQLite telemetry persistence. Data survives proxy restarts. |
| `MERIDIAN_TELEMETRY_DB` | `CLAUDE_PROXY_TELEMETRY_DB` | `~/.config/meridian/telemetry.db` | SQLite database path (when persistence is enabled) |
| `MERIDIAN_TELEMETRY_RETENTION_DAYS` | `CLAUDE_PROXY_TELEMETRY_RETENTION_DAYS` | `7` | Days to retain telemetry data before cleanup |
| `MERIDIAN_TRANSCRIPT_RETENTION_DAYS` | `CLAUDE_PROXY_TRANSCRIPT_RETENTION_DAYS` | unset (off) | **Opt-in.** `1`-`3650` turns on Claude Code's own cleanup in request processes, which deletes **all** of its files older than that many days in each profile's config directory, not only transcripts. `0` pins it off over a saved setting; any other value is ignored. Wins over `transcriptRetentionDays` in `settings.json` (or the `/settings` page). See [Transcript retention](#transcript-retention). |
| `MERIDIAN_DEFAULT_PROFILE` | — | *(first profile)* | Default profile ID when no header is sent |
| `MERIDIAN_ADAPTER_INSTANCES` | — | unset | JSON [adapter instance](agents.md#adapter-instances) definitions, overriding `~/.config/meridian/adapter-instances.json` |
| `MERIDIAN_BETA_POLICY` | — | `allow-safe` | Client `anthropic-beta` header handling: `allow-safe`, `strip-all`, or `allow-all` |
| `MERIDIAN_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL` | — | canonical ids | Pin the model id the SDK resolves for each tier alias (e.g. `MERIDIAN_DEFAULT_OPUS_MODEL`); Haiku defaults to `claude-haiku-5-5` |
| `MERIDIAN_SESSION_DIR` | `CLAUDE_PROXY_SESSION_DIR` | `~/.cache/meridian` | Directory for the persisted session store |
| `MERIDIAN_NO_UPDATE_CHECK` | — | unset | Set to `1` to force the update check off even when the `checkForUpdates` setting is on. No outbound request is made at all when set. See [Build provenance](#build-provenance-and-staying-current). |
| `MERIDIAN_UPDATE_CHECK_URL` | — | npm dist-tags | Registry endpoint for the update check. Point it at a mirror on restricted networks; it must return `{"latest":"<version>"}`. |
| `MERIDIAN_UPDATE_CHECK_PATH` | — | `~/.cache/meridian/update-check.json` | Where the update check caches its result. |
| `MERIDIAN_UPDATE_CHECK_REGISTRY` | — | `https://registry.npmjs.org` | Registry the plugin update check asks for each plugin package's `/-/package/<name>/dist-tags`. When `MERIDIAN_UPDATE_CHECK_URL` is set and this is not, plugins are not checked at all (rather than asking the public registry); set both to check plugins through your mirror. |
| `MERIDIAN_PLUGIN_UPDATE_CHECK_PATH` | — | `~/.cache/meridian/plugin-update-check.json` | Where the plugin update check caches its results. |
| `MERIDIAN_BUILD_SOURCE` | — | *(derived from the install path)* | Overrides the `build.source` reported by `/health`: `npm`, `local`, or `dev`. Normally set by [`bin/meridian-launchd.sh`](#running-as-a-service-without-drift), not by hand. |
| `MERIDIAN_BUILD_SHA`, `MERIDIAN_BUILD_BRANCH`, `MERIDIAN_BUILD_DIRTY` | — | unset | Optional commit stamps surfaced in `/health` `build`. Absent unless something sets them at launch. |
| `MERIDIAN_ERROR_REPORTING_DSN` | — | unset | GlitchTip/Sentry DSN to report Meridian's own crashes to; `errorReportingDsn` in `settings.json` is the alternative, and the environment wins. Off when neither is set. See [Error reporting](#error-reporting). |
| `MERIDIAN_DEBUG` | `CLAUDE_PROXY_DEBUG` | unset | Set to `1` for verbose request/session logging |
| `MERIDIAN_SILENT` | `CLAUDE_PROXY_SILENT` | unset | Set to `1` to suppress startup output (used by embedding plugins) |
| `MERIDIAN_ENFORCE_MAX_TOKENS` | `CLAUDE_PROXY_ENFORCE_MAX_TOKENS` | unset | Set to `1` to apply the client output budget; see [output limits](#known-limitations). |
| `MERIDIAN_HOST_ID` | — | derived | Stable, unique container identity for session locks; see [deployment](deployment.md#persistence-and-host-identity). |
| `MERIDIAN_QUIET` | `CLAUDE_PROXY_QUIET` | unset | Suppress informational telemetry startup output; warnings and errors still print. |
| `MERIDIAN_AUTH_RENEWAL_WARN_DAYS` | — | `3` | Renewal warning horizon reported by health when credential renewal information is available. |
| `MERIDIAN_PLUGIN_DIR` | — | `<config dir>/plugins` | Plugin auto-discovery directory |
| `MERIDIAN_PLUGIN_CONFIG` | — | `<config dir>/plugins.json` | Plugin manifest path |
| `MERIDIAN_CHATGPT_CREDENTIALS` | — | unset | Serve GPT models from ChatGPT subscriptions: `owned`, `follow-external` or `off`. Unset means `owned` when Meridian's own ChatGPT store holds seats, else off. See [ChatGPT subscriptions](#chatgpt-subscriptions). |
| `MERIDIAN_CHATGPT_STORE_PATH` | — | `<config dir>/chatgpt-accounts.json` | Meridian's own ChatGPT seat store (`owned` mode). |
| `MERIDIAN_CODEX_POOL_PATH` | — | `~/.opencode/oc-codex-multi-auth-accounts.json` | The oc-codex-multi-auth store read in `follow-external` mode. |
| `MERIDIAN_CREDENTIALS_READONLY` | `CLAUDE_PROXY_CREDENTIALS_READONLY` | unset | Set to `1` to forbid this instance from refreshing or writing OAuth credentials. For a second instance sharing another's credential files — see [Read-only credentials](#read-only-credentials). |

†These are Meridian context defaults, not a billing guarantee. Availability and extended-context charges depend on the model and account; consult [Anthropic model configuration](https://code.claude.com/docs/en/model-config#extended-context). Historical Max/Team tests do not establish entitlement for another account.

### Haiku 5.5

The bare `haiku` alias defaults to `claude-haiku-5-5`. Use Claude Code **2.1.293
or newer** (including when selecting a system/custom executable). Haiku 5.5 has
a native **1M context window**, up to **128K output tokens**, and adaptive
thinking controlled by effort; it does not need a `haiku[1m]` SDK alias.
Explicit `claude-haiku-4-5` and dated 4.5 requests retain their requested model
and 200k context window (default replay allowance 160k, with a 20k reserve).
Shell/profile pins and `MERIDIAN_DEFAULT_HAIKU_MODEL`
still work; replay capacity follows the effective Haiku pin.

The tested Claude Code 2.1.296 / Agent SDK 0.2.141 path cannot reliably honor
explicit `thinking: disabled` or `thinking.display: omitted` on Haiku 5.5.
Meridian refuses those requests with HTTP 400 **before generation**, including
an authoritative adapter-off setting or a beta policy that disables thinking.
Use adaptive thinking with effort, omit display/use `summarized`, or explicitly
select Haiku 4.5. The native CLI converts legacy enabled/manual-budget inputs
to adaptive thinking on Haiku 5.5; a numeric thinking budget is not an adaptive
hard cap. Use effort for depth, or keep an explicit 4.5 pin for manual thinking.
The tested native SDK path preserves a 4.5 budget supplied as SDK-style
`budgetTokens`; conventional Anthropic `budget_tokens` is not translated by the
existing HTTP builder and was not preserved in the retained control. This change
does not fix that pre-existing limitation or guarantee snake-case manual budgets.
The disabled/omitted refusal is a native SDK limitation, not a claim that Haiku
5.5's API lacks those controls.

Built-in cost estimates use Haiku 5.5's short-prompt rates ($0.10 input / $0.50
output per million tokens). Above **100,000 prompt tokens**, including cache
reads and writes, the entire request uses $0.50 / $2.50 instead. Five-minute
cache writes cost 1.25× input and cache reads 0.10× input. Settings list the
short-prompt rates; custom overrides remain flat. These are API-value estimates,
not subscription bills; SDK-aggregated subrequests and one-hour cache writes
cannot be reconstructed exactly from the retained request totals. New Haiku
records retain the effective SDK pin for pricing, while request-key overrides
still win. Historical bare aliases without that pin use today's alias valuation,
not a reconstruction of the model actually served.

See Anthropic's [overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
and [migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide).

### Read-only credentials

`MERIDIAN_CREDENTIALS_READONLY=1` makes an instance incapable of modifying
credentials. It exists so a second instance — a development build, a staging
copy — can run beside a production one **against the same credential files**
without being able to corrupt them.

The hazard is two instances holding the same OAuth refresh token. Meridian
refreshes proactively on boot and every 45s. If Anthropic rotates a refresh
token on use, whichever instance refreshes first can invalidate the other's
copy, and the only recovery is an interactive `claude login` per account.

Sharing the files is usually not a choice. `profiles.json` is read from
`~/.config/meridian/` unconditionally — `MERIDIAN_CONFIG_DIR` relocates
`settings.json` only — so any second instance sees the same profile list
pointing at the same credential directories. This flag is what makes that
safe.

With it set:

| Behaviour | Effect |
|---|---|
| Proactive refresh on boot and every 45s | Not scheduled |
| Auth keepalive every 45s | Not scheduled |
| Renewing owned ChatGPT seats ahead of expiry, on boot and every 60s | Not scheduled |
| Auth-status cache (60s TTL) | Also invalidated when the credential file's mtime changes, so a rotation by the other instance is picked up on the next tick |
| Any credential write | Refused at the credential store, and logged to stderr |
| Any OAuth refresh request | Not sent — the grant would rotate the token server-side even if the result were never written |

The instance announces the mode once at startup. Reads are untouched: it
re-reads credentials from disk, which is how a refresh performed by the other
instance is picked up.

The refusal sits at the credential store rather than only on the two timers,
so a write path nobody anticipated fails loudly instead of silently corrupting
a token file the other instance depends on. If you see
`REFUSED credential write` in the log, a call path is missing a guard — the
message names the operation and the store, never a credential value.

**Limit — the SDK subprocess is outside this guarantee.** Meridian shells out
to the Claude Agent SDK with `CLAUDE_CONFIG_DIR` pointing at the profile's
directory. Anything that subprocess writes happens outside this process and
cannot be intercepted by a flag in it.

Measured on 2026-08-07 against a live proxy (Linux, Claude Code 2.1.198,
`claude-haiku-4-5`), hashing one profile's `.credentials.json` before and after
a single request routed to it:

- A control window spanning two 45s refresh ticks left the file unchanged,
  establishing a quiescent baseline.
- After the request (HTTP 200, a genuine SDK round trip), the file was
  **byte-identical** — same SHA-256, same mtime, same size.
- The subprocess is demonstrably willing to write to that directory: the same
  request updated `.claude.json`, `policy-limits.json`, `remote-settings.json`,
  `backups/`, `jobs/` and `sessions/`. It simply did not touch
  `.credentials.json`.

So on the path that matters in practice — the access token still valid, the
proxy having refreshed it earlier — the SDK does not write credentials back.

**Not measured:** whether the SDK writes the file when it has to refresh an
*expired* access token itself. Reproducing that requires either waiting out an
~8h token lifetime or editing a live credential file, and in this deployment
the proxy's own refresh (5-minute buffer) reaches it first. If the SDK does
write on that path, this flag cannot prevent it. Treat the guarantee as
covering everything Meridian does, not everything the subprocess might do.

### Relocating the config directory

`MERIDIAN_CONFIG_DIR` moves the directory Meridian keeps its own state in, so a
second instance pointed at an empty directory starts genuinely empty:

| File | Holds |
|---|---|
| `settings.json` | Active profile, routing mode, priority order, `checkForUpdates`, `cacheKeepalive`, page `layout`, `transcriptRetentionDays` |
| `profiles.json` | Configured profiles ([Multi-Profile Support](profiles.md)) |
| `profiles/<id>/` | Per-profile `CLAUDE_CONFIG_DIR` (credentials, SDK state) |
| `adapter-instances.json` | [Adapter instances](agents.md#adapter-instances) |
| `sdk-features.json` | Per-adapter [SDK feature toggles](#sdk-feature-toggles-experimental) |
| `model-pricing.json` | Cost-estimation overrides |
| `telemetry.db` | Persisted telemetry, when enabled |

`MERIDIAN_PRICING_CONFIG` and `MERIDIAN_TELEMETRY_DB` still win for their own
file when set. `XDG_CONFIG_HOME` is deliberately ignored: honouring it would
relocate the configuration of everyone who has it set, without them asking.

Plugins follow it too: `plugins/` and `plugins.json` default under this
directory, and `MERIDIAN_PLUGIN_DIR` / `MERIDIAN_PLUGIN_CONFIG` still win when
set. One path does **not** follow it yet: `design-token.json` still defaults
under `~/.config/meridian`; point a second instance's elsewhere with
`MERIDIAN_DESIGN_TOKEN_PATH`.

Running a second instance beside your usual one:

```bash
mkdir -p ~/.config/meridian-dev
MERIDIAN_CONFIG_DIR=~/.config/meridian-dev MERIDIAN_PORT=3457 meridian
```

That instance has no profiles until you add them (`MERIDIAN_CONFIG_DIR=... meridian
profile add ...`), and switching its active profile cannot disturb the other one.
Upgrading from a version where the variable moved `settings.json` alone? Your
profiles stay where they are — copy `profiles.json` and `profiles/` across, or
unset the variable. Meridian says so once at startup if it finds the new location
empty and the default one populated.

### Following another instance's active profile

`MERIDIAN_FOLLOW_ACTIVE=http://127.0.0.1:3456` makes an instance take its
active profile from the instance at that URL instead of from its own
`settings.json`.

This exists for running a development build beside a primary instance and
comparing them. `MERIDIAN_CONFIG_DIR` relocates `settings.json` and nothing
else, so a second instance keeps its **own** `activeProfile` — whatever moves
the primary's active profile (a click in the UI, `meridian profile use`, an
external scheduler) leaves the second instance serving from a different
account, and the comparison is no longer like-for-like.

The value is a Meridian base URL. A bare `host:port` is accepted and assumed
to be `http`. The followed instance is polled every 10s on `GET /profiles/list`
and the value is cached, so the request path never waits on the network.

What it does and does not change:

- **Replaces exactly one input** to profile resolution — the active profile.
  An explicit `x-meridian-profile` header still wins, per request.
- **Refuses to follow a profile this instance does not have.** The local active
  profile is used instead and the reason is reported; routing to a name that is
  not configured here would silently resolve to an unrelated account.
- **Never fails closed.** If the followed instance is down, slow, or answers
  something unusable, the last known value keeps being served. If a good value
  has never been read, the local active profile is used. A poll failure is
  logged once per outage, not once per poll.
- **A value that has not been confirmed for two minutes is still served**, and
  is flagged `stale` on `/profiles/list` and in the header chip. Falling back
  to the local value on a timeout would split the comparison exactly when you
  are least likely to notice.
- **`POST /profiles/active` is refused with `409`**, naming the followed URL.
  A local write would be shadowed on the next resolution and erased by the next
  poll — a picker that appears to work and silently doesn't. The web UI's
  account cards stop being clickable and `meridian profile use` prints the
  refusal.
- **No effect under `MERIDIAN_ROUTING=priority`** for unpinned requests, which
  are dispatched across the pool without consulting the active profile. Startup
  says so if both are set.
- **Following your own address is refused** at startup: the followed value
  could never change and local switching would be refused, freezing the active
  profile permanently.

The mode is announced at startup and surfaced on `/profiles/list` as a `follow`
object (`url`, `activeProfile`, `followedValue`, `reason`, `stale`,
`lastSyncedAt`, `lastError`), which the shared header chip renders on every
page.

Limitation: the poll sends no credentials, so a followed instance behind
`MERIDIAN_API_KEY` will always fail the poll and the follower will fall back to
its local active profile.

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
| `POST /v1/sessions/:key/cancel` | Cancel live requests in a session subtree |
| `GET/POST /v1/design/*` | Claude Design MCP proxy (see [Claude Design MCP](agents.md#claude-design-mcp)) |
| `GET/POST /design-login` | OAuth flow for the design scopes |
| `GET /health` | Auth status, mode, plugin status, upstream reachability |
| `GET /livez` | `ok` while the process is turning; for restart supervisors |
| `GET /readyz` | `ok`, or `503` naming the failed checks: whether traffic should come to this instance. See [Readiness and upstream reachability](#readiness-and-upstream-reachability) |
| `PUT /upstream-reachability` | Force or clear the upstream reachability state, to test a load balancer; loopback clients only |
| `GET /inflight` | Client requests in flight per upstream; loopback clients only. See [Restarting when idle](#restarting-when-idle) |
| `POST /drain`, `DELETE /drain` | Best-effort bounded generation hold for local supervisors; configured API key required. See [Draining for a restart](#draining-for-a-restart) |
| `POST /auth/refresh` | Manually refresh the OAuth token |
| `GET /telemetry` | Performance dashboard |
| `GET /telemetry/requests` | Recent request metrics (JSON) |
| `GET /telemetry/summary` | Aggregate statistics (JSON) |
| `GET /telemetry/timeseries` | Requests, errors, tokens, cache hit rate, p50 latency and estimated cost per time bucket (JSON); see [Monitoring](../MONITORING.md#diagnostic-queries) |
| `GET /telemetry/logs` | Diagnostic logs (JSON) |
| `GET /metrics` | Prometheus exposition format metrics |
| `GET /profiles` | Profile management page |
| `GET /profiles/list` | List profiles with auth status (JSON) |
| `POST /profiles/active` | Switch the active profile |
| `POST /profiles/login/start` | Begin an OAuth login for a profile — returns the authorize URL (see [Re-authenticating from the web UI](profiles.md#from-the-web-ui-re-authenticate-a-profile-without-a-terminal)) |
| `GET /profiles/login/status` | Poll a started login: `waiting`, `completed` or `failed` |
| `POST /profiles/login/complete` | Finish that login with the code the user pasted back |
| `GET /callback` | Anthropic's OAuth redirect target. **Not** behind `MERIDIAN_API_KEY` — the redirect carries no key; acts only on a single-use `state` minted by `/profiles/login/start` |
| `POST /profiles/add/start` | Begin creating a new profile — validates the name and returns the authorize URL (see [Adding from the web UI](profiles.md#from-the-web-ui-add-a-profile)) |
| `POST /profiles/add/complete` | Finish that creation — writes the profile only once Anthropic returns credentials |
| `GET /v1/usage/quota` | Usage windows for the active profile (JSON) |
| `GET /v1/usage/quota/all` | Usage windows and Claude banked-reset grants with expiration dates for every profile (JSON) |
| `POST /v1/usage/quota/reset` | Explicitly redeem a Claude banked reset with `profile`, `grantId` and caller-owned `requestId`; [request and outcome contract](../MONITORING.md#redeeming-a-banked-reset) |
| `GET /settings` | Routing, SDK feature toggles, model pricing, telemetry storage, update-check, site-header and page layout UI |
| `GET/PUT /settings/api/updates` | Read or set `checkForUpdates` (JSON `{"checkForUpdates": true}`); takes effect on the running proxy. Also reports each loaded plugin's installed and latest version in `plugins`; turning it on also sends loaded plugins' npm package names to the registry |
| `GET/PUT /settings/api/header` | Read or set `showHostname` (JSON `{"showHostname": true}`): name the machine beside the header's status; takes effect on the running proxy |
| `GET/PUT /settings/api/layout` | Read or set the web pages' `layout`: `contained` (default, a centered column) or `wide` (spans the window, more cards per row). JSON `{"layout": "wide"}`, `null` to unset; applies on the next page load |
| `GET /plugins` | Plugin management page (`/plugins/list`, `POST /plugins/reload` for JSON/actions) |

Illustrative health response excerpt (versions and status vary by installation):

```json
{
  "status": "healthy",
  "version": "1.50.0",
  "build": { "source": "npm", "version": "1.50.0", "latest": "1.50.0", "updateAvailable": false },
  "auth": { "loggedIn": true, "email": "you@example.com", "subscriptionType": "max" },
  "mode": "internal",
  "plugin": { "opencode": "configured", "pi": "not-configured" }
}
```

`plugin.opencode` is `"configured"` when `meridian setup` has been run, `"not-configured"` otherwise.
`plugin.pi` is `"configured"` when `meridian setup --client pi` has installed the Pi extension, `"not-configured"` otherwise.
Claude and combined-provider health responses also carry `upstream.claude`, described under
[Readiness and upstream reachability](#readiness-and-upstream-reachability).

With `"showHostname": true` in `settings.json` (or the switch under **Site
Header** at `/settings`), `/health` also carries `"hostname"`, the machine's
name as the OS reports it, and the site header shows it beside the status, e.g.
`Operational · nwkr-desktop`. It is off by default because `/health` answers
without the API key.

This applies to Claude and standalone Antigravity health, including unhealthy
and draining responses; their status codes and other fields stay intact.
`/livez` and `/readyz` do not disclose the hostname. The header shows the first
DNS label (or a whole IP address), with the complete name in its tooltip.

`GET /settings/api/header` returns `{ "showHostname": false, "hostname":
"<OS name>" }` when off. `PUT` accepts a boolean, `null` to remove the saved
field, or an omitted field to preserve it; invalid values or bodies return
400. Both routes use the existing `MERIDIAN_API_KEY` gate when configured.
Health and header settings bypass caches, and disabling takes effect on
responses assembled after the setting changes, including probes already
waiting for auth. The UI permits one hostname save at a time and ignores
older health polls when a newer refresh has started.

Browser writes must originate from this server. HTTPS origins are also
accepted across an internal HTTP TLS-termination hop with the same preserved
public Host/port; explicit default 443 is equivalent to omitted HTTPS 443.
Foreign, opaque, malformed or different-port origins return 403. Forwarding
headers are not trusted. A reverse proxy that rewrites Host must preserve the
public Host for this route. CLI writes without an `Origin` header continue to
work through the API-key gate.

## Error reporting

Meridian can report its own uncaught exceptions and unhandled promise
rejections to a self-hosted [GlitchTip](https://glitchtip.com) or a Sentry
project. It is off unless you give it a DSN:

```bash
MERIDIAN_ERROR_REPORTING_DSN=https://<key>@glitchtip.example.com/<project-id> meridian
```

or `"errorReportingDsn": "https://<key>@glitchtip.example.com/<project-id>"` in
`~/.config/meridian/settings.json` (the environment variable wins). The value is
read once at startup.

- **Errors only.** An event carries the exception, its `cause` chain, stack
  frames, the Meridian release and the runtime name and version. No request
  or response content, headers, session ids, environment variables, argv,
  hostname, breadcrumbs, tracing or profiling. Token-shaped strings
  (JWTs, `sk-…` keys, `Bearer` values, Google OAuth tokens, URL credentials
  and query strings, `access_token=`-style pairs) are replaced with
  `<redacted>` before anything is written.
- **It never changes whether Meridian crashes.** A crash still exits exactly
  as it would without reporting; an error Meridian recovers from is still
  recovered from.
- **A collector outage costs nothing but the events.** Each event is written
  first to `<config dir>/error-reports/` (`0600` files, at most 500, dropped
  after 7 days) and posted afterwards: at once by a process that survives the
  error, by a short-lived detached child when the error ends the process, and
  otherwise on the next start. Nothing blocks and nothing throws when the
  collector is unreachable.

To check the wiring, run `meridian test-error-report` with the same
configuration. It crashes on purpose with a test error that shows up in the
project within seconds.

## Build provenance and staying current

`version` alone cannot tell you what an instance is running. It is read from
`package.json`, so a build made from a feature branch reports the same string
as the release it branched from. An instance serving uncommitted code is
indistinguishable from one serving the published version.

`build` answers the question `version` cannot:

| Field | Meaning |
|-------|---------|
| `source` | `npm` — resolved from a `node_modules` install, so `version` is trustworthy. `local` — running from a checkout or a build next to sources. `dev` — explicitly stamped as a development build. |
| `version` | The `package.json` version. Proof of what is running **only** when `source` is `npm`. |
| `sha`, `branch`, `dirty` | Captured from the local tree at build/startup, or from launcher stamps when no Git snapshot is available. `dirty` describes that captured tree, not later edits. |
| `kind` | Local execution: `artifact` for bundled output, `source` for direct TypeScript execution. |
| `releaseVersion` | Reachable release tag at build/startup, when available and not older than `package.json` (an older one means newer tags were never fetched). Never an invented next release. |
| `counter`, `counterScope` | Successful local build ordinal and its worktree-specific history ID. Absent for source runs or unverifiable artifacts. Compare counters only within the same scope. |
| `attemptId`, `certification` | Embedded artifact identity and its verification result. A process never adopts a newer artifact's identity after startup. |
| `branchUrl`, `commitUrl` | Public GitHub/GitLab links derived from the checkout's origin, without credentials, query strings or fragments. A dirty build links to its base commit, not its uncommitted edits. |
| `latest` | Newest published version, from the cached registry check. Absent until the check resolves, and on the first run of a fresh install. |
| `updateAvailable` | `latest` is strictly newer than `version`. Absent — not `false` — while `latest` is unknown, because "not checked" and "current" are different claims. |

The site header always shows the running npm version. Local builds show their
release base, build number (or explicit source/unnumbered status), branch, short
commit and dirty marker. Branch/commit links are blue; metadata is violet.

`GET /build-status` is available only for local/dev execution and uses the
existing optional API-key protection. It returns `{runtime, latest?, state,
buildsBehind?}` with `Cache-Control: no-store`. Runtime identity is immutable;
disk state is refreshed separately in a bounded worker, shared across requests
and refreshed on demand at most every ten seconds. An initial reading may be
`unknown` until the worker finishes. `behind` reports the difference between
successful build counters, for example `3 builds behind`. `current`, `rollback`,
`incomparable`, `source-changed`, `building`, `missing`, `invalid` and `unknown`
distinguish other outcomes rather than claiming an update without evidence.
Source edits alone never count as completed builds. npm installs return 404.

`npm run build` certifies output only after bundling, declarations, export fixes
and Node entrypoint checks succeed. Local records live under the worktree's
Git directory in `meridian-builds/`; deleting `dist` does not reset the counter.
Separate worktrees have separate histories. The runtime checks its embedded
identity against the success record and artifact hashes; missing or altered
evidence produces an unnumbered artifact, not a guessed number. Git-less source
archives still build but do not receive local counters.

Builds use owner-PID claim directories under `meridian-builds/`; competing builds
wait briefly or report contention. Claims belonging to exited processes are
reclaimed, never by age alone. An unreaped or reused PID can require operator
inspection. Source changes during a build prevent certification. This is local integrity checking,
not signed attestation or atomic deployment: do not replace a live `dist` while
it may still need to load chunks. Direct `bun run bin/cli.ts` execution is labeled
`source run`, with source drift rather than a build count. Unstamped archive
builds retain the existing local-build display and cannot claim disk freshness.
Unavailable Git before certification falls back to an uncertified archive build;
failed build gates never fall back or consume a successful-build number.

**The update check is off by default.** Nothing contacts the registry until you
turn it on, either in the **Updates** section of `/settings` or in
`settings.json`:

```json
{ "checkForUpdates": true }
```

Once on, it asks the npm registry's `dist-tags` endpoint (the same source
`npm install -g @rynfar/meridian@latest` resolves) once a day, caches to
`~/.cache/meridian/update-check.json`, times out after 5s, and never touches
the request path. If the registry is unreachable it keeps reporting the last
version it saw rather than dropping the field. Toggling it in the UI applies to
the running proxy; switching it off also clears `build.latest`.

The same pass checks every loaded plugin installed from an npm package, so
**turning the check on also sends the npm package name of each loaded plugin to
the registry** (one switch covers both checks; there is no separate one for
plugins). A plugin's package is the nearest `package.json` above the
file Meridian loaded, which gives its name and installed version. A lone file
dropped into `plugins/` (or a symlink to one), a private package, a package
whose `publishConfig.registry` names a non-public registry other than the
one being asked, and a
package.json that is not a JSON object are listed as not checkable, with the
reason. When `MERIDIAN_UPDATE_CHECK_URL` points Meridian's own check at a
mirror and `MERIDIAN_UPDATE_CHECK_REGISTRY` is unset, no plugin is checked and
every plugin says to set `MERIDIAN_UPDATE_CHECK_REGISTRY`. Each package is asked
once per interval however many plugins share it, at most four at a time and all
within one 5s deadline (so switching the check on answers in about 5s even on a
network that drops the requests), cached to
`~/.cache/meridian/plugin-update-check.json`, and a failed lookup is reported on
that plugin with the last version it saw. A plugin added by **Reload Plugins**
is checked at once. The results are listed under **Updates** on `/settings` and
in `plugins` on `GET /settings/api/updates`: per plugin `name`, `path`,
`status`, `checkable` (`reason` when false), `package`, `installed`, `latest`,
`updateAvailable`, `checkedAt` and `error`. The list is present while the
check is off, without `latest`.
`MERIDIAN_NO_UPDATE_CHECK=1` forces it off regardless of the setting, so a
fleet can refuse the call in one place. The launcher script's own install-time
check below is separate and has its own switch.

### Running as a service without drift

A service unit pointed straight at a checkout's `dist/cli.js` runs whatever was
last built there — so building on a branch and then restarting (a crash, a
reboot, `KeepAlive`) silently serves unreleased code.

`bin/meridian-launchd.sh` avoids that. It runs the **installed** package and,
**at start**, updates it when the registry is ahead (rate-limited to once an
hour so a crash loop cannot flood the registry), falling back to whatever is
installed if the network is down. Every path ends in `exec` — a launcher that
refuses to start is a proxy that is simply down.

A long-running instance is never updated underneath itself; it reports the
newer version through `build.updateAvailable` and picks it up on the next
restart.

The script ships with the package, so a global install already has it, under
`<package root>/bin/meridian-launchd.sh`:

```bash
# npm:   $(npm root -g)/@rynfar/meridian
# volta: ~/.volta/tools/image/packages/@rynfar/meridian/lib/node_modules/@rynfar/meridian
# or run from a checkout: <repo>/bin/meridian-launchd.sh
```

```xml
<key>ProgramArguments</key>
<array>
    <string>/absolute/path/to/bin/meridian-launchd.sh</string>
</array>
```

It is a plain POSIX script with no launchd-specific logic, so it works equally
well as a systemd `ExecStart` or any other supervisor's command.

To run a local build instead, opt in explicitly — it will announce itself as a
`dev` build in `/health` and in the site header:

```bash
MERIDIAN_DEV_BUILD=1 MERIDIAN_PORT=3457 bin/meridian-launchd.sh
```

Set `MERIDIAN_NO_SELF_UPDATE=1` to keep the launcher's package resolution but
skip the update step.

## systemd socket activation

On Linux, run the service under **Node** when using systemd socket activation. The daemon adopts the single listening fd passed in `LISTEN_FDS=1` when `LISTEN_PID` matches its own pid. Bun 1.3.14 does not adopt that fd correctly. The CLI skips its port probe for an activated service, because probing the socket would start the service again.

Example user units:

```ini
# ~/.config/systemd/user/meridian.socket
[Unit]
Description=Meridian proxy socket

[Socket]
ListenStream=127.0.0.1:3456

[Install]
WantedBy=sockets.target
```

```ini
# ~/.config/systemd/user/meridian.service
[Unit]
Description=Meridian proxy

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/meridian/dist/cli.js
Environment=MERIDIAN_IDLE_EXIT_SECONDS=600
Restart=no
```

The idle exit setting is optional. It starts a graceful shutdown after the configured period without a model request; the socket unit starts a new process on the next connection. The inherited fd is not passed on to the SDK subprocess. [E59](../E2E.md#e59-node-socket-activation-and-idle-exit) describes the process-level probe.

## Readiness and upstream reachability

Two probes for whatever sits in front of Meridian, shaped like
kube-apiserver's: plain text `ok` when everything passes, and with `?verbose`
one `[+]name ok` / `[-]name failed: reason` line per check.

- `GET /livez` answers whether a restart would help. It has no checks: reaching
  it means the process is turning. Point a restart supervisor here.
- `GET /readyz` answers whether traffic should come to this instance rather
  than another one. It answers `503` naming the failed checks: `profiles` (no
  account configured), `claude-executable` (no CLI resolved) and
  `upstream-claude` (native Claude traffic from this instance has definite connection failures).

Neither needs the API key: a load balancer reads a `401` as "down".

`upstream-claude` exists for a host whose network still serves HTTP while it
has definite connection failures to its configured Claude egress: a dead resolver, a broken route, a firewall. Without it
such an instance looks ready, keeps its share of traffic, and every request
spends the CLI's whole retry budget before failing with "API Error: Can't reach
the API server".

- **Only connection failures count**: DNS (`ENOTFOUND`, `EAI_AGAIN`), refused,
  reset, no route, connect-only timeouts, TLS and proxy-tunnel failures, read
  from validated native terminal error envelopes on real SDK queries. A null
  retry status is ambiguous (it includes slow/read timeouts) and supplies no
  evidence. Generic timeout text, bare timeout codes, arbitrary model/tool
  text, replay and synthetic normal answers do not change the check.
- **Transport answers**: a valid native `system/api_retry` integer HTTP status
  from 100 through 599, or a fresh real response start, clears the failure run
  for this instance. This includes configured-egress refusals; it does not
  establish Anthropic origin, usable credentials or successful inference.
  HTTP-looking strings and bare error enums are insufficient. Old streaming
  completions cannot clear an outage that began after their response start.
- **When it fails**: after at least 3 connection failures spanning 2 minutes
  with no answer in between.
- **For how long**: until 5 minutes after the latest failure. Then the check
  passes again, so real traffic can observe the configured Claude egress: the first
  answer clears it, and the first failure fails it again at once.
- **Passive**: Meridian never sends a request just to test reachability.

```text
[-]upstream-claude failed: This instance's configured Claude egress failed since 2026-10-01T21:00:00.000Z (last error: dns, 7 connection failures, last answered 2026-10-01T20:59:58.000Z)
readyz check failed
```

The thresholds are `upstreamUnreachableAfterMs`, `upstreamUnreachableHoldMs`
and `upstreamUnreachableMinFailures` in `settings.json`, or the
`MERIDIAN_UPSTREAM_UNREACHABLE_*` variables in the
[environment table](#configuration). `MERIDIAN_*` takes precedence over its
`CLAUDE_PROXY_*` alias, then a valid persisted numeric setting, then the default;
invalid environment values fall back to the persisted value. Values must be
non-negative safe integers: timing values are bounded by the representable Date
range, and the minimum failure count is at least one. Non-object or malformed
settings and incorrectly typed values are ignored. They are re-read on every
evaluation. A hold of `0` records the observations without failing readiness.
State is ephemeral and local to each server instance, including embedded
instances that share SDK capacity. Accounts on that instance aggregate; another
instance or Antigravity traffic cannot clear it. `ok` means there is no currently
declared outage; it can retain failures below the detection threshold, and a
forced-ok override can mask a natural outage. It is not a fresh reachability
guarantee.

`/health` reports the state as `upstream.claude` (timestamps ISO-8601 or `null`;
no error text, account or token):

```json
"upstream": {
  "claude": {
    "state": "unreachable",
    "since": "2026-10-01T21:02:00.000Z",
    "failingSince": "2026-10-01T21:00:00.000Z",
    "consecutiveFailures": 7,
    "lastReachedAt": "2026-10-01T20:59:58.000Z",
    "lastFailureAt": "2026-10-01T21:03:10.000Z",
    "lastErrorKind": "dns",
    "holdUntil": "2026-10-01T21:08:10.000Z",
    "override": null
  }
}
```

`state` is `ok`, `unreachable` or `probing` (the hold has expired and traffic is
let back in). The site header shows it too: a red "Claude connection failed" pill and a
yellow "Rechecking Claude connection" one while probing. Details name this
instance's configured Claude egress and open on hover or button activation;
Escape or blur dismisses them.
Draining and offline status retain precedence. Combined instances label the
Claude observation explicitly; it does not describe Antigravity availability.
The hostname and build provenance retain their existing header positions.

To test a load balancer's failover without breaking a host's DNS, force the
state from the host itself:

```bash
curl -X PUT http://127.0.0.1:3456/upstream-reachability \
  -H 'content-type: application/json' -d '{"state": "unreachable", "ttlMs": 300000}'
curl -X PUT http://127.0.0.1:3456/upstream-reachability \
  -H 'content-type: application/json' -d '{"state": null}'
```

`state` is `"unreachable"`, `"ok"` or `null` to clear; `ttlMs` defaults to ten
minutes and is capped at a day, so a forgotten override expires. Like
`/inflight`, only a loopback peer without forwarding headers gets an answer;
when `MERIDIAN_API_KEY` is set the key is required as well. Browser writes must
pass the same Origin policy as header settings: exact origin, or the narrow
HTTPS-to-HTTP TLS-termination bridge preserving Host/port (including explicit
default 443). Foreign, opaque, malformed and different-port origins are
rejected. CLI requests without Origin are permitted after the loopback/key
checks. Forwarding headers never confer authority. Responses are no-store.
Forced `ok` masks only the reachability check, preserving executable/profile
checks and shutdown behavior. Natural observations continue underneath an
override and resume after expiry or clear; `since` describes the visible forced
state truthfully.

## Restarting when idle

`GET /inflight` lets a supervisor on the same host observe admitted client
HTTP requests before requesting a graceful shutdown:

```json
{
  "scope": "client-http",
  "at": "2026-09-28T11:02:03.456Z",
  "total": 3,
  "oldestStartedAt": "2026-09-28T11:01:40.012Z",
  "upstreams": {
    "claude": { "streams": 1, "requests": 0, "queued": 2 },
    "antigravity": { "streams": 0, "requests": 0, "queued": 0 },
    "chatgpt": { "streams": 0, "requests": 0, "queued": 0 }
  }
}
```

- `scope` is `"client-http"`. `total` counts admitted Claude Messages requests
  (including internal OpenAI translations), combined Antigravity POSTs and
  ChatGPT gateway turns; zero
  means that none of those requests is currently admitted. It does not mean
  that restarting will interrupt no work. Each request counts once: in `queued`
  while it waits for its session's turn or a free SDK slot, otherwise in
  `streams` or `requests` by whether the client asked for a stream. A request
  stays counted until its application response body is consumed by the HTTP
  adapter, cancelled or failed. This is not an acknowledgement of remote receipt.
- `oldestStartedAt` is when the longest-running of them arrived, or `null`.
- `antigravity` appears only with `MERIDIAN_BACKEND=combined` and counts
  `POST /antigravity/*` requests. Background Responses jobs that keep running
  after their `POST` returned and processes waiting for a client tool result
  are not counted. The standalone
  `MERIDIAN_BACKEND=antigravity` server does not serve `/inflight`.
- `chatgpt` appears only when the ChatGPT gateway is configured and counts
  every turn it serves on `/v1/responses` and `/v1/messages`.
- Meridian's own background work (token refresh, usage polling, session
  cleanup) is never counted.
- Only a loopback peer (`127.0.0.0/8`, `::1`) gets an answer, and not through a
  proxy: a request with `Forwarded`, `X-Forwarded-For` or `X-Real-IP` gets
  `403`, as does any other address. No API key is needed. The response holds
  counts only: no session ids, prompts, profiles or accounts.

A request arriving between a probe and the restart is not covered by the
probe. Use the [graceful shutdown](#graceful-shutdown) drain; this endpoint
is not an admission barrier. Background Responses jobs are not restart
resumable, so a supervisor must also wait for those jobs and pending client
tool continuations to finish through their own lifecycle APIs.

### Draining for a restart

Overlapping traffic can prevent `total` reaching zero. `POST /drain` opens a
best-effort idle opportunity by delaying new generation requests while already
admitted work continues. A zero snapshot does not authorize a safe restart or
transfer accepted client connections. Long requests, time caps, saturation and
background work can still prevent idle; a supervisor must give up or retry.

- DELETE or the drain timeout releases held requests normally. Each request
  also proceeds after its individual `holdMs` cap. There is no guarantee that
  a client will tolerate the delay without its own timeout or retry.
- A drain ends on `DELETE /drain`, after `timeoutMs`, or when Meridian begins
  shutting down. At shutdown the held requests get the shutdown `503` with
  `Retry-After`, as any new request does.
- Held requests are not in `total`; `drain.held` counts them.
- It holds Claude Messages and public OpenAI generation translations once,
  plus combined Antigravity generation submissions (`/v1/messages`,
  `/messages`, `/v1/chat/completions`, `/v1/responses` under `/antigravity`).
  Cancellation, token estimates, polling/retrieval/deletion and other control
  operations remain usable. Every admitted combined-provider POST retains its
  existing HTTP count. Background Responses
  jobs and pending client tool continuations keep running and are not held, so
  a supervisor still waits for them through their own lifecycle APIs.
- Body (optional JSON): `holdMs` (default 60000, 1000-240000) and `timeoutMs`
  (default 600000, 10000-3600000). A `POST` while a drain is active changes
  nothing and answers `started: false`.
- The options body is limited to 1 KiB and a two-second read deadline. Shutdown
  or socket abort revokes a pending read's authority. At the internal limit of
  128 retained held reservations, additional requests proceed normally;
  saturation does not increment `admittedAtCap`. This bounds held reservations,
  timers and listeners, not all HTTP payloads or total server memory.
- POST/DELETE require the actual loopback peer, no Forwarded/X-Forwarded-For/
  X-Real-IP headers, and no Origin header, including empty or `null`. If
  `MERIDIAN_API_KEY` is configured, the matching `x-api-key` or Bearer key is
  also required. GET `/inflight` keeps its existing keyless read-only policy.
- Same-key and declared subtree cancellation reaches live, parsed held
  requests without remembering a cancellation for later requests. Socket
  abort removes its waiter before any SDK/session-store work. A body-only
  identity cannot be registered before its JSON bytes arrive. Held requests
  keep the existing opt-in idle-exit lifetime busy.
- State belongs to this instance and disappears at restart. Authorized local
  operators share it; the first caller has no exclusive lease. Standalone
  Antigravity is unchanged. Soft-hold `draining` is distinct from shutdown
  health/readiness and does not change them.

`GET /inflight` reports it:

```json
{
  "scope": "client-http",
  "total": 0,
  "draining": true,
  "drain": {
    "active": true,
    "startedAt": "2026-09-30T12:00:00.000Z",
    "endsAt": "2026-09-30T12:10:00.000Z",
    "holdMs": 60000,
    "held": 2,
    "admittedAtCap": 0,
    "lastEnded": null
  }
}
```

A supervisor that gives up calls idempotent `DELETE /drain`. During shutdown,
held clients receive the existing route-appropriate 503/Retry-After response;
their client must retry if appropriate. A replacement process has no previous
hold or accepted connection ownership.

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
- New `/v1/messages`, `/v1/chat/completions` and `/v1/responses` requests are
  rejected with `503` and header `x-meridian-draining: 1`. Each is checked at
  its own public entrypoint, so a request the proxy already accepted is never
  refused part-way through the internal translation hop:

  ```http
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

  `/v1/responses` reports errors in the OpenAI envelope, so it returns the same
  status, header and `type` in its own shape — `{"error": {"type":
  "overloaded_error", "message": "...", "code": null}}`. Match on the status
  code or the `x-meridian-draining` header rather than the body shape.

- Requests already in flight when draining started are left to finish; the
  port only closes once they're all done or the grace period elapses,
  whichever comes first. If the grace period elapses first, a warning is
  logged and any remaining HTTP connections are forcibly closed.

## Transcript retention

Every request leaves a Claude Code transcript on disk -
`projects/<project>/<session>.jsonl` and its sidecar files - in the config
directory of the profile that served it (`~/.claude` without profiles).
Claude Code has its own retention cleanup, but it runs only when an enabled
settings source names `cleanupPeriodDays` or its user settings are loaded, and
Meridian normally starts Claude Code with every settings file switched off so
nothing on the proxy host leaks into a request. So, by default, nothing cleans
that directory and it keeps growing.

**Retention is off by default.** Turn it on with
`MERIDIAN_TRANSCRIPT_RETENTION_DAYS`, `transcriptRetentionDays` in
`settings.json`, or the `/settings` page (1 to 3650 days; the environment
wins, and `MERIDIAN_TRANSCRIPT_RETENTION_DAYS=0` pins it off over a saved
value). Meridian then passes the period to every request's Claude Code process
as a flag setting, which loads no settings file. A change applies to the next
request.

**What it deletes.** This is Claude Code's cleanup, not Meridian's, and it is
not limited to transcripts. In each profile's config directory it deletes,
by modification time alone, everything of its kind older than the period:

- transcripts, **including conversations Meridian still maps or pins** -
  their next request finds no transcript to resume and Meridian replays the
  history the client sent into a fresh session (flattened text trimmed to the
  model's context window; SDK thinking is not restored);
- file history, plans, tasks, uploads, shell snapshots, debug logs, backups,
  and Claude Code's other caches, jobs and logs.

Without profiles that directory is your own `~/.claude`, shared with your
interactive Claude Code.

- **A config directory's own `settings.json` wins** when it sets
  `cleanupPeriodDays` and retention is on here, so a retention you chose for
  interactive Claude Code still holds. If that file cannot be parsed, or names
  a value Claude Code would reject, no period is passed for that directory.
  A `cleanupPeriodDays` from your organisation's managed settings outranks all
  of these inside Claude Code. With `MERIDIAN_LOAD_CONTEXT=1` or `claudeMd:
  full`, the period Meridian passes also outranks one in a loaded project or
  local settings file.
- **Meridian never passes `0`.** Current Claude Code rejects
  `cleanupPeriodDays: 0` as invalid, and older versions read it as "write no
  transcripts at all".
- **When it runs:** Claude Code cleans up in the background a few seconds after
  a request's process starts, at most once a day per config directory
  (`.last-cleanup` there records the last run). A short request's process often
  ends before the cleanup gets going (in testing, a process that lived under
  about 5 s never cleaned up), and a profile that serves no requests is never
  cleaned: Meridian runs no cleanup process of its own.
- **The first cleanup can wait a day.** Claude Code stamps `.last-cleanup`
  even when retention is off and it skips the deletion, so after you turn
  retention on, a config directory that served a request in the previous
  24 hours deletes nothing until that stamp is a day old.
- **Race with a resume:** a conversation idle for longer than the period whose
  resume is still loading its transcript while a concurrent cleanup deletes it
  can lose its earlier SDK-side history without Meridian noticing. This only
  happens with retention on.

**Off does not mean "keep everything".** With retention off Meridian passes no
period and changes nothing about Claude Code's own behavior, which is exactly
what it does without this setting. If an instance loads Claude Code settings
files (`MERIDIAN_LOAD_CONTEXT=1`, or an adapter's `claudeMd` set to `full`
outside passthrough), Claude Code's user settings are enabled and it applies
your own `cleanupPeriodDays`, or its default of 30 days, as it always has. A
loaded project settings file or your organisation's managed settings that name
a period are applied the same way.

## Session identity

Meridian resumes the backing Claude SDK session between turns. Resuming is
what keeps the model's own earlier turns in context and what keeps the prompt
cache warm; a turn that cannot resume is sent as a fresh session and pays to
re-write its prompt prefix.

Identity is resolved in this order:

1. **The adapter's session header**, if the client sends one.
2. **An id the adapter reads out of the request body**, for clients that carry
   one there instead (`claudecode`, `pi`, `prime`, `letta`).
3. **An id Meridian derives for a client-driven tool loop** — `tool-loop:<hash>`
   from the loop's own first tool-call id — for a headerless generic OpenAI
   client that resends its whole growing conversation every round (`openai`).
4. **A conversation fingerprint** — a hash of the opening user message plus the
   client working directory — when none of the above applies.

The fingerprint is a fallback, not an equivalent. It cannot distinguish two
concurrent conversations that open with the same text, and it moves if anything
rewrites the opening message. It is also blind to identity carried inside a
`<system-reminder>` block, which is stripped before hashing — that is why Letta,
whose conversation id lives in exactly such a block, reads the id directly
rather than relying on the fallback. For a headerless OpenAI tool loop, the
first tool-call id distinguishes concurrent runs of the same workflow even
when their opening text and working directory match.

| Adapter | Session identity it reads |
|---|---|
| `opencode` | `x-opencode-session`, then `x-session-affinity` |
| `pi`, `prime` | `x-session-affinity`, then `metadata.user_id` `{"session_id": …}` |
| `claudecode` | `metadata.user_id` `{"session_id": …}` |
| `codex` | `x-codex-session` |
| `crush` | `x-session-id`, then `x-session-affinity` |
| `jcode` | `x-jcode-session` |
| `letta` | The `conv-<uuid>` id in the agent-info block Letta places in its opening user message (no session header) |
| `passthrough` (LiteLLM) | `x-litellm-session-id` |
| `cherry` | Inherits OpenCode header handling |
| `openai` | OpenCode header handling, then `x-session-id`; a headerless generic OpenAI tool loop additionally gets a derived `tool-loop:<hash>` key, so it resumes instead of packing |
| `polytoken` | Nonblank `x-polytoken-conversation`, falling back to `x-polytoken-session` |
| `droid`, `forgecode` | none — fingerprint fallback |

### Claude Code behind a gateway

The bypass described below exempts Claude Code, because Claude Code owns its
tool loop but still expects Meridian to resume the backing SDK session. That
exemption follows the **client**, identified by the `x-claude-code-session-id`
header the CLI sends on every request — not the adapter that happens to be
handling it.

This matters behind an API gateway. LiteLLM traffic resolves to the
`passthrough` adapter, so a Claude Code session used to lose the exemption; and
LiteLLM owns the `x-litellm-*` namespace for its own Langfuse session tracking
and does not forward `x-litellm-session-id` upstream on the `anthropic/`
provider route, so it had no session key either. Every tool round of the whole
agentic loop then took the bypass, measured in
[#820](https://github.com/rynfar/meridian/issues/820) at 35k-56k cache-write
tokens per turn with `cache_read` pinned at 30629, against 46-53 tokens on a
direct connection — one 764-turn session accumulated 90M cache-creation tokens.

Two things the header is deliberately **not** used for:

- **Adapter selection.** Routing gateway traffic to the `claudecode` adapter on
  this signal would swap tool handling, MCP naming and prompt shape for every
  existing LiteLLM user and move their prompt-cache prefix.
- **A session key.** The CLI reuses one session id across the auxiliary
  requests it makes alongside a conversation, so keying on it puts two
  unrelated histories under one key. Measured live, that produced
  `diverged=unrelated-history` and then `HTTP 400 This session advanced while
  the request was waiting` — a hard client failure where there had only been a
  silent inefficiency. Keying stays on the conversation fingerprint, exactly as
  a direct Claude Code request already does.

If you run LiteLLM and would rather it forward its own session header, an
explicit pass-through route restores it, and an explicit key always wins over
the fingerprint:

```yaml
general_settings:
  pass_through_endpoints:
    - path: "/meridian/v1/messages"
      target: "http://<meridian>/v1/messages"
      forward_headers: true
```

### Client-driven tool loops need a session header

A request whose last message is a `tool_result` is a round of the client's own
tool loop. A round with **no** session identity used to skip session lookup
entirely and run as a fresh session. A generic OpenAI-protocol client on
`/v1/chat/completions` no longer has to: Meridian derives `tool-loop:<hash>` from
the loop's first tool-call id and resumes. Nothing is claimed on the client's
behalf — the derived id is Meridian's own inference, so an unsettled tool
checkpoint resumes rather than being rebuilt, and a lost concurrency race
replays rather than returning a hard `400`.

The bypass still governs everywhere else. A headerless round with no tool-call
to anchor on, and a headerless round on any other transport, still runs fresh.
That is deliberate. Those rounds all collapse onto the same `(first user
message, working directory)` fingerprint, so a workflow engine running several
loops concurrently would have one run resume another run's Claude session and
corrupt it — premature `end_turn`, dropped tool calls. A conversation
fingerprint is not proof that two requests are the same chat; an explicit key,
or a per-generation tool-call id, is.

For an **interactive** client the same rule is expensive, because every
agentic turn ends in a `tool_result`:

- the model receives none of its own previous turns and re-derives the same
  intent each round, re-issuing the same read-only tool calls;
- the prompt cache decays to the static-prefix floor — `cache_read` stops
  moving while the conversation grows, and `cache_write` is paid again every
  round.

None of this fails a request. Every one returns 200, so it is invisible in
success metrics and shows up only as burn rate and a model that behaves as
though it has amnesia.

Send a session header and the loop resumes. If the client has no native
header, `x-session-affinity` is honoured by the `opencode`, `pi`, `prime` and
`crush` adapters.

Pi has no native header, but it exposes a `before_provider_headers`
extension hook. Save this as `~/.pi/agent/extensions/session-affinity.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const PROVIDER = "anthropic"

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_headers", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return
    // Without this, adapter detection does not resolve to `pi` and the
    // affinity key is not read the way the pi adapter reads it.
    event.headers["x-meridian-agent"] = "pi"
    const sessionId = ctx.sessionManager.getSessionId()
    if (sessionId) event.headers["x-session-affinity"] = sessionId
  })
}
```

Contributed by @odfalik and @RobertoNegro in
[#820](https://github.com/rynfar/meridian/issues/820) and verified there
against pi 0.84.1 with a full 27-tool configuration: turns 3 onward moved from
`lineage=new` to `lineage=continuation` at 99% cache hit rate and
`cache_write` around 214 tokens, against ~280k per turn on a control session
started before the extension existed.

The `provider` check is broad — it also sets both headers when the `anthropic`
provider points straight at `api.anthropic.com`, which is harmless since
unknown headers are ignored upstream. Gate on the resolved base URL being a
local Meridian endpoint instead if your pi version exposes it on the hook
context.

Extensions load at startup, so a pi session started before the file existed
keeps the old behaviour until pi is restarted.

### Reminders and changing request context

Meridian resumes an SDK session only when the next request extends its verified
history. A client that removes a plan reminder or limit warning from an earlier
message changes that history and gets a fresh replay (`modified-history`). The
client can keep the history append-only by persisting a new plan snapshot only
when the plan changes and retaining earlier warnings.

Meridian ignores exact `<system-reminder>...</system-reminder>` spans **inside a
text block** when hashing lineage. A Pi extension can therefore fold a notice
into an existing, persisted text block without changing that block's hash if
it adds nothing outside the tags, as observed in
[#1068](https://github.com/rynfar/meridian/issues/1068). For Pi and generic
passthrough, the notice still reaches the model on that request, and an SDK
session resumed on the next request **retains the earlier notice**. Omitting
it from the client's later request does not remove it from the SDK transcript.
Adding or removing a whole content block, changing text outside the tags, or
changing a tool result still changes lineage.

This hash rule accommodates client-generated reminder noise; it is not a
request-scoped context contract or a way to make content disappear from an
active model session. In particular, do not use it for secrets or instructions
that must be forgotten. For Pi and generic passthrough, persist advisory
snapshots in append-only history when client and SDK context must agree. An
explicit request-scoped context API was declined in
[#1068](https://github.com/rynfar/meridian/issues/1068); append-only advisory
snapshots remain the supported approach.

### Reading the log

Every request line carries `lineage=`, and every divergence also carries
`diverged=` naming why the turn did not resume:

| `diverged=` | Meaning |
|---|---|
| `not-found` | The key resolved to nothing — a first turn, or an evicted entry |
| `unverifiable` | An entry exists but cannot prove which history its session holds |
| `replayed-request` | The same history arrived again; a retry, not a continuation |
| `modified-history` | The stored prefix changed, so resume would skip history |
| `undo-gap` | An undo whose rollback point would omit supplied history |
| `unrelated-history` | The key resolved to a different conversation |
| `missing-session-header` | An OpenCode request arrived without its session header |
| `moved-on-elsewhere` | Another profile's copy, used since, holds more of the history; this profile's older copy would drop the replies given there, so the turn replays |
| `concurrent-race`, `priority-failback` | Lost a commit race; routed to another profile |
| `independent-request:headerless-tool-result` | The client-driven tool loop above |
| `independent-request:fork-source` | Declared `x-meridian-source: fork-*` |
| `independent-request:subagent` | Declared a subagent flow |
| `independent-request:no-cache-identity` | No header and no derivable fingerprint |

A resumed turn prints no `diverged=` field at all. The
`independent-request:*` causes skip session lookup before it happens; the rest
are the verdict of a lookup that ran.

`headerless-tool-result` also prints a one-time warning at the first
occurrence, because it is a property of how the client is wired rather than of
a single turn.

### Prompt-cache keepalive

Off by default. When a session sits idle long enough for its prompt cache to
expire, the next turn writes the whole conversation to the cache again. A
Claude Max (subscription) session through the Agent SDK writes the one-hour
cache tier, so short pauses already cost nothing; this only helps sessions
left idle for more than an hour, such as a user away at a meeting.

Turn it on with `MERIDIAN_CACHE_KEEPALIVE=1`, or `"cacheKeepalive": true` in
`settings.json` (the environment wins, and `MERIDIAN_CACHE_KEEPALIVE=0`
forces it off). Both are re-read on every turn and every scheduler tick, so
no restart is needed. There is no request header for it: the operator
decides.

When it is on:

- Only a main conversation (not a subagent, title or summary request) of a
  keyed passthrough session on a `claude-max` profile is eligible, and
  only while its latest real turn wrote the **one-hour** cache tier. A turn
  that writes the five-minute tier (API keys, Extra Usage) or that the client
  cancels stops keepalives for that session; a turn that stops at a tool call
  keeps them.
- About 55 minutes after the latest real turn, and 55 minutes after each
  keepalive, Meridian resumes the session's stored transcript exactly as the
  next turn would, adds a short prompt, and stops as soon as the response
  starts. At most three keepalives per idle period (about three hours); after
  that the cache is allowed to expire.
- The next real turn on the session ends the idle period and starts a new one.
  Side calls that share the session key (Claude Code's classifier and title
  requests) do not.
- Keepalives never change the session. They are not saved, so the next turn
  resumes the same transcript and mapping it would have without them.
- A keepalive is skipped, not queued, when it would take the last free SDK
  slot (`MERIDIAN_MAX_CONCURRENT`; with a limit of `1` keepalive never runs), when another keepalive is already running
  (`MERIDIAN_CACHE_KEEPALIVE_MAX_IN_FLIGHT`), and while the session's account
  is using Extra Usage, rate-limited, cooling down or benched from `[1m]`.
  It always uses the account the session was published under and never fails
  over to another profile.
- It is skipped when the cache has already expired, and at a tool checkpoint
  with more than eight pending tool calls, where it could not reuse the cache.
- Each keepalive still counts toward subscription usage, at the cached-input
  rate.
- Shutdown and drain stop new keepalives, abort a running one and wait for its
  Claude Code process to exit, like any other request.

Keepalives appear in `/telemetry` with `requestSource: "cache-keepalive"`.
They are left out of the request, error, cache-hit and cost figures and shown
separately (the **Cache Keepalive** section, `cacheKeepalive` in
`GET /telemetry/summary`, and `meridian_cache_keepalive_beats_total` in
`/metrics`). One that never reached upstream is a skipped refresh, not an
error.

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

```http
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
other and never see this concurrency error. Exceptions and lease behavior:

- **Concurrent-client adapters.** Pi (including Oh My Pi) declares concurrent callers under one key. Conflicting complete histories are replayed rather than refused merely for advancing while queued. Passthrough `modified-history` conflicts also take fresh replay. A replay can lose cache reuse.
- **Scoped per profile.** One session id backs an independent conversation
  per profile, each with its own resume cache. Turns under different profiles
  still serialize against each other (they share one id), but a commit under
  one profile never refuses a queued turn from another.
- **Declared concurrent flows are never refused.** A request whose
  `x-meridian-source` starts with `fork-` or `subagent-` has told Meridian it
  is knowingly running a parallel turn under a shared session key. Those
  turns are still serialized, but a stale lineage costs them a replay rather
  than a `400` — the behavior they had before serialization existed. A
  `subagent-` source also selects the base 200k model tier (for example,
  `opus` instead of `opus[1m]`) across adapters. Headerless subagent flows skip
  the shared fingerprint cache to avoid colliding with their parent; provide a
  distinct session key for multi-turn subagents that need warm cache resume.
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

## Session bookkeeping maintenance

Node 22: `meridian-bookkeeping <command> --session-dir /absolute/private/session-directory [--json]`.
The npm entry is `dist/session-bookkeeping.js`; this is not a proxy request endpoint.
Docker images include `/app/dist/session-bookkeeping.js`; invoke it with
`--entrypoint node` and the same private session-directory mount while writers
are stopped. Use a supported local filesystem for that mount; the container
writable overlay is not a supported SQLite data directory.

* `inspect` is read-only, holds a shared maintenance guard when one exists, and can run beside live proxies.
* Stop/drain **all** writers, then `migrate --writers-stopped`. The flag is the operator's assertion,
  not a conclusion from an empty lease table. Missing `--writers-stopped` exits **2**.
  An already READY store returns 0 without a new transition.
* `export-json` returns to legacy JSON, preserving current database documents, then releases its barriers.
* `abort-migration` reverses only a pre-database BARRIERS failure; otherwise resume migration or export.
* `recanonicalize` repairs derived mapping paths offline; resource rekeying requires export/correction/migrate.

After EXPORTED or ABORTED, a new migration archives the prior cycle in
`bookkeeping-cycles/<migration_id>/` before preparing a new cycle. An interrupted archival move resumes
from `session-bookkeeping-cycle.json`. Never move individual files by hand. The guard database, journals,
archived cycles, main database and WAL/SHM belong to the backup boundary.

Exit codes (all commands): **0** completed/already target; **2** usage; **3** refusal before transition
(quiescence, live/unknown candidate/gate, busy guard, capacity); **4** refusal with barriers or export already
active; **5** corrupt/unreadable state or replaced barrier; **6** caller uid differs from directory owner.
Code 3 permits the old binary only when the starting state was legacy; it does not undo a pre-existing READY
transition. Code 4 means **do not start legacy writers**: resume `migrate`, use `abort-migration` before any
database creation, or resume `export-json`. UID mismatch handling is implemented but not privilege-tested.

`inspect --json` reports `phase` (`legacy`, `prepared`, `barriers`, `imported`, `ready`, `exporting`,
`exported`, `aborted`, or `corrupt`), `migration_id`, `cycle_id`, `cycle_number`, `archived_cycles`, resource
counts by state, mappings, main/WAL/SHM sizes, barrier ownership (`own`, `foreign`, `none`), `candidates`,
`gates` and `temporary` residue lists, each with a relative `path` and `verdict`.
Incarnations proven dead are `dead-incarnation`; `live` requires an OS observation of a live process.
Darwin's second-resolution start time cannot prove incarnation equality, but an observed live process
at that identity still refuses maintenance. Unobservable/malformed identities are `unknown`.
Gate files do not persist an incarnation, so their verdict is `unknown`, never inferred from PID/age.
`temporary` lists `session-gc.json.tmp-<pid>-<uuid>` and `sessions.json.tmp-<pid>-<uuid>` files,
empty or nonempty, with byte size and SHA256 (interrupted legacy atomic writes).
A currently live local PID from the filename yields `live` and refuses maintenance; otherwise the verdict
is `unknown`, not a proof of a dead incarnation. Under `--writers-stopped`, these files are archived
intact as residue, never discarded because they are temporary or empty.
`turn-locks/` is outside bookkeeping and is neither listed nor moved.
An empty directory candidate lacking `owner.json` is `unknown` with `kind: "incomplete-candidate"`,
not corruption. Its original inode is captured by rename into a fresh UUID name under `residue/`, recorded
as `archiveName` in the migration journal before the move. An adjacent `<private-name>.manifest.json`
records source, private path, before/after device and inode, reason, and time. No source rmdir is used.
If identity differs after capture, the directory stays private and exit 5 names its location and manifest:
**nothing was deleted**. The operator must inspect it. There is deliberately no automatic directory rename
back to a public name: POSIX rename could overwrite a newly occupied empty directory. A nonempty source
observed before capture is refused without moving it.

For `migrate --writers-stopped`, the operator attests that all proxies **and SDK/deletion children**
have stopped. Under that attestation, unknown/dead residues are moved, not deleted, to
`bookkeeping-cycles/<migration_id>/residue/<relative-path>`. The PREPARED migration journal records
`residues` (path, verdict, SHA256, bytes, device/inode); the command returns the same list in
`result.residues`. File archival uses no-clobber links followed by journaled private capture of the source;
only that private name is deleted. Directory archival preserves the directory rather than copying/removing it.
A live candidate refuses migration with its address (3 from legacy; 4 if barriers are already active).
Other maintenance commands do not accept unknown candidates/gates. An already-ready CLI migrate is a
no-op and does not archive newly appeared residues. The current cycle's residue directory does not count
as an archived cycle. Inspection alone only reports residues, without applying the operator attestation.
**Deletion invariant:** bookkeeping never calls unlink/rmdir on a public name. Every retirement first
records a fresh private UUID name and observed identity durably, captures the public name by rename, and
checks the captured inode. Only `PrivatePath` capabilities reach the deletion wrappers. Barrier intent
lives in the migration journal; other file retirements have private `.deletion-intent.releasing-*` journals.
If the captured file is foreign, restoration uses link (never overwrite): EEXIST leaves the private file
intact and returns 5. Resume accepts the recorded identity; a missing capture with the original still public
starts a new capture with a new UUID. The accepted POSIX limit is that another process cannot name a newly
generated private UUID; the stop/drain attestation excludes live coordinators. Directory mismatch is
fail-closed without automatic restoration, at the operator's explicitly accepted recovery cost.
A foreign SQLite database without a migration journal refuses migration with 3 before guard creation.
If it appears between preflight and guard acquisition, the operation releases its lease and retires only
the guard inode it published itself, leaving the foreign main/WAL/SHM untouched. A pre-existing guard is
not adopted as disposable. Ordinary durable journal publication remains the metadata-write protocol;
the invariant above governs file retirement and restoration, not disabling journal updates.
Inspection never repairs permissions or bootstraps a missing guard. WAL without SHM requires offline recovery
rather than creating SHM during inspection. Without `--json`, output is indented for human reading.

All JSON output includes `timings.total_ms` and `timings.phases` (`phase`, `duration_ms`); use measured
production-size transitions to choose systemd `TimeoutStartSec`, not a guessed constant.

Both permanent legacy lock files (`session-gc.json.lock`, `sessions.json.lock`) contain one JSON line:

```json
{"backend":"sqlite","migration_id":"<uuid>","format":"meridian-bookkeeping-barrier-v1","instruction":"Stop all writers; use meridian-bookkeeping export-json. Never delete this barrier manually."}
```

This deliberately lacks the legacy canonical pid/incarnation/token owner tuple. Never delete these markers
manually. Release temporarily uses `<lock>.releasing-<migration_id>` and resumes after a crash from that name.
Old-package negative-write probes are a separate acceptance step; this command alone is not evidence for them.

## CLI Commands

| Command | Description |
|---------|-------------|
| `meridian` | Start the proxy server. When the port is already serving Meridian, prints `meridian status` and exits 0 instead of failing |
| `meridian status` | Print what the running instance is doing — the `/` page rendered for a terminal. Reads `MERIDIAN_HOST`/`MERIDIAN_PORT`; exits 1 when nothing of ours is there |
| `meridian setup` | Configure the OpenCode plugin in `~/.config/opencode/opencode.json` |
| `meridian profile add <name> [--headless]` | Add a profile and authenticate via Claude OAuth; `--headless` prints a URL, prompts for the returned code, and stores the exchanged credentials |
| `meridian profile add <name> --oauth-token [TOKEN]` | Add a headless profile from a `claude setup-token` value (prompts when `TOKEN` is omitted) |
| `meridian profile list` (alias `profile ls`) | List all profiles and their auth status |
| `meridian profile switch <name>` | Switch the active profile (requires running proxy) |
| `meridian profile login <name> [--headless]` | Re-authenticate an expired profile, adding it first if that name has no profile yet (browser-login profiles only); `--headless` uses the URL/code flow |
| `meridian profile remove <name>` | Remove a profile and its credentials |
| `meridian refresh-token` | Manually refresh the Claude OAuth token (exits 0/1) |
| `meridian chatgpt-migrate [--reverse] [--dry-run] [--step <steps>]` | Move ChatGPT accounts from oc-codex-multi-auth and opencode's OpenAI login into Meridian's store, or with `--reverse` hand them back. See [ChatGPT migration](#chatgpt-migration) |
| `meridian instance-import --from <dir> --to <dir> [--apply]` | Move one Meridian instance's ChatGPT seats, settings and telemetry into another, then retire the source. See [Moving ChatGPT seats between instances](#moving-chatgpt-seats-between-instances) |
| `meridian test-error-report` | Crash on purpose so the configured [error-reporting](#error-reporting) collector receives a test issue. Always exits 1; when reporting is off it only prints how to turn it on |

## ChatGPT subscriptions

Meridian can serve OpenAI models from ChatGPT subscriptions (Plus, Pro,
Business) beside Claude. A request for an OpenAI model (`gpt-*`, `chatgpt-*`,
`codex*`, `o<n>*`) on `POST /v1/responses` is passed through to the Codex
backend with one of your ChatGPT seats; every other model keeps going to
Claude. The ChatGPT path never enters the Claude pipeline: no Agent SDK, no
system prompt and no request plugins, so a Claude-oriented plugin cannot
rewrite a GPT request. A GPT model is never answered by Claude: on
`/v1/messages` it gets a 404 saying to use the Responses API.

`POST /v1/images/generations` and `POST /v1/images/edits` (the OpenAI Images
API) always go to ChatGPT, whatever model the body names, on the same seats
and with the same failover as a Responses turn. The body is sent to the Codex
backend's image endpoints as the client wrote it, and its JSON answer comes
back unchanged. Without ChatGPT they answer 404.

| `MERIDIAN_CHATGPT_CREDENTIALS` | Seats come from |
|---|---|
| `owned` | Meridian's own store (`MERIDIAN_CHATGPT_STORE_PATH`). Meridian takes a writer lease on it at startup and is the only program that renews its seats, each before its access token runs out. |
| `follow-external` | The oc-codex-multi-auth store (`MERIDIAN_CODEX_POOL_PATH`), read-only. Meridian never refreshes or writes it; that tool owns sign-in, renewal and removal. |
| `off` | Nowhere: GPT model names keep meaning Claude, as before. |

Unset, Meridian runs `owned` once its own store holds a seat, and is off
otherwise, so an instance nobody configured for ChatGPT is unchanged.

**Adding a seat** (`owned`): on `/profiles`, type a name and choose
**Connect with ChatGPT**, or run `meridian profile add <name> --chatgpt`
(`--headless` for a device code). ChatGPT redirects the browser to
`http://127.0.0.1:1455/auth/callback`; from another machine, paste the address
the tab ended on into the panel, or use the device code. Seats already signed
in to oc-codex-multi-auth move over with [`meridian chatgpt-migrate`](#chatgpt-migration).

**Seats are profiles.** `/profiles/list`, `/v1/usage/quota/all`,
`POST /profiles/active`, `/profiles/events` and `meridian profile
list|switch|rename|remove|login` cover seats as they cover Claude profiles,
with `type: "chatgpt"`. Each provider has its own active account. A turn goes
to the active seat, else the next seat with plan quota in the saved profile
order; a seat that is rate limited or refuses a model is benched and the next
one is tried before any output reaches the client. `x-meridian-profile` pins a
turn to one seat. `POST /profiles/chatgpt/remove` deletes an owned seat with
its credentials.

**Settings → ChatGPT** holds the gateway's own options: forwarding reasoning
summaries, a per-request cost cap, a fallback model, when a seat with its plan
spent may serve on purchased Codex credits (`never` by default), and where
free-plan seats rank.

**Telemetry and health.** Each turn is recorded with `adapter: "chatgpt"`,
valued at OpenAI list prices for the model that served it. `/health` carries a
`chatgpt` block (seat counts only) and judges the instance by every backend it
serves, `/readyz` counts seats as profiles, and `/v1/models` lists the models
the Codex backend's catalog offers.

Point an OpenAI-compatible client's base URL at `http://127.0.0.1:3456/v1`.
For OpenCode, set `provider.openai.options.baseURL` to that address.

## ChatGPT migration

`meridian chatgpt-migrate` hands ChatGPT subscription accounts from oc-codex-multi-auth (and opencode's own `openai` OAuth login in `auth.json`) to Meridian. Refresh tokens are single-use, so exactly one program may refresh each account; the command moves that authority rather than copying it.

| Step | What it does |
|------|--------------|
| `processes` | Lists running opencode processes that still hold the tokens in memory: those whose effective config loads the plugin, and, while `auth.json` holds an OpenAI login, every opencode process. A process whose config changed after it started counts only if that file may have listed the plugin when it started: the `.meridian-backup` the `plugin` step wrote shows when the plugin was removed, so a later unrelated rewrite of the file does not flag processes started after the removal. systemd units are named with the command that stops them. Nothing is killed |
| `import` | Reads every copy of every account (global and per-project stores, flagged store, `backups/`, keychain entries with `CODEX_KEYCHAIN=1` or `--keychain`, `auth.json`) and writes the freshest token per seat into Meridian's store. Accounts found only in backups need `--include-backup-only` |
| `strip` | Removes the refresh tokens from the plugin's stores under its own locks, removes the `openai` OAuth entry from `auth.json`, and moves `backups/` aside. Each original is kept as `<name>.meridian-backup` (mode 0600). A source holding a seat Meridian does not hold yet, or holds an older token for, is refused unless `--strip-unowned` |
| `plugin` | Removes oc-codex-multi-auth from every opencode config that loads it, global and project-level, and from the TUI configs (`tui.json`/`tui.jsonc`) that load its quota status bar, keeping comments |
| `provider` | Sets `provider.<id>.options.baseURL` (default provider `openai`, `--provider` to change) to Meridian in the global config file that takes precedence |
| `validate` | Checks through the running Meridian that each account reports its quota; `--test-prompt` also sends one short prompt on the cheapest model |

Steps run in that order; `--step import,strip` runs a subset. `import` and `strip` refuse while a process holds the tokens unless `--force`, which overrides that check and nothing else: the `processes` step then reports the holders without failing the run. Run with `--dry-run` first: it reads everything, writes nothing, and never prints a token. After `import`, run Meridian with `MERIDIAN_CHATGPT_CREDENTIALS=owned` (or unset) so it refreshes the accounts, and restart opencode after `plugin` and `provider`.

The store and the settings (where profile names are saved) are those of the Meridian server running at `--meridian-url`, found in `/proc` by its port, so an instance with its own `HOME` or `MERIDIAN_CHATGPT_STORE_PATH` is migrated into the files it actually reads. The command prints which ones it uses, and the flags to pass when that instance is stopped. `--store` and `--config-dir` win over everything, then `MERIDIAN_CHATGPT_STORE_PATH` and `MERIDIAN_CONFIG_DIR` when this shell sets them, then the running instance, then the defaults.

### Duplicates on import

`import` compares every seat with the ChatGPT profiles Meridian already holds:

- **Same seat** (same `accountUserId`): never a second profile. The one record keeps whichever token is fresher, and its profile name. Two records for one seat would hold one single-use refresh token twice, and the second renewal would fail.
- **Possible duplicate** (another `accountUserId` with the same email in the same workspace): imported under `<name> (possibly duplicate of <existing profile>)`, spelled as a profile id, e.g. `alice-shared-3b18-possibly-duplicate-of-alice-shared`. The name is saved in `chatGptProfileNames`; rename it on `/profiles` once checked. `--skip-possible-duplicates` leaves these seats out. Each such seat has its own refresh token, so importing it renews nothing twice.
- A seat whose refresh token Meridian already holds under another seat is refused.

Email alone is not identity (one person holds seats in several workspaces), and neither is the workspace (a Business workspace holds many people). The dry run prints every match.

### Reverse: handing seats back to oc-codex-multi-auth

`meridian chatgpt-migrate --reverse` undoes the migration, step by step:

| Step | What it does |
|------|--------------|
| `processes` | Lists opencode processes that still hold plugin tokens (refused for `handback` without `--force`), and the ones that need a restart to load the plugin again |
| `handback` | Writes Meridian's seats into the plugin's global store (`--plugin-store` for another), merged by `accountUserId`: every other account is kept, and the store as it was is preserved as `.meridian-backup`. A `.meridian-backup` original whose refresh token Meridian never renewed is restored whole; otherwise Meridian's current token is laid over the plugin's own record. Then the seats are removed from Meridian's store, under its writer lease, so exactly one program renews each. Stop Meridian first; a seat with an interrupted renewal is skipped unless `--include-interrupted` (`--force` only overrides the process check). `--seat <profile or seat id>` hands back only some |
| `plugin` | Puts oc-codex-multi-auth back in every config whose preserved original listed it, at its old position, and in the global file whose plugin list opencode uses. Its TUI status bar goes back into the `tui.json` files that listed it, or into the global `tui.json` (where the plugin's installer puts it) when none did. The spec is the one the original named, else `oc-codex-multi-auth@latest`; `--plugin-path <repo>` writes `file://<repo>` instead (it must be a checkout of the plugin; build it with `npm ci && npm run build`) |
| `provider` | Undoes the `provider` step: `baseURL` goes back to its value before the migration (or away), and the placeholder `apiKey` goes only if the provider had none before |
| `verify` | Checks that no seat is renewed by both, that opencode's global config loads the plugin and its global TUI config the status bar, and that the provider no longer points at Meridian |

The plugin restores opencode's own `openai` login in `auth.json` from its store when it loads; the `backups/` directory the forward `strip` moved aside holds spent tokens and stays aside. Restart opencode afterwards.

## Moving ChatGPT seats between instances

`meridian instance-import` folds one instance's ChatGPT seats into another, for example a separate ChatGPT instance into the one that serves Claude, so a single Meridian serves both. Each instance is named by its config directory (its `MERIDIAN_CONFIG_DIR`); `--from-store`/`--to-store` and `--from-telemetry`/`--to-telemetry` name a store or database the instance keeps elsewhere (`MERIDIAN_CHATGPT_STORE_PATH`, `MERIDIAN_TELEMETRY_DB`).

```bash
meridian instance-import --from ~/.config/meridian-gpt --to ~/.config/meridian          # what would happen
meridian instance-import --from ~/.config/meridian-gpt --to ~/.config/meridian --apply  # do it
```

| Moved | How |
|---|---|
| ChatGPT seats | Every account in the source's store, with its credentials unchanged and in its order, written through the destination store's writer lease |
| Seat names | `chatGptProfileNames`, `chatGptProfileAliases` and `chatGptActiveSeat` (unless the destination has an active seat of its own), so every seat keeps its profile name and former names |
| ChatGPT features | `chatgpt` and `integrations` keys the destination does not set; a value both set differently is a conflict. Routing order entries that name a seat |
| Prices | `model-pricing.json` overrides the destination does not have |
| Telemetry | Every request and diagnostic log entry, with all its columns, under the same profile ids, so each seat's requests and estimated value on `/` and `/telemetry` are what they were |

Other settings (`layout`, `claudeExecutable`, ...) and Claude profiles stay with their instance; a source with Claude profiles is refused. The plan is computed the way the destination will name its seats: a name the destination already uses for a Claude profile, a former name, or another seat, and requests filed under such a name, are conflicts, and nothing is written. `--rename <old>=<new>` files a seat, or requests filed under `<old>`, under another name.

With `--apply`, neither instance may be serving ChatGPT: stop the source, and the destination unless it has no ChatGPT seats yet (a destination still serving Claude may keep running). Telemetry is copied first, in short transactions beside the running destination, and read back column by column; then the settings; the seats last. Only after the whole destination has been checked again is the source retired: each file it read is renamed to `<name>.imported-<time>`, and nothing is deleted. A run that stops part-way leaves the source in place, and running the command again continues it without copying a request twice. Once it succeeds, restart the destination with `MERIDIAN_CHATGPT_CREDENTIALS=owned` (or unset).

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
- **Internal mode** — Claude Code handles everything. The SDK executes tools directly on the host, runs its full agent loop, and returns the final result. The `cherry` adapter uses this for built-in web tools. Generic OpenAI endpoints default to passthrough; choosing a chat UI does not itself enable internal tools.

Most users don't need to configure anything — the adapter sets the right mode automatically. To override:

```bash
MERIDIAN_PASSTHROUGH=1 meridian   # force passthrough
MERIDIAN_PASSTHROUGH=0 meridian   # request internal mode where the adapter permits it
```

Codex and Polytoken require client-owned tools and cannot be switched to internal mode. Adapter instances can also override the global preference.

### How tool calling works in passthrough

1. The client sends a request with tool definitions (read, write, edit, bash, glob, grep)
2. Meridian registers these as MCP tools so the SDK can generate proper `tool_use` blocks
3. The SDK produces a tool call → Meridian captures it and returns it to the client
4. The client executes the tool locally and sends the result back

For large tool sets (>15 tools), non-core tools are automatically deferred via the SDK's ToolSearch mechanism. Core tools (read, write, edit, bash, glob, grep) are always loaded eagerly. The deferral threshold is configurable with `MERIDIAN_DEFER_TOOL_THRESHOLD`.

**Digest-turn elimination** — after a tool call is captured, the SDK would normally invoke the model one more time to "digest" the denial before ending the turn. That extra invocation is discarded by the proxy but fully billed — and on always-thinking models like Fable it costs a full thinking pass each time.

Meridian eliminates it by capping `maxTurns` at 1 for passthrough turns, so the SDK stops at the tool-use boundary rather than starting the digest turn. The capped stop arrives as the SDK's `error_max_turns` result, which is safe to keep: the SDK can only report that from a `result` it has already enqueued, and it flushes its transcript on `result` — so the session is durably committed at the tool boundary and the next request resumes from it with the client's real `tool_result`. A turn that ends on its own (plain text, no tools) never asks for a second turn and so never trips the cap.

Measured against the live SDK (sonnet, one tool call), capped vs. uncapped: **66 vs 159 output tokens and 0 vs ~127k cache-read tokens** — the digest turn drags the CLI's full context along with it. Parallel tool calls are unaffected: the SDK surfaces them within a single turn, so all of them still reach the client.

The cap is lifted for the cases that genuinely need the SDK to keep going — deferred tools (ToolSearch discovery is a real round-trip), a configured advisor, and structured output — and an explicit `MERIDIAN_PASSTHROUGH_MAX_TURNS` always wins. Kill switch: `MERIDIAN_PASSTHROUGH_EARLY_STOP=0` restores the uncapped multi-turn behavior.

A lifted budget still stops at the tool boundary. Deferred tools and an advisor need turns *before* the client tool call, not after it, so whenever the budget is above one turn Meridian adds a `PostToolBatch` hook: once a batch holding a call forwarded to the client has resolved, the hook returns `continue: false` and the CLI ends the turn without another model request. The turn ends on a normal `success` result, so the transcript is committed at the tool boundary exactly as under the cap. The stop counts only calls Meridian captured for the client. A batch made only of other calls continues: SDK-internal ones (ToolSearch), a bare tool name the CLI refused, a repeat the hook dropped — so the CLI-refusal recovery (`MERIDIAN_PASSTHROUGH_UNCAPTURED_TOOL_RECOVERY`) still runs to `error_max_turns`. Not covered: the one-turn cap, where `error_max_turns` is the expected terminal shape; structured output, whose answer is a StructuredOutput call that can only come after the denial; and the kill switch, which removes the stop along with the cap.

> **Upgrade note.** If you previously set `MERIDIAN_PASSTHROUGH_MAX_TURNS` — most
> likely to give deep orchestration chains more headroom (#494) — an explicit
> budget still wins over the cap by design. A budget above one turn no longer
> pays for a digest turn: it gets the `PostToolBatch` stop described above, so
> the pin only adds headroom before the tool boundary. The reason the override
> was needed is largely gone: it existed because wide parallel tool calls could
> exhaust the budget, and the SDK now stops at the tool boundary instead of
> competing for turns with its own internal loop. If unsetting it causes
> trouble, that is worth an issue rather than a permanent pin.
>
> Two other behaviours change with the cap, both deliberate. A passthrough tool
> turn now ends on the SDK's `max_turns` result rather than a clean `success` —
> that is the normal, expected shape, and `passthrough.checkpoint_persisted` in
> `/telemetry/logs` is what confirms the session was preserved. And a turn that
> hits the cap having produced visible text but no forwardable tool call is reported
> as `stop_reason: "max_tokens"` (truncated) instead of failing the request.
> Empty text, thinking alone, or an uncaptured tool call do not qualify.
>
> A capped turn that produced *nothing* — no wire event, no captured tool call —
> never reached the tool boundary the cap exists to stop at, so the single turn
> bought nothing and cost the whole request. Meridian reissues that turn once
> with the cap lifted (`single_turn_cap_lifted` in `/telemetry/logs`), which is
> safe precisely because nothing had reached the client yet. An explicit
> `MERIDIAN_PASSTHROUGH_MAX_TURNS` suppresses the reissue too: the budget is
> then the operator's, and a second identical attempt would only spend a turn.

### Silent turns

A **silent turn** is a completed turn whose terminal envelope carries nothing the client can act on: no text, no tool call. On the wire it is indistinguishable from success — `stop_reason: "end_turn"`, HTTP 200, `error: null` — so a client does not retry, and an autonomous run treats a lost turn as a finished one.

Three separate defects have produced this shape (all fixed in rynfar/meridian#768): a session resumed from an interrupted tail, a client abort that never settled its session, and a spent `end your turn now` deny landing immediately before a boundary continuation. They have nothing in common but their outcome, so Meridian now guards the outcome directly:

- **Detection.** Every completed turn is classified: text or a tool call means productive, anything else is silent. `thinking` deliberately does not count — thinking plus an empty text block *is* the defect's signature. Silent turns are recorded as `response.silent_turn` in `/telemetry/logs` and named at session level, because an autonomous run has nobody to notice a quiet telemetry row.
- **Recovery.** One extra turn, in the same session, forked from the deny boundary rather than appended to the silent tail — appending is what compounds one empty turn into an empty session. The nudge names the contradiction and discharges it, rather than just asking again like the CLI's own no-visible-output prompt, which failed on all three observed cases because the offending instruction was still standing. At most one attempt; never when the client has already disconnected. A recovery that itself fails leaves the original envelope intact and never turns a delivered turn into a failed request. Kill switch: `MERIDIAN_SILENT_TURN_RECOVERY=0` keeps detection and telemetry, skips the spend.
- **Honest failure envelopes.** When a turn dies mid-stream, the `error` event now precedes `message_stop` — clients stop reading at `message_stop`, so an error queued behind it was written into a stream nobody was consuming. A failed turn that produced no text also reports `stop_reason: "max_tokens"` (truncated) instead of `"end_turn"` (finished), which is what lets a client tell a crash from a completed answer.

Coverage: `E38` in [E2E.md](../E2E.md), with `MERIDIAN_DEBUG_FORCE_SILENT_TURN=1` reproducing the shape on demand — the live rate is roughly three in five hundred requests, far too rare for a test run to wait for.

### Known limitations

- **Client-owned tool loops** — ordinary passthrough turns default to `maxTurns=1` to stop at the tool boundary. Deferred tools, advisors, structured output, and explicit turn budgets can lift that cap; see [digest-turn elimination](#how-tool-calling-works-in-passthrough). The client sends another request after executing the returned tools.
- **Blocked tools** — 10 built-in SDK tools (Read, Write, Bash, etc.) are blocked to prevent conflicts with the client's own tools. 19 additional Claude Code-only tools (CronCreate, EnterWorktree, Agent, etc.) are blocked because they require capabilities that external clients don't support.
- **Implicit SDK attachments (passthrough)** - replayed source tokens such as Ruby `@app` and `@config` can trigger proxy-host filesystem reads that the CLI presents as tool calls. Meridian defaults `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` to prevent that enrichment, including automatic MCP resource attachments. Explicit client images/documents and native SDK mode are unchanged. This internal switch also bypasses the CLI's kept-deferred-tools optimization. Linux CI runs the [real-CLI attachment probe](../E2E.md#implicit-sdk-file-mentions-in-passthrough) against a local API fixture to catch CLI-version drift.

  Set `MERIDIAN_SUPPRESS_IMPLICIT_ATTACHMENTS=0` to disable Meridian's default. An inherited `CLAUDE_CODE_DISABLE_ATTACHMENTS` value still wins: an empty string permits expansion, while nonempty `"0"` or `"false"` still disable it because the CLI checks truthiness. Existing attachments in resumed history are not scrubbed.
- **Subagent extraction** — Meridian parses the client's Task tool description to extract subagent names and build SDK AgentDefinitions. If the client's agent framework uses a non-standard format, subagent routing may not work automatically.
- **Scratchpad suppression (passthrough)** — the Claude CLI advertises a proxy-host scratchpad directory that clients can't use; OpenCode 1.18+ permission-blocks writes to it. Meridian suppresses it in passthrough mode (`CLAUDE_CODE_SESSION_KIND=bg` on the subprocess). Kill switch: `MERIDIAN_SUPPRESS_SCRATCHPAD=0`.
- **`max_tokens` is not enforced by default** — the Anthropic contract makes `max_tokens` a hard cap on total output (thinking and response text combined), with a truncated response reporting `stop_reason: "max_tokens"`. Meridian ignores it unless you opt in, so a small value does not bound the answer and a long answer still reports `end_turn`.

  The reason is that the Agent SDK exposes no output cap at all: its options carry `maxBudgetUsd`, `maxThinkingTokens`, `maxTurns` and `taskBudget`, and nothing for output tokens. The only lever is the CLI's own cap, which counts thinking *plus* text — so applying a client's answer-sized budget to a whole agentic turn can leave no room for an answer. Measured: a 128-token cap could not complete a turn whose visible answer was ~15 tokens, and a 16-token cap produced no text at all.

  Set **`MERIDIAN_ENFORCE_MAX_TOKENS=1`** to honour it exactly. With it on, a capped turn stops generating and reports `stop_reason: "max_tokens"` (empty content included, which is what the wire defines when thinking spent the budget) instead of overrunning. A cap that lands mid tool call still fails the request rather than delivering a half-built call. Verified by the E49 gate in [`E2E.md`](../E2E.md): `max_tokens=16` goes from 3900 output tokens with `end_turn` to 64 with `max_tokens`.
- **Container host identity needs pinning** — `hostId` is derived from the machine-id *and* the pid-namespace inode. Inside a container that inode changes on every `docker restart`, while the session store survives in the writable layer; a proxy killed while holding a store lock therefore returns with a different `hostId`, cannot retire its own stale lock, and every request fails with `timed out waiting for lock` until the container is recreated. Separately, containers from one image tag share a baked `/etc/machine-id`, so two hosts sharing a session directory can read each other's live locks as dead.

  Set **`MERIDIAN_HOST_ID`** to something stable across restarts and unique per container — the container ID works — and both go away. Unset outside containers, where the derived value is genuinely stable and unique. The value is hashed, so a pinned hostname does not travel in a lock file.
- **`MERIDIAN_QUIET=1` suppresses informational startup banners** — currently the `[telemetry] SQLite persistence enabled: ...` line. It does **not** change behaviour: persistence stays on, and warnings and errors still print. Intended for Meridian spawned by a wrapper or plugin, where stderr surfaces in the agent's UI and a per-session confirmation is noise. The `silent` config option cannot gate this line: the telemetry stores are created at module load, before any config exists.
- **Boot identity is required to serve** — every session-store write takes a lock stamped with a process incarnation, which needs a host boot identity (`/etc/machine-id` or `/var/lib/dbus/machine-id` on Linux, the hardware UUID on macOS, the machine GUID on Windows). Without one, every request that touches a session fails with `500 cannot capture lock owner process incarnation`.

  Meridian **refuses to start** in that state rather than binding a port it cannot serve from, and names the missing artefact. Distroless, scratch, chroot and gVisor images commonly lack `machine-id`: generate one (`dbus-uuidgen > /etc/machine-id`) or bind-mount the host's. `/health` also probes it and returns `503 unhealthy` with the cause, so Docker's `HEALTHCHECK` and orchestrators see the failure instead of routing traffic to a process serving nothing.

  Escape hatch: **`MERIDIAN_ALLOW_MISSING_BOOT_IDENTITY=1`** starts anyway — requests will still fail, and `/health` still reports unhealthy. It exists so a false negative in the probe cannot brick an install, not as a supported configuration.
- **Anthropic server tools not supported** — native server-side tools (`web_search_*`, `web_fetch_*`) are a raw Anthropic API feature (billed to an API key) that emits `server_tool_use` / `web_search_tool_result` blocks the Claude Max / Agent SDK path cannot produce. A request carrying one is rejected with a `400` explaining the fix. If a plugin needs server-side web search (e.g. [`opencode-websearch`](https://github.com/emilsvennesson/opencode-websearch)), give it its **own** provider pointed at `https://api.anthropic.com` with your `ANTHROPIC_API_KEY` — don't route that call through Meridian.

### Troubleshooting: "aborted" tool calls

Two very different things can carry the word "abort" — one is normal, one is always a bug:

- **Normal (invisible):** Meridian intentionally stops its internal SDK subprocess after your tool calls are captured — this is the optimization that avoids a wasted, billed model turn per tool call. It never appears in your client; log lines like `passthrough.early_stop` or `sdk_termination reason=aborted` in Meridian's own logs are calm, expected bookkeeping.
- **A bug (report it):** an **empty tool call in your client UI** — `tool {}` with "Tool execution aborted" — is never expected behavior, on any version. It means a call was cut off in transit.

**The definitive check:** the `/telemetry` dashboard's **Envelope** card. Meridian audits its own output on every response — green "wire contract clean" means every tool call was delivered intact regardless of what internal logs say. If it shows red, the logs contain `ENVELOPE VIOLATION` lines with request IDs — include those in a bug report and it can usually be root-caused directly.

## Headless quick start on Windows

With Node.js 22 or newer and Claude Code authentication available, run:

```powershell
npm install -g @rynfar/meridian
claude login
meridian
```

In another PowerShell window, set the client environment:

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3456"
$env:ANTHROPIC_API_KEY = "x" # Use your Meridian API key if protection is enabled.
```

Then follow the [setup instructions for your client](agents.md). The desktop app
is currently a Mac preview; it is not required for Windows headless use.

Local provenance verification accepts complete fingerprints only. Source and
artifact scans allow at most 64 MiB per file, 256 MiB total, 10,000 entries,
and two seconds of scan work; artifact traversal additionally caps depth at 32.
Git output is capped at 2 MiB, metadata at 4 MiB (package metadata 1 MiB).
Oversized or unavailable inputs report unavailable/invalid provenance rather
than certifying a partial hash. A local certified build refuses such inputs;
Git-less archives retain their uncertified build path.

# SQLite session bookkeeping

Set `MERIDIAN_BOOKKEEPING=sqlite` to explicitly use SQLite for both transcript
lifecycle and cross-proxy session mappings. The default is `json` for existing
installations. `MERIDIAN_SESSION_DIR` selects the shared private directory.
Once a directory contains SQLite or active maintenance journals, JSON startup
refuses it rather than creating a second authority. Never remove lock barriers
by hand.

The runtime must provide SQLite with the upstream WAL-reset fix: 3.51.3 or
later, or the 3.44.6/3.50.7 backports. Node 22.22.3 includes SQLite 3.51.3;
use a Node release whose built-in engine meets this requirement. The actual
version and source ID are checked in memory before opening a persistent main
database or maintenance guard. Older engines fail initialization with upgrade
guidance. The default JSON backend is unaffected.

Bun uses its own SQLite API and, on macOS, normally loads the OS library.
Its version can therefore differ from Node's. Advanced Bun embedders may select
a patched library with Bun's `Database.setCustomSQLite()` before initialization;
Meridian never changes that process-wide setting. Running the CLI with a
qualified Node runtime is the direct option. Node 22 may print its standard
experimental SQLite notice on stderr; structured command results remain on stdout.

SQLite uses `session-bookkeeping.sqlite`, WAL, `synchronous=FULL`, foreign keys,
`busy_timeout=0` and disabled automatic checkpoints. Use a local filesystem
with working SQLite locks: Linux ext2/3/4, xfs, btrfs or tmpfs; macOS APFS.
HFS/HFS+ and native Windows are outside the verified filesystem set and refuse
normal SQLite initialization; the default JSON backend remains available.
An unverified filesystem requires the explicit
`BOOKKEEPING_ALLOW_UNVERIFIED_FS=1` escape hatch, not an assumed safety claim.
The directory must belong to the service uid with mode 0700; database, journal,
WAL and SHM files are private (0600). Corruption, incompatible schema, path
identity drift or incomplete maintenance prevents startup, without salvage or
JSON fallback. Windows migration/crash behavior needs separate platform evidence.

An uncertain GC deletion remains fenced while its claiming proxy is alive or
its identity is indeterminate. Recovery requires authoritative death of that
proxy and its recorded executor, plus an empty process group on POSIX. A child
exit alone does not release the original owner's child and pipe custody.

## Explicit migration and rollback

Stop and drain **every** proxy and its SDK/deletion children first. A missing
lock file is not proof that a writer stopped. Back up the whole directory,
including journals and WAL, and provide sufficient free space for the database,
source backups and migration journals. Then run:

```sh
meridian-bookkeeping inspect --session-dir /private/session-dir --json
meridian-bookkeeping migrate --session-dir /private/session-dir --writers-stopped --json
MERIDIAN_BOOKKEEPING=sqlite MERIDIAN_SESSION_DIR=/private/session-dir meridian
```

Starting the server or calling initialization is **not** permission to import
legacy JSON. Fresh empty directories bootstrap READY atomically; legacy
directories require the explicit migration command. Migration preserves source
JSON backups and installs permanent barriers on both legacy lock names. Inspect
phases are `legacy`, `prepared`, `barriers`, `imported`, `ready`, `exporting`,
`exported` and `corrupt`. CLI exits: 0 success, 2 usage, 3 refusal before barriers,
4 refusal after barriers/export, 5 corrupt/foreign authority, 6 wrong uid.
An interrupted transition is resumed with its explicit maintenance command.

To return to a legacy binary, stop/drain all writers again, then run the new
package's command **before replacing the package**:

```sh
meridian-bookkeeping export-json --session-dir /private/session-dir --json
```

Fresh SQLite directories use the same durable migration identity and both legacy
lock barriers as an empty-input migration. READY is inspectable/exportable;
interrupted fresh bootstrap requires explicit `migrate --writers-stopped` (or a
safe abort), never implicit adoption of an unjournaled database. Import planning
executes the actual codecs/DDL in a disposable memory transaction before changing
authority and repeats under maintenance ownership. Invalid scalar NUL, unsafe
integers or row/constraint violations leave legacy source bytes, journals and
barriers unchanged. Historical failed imports can be aborted only if their
PREPARED database is provably empty: no mappings/resources/leases/history/fences
or imported provenance. READY/nonempty authority is never discarded by abort.

After successful export or abort, this same build may start with
`MERIDIAN_BOOKKEEPING=json` only with validated terminal history, completed barrier
release and no active SQLite main/WAL/SHM/journal. Export archives are checked;
incomplete, substituted or foreign history does not authorize JSON fallback.

Post-READY crash gates contain no incarnation proving the child dead. Ordinary
export refuses unknown gates. After explicitly stopping/draining **all** SDK and
deletion children, use:

```sh
meridian-bookkeeping export-json --session-dir /private/session-dir --writers-stopped --json
```

This records archive intent in the migration journal and uses the existing
no-clobber/inode-checked residue archive. It resumes interrupted archival, including
private captures within gate directories. A positively live or indeterminate
ledger owner still refuses; attestation is not permission to invent process death.

The published maintenance guard is permanent; refused operations never retire it.
Historical guard-retirement intents/captures block ordinary commands **before**
opening the guard or bootstrapping a replacement. Only after stopping every old
runtime and maintainer (including children), the following explicit recovery can
restore/link and exclusively lock the **original recorded inode**, then cancel
only its private retirement intent/aliases:

```sh
meridian-bookkeeping recover-guard-retirement --session-dir /private/session-dir --writers-stopped --json
```

A different public inode, conflicting intents, missing original inode or invalid
guard format refuses. Keep writers stopped and use an operator-approved coherent
backup restore; never unlink/replace the public guard, change recorded dev/ino,
or delete barriers manually. Recovery after copying an intent to a different
filesystem is not implicit permission to rehome that identity.

Run inspection through a **separate CLI process** beside a live proxy. In-process
inspection refuses while any local SQLite owner exists (including alias paths):
opening/closing an auxiliary descriptor for a POSIX lock-bearing inode can revoke
the owner's OS locks even when SQLite still reports an active transaction.

If a crash occurred after bootstrap's temporary-to-public hardlink but before
private alias retirement, `inspect` reports `temporary.kind=bootstrap-alias`
without mutating/opening that SQLite inode. This is diagnostic residue, not a
certification that runtime can serve. Recover through the CLI only:

```sh
meridian-bookkeeping recover-bootstrap --session-dir /private/session-dir --writers-stopped --json
meridian-bookkeeping migrate --session-dir /private/session-dir --writers-stopped --json
```

`migrate --writers-stopped` and `export-json --writers-stopped` can run this
recovery before their normal phase checks. Recovery locks the published original
guard exclusively, including the first-guard link window, before alias cleanup;
it never opens/closes an auxiliary descriptor for that SQLite inode. A valid
owner record must prove the exact bootstrap process dead; stopped attestation
does not override live, ambiguous or missing ownership. Inode mismatch/foreign
hardlinks refuse without deletion/adoption. Public main/guard identities stay
unchanged. Private capture/intent/write names are bounded to filesystem NAME_MAX
in UTF-8 bytes; legacy pending names remain readable and resumable.

Use the freshly exported JSON, never the original migrated backups: those omit
all later publications and fence advances. Do not start an old binary until
export completes and its barriers have been released. Retain the cycle/archive
files for recovery. A corrupt database requires an operator's restore decision,
not automatic rollback.

## Admission and embedding

The SQLite async admission budget is the maximum of
`MERIDIAN_SESSION_GC_LOCK_WAIT_MS` (default 2000 ms) and
`MERIDIAN_SESSION_LOCK_TIMEOUT_MS` (default 10000 ms). The latter is the legacy
store-lock setting, now a compatibility synonym in the common budget; corresponding
`CLAUDE_PROXY_*` aliases remain accepted. Explicit library `lockWaitMs=0` means
one BEGIN attempt, not a blocking retry. `lockRetryMs` controls asynchronous
retry timing. Legacy `lockStaleMs` cannot recover SQLite locks. An exhausted
budget gives typed overload; HTTP server paths answer 503, not an SDK timeout.
Synchronous library writers outside admission can immediately throw typed busy.

`startProxyServer` handles initialization and owned shutdown. For synchronous
embedders:

```js
const handle = await initializeProxyBookkeeping()
const proxy = createProxyServer(config)
// Serve proxy.app.fetch, then stop admissions and drain outstanding requests.
proxy.beginDrain?.()
await proxy.closeBackend?.()
await handle?.close()
```

The exported `clearSessionCache()` resets memory immediately and returns
`Promise<void>` under the approved #1244/#1277 contract. Use
`await clearSessionCache()` before relying on completed durable cleanup or
closing its bookkeeping owner. SQL cleanup waits in the existing bounded
writer queue; later publications survive. Cleanup retains its best-effort
error policy, so fulfillment alone does not certify that an unavailable store
was cleared. JSON remains the default and performs its cleanup synchronously
before returning the promise.

Keep the directory/backend fixed for the lifetime of these owners. Closing one
proxy never closes another owner's connection. The returned handle is opaque:
it exposes only idempotent `close(): Promise<void>`, with repeated calls joining
the same promise. Successful close waits for the final owner's admitted durable
work. If its two-second close budget expires, it rejects and retains ownership
until that original work joins; a rejected close is not permission to start
offline maintenance. Unknown COMMIT outcomes are not
replayed and do not authorize retiring a possibly published transcript. Periodic
GC performs a PASSIVE checkpoint; physical WAL shrinking is an offline operation.
