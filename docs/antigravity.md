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

Pending tool calls retain a live `agy` process. Each continuation must preserve
the delivered conversation prefix, model, system instructions, tool catalog and
output budget. The result must correspond to the exact delivered tool ID.
Changed live continuations and recently consumed duplicate results receive HTTP 409.
Unpaired or malformed historical results receive HTTP 400. New user text
may accompany the exact result or follow it in another user message. This steering
continues the same pending process and is delivered separately from tool output. Independent upstream calls are coalesced into one response, preserving every
correlation. A synthetic `meridian_parallel` MCP tool also submits 2–16 independent
actions atomically. `disable_parallel_tool_use: true` delivers them serially. A live result remains bound to its original process.

Matching ordinary turns reuse the same live CLI process and send only new user
messages. This preserves native conversation/cache affinity while that process
lives; cache hits and quota savings remain provider-dependent. Exact history,
model, instructions, tools and output controls must match. Edits, forks after a
branch advances, compaction, expired processes and restarts use full history
replay. Schema/stopped responses use fresh processes. Embedders can disable warm
reuse with `antigravity.reuseConversations: false`. Replay is explicit JSON
context, not native role-preserving transcript import or durable native resume.

Repeated MCP request IDs reuse their original result within their MCP session;
conflicting reuse is rejected. Native children have independent MCP sessions. Each
live conversation permits 256 client calls, 32 outstanding calls and 64 MCP
sessions. Warm reuse retires long tool conversations before exhausting that budget.

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
A bounded process-local ledger rejects the latest 4,096 consumed result IDs and
concurrent recovery of the same result. This is not durable exactly-once delivery:
after restart or ledger eviction, clients must retain their completed history and
avoid resubmitting already answered requests. The model still decides subsequent
tool calls; client permissions and side-effect safeguards remain important.

HTTP disconnects during active responses abort that request's process.
Disconnecting normally after a `tool_use` response leaves its process waiting
until a result, reclamation, or the tool deadline.

Temporary workspaces are removed after subprocess exit. The official CLI still
persists its own conversations and project metadata under its normal account
directories. Meridian does not edit or garbage-collect those private records.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERIDIAN_BACKEND` | `claude` | Set to `antigravity` to select Antigravity, or `combined` for both providers |
| `MERIDIAN_AGY_PATH` | `agy` | Official CLI executable |
| `MERIDIAN_AGY_ALLOW_TOOL_BRIDGE` | off | Explicit tool bridge permission opt-in |
| `MERIDIAN_AGY_ALLOW_NATIVE_BROWSER` | off | Isolated native browser opt-in |
| `MERIDIAN_AGY_BROWSER_MCP_PATH` | `chrome-devtools-mcp` | Installed Chrome DevTools MCP 1.9.0 executable |
| `MERIDIAN_AGY_ALLOW_NATIVE_SUBAGENTS` | off | Guarded native self/research subagent opt-in |
| `MERIDIAN_AGY_WHISPER_MODEL` | unset | Local whisper.cpp model for audio transcription |
| `MERIDIAN_AGY_MAX_CONCURRENT` | `4` | Maximum live processes; idle pending tools can yield capacity |
| `MERIDIAN_AGY_TURN_TIMEOUT_MS` | `300000` | Per-turn deadline, including preprocessing and tool waits |
| `MERIDIAN_AGY_TOOL_TIMEOUT_MS` | `60000` | Pending result deadline and completed-conversation idle retention |

Capacity exhaustion returns 429 with `Retry-After`. No unbounded request queue
is created. Bodies are capped at 8 MiB; upstream stdout is capped at 16 MiB.
Prompts use stdin to avoid OS argument-size limits. Shutdown terminates owned
process groups and closes the MCP listener.

Embedders can set `backend: "antigravity"` and `antigravity: { executable,
allowToolBridge, maxConcurrent, turnTimeoutMs, pendingToolTimeoutMs }` on
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
- Numeric thinking budgets, sampling controls, signed reasoning, Claude-specific
  profiles/plugins, durable Claude telemetry and durable native resume remain
  unavailable. Unsupported modeled request features fail before execution.
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
Antigravity uses bounded minute buckets; Claude uses its telemetry window. Antigravity activity is process-local, retains the
latest 500 request metadata records, and resets when Meridian restarts. No
prompts or tool contents are retained in this activity feed. Subscription quotas
come from the account and survive proxy restarts.

The macOS app has a Providers page, the same overview and filters, separate
Antigravity quota windows in the menu bar, and provider selection under Settings.
For an app-managed service, stop it, choose Claude, Antigravity, or both, then
start it. Client tools, native browsing and native subagents have separate opt-in checkboxes.
The provider card exposes capabilities and their practical limits. An attached service
is configured by its owner. Sign into Google using the official CLI; the desktop
app does not collect Google credentials or repurpose Claude profile login.

## Compatibility and operational contract

The supported macOS text/client-tools path is gated to official `agy` **1.2.7**.
An unverified CLI update is refused before a new model process starts. Validate
new versions with the live gates below before changing the compatibility gate.
Linux remains preview until its actual CLI/client flow is verified. Windows
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

## Pi and OpenCode

Both clients use their own tools, permissions and saved sessions. Meridian does
not replace their tool implementations. Matching completed turns reuse the live
CLI; forks, undo and compaction use validated client history when replay is
needed. Client-owned delegation (for example OpenCode's `task`) is allowed
through MCP. Native delegation is independently gated below.

These examples use standalone Antigravity on port 3457. For a combined service,
use its port and prepend `/antigravity` to each base URL. If Meridian API-key
protection is configured, replace `local-placeholder` with that local key.

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


## What the remaining limits mean

| Control | Meaning | What is lost through the current CLI |
| --- | --- | --- |
| Hard `max_tokens` | Enforce an exact upper bound on generated tokens | The requested limit is advisory. A long answer or tool loop can use more quota and time than that number suggests. Response byte limits and process deadlines remain enforced. |
| Numeric thinking budget | Allocate a specific number of tokens to internal reasoning | No exact reasoning-token allowance. Supported Gemini low/medium/high variants offer coarser effort selection; disabling a client's budget control does not disable the model's intrinsic reasoning. |
| `temperature`, `top_p`, `top_k` | Tune how the model samples its next tokens | No direct randomness/diversity tuning. Prompts can request a style, but do not implement sampling parameters or guarantee repeatability. |

These controls do not determine whether file editing, shell commands, search,
images or client delegation are available. Truncating returned text locally would
not impose a native token/quota budget and could break JSON or tool arguments;
Meridian does not claim that workaround as a hard limit.

Remaining boundaries:

- Exact upstream token counts, hard output caps, numeric thinking budgets,
  sampling controls and signed native reasoning are not exposed by this CLI.
- Native attachment semantics differ from local adaptation: no native PDF
  citations, continuous video understanding, non-speech audio or generated media.
- Warm native reuse ends on expiry/restart; no durable native session restoration.
- Durable Responses storage, arbitrary OpenAI tools/formats and universal
  third-party client compatibility are not implemented.
- Claude profile pools and SDK-specific plugin hooks cannot be applied to the
  Google account. The existing plugin `RequestContext` contains Claude SDK agents,
  hooks and settings; translating it would require a separate provider-aware
  contract, not claiming those hooks ran. Global agy customizations still load,
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
results. Custom/namespaced tools and audio/video OpenAI formats remain unsupported.
Unsupported fields fail before dispatch instead of being silently dropped.
This surface is not a claim of complete Codex compatibility.

Responses are stored by default; `store: false` disables the response-ID snapshot
for that turn (it does not disable the separate live CLI conversation). Use
`GET /v1/responses/:id` to retrieve the completed JSON response and
`DELETE /v1/responses/:id` to remove its snapshot. Both routes use normal Meridian
authentication; snapshots are scoped to the supplied API credential. When no key
is configured, callers without a credential share the local service scope.
Combined mode prefixes these routes with `/antigravity`.

Storage is process-local, with a fixed 30-minute lifetime, at most 256 entries,
64 MiB of serialized state in total, and 16 MiB per entry. Oldest entries are
removed under pressure; expired entries are removed on subsequent store access.
Restart/shutdown clears storage. Missing, expired, deleted, evicted and unstored
IDs return 404; clients can recover by resending their complete history. Expanded
input is limited to 8 MiB before any model call. A response exceeding its storage
budget fails rather than advertising a retrievable ID. Keep a client-side history
for longer sessions and reliable recovery.

Only input/output items carry forward through a response ID: resend the desired
`instructions`, tools and controls on each call. Ordinary forks are independent;
changing instructions or model causes full-history replay. Pending tool results
still require the matching tool definitions and instruction contract. JSON and
streaming responses are stored only on successful completion; failed/cancelled
streams are not published. Deleting an ancestor does not delete already-created
descendants or cancel native work. Retrieval streaming, input-item listing and
background responses remain unsupported. These semantics follow the
[Responses continuation contract](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
with the explicit local retention limits above.

`/v1/messages/count_tokens` returns `input_tokens`, `estimated: true`, the
`x-meridian-token-count: estimate` header and an `estimation` object. It uses
UTF-8 bytes divided by four plus an image allowance. Hidden CLI context and
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
