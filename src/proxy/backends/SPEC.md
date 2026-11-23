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

## Completed-history recovery

This deliberately relaxes #1074's rule that a changed delivered history/batch
must keep the pending process and return 409. Production Claude Code stream loss
left complete client histories stuck behind that rule. Owner-approved 2026-11-22
(#1561), on the condition that Meridian never re-executes a client tool. A validated complete
history with known completed results is authoritative for the narrow joined
replay below; active or uncertain client actions retain their existing guards.

With native capabilities disabled, a complete validated tool history that changes
one idle pending owner's delivered prefix or batch retires and joins that owner
before cold replay. Model, session and execution controls must still match.
Mixed owners and active HTTP responses remain conflicts. Replay sends the supplied
results as history; it never invokes the old pending client calls.

Exact completed-result continuations interrupted by cancellation or retryable
failure (401, 408, 429, 499 or 5xx) can retry only after the failed process joins
and before another client tool was emitted. Other deterministic failures retain
the consumed-result conflict. Failure to record the recovery fingerprint logs an
error but cannot replace the original response status or Retry-After. Successful
result duplicate guards and response snapshots remain in force; native-capability work is never made replayable this way.

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

## Turn deadlines

`turnTimeoutMs` bounds each model and preprocessing phase independently. Delivering
client tools pauses the phase clock; accepting a complete result batch starts a
new phase with the full allowance. This lets long client-tool loops continue when
each model phase is healthy, even if their combined model time exceeds one budget.
`pendingToolTimeoutMs` independently limits each client wait. `turnMaxDurationMs`
is an absolute per-turn cap including all phases and waits (default two hours),
also passed as the CLI print timeout. It is not reset on tool-result acceptance.
Successful completion clears both clocks; a warm user turn starts fresh clocks.
Timer replacement clears the prior handle first, and the phase deadline is
validated before the absolute cap so invalid phase settings name the right option.

## Client-tool allowance

The live conversation's cumulative client-tool count and MCP request replay
ledger are bounded by `MERIDIAN_AGY_MAX_TOOL_CALLS` (default 256, integer
1–65536, captured at runtime construction). Invalid explicit values fail
construction. Sequential and parallel calls share this allowance; an excessive
batch fails before any call is dispatched, and duplicate MCP request IDs replay
their original result without spending another call. The independent limits of
32 outstanding client calls and 16 calls per parallel batch remain unchanged.
This is Meridian's bridge allowance; native CLI/provider limits are unchanged;
raising it retains more conversation/replay data until that run is retired.
The existing completed-conversation reuse cutoff (128 client calls) is unchanged.
A restored live process starts a fresh counter; this is not a persistent native
conversation lifetime ledger. Model/turn and pending-tool deadlines remain
independent of the allowance.

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
