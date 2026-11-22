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

## Input and context budgets

Keep the existing byte guard and apply a separate estimated token guard to
submitted inputs. The count endpoint and the guard use a conservative estimate
that accounts for dense Unicode text. Neither supplies the provider tokenizer.
This estimate can reject dense Unicode inputs that fit the former byte-only
guard; the 52,000 step budget is a safety margin, not a measured cutoff.
A separate estimated context budget reserves output space and uses submitted
inputs, observed output and reported input usage. Reused processes take only
new messages or results. When a new user continuation would exceed the budget,
retire the cached process and start a bounded fresh replay. Do not partially
resolve an oversized client tool batch.

Cold replay defaults to one bounded input. It retains the latest user request
and intact retained tool pairs, using middle omission and, when necessary,
dropping older completed units. The operator can opt into multi-step history
loading. This experimental path submits complete historical units, denies
actions during priming, requires a new indexed input marker for each step and
does not expose priming text or usage as the final answer. Structured output
and native capability grants use the single-input policy. Priming failures do
not retry automatically; a normally completed priming step need not emit a
visible acknowledgement. When the newest unit is a tool batch, its final
input also carries the latest typed user goal in its own complete unit.

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
  controls or native media APIs; documents/speech/video go through local
  conversion.
- Some provider-specific plugins, hosted-tool/file contracts and client versions
  still need adapters and acceptance tests.
