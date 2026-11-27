# Antigravity backend

Meridian can expose the official `agy` CLI through its Anthropic Messages
endpoint using the CLI's signed-in Google account. No Gemini API key, Python
SDK, copied OAuth credential, private model endpoint, or API-key fallback is
used. Claude remains the default backend.

The macOS path covers text, client tools, parallel delivery, warm conversation
reuse, OpenAI routes, structured output and adapted attachments. Native browser
and subagents have separate operator opt-ins. Linux remains preview; Windows
transport has fixture coverage but needs authenticated platform verification.
Antigravity's harness instructions remain in effect and `max_tokens` is advisory.

## Preview availability

Antigravity is included in **Meridian 1.74.0 and later** as a preview. Follow the
[installation instructions](../README.md#try-antigravity). For a source build,
substitute `node dist/cli.js` for `meridian` in the commands below. Run the preview
on a separate port if you already have a Claude service.

## Feature status

Validated on macOS arm64 with agy **1.2.7**, Pi **0.72.1** and OpenCode V1
**1.18.31**, and on Linux x64 with agy **1.5.13** and Pi **1.3.0**.
[E2E.md](../E2E.md) records the actual-client evidence.

| Area | Available in 1.74.0 |
| --- | --- |
| Coding | Incremental text, tool/result loops, parallel batches, approvals, questions and cancellation |
| Client extensions | Tested Pi/OpenCode plugins and client-owned delegation |
| Output | Model/effort selection, forced tools and validated JSON schemas |
| APIs | Anthropic Messages, OpenAI Chat Completions and the documented Responses subset |
| Attachments | Images/public HTTPS images; local document, speech and video adapters |
| Continuity | Warm reuse, eligible completed-session restoration, history replay and bounded saved-answer recovery |
| Management | Web/macOS provider setup, separate status/quotas and shared activity/navigation |
| Native tools | Browser/subagents through separate explicit grants |

**Unfinished:** active-task reattachment, automatic uncertain-action reconciliation,
additional client/native-plugin contracts and authenticated Linux/Windows testing.
Exact generation budgets, sampling controls and some native media/reasoning
semantics depend on capabilities the official CLI does not expose. See the
[complete support and recovery checklist](antigravity-support.md) for alternatives
and the requirements to close each gap.

## Start

Install the official Antigravity CLI and sign in by running `agy` interactively.
Use the default account provider, with paid overage credits disabled in agy's
settings. Meridian checks effective CLI settings and account model discovery
before starting. API-provider environment variables are removed from the
child environment; configured API-key providers are refused.

```sh
# Text-only requests:
MERIDIAN_BACKEND=antigravity MERIDIAN_PORT=3457 meridian

# Client-owned tools (read the permission explanation below):
MERIDIAN_BACKEND=antigravity \
MERIDIAN_AGY_ALLOW_TOOL_BRIDGE=1 \
MERIDIAN_PORT=3457 meridian

curl http://127.0.0.1:3457/v1/models
```

Use a model slug returned by that endpoint, such as `gemini-3.8-flash-low` if
your account offers it. Claude aliases such as `sonnet` are not remapped.
The local client may require a placeholder API key; this is not a Google key.
The existing `MERIDIAN_API_KEY` protects message and model endpoints with
`x-api-key` or bearer authentication. Health probes remain public. Provider usage is available in the web dashboard and desktop app. Claude
profiles remain specific to Claude.

When running from a checkout, replace `meridian` with `node dist/cli.js` after
`npm install` and `npm run build`.

## Read-only CLI timeout recovery

Before generation, Meridian verifies the official CLI version and its current
subscription configuration. Simultaneous checks in one runtime share the same
in-flight check; later requests validate again. Version validation precedes the
configuration command.

Both `/config` and `agy models` discovery probes have a 20-second deadline. If either times out, Meridian terminates
and joins it (forcing termination after one second if needed), waits 250 ms, and
retries that read-only command once. Generation still requires a successful,
validated configuration response. Both attempts timing out returns an explicit
failure; no model request is sent by that admission. Command exits, missing
executables, oversized output, malformed configuration, disallowed providers,
paid overage and unsupported versions are not retried. Shutdown cancels active
probes and prevents retry. Failed version/configuration/model probes also impose
a five-second account-check cooldown with HTTP 503 and `Retry-After`; no old
successful authorization is reused. Configuration refusals and unsupported
versions still require operator correction.

Diagnostics report reason, attempt, elapsed time, deadline, exit/signal and output
size without exposing CLI configuration contents. A recovered timeout is logged.
This handles a reproduced timeout mode; it does not explain the CLI's internal
stall or guarantee every historical 503 has the same cause.

The live fault gate withholds the first official `/config` result until the real
production deadline and requires a fresh successful configuration check before
any model invocation:

```sh
E2E_AGY_PREFLIGHT_TIMEOUT=1 E2E_AGY_DISCONNECT=1 E2E_CLIENT=pi node scripts/e2e-antigravity-client-extensions.mjs
E2E_AGY_PREFLIGHT_TIMEOUT=1 E2E_AGY_DISCONNECT=1 E2E_CLIENT=opencode node scripts/e2e-antigravity-client-extensions.mjs
```

## Tool permissions

The tool bridge requires explicit `MERIDIAN_AGY_ALLOW_TOOL_BRIDGE=1`. It launches
the CLI with per-process `--dangerously-skip-permissions` and installs a workspace
hook that permits named client tools on Meridian's MCP server and exact
image attachment paths created by Meridian. Structured output also permits the
native `finish` submission tool; arbitrary filesystem reads remain denied. This combination is deliberate: the CLI's headless permission layer
denied MCP dispatch in research even when the hook returned `allow`.

The hook has been tested to deny a built-in file read under auto-approval.
The hook alone is not OS sandboxing or a proof of complete isolation against CLI bugs or
conflicting user customizations. Global CLI customizations still load. Use this
opt-in only with a trusted local CLI installation and account configuration;
project-scoped grants without blanket CLI auto-approval remain future work.
Text/schema-only mode without native grants does not use auto-approval. Attachments
require the same explicit tool-bridge opt-in, even without client tools.

Meridian creates a disposable workspace containing its hook and MCP config.
It advertises the client's tools through a loopback MCP listener. When the
model requests a tool, Meridian returns `tool_use` to the client and keeps
the MCP response pending. The next HTTP request supplies `tool_result`, which
becomes the MCP result. Meridian never runs the client's filesystem or shell
tools itself. Client tool execution and permission prompts remain the client's
responsibility.

## State and recovery

Pending tool calls retain a live `agy` process. Exact continuations preserve the
delivered prefix and batch. A complete changed history or batch can instead retire
and join its single idle owner before replay (`history-replay`), with native grants
disabled. Some completed IDs may have no live owner; two different live owners
remain a conflict. Model, session identity and execution controls must still match. A client plugin may update
system instructions or tool definitions: Meridian claims the completed results,
stops and joins the old CLI, then replays the completed history through a fresh
official CLI with the new context. Telemetry labels this `client-context-replay`.
The old pending action is never resumed under the changed tool policy. Active
responses, mixed live owners, incompatible execution controls and native-capability
history changes remain HTTP 409 conflicts. Recently consumed duplicate results
require a saved answer or an eligible exact failed-continuation retry.
Unpaired or malformed historical results receive HTTP 400. New user text
may accompany the exact result or follow it in another user message. This steering
continues the same pending process and is delivered separately from tool output. Independent upstream calls are coalesced into one response, preserving every
correlation. A synthetic `meridian_parallel` MCP tool also submits 2–16 independent
actions atomically. `disable_parallel_tool_use: true` delivers them serially. Unchanged live continuations remain bound to their original process.

Matching ordinary turns reuse the same live CLI process and send only new user
messages. This preserves native conversation/cache affinity while that process
lives; cache hits and quota savings remain provider-dependent. Exact history,
model, instructions, tools and output controls must match. Edits, forks after a
branch advances, compaction and expired snapshots use full history replay. With
`MERIDIAN_AGY_STATE_PATH`, completed and joined text/client-tool conversations
can restore through the official `--conversation` flag after restart. Active work,
media, native browser/subagents and structured/stopped turns are not eligible. Schema/stopped responses use fresh processes. Embedders can disable warm
reuse with `antigravity.reuseConversations: false`. Replay is explicit JSON
context, not native role-preserving transcript import. Native restore never reads
or edits private CLI transcripts.

Repeated MCP request IDs reuse their original result within their MCP session;
conflicting reuse is rejected. Native children have independent MCP sessions. Each
live conversation permits 256 client calls by default (configurable with
`MERIDIAN_AGY_MAX_TOOL_CALLS`), 32 outstanding calls and 64 MCP sessions. The
existing warm-reuse eligibility cutoff remains 128 completed client calls; raising
the allowance does not raise that separate cutoff.

If the proxy or CLI dies, or the tool deadline expires, a later client request
containing the complete tool-call/result history starts a fresh CLI conversation.
No extra user message is required. The supplied results describe completed work;
Meridian does not execute or automatically retry that work. This is history replay,
not restoration of native CLI state. Recovery uses the currently configured account
and its current subscription authorization checks. Keep that account stable when
continuing a session.

When capacity is full, Meridian may terminate and join an idle process waiting
for a client tool, or retaining a completed conversation, before admitting a new request. Active HTTP responses are never
evicted. This prevents terminal tools that never return a result from occupying
all slots until their deadlines; a late result follows the same replay path.
A bounded ledger rejects the latest 4,096 consumed result IDs and concurrent
recovery of the same result. With persistent state, those IDs survive restart for
up to 30 minutes. This is not exactly-once delivery: after expiry or eviction,
clients must retain their completed history and
avoid resubmitting already answered requests. The model still decides subsequent
tool calls; client permissions and side-effect safeguards remain important.

HTTP disconnects during active responses abort that request's process.
Disconnecting normally after a `tool_use` response leaves its process waiting
until a result, reclamation, or the tool deadline.

Temporary workspaces are removed after subprocess exit unless retained for an
eligible completed native snapshot (up to 30 minutes). Expired workspaces are
pruned on subsequent lifecycle activity; live owner processes are protected. The official CLI still
persists its own conversations and project metadata under its normal account
directories. Meridian does not edit or garbage-collect those private records.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERIDIAN_BACKEND` | `claude` | Set to `antigravity` to select Antigravity, or `combined` for both providers |
| `MERIDIAN_AGY_STATE_PATH` | unset | Private SQLite file for bounded response, activity and completed native continuation state; one live service per path |
| `MERIDIAN_AGY_PLUGIN_PATHS` | unset | JSON array of explicit Antigravity plugin module paths |
| `MERIDIAN_AGY_GRAMMAR_PYTHON` | unset | Local Python with Lark installed for Lark custom-tool validation |
| `MERIDIAN_AGY_PATH` | `agy` | Official CLI executable |
| `MERIDIAN_AGY_ALLOW_TOOL_BRIDGE` | off | Explicit tool bridge permission opt-in |
| `MERIDIAN_AGY_ALLOW_NATIVE_BROWSER` | off | Isolated native browser opt-in |
| `MERIDIAN_AGY_BROWSER_MCP_PATH` | `chrome-devtools-mcp` | Installed Chrome DevTools MCP 1.9.0 executable |
| `MERIDIAN_AGY_ALLOW_NATIVE_SUBAGENTS` | off | Guarded native self/research subagent opt-in |
| `MERIDIAN_AGY_WHISPER_MODEL` | unset | Local whisper.cpp model for audio transcription |
| `MERIDIAN_AGY_MAX_CONCURRENT` | `4` | Maximum live processes; idle pending tools can yield capacity |
| `MERIDIAN_AGY_MAX_TOOL_CALLS` | `256` | Client-call and MCP replay-ledger allowance per live process, integer 1–65536; independent of deadlines and the 128-call warm-reuse cutoff |
| `MERIDIAN_AGY_TURN_TIMEOUT_MS` | `300000` | Full model/preprocessing deadline for each phase, refreshed after each accepted tool-result batch; paused while waiting for client tools |
| `MERIDIAN_AGY_TURN_MAX_DURATION_MS` | `7200000` | Absolute per-turn deadline including client tool waits; also passed as CLI `--print-timeout` on every turn (including tool-less turns) |
| `MERIDIAN_AGY_TOOL_TIMEOUT_MS` | `60000` | Pending client tool-result deadline |
| `MERIDIAN_AGY_IDLE_CONVERSATION_MS` | tool timeout | How long a completed conversation keeps its live process for the next turn (explicit values: 1–86400000); afterwards that turn replays the full history. Unset preserves the existing tool timeout, including values above this new option's limit. |
| `MERIDIAN_AGY_MAX_PROMPT_BYTES` | `190000` | UTF-8 byte limit of one prompt sent to agy, which keeps only about 192,000 bytes of an input step and drops the rest (the newest messages). Past it the oldest large tool results, arguments and text are shortened, the newest last; a current request that alone does not fit returns 400 `prompt is too long`. `0` disables it. |
| `MERIDIAN_AGY_MAX_STEP_TOKENS` | `52000` | Estimated tokens per submitted input, independently of the byte guard; 1–63000. |
| `MERIDIAN_AGY_MAX_CONTEXT_TOKENS` | `480000` | Estimated context safety budget derived from a 512K model window; 1–512000. Includes an output reserve. This is not a provider limit or a retention guarantee. |
| `MERIDIAN_AGY_CHUNKED_HISTORY` | `0` | Set to `1` to opt into experimental multi-step cold replay. The default is one trimmed input. |
| `MERIDIAN_AGY_HISTORY_STEP_BYTES` | `180000` | Extra byte bound for each experimental replay input; 1–190000. |
| `MERIDIAN_AGY_HISTORY_MAX_STEPS` | `12` | Total experimental replay inputs including the final request; 1–64. |

Capacity exhaustion returns 429 with `Retry-After`. No unbounded request queue
is created. Bodies are capped at 8 MiB; upstream stdout is capped at 16 MiB.
Prompts use stdin to avoid OS argument-size limits. Shutdown terminates owned
process groups and closes the MCP listener. Because child processes are spawned
detached and receive `--print-timeout` equal to `turnMaxDurationMs` (two hours
by default), an unclean Meridian crash can leave an active `agy` child running
up to that limit instead of the previous 300 s CLI backstop; real `agy`
`--print-timeout` semantics across reused stdin turns are unverified.

Embedders can set `backend: "antigravity"` and `antigravity: { executable,
allowToolBridge, maxConcurrent, turnTimeoutMs, turnMaxDurationMs, pendingToolTimeoutMs }` on
`startProxyServer`. Call `ProxyInstance.close()` to release resources. Direct
`createProxyServer().app.fetch` embedders must call the optional
`closeBackend()` when finished.

## Supported surface and limits

- `POST /v1/messages` and `/messages`: text, images/documents/adapted media,
  client tools, JSON and SSE.
- `POST /v1/chat/completions` and `/v1/responses`: explicit OpenAI subsets below.
- `POST /v1/messages/count_tokens`: labeled planning estimate without a CLI call.
- `GET /v1/models`: current account's CLI model slugs.
- `GET /health`, `/readyz`, `/livez`: backend identity, capability limits and health.
- Exact numeric thinking budgets, sampling controls, signed reasoning, Claude-specific
  profiles/SDK hooks and signed Claude lineage remain unavailable. Explicit
  Antigravity provider plugins and bounded persistent activity are supported. Unsupported modeled request features fail before execution.
- `output_config.effort` accepts `low`, `medium`, or `high` only when it matches
  the selected model slug suffix; it is passed to the native CLI flag. Adaptive
  thinking is accepted, but no private reasoning transcript is synthesized.
  Google-hosted Claude does not support this effort override: select its account
  model as advertised, with client thinking controls off. Gemini effort variants
  can always be selected as separate model slugs.
- `max_tokens` is included as a prompt instruction; the CLI does not expose a
  native hard output-token cap. Health reports this as `advisory`.
- CLI-reported terminal permission denial is an error even when terminal status
  says `SUCCESS`. Individual denied tool attempts may be recovered by the CLI. Interrupted or malformed streams never receive a success stop.
- Usage is accumulated from per-step usage for each HTTP response, avoiding
  double-counting cumulative CLI conversation totals. The CLI reports uncached input and cached reads separately; Meridian preserves
  them as `input_tokens` and `cache_read_input_tokens` without subtracting twice.
- Fresh replay, full native prompt inheritance and account quotas can make
  this less efficient than Claude's existing resume implementation.

## Verification

`bun test src/__tests__/antigravity-backend.test.ts` drives the real process/MCP
transport against a deterministic local CLI fixture. It covers continuation
matching, parallel-call correlation, duplicate/stale results, body capabilities,
SSE lifecycle, permission-denial errors, disconnect cancellation, deadlines,
capacity, account-provider refusal and long stdin payloads.

`node scripts/e2e-antigravity.mjs` uses the actual official CLI and account model,
then runs actual Pi through the built Node entrypoint. A recording relay verifies
that a random file value entered through Pi's own tool result. Run after
`npm run build`; it consumes account quota. See [E2E.md](../E2E.md#antigravity-subscription-cli-backend)
for the recorded versions and outcome.

For a full client coding loop, run `node scripts/e2e-antigravity-tools.mjs`
after building. It verifies actual Pi `read`, `edit`, `bash` and `write`, recovery
from a tool error, Unicode paths, and exact source/output bytes. This is separate
from the basic read/write gate; neither establishes arbitrary client compatibility
or restoration of a pending native process after a crash. See the recovery gates below.

Implementation tracks [#1073](https://github.com/rynfar/meridian/issues/1073),
following the [research PR](https://github.com/rynfar/meridian/pull/1050).

## Combined service and provider navigation

Set `MERIDIAN_BACKEND=combined` to run both providers in one Meridian service.
Claude retains `/v1/messages`; Antigravity uses `/antigravity/v1/messages` and
`/antigravity/v1/models`. Configure the Antigravity client's base URL with the
`/antigravity` suffix. Claude account routing never selects a Google account.
An unavailable Antigravity installation does not prevent Claude from starting.

Open `/providers` for **All providers / Claude / Antigravity** navigation.
`/providers/status` supplies the same data to Meridian Desktop. Quota windows
come from the official `agy -p /usage --output-format json` command: Gemini and
Claude/GPT allowances remain separate inside the Google subscription. Quota reads refresh in the background; the dashboard never waits for them. Failed
refreshes retain last known readings with stale/error labels. These percentages
are never added to Anthropic percentages or converted to invented costs.

The activity strip sums observed request and token counts over the past hour.
Antigravity uses bounded minute buckets; Claude uses its telemetry window. Without a state path, Antigravity activity resets on restart. With persistence,
up to 10,000 request metadata records survive for 30 days; the feed displays the
latest 500. Native activity retains up to 500 records for 30 days. No
prompts or tool contents are retained in this activity feed. Subscription quotas
come from the account and survive proxy restarts.

The macOS app has a Providers page, the same overview and filters, separate
Antigravity quota windows in the menu bar, and provider selection under Settings.
For an app-managed service, stop it, choose Claude, Antigravity, or both, then
start it. Client tools, native browsing, native subagents and keeping history
across restarts have separate opt-in checkboxes. History storage includes response
content; turning it off stops writes but does not immediately erase existing files.
The provider card exposes capabilities and their practical limits. An attached service
is configured by its owner. Sign into Google using the official CLI; the desktop
app does not collect Google credentials or repurpose Claude profile login.

## Compatibility and operational contract

The supported text/client-tools path is gated to official `agy` **1.5.13**
(validated on Linux x64; the macOS 1.2.7 acceptance below predates the gate
moves and awaits a 1.5.13 re-run on that platform).
An unverified CLI update is refused before a new model process starts. Validate
new versions with the live gates below before changing the compatibility gate.
`/health` still reports Linux as `preview` and macOS as `supported` until each
platform has full 1.5.13 client evidence. Windows
process-tree termination and hook quoting are implemented and exercised in CI;
normal execution stays gated until authenticated live verification. The embedder
option `allowUnverifiedWindows: true` is solely for that acceptance gate. This is a supported, bounded protocol surface, not full Claude parity.

Each new process rechecks account-provider and paid-credit settings, even when
the model catalogue is cached. Preflight work counts toward capacity. Readiness
checks CLI configuration, not a billable model call; account quota failures are
shown separately in provider status. A quota failure maps to HTTP 429 (or an SSE
error) with retry guidance. Failed active requests are not automatically retried. A subsequent complete client
tool-result request can recover through history replay.
Schema/one-shot output is committed after clean process exit. Warm conversations
commit a successful terminal result while retaining the official stream stdin for
the next turn; a later process failure cannot retroactively revoke that response.
Slow stream readers have a 1 MiB response-buffer budget; deadlines and process
shutdown still apply. Terminal sandboxing is requested in addition to the deny
hook, but does not claim full isolation of the CLI or all native tools.

MCP tool content is wrapped in `meridian_client_result` JSON. The model is
instructed to decode that exact client content, keeping CLI timing metadata out
of file contents. The live Pi copy gate compares exact bytes and catches leaks.

For the actual macOS app and its managed combined service:

```sh
npm run build
npm ci --prefix apps/desktop
npm run build --prefix apps/desktop
env -u ELECTRON_RUN_AS_NODE apps/desktop/node_modules/.bin/electron \
  scripts/e2e-antigravity-desktop.cjs
```

This creates disposable app data and an isolated managed service, exercises
provider filters and settings, runs actual Pi read/write through Antigravity,
checks the ordinary Claude SDK route, observes both providers' activity, and
stops the owned service. It consumes both accounts' model quota.


CLI behavior references: [headless mode](https://antigravity.google/docs/cli/headless/),
[hooks](https://antigravity.google/docs/hooks), and
[terminal sandbox](https://antigravity.google/docs/sandbox?tab=cli).

## Request compatibility

Hosted Anthropic tools without client schemas are reported in
`x-meridian-dropped-tools` (up to 16 names) and
`x-meridian-dropped-tools-count` (the number of distinct dropped names). The warning log uses the same
bounded name sample; Meridian does not execute these hosted tools. Normalized
late system steering remains in conversation order and does not replace the
latest actual user instruction during prompt compaction. A valid choice targeting a dropped hosted tool becomes `auto` while preserving `disable_parallel_tool_use`. Literal user `[system]` text remains a user instruction. Unknown-block descriptions are bounded; unrepresentably deep data and malformed known blocks return 400.

## Pi and OpenCode

Both clients use their own tools, permissions and saved sessions. Meridian does
not replace their tool implementations. Matching completed turns reuse the live
CLI; forks, undo and compaction use validated client history when replay is
needed. Client-owned delegation (for example OpenCode's `task`) is allowed
through MCP. Native delegation is independently gated below.

These examples use standalone Antigravity on port 3457. For a combined service,
use its port and prepend `/antigravity` to each base URL. If Meridian API-key
protection is configured, replace `local-placeholder` with that local key.

### Configure installed clients

Client acceptance is verified with Pi 0.72.1 and OpenCode V1 1.18.31.
OpenCode 1.2.15 sends numeric `top_p` defaults, which Meridian accepts and ignores
(not forwarded to `agy`); upgrade if you need current OpenCode V1 behavior rather
than expecting sampling controls to be honored.

In the web dashboard or macOS app, open **Providers → Antigravity → Connect Pi
or OpenCode**. Choose an account model and copy the generated setup command. The
command uses the current service address and its separate Antigravity route.
Changing the client's default is opt-in; service authentication takes an
environment-variable name, never the key value. Run the command in a terminal
where Meridian is installed, then restart the client.


Meridian 1.74.0+ packages include both retry integrations; a source checkout is
not required. With your official CLI signed in and Meridian running with the
Antigravity tool bridge enabled, add your account model to either client:

```sh
meridian setup --antigravity --client pi --url http://127.0.0.1:3457 --model gemini-3.8-flash-low
meridian setup --antigravity --client opencode --url http://127.0.0.1:3457 --model gemini-3.8-flash-low
```

For combined mode use `--url http://127.0.0.1:3456/antigravity`. Restart the client
after setup. Pi loads its integration from the client `extensions` directory;
OpenCode V1 loads it from `plugins`. This installs the supported retry/streaming
behavior as well as the provider configuration. OpenCode V2 is not targeted by
this command. Replace the example model with an actual account model slug.

Existing providers, permissions and client defaults remain intact. Add
`--set-default` to select the new provider/model (and OpenCode's `small_model`).
`--config-dir <directory>` targets a specific client installation. Otherwise Pi
uses `PI_CODING_AGENT_DIR` or `~/.pi/agent`, and OpenCode uses its configured
platform directory. `--api-key-env MERIDIAN_API_KEY` writes an environment
reference for local Meridian authentication; it never copies Google credentials.
Without that flag, an existing local key is retained or a placeholder is used.

Setup validates all intended configuration before writing, preserves OpenCode
JSONC comments, creates private `.bak-<id>` backups for replaced files, and uses
atomic per-file replacement. Rerunning unchanged setup makes no edits. Malformed
configuration, conflicting sibling providers, explicit provider exclusions,
unmanaged destination scripts and known duplicate retry scripts are rejected.
Remove an old manually installed retry script before installing the managed one.
Client tool permissions remain under the client's control. Pi's existing automatic
retry preference is preserved; enable it for Pi partial-stream recovery.

The following manual configuration remains available for custom installations.

Pi's `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "meridian-agy": {
      "api": "anthropic-messages",
      "baseUrl": "http://127.0.0.1:3457",
      "apiKey": "local-placeholder",
      "models": [{
        "id": "gemini-3.8-flash-low",
        "name": "Antigravity Gemini Flash Low",
        "reasoning": false,
        "input": ["text", "image"],
        "contextWindow": 128000,
        "maxTokens": 4096
      }]
    }
  }
}
```

Run `pi --provider meridian-agy --model gemini-3.8-flash-low --thinking off`.
Pi enables read/edit/bash/write by default. To enable its search tools too, add
`--tools read,edit,bash,write,grep,find,ls`. Add other account model slugs as
separate entries (including Gemini medium/high variants). `reasoning: false`
disables unsupported client thinking-budget controls; it does not disable a
model's intrinsic reasoning. The context/output settings above are conservative
client budgets, not claims about native hard limits.

OpenCode's `opencode.json` (merge the provider into existing configuration):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "meridian-agy": {
      "npm": "@ai-sdk/anthropic",
      "name": "Antigravity through Meridian",
      "options": {
        "baseURL": "http://127.0.0.1:3457/v1",
        "apiKey": "local-placeholder"
      },
      "models": {
        "gemini-3.8-flash-low": {
          "name": "Antigravity Gemini Flash Low",
          "limit": { "context": 128000, "output": 4096 },
          "temperature": false,
          "reasoning": false,
          "tool_call": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        }
      }
    }
  }
}
```

Select `meridian-agy/gemini-3.8-flash-low`. Leave permission choices with the
client; there is no need to globally auto-approve OpenCode tools. Use a configured
Antigravity model for `small_model` as well if title/compaction helper work should
stay on that subscription. This custom provider does not need the Claude-specific
Meridian OpenCode plugin.

For a matching Gemini high model entry, OpenCode model `options` may specify
`{"thinking":{"type":"adaptive"},"effort":"high"}`. Do not apply these options
to low/medium variants or Google-hosted Claude models.

### Client thinking controls through effort adaptation

Set `MERIDIAN_AGY_ADAPT_THINKING_BUDGETS=1` on the Meridian service (or
`antigravity.adaptThinkingBudgets: true` for embedders) to use numeric Anthropic
client thinking controls with Gemini effort variants. Strict rejection remains
the default. Generation still goes through the official subscription CLI.

| Client `thinking.budget_tokens` | Effective CLI effort |
| --- | --- |
| 1–2048 | low |
| 2049–8192 | medium |
| 8193 and above | high |

These thresholds are Meridian's compatibility policy, not Google's token
allocations. The selected Gemini family stays fixed; for example an 8192 budget
on `gemini-3.8-flash-low` selects `gemini-3.8-flash-medium` and passes
`--effort medium`. The target must appear in the signed-in account's `agy models`
list. A missing variant is rejected without a model call; Meridian never switches
to a different family or provider. Google-hosted Claude models are not mapped.
Conflicting explicit effort and numeric budget settings are rejected.

For Pi, change the model entry above to `"reasoning": true` and
`"maxTokens": 32768`, then use `--thinking low`, `medium`, or `high`. Pi clamps
its requested thinking budget to leave room for its answer; the larger client
limit allows its medium/high budgets to reach Meridian intact. This remains an
advisory output limit for agy. For OpenCode, set `"reasoning": true`
and configure a model's `options` or a named variant with
`{"thinking":{"type":"enabled","budgetTokens":8192}}`. Keep `temperature: false`.
Pi/OpenCode still own tool execution, approvals, skills and client subagents.

JSON and SSE responses expose `x-meridian-thinking-budgets: approximate-effort`,
`x-meridian-effective-model` and, when selected, `x-meridian-effective-effort`.
The response model and request telemetry use the effective CLI model. Health
reports `capabilities.thinkingBudgets: "approximate-gemini-effort"` when enabled.
Changing effort between completed turns can replay history rather than reuse a
process; changing it while a tool result is pending is rejected by the existing
continuation contract. Client thinking `off` leaves the chosen model unchanged;
it does not disable the model's intrinsic reasoning. Exact quota caps and signed
reasoning blocks are not implied by enabling the client controls.

The actual-client gates are:

```sh
npm run build
E2E_CLIENT=pi node scripts/e2e-antigravity-clients.mjs
E2E_CLIENT=opencode E2E_AGY_EFFORT_MODEL=gemini-3.8-flash-high node scripts/e2e-antigravity-clients.mjs
node scripts/e2e-antigravity-opencode-session.mjs
```

They consume subscription quota and retain local fixture artifacts. See
[E2E.md](../E2E.md#antigravity-coding-tool-acceptance-gate) for verified versions,
individual outcomes and retained failures. They establish the listed coding
flows, not every third-party extension or hard token budgets. The additional
image/schema gates are documented below.


## Images, schemas and tool selection

PNG, JPEG, GIF and WebP images use Anthropic base64 `image` blocks, either in a
user message or inside `tool_result.content`. Public HTTPS image sources use
`{"type":"image","source":{"type":"url","url":"https://…"}}`. Each redirect
and DNS result is validated; loopback, private/special-use addresses, credentials
and non-443 ports are refused. Connections pin the validated address, forward no
account credentials, and allow at most three redirects and 6 MiB per image.
The existing 8 MiB request limit includes base64 bytes. Meridian validates the
encoding and media signature, writes the supplied bytes into its private turn
workspace, and replaces them with attachment references in the CLI prompt.
Only exact generated attachment paths are allowed through `view_file`; no
caller filesystem path is read by Meridian. Files disappear when the turn
process exits. The CLI can retain its own conversation records as usual.
Actual Pi/OpenCode attachment and read-tool flows have been verified with PNGs;
other accepted formats still depend on the selected model's vision support.

`output_config.format: {"type":"json_schema","schema":{...}}` passes the
schema to the official `--json-schema` option through a temporary file.
Non-string enums are omitted from native transport where Gemini rejects them,
while the original exact schema remains in the prompt and local validator. Legacy `output_format` accepts the same shape; sending both is rejected.
Intermediate prose is withheld, while client tool calls still pass through.
Only the CLI's `structured_output` is returned after local schema validation and
clean exit. Tool arguments are also validated before client delivery; invalid
arguments return to the model for correction. Draft 7, 2019-09 and 2020-12
schemas use request-local validators without coercion or remote reference fetches. A missing result
fails explicitly. Numeric enum output has passed a live gate after this transport
adaptation. Other upstream schema restrictions can still fail; Meridian never
returns a result that violates the original locally validated schema.

`tool_choice` accepts `auto`, `none`, `any`, or `tool` with an advertised name.
Forced responses contain a matching tool call or fail explicitly; they never
succeed with prose instead. The client may change tool choice when returning a
pending result while preserving the other contract fields. Queued calls excluded
by a new choice are rejected. `disable_parallel_tool_use: true` opts into serial
delivery; otherwise independent calls can share one response. Tools still awaiting a client result
retain their process until the result, cancellation, or configured deadline;
idle waiting processes may also be reclaimed when another request needs capacity.

Up to four nonempty `stop_sequences` of at most 1024 characters are enforced on
assistant text at Meridian's response boundary. Matching spans streaming chunks,
the sequence itself is withheld, and the owned process is terminated and joined
before `stop_reason: "stop_sequence"` succeeds. Stops do not inspect tool arguments
and can accompany forced tools or structured output. Forced tools suppress prose.
If a stop occurs inside the final serialized schema result, Meridian returns 422
instead of truncating JSON into an invalid result. Usage after
an early stop includes only CLI usage observed before termination. This does not
turn the advisory `max_tokens` field into a native token cap.

```sh
node scripts/e2e-antigravity-capabilities.mjs
E2E_SESSION_CAPABILITIES=1 node scripts/e2e-antigravity-opencode-session.mjs
```

Both gates need Python Pillow and the macOS Menlo font to generate random
visual fixtures. The second uses actual Pi and OpenCode clients. It also checks
OpenCode's own structured-output workflow. If using an OpenCode deny-all
permission policy, explicitly allow its `StructuredOutput` tool when requesting
that feature; a hidden tool cannot satisfy the client's format requirement. The first gate exercises native
schema output, forced tool selection/continuation, text stops through JSON/SSE
and a multi-megabyte image request through production Node and live CLI vision.


## Warm context and cold replay

Matching live conversations already submit only the new input. The per-step
and context budgets bound how far that reuse can grow. On context exhaustion,
the next ordinary continuation starts a fresh trimmed conversation, which can
then reuse its process again. A cold replay can shorten or omit older completed
turns. The latest user instruction and complete retained tool pairs are kept.
If the latest content still cannot fit, the request fails explicitly.
The step estimate reserves one token per non-ASCII UTF-8 byte, intentionally
overestimating many dense CJK inputs. With the default settings, a CJK-only input
around 54 KB may now need splitting even though it fit the older byte guard.
The 52,000 and 480,000 defaults are safety margins below the observed 64,000
single-step limit and the reported 512,000 model window, respectively.

Optional chunking sends old history in separate priming inputs with tools
disabled. Each completed input must be identified before the next is sent.
Priming output is not part of the client answer; its usage is counted in
telemetry. Structured output or native browser/subagent grants use one bounded
cold input. Dense histories with tools have encountered native subscriber lag
even when each planned step fits, so chunking remains opt-in.
The final input explicitly includes the most recent user goal when the last
unit is only a tool result. Plans exceeding the step count or an indivisible
unit's input budget fail before starting the model.

## What the remaining limits mean

The [support and recovery checklist](antigravity-support.md) separates supported
flows, adaptations, current exclusions and the work needed to close each gap.
It includes recovery instructions and practical execution budgets.


| Control | Meaning | What is lost through the current CLI |
| --- | --- | --- |
| Hard `max_tokens` | Enforce an exact upper bound on generated tokens | The requested limit is advisory. A long answer or tool loop can use more quota and time than that number suggests. Response byte limits and process deadlines remain enforced. |
| Numeric thinking budget | Allocate a specific number of tokens to internal reasoning | Opt-in adaptation maps client budgets to Gemini low/medium/high effort. This enables client controls without promising an exact reasoning-token allowance. |
| `temperature`, `top_p`, `top_k` | Tune how the model samples its next tokens | Numeric values are accepted and ignored (not forwarded). Prompts can request a style, but do not implement sampling parameters or guarantee repeatability. |

These controls do not determine whether file editing, shell commands, search,
images or client delegation are available. Truncating returned text locally would
not impose a native token/quota budget and could break JSON or tool arguments;
Meridian does not claim that workaround as a hard limit.

Remaining boundaries:

- Exact upstream token counts, hard output caps, numeric thinking budgets,
  sampling controls and signed native reasoning are not exposed by this CLI.
- Native attachment semantics differ from local adaptation: no native PDF
  citations, continuous video understanding, non-speech audio or generated media.
- Native restoration covers completed, joined text/client-tool sessions only.
  Active/background work does not resume after a crash; other contexts replay.
- Arbitrary provider-hosted OpenAI tools (including OpenAI web search), uploaded
  file IDs and universal third-party client compatibility are not implemented.
- Claude profile pools and SDK-specific plugin hooks cannot be applied to the
  Google account. The existing plugin `RequestContext` contains Claude SDK agents,
  hooks and settings; Antigravity instead exposes its own request/response/telemetry extension
  contract, without claiming those Claude hooks ran. Global agy customizations still load,
  but the bridge does not grant arbitrary plugin MCP tools. Client-owned plugins
  run in Pi/OpenCode as usual. Antigravity uses its CLI's one signed-in account;
  no credential copying or unofficial multi-account isolation is provided.
- Provider navigation, quotas, request metadata and bounded native-tool activity
  are available; durable Claude lineage/telemetry is not fabricated for agy.
- Authenticated Linux and Windows live acceptance remains unverified. Mocked
  cross-platform CI is transport evidence, not subscription/client evidence.

Run `node scripts/e2e-antigravity-recovery.mjs` for live expiry and capacity
reclamation checks. Recovery verification uses the actual client while replacing its backend between
successful tool execution and result delivery:

```sh
E2E_AGY_RECOVERY=1 E2E_CLIENT=pi node scripts/e2e-antigravity-clients.mjs
E2E_AGY_RECOVERY=1 E2E_CLIENT=opencode node scripts/e2e-antigravity-clients.mjs
```

The gate checks the finished tool is not requested again, then verifies the full
coding, saved-session and client-delegation/session flows. This establishes
completed-history recovery, not durable exactly-once semantics or native resume.


## OpenAI routes and token estimates

Chat Completions and Responses support text, data/HTTPS images, standard function
tools and their full-history continuations, forced/parallel tool selection,
JSON/SSE, matching Gemini effort and JSON schemas. Responses supports either full
input history or `previous_response_id` with only new input, including function
results. Responses additionally supports namespaced function/freeform tools,
custom-tool outputs, PDF/text/audio/video base64 data-file inputs and audio input;
Chat Completions supports WAV/MP3 audio input. Media uses the same local adaptation
path described below. Optional reasoning-summary/encrypted-content requests do
not fabricate unavailable native reasoning. Unsupported fields fail before dispatch.
Actual Codex shell/edit/readback is verified with web search disabled; this is not
a claim of complete Codex compatibility.

Responses are stored by default; `store: false` disables the response-ID snapshot
for that turn (it does not disable the separate live CLI conversation). Use
`GET /v1/responses/:id` to retrieve the completed JSON response and
`DELETE /v1/responses/:id` to remove its snapshot. Both routes use normal Meridian
authentication; snapshots are scoped to the supplied API credential. When no key
is configured, callers without a credential share the local service scope.
Combined mode prefixes these routes with `/antigravity`.

Storage has a fixed 30-minute lifetime, at most 256 entries,
64 MiB of serialized state in total, and 16 MiB per entry. Oldest entries are
removed under pressure; expired entries are removed on subsequent store access.
Without a state path, restart/shutdown clears storage. With a state path, terminal
snapshots survive restart. Limits measure serialized records, not physical SQLite
file size. The SQLite file is private (0600), and an OS-backed exclusive guard
prevents concurrent services from owning the same state. Missing, expired, deleted, evicted and unstored
IDs return 404; clients can recover by resending their complete history. Expanded
input is limited to 8 MiB before any model call. A response exceeding its storage
budget fails rather than advertising a retrievable ID. Keep a client-side history
for longer sessions and reliable recovery.

Only input/output items carry forward through a response ID: resend the desired
`instructions`, tools and controls on each call. Ordinary forks are independent;
changing instructions or model causes full-history replay. Pending tool results
may refresh instructions and tool definitions through completed-history replay;
a changed complete history/batch may retire a single idle owner with native grants
disabled; model, session and execution controls must still match. JSON and
streaming responses are stored only on successful completion; failed/cancelled
foreground streams are not published. Deleting an ancestor does not delete
already-created descendants. `background: true` requires storage and returns a
queued response; poll GET, retrieve SSE with `?stream=true&starting_after=N`, list
`/:id/input_items` with pagination, or POST `/:id/cancel`. Deleting a running
background response first cancels its owned work. Background reader disconnects
do not cancel generation. Queued/running work is volatile across restart. There
are at most 32 background jobs, with bounded event logs; cancellation/failure
records are process-local and retain the terminal event rather than the prior
partial event log. Completed foreground JSON retrieval emits item-level
events, not invented original token deltas. These semantics follow the
[Responses continuation contract](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
with the explicit local retention limits above.

`/v1/responses/input_tokens` accepts the supported Responses request shape and
returns the same explicitly labeled estimate.

`/v1/messages/count_tokens` returns `input_tokens`, `estimated: true`, the
`x-meridian-token-count: estimate` header and an `estimation` object. It uses
an estimate of ASCII bytes divided by four plus a conservative allowance for
each non-ASCII UTF-8 byte and images. Hidden CLI context and
unprocessed PDF/audio/video contents are excluded and explicitly counted in
`excluded_unprocessed_media`. It performs no fetching, rendering, transcription
or model call. It is neither an exact tokenizer nor an upper-bound quota estimate.

## Locally adapted documents, audio and video

Anthropic-style `document` blocks accept text/plain (`text` or canonical
`base64`) and application/pdf (`base64`), optionally with a title. PDFs require
local Poppler `pdfinfo`/`pdftoppm`: 1–16 pages are rendered at up to 1600 pixels.
Only exact rendered paths are readable by the CLI; native citations are absent.

Meridian extensions `audio` and `video` use a base64 source with `media_type`.
Audio accepts WAV/MPEG/MP4/OGG/FLAC; video accepts MP4/WebM/QuickTime. Local
`ffprobe`/`ffmpeg` limit clips to 120 seconds. Speech uses `whisper-cli` with
`MERIDIAN_AGY_WHISPER_MODEL` pointing to an installed whisper.cpp model. No
transcription API or alternate subscription authentication is used. Video yields
at most 12 frames at roughly ten-second intervals, plus a transcript if it has
audio. Short events between frames and non-speech sounds are not preserved.
A video with audio fails if transcription dependencies are missing, rather than
silently omitting its sound. The same blocks work inside client tool results.

All attachments require the client-tool bridge opt-in. Request bodies remain
8 MiB; a live conversation has a 32 MiB materialization budget and 64 rendered
images. Media preparation participates in request cancellation and deadlines.
Missing local dependencies return actionable errors. These adapters are not
native multimodal input APIs; the provider card labels that distinction.

## Native browser and subagents

Enable only the desired grants:

```sh
# Install separately; Meridian never downloads executable packages per request.
npm install -g chrome-devtools-mcp@1.9.0
MERIDIAN_BACKEND=antigravity \
MERIDIAN_AGY_ALLOW_NATIVE_BROWSER=1 \
MERIDIAN_AGY_ALLOW_NATIVE_SUBAGENTS=1 meridian
```

Chrome must also be installed. `MERIDIAN_AGY_BROWSER_MCP_PATH` selects a local
executable when it is not on the service PATH. Browser sessions use isolated,
headless Chrome profiles through the official Chrome DevTools MCP; personal
Chrome cookies/profile/debugging settings are untouched. The native browser
subagent performs actions and returns its result inside agy. Native actions do
not appear as client-owned tool calls or client permission dialogs.

Native self/research subagents must inherit the guarded workspace. Browser
subagents require the separate browser grant. File/shell tools, arbitrary new
agent definitions, branched workspaces, background scheduling and browser file
uploads remain denied. The actual child hook was tested to deny a disposable
non-attachment file. This is bounded allowlisting, not a claim that a CLI hook
is a complete OS security sandbox. `/telemetry/native-tools` exposes the latest
500 native tool events without prompts/results. The health endpoint separates
`processes`, `activeProcesses` and `pendingToolProcesses`; idle warm processes
are expected and reclaimable.

Additional live gates (consume the signed-in subscription):

```sh
node scripts/e2e-antigravity-expansion.mjs
node scripts/e2e-antigravity-openai-tools.mjs
E2E_PYTHON=/path/to/python-with-reportlab-and-pillow \
MERIDIAN_AGY_WHISPER_MODEL=/path/to/ggml-base.bin \
node scripts/e2e-antigravity-media.mjs
MERIDIAN_AGY_BROWSER_MCP_PATH=/path/to/chrome-devtools-mcp \
node scripts/e2e-antigravity-native-tools.mjs
```

The media fixture also uses macOS `say`; its recorded evidence does not validate
Linux/Windows preprocessing. See E2E.md for exact successes and retained failures.


## Pi/OpenCode extensions, approvals and questions

Use client extensions and plugins in their normal client locations. Their tools
are advertised through the existing client tool bridge; no additional Meridian
plugin or backend permission grant is needed. Pi/OpenCode execute the tools,
show approval dialogs, run their hooks and send results or errors to Meridian.
A denied client action does not authorize agy to perform the action itself.

The live extension gate covers:

- Pi: a real extension's custom tool, a confirmation dialog, argument rewriting,
  denial without execution, selected/cancelled questions, and a tool registered
  dynamically and used on the next user turn.
- OpenCode: a real V1 plugin's custom tools, permission approval/rejection,
  before/after hooks, system-context updates between tool calls, and the built-in
  question tool with both answered and rejected questions. OpenCode can end the
  current turn on permission rejection; a subsequent user turn conveys that
  rejected result back to the model.
- Both clients: approval after the CLI's configured tool wait expires. Complete
  client history recovers the result without executing the approved tool twice.

```sh
E2E_CLIENT=pi node scripts/e2e-antigravity-client-extensions.mjs
E2E_CLIENT=opencode node scripts/e2e-antigravity-client-extensions.mjs
```

The gate runs actual installed clients and the signed-in official agy CLI,
consumes subscription quota, and uses disposable client configuration. It checks
execution counts, private receipts carried in client tool results, and HTTP
errors, so successful client retries cannot conceal bridge failures. It uses a
five-second CLI tool wait to exercise delayed approval efficiently; production's
default remains sixty seconds. This verifies the listed client mechanisms,
not arbitrary third-party plugin code or TUI-only extension rendering.

### Disconnect after a completed client action

If a tool-result continuation fails or is cancelled before Meridian emits another
client call, an exact retry can replay its completed history after the old CLI exits.
Eligible statuses are 401, 408, 429, 499 and 5xx; normal backoff or account
correction is still required before retrying. Other deterministic failures keep
the consumed-result 409. A recovery-state write failure is logged while the
original failure and Retry-After are preserved.
Retries arriving during cleanup wait for that exit. The result IDs stay consumed;
a bounded exception binds the entire history, tool result, instructions, tools,
model, session, execution controls and tool choice. Concurrent retries cannot
start competing replays, and success removes the exception.

With `MERIDIAN_AGY_STATE_PATH`, these joined-interruption fingerprints persist for
up to 30 minutes (at most 256). They contain hashes, not prompts or tool results.
Clients must still resend the complete matching request. This does not restore
in-flight processes after a crash or guarantee exactly-once execution. Completed
answer recovery has a separate bounded snapshot cache, described below. No automatic replay exception is granted after a new
client tool was emitted, or when native browser/subagent capabilities are enabled.

The actual Pi/OpenCode fault gate drops delivery after accepting a completed
tool result, requires automatic client recovery and one audited execution, and
rejects every HTTP error:

```sh
E2E_AGY_DISCONNECT=1 E2E_CLIENT=pi node scripts/e2e-antigravity-client-extensions.mjs
E2E_AGY_DISCONNECT=1 E2E_CLIENT=opencode node scripts/e2e-antigravity-client-extensions.mjs
```

## Antigravity extensions and custom grammars

Embedders can pass `antigravity.plugins` or `pluginPaths`; CLI users can set
`MERIDIAN_AGY_PLUGIN_PATHS='["/absolute/plugin.mjs"]'`. Modules default-export an
object with a unique `name` and optional `onRequest`, `onResponse`, `onTelemetry`.
Request hooks receive `{provider,request,signal}` and return the Anthropic-shaped
request, which is revalidated. Response/telemetry observers receive isolated
copies and cannot rewrite saved responses. Request hooks have a ten-second
deadline; observers have one second. Failures appear in `/plugins/list`. Hooks
are trusted operator code, not sandboxed client code; Claude plugins are not
automatically loaded here.

Responses custom tools accept free text or `{type:"grammar",syntax:"regex"|"lark",
definition:"..."}`. Validation runs before client delivery and compiles before
model dispatch. Regex uses whole-string Unicode JavaScript RegExp in a worker
with a two-second deadline. Lark uses local Python/Lark, the `start` rule and
Earley parsing with a five-second deadline; imports are limited to individual
`common` rules. Other regex dialects/import forms are not promised. Up to sixteen
64-KiB grammars are accepted, with eight validators and a bounded waiting queue.
Grammar checking validates output; it does not provide native constrained
sampling or guarantee the model produces a valid payload.


### Lost completed answers

On the Anthropic Messages route, an exact retry of a completed tool-result turn
can receive the saved terminal text answer, including its original message ID,
content, stop reason and usage. The retry does not call agy, run response/telemetry
observers again, or add a second usage record. JSON and SSE retries are supported;
`x-meridian-response-replayed: true` identifies this path. Request transforms still
run before matching the validated request.

Matching binds the credential digest, complete history and result, system
instructions, tools, model, session, execution controls and tool choice. Ordinary
prompts are not memoized without an explicit request ID. Tool-call responses
require the identified-request path below. Requests
with native browser/subagent grants are also excluded. OpenAI routes retain their
existing Responses storage semantics; `store: false` never opts into this cache.

The separate answer budget is 128 entries, 16 MiB total and 1 MiB per serialized
snapshot, retained for up to 30 minutes. Oldest entries are evicted; retries do not
extend retention. Optional `MERIDIAN_AGY_STATE_PATH` persists these answer bodies
in Meridian's private SQLite file; without it, they disappear on restart. Oversized
implicit answers still succeed but are not saved. Identified responses exceeding
the entry limit fail explicitly before any tool call is delivered. If an answer is missing while its result
ID remains consumed, the retry receives 409. After both ledgers expire or evict
entries, exactly-once behavior is not guaranteed; clients must keep their history.

The live fault gate consumes an entire completed upstream response and then drops
it before the client sees it. It requires automatic recovery with identical message
ID, text and usage, one audited client execution, and zero HTTP errors:

```sh
E2E_AGY_LOST_ANSWER=1 E2E_CLIENT=pi node scripts/e2e-antigravity-client-extensions.mjs
E2E_AGY_LOST_ANSWER=1 E2E_CLIENT=opencode node scripts/e2e-antigravity-client-extensions.mjs
```


### Identified retries and lost tool-call responses

For the Antigravity Anthropic Messages route, send a unique `idempotency-key`
header or `meridian_request_id` body field for each logical model invocation.
Transport retries must reuse it and resend the identical request. IDs accept
1–128 ASCII letters, digits, dots, underscores, colons or hyphens; supplying
conflicting header/body IDs is invalid. The credential digest and ID select the
snapshot; a changed model, history, tools, instructions or execution controls
under the same ID receives 409. JSON/SSE mode may change.

Meridian validates and saves an entire tool batch before emitting its first tool
block. A retry returns the same message ID, tool IDs, arguments and usage without
another CLI invocation or another response/telemetry observer call. Results for
those IDs continue normally, including completed-history recovery after the
original CLI expires or restarts. Once results are being processed or are consumed,
the old tool response cannot be replayed. Concurrent exact retries wait for the
original response; cancelling a waiter does not cancel its owner. In-flight
identities and waiters are each bounded to 128 (waiters per identity).

This shares the existing 128-entry / 16 MiB / 30-minute answer budget and optional
SQLite persistence; it does not allocate a second response cache. The 1 MiB entry
limit applies. Ordinary prompts only acquire replay semantics when an ID is
explicitly provided. Native browser/subagent grants remain incompatible with this
path; OpenAI routes do not use it. In-flight work is not restored after a crash. With `statePath`, a separate
bounded hash-only journal records up to 128 unfinished identified requests for
30 minutes. A restart with no saved response returns an actionable HTTP 409
instead of automatically generating again; changed payloads retain the identity
conflict. Cleanly joined requests release their guard. Admission refuses to evict
unresolved guards when the journal is full. Saved answers remain recoverable even
if the process died before releasing its guard.
Expired/evicted entries and client-side execution outside the bridge do not acquire
an exactly-once guarantee. A custom GUI must track tool execution by tool ID and
never execute an already completed action merely because it reads a response again.

The repository includes provider-scoped integrations for a provider named
`meridian-agy`:

- Pi: load [antigravity-retry.js](../examples/pi-extension/antigravity-retry.js)
  with `pi -e /path/to/meridian/examples/pi-extension/antigravity-retry.js ...`.
  Its supported payload hook adds an ID before the SDK's HTTP retries and retains
  it for an exact failed-turn retry. Enable Pi's normal automatic retry setting
  for partial-stream transport failures. New prompts, changed payloads, successful
  or aborted turns, and session operations reset the ID. This uses bounded
  in-memory state (one request hash and ID), not persisted conversation content.
- OpenCode V1: copy [antigravity-retry.js](../examples/opencode-plugin/antigravity-retry.js)
  into the client's `plugins` directory. The header hook reads the active assistant
  message through OpenCode's public session API. That message survives processor
  retries and changes for the next tool round. Missing/ambiguous active steps do
  not get guessed IDs; a failed metadata read fails explicitly. Other providers
  are untouched. This integration has been verified on OpenCode 1.18.31.

Both helpers cover automatic transport retry before client response delivery.
Pi 0.72.1 additionally recovers the tested client-visible tool block followed by
a broken stream: it rejects the incomplete assistant turn before executing tools,
then retries the saved response with the same ID. This requires Pi to classify
the transport error as retryable; it does not repair arbitrary malformed streams.

OpenCode's provider-scoped transport forwards text events as they arrive while
holding tool calls and terminal events until EOF and `message_stop`. This restores
incremental text display without exposing executable tool prefixes from incomplete
responses. Text following the first tool block stays held to preserve event order.
The wrapper preserves an existing configured fetch, honors cancellation, and
limits each response to 4 MiB with a five-minute overall deadline. HTTP errors and
non-SSE responses pass through; other providers remain untouched.

On a transport interruption or truncated EOF, it requests the saved response once
as JSON using the original ID and `x-meridian-replay-only: true`. That header never
starts a model: absent/expired snapshots return 404. Normal credential, fingerprint
and consumed-tool checks remain enforced. The wrapper verifies the message ID and
every already displayed text prefix before emitting only the missing suffix and
withheld tools. Changed prefixes, missing snapshots, malformed streams and
cancellation fail explicitly; no replacement answer is silently spliced into
visible text. This is bounded delivery recovery, not durable exactly-once action
execution across a client crash.
Approvals remain in the client and are never granted by these helpers.

```sh
E2E_AGY_LOST_TOOL=1 E2E_CLIENT=pi node scripts/e2e-antigravity-client-extensions.mjs
E2E_AGY_LOST_TOOL=1 E2E_CLIENT=opencode node scripts/e2e-antigravity-client-extensions.mjs
```

The relay consumes a complete tool-call response, drops it before delivery, and
requires the real client to retry through the saved-response path with the same
request, message and tool IDs, one approved execution, and zero HTTP errors.

To test client-visible partial tool delivery for either supported client:

```sh
E2E_AGY_LOST_TOOL=1 E2E_AGY_PARTIAL_TOOL=1 E2E_CLIENT=pi node scripts/e2e-antigravity-client-extensions.mjs
E2E_AGY_LOST_TOOL=1 E2E_AGY_PARTIAL_TOOL=1 E2E_AGY_TEXT_STREAM=1 E2E_CLIENT=opencode node scripts/e2e-antigravity-client-extensions.mjs
```

The relay sends tool blocks, waits 250 ms, records actual executions, then severs
the connection before `message_delta`/`message_stop`. The gate requires no
execution before the disconnect and normal approval/result recovery afterward.

### Local media provenance

Local Whisper transcription includes estimated SRT segment timestamps. Video
sampling selects the first frame and subsequent frames at least ten seconds
apart (up to 12 frames). Each frame carries its measured source timestamp from
ffmpeg; times are not inferred from image numbering. These references help
locate content but do not establish native citations, perfect transcription,
continuous motion understanding or coverage of brief events between samples.

## Long client-tool conversations

`MERIDIAN_AGY_MAX_TOOL_CALLS` sets the cumulative client-tool and MCP replay-ledger
allowance for one live conversation. It defaults to 256 and accepts integers
from 1 to 65536; invalid explicit values fail startup. An operator can raise the
allowance for a long agent task, for example to 512, before starting Meridian.
Higher allowances retain more conversation and replay data until the run is
retired. The existing completed-conversation reuse policy is unchanged.

A restored live process starts with a fresh allowance; the count is not a
lifetime ledger for a saved native conversation. Model/turn and pending-tool
deadlines remain independent: raising the call allowance does not extend them.

This setting does not change native CLI/provider limits, client tool
permissions, the 32 outstanding-call limit, or the 16-call parallel batch limit.
Duplicate MCP request IDs replay their original result without spending another
client call. A batch that exceeds the remaining allowance is rejected before
any call in it is dispatched.

A client-call limit error retains the existing error wording. Use
`MERIDIAN_AGY_MAX_TOOL_CALLS` to configure this allowance, independently of turn
and client-tool wait deadlines.
