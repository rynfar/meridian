---
id: antigravity-backend
type: module-design
status: active
title: Antigravity backend
parent: architecture
references: [api-contract]
depends-on: [telemetry-ui]
---

## Responsibility

Serve Anthropic Messages, OpenAI Chat Completions and a documented OpenAI
Responses subset through Google's official, signed-in `agy` CLI (preview):
subprocess lifecycle, the loopback MCP tool bridge for client-owned tools,
warm-process reuse and history replay, attachments/media adaptation, bounded
saved-answer and tool-ID recovery, optional private SQLite state, read-only
account/quota probes, provider status, and explicit Pi/OpenCode client setup.

Selected by `backend: "antigravity"` (standalone) or `"combined"` (mounted at
`/antigravity/*` beside Claude, with independent admission, processes, quotas
and shutdown).

Code: `src/proxy/backends/antigravity*.ts`, `providerStatus.ts`, and
`src/proxy/antigravitySetup.ts`. (`backends/chatgpt*.ts` in the same directory
belong to [`chatgpt-backend`](../chatgpt/SPEC.md).)

## Boundary

- Chosen at the public server entrypoint **before** Claude authentication,
  sessions, plugins or background maintenance start; the client-facing
  `AgentAdapter` is not reused as a backend selector.
- **Never imports Claude `session/` or cache modules**; Claude session-cache
  ownership is untouched in combined mode. Account identities and quota
  percentages are never mixed with Claude's.
- Does not import Hono; it adapts standard `Request`/`Response`, and only
  `server.ts` binds the listener. It may use the pure OpenAI translators, `auth`,
  `buildRuntime`, `headerSettings` and shared `telemetry-ui` presentation.
- Generation runs only through the official CLI — no Google API key or model-SDK
  fallback, and private CLI transcripts are never read.
- Client tools execute with the **client's** permissions via
  `MERIDIAN_AGY_ALLOW_TOOL_BRIDGE`; native browser/subagent capabilities need a
  separate explicit operator grant.
- Client setup writes where the client itself reads: Pi's directory is resolved
  by the shared `piAgentDirectory()` (`PI_CODING_AGENT_DIR` with Pi's own `~`
  expansion), the same as `meridian setup --client pi`.
- Persistence (`statePath`) is opt-in and bounded; Antigravity plugins
  (`antigravityPlugins.ts`) are separate from Claude user plugins.

The full runtime, replay, recovery and persistence contract is in
[`architecture`](../../../ARCHITECTURE.md) → *Antigravity runtime and combined
provider service*; public routes and headers are in
[`api-contract`](../../../.agents/references/api-contract.md); feature status in
`docs/antigravity-support.md`.

## Request normalization

Before strict schema validation (`antigravityProtocol.ts`), Anthropic requests
undergo bounded compatibility normalization:
- Mid-conversation and late `role: "system"` messages are rendered in-place as
  `[system]`-tagged `role: "user"` messages, preserving message order,
  top-level `system`, and `contractKey` (so late system steering can warm-reuse
  without replaying old turns). Prompt compaction keeps the latest actual user
  instruction and subsequent tagged steering text intact without protecting whole
  adjacent tool-result messages from compaction. Steering provenance is tracked out-of-band on parsed text blocks; a literal user `[system]` prefix remains ordinary user text. Current instructions and subsequent steering that cannot fit still return 400. Inline placement preserves content order even
  when synthetic `[system]` blocks coalesce into the immediately following `user`
  message to keep `tool_use`/`tool_result` pairing intact.
- Historical `thinking` and `redacted_thinking` blocks are dropped; `assistant`
  messages and historical `user` messages left empty after thinking removal are
  dropped, and a final `user`
  message that is empty after normalization is rejected (400). Trailing system steering may itself form the final user message; coalescing a non-empty system message with an otherwise empty user message is also valid.
- Unknown content blocks (such as `tool_reference`, `server_tool_use`,
  `web_search_tool_result`) are rendered as descriptive text while malformed
  known blocks remain strictly rejected. Each complete description is capped at 20,000 UTF-16 code units plus a truncation marker without splitting a surrogate pair. Unrepresentably deep unknown data returns 400.
- Hosted server tools without `input_schema` (`web_search_*`, `web_fetch_*`,
  `code_execution_*`) with valid ASCII names (1-64 characters) and string descriptions are dropped; descriptions need no additional length bound because they are not forwarded. A valid `tool_choice` targeting only a dropped tool becomes `auto`, retaining `disable_parallel_tool_use`; malformed choices remain rejected. Dropped tools are exposed via the
  `x-meridian-dropped-tools` response header (first 16 names, comma-separated),
  with the number of distinct dropped names in `x-meridian-dropped-tools-count`, and logged once
  per request; client-executed Anthropic tools (`bash_*`, `text_editor_*`,
  `computer_*`, `memory_*`) without `input_schema` and malformed tool
  definitions remain rejected (400).
- Numeric `temperature`, `top_p`, and `top_k` are accepted and ignored (not
  forwarded to `agy`).

## Known limitations

- **Platform verification.** Authenticated acceptance exists on macOS arm64
  (agy 1.2.7, Pi 0.72.1, OpenCode V1 1.18.31) and, for the core, Pi-client and
  account-settings gates, on Linux x64 (agy 1.5.5, Pi 1.5.2, 2026-11-12; agy
  1.5.13, Pi 1.3.0, 2026-11-22); the compatibility gate now pins agy 1.5.13, so
  the frozen macOS gates pinning the 1.2.7 binary hash await a 1.5.13 re-run on
  that platform. Windows remains
  unverified.
- **Active-task reattachment** after a restart and **automatic reconciliation of
  uncertain tool outcomes** are unfinished; an unclean restart returns 409 with
  recovery guidance instead.
- **Background jobs are not restart-resumable.**
- **CLI-exposed controls only.** No exact output-token caps, numeric thinking
  budgets (opt-in approximate mapping to effort variants only), sampling
  controls (numeric `temperature`/`top_p`/`top_k` are accepted and ignored) or
  native media APIs; documents/speech/video go through local conversion.
- Some provider-specific plugins, hosted-tool/file contracts and client versions
  still need adapters and acceptance tests.
