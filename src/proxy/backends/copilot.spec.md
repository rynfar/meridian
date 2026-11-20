---
id: copilot-backend
type: module-design
status: active
title: Copilot backend (preview)
parent: architecture
references: [api-contract]
depends-on: [telemetry-ui]
---

## Responsibility

Serve OpenAI Chat Completions and Anthropic Messages from the models on the
operator's GitHub Copilot subscription, through the official
`@microsoft/copilot-sdk` (preview): SDK loading, one Copilot session per
conversation, media attachments, the hand-off of every tool call to the
client, history replay when a session cannot continue, health, models and
provider status.

Enabled by `MERIDIAN_COPILOT=1` (`ProxyConfig.copilot`), independent of
`backend`, and mounted at `/copilot/*` beside Claude (`claude` or `combined`).
The standalone Antigravity server refuses it rather than ignore it.

Code: `src/proxy/backends/copilot.ts` (runtime and routes),
`copilotProtocol.ts` (pure request validation and continuation planning) and
`copilotSdk.ts` (the typed slice of the SDK and its loader).

## Boundary

- **The SDK is not a dependency.** The operator installs it; it is imported
  only when the backend is enabled (`MERIDIAN_COPILOT_SDK_PATH`, else normal
  resolution). No `package.json`, `bun.lock` or Nix hash change. Its
  per-platform runtime (about 185 MB) would otherwise reach every install, and
  every platform in the Nix tree.
- **Never imports Claude `session/` or cache modules.** Account identity and
  activity are reported separately from Claude's.
- Does not import Hono; it adapts standard `Request`/`Response`. `server.ts`
  owns auth, admission, drain and in-flight counting through the shared
  provider mount.
- Generation runs only through the SDK with the Copilot CLI sign-in
  (`useLoggedInUser`). No token, API key or BYOK provider is passed, and a
  round whose usage names another model or BYOK fails.
- **Client tools run with the client's permissions.** Sessions start in
  `mode: "empty"` with only the client's tools (declaration-only,
  `overridesBuiltInTool`), custom instructions and repository hooks off, and
  every permission request denied. Copilot never executes a tool.
- The SDK runtime is a child process with a private temporary `COPILOT_HOME`
  and no `MERIDIAN_*`, `ANTHROPIC_*` or `CLAUDE_*` environment.
- **Unsupported controls are rejected, not faked:** audio, remote/file-ID
  attachments, `tool_choice` other than `auto`, `parallel_tool_calls: false`,
  unknown options and unsupported `reasoning_effort` values. Base64 images,
  PDFs and text documents in direct user messages are sent as SDK blob
  attachments, bounded to 8 MiB. Tool-result attachments are rejected because
  the pending-tool RPC accepts text results only. `max_tokens` and `temperature`
  are accepted, ignored and labelled as ignored
  in `/health`.

## Continuity

A live session continues natively only while the request extends exactly what
it has seen: same model, effort, system prompt and tool definitions, the same
history prefix, the previous assistant turn, then either the pending tool
results or new user messages. Anything else (mode switch, compaction, edits,
restart, eviction) opens a new session whose first prompt replays the
conversation as text. Sessions are keyed by `x-session-affinity`,
`x-opencode-session` or `x-session-id`, else by a hash of the opening. Tool-less
requests use a session closed after the round. Bounded by
`MERIDIAN_COPILOT_MAX_SESSIONS` (LRU of idle sessions), a round timeout and a
pending-tool timeout.

## Known limitations

- **Preview.** Verified with SDK 2.0.1 (runtime 1.0.114) on macOS arm64 only.
- No Responses API, audio/video, remote/file-ID inputs, structured output or
  forced tool choice.
- Premium-request billing is Copilot's. Meridian neither meters nor caps it;
  it shows only quota windows observed by the SDK and leaves missing data unknown.
- Replay is text, so a replayed session loses native tool-call structure for
  earlier turns and costs a fresh prompt.
