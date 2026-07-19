# Agent Setup

[← Back to README](../README.md)

Per-agent configuration for every tested client. All agents share the same basics — point the tool at `http://127.0.0.1:3456` with any API key value — but several have their own config formats or adapters, documented here.

### OpenCode

**Step 1: Run `meridian setup` (required, one time)**

```bash
meridian setup
```

This adds the Meridian plugin to your OpenCode global config (`~/.config/opencode/opencode.json`). The plugin enables:

- **Session tracking** — reliable conversation continuity across requests
- **Safe model defaults** — Opus uses 1M context (included with Max subscription); Sonnet uses 200k to avoid Extra Usage charges ([details](configuration.md#configuration))
- **Subagent model selection** — subagents automatically use `sonnet`/`opus` (200k), preserving rate-limit budget

If the plugin is missing, Meridian warns at startup and reports `"plugin": "not-configured"` in the health endpoint.

**Step 2: Start**

```bash
ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

Or set these in your shell profile so they're always active:

```bash
export ANTHROPIC_API_KEY=x
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
```

#### oh-my-opencagent (OMO)

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
        { "id": "claude-fable-5",    "name": "Claude Fable 5 (1M)",     "context_window": 1000000, "default_max_tokens": 32768, "can_reason": true, "supports_attachments": true },
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
    { "model": "claude-fable-5",          "name": "Fable 5 (Meridian)",    "provider": "anthropic", "baseUrl": "http://127.0.0.1:3456", "apiKey": "x" },
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
