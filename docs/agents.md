# Agent Setup

[← Back to README](../README.md)

Per-agent configuration for every tested client. All agents share the same basics — point the tool at `http://127.0.0.1:3456` with any API key value — but several have their own config formats or adapters, documented here.

### OpenCode

### OpenCode V1

**Step 1: Run `meridian setup` (required, one time)**

```bash
meridian setup
```

When V1 and V2 are both installed, the default command keeps V1 selected. You can
also select it explicitly:

```bash
meridian setup --v1
```

Setup adds the V1 Meridian plugin to the OpenCode global config
(`~/.config/opencode/opencode.json`). It preserves unrelated plugin entries and
all other settings.

**Step 2: Start**

```bash
ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

Or set these in your shell profile so they are always active:

```bash
export ANTHROPIC_API_KEY=x
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
```

### OpenCode V2 beta

Meridian currently supports the exact public beta used by its V2 plugin:
`@opencode-ai/cli@0.0.0-beta-18314`. V2 plugin APIs are still changing, so setup
fails closed for another V2 version instead of installing a plugin with an
unknown contract.

Install the pinned beta and select its executable:

```bash
npm install -g --prefix ~/.local @opencode-ai/cli@0.0.0-beta-18314
meridian setup --v2 --opencode-bin ~/.local/bin/opencode2
```

If your binary is elsewhere, pass that path to `--opencode-bin`. V2 can
self-update to a newer beta, so keep it pinned and launch it with automatic
updates disabled while this compatibility target is current:

```bash
export OPENCODE_DISABLE_AUTOUPDATE=1
```

Configure V2's Anthropic provider to use Meridian. Keep the existing settings in
`~/.config/opencode/opencode.json`; the important provider fields are:

```json
{
  "model": "anthropic/claude-opus-4-6",
  "small_model": "anthropic/claude-haiku-4-5",
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "x",
        "baseURL": "http://127.0.0.1:3456"
      },
      "models": {
        "claude-opus-4-6": { "name": "Claude Opus 4.6" },
        "claude-haiku-4-5": { "name": "Claude Haiku 4.5" }
      }
    }
  }
}
```

Then start the pinned client:

```bash
OPENCODE_DISABLE_AUTOUPDATE=1 ~/.local/bin/opencode2
```

The V2 plugin uses the native `model.request` and `http.request` hooks. It keeps
primary and compaction requests attached to the correct OpenCode session,
detaches concurrent hidden title/summary requests, and gives each visible
subagent its own trusted identity. Request bodies and model input are unchanged.

For either generation, the plugin enables:

- **Session tracking** — reliable conversation continuity across requests
- **Safe hidden-agent concurrency** — title and summary work cannot advance the primary lineage
- **Safe model defaults** — Opus uses 1M context; Sonnet uses 200k to avoid Extra Usage charges ([details](configuration.md#configuration))
- **Subagent model selection** — subagents use the 200k tier, preserving rate-limit budget

If the plugin is missing, Meridian warns at request time. Restart OpenCode after
running setup so it loads the selected plugin.

#### oh-my-opencagent (OMO)

> **OpenCode V1:** The integration below is validated on V1. Do not assume that
> its plugin schema is compatible with the pinned V2 beta.

[oh-my-opencagent](https://github.com/nicobailey/oh-my-opencagent) adds multi-agent orchestration on top of OpenCode. It works transparently through Meridian with no extra configuration — OMO uses the same OpenCode headers and tool format, so Meridian detects it automatically.

Meridian parses OMO's Task tool descriptions to extract subagent names (explore, code-review, etc.) and builds SDK AgentDefinitions so Claude can route to the correct agent. Internal orchestration markers (`<!-- OMO_INTERNAL_INITIATOR -->`, `[SYSTEM DIRECTIVE: OH-MY-OPENCODE ...]`) are stripped automatically to prevent context leakage.

OMO requires **passthrough mode** (the default for OpenCode) — subagent delegation flows through tool calls that must be forwarded back to the client.

### Crush

Add a provider to `~/.config/crush/crush.json`:

```json
{
  "providers": {
    "meridian": {
      "id": "meridian",
      "name": "Meridian",
      "type": "anthropic",
      "base_url": "http://127.0.0.1:3456",
      "api_key": "dummy",
      "models": [
        { "id": "claude-fable-5-1",  "name": "Claude Fable 5.1 (1M)",   "context_window": 1000000, "default_max_tokens": 32768, "can_reason": true, "supports_attachments": true },
        { "id": "claude-fable-5",    "name": "Claude Fable 5 (1M)",     "context_window": 1000000, "default_max_tokens": 32768, "can_reason": true, "supports_attachments": true },
        { "id": "claude-opus-5",     "name": "Claude Opus 5 (1M)",      "context_window": 1000000, "default_max_tokens": 32768, "can_reason": true, "supports_attachments": true },
        { "id": "claude-opus-4-8",   "name": "Claude Opus 4.8 (1M)",    "context_window": 1000000, "default_max_tokens": 32768, "can_reason": true, "supports_attachments": true },
        { "id": "claude-opus-4-7",   "name": "Claude Opus 4.7 (1M)",    "context_window": 1000000, "default_max_tokens": 32768, "can_reason": true, "supports_attachments": true },
        { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6 (1M)",  "context_window": 1000000, "default_max_tokens": 64000, "can_reason": true, "supports_attachments": true },
        { "id": "claude-opus-4-6",   "name": "Claude Opus 4.6 (1M)",    "context_window": 1000000, "default_max_tokens": 32768, "can_reason": true, "supports_attachments": true },
        { "id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5", "context_window": 200000,  "default_max_tokens": 16384, "can_reason": true, "supports_attachments": true }
      ]
    }
  }
}
```

```bash
crush run --model meridian/claude-sonnet-4-6 "refactor this function"
crush --model meridian/claude-opus-4-6       # interactive TUI
```

Crush is automatically detected from its `Charm-Crush/` User-Agent — no plugin needed.

### Droid (Factory AI)

Add Meridian as a custom model provider in `~/.factory/settings.json`:

```json
{
  "customModels": [
    { "model": "claude-fable-5-1",        "name": "Fable 5.1 (Meridian)",  "provider": "anthropic", "baseUrl": "http://127.0.0.1:3456", "apiKey": "x" },
    { "model": "claude-fable-5",          "name": "Fable 5 (Meridian)",    "provider": "anthropic", "baseUrl": "http://127.0.0.1:3456", "apiKey": "x" },
    { "model": "claude-opus-5",           "name": "Opus 5 (Meridian)",     "provider": "anthropic", "baseUrl": "http://127.0.0.1:3456", "apiKey": "x" },
    { "model": "claude-opus-4-8",         "name": "Opus 4.8 (Meridian)",   "provider": "anthropic", "baseUrl": "http://127.0.0.1:3456", "apiKey": "x" },
    { "model": "claude-opus-4-7",         "name": "Opus 4.7 (Meridian)",   "provider": "anthropic", "baseUrl": "http://127.0.0.1:3456", "apiKey": "x" },
    { "model": "claude-sonnet-4-6",       "name": "Sonnet 4.6 (Meridian)", "provider": "anthropic", "baseUrl": "http://127.0.0.1:3456", "apiKey": "x" },
    { "model": "claude-opus-4-6",         "name": "Opus 4.6 (Meridian)",   "provider": "anthropic", "baseUrl": "http://127.0.0.1:3456", "apiKey": "x" },
    { "model": "claude-haiku-4-5-20251001", "name": "Haiku 4.5 (Meridian)", "provider": "anthropic", "baseUrl": "http://127.0.0.1:3456", "apiKey": "x" }
  ]
}
```

Then pick any `custom:claude-*` model in the Droid TUI. No plugin needed — Droid is automatically detected.

### Cline

**1. Authenticate:**

```bash
cline auth --provider anthropic --apikey "dummy" --modelid "claude-sonnet-4-6"
```

**2. Set the proxy URL** in `~/.cline/data/globalState.json`:

```json
{
  "anthropicBaseUrl": "http://127.0.0.1:3456",
  "actModeApiProvider": "anthropic",
  "actModeApiModelId": "claude-sonnet-4-6"
}
```

**3. Run:**

```bash
cline --yolo "refactor the login function"
```

No plugin needed — Cline uses the standard Anthropic SDK.

### Aider

```bash
ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://127.0.0.1:3456 \
  aider --model anthropic/claude-sonnet-4-6
```

> **Note:** `--no-stream` is incompatible due to a litellm parsing issue — use the default streaming mode.

### Codex CLI

Codex CLI ≥ 0.96 dropped `wire_api = "chat"` and speaks only the OpenAI **Responses API** (`/v1/responses`), which Meridian serves. Add a provider to `~/.codex/config.toml`:

```toml
model = "claude-sonnet-5"
model_provider = "meridian"

[model_providers.meridian]
name = "Meridian"
base_url = "http://127.0.0.1:3456/v1"
wire_api = "responses"
env_key = "MERIDIAN_KEY"    # any value unless MERIDIAN_API_KEY is set
```

```bash
MERIDIAN_KEY=x codex "refactor this function"
MERIDIAN_KEY=x codex exec "run the tests and summarize failures"   # non-interactive
```

Codex is a tool-driving agent — Meridian runs the `/v1/responses` endpoint in **passthrough** mode automatically (Codex executes its own shell/apply-patch tools), so no `MERIDIAN_PASSTHROUGH` change is needed. A harmless `Model metadata for 'claude-sonnet-5' not found` warning from Codex is expected — it doesn't recognize non-OpenAI model ids but works regardless.

`model_reasoning_effort` is supported and won't stall the CLI, but Claude's private thinking isn't yet carried **across** turns — the Responses API's encrypted-reasoning envelope is OpenAI-specific and incompatible with Claude's signed thinking blocks, so cross-turn reasoning continuity is deferred (each turn still reasons with full context including tool results). Verified on Codex 0.144 with plain, tool-driving, and reasoning-enabled turns.

### OpenAI-compatible tools (Open WebUI, Continue, etc.)

Meridian speaks the OpenAI protocol natively — no LiteLLM or translation proxy needed.

**`POST /v1/chat/completions`** — accepts OpenAI chat format, returns OpenAI completion format (streaming and non-streaming)

- `image_url` parts are supported when provided as **data URLs** (`data:image/...;base64,...`)
- multimodal tool flows where a tool returns `tool_result.content = [text, image]` are preserved through the structured multimodal path instead of being flattened to text

**`GET /v1/models`** — returns available Claude models in OpenAI format

Point any OpenAI-compatible tool at `http://127.0.0.1:3456` with any API key value:

```bash
# Open WebUI: set OpenAI API base to http://127.0.0.1:3456, API key to any value
# Continue: set apiBase to http://127.0.0.1:3456 with provider: openai
# Any OpenAI SDK: set base_url="http://127.0.0.1:3456", api_key="dummy"
```

> **Note:** Multi-turn conversations work by packing prior turns into the system prompt. Each request is a fresh SDK session — OpenAI clients replay full history themselves and don't use Meridian's session resumption.

### Cherry Studio

[Cherry Studio](https://github.com/CherryHQ/cherry-studio) is a desktop chat client. Point it at Meridian by setting the Anthropic API base URL to `http://127.0.0.1:3456` (any API key value works).

Because Cherry Studio is a chat client rather than a coding agent, select the `cherry` adapter so Claude's **built-in web search** is available (coding-agent adapters block it in favour of their own):

```bash
MERIDIAN_DEFAULT_AGENT=cherry meridian
```

The `cherry` adapter runs in internal mode: Claude executes `WebSearch`/`WebFetch` itself and Meridian returns the grounded answer — the internal tool calls are hidden from the client. This resolves the "no WebSearch/WebFetch tool exposed" error (#481).

> Cherry Studio doesn't send a Meridian-specific header, so set `MERIDIAN_DEFAULT_AGENT=cherry` on a Meridian dedicated to it, or send `x-meridian-agent: cherry` if your setup allows custom headers.

### ForgeCode

Add a custom provider to `~/forge/.forge.toml`:

```toml
[[providers]]
id            = "meridian"
url           = "http://127.0.0.1:3456/v1/messages"
models        = "http://127.0.0.1:3456/v1/models"
api_key_vars  = "MERIDIAN_FORGE_KEY"
response_type = "Anthropic"
auth_methods  = ["api_key"]

[session]
provider_id = "meridian"
model_id    = "claude-opus-4-6"
```

Set the API key env var. Any value works unless you've enabled authentication with `MERIDIAN_API_KEY`, in which case use your auth key here:

```bash
export MERIDIAN_FORGE_KEY=x
```

Then log in and select the model:

```bash
forge provider login meridian    # enter any value when prompted
forge config set provider meridian --model claude-opus-4-6
```

Start Meridian with the ForgeCode adapter:

```bash
MERIDIAN_DEFAULT_AGENT=forgecode meridian
```

ForgeCode uses reqwest's default User-Agent, so automatic detection isn't possible. The `MERIDIAN_DEFAULT_AGENT` env var tells Meridian to use the ForgeCode adapter for all unrecognized requests. If you run other agents alongside ForgeCode, use the `x-meridian-agent: forgecode` header instead (add `[providers.headers]` to your `.forge.toml`).

### Pi

Pi uses the `@mariozechner/pi-ai` library which supports a configurable `baseUrl` on the model. Add a provider-level override in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "http://127.0.0.1:3456",
      "apiKey": "x",
      "headers": {
        "x-meridian-agent": "pi"
      }
    }
  }
}
```

Pi mimics Claude Code's User-Agent, so automatic detection isn't possible. The `x-meridian-agent: pi` header in the config above tells Meridian to use the Pi adapter. Alternatively, if Pi is your only agent, you can set `MERIDIAN_DEFAULT_AGENT=pi` as an env var instead.

Pi runs in passthrough mode by default — it executes its own tools and Meridian just forwards the `tool_use` blocks. Opt out with `MERIDIAN_PASSTHROUGH=0`.

[Oh My Pi](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) (`omp`) is
built on the same runtime and uses the Pi adapter. Its config lives in
`~/.omp/agent/models.yml` and takes the same three keys:

```yaml
providers:
  anthropic:
    baseUrl: http://127.0.0.1:3456
    apiKey: x
    headers:
      x-meridian-agent: pi
```

omp runs its main turn, title generation and mid-turn side questions
concurrently under one session id. Meridian serializes them and answers a
conflicting late request by replaying its own history. It does not reject that
request merely because another caller committed while it waited. Normal
upstream errors and cancellation still apply. The mapping follows the last
completed caller: if that is a side call, the next main turn may also need a
fresh replay. Separate session identities avoid this extra replay cost.

Fresh side requests use their own tool declarations. Tool definitions omitted
on a continuation can be inherited only from that same published SDK branch;
a failed side request does not replace its tool cache.

### Prime Agent

[Prime Agent](https://www.npmjs.com/package/prime-agent) is a fork of Pi with a
different prompt and tool surface, so it uses its own `prime` adapter rather
than Pi's. Its only tool by default is `ipython`, a persistent kernel in the
client — passthrough is effectively required, and internal mode
(`MERIDIAN_PASSTHROUGH=0`) drops that tool entirely.

Connect it with an extension. Save as `.prime/agent/extensions/meridian.ts` in
a project, or `~/.prime/agent/extensions/meridian.ts` globally:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const MERIDIAN_PROVIDER = "meridian"

export default function (pi: ExtensionAPI) {
  pi.registerProvider(MERIDIAN_PROVIDER, {
    name: "Meridian (Claude Max)",
    baseUrl: "http://127.0.0.1:3456",
    apiKey: "MERIDIAN_API_KEY",       // env var name, or any literal if auth is off
    api: "anthropic-messages",
    headers: { "x-meridian-agent": "prime" },
    models: [
      {
        id: "claude-opus-5",
        name: "Claude Opus 5 (Meridian)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 64000,
      },
    ],
  })

  // Required, not an optimisation — see below.
  pi.on("before_provider_request", (event: any, ctx: any) => {
    if (ctx?.model?.provider !== MERIDIAN_PROVIDER) return undefined
    const sessionId = ctx?.sessionManager?.getSessionId?.()
    if (typeof sessionId !== "string" || !sessionId) return undefined
    const identity: Record<string, string> = { session_id: sessionId }
    // Optional, and only present on newer Prime Agent builds. It is what lets
    // Meridian cancel a whole subagent tree — see "Subagent cancellation".
    const parentSessionId = ctx?.sessionManager?.getParentSessionId?.()
    if (typeof parentSessionId === "string" && parentSessionId) {
      identity.parent_session_id = parentSessionId
    }
    return {
      ...(event.payload as Record<string, unknown>),
      metadata: { user_id: JSON.stringify(identity) },
    }
  })
}
```

Then pick a model with `/model` or `--provider meridian --model claude-opus-5`.

**`contextWindow` must say `1000000`.** Provider models registered this way are
static — Prime Agent never calls `GET /v1/models` for them — so this literal is
the *only* thing driving the TUI footer and auto-compaction
(`contextTokens > contextWindow - reserveTokens`). Meridian routes every primary
`opus` request to the SDK's `opus[1m]` alias, so a `200000` here compacts the
conversation at a fifth of the window you are actually paying for. Restart Prime
Agent after editing: providers are registered once per process.

Set it back to `200000` if you opt out of extended context on the proxy side —
`MERIDIAN_1M_CONTEXT_SUPPORT=0`, `MERIDIAN_OPUS_MODEL=opus`, or a plan that
doesn't include Opus 1M (Meridian then falls back to plain `opus` after one
Extra-Usage rejection). Leaving `1000000` in that case surfaces as upstream
errors on long conversations instead of local compaction.

`maxTokens: 64000` is a conservative output cap; Opus 5 supports up to 128000
and Meridian does not clamp it.

Registering a **new** provider rather than overriding `anthropic` means
installing this changes nothing until you select one of its models, so an
already-running agent is unaffected.

**The `before_provider_request` hook is required.** Prime Agent sends no session
identity of its own, and under passthrough every tool round ends in a
`tool_result` — which Meridian treats as a self-contained request needing no
session resume. Each round then replays the whole conversation into a fresh
session, and since that replay strips the assistant's `tool_use` blocks by
design, the model loses track of what it has already run. Stamping
`metadata.user_id` makes each round a continuation instead, so the SDK keeps the
real tool calls in its own session state. `getSessionId()` is distinct per
agent, so RLM children get their own keys rather than colliding with the parent.

**Subagent cancellation.** RLM children reach Meridian as independent requests
on their own session keys, so cancelling the parent used to leave every child
running — holding an SDK permit and billing the subscription until its own
socket closed. `parent_session_id` closes that: it names the child's *immediate*
parent, Meridian keeps a registry of in-flight requests and their parent links,
and aborting a parent's request aborts every live request in the subtree below
it, evicting each one's session mapping exactly as a direct cancel does.

Three limits are deliberate. Only an actual abort propagates — a parent turn
that merely finishes leaves its children alone, because a child routinely
outlives the turn that spawned it. Only *live* requests are tracked; a session
with nothing in flight is not remembered. And a client that omits
`parent_session_id` is unaffected, which is the whole gate — there is no config
flag. `POST /v1/sessions/<key>/cancel` cancels a subtree explicitly if you want
to stop one without dropping sockets, and `/telemetry/summary` reports the
counts under `sessionTree`.

Detection is by the `x-meridian-agent: prime` header above, or
`MERIDIAN_DEFAULT_AGENT=prime`. There is deliberately no User-Agent rule: in
API-key mode Prime Agent sends the generic `Anthropic/JS <version>` that every
Anthropic SDK client sends, so matching on it would misroute unrelated traffic.

**Known limitation — file-change tracking.** Meridian reads file changes out of
`ipython` cells for `%%bash` bodies, `!` shell escapes, and `await edit(path=…)`
calls. It does **not** parse arbitrary Python writes (`open(p, "w").write(…)`,
`Path.write_text`, library calls), which would need real dataflow analysis. Those
edits still happen; they just don't appear in Meridian's file-change summary.

#### What was verified, and what wasn't

Measured on 2026-08-13/14 against Prime Agent 0.7.2:

| Verified | How |
|---|---|
| Adapter selection, live turns | Real `prime-agent` binary through Meridian |
| Tool-round session continuity | 45/45 rounds resumed as continuations across 12 sessions |
| RLM children get distinct keys | Parent and depth-1 child carried different `metadata.user_id` on the wire |
| Works with `codeSystemPrompt` off | 6 multi-round loops per arm; preset on vs off scored identically |
| Survives long idle gaps | 7-minute silence, then `lineage=continuation` and the model recalled a codeword set before the gap |
| Not metered as a third-party app | Negative control → full 18KB prompt → control again, all passing with the preset off |

**Not verified: cron/scheduled tick delivery.** Two attempts, neither
conclusive. Against a shared supervisor the scheduler fired (`runs=3`) but no
request reached Meridian. Against an isolated supervisor, `schedule add` itself
hung and never persisted the job. Session continuity across a worker restart is
likewise untested.

Four constraints make this awkward to exercise, all learned the hard way:

- Only *resident* workers can be scheduled against. `print`, `rpc` and `json`
  create **client-owned** workers, which Prime Agent deliberately omits from
  schedules — so every headless mode is structurally ineligible. A resident
  worker needs an interactive session, which needs a TTY (a pty works).
- The `--daemon-socket` flag must come **before** the subcommand:
  `prime-agent --daemon-socket <path> schedule list`. Placed after, it is
  rejected as an unknown option, which reads misleadingly like the subcommand
  cannot target a custom socket.
- `PRIME_AGENT_CODING_AGENT_DIR` does **not** isolate a session from a shared
  supervisor. The supervisor writes sessions into whichever agent directory
  *it* was started with, so a test run against an already-running daemon lands
  its sessions in that daemon's store. The supervisor socket is likewise global
  per UID (`$TMPDIR/prime-agent-<uid>/daemon.sock`), so real isolation needs
  `--daemon-socket` *and* a matching `PRIME_AGENT_CODING_AGENT_DIR`.
- A dangling `~/.cache/meridian` makes Meridian return
  `500 ENOENT … mkdir '~/.cache/meridian'` on affected requests. The client
  retries and appears to hang, which is easy to misread as the agent stalling.
  Check that path resolves before diagnosing anything else.

A resident worker configured this way *does* reach Meridian — verified — so the
remaining gap is specifically the scheduler, not the transport.

The long-idle result above covers the part Meridian owns — a turn arriving on a
session after a quiet gap resumes rather than replaying.

Also not verified: the real client driving its own IPython kernel through a full
tool loop. Kernel provisioning stalled in the isolated test environment; the
tool-round evidence above comes from replaying Prime Agent's exact prompt and
tool schema rather than from its kernel.

**The metering result is a dated snapshot, not a property of the prompt.** It
means "not flagged on this account at this moment" — the same classifier was
observed changing its answer within a single day during the OpenClaw work. If
you hit `400 You're out of extra usage` on Prime Agent traffic, re-measure
before assuming the prompt is fine.

### Claude Code

Claude Code can point at Meridian like any other Anthropic API client. The
common use case is sharing a single Claude Max subscription from one host
across other machines on your network — run Meridian on the box that is
logged into Claude Max, then run Claude Code anywhere else against it.

```bash
# On another machine (or the same one)
ANTHROPIC_AUTH_TOKEN=x ANTHROPIC_BASE_URL=http://meridian-host:3456 claude
```

> **Note:** Use `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`) — Claude Code
> treats both as bearer credentials. Set the value to your `MERIDIAN_API_KEY`
> if you've enabled authentication, otherwise any string works.

> ⚠️ **Security for multi-machine setups.** If you expose Meridian beyond
> loopback (e.g. bind to `0.0.0.0` or a LAN IP), **set `MERIDIAN_API_KEY` to a
> strong secret** and require it on clients. An unprotected network-accessible
> proxy is a Claude Max credential leak — anyone who can reach the port can
> burn your subscription.

Claude Code is detected automatically via its `claude-cli/*` User-Agent.
Requests flow through the Claude Code adapter which:

- Parses the client's real working directory from its `Primary working directory:` system-prompt line so Claude answers path-related questions with your local path, not the proxy host's.
- Leaves the SDK subprocess cwd on the proxy host (Claude Code's local paths don't exist there).
- Runs in passthrough mode by default — Claude Code executes its own tools on the machine it runs on; Meridian just forwards tool_use blocks.

### Adapter instances

Run several configurations of the same adapter side by side — e.g. a passthrough variant with thinking enabled and one without, or a dedicated config for a specific client. Define instances in `~/.config/meridian/adapter-instances.json` (or the `MERIDIAN_ADAPTER_INSTANCES` env var as a JSON string):

```jsonc
{
  "oc-thinky":  { "base": "opencode", "features": { "thinking": "enabled" } },
  "lite-plain": { "base": "passthrough", "passthrough": true,
                  "match": { "userAgentPrefix": "litellm/" } },
  "team-webui": { "base": "opencode", "features": { "codeSystemPrompt": false },
                  "match": { "header": { "x-team": "alpha" } } }
}
```

- **`base`** — which built-in adapter provides the behavior (tool handling, session tracking, transforms). Existing plugins and transforms scoped to the base adapter apply to its instances automatically.
- **`features`** — per-instance overrides of the [SDK feature toggles](configuration.md#sdk-feature-toggles-experimental) (thinking, system prompts, memory, ...) layered over the base's settings. Same keys as the settings UI.
- **`passthrough`** — per-instance passthrough mode, overriding the adapter default and `MERIDIAN_PASSTHROUGH`.
- **`match`** — optional automatic selection: exact header values and/or a User-Agent prefix. Match rules outrank built-in User-Agent detection (that's their purpose). Without `match`, select the instance per request with `x-meridian-agent: <instance-name>`.

Built-in adapter names are reserved and can't be shadowed. With no instances configured, detection is exactly the built-in chain. Config file changes apply within ~5s, no restart needed.

### Claude Design MCP

Meridian proxies the Claude Design MCP API (`api.anthropic.com/v1/design/*`), so MCP clients can use Claude Design tools through your local endpoint.

**1. Add the MCP server.** For Claude Code:

```bash
claude mcp add -s user --transport http claude-design http://127.0.0.1:3456/v1/design/mcp
```

Any other MCP client: point it at `http://127.0.0.1:3456/v1/design/mcp` (streamable HTTP).

**2. Grant Claude Design consent (one time, per Anthropic account).** Tool calls return a `needs_consent` error until you enable it: open [claude.ai/design/settings](https://claude.ai/design/settings), find **"Claude product access"** ("Let other Claude products, like Claude Code, read and edit your Design projects"), and switch it **On**. This is a setting on the Anthropic account itself — with multiple Meridian profiles, the account behind the *profile handling the request* is the one that needs the toggle.

That's it — your existing Claude Max login covers auth (`initialize`, `tools/list`, and tool calls are all verified working with a plain Max token). Verify with a quick handshake:

```bash
curl -s -X POST http://127.0.0.1:3456/v1/design/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

**Multiple profiles:** design requests use the active profile by default. To pin design traffic to a specific profile regardless of which is active, register the server with a profile header:

```bash
claude mcp add -s user --transport http --header "x-meridian-profile: personal" \
  claude-design http://127.0.0.1:3456/v1/design/mcp
```

**Fallback OAuth flow:** if the upstream ever rejects your token with an `auth_error` (scope enforcement has varied over time), `/design-login` obtains a dedicated token with the `user:design:read`/`user:design:write` scopes:

```bash
curl http://127.0.0.1:3456/design-login          # returns an authorize URL — open it in your browser
curl -X POST http://127.0.0.1:3456/design-login \
  -H 'content-type: application/json' \
  -d '{"code": "<code-from-browser>"}'           # paste the code you were shown
```

The design token is stored at `~/.config/meridian/design-token.json` (mode `0600`, global across profiles) and refreshed automatically when it expires.

> Contributed by [@sittitep](https://github.com/sittitep) (#543).

### Any Anthropic-compatible tool

```bash
export ANTHROPIC_API_KEY=x
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
```
### Hermes Agent

[Hermes](https://hermes-agent.nousresearch.com) profiles route through
Meridian via their model config — no adapter-specific setup on the Meridian
side:

```yaml
# $HERMES_HOME/config.yaml
model:
  provider: anthropic
  base_url: http://127.0.0.1:3456
```

Any `ANTHROPIC_API_KEY` value satisfies Hermes' credential check; Meridian
handles the real authentication. Note that Hermes profiles have isolated
`HERMES_HOME` directories: repeat the config for each profile.

**Strongly recommended:** install the
[`meridian-affinity` Hermes plugin](../examples/hermes-plugin/) — without
it, every agentic turn ending in a `tool_result` is treated as an
independent session and prompt-cache reuse is lost (each turn re-bills
cache creation for the whole history). With it, sessions are resumed and
cache hit rates reach ~100% on long runs. The plugin also wires
`x-request-id`, `x-meridian-source` and `x-opencode-effort` for per-task
cost control and telemetry correlation.

**Which adapter Hermes lands on.** Hermes sends `User-Agent: python-httpx`,
which matches no detection heuristic, so plain Hermes traffic falls through
to whatever `MERIDIAN_DEFAULT_AGENT` names — `opencode` only when that
variable is unset. Installing `meridian-affinity` changes this: the
`x-session-affinity` header it injects resolves to the **`opencode`**
adapter regardless of the default.

That is usually what you want — the plugin's headers are the ones the
OpenCode adapter reads — but it is a real switch, not a no-op. If you run
`MERIDIAN_DEFAULT_AGENT=pi` (or anything else) and rely on that adapter's
transforms for Hermes, set the adapter explicitly per request rather than
letting the header decide.
