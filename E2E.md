# End-to-End Testing

Live tests against the real proxy + Claude Max SDK. These verify the full request cycle that unit tests (mocked SDK) cannot cover.

**Prerequisites:** Claude Max subscription, `claude auth status` shows `loggedIn: true`, `opencode` installed.

> **Droid tests (D1–D10)** additionally require `droid` installed (`droid --version` ≥ 0.89.0) and a Factory AI account for BYOK configuration. Tests D1–D10 cover internal mode (the default). Passthrough mode for Droid is opt-in via `MERIDIAN_PASSTHROUGH=1` and requires `droid` ≥ 0.109 — see "Droid passthrough mode" below.

## Quick Start

```bash
# 1. Build and start the proxy
npm run build
CLAUDE_PROXY_PORT=3456 bun run ./bin/cli.ts &

# 2. Wait for ready
curl -s http://127.0.0.1:3456/health | jq .status   # → "healthy"

# 3. Run tests (pick a section below)
# 4. Kill proxy when done
kill $(lsof -ti :3456)
```

### Error telemetry and SDK billing refusals (#836 / #829)

```bash
bun scripts/e2e-error-telemetry.mjs
```

The real CLI and SDK call a local Anthropic API fixture that refuses billing.
Its normalized `Credit balance is too low` error must classify as a billing
refusal. Pinned requests fail with the correct account/model telemetry in both
response modes. Unpinned priority requests must fail over to real Claude Max,
return a visible recovery receipt, and record the refusing and serving accounts
under the same request id, in both modes. No SDK query is mocked.

Each case uses a fresh proxy instance so a preceding case's expected account
cooldown cannot skip the refusal being tested. Configuration, session metadata
and working directory are disposable; Claude Max retains its normal authentication.
The local API uses a dummy key. `E2E_MERIDIAN_ROOT` selects source from another
checkout for before/after comparisons; `--failover-only` selects one failure case.
This verifies actual SDK refusal handling and live recovery, not two separate
paid accounts. Run the full priority-routing suite and all four E41 modes to
retain the barrier against failover after real content, tools or structured output.

### Consecutive idle stalls (#868)

```bash
npm run build
E2E_OPENCODE_BIN=/absolute/path/to/opencode bun scripts/e2e-idle-stall-clients.mjs --v1
E2E_OPENCODE_BIN=/absolute/path/to/opencode2 bun scripts/e2e-idle-stall-clients.mjs
```

Use V1 1.18.11 or V2 beta18314/beta18866. The gate isolates client HOME,
configuration and working directory while retaining the proxy's Claude Max
authentication. It starts actual SDK queries, waits for their startup events,
then withholds iterator output to exercise the real eight-second idle guard.
This is explicit output-stall fault injection, not a naturally reproduced
provider outage. Each timed-out query must close.

Require three identical stalled SDK attempts. V2 beta18866 must stop on the third terminal
SSE error; V1 must receive HTTP400 on its fourth request without another SDK
query. V2 beta18314 already stops at the first upstream timeout; its separate
compatibility control asserts that behavior, not the three-attempt ceiling.
Remove the fault and send a changed prompt in the same client session:
the real model must return the recovery receipt. An optional E2E_MERIDIAN_ROOT
selects a separately built checkout for before/after comparisons.

The terminal pause is one configured idle window, with a 60-second minimum.
Rejected requests do not extend it; changed requests and completed turns reset
the streak. Pure tests cover expiry without waiting, and HTTP integration tests
cover both response modes, changed models, recovery and unrelated sessions.
Run all four live E41 modes alongside this gate to check ordinary tool-result
continuation and cache reuse.

### Capped passthrough turns (#926)

```bash
for cap_case in partial empty thinking unhandled retry retry-resume pinned; do
  bun scripts/e2e-capped-turns.mjs "--case=$cap_case" || exit 1
  bun scripts/e2e-capped-turns.mjs "--case=$cap_case" --stream || exit 1
done
```

These controls use the real SDK and CLI against a local Anthropic API fixture.
An unknown synthetic tool makes the CLI return an actual `error_max_turns`
without executing a tool. Explicit withholding of SDK events reproduces partial
or silent delivery; this is fault injection, not a naturally reproduced live-model
incident. Partial prose must truncate; empty output, thinking alone and unhandled
calls must fail. A silent turn may retry once, except with an operator-pinned cap.

Fresh and resumed retries must use distinct targets, retire the failed target,
publish the successful target, and deliver exactly one tool call. Its real client
result must reach a checkpoint follow-up. Supported SDK `getSessionMessages`
inspection verifies source immutability and absence of the refused attempt in the
successful history. The fixture identifies each CLI query separately because a
hidden drain can overlap a follow-up; auxiliary CLI requests are excluded.
Run all four live Claude Max E41 modes alongside these controls, plus the #925
`--fixture --stream --drop-stop` control when changing stream recovery.

### Passthrough argument repair (#925)

```bash
bun scripts/e2e-tool-input-repair.mjs --fixture
bun scripts/e2e-tool-input-repair.mjs --fixture --stream
bun scripts/e2e-tool-input-repair.mjs --fixture --stream --drop-stop
bun scripts/e2e-tool-input-repair.mjs
bun scripts/e2e-tool-input-repair.mjs --stream
```

The deterministic fixture runs the real CLI and SDK against a local Anthropic
API response containing stringified tool arguments. It verifies repaired client
arguments in both modes, a real client tool result reaching the resumed CLI,
checkpoint forking, the exact follow-up receipt, and unchanged source history
through supported SDK inspection. It uses a dummy local API key and does not
contact a model service. The two runs without `--fixture` use Claude Max and
validate compatibility with real model output. Their `repairExercised` flag
distinguishes actual string repair from already-typed model calls.
The `--drop-stop` fault injection withholds one SDK tool-block stop while the
real CLI and hook continue, proving recovery flushes buffered arguments before
closing the block and preserves the subsequent checkpoint continuation.

Required/optional advertised MCP schemas and malformed numeric inputs have
automated protocol/unit coverage. Streamed arguments with repairable declared
types are buffered until their block completes; text and string-only tool
arguments retain normal streaming. Run all four E41 modes after changes here.

### Profile-switch retirement admission (#923)

```bash
bun scripts/e2e-retirement-admission.mjs
bun scripts/e2e-retirement-admission.mjs --stream
```

With a two-slot pending budget and a long retirement quarantine, seed two real
sessions, switch profiles through HTTP, sweep GC and require a fresh request and
its follow-up to answer correctly. Supported SDK history inspection verifies both
old histories remain unchanged and the new mapping contains the expected token.
Both profile aliases use the existing authentication; this does not validate two
distinct billing accounts. Meridian state and SDK working directory are isolated.
The one-slot configuration retains its existing behavior; reserving its only slot
would disable passive cleanup. At limit two, passive retirement can pause while a
publication is in flight, then resume after it completes. Capacity and cleanup
progress are covered by the lifecycle tests.

### Fresh replay with completed tool calls (#888 / #858)

```bash
bun scripts/e2e-replay-tool-history.mjs
bun scripts/e2e-replay-tool-history.mjs --stream
bun scripts/e2e-replay-tool-history.mjs --image
bun scripts/e2e-replay-tool-history.mjs --image --stream
```

This isolated real-SDK gate forces each round through a fresh replay. It expects
exactly one price lookup, an answer containing the exact returned price and
unique confirmation code, and (with `--image`) correct identification of the
image color. Supported `getSessionMessages` inspection verifies that completed
call identities and arguments, result payloads, and images survive, and no
unpaired native `tool_result` blocks enter a fresh SDK session. Fresh SDK queries
accept user input only, so completed assistant calls are explicit replay context;
native result wrappers remain reserved for real SDK tool checkpoints. A fresh
multimodal replay is delivered in one SDK input so generation cannot begin
before the final result arrives.

Run these four modes with both the default Haiku and `E2E_MODEL=sonnet`.
Also run `E2E_MODEL=sonnet bun scripts/e2e-replay-tool-history.mjs --image --no-preset`
to verify the Claude Code preset remains optional. Meridian
state is isolated in a temporary directory while the existing SDK auth is kept.
Also run all four E41 modes to validate normal checkpoint resumes after changes.

### Pi concurrent callers (#870 / #922)

```bash
bun scripts/e2e-pi-concurrent-replay.mjs
bun scripts/e2e-pi-concurrent-replay.mjs --stream
# Install Oh My Pi in a disposable directory; point at the package directory.
E2E_OMP_PACKAGE=/path/to/node_modules/@oh-my-pi/pi-coding-agent bun scripts/e2e-omp-concurrent-client.mjs
E2E_OMP_PACKAGE=/path/to/node_modules/@oh-my-pi/pi-coding-agent bun scripts/e2e-omp-concurrent-client.mjs --main-first
```

The first fixture controls queue admission while using real SDK responses. Both
main-first and side-first orders must answer from their own request bodies,
preserve source histories through the supported SDK API, and keep the next main
turn correct. The last completed branch owns the mapping; following a side call
can require another fresh replay.

The second fixture uses Oh My Pi's actual session and title-generation APIs
(validated with 18.0.3), provider serialization and read/write tools. It forces
the main/title overlap using their real shared session metadata, then verifies
that the title parses and the client copies a random fixture value through its
tool loop. It does not mock client or model responses or exercise the terminal
UI. Both fixtures isolate Meridian state and work only in temporary directories.

## Test Index

| ID | Section | What It Proves | Verified |
|----|---------|----------------|----------|
| E1 | [Basic Request/Response](#e1-basic-requestresponse) | Proxy starts, routes to SDK, returns valid Anthropic response | 2026-03-24 |
| E2 | [Streaming SSE](#e2-streaming-sse) | SSE event format correct, events arrive in order | 2026-03-24 |
| E3 | [Tool Use Loop](#e3-tool-use-loop) | MCP tools (read/write/bash) execute through SDK | 2026-03-24 |
| E4 | [Session Continuation](#e4-session-continuation) | Same session header → `lineage=continuation`, SDK session reused | 2026-03-24 |
| E5 | [Undo with Rollback](#e5-undo-with-rollback) | Shorter/diverged suffix → `lineage=undo`, rollback UUID emitted | 2026-03-24 |
| E6 | [Compaction](#e6-compaction) | Summarized prefix + preserved suffix → `lineage=compaction` | 2026-03-24 |
| E7 | [Diverged Detection](#e7-diverged-detection) | Completely unrelated messages → `lineage=new`, fresh session | 2026-03-24 |
| E8 | [Cross-Proxy Resume](#e8-cross-proxy-resume) | Kill proxy → restart → session resumes from file store | 2026-03-24 |
| E9 | [Fingerprint Fallback](#e9-fingerprint-fallback) | No session header → fingerprint-based session lookup works | 2026-03-24 |
| E10 | [Coding Task (opencode)](#e10-coding-task-via-opencode) | Full round-trip: opencode → proxy → SDK → tool use → file modified | 2026-03-24 |
| E11 | [Telemetry](#e11-telemetry) | Dashboard HTML, `/requests`, `/summary`, `/logs` return data | 2026-03-24 |
| E12 | [Health Check](#e12-health-check) | `/health` returns auth status and mode | 2026-03-24 |
| E13 | [Concurrent Requests](#e13-concurrent-requests) | Parallel requests don't deadlock; active count increments | 2026-03-24 |
| E14 | [Model Routing](#e14-model-routing) | haiku/sonnet/opus model strings map correctly in proxy logs | 2026-03-24 |
| E15 | [Non-Streaming](#e15-non-streaming) | `stream:false` → JSON response with Content-Type, session header | 2026-03-24 |
| E16 | [Error Handling](#e16-error-handling) | Malformed JSON, missing fields, bad endpoints → structured errors | 2026-03-24 |
| E17 | [Passthrough Mode](#e17-passthrough-mode) | `CLAUDE_PROXY_PASSTHROUGH=1` → tool_use forwarded, not executed | 2026-03-24 |
| E18 | [Multimodal Content](#e18-multimodal-content) | Image blocks preserved, structured message path used | 2026-03-24 |
| E19 | [Subagent / Task Tool](#e19-subagent--task-tool) | Task tool agent definitions extracted, request processes correctly | 2026-03-24 |
| E20 | [Env Stripping](#e20-env-stripping) | ANTHROPIC_* vars don't leak to SDK subprocess | 2026-03-24 |
| E21 | [Session Store Pruning](#e21-session-store-pruning) | File store respects count cap, oldest entries evicted | 2026-03-24 |
| D1 | [Droid: Basic Response](#d1-droid-basic-response) | Proxy accepts Droid User-Agent, routes via droid adapter, returns valid response | 2026-03-29 |
| D2 | [Droid: MCP Server Name](#d2-droid-mcp-server-name) | Internal mode: tools use `mcp__droid__` prefix, not `mcp__opencode__` | 2026-03-29 |
| D3 | [Droid: OpenCode Backward Compat](#d3-droid-opencode-backward-compat) | Requests without Droid UA still use opencode adapter | 2026-03-29 |
| D4 | [Droid: CWD from system-reminder](#d4-droid-cwd-from-system-reminder) | Working directory extracted from `<system-reminder>` block | 2026-03-29 |
| D5 | [Droid: Fingerprint Session Resume](#d5-droid-fingerprint-session-resume) | Session continues via fingerprint (no session header needed) | 2026-03-29 |
| D6 | [Droid: Real Binary Basic](#d6-droid-real-binary-basic) | Live `droid exec` → proxy → Claude Max returns correct response | 2026-03-29 |
| D7 | [Droid: Real Binary Tool Use](#d7-droid-real-binary-tool-use) | Internal mode: live `droid exec` reads file via `mcp__droid__read` | 2026-03-29 |
| D8 | [Droid: exec Session Isolation](#d8-droid-exec-session-isolation) | Each `droid exec` call is a fresh session (expected — no history passed) | 2026-03-29 |
| D9 | [Droid: Streaming SSE](#d9-droid-streaming-sse) | SSE stream correct format with Droid User-Agent | 2026-03-29 |
| D10 | [Droid: OpenCode Session Unaffected](#d10-droid-opencode-session-unaffected) | OpenCode header-based session tracking still works alongside Droid | 2026-03-29 |
| C1 | [Crush: Basic Response](#c1-crush-basic-response) | Proxy accepts Charm-Crush/ User-Agent, routes via crush adapter, returns valid response | 2026-03-29 |
| C2 | [Crush: Session Continuation](#c2-crush-session-continuation) | `crush run --continue` resumes via fingerprint; `lineage=continuation` in proxy log | 2026-03-29 |
| C3 | [Crush: Tool Use (Read)](#c3-crush-tool-use-read) | `ls`/`view`/`grep` tool round-trip: Crush executes, sends tool_result, proxy resumes | 2026-03-29 |
| C4 | [Crush: Model Routing](#c4-crush-model-routing) | sonnet-4-6→sonnet[1m], opus-4-6→opus[1m], haiku→haiku for Max users | 2026-03-29 |
| C5 | [Crush: Backward Compat](#c5-crush-backward-compat) | OpenCode and Droid sessions unaffected when Crush requests coexist | 2026-03-29 |
| CL1 | [Cline: Basic Response](#cl1-cline-basic-response) | Proxy accepts Cline requests via anthropicBaseUrl, returns valid response | 2026-03-29 |
| CL2 | [Cline: File Read](#cl2-cline-file-read) | Cline reads a file via tool_use/tool_result passthrough loop | 2026-03-29 |
| CL3 | [Cline: File Write](#cl3-cline-file-write) | Cline writes a file to disk in --yolo mode | 2026-03-29 |
| CL4 | [Cline: Bash Execution](#cl4-cline-bash-execution) | Cline runs bash commands through passthrough | 2026-03-29 |
| CL5 | [Cline: File Edit](#cl5-cline-file-edit) | Cline edits an existing file (bug fix) | 2026-03-29 |
| CL6 | [Cline: Session Continuation](#cl6-cline-session-continuation) | `-T taskId` resumes session; `lineage=continuation` in proxy log | 2026-03-29 |
| CL7 | [Cline: Model Routing](#cl7-cline-model-routing) | sonnet-4-6→sonnet[1m], opus-4-6→opus[1m], haiku→haiku | 2026-03-29 |
| CL8 | [Cline: Multi-Agent Coexistence](#cl8-cline-multi-agent-coexistence) | Cline + Crush + OpenCode on same port simultaneously | 2026-03-29 |
| FC1 | [File Changes: Write (non-stream)](#fc1-file-changes-write-non-stream) | PostToolUse hook tracks write, appends "Files changed" to non-stream response | 2026-03-30 |
| FC2 | [File Changes: Write (stream)](#fc2-file-changes-write-stream) | PostToolUse hook tracks write, emits file change text block in SSE stream | 2026-03-30 |
| FC3 | [File Changes: Edit](#fc3-file-changes-edit) | Edit operations tracked as "edited" in summary | 2026-03-30 |
| FC4 | [File Changes: Read-only (no summary)](#fc4-file-changes-read-only-no-summary) | Read-only operations produce no "Files changed" section | 2026-03-30 |
| FC5 | [File Changes: Multiple ops](#fc5-file-changes-multiple-ops) | Multiple writes + edits listed in a single summary | 2026-03-30 |
| FC6 | [File Changes: Multiple ops (stream)](#fc6-file-changes-multiple-ops-stream) | Multiple file changes emitted as a text block in SSE stream | 2026-03-30 |
| E22 | [OAuth Token Refresh](#e22-oauth-token-refresh) | Expired access token auto-refreshed inline; request succeeds without manual `claude login` | 2026-04-02 |
| E23 | [Subagent Model Selection](#e23-subagent-model-selection) | `x-opencode-agent-mode: subagent` header selects base model; primary gets 1M; proxy log shows `agent=subagent` | 2026-04-02 |
| E24 | [Default Non-Streaming](#e24-default-non-streaming) | Omitting `stream` field returns JSON (not SSE), matching Anthropic API spec | - |
| E25 | [OpenAI Compat: Non-Streaming](#e25-openai-compat-non-streaming) | `/v1/chat/completions` returns valid OpenAI completion shape | - |
| E26 | [OpenAI Compat: Streaming](#e26-openai-compat-streaming) | `/v1/chat/completions` with `stream: true` returns OpenAI SSE chunks | - |
| E27 | [OpenAI Compat: Models](#e27-openai-compat-models) | `GET /v1/models` returns Claude model list in OpenAI format | - |
| E28 | [SDK Param Passthrough](#e28-sdk-param-passthrough) | Live proxy accepts effort/thinking/task_budget/beta fields without breaking responses | 2026-04-03 |
| E29 | [Context Usage Endpoint](#e29-context-usage-endpoint) | `/v1/sessions/:claudeSessionId/context-usage` returns live token usage for a completed request | 2026-04-03 |
| E30 | [Context Usage via Fingerprint + Restart](#e30-context-usage-via-fingerprint--restart) | Context usage lookup works for headerless sessions and survives proxy restart via shared store | 2026-04-03 |
| E32 | [Tool-use leak (#416) — opencode + opus-4-7](#e32-tool-use-leak-416--opencode--opus-4-7) | Multi-turn opencode rehydration with prior tool_use blocks does not cause opus-4-7 to emit `[Tool Use:` / `H:` / `Human:` text in its response | 2026-04-26 |
| E33 | [OpenAI Compat: system prompt, no preset](#e33-openai-compat-system-prompt-no-preset) | `/v1/chat/completions` honours the client's system prompt without injecting the claude_code preset (openai adapter default) | 2026-06-15 |
| E34 | [Streaming parallel tool calls (#552)](#e34-streaming-parallel-tool-calls-552) | **Automated**: `bun scripts/e2e-stream-parallel.mjs` — real CLI, SSE mode: parallel tool calls stream intact (no dangling `{}` blocks), denies held past generation, fast follow-up resumes. **Run before any release touching the passthrough tool loop** — mocked suites cannot catch CLI dispatch-ordering bugs (two shipped regressions proved it) | 2026-07-15 |
| E35 | [SDK boundary assumptions (#694/#708/#710)](#e35-sdk-boundary-assumptions-694708710) | **Automated**: `bun scripts/e2e-sdk-boundary.mjs` — real SDK: rate-limit reset units land in a sane window, every live content-block type is classified for hashing, resume survives a client dropping thinking blocks, and reports whether the gitStatus block still misstates its provenance. **Run after any `@anthropic-ai/claude-agent-sdk` bump** and before releases touching lineage, rate limits, or the system prompt | 2026-07-29 |
| E36 | [Client detection after an upgrade (#733)](#e36-client-detection-after-an-upgrade-733) | **Automated**: `bun scripts/e2e-client-detection.mjs` — drives each installed client against a local stub, captures its real headers, and asserts the adapter Meridian resolves. **Run after upgrading any client**; costs no tokens | 2026-07-31 |
| E37 | [WebFetch preflight scope (#748)](#e37-webfetch-preflight-scope-748) | **Automated**: `bun scripts/e2e-webfetch-preflight.mjs` — stubbed `claude` + isolated HOME: the toggle reaches the right adapter's `--settings`, and only `cherry` can actually run the built-in WebFetch, so the documented scope is asserted rather than assumed. **Run before releases touching sdkFeatures, query settings, or tool config**; costs no tokens | 2026-08-03 |
| E38 | [Silent turns (#768)](#e38-silent-turns-768) | **Automated**: `bun scripts/e2e-silent-turn.mjs` — real CLI, SSE mode. Asserts four things per attempt: the client got text or a tool call; recovered content sits BEFORE the terminal `message_delta` (content behind it is dropped by a correct client); exactly one `message_delta` per message; and a third turn after a recovery still resumes. Attribution is read from `/telemetry/logs`, not stdout. Pair `MERIDIAN_DEBUG_FORCE_SILENT_TURN=1` against `MERIDIAN_SILENT_TURN_RECOVERY=0` for the before/after. **Run before any release touching the passthrough tool loop, prompt assembly, or session resume** | 2026-08-11 |
| E39 | [OpenCode internal-agent session key (#845)](#e39-opencode-internal-agent-session-key-845) | **Manual**, real OpenCode: its `title` agent runs under the USER'S session id, so the user's first turn used to queue behind it and then get HTTP 400 `session_turn_conflict`. Asserts the first turn succeeds, waits ~0ms on the session lease, and every later request is `lineage=continuation`. **Run after any OpenCode upgrade and before releases touching session keys or the turn coordinator** | 2026-08-19 |
| E40 | [Passthrough digest-turn cap](#e40-passthrough-digest-turn-cap) | **Automated**: `bun scripts/e2e-digest-turn-cap.mjs` — real SDK. Asserts the capped tool turn generates no digest text, costs materially less than uncapped on an identical prompt, still RESUMES at its captured checkpoint, leaves text-only turns returning `success`, and does not truncate parallel tool calls. **Run before any release touching the passthrough tool loop, `maxTurns`, or the early-stop checkpoint** | 2026-08-20 |
| E41 | [Passthrough multi-turn: one call, one answer](#e41-passthrough-multi-turn-one-call-one-answer) | **Automated**: `bun scripts/e2e-passthrough-turns.mjs [--stream]` — real proxy + SDK + Claude Max. Chain and `PROBE_PARALLEL=1` modes assert exact tool-call batching, a distinct durable fork per result round, one real answer per delivered call in the active transcript, and full prompt-cache continuity. **Run all four chain/parallel × stream/non-stream combinations before releases touching passthrough resume or the deny hook** | 2026-08-26 |
| E42 | [OpenCode V2 beta compatibility](#e42-opencode-v2-beta-compatibility) | **Automated**, exact betas `18314` and `18866`: run `e2e-opencode-v2-package.mjs --live --extended` with each pinned binary. Covers hidden title/summary isolation, process restart, passthrough tools, undo/fork/compaction and overlapping general children. Also test source and packed npm artifacts. **Run after any V2 plugin/API change; another beta is not a pass** | 2026-08-27 |
| E43 | [Passthrough tools in a namespaced client](#e43-passthrough-tools-in-a-namespaced-client) | **Automated**: `bun scripts/e2e-passthrough-namespaced-tools.mjs [--stream]` — real proxy + SDK. A client tool declared `mcp__oc__read` collides with the namespace Meridian nests client tools under; asserts the call is still dispatched and captured, delivered under the name the client declared, and answered from the client's real result, with an ordinary and a foreign-namespace control alongside. **Run before any release touching passthrough tool registration, the deny hook, or tool-name delivery** | 2026-09-08 |
| E44 | [Tier refusal failover](#e44-tier-refusal-failover) | **Automated**: `bun scripts/e2e-tier-refusal-failover.mjs [--stream]` — local refusal fixture, **real Claude Max fallback**. Asserts the credits-era per-tier banner is recorded 429 on the refusing profile and that a healthy profile actually answers. Catches what unit tests cannot: the shape that arrives carries the upstream status. **Run before releases touching error classification or priority failover** | 2026-09-08 |
| E45 | [Codex auto-defer](#e45-codex-auto-defer) | **Automated**: `bun scripts/e2e-codex-auto-defer.mjs` — real proxy + SDK, 40 Codex-shaped tools. Asserts a Codex request reports no deferral and that `exec_command` is loaded rather than found via ToolSearch. The codex transform inherited OpenCode's core tool names, which match nothing Codex sends, so every tool was deferred. **Run before releases touching the codex transform, auto-defer, or `computePassthroughMaxTurns`** | 2026-09-08 |
| E46 | [Codex namespace and MCP tools](#e46-codex-namespace-and-mcp-tools) | **Automated**: `bun scripts/e2e-codex-namespace-tools.mjs [--stream]` — real proxy + SDK. Codex 0.15x sends MCP servers as `{type:"namespace", tools:[...]}`, which the Responses translator dropped. Asserts namespaced tools reach Claude, calls come back carrying `namespace`, and a `function_call_output` whose output is a content-item ARRAY does not 400. **Run before releases touching the Responses translator or Codex tool handling** | 2026-09-08 |
| E47 | [Codex thread identity](#e47-codex-thread-identity) | **Automated**: `bun scripts/e2e-codex-thread-identity.mjs` — real proxy + SDK. Codex hands a spawned subagent and its compaction the PARENT's `prompt_cache_key`. Asserts a user thread still resumes unchanged, siblings get their own sessions, and the parent still resumes after both. **Run before releases touching Responses session identity, the turn coordinator, or request-source admission** | 2026-09-08 |
| E48 | [Responses developer-note cache](#e48-responses-developer-note-cache) | **Automated**: `bun scripts/e2e-responses-developer-cache.mjs` — real proxy + SDK, A/B. A `developer` item folded into `system` mid-conversation re-wrote the whole cached prefix. Asserts the note's turn re-writes no more than the control's (measured 7.8x pre-fix, 1.2x after). **Run before releases touching Responses prompt assembly or system-block construction** | 2026-09-08 |
| E49 | [max_tokens enforcement](#e49-max_tokens-enforcement) | **Automated**: `bun scripts/e2e-max-tokens.mjs` — real proxy + SDK. Opt-in via `MERIDIAN_ENFORCE_MAX_TOKENS=1`: a tiny cap bounds output and reports `stop_reason: max_tokens` in both modes, a generous cap is untouched, and with the flag unset the cap is ignored exactly as before. **Run before releases touching the SDK call builder, env plumbing, or terminal stop reasons** | 2026-09-08 |
| E50 | [Passthrough MCP namespace](#e50-passthrough-mcp-namespace) | **Automated**: `bun scripts/e2e-passthrough-mcp-namespace.mjs` — real proxy + SDK. Asks the model to state its own tool name, the only place the namespace is visible. A LiteLLM-pinned request must read `mcp__litellm__*`; an OpenCode request must still read `mcp__oc__*`. **Run before releases touching passthrough tool registration or adapter tool config** | 2026-09-08 |
| E51 | [Boot identity](#e51-boot-identity) | **Automated, needs Docker** (skips cleanly without it, costs no tokens): `bun scripts/e2e-boot-identity.mjs`. In an image with no `/etc/machine-id`, asserts startup refuses with an actionable cause and `/health` returns 503 `unhealthy`; with a valid machine-id the same image starts normally. **Run before releases touching startup validation, `/health`, or process incarnation** | 2026-09-08 |
| E52 | [Host identity](#e52-host-identity) | **Automated, needs Docker** (skips cleanly without it, costs no tokens): `bun scripts/e2e-host-id.mjs`. Reproduces the derived `hostId` moving with the pid-namespace inode across `docker restart`, then asserts `MERIDIAN_HOST_ID` makes it stable across namespaces and distinct across hosts sharing a baked machine-id. **Run before releases touching process incarnation or store locking** | 2026-09-08 |
| E53 | [Auto-defer pin](#e53-auto-defer-pin) | **Automated**: `bun scripts/e2e-defer-pin.mjs` — real proxy + SDK, A/B. Two three-turn conversations, one crossing the auto-defer threshold on its last turn. Asserts deferral (and so `maxTurns`) does not flip mid-session and that the suppressed flip is logged. **Run before releases touching auto-defer, tool registration, or prompt assembly** | 2026-09-09 |
| E54 | [Lineage divergence reason](#e54-lineage-divergence-reason) | **Automated**: `bun scripts/e2e-lineage-divergence-reason.mjs` — real proxy + SDK, A/B. Drives a headerless pi tool loop and the same loop with `x-session-affinity`. Asserts no divergence is silent, that the headerless bypass names itself, that the advice is printed once per process, and that the named remedy actually restores resume and prompt-cache reuse. **Run before releases touching lineage classification, the independence guards, or the request log line** | 2026-09-09 |
| E55 | [Gateway-fronted Claude Code](#e55-gateway-fronted-claude-code) | **Automated, needs the `claude` CLI** (skips cleanly without it): `bun scripts/e2e-passthrough-claude-code-session.mjs` — real proxy + SDK, and the REAL Claude Code CLI as the client. Asserts a gateway-fronted Claude Code session keeps the tool-loop exemption it has on a direct connection, that its following turn resumes, and that the CLI's auxiliary requests do not collide with the conversation. **Run before releases touching the independence guards, adapter detection, or passthrough session identity** | 2026-09-09 |
| E56 | [Namespaced tool-round resume](#e56-namespaced-tool-round-resume) | **Automated**: `bun scripts/e2e-passthrough-namespace-resume.mjs` — real proxy + SDK, three adapters. Drives an identical keyed tool loop on `pi`, `passthrough` and `opencode` and asserts every keyed tool round resumes on all of them, so an adapter-specific client-tool namespace cannot silently take the resume checkpoint away. **Run before releases touching the passthrough namespace, the early-stop tracker, or checkpoint storage** | 2026-09-09 |

| P1 | [Profile: List & Auth Status](#p1-profile-list--auth-status) | `/profiles/list` returns profiles with emails, login status, auth timestamps | - |
| P2 | [Profile: Switch via API](#p2-profile-switch-via-api) | `POST /profiles/active` switches profile; health endpoint reflects new email | - |
| P3 | [Profile: Persistence Across Restart](#p3-profile-persistence-across-restart) | Active profile survives proxy restart via settings.json | - |
| P4 | [Profile: Request Routing](#p4-profile-request-routing) | Request on profile A uses different SDK auth than profile B | - |
| P5 | [Profile: Per-Request Header Override](#p5-profile-per-request-header-override) | `x-meridian-profile` header routes single request to non-active profile | - |
| P6 | [Profile: Session Isolation](#p6-profile-session-isolation) | Same messages on different profiles get separate SDK sessions (no cross-contamination) | - |
| P7 | [Profile: Invalid Profile Rejection](#p7-profile-invalid-profile-rejection) | Switching to nonexistent profile returns 400; invalid persisted profile falls back safely | - |
| P8 | [Profile: Settings Persistence](#p8-profile-settings-persistence) | `settings.json` updated on switch; CLI `meridian profile list` reflects state | - |
| P9 | [Profile: Health Reflects Active](#p9-profile-health-reflects-active) | `/health` email changes when active profile changes | - |
| P10 | [Profile: Telemetry Records After Switch](#p10-profile-telemetry-records-after-switch) | Requests on both profiles appear in `/telemetry/requests` | - |

---

## Conventions

**Model selection.** Tests use `claude-haiku-4-5-20251001` by default — it's the cheapest Claude Max tier and sufficient for verifying proxy behavior. Only use sonnet or opus when the test genuinely requires stronger reasoning (E3, E10: real coding tasks via opencode) or is explicitly testing model routing (E14, C4).

**Proxy log verification.** Most tests check proxy stderr for structured log lines:
```
[PROXY] <uuid> model=<m> stream=<bool> tools=<n> lineage=<type> session=<id|new> active=<n>/<max> msgCount=<n>
```

Extract these with:
```bash
cat /tmp/proxy-e2e.log | strings | grep "\[PROXY\]" | tail -5
```

**Session header.** All curl tests use `x-opencode-session` to control session identity. This is the header the OpenCode adapter reads.

**Diagnostics vs gates.** `scripts/e2e-*.mjs` are gates: they assert and exit non-zero. Real-session gates must inspect history only through supported Agent SDK APIs such as `getSessionMessages()`. Never locate, parse, rewrite, or mutate Claude's private transcript files.

**Cleanup.** Each test section is independent. Kill the proxy and clear the session store between sections if you need isolation:
```bash
kill $(lsof -ti :3456) 2>/dev/null
rm -f ~/.cache/meridian/sessions.json
```

---

## E1: Basic Request/Response

**Verifies:** Proxy accepts Anthropic API format, routes to SDK, returns valid JSON response.

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-basic-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Respond with exactly: E2E_OK"}]
  }'
```

**Pass criteria:**
- Response has `"type": "message"`, `"role": "assistant"`
- Content includes a text block
- `stop_reason` is `"end_turn"`
- Proxy log shows `lineage=new session=new`

---

## E2: Streaming SSE

**Verifies:** SSE event stream has correct format, events arrive in proper order.

```bash
curl -sN http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-stream-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": true,
    "messages": [{"role": "user", "content": "Say hello in one word"}]
  }' | head -30
```

**Pass criteria:**
- First event is `event: message_start` with a `message` object
- At least one `event: content_block_start` with `type: "text"`
- At least one `event: content_block_delta` with `type: "text_delta"`
- Final events include `event: message_stop`
- No `mcp__opencode__*` tool blocks leak through

---

## E3: Tool Use Loop

**Verifies:** SDK MCP tools execute and produce correct results.

```bash
# Setup
echo "CANARY_12345" > /tmp/e2e-canary.txt

# Test via opencode (tools are registered by opencode, not by curl)
cd /tmp && opencode run --model anthropic/claude-sonnet-4-5 --format json \
  "What are the contents of /tmp/e2e-canary.txt?" 2>/dev/null

# Cleanup
rm /tmp/e2e-canary.txt
```

**Pass criteria:**
- Response text includes `CANARY_12345`
- Proxy log shows `tools=76` (or similar — opencode registers its full tool set)

### Variant: Write + Read

```bash
rm -f /tmp/e2e-write-test.txt
cd /tmp && opencode run --model anthropic/claude-sonnet-4-5 --format json \
  "Write 'WRITE_OK' to /tmp/e2e-write-test.txt then read it back and confirm." 2>/dev/null

# Verify on disk
cat /tmp/e2e-write-test.txt   # → WRITE_OK
rm /tmp/e2e-write-test.txt
```

---

## E4: Session Continuation

**Verifies:** Appending messages with the same session header resumes the SDK session.

```bash
# Turn 1: Create session
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-cont-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 100,
    "stream": false,
    "messages": [{"role": "user", "content": "Remember: DELTA_99"}]
  }' > /dev/null

# Turn 2: Continue (prefix preserved, new message appended)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-cont-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 100,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Remember: DELTA_99"},
      {"role": "assistant", "content": [{"type":"text","text":"Noted: DELTA_99."}]},
      {"role": "user", "content": "What was the code?"}
    ]
  }'
```

**Pass criteria:**
- Turn 2 proxy log: `lineage=continuation session=<8-char-id>` (not `new`)
- Response mentions `DELTA_99`

---

## E5: Undo with Rollback

**Verifies:** When the message suffix changes (user edited/undid), proxy detects undo and emits rollback UUID.

**Automated history-integrity gate (#817):** Run `bun scripts/e2e-undo-gap.mjs`
and `bun scripts/e2e-undo-gap.mjs --stream`. The fixture creates a real SDK
conversation with valid historical assistant UUIDs and publishes its matching
Meridian mapping, representing a persisted session with available rollback
points. Recent proxy forks invalidate older UUIDs, so simply growing a proxy
conversation can mask this bug through the missing-UUID fresh-replay fallback.
The gate proves ordinary undo uses a real fork, shortened history with edited
intermediate turns reaches the SDK and the answer in full, and the source stays
unchanged. A third case removes the adjacent UUID from the stored mapping and
checks that fresh replay preserves facts after an older known checkpoint.
It inspects history only through `getSessionMessages()` and isolates
Meridian configuration/session storage in a temporary directory.

**Prerequisite:** Run E4 first (builds a 3+ message session with `e2e-cont-001`).

```bash
# Send same prefix but DIFFERENT last message (undo turn 2, ask something else)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-cont-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 100,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Remember: DELTA_99"},
      {"role": "assistant", "content": [{"type":"text","text":"Noted: DELTA_99."}]},
      {"role": "user", "content": "Actually, forget that. Tell me a joke."}
    ]
  }'
```

**Pass criteria:**
- Proxy log: `lineage=undo session=<same-id> rollback=<uuid>`
- `Undo detected` message in proxy stderr
- Response is valid (not an error)

---

## E6: Compaction

**Verifies:** When the agent summarizes early messages but preserves recent ones, proxy detects compaction and resumes.

```bash
# Step 1: Seed a 7-message conversation (≥6 required for compaction detection)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-compact-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Message one"},
      {"role": "assistant", "content": "Reply one"},
      {"role": "user", "content": "Message two"},
      {"role": "assistant", "content": "Reply two"},
      {"role": "user", "content": "Message three"},
      {"role": "assistant", "content": "Reply three"},
      {"role": "user", "content": "Message four"}
    ]
  }' > /dev/null

# Step 2: Simulate compaction — early messages replaced, recent suffix preserved
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-compact-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [
      {"role": "user", "content": "[Summary of earlier conversation]"},
      {"role": "assistant", "content": "[Summary of replies]"},
      {"role": "user", "content": "Message three"},
      {"role": "assistant", "content": "Reply three"},
      {"role": "user", "content": "Message four"},
      {"role": "assistant", "content": "Reply four"},
      {"role": "user", "content": "Continuing after compaction"}
    ]
  }'
```

**Pass criteria:**
- Step 2 proxy log: `lineage=compaction session=<same-id>` (not `new`)
- `Compaction detected` message in proxy stderr
- Response is valid (session was resumed, not restarted)

**Key constants:** `MIN_SUFFIX_FOR_COMPACTION = 2`, `MIN_STORED_FOR_COMPACTION = 6` (in `session/lineage.ts`)

---

## E7: Diverged Detection

**Verifies:** Completely unrelated messages with the same session header start a fresh session.

**Prerequisite:** Run E6 first (session `e2e-compact-001` exists).

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-compact-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Completely unrelated topic about quantum physics"},
      {"role": "assistant", "content": "Quantum physics is fascinating"},
      {"role": "user", "content": "Tell me about entanglement"}
    ]
  }'
```

**Pass criteria:**
- Proxy log: `lineage=new session=new` (old session discarded)

---

## E8: Cross-Proxy Resume

**Verifies:** Sessions survive proxy restart via the shared file store (`~/.cache/meridian/sessions.json`).

```bash
# Step 1: Create a session
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-persist-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Remember: PHOENIX_42"}]
  }' > /dev/null

# Verify stored in file
cat ~/.cache/meridian/sessions.json | python3 -m json.tool | grep -A3 "e2e-persist"

# Step 2: Kill and restart proxy (in-memory caches wiped)
kill $(lsof -ti :3456); sleep 2
CLAUDE_PROXY_PORT=3456 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &
sleep 5  # Wait for startup

# Step 3: Resume the session
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-persist-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 100,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Remember: PHOENIX_42"},
      {"role": "assistant", "content": [{"type":"text","text":"Got it — PHOENIX_42."}]},
      {"role": "user", "content": "What was the code?"}
    ]
  }'
```

**Pass criteria:**
- Step 3 proxy log: `lineage=continuation session=<same-8-char-id>` (not `new`)
- Response mentions `PHOENIX_42`
- SDK session was genuinely resumed (not a fresh start with flat text replay)

---

## E9: Fingerprint Fallback

**Verifies:** When no `x-opencode-session` header is sent, sessions are matched by fingerprint (hash of first user message + working directory).

```bash
# Turn 1: No session header
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Unique fingerprint test message 98765"}]
  }' > /dev/null

# Turn 2: Same first message, no header — should match by fingerprint
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Unique fingerprint test message 98765"},
      {"role": "assistant", "content": "Acknowledged."},
      {"role": "user", "content": "Continue the conversation"}
    ]
  }'
```

**Pass criteria:**
- Turn 1 proxy log: `lineage=new`
- Turn 2 proxy log: `lineage=continuation` (fingerprint matched, not `new`)

---

## E10: Coding Task via opencode

**Verifies:** Full opencode → proxy → SDK → tool execution → file modification loop.

```bash
# Setup
mkdir -p /tmp/e2e-coding-test
cat > /tmp/e2e-coding-test/buggy.js << 'EOF'
function add(a, b) {
  return a - b  // BUG: should be +
}
module.exports = { add }
EOF

# Run
cd /tmp/e2e-coding-test && opencode run --model anthropic/claude-sonnet-4-5 \
  "There's a bug in buggy.js. Find and fix it." 2>/dev/null

# Verify
cat /tmp/e2e-coding-test/buggy.js   # Should show "a + b"

# Cleanup
rm -rf /tmp/e2e-coding-test
```

**Pass criteria:**
- `buggy.js` now contains `a + b` (not `a - b`)
- Proxy log shows tool execution (multiple `[PROXY]` lines for the session)

### Variant: Multi-turn via opencode

```bash
SESSION_OUT=$(opencode run --model anthropic/claude-sonnet-4-5 --format json \
  "Remember the code ALPHA_42. Just confirm." 2>/dev/null)
SESSION_ID=$(echo "$SESSION_OUT" | grep -o '"sessionID":"[^"]*"' | head -1 | cut -d'"' -f4)

opencode run --model anthropic/claude-sonnet-4-5 --session "$SESSION_ID" --format json \
  "What was the code?" 2>/dev/null
```

**Pass criteria:**
- Second response includes `ALPHA_42`

---

## E11: Telemetry

**Verifies:** Telemetry dashboard and API endpoints return data after requests.

```bash
# Dashboard HTML
curl -s http://127.0.0.1:3456/telemetry | head -3
# → <!DOCTYPE html> ...

# Recent requests
curl -s http://127.0.0.1:3456/telemetry/requests?limit=5 | python3 -m json.tool | head -20

# Aggregate summary
curl -s http://127.0.0.1:3456/telemetry/summary | python3 -m json.tool

# Diagnostic logs
curl -s http://127.0.0.1:3456/telemetry/logs?limit=5 | python3 -m json.tool | head -20
```

**Pass criteria:**
- `/telemetry` returns HTML with `<title>Meridian`
- `/telemetry/requests` returns an array of request metrics with `requestId`, `model`, `lineageType`
- `/telemetry/summary` returns `totalRequests > 0`, `errorCount`, percentile latencies
- `/telemetry/logs` returns an array with `level`, `category`, `message` fields

---

## E12: Health Check

**Verifies:** `/health` endpoint returns auth and mode status.

```bash
curl -s http://127.0.0.1:3456/health | python3 -m json.tool
```

**Pass criteria:**
- `status: "healthy"`
- `auth.loggedIn: true`
- `auth.subscriptionType: "max"`
- `mode: "internal"` (or `"passthrough"` if `CLAUDE_PROXY_PASSTHROUGH` is set)

---

## E13: Concurrent Requests

**Verifies:** Multiple simultaneous requests are queued, not dropped or deadlocked.

```bash
# Fire 3 requests in parallel
for i in 1 2 3; do
  curl -s http://127.0.0.1:3456/v1/messages \
    -H "Content-Type: application/json" \
    -H "x-api-key: dummy" \
    -H "x-opencode-session: e2e-concurrent-$i" \
    -d "{
      \"model\": \"claude-haiku-4-5-20251001\",
      \"max_tokens\": 30,
      \"stream\": false,
      \"messages\": [{\"role\": \"user\", \"content\": \"Say $i\"}]
    }" &
done
wait
```

**Pass criteria:**
- All 3 responses return valid JSON with `"type": "message"`
- Proxy log shows `active=` counts incrementing (e.g. `active=1/10`, `active=2/10`, `active=3/10`)
- No errors or deadlocks

---

## E14: Model Routing

**Verifies:** Different model strings map to the correct SDK model.

```bash
# Haiku
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{"model":"claude-haiku-4-5-20250929","max_tokens":10,"stream":false,"messages":[{"role":"user","content":"Hi"}]}' > /dev/null

# Opus
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{"model":"claude-opus-4-20250514","max_tokens":10,"stream":false,"messages":[{"role":"user","content":"Hi"}]}' > /dev/null

# Sonnet (default)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{"model":"claude-sonnet-4-5-20250514","max_tokens":10,"stream":false,"messages":[{"role":"user","content":"Hi"}]}' > /dev/null
```

**Pass criteria:**
- Proxy log shows `model=haiku` for the first request
- Proxy log shows `model=opus` (or `model=opus[1m]`) for the second
- Proxy log shows `model=sonnet[1m]` for the third

---

## E15: Non-Streaming

**Verifies:** `stream: false` returns a complete JSON response with correct headers.

```bash
curl -s -D /tmp/e2e-headers.txt http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-nonstream-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Say exactly: NONSTREAM_OK"}]
  }'
cat /tmp/e2e-headers.txt
rm /tmp/e2e-headers.txt
```

**Pass criteria:**
- Response body: `"type": "message"`, `"stop_reason": "end_turn"`
- Response header: `Content-Type: application/json`
- Response header: `x-claude-session-id: <uuid>` present
- Content includes text block

---

## E16: Error Handling

**Verifies:** Invalid requests return structured error responses, not crashes.

```bash
# Malformed JSON
curl -s -w "\n%{http_code}" http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: dummy" \
  -d 'not json'

# Missing messages
curl -s -w "\n%{http_code}" http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: dummy" \
  -d '{"model":"claude-haiku-4-5-20251001","stream":false}'

# Unknown endpoint
curl -s -w "\n%{http_code}" http://127.0.0.1:3456/v1/nonexistent

# Wrong HTTP method
curl -s -w "\n%{http_code}" http://127.0.0.1:3456/v1/messages
```

**Pass criteria:**
- Malformed JSON → HTTP 500, `{"type":"error","error":{"type":"api_error",...}}`
- Missing messages → HTTP 400, `{"type":"error","error":{"type":"invalid_request_error","message":"messages: Field required"}}`
- Unknown endpoint → HTTP 404, `{"error":{"type":"not_found",...}}`
- GET on POST endpoint → HTTP 404, `{"error":{"type":"not_found",...}}`
- Proxy does NOT crash on any of these

---

## E17: Passthrough Mode

**Verifies:** With `CLAUDE_PROXY_PASSTHROUGH=1`, the SDK returns tool_use blocks to the client instead of executing them internally.

**Requires proxy restart with env var:**
```bash
kill $(lsof -ti :3456) 2>/dev/null; sleep 1
CLAUDE_PROXY_PORT=3456 CLAUDE_PROXY_PASSTHROUGH=1 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &
# Wait for ready...
```

### Non-streaming

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-passthrough-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 200,
    "stream": false,
    "messages": [{"role": "user", "content": "Read the file /tmp/test.txt"}],
    "tools": [
      {
        "name": "Read",
        "description": "Read a file from disk",
        "input_schema": {
          "type": "object",
          "properties": {"file_path": {"type": "string"}},
          "required": ["file_path"]
        }
      }
    ]
  }'
```

**Pass criteria:**
- `"stop_reason": "tool_use"` — SDK didn't execute the tool
- Content includes a `tool_use` block with `"name": "Read"` and correct `input`
- Tool name is clean (no `mcp__passthrough__` prefix)
- `/health` shows `"mode": "passthrough"`

### Streaming

```bash
curl -sN http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-passthrough-stream-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 200,
    "stream": true,
    "messages": [{"role": "user", "content": "Read the file /tmp/test.txt"}],
    "tools": [{"name":"Read","description":"Read a file","input_schema":{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}}]
  }' | grep -E "tool_use|stop_reason"
```

**Pass criteria:**
- Stream contains `content_block_start` with `type: "tool_use"`, `name: "Read"`
- `message_delta` has `stop_reason: "tool_use"`

**After testing, restart proxy in normal mode:**
```bash
kill $(lsof -ti :3456) 2>/dev/null; sleep 1
CLAUDE_PROXY_PORT=3456 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &
```

---

## E18: Multimodal Content

**Verifies:** Image content blocks are preserved and passed through the structured message path.

```bash
# 1x1 red PNG pixel
IMG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="

curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-multimodal-001" \
  -d "{
    \"model\": \"claude-haiku-4-5-20251001\",
    \"max_tokens\": 100,
    \"stream\": false,
    \"messages\": [{
      \"role\": \"user\",
      \"content\": [
        {\"type\": \"image\", \"source\": {\"type\": \"base64\", \"media_type\": \"image/png\", \"data\": \"$IMG_B64\"}},
        {\"type\": \"text\", \"text\": \"What color is this image? Reply with just the color name.\"}
      ]
    }]
  }"
```

**Pass criteria:**
- Response contains a text block with a color name
- Proxy log shows `msgs=user[image,text]` — image content type was detected
- No errors about unsupported content types

---

## E19: Subagent / Task Tool

**Verifies:** When the request includes a Task tool with agent descriptions, the proxy extracts agent definitions and processes the request through the agent routing path.

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-task-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 100,
    "stream": false,
    "messages": [{"role": "user", "content": "Just say hello"}],
    "tools": [
      {
        "name": "Task",
        "description": "Launch a sub-agent. Available agents:\n- coder: Writes code\n- reviewer: Reviews code\n- explorer: Explores codebase",
        "input_schema": {
          "type": "object",
          "properties": {
            "description": {"type": "string"},
            "subagent_type": {"type": "string"}
          },
          "required": ["description"]
        }
      },
      {
        "name": "Read",
        "description": "Read a file",
        "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}}}
      }
    ]
  }'
```

**Pass criteria:**
- Response is `"type": "message"` (no error)
- Proxy log shows `tools=2` — both tools were seen
- No crash from agent definition parsing

---

## E20: Env Stripping

**Verifies:** The proxy strips `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN` from the environment before spawning SDK subprocesses, preventing the SDK from looping back through the proxy.

```bash
ANTHROPIC_API_KEY=should-be-stripped ANTHROPIC_BASE_URL=http://should-be-stripped:9999 \
  curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-envstrip-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 20,
    "stream": false,
    "messages": [{"role": "user", "content": "Say OK"}]
  }'
```

**Pass criteria:**
- Response is a valid message with text content (request succeeded)
- If env vars leaked, the SDK would try to call `http://should-be-stripped:9999` and fail

**Note:** This test verifies the client-side env doesn't matter (the proxy runs in its own process). The actual env stripping happens inside `server.ts` before spawning the SDK. All prior tests implicitly prove this works (they'd fail if the SDK looped back), but this makes the verification explicit.

---

## E21: Session Store Pruning

**Verifies:** The file-based session store (`~/.cache/meridian/sessions.json`) evicts the oldest entries when the count exceeds `CLAUDE_PROXY_MAX_STORED_SESSIONS`.

**Requires proxy restart with env var:**
```bash
kill $(lsof -ti :3456) 2>/dev/null; sleep 1
rm -f ~/.cache/meridian/sessions.json
CLAUDE_PROXY_PORT=3456 CLAUDE_PROXY_MAX_STORED_SESSIONS=3 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &
# Wait for ready...
```

```bash
# Create 5 sessions
for i in 1 2 3 4 5; do
  curl -s http://127.0.0.1:3456/v1/messages \
    -H "Content-Type: application/json" \
    -H "x-api-key: dummy" \
    -H "x-opencode-session: e2e-prune-$i" \
    -d "{\"model\":\"claude-haiku-4-5-20251001\",\"max_tokens\":10,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Session $i\"}]}" > /dev/null
  sleep 1  # ensure distinct timestamps for deterministic eviction
done

# Verify the store is bounded
cat ~/.cache/meridian/sessions.json | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'Entries: {len(d)} (should be <= 3)')
"
```

**Pass criteria:**
- File store contains at most 3 entries
- Oldest sessions (lowest `lastUsedAt`) were evicted

**After testing, restart proxy in normal mode (no cap).**

---

## E22: OAuth Token Refresh

**Verifies:** When the Claude Code OAuth access token has expired, the proxy detects the 401, refreshes the token automatically, and retries the request — the caller sees a normal successful response.

**Platform note:** The credential store is platform-specific. Run on the platform you want to verify:
- **macOS** — credentials in Keychain (`/usr/bin/security`)
- **Linux** — credentials in `~/.claude/.credentials.json`

### macOS

```bash
# 1. Snapshot current expiry
python3 -c "
import subprocess, json
creds = json.loads(subprocess.check_output(
    ['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials',
     '-a', __import__('os').getlogin(), '-w']).decode())
print('Current expiresAt:', creds['claudeAiOauth']['expiresAt'])
"

# 2. Artificially expire the token
CREDS=$(security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w)
EXPIRED=$(echo "$CREDS" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
d['claudeAiOauth']['expiresAt'] = 0   # epoch — definitely expired
print(json.dumps(d, indent=2))
")
security add-generic-password -U -s "Claude Code-credentials" -a "$(whoami)" -w "$EXPIRED"
echo "Token expired (expiresAt set to 0)"

# 3. Make a request — proxy should refresh inline and succeed
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-token-refresh-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 20,
    "stream": false,
    "messages": [{"role": "user", "content": "Say: REFRESH_OK"}]
  }'

# 4. Verify token was refreshed
python3 -c "
import subprocess, json
creds = json.loads(subprocess.check_output(
    ['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials',
     '-a', __import__('os').getlogin(), '-w']).decode())
exp = creds['claudeAiOauth']['expiresAt']
import time
print(f'New expiresAt: {exp} ({"VALID" if exp > time.time()*1000 else "STILL EXPIRED"})')
"
```

### Linux

```bash
# 1. Snapshot current expiry
python3 -c "
import json, os
creds = json.loads(open(os.path.expanduser('~/.claude/.credentials.json')).read())
print('Current expiresAt:', creds['claudeAiOauth']['expiresAt'])
"

# 2. Artificially expire the token
python3 -c "
import json, os
path = os.path.expanduser('~/.claude/.credentials.json')
d = json.loads(open(path).read())
d['claudeAiOauth']['expiresAt'] = 0
open(path, 'w').write(json.dumps(d, indent=2))
print('Token expired')
"

# 3. Make a request
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-token-refresh-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 20,
    "stream": false,
    "messages": [{"role": "user", "content": "Say: REFRESH_OK"}]
  }'

# 4. Verify token was refreshed
python3 -c "
import json, os, time
path = os.path.expanduser('~/.claude/.credentials.json')
d = json.loads(open(path).read())
exp = d['claudeAiOauth']['expiresAt']
print(f'New expiresAt: {exp} ({\"VALID\" if exp > time.time()*1000 else \"STILL EXPIRED\"})')
"
```

**Pass criteria:**
- Response: `"type": "message"` with text containing `REFRESH_OK` — request succeeded despite starting with an expired token
- Proxy log: `[PROXY] <id> OAuth token expired — refreshed, retrying` appears before the successful response log line
- Step 4 expiresAt: `VALID` (in the future — token was refreshed and written back)
- No `authentication_error` in the response

**What's being tested:** The `isExpiredTokenError()` detection in `errors.ts`, the `refreshOAuthToken()` cross-platform credential read/write in `tokenRefresh.ts`, and the inline retry loop in `server.ts`.

### Bonus: manual refresh endpoint

While the proxy is running with a valid token, you can also verify the `/auth/refresh` endpoint directly:

```bash
curl -s -X POST http://127.0.0.1:3456/auth/refresh
# → {"success":true,"message":"OAuth token refreshed successfully"}
```

**Pass criteria:** `success: true` and the `expiresAt` in the credential store is updated to a new future timestamp.

---

## E23: Subagent Model Selection

**Verifies:** When the `x-opencode-agent-mode: subagent` header or a generic `x-meridian-source: subagent-*` declaration is present, the proxy selects the base model (200k) instead of the 1M variant, conserving rate limit budget for the primary agent. The `meridian-agent-mode.ts` plugin sets the OpenCode header automatically based on the agent's runtime `mode` field. SDK-native Task agent definitions also receive the matching base tier explicitly, so they do not inherit an `opus[1m]` parent.

### Part A — header routing (curl, no plugin needed)

```bash
# Primary agent → opus[1m]
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-agent-mode: primary" \
  -d '{"model":"claude-opus-4-6","max_tokens":10,"stream":false,"messages":[{"role":"user","content":"hi"}]}' > /dev/null
# Proxy log: model=opus[1m] ... agent=primary

# Subagent → opus (base)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-agent-mode: subagent" \
  -d '{"model":"claude-opus-4-6","max_tokens":10,"stream":false,"messages":[{"role":"user","content":"hi"}]}' > /dev/null
# Proxy log: model=opus ... agent=subagent

# Generic source declaration (works across adapters) → base opus
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-meridian-source: subagent-reviewer" \
  -d '{"model":"claude-opus-4-6","max_tokens":10,"stream":false,"messages":[{"role":"user","content":"hi"}]}' > /dev/null
# Proxy log: model=opus ... source=subagent-reviewer agent=subagent
```

**Pass criteria (Part A):**
- Primary request proxy log: `model=opus[1m] ... agent=primary`
- Subagent request proxy log: `model=opus ... agent=subagent` — base model, no `[1m]`
- Generic `subagent-*` source: base tier and `agent=subagent`, even outside OpenCode
- No header → `model=opus[1m]` (default primary behaviour)

### Part B — plugin integration (requires OpenCode)

**Setup:**
```bash
# 1. Copy the plugin into your project
cp /path/to/meridian/examples/opencode-plugin/meridian-agent-mode.ts ./meridian-agent-mode.ts

# 2. Add to opencode.json
# { "plugin": ["./claude-max-headers.ts", "./meridian-agent-mode.ts"] }

# 3. Create a named agent (e.g. ~/.config/opencode/agents/researcher.md)
# The agent's frontmatter mode determines primary vs subagent
```

**Test:**
```bash
# Run a task that uses the Task tool to spawn the researcher agent
opencode run --model anthropic/claude-opus-4-6 \
  "Use the researcher agent to find out what day it is, then summarise."
```

**Pass criteria (Part B):**
- Primary session log line: `model=opus[1m] agent=primary`
- Subagent session log line: `model=opus agent=subagent`
- Both requests succeed — no errors
- Two distinct proxy log entries visible (parent + subagent turn)

**What's being tested:** `mapModelToClaudeModel()` subagent tier selection in `models.ts`, OpenCode agent-mode extraction through its adapter, generic `x-meridian-source` fallback in `server.ts`, base-tier SDK agent definitions in `agentDefs.ts`, and the `meridian-agent-mode.ts` plugin's use of the runtime agent mode without any API calls.

---

## E24: Default Non-Streaming

**Verifies:** When the `stream` field is omitted from the request body, the proxy returns a single JSON response (`application/json`), not an SSE stream — matching the Anthropic API spec default.

```bash
curl -s -D /tmp/e2e-headers.txt http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 10,
    "messages": [{"role": "user", "content": "Say OK"}]
  }'
grep -i content-type /tmp/e2e-headers.txt
rm /tmp/e2e-headers.txt
```

**Pass criteria:**
- Response header: `Content-Type: application/json` (not `text/event-stream`)
- Response body: `"type": "message"`, `"role": "assistant"`, valid `content` array
- Response is a single JSON object, not SSE events
- Proxy log: `stream=false`

**What's being tested:** The `body.stream ?? false` default in `server.ts`. Prior to this fix, omitting `stream` defaulted to `true` (SSE), which broke SDK clients calling `messages.create()` without an explicit `stream` parameter.

---

## E25: OpenAI Compat: Non-Streaming

**Verifies:** `POST /v1/chat/completions` accepts an OpenAI-format request and returns a valid OpenAI completion JSON object.

```bash
curl -s http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 20,
    "stream": false,
    "messages": [{"role": "user", "content": "Say: OK"}]
  }' | python3 -m json.tool
```

**Pass criteria:**
- `"object": "chat.completion"`
- `id` starts with `chatcmpl-`
- `choices[0].message.role` is `"assistant"`
- `choices[0].message.content` contains a response
- `choices[0].finish_reason` is `"stop"`
- `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens` are numbers
- Proxy log: `stream=false` (non-streaming path used internally)

**What's being tested:** `translateOpenAiToAnthropic()` and `translateAnthropicToOpenAi()` in `openai.ts`, internal routing via `app.fetch()` to `/v1/messages`.

---

## E26: OpenAI Compat: Streaming

**Verifies:** `POST /v1/chat/completions` with `stream: true` returns OpenAI SSE chunks in the correct format.

```bash
curl -sN http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 20,
    "stream": true,
    "messages": [{"role": "user", "content": "Say: hello"}]
  }'
```

**Pass criteria:**
- Response `Content-Type: text/event-stream`
- First data chunk has `"object": "chat.completion.chunk"` and `choices[0].delta.role == "assistant"`
- At least one chunk has non-empty `choices[0].delta.content`
- A chunk has `choices[0].finish_reason == "stop"`
- Stream ends with `data: [DONE]`
- All chunks share the same `id` starting with `chatcmpl-`
- Proxy log: `stream=true`

**What's being tested:** `translateAnthropicSseEvent()` in `openai.ts`, SSE stream translation in `server.ts`.

---

## E27: OpenAI Compat: Models

**Verifies:** `GET /v1/models` returns available Claude models in OpenAI format with correct context windows for the subscription tier.

```bash
curl -s http://127.0.0.1:3456/v1/models | python3 -m json.tool
```

**Pass criteria:**
- `"object": "list"`
- `data` array contains `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5-20251001`
- Each model has `object: "model"`, `owned_by: "anthropic"`, `context_window > 0`
- For Max subscription: sonnet and opus have `context_window: 1000000`
- Haiku always has `context_window: 200000`

**What's being tested:** `buildModelList()` in `openai.ts`, `GET /v1/models` route in `server.ts`.

---

## E28: SDK Param Passthrough

**Verifies:** The live proxy accepts the new SDK passthrough fields (`effort`, `thinking`, `task_budget`, `anthropic-beta`) and still completes a normal Claude request. Exact option mapping is asserted by the integration tests in `src/__tests__/proxy-sdk-params.test.ts` and `src/__tests__/query-passthrough.test.ts`; this live test proves the real HTTP → proxy → SDK path does not reject or break on these fields.

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-sdk-params-001" \
  -H "x-opencode-effort: high" \
  -H "x-opencode-task-budget: 2000" \
  -H "anthropic-beta: interleaved-thinking-2025-05-14" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 120,
    "stream": false,
    "thinking": {"type": "enabled", "budgetTokens": 1024},
    "task_budget": {"total": 1000},
    "messages": [{"role": "user", "content": "Reply with exactly: SDK_PARAMS_OK"}]
  }' | python3 -m json.tool
```

**Pass criteria:**
- Response is a valid Anthropic-format assistant message
- Response is **not** a structured error
- Proxy stderr shows a normal request log line (`model=... stream=false ...`)
- Proxy stderr shows a `usage:` line after the request

### Variant: malformed thinking override falls back cleanly

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-sdk-params-002" \
  -H "x-opencode-thinking: not-valid-json{{{" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 120,
    "stream": false,
    "thinking": {"type": "enabled", "budgetTokens": 1024},
    "messages": [{"role": "user", "content": "Reply with exactly: THINKING_FALLBACK_OK"}]
  }' | python3 -m json.tool
```

**Pass criteria:**
- Response succeeds with a normal assistant message (HTTP 200)
- Proxy stderr contains `ignoring malformed x-opencode-thinking header`
- Request still completes normally instead of failing with a 4xx/5xx

---

## E29: Context Usage Endpoint

**Verifies:** A completed request stores token usage under the Claude SDK session ID returned by the proxy, and `/v1/sessions/:claudeSessionId/context-usage` returns it.

```bash
# 1. Make a request and capture response headers + body
curl -sD /tmp/e2e-context-usage.headers \
  -o /tmp/e2e-context-usage.body \
  http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-context-usage-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 80,
    "stream": false,
    "messages": [{"role": "user", "content": "Reply with exactly: CONTEXT_USAGE_OK"}]
  }'

# 2. Extract the Claude session ID the proxy returned
CLAUDE_SESSION_ID=$(awk 'BEGIN{IGNORECASE=1} /^X-Claude-Session-ID:/ {print $2}' /tmp/e2e-context-usage.headers | tr -d '\r')
echo "$CLAUDE_SESSION_ID"

# 3. Query the usage endpoint
curl -s http://127.0.0.1:3456/v1/sessions/$CLAUDE_SESSION_ID/context-usage | python3 -m json.tool
```

**Pass criteria:**
- `CLAUDE_SESSION_ID` is non-empty
- Endpoint returns HTTP 200
- JSON contains `session_id` equal to the extracted Claude session ID
- JSON contains `context_usage.input_tokens` and `context_usage.output_tokens`
- Proxy stderr for the original request contains a `usage:` line

---

## E30: Context Usage via Fingerprint + Restart

**Verifies:** The context-usage endpoint also works for sessions created **without** `x-opencode-session` (fingerprint fallback) and still works after restarting the proxy (shared session store persistence).

```bash
# 1. Make a headerless request and capture the returned Claude session ID
curl -sD /tmp/e2e-context-fp.headers \
  -o /tmp/e2e-context-fp.body \
  http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 80,
    "stream": false,
    "messages": [{"role": "user", "content": "Reply with exactly: FP_CONTEXT_USAGE_OK"}]
  }'

CLAUDE_SESSION_ID=$(awk 'BEGIN{IGNORECASE=1} /^X-Claude-Session-ID:/ {print $2}' /tmp/e2e-context-fp.headers | tr -d '\r')
echo "$CLAUDE_SESSION_ID"

# 2. Query usage immediately (proves fingerprint-backed sessions are discoverable)
curl -s http://127.0.0.1:3456/v1/sessions/$CLAUDE_SESSION_ID/context-usage | python3 -m json.tool

# 3. Restart the proxy WITHOUT deleting ~/.cache/meridian/sessions.json
kill $(lsof -ti :3456) 2>/dev/null
sleep 2
CLAUDE_PROXY_PORT=3456 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &
sleep 5

# 4. Query usage again after restart (proves shared-store persistence)
curl -s http://127.0.0.1:3456/v1/sessions/$CLAUDE_SESSION_ID/context-usage | python3 -m json.tool
```

**Pass criteria:**
- Step 2 returns HTTP 200 for a request that had **no** `x-opencode-session` header
- Step 4 also returns HTTP 200 after restart
- Both responses contain `session_id` equal to the extracted Claude session ID
- Both responses contain `context_usage.input_tokens` and `context_usage.output_tokens`
- No need to replay the original request after restart — the lookup should work from persisted session data alone

---

## Adding New E2E Tests

When extending this document:

1. **Assign an ID** — use the next sequential `E##` number in the index.
2. **Add to the index table** at the top with the date verified.
3. **Include the exact curl/opencode command** — tests must be copy-pasteable.
4. **Define pass criteria** — what to check in the response AND in the proxy log.
5. **Note prerequisites** — if the test depends on a prior test's session state, say so.
6. **Note env vars** — if the test requires a proxy restart with special env vars (E17, E21), say so explicitly.
7. **Keep tests independent where possible** — use unique session IDs (`e2e-<test>-<nnn>`).

### Session ID Convention

Use `e2e-<feature>-<nnn>` format: `e2e-cont-001`, `e2e-compact-001`, `e2e-persist-001`.

### Checking Proxy Logs

The proxy writes structured log lines to stderr. When running as a background process:
```bash
CLAUDE_PROXY_PORT=3456 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &

# Read logs (binary-safe — the log may contain emoji)
cat /tmp/proxy-e2e.log | strings | grep "\[PROXY\]"
cat /tmp/proxy-e2e.log | strings | grep -E "Compaction|Undo|diverged"
```

### Tests That Require Proxy Restart

Some tests need specific env vars. Group these at the end of a run to minimize restarts:

| Test | Env Var | Value |
|------|---------|-------|
| E17 | `CLAUDE_PROXY_PASSTHROUGH` | `1` |
| E21 | `CLAUDE_PROXY_MAX_STORED_SESSIONS` | `3` |

### Relationship to Unit/Integration Tests

```
Unit tests (bun test)          → Pure functions, no SDK, no network
Integration tests (bun test)   → HTTP layer with mocked SDK (fast, deterministic)
E2E tests (this document)      → Real proxy + real SDK + real Claude Max (slow, non-deterministic)
```

Unit and integration tests run in CI. E2E tests run manually before releases or after major refactors. They require an active Claude Max subscription.

### Coverage Map

Which proxy modules each E2E test exercises:

| Module | Tests |
|--------|-------|
| `server.ts` (orchestration) | All |
| `session/lineage.ts` | E4, E5, E6, E7, E8, E9 |
| `session/cache.ts` | E4, E5, E6, E7, E8, E9, E29, E30 |
| `session/fingerprint.ts` | E9, E30 |
| `sessionStore.ts` | E8, E21, E30 |
| `query.ts` | All (builds SDK options), especially E28 |
| `adapter.ts` + `adapters/opencode.ts` | All E-tests, D3, D10 |
| `adapters/droid.ts` | D1, D2, D4, D5, D6, D7, D8, D9 |
| `adapters/crush.ts` | C1, C2, C3, C4, C5 |
| `adapters/detect.ts` | D1, D2, D3, D6, D7, D9, D10, C1, C5 |
| *(default adapter — no Cline adapter needed)* | CL1–CL8 |
| `errors.ts` | E16, E22 |
| `tokenRefresh.ts` | E22 |
| `models.ts` | E14, E23 |
| `messages.ts` | E4, E5, E6 (content normalization for hashing) |
| `tools.ts` | E3, E17, E19 |
| `agentDefs.ts` | E19 |
| `agentMatch.ts` | E19 (fuzzy matching in PreToolUse hook) |
| `passthroughTools.ts` | E17 |
| `mcpTools.ts` | E3, E10 |
| `fileChanges.ts` | FC1, FC2, FC3, FC4, FC5, FC6 |
| `telemetry/` | E11 |

---

## Droid (Factory AI) Tests

These tests verify the Droid adapter added in the Droid support release. They require `droid` CLI installed and a Factory AI account.

### Droid passthrough mode

Droid's passthrough behavior is **env-controlled, defaulting to OFF**:

- **Without `MERIDIAN_PASSTHROUGH`** (default): Droid runs in internal mode. The proxy executes tools via the `mcp__droid__*` MCP server and Claude sees results via the SDK's internal tool loop. This is what tests D1–D10 cover.
- **With `MERIDIAN_PASSTHROUGH=1`** (or `CLAUDE_PROXY_PASSTHROUGH=1`): the proxy forwards `tool_use` blocks to Droid, Droid executes the tools locally, and sends `tool_result` back. Requires Droid ≥ 0.109 (earlier versions had a BYOK loop bug where `tool_result` wasn't delivered).

Historical note: this used to be hardcoded to internal mode for Droid because of the BYOK loop bug. Verified working on Droid 0.114.1 — `tool_use` → `tool_result` roundtrip completes correctly. See `src/__tests__/droid-adapter.test.ts` and `src/__tests__/proxy-droid-integration.test.ts` for the unit-level coverage of the env-controlled behavior.

### Droid BYOK Setup

Droid connects to the proxy via its BYOK (Bring Your Own Key) feature. Configure once before running D6–D8:

```bash
# 1. Back up Droid settings
cp ~/.factory/settings.json ~/.factory/settings.json.backup

# 2. Register all model tiers pointing at the proxy
# Model names drive mapModelToClaudeModel():
#   "4-6" in name → 1M context for Max users
#   "haiku" in name → haiku tier (no 1M)
#   "4-5" in name → base tier (no 1M)
python3 -c "
import json
with open('$HOME/.factory/settings.json') as f:
    s = json.load(f)
s['customModels'] = [
    {'model':'claude-sonnet-4-6',          'name':'Sonnet 4.6 (1M — Meridian)', 'provider':'anthropic','baseUrl':'http://127.0.0.1:3457','apiKey':'sk-proxy'},
    {'model':'claude-opus-4-6',            'name':'Opus 4.6 (1M — Meridian)',   'provider':'anthropic','baseUrl':'http://127.0.0.1:3457','apiKey':'sk-proxy'},
    {'model':'claude-haiku-4-5-20251001',  'name':'Haiku 4.5 (Meridian)',       'provider':'anthropic','baseUrl':'http://127.0.0.1:3457','apiKey':'sk-proxy'},
    {'model':'claude-sonnet-4-5-20250929', 'name':'Sonnet 4.5 (Meridian)',      'provider':'anthropic','baseUrl':'http://127.0.0.1:3457','apiKey':'sk-proxy'},
]
with open('$HOME/.factory/settings.json', 'w') as f:
    json.dump(s, f, indent=2)
"

# 3. Verify Droid sees the model
droid exec --model "custom:claude-haiku-4-5-20251001" --list-tools 2>&1 | head -3
# → Available tools for claude-sonnet-4-5-20250514

# After all Droid tests, restore:
# cp ~/.factory/settings.json.backup ~/.factory/settings.json
```

### Droid Proxy Quick Start

Use port 3457 to avoid conflicts with any existing proxy service on 3456:

```bash
# Note: if you have an existing proxy service with CLAUDE_PROXY_PASSTHROUGH=1
# (e.g., a launchd service), use a different port
CLAUDE_PROXY_DEBUG=1 CLAUDE_PROXY_PORT=3457 bun run ./bin/cli.ts > /tmp/proxy-droid-e2e.log 2>&1 &
sleep 5
curl -s http://127.0.0.1:3457/health | python3 -m json.tool
# → {"status":"healthy","mode":"internal",...}

# Check logs
cat /tmp/proxy-droid-e2e.log | grep "\[PROXY\]"
```

---

## D1: Droid Basic Response

**Verifies:** Proxy detects `factory-cli/` User-Agent, selects droid adapter, returns valid Anthropic-format response.

```bash
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Respond with exactly: DROID_E2E_OK"}]
  }' | python3 -m json.tool
```

**Pass criteria:**
- `"type": "message"`, `"role": "assistant"`
- Content includes text block with `DROID_E2E_OK`
- `"stop_reason": "end_turn"`
- Proxy log: `lineage=new session=new` (no prior session)

---

## D2: Droid MCP Server Name

**Verifies:** When Droid requests a tool execution, the proxy uses `mcp__droid__*` tool names (not `mcp__opencode__*`). Confirmed by observing the tool name in the response content block.

```bash
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 200,
    "stream": false,
    "messages": [{"role": "user", "content": "List the current directory. Use the Bash tool."}],
    "tools": [
      {"name": "Bash", "description": "Run a shell command", "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}
    ]
  }' | python3 -c "
import json, sys
d = json.load(sys.stdin)
for block in d['content']:
    if block['type'] == 'tool_use':
        print('Tool name in response:', block['name'])
"
```

**Pass criteria:**
- Tool block name is `mcp__droid__bash` (internal SDK MCP name — confirms droid adapter selected)
- NOT `mcp__opencode__bash`

**What's happening:** The Droid adapter sets `getMcpServerName() = "droid"`, so the SDK registers MCP tools as `mcp__droid__*`. The proxy strips these prefixes before returning to Droid, but the pre-strip name confirms adapter selection.

---

## D3: Droid OpenCode Backward Compat

**Verifies:** Requests without Droid User-Agent still use the OpenCode adapter. All existing OpenCode behavior preserved.

```bash
# No User-Agent → OpenCode adapter
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: d3-compat-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 30,
    "stream": false,
    "messages": [{"role": "user", "content": "Say: OC_COMPAT_OK"}]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][0]['text'])"

# With opencode User-Agent → still OpenCode adapter
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: opencode/1.0" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 30,
    "stream": false,
    "messages": [{"role": "user", "content": "Say: OC_UA_OK"}]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][0]['text'])"
```

**Pass criteria:**
- Both responses return valid messages
- No errors
- Proxy log: `lineage=new session=new` for both (both are first requests with those sessions)

---

## D4: Droid CWD from system-reminder

**Verifies:** Proxy extracts the working directory from Droid's `<system-reminder>` block in the first user message content, not from a `system` field (which OpenCode uses).

```bash
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 30,
    "stream": false,
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "<system-reminder>\nUser system info\n% pwd\n/Users/dev/my-project\n% ls\nsrc\n</system-reminder>"},
        {"type": "text", "text": "Say: CWD_EXTRACTED_OK"}
      ]
    }]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][-1]['text'])"
```

**Pass criteria:**
- Response contains `CWD_EXTRACTED_OK`
- Proxy log: `msgs=user[text,text]` — multiple content blocks received

**What's happening internally:** `droidAdapter.extractWorkingDirectory()` matches `% pwd\n<path>` inside `<system-reminder>` and returns `/Users/dev/my-project` as the `cwd` passed to the SDK. Different first messages will fingerprint to different sessions.

---

## D5: Droid Fingerprint Session Resume

**Verifies:** Without a session header, Droid sessions are resumed via fingerprint (hash of first user message + CWD). Same first message = same fingerprint = resumed session.

```bash
# Turn 1: Establish session
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "<system-reminder>\n% pwd\n/Users/dev/my-project\n</system-reminder>"},
        {"type": "text", "text": "Remember the code: DROID_FINGERPRINT_88"}
      ]
    }]
  }' > /dev/null

# Turn 2: Same first message → fingerprint resume
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 80,
    "stream": false,
    "messages": [
      {"role": "user", "content": [
        {"type": "text", "text": "<system-reminder>\n% pwd\n/Users/dev/my-project\n</system-reminder>"},
        {"type": "text", "text": "Remember the code: DROID_FINGERPRINT_88"}
      ]},
      {"role": "assistant", "content": [{"type": "text", "text": "Got it — DROID_FINGERPRINT_88."}]},
      {"role": "user", "content": [{"type": "text", "text": "What was the code?"}]}
    ]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][-1]['text'][:80])"
```

**Pass criteria:**
- Turn 2 proxy log: `lineage=continuation session=<8-char-id>` — fingerprint matched, session resumed
- Response includes `DROID_FINGERPRINT_88`

---

## D6: Droid Real Binary Basic

**Prerequisites:** Droid BYOK configured (see [Droid BYOK Setup](#droid-byok-setup)). Proxy running on port 3457.

**Verifies:** Live `droid exec` binary successfully routes through the proxy and receives a valid Claude Max response.

```bash
droid exec \
  --model "custom:claude-haiku-4-5-20251001" \
  --skip-permissions-unsafe \
  --cwd /tmp \
  "Reply with exactly: REAL_DROID_OK. Nothing else."
```

**Pass criteria:**
- Output: `REAL_DROID_OK` (printed to stdout by droid)
- Proxy log: `model=sonnet stream=true tools=<n> lineage=new session=new` — request received and processed
- No `"isByok": false` errors — authentication via BYOK succeeded
- No 402 Payment Required errors

---

## D7: Droid Real Binary Tool Use

**Prerequisites:** Droid BYOK configured, proxy on port 3457.

**Verifies:** Live `droid exec` can read a file using the `mcp__droid__read` MCP tool registered by the droid adapter.

```bash
# Setup canary file
echo "DROID_CANARY_E2E_42" > /tmp/droid-canary.txt

# Droid reads it via proxy
droid exec \
  --model "custom:claude-haiku-4-5-20251001" \
  --auto medium \
  --cwd /tmp \
  "Read the file /tmp/droid-canary.txt and tell me what it contains. Just the content, nothing else."

# Verify
rm /tmp/droid-canary.txt
```

**Pass criteria:**
- Output: `DROID_CANARY_E2E_42` (droid read the file successfully)
- Proxy log shows `tools=<n>` for the request — Droid sent its tool definitions
- Multi-turn exchange visible in proxy logs (tool call + result + final response)

---

## D8: Droid exec Session Isolation

**Verifies:** Each `droid exec` invocation is a fresh independent session. This is expected behavior — `droid exec` does not pass previous conversation history (unlike interactive TUI mode). Session continuity in interactive mode works via fingerprint resume (D5).

```bash
# Turn 1 — set a secret
droid exec \
  --model "custom:claude-haiku-4-5-20251001" \
  --skip-permissions-unsafe \
  --cwd /tmp \
  "Remember the code: DROID_SECRET_99. Just say 'noted'."

# Turn 2 — separate exec, no shared history
droid exec \
  --model "custom:claude-haiku-4-5-20251001" \
  --skip-permissions-unsafe \
  --cwd /tmp \
  "What was the secret code?"
```

**Pass criteria:**
- Turn 1 output: `noted` (or similar)
- Turn 2 output: model says it has no record of any secret code — **this is correct behavior**
- Proxy log: both show `lineage=new session=new` — each exec is a fresh session
- No errors or crashes

**Why this is correct:** `droid exec` is a one-shot command that sends only the current prompt as the message. It does not replay prior conversation history. For multi-turn continuity in interactive mode, fingerprint-based resume (D5) kicks in because Droid sends the full message history including the same first-message content.

---

## D9: Droid Streaming SSE

**Verifies:** When Droid requests streaming, the proxy returns correct SSE format with proper event ordering.

```bash
curl -sN http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": true,
    "messages": [{"role": "user", "content": "Say: STREAM_DROID_OK"}]
  }' | head -25
```

**Pass criteria:**
- First event: `event: message_start` with a valid `message` object
- At least one `event: content_block_delta` with `type: "text_delta"` containing the response text
- Final event: `event: message_stop`
- No `mcp__droid__*` tool blocks leak to the client
- Proxy log: `stream=true`

---

## D10: Droid OpenCode Session Unaffected

**Verifies:** Adding Droid support does not break OpenCode session tracking. The `x-opencode-session` header is still used by the OpenCode adapter for session continuity.

```bash
# OpenCode Turn 1
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: d10-oc-backcompat-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Remember: OPENCODE_BACKCOMPAT_55"}]
  }' > /dev/null

# OpenCode Turn 2 — same session header → continuation
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: d10-oc-backcompat-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 80,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Remember: OPENCODE_BACKCOMPAT_55"},
      {"role": "assistant", "content": [{"type": "text", "text": "Got it."}]},
      {"role": "user", "content": "What was the code?"}
    ]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][-1]['text'][:80])"
```

**Pass criteria:**
- Response includes `OPENCODE_BACKCOMPAT_55`
- Proxy log Turn 2: `lineage=continuation session=<id>` — OpenCode header session resumed correctly
- Droid requests in D1–D9 did not corrupt the OpenCode session cache

---

## Droid Cleanup

```bash
# Restore Droid settings (if BYOK was configured)
cp ~/.factory/settings.json.backup ~/.factory/settings.json 2>/dev/null

# Kill the test proxy
kill $(lsof -ti :3457) 2>/dev/null
```

---

## Crush (Charm) Tests

These tests verify the Crush adapter. Crush connects via a provider entry in `~/.config/crush/crush.json` — no BYOK or special auth needed, just a base_url pointing at the proxy.

### Crush Provider Setup

Add the `meridian` provider to `~/.config/crush/crush.json`:

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
        {
          "id": "claude-sonnet-4-6",
          "name": "Claude Sonnet 4.6 (1M)",
          "context_window": 1000000,
          "default_max_tokens": 64000,
          "can_reason": true,
          "supports_attachments": true
        },
        {
          "id": "claude-opus-4-6",
          "name": "Claude Opus 4.6 (1M)",
          "context_window": 1000000,
          "default_max_tokens": 32768,
          "can_reason": true,
          "supports_attachments": true
        },
        {
          "id": "claude-haiku-4-5-20251001",
          "name": "Claude Haiku 4.5",
          "context_window": 200000,
          "default_max_tokens": 16384,
          "can_reason": true,
          "supports_attachments": true
        }
      ]
    }
  }
}
```

Verify Crush sees the models:
```bash
crush models | grep meridian
# → meridian/claude-haiku-4-5-20251001
# → meridian/claude-opus-4-6
# → meridian/claude-haiku-4-5-20251001
```

---

## C1: Crush Basic Response

**Verifies:** Proxy detects `Charm-Crush/` User-Agent, selects crush adapter, returns valid response.

```bash
crush run \
  --model meridian/claude-haiku-4-5-20251001 \
  --cwd /path/to/your/project \
  --quiet \
  "Respond with exactly: CRUSH_E2E_OK"
```

**Pass criteria:**
- Output: `CRUSH_E2E_OK`
- Proxy log: `model=sonnet[1m] stream=true tools=19 lineage=new session=new`
- Note: first request may show `rate-limited on [1m], retrying with sonnet` — this is expected, the proxy auto-falls back

---

## C2: Crush Session Continuation

**Verifies:** `crush run --continue` resumes the most recent Crush session via fingerprint-based cache lookup.

```bash
# Turn 1: establish session
crush run \
  --model meridian/claude-haiku-4-5-20251001 \
  --cwd /path/to/your/project \
  --quiet \
  "Remember the code: CRUSH_CONT_99. Reply with 'stored'."

# Turn 2: continue that session
crush run \
  --model meridian/claude-haiku-4-5-20251001 \
  --cwd /path/to/your/project \
  --continue \
  --quiet \
  "What was the code I asked you to remember?"
```

**Pass criteria:**
- Turn 1 output: `stored` (or equivalent)
- Turn 2 output: includes `CRUSH_CONT_99`
- Proxy log Turn 2: `lineage=continuation session=<id>` — fingerprint matched, not a new session

---

## C3: Crush Tool Use (Read)

**Verifies:** Crush's tool execution loop works through the proxy. Crush sends a tool call, the proxy returns it (passthrough mode), Crush executes it, sends the result back, and Claude responds with the content.

```bash
crush run \
  --model meridian/claude-haiku-4-5-20251001 \
  --cwd /path/to/your/project \
  --quiet \
  "Use the ls tool to list the files in the current directory and show me the output"
```

**Pass criteria:**
- Output shows directory listing (actual files, not hallucinated)
- Proxy log: two entries for the same session — first `lineage=new` (initial turn), then `lineage=continuation` (after tool result returned) — confirms the multi-turn tool loop worked
- `msgs=` on the second log entry shows `tool_use` and `tool_result` in the message chain

**Note:** In `crush run` (headless) mode, all tool operations execute automatically without prompting — there is no interactive terminal to ask for approval. This includes writes, edits, and bash commands.

---

## C3b: Crush Tool Use (Write)

**Verifies:** Write tool executes automatically in `crush run` headless mode — no approval prompt needed.

```bash
crush run \
  --model meridian/claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --quiet \
  "Write the text 'CRUSH_WRITE_OK' to /tmp/crush-write-test.txt"

cat /tmp/crush-write-test.txt   # → CRUSH_WRITE_OK
rm /tmp/crush-write-test.txt
```

**Pass criteria:**
- File exists on disk with correct content
- Proxy log shows multi-turn: `tool_use` then `tool_result` then final text

---

## C4: Crush Model Routing

**Verifies:** Model names in `crush.json` map to the correct Claude Max tiers.

```bash
# Sonnet 4.6 → sonnet[1m]
crush run --model meridian/claude-sonnet-4-6 --quiet "Say: SONNET_OK" 2>/dev/null
# Proxy log: model=sonnet[1m]

# Opus 4.6 → opus[1m]
crush run --model meridian/claude-opus-4-6 --quiet "Say: OPUS_OK" 2>/dev/null
# Proxy log: model=opus[1m]

# Haiku 4.5 → haiku
crush run --model meridian/claude-haiku-4-5-20251001 --quiet "Say: HAIKU_OK" 2>/dev/null
# Proxy log: model=haiku
```

**Pass criteria:**
- Each model routes to the expected tier in proxy logs
- Sonnet 4.6 and Opus 4.6 both show `[1m]` (extended context) for Max subscribers
- Haiku shows `model=haiku` (no extended context)

---

## C5: Crush Backward Compat

**Verifies:** Crush requests coexist with OpenCode and Droid sessions on the same proxy port. No cross-contamination between adapters.

```bash
# Fire all three agents in sequence
crush run --model meridian/claude-haiku-4-5-20251001 --quiet "Say: CRUSH_COEXIST" 2>/dev/null

curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: c5-oc-001" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":20,"stream":false,"messages":[{"role":"user","content":"Say: OC_COEXIST"}]}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['content'][0]['text'])"

curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":20,"stream":false,"messages":[{"role":"user","content":"Say: DROID_COEXIST"}]}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['content'][0]['text'])"
```

**Pass criteria:**
- All three respond correctly without interfering with each other
- Proxy logs show `model=haiku` for Crush, normal models for others
- OpenCode session `c5-oc-001` is tracked independently (header-based)
- Droid and Crush both use fingerprint-based tracking independently

---

## Cline Tests

Cline connects via its `anthropicBaseUrl` config key. No adapter needed — it uses the standard Anthropic SDK and falls through to the default (OpenCode) adapter. Passthrough mode handles tool execution correctly.

### Cline Setup

**1. Authenticate with the Anthropic provider:**

```bash
cline auth --provider anthropic --apikey "dummy" --modelid "claude-sonnet-4-6"
```

**2. Set the proxy base URL** in `~/.cline/data/globalState.json`:

```json
{
  "anthropicBaseUrl": "http://127.0.0.1:3456"
}
```

Verify Cline can reach the proxy:
```bash
cline --yolo --model claude-haiku-4-5-20251001 --timeout 20 --json "Say: OK" 2>/dev/null | grep completion_result
```

---

## CL1: Cline Basic Response

**Verifies:** Proxy accepts Cline requests routed via `anthropicBaseUrl`, returns valid response.

```bash
cline --yolo \
  --model claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --timeout 20 \
  --json \
  "Reply with exactly: CLINE_E2E_OK" 2>/dev/null | grep completion_result
```

**Pass criteria:**
- Output includes `CLINE_E2E_OK`
- Proxy log: `model=haiku stream=true tools=11 lineage=new`
- No authentication errors

---

## CL2: Cline File Read

**Verifies:** Cline's tool_use/tool_result passthrough loop works for reading files.

```bash
echo "CLINE_CANARY_123" > /tmp/cline-canary.txt

cline --yolo \
  --model claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --timeout 45 \
  --json \
  "Read /tmp/cline-canary.txt and tell me its exact contents" 2>/dev/null | grep completion_result

rm /tmp/cline-canary.txt
```

**Pass criteria:**
- Output includes `CLINE_CANARY_123`
- Proxy log shows multi-turn: `lineage=continuation` with `tool_use` → `tool_result` in message chain

---

## CL3: Cline File Write

**Verifies:** Cline writes files to disk through the passthrough tool loop.

```bash
rm -f /tmp/cline-write-test.txt

cline --yolo \
  --model claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --timeout 45 \
  --json \
  "Write 'CLINE_WRITE_OK' to /tmp/cline-write-test.txt" 2>/dev/null | grep completion_result

cat /tmp/cline-write-test.txt   # → CLINE_WRITE_OK
rm /tmp/cline-write-test.txt
```

**Pass criteria:**
- File exists on disk with correct content
- Proxy log shows tool_use → tool_result continuation

---

## CL4: Cline Bash Execution

**Verifies:** Bash commands execute through the passthrough loop.

```bash
cline --yolo \
  --model claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --timeout 45 \
  --json \
  "Run 'echo CLINE_BASH_OK' using bash and show the output" 2>/dev/null | grep completion_result
```

**Pass criteria:**
- Output includes `CLINE_BASH_OK`

---

## CL5: Cline File Edit

**Verifies:** Cline edits existing files correctly.

```bash
echo 'function add(a, b) { return a - b }' > /tmp/cline-edit-test.js

cline --yolo \
  --model claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --timeout 45 \
  --json \
  "Fix the bug in /tmp/cline-edit-test.js — it subtracts instead of adding" 2>/dev/null | grep completion_result

cat /tmp/cline-edit-test.js   # → should contain a + b
rm /tmp/cline-edit-test.js
```

**Pass criteria:**
- File on disk shows `a + b` (not `a - b`)
- Proxy log shows read → edit tool chain

---

## CL6: Cline Session Continuation

**Verifies:** Resuming a session with `-T taskId` maintains conversation context through the proxy.

```bash
# Turn 1: create session
OUTPUT=$(cline --yolo \
  --model claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --timeout 30 \
  --json \
  "Remember the code: CLINE_RECALL_55. Say 'noted'." 2>/dev/null)
TASK_ID=$(echo "$OUTPUT" | head -1 | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('taskId',''))" 2>/dev/null)
echo "Task ID: $TASK_ID"

# Turn 2: resume with task ID
cline --yolo \
  --model claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --timeout 30 \
  -T "$TASK_ID" \
  --json \
  "What was the code?" 2>/dev/null | grep completion_result
```

**Pass criteria:**
- Turn 2 output includes `CLINE_RECALL_55`
- Proxy log Turn 2: `lineage=continuation session=<id>`

---

## CL7: Cline Model Routing

**Verifies:** Model names map to correct Claude Max tiers.

```bash
cline --yolo --model claude-sonnet-4-6 --timeout 20 --json "Say: OK" 2>/dev/null > /dev/null
# Proxy log: model=sonnet[1m]

cline --yolo --model claude-opus-4-6 --timeout 20 --json "Say: OK" 2>/dev/null > /dev/null
# Proxy log: model=opus[1m]

cline --yolo --model claude-haiku-4-5-20251001 --timeout 20 --json "Say: OK" 2>/dev/null > /dev/null
# Proxy log: model=haiku
```

**Pass criteria:**
- `claude-sonnet-4-6` → `model=sonnet[1m]`
- `claude-opus-4-6` → `model=opus[1m]`
- `claude-haiku-4-5-20251001` → `model=haiku`

---

## CL8: Cline Multi-Agent Coexistence

**Verifies:** Cline, Crush, and OpenCode all work on the same proxy port simultaneously.

```bash
# Cline
cline --yolo --model claude-haiku-4-5-20251001 --timeout 20 --json "Say: CLINE_COEXIST" 2>/dev/null | grep completion_result

# Crush
crush run --model meridian/claude-haiku-4-5-20251001 --quiet "Say: CRUSH_COEXIST" 2>/dev/null

# OpenCode (curl)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: cl8-oc-001" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":20,"stream":false,"messages":[{"role":"user","content":"Say: OC_COEXIST"}]}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['content'][0]['text'])"
```

**Pass criteria:**
- All three respond correctly
- No cross-contamination between sessions
- Proxy handles all three without errors

---

## File Change Visibility Tests

These tests verify the PostToolUse hook that tracks file write/edit operations and appends a "Files changed" summary to responses. This feature is **internal mode only** — passthrough mode forwards tools to the client, so the proxy never sees tool execution results.

**Requires:** Proxy running in internal mode (no `MERIDIAN_PASSTHROUGH` env var). Use a separate port if your default service runs in passthrough mode.

```bash
kill $(lsof -ti :3457) 2>/dev/null; sleep 1
CLAUDE_PROXY_PORT=3457 bun run ./bin/cli.ts > /tmp/proxy-fc-e2e.log 2>&1 &
sleep 5
curl -s http://127.0.0.1:3457/health | python3 -m json.tool
# → mode: "internal"
```

---

## FC1: File Changes Write (non-stream)

**Verifies:** PostToolUse hook captures a write operation and appends "Files changed" summary to non-streaming response.

```bash
rm -f /tmp/e2e-fc-write.txt

curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-fc-write-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 300,
    "stream": false,
    "messages": [{"role": "user", "content": "Write the text FILECHANGE_OK to /tmp/e2e-fc-write.txt. Just write it, nothing else."}]
  }' | python3 -c "
import json, sys
d = json.load(sys.stdin)
texts = [b['text'] for b in d['content'] if b['type'] == 'text']
full = '\n'.join(texts)
print(full)
"

cat /tmp/e2e-fc-write.txt   # → FILECHANGE_OK
rm /tmp/e2e-fc-write.txt
```

**Pass criteria:**
- File `/tmp/e2e-fc-write.txt` exists on disk with content `FILECHANGE_OK`
- Response text includes `Files changed:` followed by `- wrote /tmp/e2e-fc-write.txt`
- `"type": "message"` in response (valid Anthropic format)

---

## FC2: File Changes Write (stream)

**Verifies:** PostToolUse hook captures a write operation and emits a file change text block in the SSE stream, before `message_stop`.

```bash
rm -f /tmp/e2e-fc-stream.txt

curl -sN http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-fc-stream-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 300,
    "stream": true,
    "messages": [{"role": "user", "content": "Write the text STREAMFC_OK to /tmp/e2e-fc-stream.txt. Just write it."}]
  }' | tee /tmp/fc-stream-raw.txt | grep -E "text_delta.*Files changed"

cat /tmp/e2e-fc-stream.txt   # → STREAMFC_OK
rm -f /tmp/e2e-fc-stream.txt /tmp/fc-stream-raw.txt
```

**Pass criteria:**
- File exists on disk with `STREAMFC_OK`
- SSE stream contains a `text_delta` event with `Files changed:\n- wrote /tmp/e2e-fc-stream.txt`
- The file change block comes BEFORE `message_stop` in the event stream
- Block index is monotonically increasing (no index collision)

---

## FC3: File Changes Edit

**Verifies:** Edit operations are tracked as "edited" (not "wrote") in the file change summary.

```bash
echo "function greet() { return 'hello' }" > /tmp/e2e-fc-edit.js

curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-fc-edit-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 300,
    "stream": false,
    "messages": [{"role": "user", "content": "Edit /tmp/e2e-fc-edit.js to change hello to world. Do not rewrite the whole file, just edit it."}]
  }' | python3 -c "
import json, sys
d = json.load(sys.stdin)
texts = [b['text'] for b in d['content'] if b['type'] == 'text']
print('\n'.join(texts))
"

cat /tmp/e2e-fc-edit.js   # → function greet() { return 'world' }
rm /tmp/e2e-fc-edit.js
```

**Pass criteria:**
- File on disk contains `'world'` instead of `'hello'`
- Response text includes `Files changed:` followed by `- edited /tmp/e2e-fc-edit.js`
- Not `- wrote` — the operation must be `edited`

---

## FC4: File Changes Read-only (no summary)

**Verifies:** Read-only tool operations (read, glob, grep) do NOT produce a "Files changed" section in the response.

```bash
echo "READ_ONLY_CONTENT" > /tmp/e2e-fc-readonly.txt

curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-fc-readonly-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 200,
    "stream": false,
    "messages": [{"role": "user", "content": "Read the file /tmp/e2e-fc-readonly.txt and tell me what it contains. Do not modify it."}]
  }' | python3 -c "
import json, sys
d = json.load(sys.stdin)
texts = [b['text'] for b in d['content'] if b['type'] == 'text']
full = '\n'.join(texts)
has_fc = 'Files changed' in full
print(f'Contains Files changed: {has_fc} (should be False)')
print(f'Contains READ_ONLY_CONTENT: {\"READ_ONLY_CONTENT\" in full}')
"

rm /tmp/e2e-fc-readonly.txt
```

**Pass criteria:**
- Response text includes `READ_ONLY_CONTENT` (file was read)
- Response text does NOT contain `Files changed:` — no write/edit occurred
- No extra text block appended

---

## FC5: File Changes Multiple ops

**Verifies:** Multiple file operations (write + edit) within one turn are all tracked and listed in the summary.

```bash
rm -f /tmp/e2e-fc-multi-a.txt
echo "original content" > /tmp/e2e-fc-multi-b.txt

curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-fc-multi-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 400,
    "stream": false,
    "messages": [{"role": "user", "content": "Do two things: 1) Write MULTI_A to /tmp/e2e-fc-multi-a.txt. 2) Edit /tmp/e2e-fc-multi-b.txt to change \"original\" to \"modified\". Do both."}]
  }' | python3 -c "
import json, sys
d = json.load(sys.stdin)
texts = [b['text'] for b in d['content'] if b['type'] == 'text']
full = '\n'.join(texts)
idx = full.find('Files changed:')
if idx >= 0:
    print(full[idx:])
else:
    print('NO FILES CHANGED SECTION FOUND')
"

cat /tmp/e2e-fc-multi-a.txt   # → MULTI_A
cat /tmp/e2e-fc-multi-b.txt   # → modified content
rm -f /tmp/e2e-fc-multi-a.txt /tmp/e2e-fc-multi-b.txt
```

**Pass criteria:**
- Both files modified on disk
- Summary includes both: `- wrote /tmp/e2e-fc-multi-a.txt` and `- edited /tmp/e2e-fc-multi-b.txt`
- Deduplication works — each path+operation listed once even if the model called the tool multiple times

---

## FC6: File Changes Multiple ops (stream)

**Verifies:** Multiple file changes in streaming mode are emitted as a single text block before `message_stop`.

```bash
rm -f /tmp/e2e-fc-stream-multi-a.txt /tmp/e2e-fc-stream-multi-b.txt

curl -sN http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-fc-stream-multi-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 400,
    "stream": true,
    "messages": [{"role": "user", "content": "Write FOO to /tmp/e2e-fc-stream-multi-a.txt and BAR to /tmp/e2e-fc-stream-multi-b.txt"}]
  }' | grep "text_delta" | grep "Files changed"

cat /tmp/e2e-fc-stream-multi-a.txt   # → FOO
cat /tmp/e2e-fc-stream-multi-b.txt   # → BAR
rm -f /tmp/e2e-fc-stream-multi-a.txt /tmp/e2e-fc-stream-multi-b.txt
```

**Pass criteria:**
- Both files exist on disk with correct content
- A `text_delta` event contains `Files changed:\n- wrote /tmp/e2e-fc-stream-multi-a.txt\n- wrote /tmp/e2e-fc-stream-multi-b.txt`
- Only one file change text block (not one per file)

---

## FC Cleanup

```bash
kill $(lsof -ti :3457) 2>/dev/null
rm -f /tmp/proxy-fc-e2e.log
```

---

## E31: Passthrough — thinking blocks stripped, Turn 2 prose suppressed

Verifies that Claude's `thinking` content blocks and the SDK's internal Turn 2 prose summary are NOT forwarded to the client in passthrough mode. This fixes the missing diff-UI bug in OpenCode when using Claude Opus (issue #237).

### Setup

```bash
# Proxy must be running in passthrough mode
MERIDIAN_PASSTHROUGH=1 MERIDIAN_PORT=3457 npm start &
sleep 3
curl -s http://127.0.0.1:3457/health | jq .mode   # → "passthrough"

# Create a test file to edit
echo 'function greet(name) { return "Hello " + name }' > /tmp/e2e-passthrough-edit.js
```

### Non-streaming: no thinking, no Turn 2 prose

```bash
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-6",
    "max_tokens": 1024,
    "stream": false,
    "messages": [{"role":"user","content":"Edit /tmp/e2e-passthrough-edit.js — replace string concat with a template literal. Use the edit tool."}],
    "tools": [{
      "name": "edit",
      "description": "Edit a file by replacing oldString with newString",
      "input_schema": {
        "type": "object",
        "properties": {
          "filePath": {"type":"string"},
          "oldString": {"type":"string"},
          "newString": {"type":"string"}
        },
        "required": ["filePath","oldString","newString"]
      }
    }]
  }' | jq '{
    stop_reason,
    block_types: [.content[].type],
    has_thinking: ([.content[].type] | contains(["thinking"])),
    has_prose_about_forwarding: ([.content[] | select(.type=="text") | .text // ""] | any(contains("forwarded"))),
    tool_use_name: (.content[] | select(.type=="tool_use") | .name),
    tool_input_keys: (.content[] | select(.type=="tool_use") | .input | keys)
  }'
```

**Pass criteria:**
- `stop_reason` = `"tool_use"`
- `has_thinking` = `false`
- `has_prose_about_forwarding` = `false`
- `tool_use_name` = `"edit"`
- `tool_input_keys` contains `["filePath","oldString","newString"]`

### Streaming: no thinking_delta events forwarded

```bash
curl -sN http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-6",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role":"user","content":"Edit /tmp/e2e-passthrough-edit.js — replace string concat with a template literal. Use the edit tool."}],
    "tools": [{
      "name": "edit",
      "description": "Edit a file by replacing oldString with newString",
      "input_schema": {
        "type": "object",
        "properties": {
          "filePath": {"type":"string"},
          "oldString": {"type":"string"},
          "newString": {"type":"string"}
        },
        "required": ["filePath","oldString","newString"]
      }
    }]
  }' | tee /tmp/e31-stream.txt | grep "thinking"
# → (no output)

# Verify the edit tool_use IS in the stream
grep '"tool_use"' /tmp/e31-stream.txt | head -1
# → data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"...","name":"edit","input":{}}}

grep '"thinking"' /tmp/e31-stream.txt
# → (no output — thinking blocks stripped)

rm -f /tmp/e31-stream.txt /tmp/e2e-passthrough-edit.js
```

**Pass criteria:**
- `grep '"thinking"'` returns no output
- A `content_block_start` with `"type":"tool_use"` and `"name":"edit"` is present
- The stream ends with `event: message_stop`

### Cleanup

```bash
kill $(lsof -ti :3457) 2>/dev/null
```

---

## Profile Tests

**Prerequisites:** Two profiles configured in `~/.config/meridian/profiles.json` with valid auth. Example:
```json
[
  {"id": "personal", "claudeConfigDir": "/Users/you/.claude"},
  {"id": "work", "claudeConfigDir": "/Users/you/.claude-work"}
]
```

Both must pass `claude auth status` with `loggedIn: true` under their respective `CLAUDE_CONFIG_DIR`.

Proxy must be running with disk profile discovery (no `MERIDIAN_PROFILES` env var — let it auto-discover from the JSON file).

### Setup

```bash
# Verify both profiles are authenticated
PROFILE1_DIR=$(python3 -c "import json; print(json.load(open('$HOME/.config/meridian/profiles.json'))[0]['claudeConfigDir'])")
PROFILE2_DIR=$(python3 -c "import json; print(json.load(open('$HOME/.config/meridian/profiles.json'))[1]['claudeConfigDir'])")
PROFILE1_ID=$(python3 -c "import json; print(json.load(open('$HOME/.config/meridian/profiles.json'))[0]['id'])")
PROFILE2_ID=$(python3 -c "import json; print(json.load(open('$HOME/.config/meridian/profiles.json'))[1]['id'])")

CLAUDE_CONFIG_DIR=$PROFILE1_DIR claude auth status | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['loggedIn'], f'{d}'; print(f'Profile 1 ({d[\"email\"]}): OK')"
CLAUDE_CONFIG_DIR=$PROFILE2_DIR claude auth status | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['loggedIn'], f'{d}'; print(f'Profile 2 ({d[\"email\"]}): OK')"

# Verify proxy is healthy
curl -sf http://127.0.0.1:3456/health | python3 -c "import json,sys; assert json.load(sys.stdin)['status']=='healthy'; print('Proxy: healthy')"
```

---

## P1: Profile List & Auth Status

**Verifies:** `/profiles/list` returns all configured profiles with live auth status, emails, and timestamps.

```bash
RESULT=$(curl -s http://127.0.0.1:3456/profiles/list)

# Should have at least 2 profiles
COUNT=$(echo "$RESULT" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['profiles']))")
test "$COUNT" -ge 2 && echo "PASS: $COUNT profiles found" || echo "FAIL: expected >=2, got $COUNT"

# Each profile should have id, email, loggedIn, isActive, lastSuccessAt
echo "$RESULT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for p in d['profiles']:
    assert 'id' in p, f'missing id: {p}'
    assert 'email' in p, f'missing email: {p}'
    assert 'loggedIn' in p, f'missing loggedIn: {p}'
    assert 'isActive' in p, f'missing isActive: {p}'
    assert 'lastSuccessAt' in p or 'lastCheckedAt' in p, f'missing auth timestamps: {p}'
    print(f'  {p[\"id\"]:12} email={p[\"email\"]}  loggedIn={p[\"loggedIn\"]}  active={p[\"isActive\"]}')
assert d.get('activeProfile'), 'missing activeProfile'
print(f'Active: {d[\"activeProfile\"]}  PASS')
"
```

**Pass criteria:**
- At least 2 profiles returned
- Each has `id`, `email`, `loggedIn`, `isActive`, auth timestamps
- Exactly one profile has `isActive: true`
- `activeProfile` field present

---

## P2: Profile Switch via API

**Verifies:** `POST /profiles/active` switches the active profile; `/profiles/list` and `/health` reflect the change.

```bash
# Get profile IDs
PROFILE1_ID=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][0]['id'])")
PROFILE2_ID=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][1]['id'])")
PROFILE1_EMAIL=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][0]['email'])")
PROFILE2_EMAIL=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][1]['email'])")

# Switch to profile 1
RES=$(curl -s -X POST http://127.0.0.1:3456/profiles/active \
  -H "Content-Type: application/json" -d "{\"profile\":\"$PROFILE1_ID\"}")
echo "$RES" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['success']; assert d['activeProfile']=='$PROFILE1_ID'; print(f'Switch to $PROFILE1_ID: PASS')"

# Health should show profile 1 email
HEALTH_EMAIL=$(curl -s http://127.0.0.1:3456/health | python3 -c "import json,sys; print(json.load(sys.stdin)['auth']['email'])")
test "$HEALTH_EMAIL" = "$PROFILE1_EMAIL" && echo "PASS: health=$HEALTH_EMAIL" || echo "FAIL: expected $PROFILE1_EMAIL, got $HEALTH_EMAIL"

# Switch to profile 2
curl -s -X POST http://127.0.0.1:3456/profiles/active \
  -H "Content-Type: application/json" -d "{\"profile\":\"$PROFILE2_ID\"}" > /dev/null

# Health should show profile 2 email
HEALTH_EMAIL=$(curl -s http://127.0.0.1:3456/health | python3 -c "import json,sys; print(json.load(sys.stdin)['auth']['email'])")
test "$HEALTH_EMAIL" = "$PROFILE2_EMAIL" && echo "PASS: health=$HEALTH_EMAIL" || echo "FAIL: expected $PROFILE2_EMAIL, got $HEALTH_EMAIL"
```

**Pass criteria:**
- Switch returns `{"success": true, "activeProfile": "<id>"}`
- `/health` email matches the switched profile

---

## P3: Profile Persistence Across Restart

**Verifies:** Active profile survives a proxy restart.

```bash
# Get profile IDs
PROFILE2_ID=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][1]['id'])")
PROFILE2_EMAIL=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][1]['email'])")

# Switch to profile 2
curl -s -X POST http://127.0.0.1:3456/profiles/active \
  -H "Content-Type: application/json" -d "{\"profile\":\"$PROFILE2_ID\"}" > /dev/null

# Verify settings.json
SAVED=$(python3 -c "import json; print(json.load(open('$HOME/.config/meridian/settings.json'))['activeProfile'])")
test "$SAVED" = "$PROFILE2_ID" && echo "PASS: settings.json=$SAVED" || echo "FAIL: expected $PROFILE2_ID, got $SAVED"

# Restart proxy (adjust for your setup — launchd, systemd, or manual)
kill $(lsof -ti :3456) 2>/dev/null; sleep 1
MERIDIAN_PORT=3456 bun run ./bin/cli.ts &
sleep 3

# Verify profile restored
ACTIVE=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['activeProfile'])")
test "$ACTIVE" = "$PROFILE2_ID" && echo "PASS: restored=$ACTIVE" || echo "FAIL: expected $PROFILE2_ID, got $ACTIVE"

HEALTH_EMAIL=$(curl -s http://127.0.0.1:3456/health | python3 -c "import json,sys; print(json.load(sys.stdin)['auth']['email'])")
test "$HEALTH_EMAIL" = "$PROFILE2_EMAIL" && echo "PASS: health=$HEALTH_EMAIL" || echo "FAIL: expected $PROFILE2_EMAIL, got $HEALTH_EMAIL"
```

**Pass criteria:**
- `settings.json` has the switched profile ID
- After restart, `/profiles/list` shows same active profile
- `/health` shows the correct email

---

## P4: Profile Request Routing

**Verifies:** Requests use the active profile's SDK auth context.

```bash
PROFILE1_ID=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][0]['id'])")
PROFILE2_ID=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][1]['id'])")

# Switch to profile 1, send request
curl -s -X POST http://127.0.0.1:3456/profiles/active \
  -H "Content-Type: application/json" -d "{\"profile\":\"$PROFILE1_ID\"}" > /dev/null

curl -s -X POST http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-profile-p4a" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"stream":false,
       "messages":[{"role":"user","content":"say ok"}]}' > /dev/null

LOG_P1=$(cat /tmp/proxy-e2e.log 2>/dev/null | strings | grep 'e2e-profile-p4a' | grep '\[PROXY\]' | head -1)
echo "Profile 1 request: $LOG_P1"

# Switch to profile 2, send request
curl -s -X POST http://127.0.0.1:3456/profiles/active \
  -H "Content-Type: application/json" -d "{\"profile\":\"$PROFILE2_ID\"}" > /dev/null

curl -s -X POST http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-profile-p4b" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"stream":false,
       "messages":[{"role":"user","content":"say ok"}]}' > /dev/null

LOG_P2=$(cat /tmp/proxy-e2e.log 2>/dev/null | strings | grep 'e2e-profile-p4b' | grep '\[PROXY\]' | head -1)
echo "Profile 2 request: $LOG_P2"

# Both should have returned 200 (no errors)
test -n "$LOG_P1" && test -n "$LOG_P2" && echo "PASS: both profiles handled requests" || echo "FAIL: missing log lines"
```

**Pass criteria:**
- Both requests return 200
- Proxy log shows both requests processed

---

## P5: Profile Per-Request Header Override

**Verifies:** `x-meridian-profile` header routes a single request to a different profile without changing the active profile.

```bash
PROFILE1_ID=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][0]['id'])")
PROFILE2_ID=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][1]['id'])")

# Set active to profile 1
curl -s -X POST http://127.0.0.1:3456/profiles/active \
  -H "Content-Type: application/json" -d "{\"profile\":\"$PROFILE1_ID\"}" > /dev/null

# Send request with header override to profile 2
curl -sf -X POST http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: dummy" \
  -H "x-meridian-profile: $PROFILE2_ID" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"stream":false,
       "messages":[{"role":"user","content":"say ok"}]}' > /dev/null \
  && echo "PASS: header override request succeeded" || echo "FAIL: request failed"

# Active profile should still be profile 1
ACTIVE=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['activeProfile'])")
test "$ACTIVE" = "$PROFILE1_ID" && echo "PASS: active unchanged=$ACTIVE" || echo "FAIL: active changed to $ACTIVE"
```

**Pass criteria:**
- Override request returns 200
- Active profile remains unchanged

---

## P6: Profile Session Isolation

**Verifies:** The same conversation messages on different profiles create separate SDK sessions (no cross-profile resume).

```bash
PROFILE1_ID=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][0]['id'])")
PROFILE2_ID=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][1]['id'])")
MSGS='[{"role":"user","content":"session isolation test e2e-p6"}]'

# Request on profile 1
curl -s -X POST http://127.0.0.1:3456/profiles/active \
  -H "Content-Type: application/json" -d "{\"profile\":\"$PROFILE1_ID\"}" > /dev/null

curl -s -X POST http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: dummy" \
  -d "{\"model\":\"claude-haiku-4-5-20251001\",\"max_tokens\":10,\"stream\":false,\"messages\":$MSGS}" > /dev/null

# Same messages on profile 2 — should be lineage=new, NOT continuation
curl -s -X POST http://127.0.0.1:3456/profiles/active \
  -H "Content-Type: application/json" -d "{\"profile\":\"$PROFILE2_ID\"}" > /dev/null

curl -s -X POST http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: dummy" \
  -d "{\"model\":\"claude-haiku-4-5-20251001\",\"max_tokens\":10,\"stream\":false,\"messages\":$MSGS}" > /dev/null

# Both requests should show session=new in the proxy log (not continuation)
# The last 2 request log lines should both be fresh sessions
COUNT=$(tail -10 /tmp/proxy-e2e.log 2>/dev/null | strings | grep '\[PROXY\].*adapter=.*session=new' | tail -2 | wc -l | tr -d ' ')
test "$COUNT" -ge 2 && echo "PASS: both requests got fresh sessions" || echo "FAIL: expected 2 session=new lines, got $COUNT"
```

**Pass criteria:**
- Second request (profile 2) shows `session=new` in proxy log, NOT `lineage=continuation`

---

## P7: Profile Invalid Profile Rejection

**Verifies:** Switching to a nonexistent profile returns 400. Invalid persisted profile is handled gracefully on restart.

```bash
# Try to switch to nonexistent profile
RES=$(curl -s -X POST http://127.0.0.1:3456/profiles/active \
  -H "Content-Type: application/json" -d '{"profile":"nonexistent_profile_xyz"}')
STATUS=$(echo "$RES" | python3 -c "import json,sys; print('error' if 'error' in json.load(sys.stdin) else 'success')")
test "$STATUS" = "error" && echo "PASS: nonexistent profile rejected" || echo "FAIL: expected error, got $RES"

# Write invalid profile to settings.json, restart, verify fallback
ORIG=$(cat ~/.config/meridian/settings.json)
echo '{"activeProfile":"does_not_exist_abc"}' > ~/.config/meridian/settings.json

kill $(lsof -ti :3456) 2>/dev/null; sleep 1
MERIDIAN_PORT=3456 bun run ./bin/cli.ts &
sleep 3

# Should fall back to first profile, not crash
ACTIVE=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['activeProfile'])")
HEALTH=$(curl -s http://127.0.0.1:3456/health | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
test "$HEALTH" = "healthy" && echo "PASS: proxy healthy after invalid profile (active=$ACTIVE)" || echo "FAIL: proxy unhealthy"

# Restore
echo "$ORIG" > ~/.config/meridian/settings.json
```

**Pass criteria:**
- Switch to nonexistent profile returns error response (not 200)
- Proxy starts healthy with invalid `settings.json`; falls back to first profile

---

## P8: Profile Settings Persistence

**Verifies:** `settings.json` is updated when profile is switched; CLI `meridian profile list` shows correct state.

```bash
PROFILE2_ID=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][1]['id'])")

# Switch via API
curl -s -X POST http://127.0.0.1:3456/profiles/active \
  -H "Content-Type: application/json" -d "{\"profile\":\"$PROFILE2_ID\"}" > /dev/null

# Verify settings.json
SAVED=$(python3 -c "import json; print(json.load(open('$HOME/.config/meridian/settings.json'))['activeProfile'])")
test "$SAVED" = "$PROFILE2_ID" && echo "PASS: settings.json=$SAVED" || echo "FAIL: expected $PROFILE2_ID, got $SAVED"

# Verify CLI shows profiles (non-interactive, just list)
meridian profile list 2>&1 | grep -q "$PROFILE2_ID" && echo "PASS: CLI shows profile" || echo "FAIL: CLI missing profile"
```

**Pass criteria:**
- `settings.json` contains the switched profile ID
- `meridian profile list` output includes the profile

---

## P9: Profile Health Reflects Active

**Verifies:** `/health` endpoint email changes when active profile changes.

```bash
PROFILE1_ID=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][0]['id'])")
PROFILE2_ID=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][1]['id'])")
PROFILE1_EMAIL=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][0]['email'])")
PROFILE2_EMAIL=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][1]['email'])")

curl -s -X POST http://127.0.0.1:3456/profiles/active \
  -H "Content-Type: application/json" -d "{\"profile\":\"$PROFILE1_ID\"}" > /dev/null
E1=$(curl -s http://127.0.0.1:3456/health | python3 -c "import json,sys; print(json.load(sys.stdin)['auth']['email'])")

curl -s -X POST http://127.0.0.1:3456/profiles/active \
  -H "Content-Type: application/json" -d "{\"profile\":\"$PROFILE2_ID\"}" > /dev/null
E2=$(curl -s http://127.0.0.1:3456/health | python3 -c "import json,sys; print(json.load(sys.stdin)['auth']['email'])")

test "$E1" = "$PROFILE1_EMAIL" && test "$E2" = "$PROFILE2_EMAIL" && test "$E1" != "$E2" \
  && echo "PASS: health switches ($E1 → $E2)" \
  || echo "FAIL: expected $PROFILE1_EMAIL/$PROFILE2_EMAIL, got $E1/$E2"
```

**Pass criteria:**
- Health email matches profile 1 email after switching to profile 1
- Health email matches profile 2 email after switching to profile 2
- The two emails are different

---

## P10: Profile Telemetry Records After Switch

**Verifies:** Requests on both profiles appear in telemetry.

```bash
PROFILE1_ID=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][0]['id'])")
PROFILE2_ID=$(curl -s http://127.0.0.1:3456/profiles/list | python3 -c "import json,sys; print(json.load(sys.stdin)['profiles'][1]['id'])")

# Note starting request count
BEFORE=$(curl -s 'http://127.0.0.1:3456/telemetry/requests?limit=100' | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")

# Request on profile 1
curl -s -X POST http://127.0.0.1:3456/profiles/active \
  -H "Content-Type: application/json" -d "{\"profile\":\"$PROFILE1_ID\"}" > /dev/null
curl -s -X POST http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: dummy" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"stream":false,
       "messages":[{"role":"user","content":"telemetry test p10a"}]}' > /dev/null

# Request on profile 2 (streaming)
curl -s -X POST http://127.0.0.1:3456/profiles/active \
  -H "Content-Type: application/json" -d "{\"profile\":\"$PROFILE2_ID\"}" > /dev/null
curl -s -N -X POST http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: dummy" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"stream":true,
       "messages":[{"role":"user","content":"telemetry test p10b"}]}' > /dev/null

sleep 1

# Should have 2 more requests
AFTER=$(curl -s 'http://127.0.0.1:3456/telemetry/requests?limit=100' | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
NEW=$((AFTER - BEFORE))
test "$NEW" -ge 2 && echo "PASS: $NEW new telemetry records (non-stream + stream)" || echo "FAIL: expected >=2 new records, got $NEW"

# Verify both modes present
curl -s 'http://127.0.0.1:3456/telemetry/requests?limit=5' | python3 -c "
import json, sys
reqs = json.load(sys.stdin)
modes = {r['mode'] for r in reqs[:5]}
assert 'stream' in modes or 'non-stream' in modes, f'unexpected modes: {modes}'
print(f'Modes seen: {modes}  PASS')
"
```

**Pass criteria:**
- At least 2 new telemetry request records after the two requests
- Both streaming and non-streaming modes recorded

---

## E32: Tool-use leak (#416) — opencode + opus-4-7

**Verifies:** When the opencode adapter (User-Agent `opencode/<version>`) sends a multi-turn request whose history contains real `tool_use` and `tool_result` content blocks, opus-4-7's response does **not** contain leaked text patterns like `[Tool Use: name(args)]`, `[Tool Result for toolu_...:]`, `H:`, `Human:` or `Assistant:` line prefixes.

The original report ([#416](https://github.com/rynfar/meridian/issues/416)) saw opus-4-7 emitting these strings as visible chat content while opus-4-6 and sonnet-4-6 did not — opus-4-7 is more sensitive to context patterns, so any leak in the rehydration prompt got mimicked back. The fix landed across SDK upgrade (#431) + cli.js refresh + the existing tool-flatten guard from #386.

**Why opencode-specific:** the opencode-with-claude wrapper hits this path more often because it forwards full message history on every turn — Meridian's `buildFreshPrompt` then runs whenever the SDK session is lost. Other adapters (pi, droid, crush) trigger the same code path but the user only reported it on opencode + opus-4-7.

### Setup

```bash
# Proxy must be running on port 3456 with personal/working profile auth
curl -s http://127.0.0.1:3456/health | jq .auth.loggedIn   # → true
```

### Reproduce the original symptom shape

Send a multi-turn request that mirrors the user's stack: opencode UA, opus-4-7, history containing real `tool_use` blocks (the model has no SDK session for this conversation yet, so `buildFreshPrompt` runs).

```bash
cat > /tmp/e2e-416-body.json <<'EOF'
{
  "model": "claude-opus-4-7",
  "max_tokens": 800,
  "stream": false,
  "messages": [
    {"role": "user", "content": "create a todo list with 3 items: A, B, C"},
    {"role": "assistant", "content": [
      {"type": "text", "text": "I will create the todo list now."},
      {"type": "tool_use", "id": "toolu_001", "name": "todowrite",
       "input": {"todos": [
         {"content": "A", "status": "pending"},
         {"content": "B", "status": "pending"},
         {"content": "C", "status": "pending"}
       ]}}
    ]},
    {"role": "user", "content": [
      {"type": "tool_result", "tool_use_id": "toolu_001", "content": "Wrote 3 todos."}
    ]},
    {"role": "assistant", "content": "Done. 3 items added."},
    {"role": "user", "content": "Reply with the todo names as a JSON array. Just the array, no tool calls."}
  ]
}
EOF

RESP=$(curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: opencode/1.14.20" \
  -d @/tmp/e2e-416-body.json)

# Extract assistant text only (ignore tool_use blocks)
TEXT=$(echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
parts = [b.get('text','') for b in d.get('content', []) if b.get('type') == 'text']
print(''.join(parts))
")

echo "=== model output ==="
echo "$TEXT"
echo "=== leak checks ==="
echo "  [Tool Use:    $(echo "$TEXT" | grep -c '\[Tool Use:')"
echo "  [Tool Result: $(echo "$TEXT" | grep -c '\[Tool Result')"
echo "  H: prefix:    $(echo "$TEXT" | grep -cE '(^|\n)H: ')"
echo "  Human: prefix:$(echo "$TEXT" | grep -cE '(^|\n)Human:')"
echo "  Assistant: prefix:$(echo "$TEXT" | grep -cE '(^|\n)Assistant:')"
```

**Pass criteria (all five counts must be 0):**
- `[Tool Use:` count = 0
- `[Tool Result` count = 0
- `H:` line prefix count = 0
- `Human:` line prefix count = 0
- `Assistant:` line prefix count = 0
- Response text is the actual answer (e.g. `["A", "B", "C"]`), not a flattened transcript

### Aggressive variant — long history with multiple tool_use turns

Triggers `buildFreshPrompt` over a longer history that more closely resembles the user's reported scenario (todowrite progression across many turns). Run this if the basic case passes but you suspect leaks under longer rehydration.

```bash
# Construct an 11-message history with 3 tool_use rounds
cat > /tmp/e2e-416-aggressive.json <<'EOF'
{
  "model": "claude-opus-4-7",
  "max_tokens": 1500,
  "stream": false,
  "messages": [
    {"role": "user", "content": "Track these 4 tasks via todowrite: locate code, analyze logic, modify file, verify build."},
    {"role": "assistant", "content": [
      {"type": "text", "text": "Creating todo list."},
      {"type": "tool_use", "id": "toolu_a", "name": "todowrite",
       "input": {"todos": [
         {"content":"locate code","status":"pending"},
         {"content":"analyze logic","status":"pending"},
         {"content":"modify file","status":"pending"},
         {"content":"verify build","status":"pending"}
       ]}}
    ]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_a", "content": "Created."}]},
    {"role": "assistant", "content": [
      {"type": "text", "text": "Working on the first item."},
      {"type": "tool_use", "id": "toolu_b", "name": "todowrite",
       "input": {"todos": [
         {"content":"locate code","status":"in_progress"},
         {"content":"analyze logic","status":"pending"},
         {"content":"modify file","status":"pending"},
         {"content":"verify build","status":"pending"}
       ]}}
    ]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_b", "content": "Updated."}]},
    {"role": "assistant", "content": [
      {"type": "text", "text": "First item complete, moving on."},
      {"type": "tool_use", "id": "toolu_c", "name": "todowrite",
       "input": {"todos": [
         {"content":"locate code","status":"completed"},
         {"content":"analyze logic","status":"in_progress"},
         {"content":"modify file","status":"pending"},
         {"content":"verify build","status":"pending"}
       ]}}
    ]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_c", "content": "Updated."}]},
    {"role": "user", "content": "What status are the four tasks in right now? Reply as a numbered list, no tool calls."}
  ]
}
EOF

RESP=$(curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: opencode/1.14.20" \
  -d @/tmp/e2e-416-aggressive.json)

TEXT=$(echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
parts = [b.get('text','') for b in d.get('content', []) if b.get('type') == 'text']
print(''.join(parts))
")

echo "=== model output (first 1500 chars) ==="
echo "${TEXT:0:1500}"
echo "=== leak checks (all should be 0) ==="
for pat in '\[Tool Use:' '\[Tool Result' '(^|\n)H: ' '(^|\n)Human:' '(^|\n)Assistant:'; do
  count=$(echo "$TEXT" | grep -cE "$pat")
  echo "  $pat: $count"
done
```

**Pass criteria:** all five leak counts = 0; the answer is a numbered list of the 4 tasks with their actual statuses (completed / in_progress / pending).

### Cleanup

```bash
rm -f /tmp/e2e-416-body.json /tmp/e2e-416-aggressive.json
```

### Why this isn't fully covered by unit tests

The existing regression test in `src/__tests__/proxy-tool-flattening-regression.test.ts` (issue #386) verifies the SDK **prompt** contains no `[Tool Use:` strings. That's necessary but not sufficient for #416 — the symptom there was the **model's response** containing those strings, picked up from context patterns the model imitates. Only a live model can verify that opus-4-7 doesn't mimic the rehydration format. The unit test guards Meridian's prompt construction; this E2E guards the model's actual behavior on the user's stack.

---

## E33: OpenAI Compat: system prompt, no preset

**Verifies:** A generic OpenAI client (Open WebUI, curl) hitting `POST /v1/chat/completions` with a `system` message has that prompt honoured directly, **without** the ~28KB `claude_code` preset being injected on top. The internal hop is tagged `x-meridian-agent: openai`, selecting the `openai` adapter whose `codeSystemPrompt` defaults OFF (mirrors the passthrough precedent, #190). Regression guard for the #526 investigation.

```bash
curl -s http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 40,
    "messages": [
      {"role": "system", "content": "You are Aristotle, a philosophy tutor. You are NOT a coding assistant. In one short sentence, state who you are."},
      {"role": "user", "content": "Who are you?"}
    ]
  }' | python3 -m json.tool
```

**Pass criteria:**
- Response reflects the client system prompt (e.g. "I am Aristotle, a philosophy tutor.")
- Proxy log shows `adapter=openai` for the inner hop (not `adapter=opencode`)
- No Claude Code persona / tool-instruction leakage in the reply

**To confirm the preset is actually gone** (the deterministic check), set `codeSystemPrompt` for the `openai` adapter and observe the difference, or rely on the unit test `src/__tests__/proxy-openai-compat.test.ts` → "sends the client system prompt verbatim, without the claude_code preset", which asserts the SDK receives a plain-string `systemPrompt` rather than a `{type: "preset", preset: "claude_code"}` object.

**What's being tested:** `openAiAdapter` (`adapters/openai.ts`), the `x-meridian-agent: openai` tag on the internal hop (`server.ts`), and `ADAPTER_DEFAULTS.openai = { codeSystemPrompt: false }` (`sdkFeatures.ts`).


## E34: Streaming parallel tool calls (#552)

**Automated** — the one E2E that is a single command:

```bash
bun scripts/e2e-stream-parallel.mjs                    # 3 attempts (default)
E2E_ATTEMPTS=5 bun scripts/e2e-stream-parallel.mjs
E2E_WIDE=1 bun scripts/e2e-stream-parallel.mjs         # #742 window (see below)
```

**`E2E_WIDE=1` — the #742 ordering.** The default prompt produces three
short-argument calls that close in one delta each, so the deny-before-block-close
window never opens: the run reports **INCONCLUSIVE for #742** rather than a
pass, because clean assertions over an ordering that never occurred prove
nothing. `E2E_WIDE=1` adds a fourth call carrying a multi-KB free-text argument
— the shape from the original report (a ~2.9 KB subagent prompt) — which keeps
one block streaming while an earlier call's deny settles. That hit the race on
**6 of 6** attempts.

The run also watches Meridian's own diagnostics, not just the wire:

| signal | meaning |
|---|---|
| `dangling_blocks_closed` / `early_stop` | the race FIRING — the bug's signature |
| `passthrough.early_stop_deferred` | the fix ENGAGING — race occurred, handled |

Requiring at least one deferral is what makes a green run evidence instead of
absence. Verified by reverting the fix and re-running the same scenario:

```
✗ tool task has EMPTY input (the '{} Tool execution aborted' render)
   widest tool input: 29 bytes across 4 calls      # vs 5259-6418 with the fix
```

Note the envelope marker did **not** fire in that failing run. The framing
stayed valid throughout — only the payload assertion caught it. That is exactly
why #675 mis-triaged this same race as "client impact: none".

**Why this exists:** the CLI dispatches PreToolUse hooks per-block while later
parallel blocks are still generating, and a deny landing mid-generation makes
the CLI cancel the in-flight request — beheading trailing parallel calls. The
client renders the cut block as an argument-less `tool {}` "Tool execution
aborted" (the #552 "red read"), the session store is skipped, and the model
loops. No mocked suite reproduced this dispatch ordering: v1.49.0 and v1.49.1
both shipped with "verified" fixes that failed in the field within hours.
This script runs the REAL CLI through the REAL proxy in SSE mode and asserts
the actual client contract.

**Pass criteria** (all attempts):
- ≥2 parallel tool_use blocks reach the client, every block terminated
- every tool input is complete, parseable JSON (no `{}`)
- exactly one `message_stop`
- the instant follow-up does not re-issue identical calls (session resumed)

**What's being tested:** deny-hold (`holdDenyUntilTurnEnd`), early stop +
drain, `flushOpenClientBlocks`, `pendingSessionStores` (`server.ts`);
`passthroughEarlyStop.ts`.

## E35: SDK boundary assumptions (#694/#708/#710)

**Automated** — one command:

```bash
bun scripts/e2e-sdk-boundary.mjs
SDK_BOUNDARY_MODEL=claude-sonnet-5 bun scripts/e2e-sdk-boundary.mjs
```

**Why this exists:** three bugs shipped through this seam in one week, and the
unit suite was green for all three — because a mocked suite can only assert
what we already thought to look for.

- **#708** — the SDK reports `resetsAt` in epoch *seconds*. Every fixture used
  milliseconds, so the mismatch was unobservable and tier 1 of the priority
  cooldown was dead code for its entire life.
- **#710** — `thinking` blocks fell into the lineage hash's
  serialize-everything fallback, folding an encrypted per-generation signature
  into the hash. There was no thinking-block test at all.
- **#694** — the `claude_code` preset injects a gitStatus block claiming to be
  "the git status at the start of the conversation" and recomputes it every
  turn. A user was told the model had destroyed their work-in-progress files.

Each was found by watching real traffic. This script makes that watching
repeatable instead of a fresh throwaway probe each time.

**Pass criteria:**
- every `resetsAt` / `overageResetsAt` lands between now and 8 days out —
  bounded *both* ways, so a missed `*1000` (1970) and a double one (year 58000)
  both fail, and the check stays valid if the SDK ever switches units
- every content-block type observed in live traffic is in one of the three
  hashing buckets in `messages.ts`
- a session whose client stops echoing thinking blocks still logs
  `lineage=continuation`, not a fresh replay
- a check that cannot gather its evidence **fails** rather than passing quietly
  (no rate-limit bucket, no content blocks, missing lineage verdicts)

**Informational, not asserted:** check 4 asks the model whether the gitStatus
block still claims to describe the conversation's start. It is reported rather
than asserted because a model declining to answer must not fail a release. When
it reports the block is gone or honestly labelled, `GIT_STATUS_PROVENANCE_NOTE`
in `query.ts` can be removed.

**Calibrated, not assumed.** Both hard checks were verified to fail against the
real bugs by reverting each fix and re-running:

```
✗ units: five_hour.resetsAt=1785404400 is in the past (1970-01-21…) — seconds treated as ms?
✗ lineage: third turn was lineage=new, expected continuation — dropped thinking blocks churned the hash (#710)
```

**What's being tested:** `toEpochMs` / `RateLimitStore.record`
(`rateLimitStore.ts`); `normalizeContent` block classification (`messages.ts`);
`hashMessage` / `verifyLineage` (`session/lineage.ts`);
`GIT_STATUS_PROVENANCE_NOTE` (`query.ts`).

**Static counterpart:** `sdk-block-type-coverage.test.ts` reads the
`ContentBlockParam` union out of the installed SDK and fails when a new block
type appears in none of the three buckets — so the next `thinking` is caught by
CI on the dependency bump rather than by a user.

## E36: Client detection after an upgrade (#733)

**Automated**, and costs **no tokens** — every request is answered by a local
stub and never forwarded upstream:

```bash
bun scripts/e2e-client-detection.mjs            # check for drift
bun scripts/e2e-client-detection.mjs --update   # re-record the fixture
```

**Why this exists:** Meridian picks an adapter from request headers, so a client
changing what it sends silently reroutes it — and nothing fails.

Crush 0.87 added `x-session-affinity`, which detection checked ahead of the
User-Agent chain, so every Crush request resolved to the **OpenCode** adapter:
OpenCode's transforms, tool config, MCP server name and CWD extraction applied
to a client with its own. Then fixing the detection made it *worse*, because
`openCodeAdapter.getSessionId` falls back to that same header — Crush had been
getting keyed sessions by accident, and correct detection downgraded it to
fingerprint-only continuity, looping until timeout.

That was found by upgrading a client and running one turn. No user would connect
"sessions feel wrong" to header precedence, and no unit test can watch a client
change its headers.

**Pass criteria:**
- every installed client resolves to the adapter recorded in
  `src/__tests__/fixtures/client-headers.json`
- a client that never reaches the capture server **fails** rather than being
  silently skipped — silence is not success
- an uninstalled client is skipped with a note, so the script is runnable on a
  machine that has only some clients

**Also reported, not failed:** headers added or removed since the recorded
capture, and User-Agent changes. A new header is exactly how #733 started, one
release before it did damage — so it is surfaced even while detection is still
correct.

**Adding a client:** one entry in the `CLIENTS` table (how to write its config
and run one turn), then `--update`.

**Static counterpart:** `client-detection-fixtures.test.ts` pins detection
against the same captured header sets, so a change to detection ORDERING fails
in CI without needing any client installed. Verified: reintroducing #733 fails
that test *and* the live script.

**Note on the fixtures:** they are real captures, not hand-written. Both
opencode 1.18.9 and crush 0.87 send `x-session-affinity` **and** `x-session-id`
— which is why one of the tests asserts, as a property, that a shared session
header can never be what distinguishes two clients.

## E37: WebFetch preflight scope (#748)

**Automated**, and costs **no tokens** — `claude` is replaced by a stub that
records its argv, and `HOME` is redirected to a temp dir so the run cannot
touch your real `~/.config/meridian/sdk-features.json`:

```bash
bun scripts/e2e-webfetch-preflight.mjs
```

**Why this exists:** the WebFetch Preflight toggle has two independent failure
modes, and only the first is obvious.

The first is routing: `webFetchPreflight: false` on one adapter must produce
`skipWebFetchPreflight: true` in *that* adapter's spawn and no other. The value
is threaded through six separate `buildQueryOptions` call sites in `server.ts`,
which is exactly the shape where one gets missed and the toggle appears to work
because you only ever tested the streaming path.

The second is scope, and it is the one that misleads users. The preflight lives
inside the SDK's built-in `WebFetch`, so the setting only changes behaviour
where the subprocess can invoke that tool. Every adapter but `cherry` prevents
it — passthrough modes send `--tools` empty (the SDK's "disable all built-ins")
and internal modes list `WebFetch` in `--disallowed-tools`. Cherry unblocks the
built-in web tools so Claude can browse for itself (#481), making it the only
adapter where the toggle does anything. A toggle that silently does nothing on
the adapter you flipped it on is worse than no toggle: you believe the hostname
stopped leaving your network when it never was.

**Pass criteria:**
- `cherry` + `webFetchPreflight:false` → `skipWebFetchPreflight:true` in argv
- `cherry` unset → `skipWebFetchPreflight:false` (default matches the
  subprocess default — an omitted key would silently re-enable the check, the
  #634 failure mode)
- `opencode` + `webFetchPreflight:false` → the setting still routes, but the
  spawn cannot reach the built-in WebFetch, so the case is asserted **INERT**
- a case where no subprocess spawned **fails** rather than passing quietly —
  silence is not success
- the real `sdk-features.json` is byte-identical before and after

**The scope assertion is deliberate.** `builtinWebFetch` is checked per case
against what `docs/configuration.md` promises. If a future tool-config change
lets another adapter run the built-in WebFetch, this fails with a pointer to
the docs — otherwise the scope note rots and users keep turning off a check
that is still running.

**Verified:** 2026-08-03. Mutation-tested both ways — flipping
`DEFAULT_FEATURES.webFetchPreflight` to `false` fails the default case, and
removing `cherry` from `ADAPTER_LABELS` fails the static counterpart in
`sdk-features-unit.test.ts`.

**Static counterpart:** the `WebFetch preflight scope` block in `query.test.ts`
pins the same three adapter shapes at the `buildQueryOptions` level, so tool
config drift fails in CI without starting a proxy.

## E38: Silent turns (#768)

**Automated**, costs real tokens (two turns per attempt, plus one per silence
the recovery repairs):

```bash
bun scripts/e2e-silent-turn.mjs
E2E_ATTEMPTS=10 bun scripts/e2e-silent-turn.mjs

# The pair that actually proves the guard, on demand:
MERIDIAN_DEBUG_FORCE_SILENT_TURN=1 MERIDIAN_SILENT_TURN_RECOVERY=0 bun scripts/e2e-silent-turn.mjs  # FAILS
MERIDIAN_DEBUG_FORCE_SILENT_TURN=1 bun scripts/e2e-silent-turn.mjs                                  # passes
```

**Why this exists:** three separate defects have now ended in the same shape —
`stop_reason: "end_turn"`, HTTP 200, `error: null`, and nothing the client can
act on. An interrupted tail, an unsettled client abort, a spent deny at the
boundary seam. Each was found by reading a transcript after the fact; each
mocked suite stayed green while the field kept breaking.

They have nothing in common except their outcome, so the outcome is what this
measures. Every turn is asked one question — did the client receive text or a
tool call? — which a cause nobody has found yet fails exactly like the three
known ones.

It drives the shape all three took: a tool call, then the turn that must answer
its result, in a fresh session each attempt. Every observed silence landed on a
session's **second** turn, where the deny is the largest thing in a still-short
context.

**Fault injection, and why it is not optional.** The live rate is about three in
five hundred requests. A ten-attempt run expects 0.06 occurrences, so a green
run without injection is ambiguous — the guard works, or the defect simply did
not happen. That ambiguity is what let two earlier "verified" fixes ship broken.
`MERIDIAN_DEBUG_FORCE_SILENT_TURN=1` drops the upstream turn's text deltas while
leaving its block start and stop, which is the production signature exactly;
detection, recovery, envelope and telemetry then run for real against a real
model. Only the trigger is synthetic.

**Pass criteria:**

- every turn under test carries text or ≥1 tool call
- exactly one `message_stop` per turn
- any `error` event precedes `message_stop` — behind it, clients have already
  stopped reading and the failure is invisible
- a failed turn with no text does not claim `stop_reason: "end_turn"`
- an attempt where the model never called a tool is reported as **skipped**,
  not counted as a pass: it never reached the shape under test

**Reading the output:** `silent: 0` says the client always got an answer, not
that nothing broke upstream — `upstream: N silent turns detected, M recovered`
is where the mechanism shows itself. Compare an injected run with recovery ON
against the same run with `MERIDIAN_SILENT_TURN_RECOVERY=0`; comparing a single
recovery-ON run against nothing tells you almost nothing.

**Verified:** 2026-08-11. Injected, recovery OFF: 2/2 attempts FAIL with
`text=0 tools=0`. Injected, recovery ON: 2/2 pass, the answer arriving as real
text deltas. Uninjected, both settings: 3/3 pass, no silences — the live rate is
far below what a run this size can see, which is the whole reason injection
exists.

---

## E39: OpenCode internal-agent session key (#845)

**Verifies:** OpenCode's internal `title` agent cannot break or de-cache the
user's conversation.

OpenCode runs `title` (and `summary`, `compaction`) under the **user's** session
id, and fires it concurrently with the user's first real turn. Both requests
carried the same `x-opencode-session`, so they shared one lineage and one
per-session turn lease. Whichever arrived first committed its own conversation
under the shared key; the other was then measured against a history that was not
its own.

Mocked tests cover the key derivation and the HTTP outcome. This exists because
neither can prove OpenCode still *sends* what the fix keys on — a client upgrade
that renames or drops `x-opencode-agent-mode` / `x-opencode-agent-name` puts the
collision straight back with every suite green.

```bash
# Isolated OpenCode config. OPENCODE_CONFIG_DIR alone is NOT enough — OpenCode
# merges ~/.config/opencode/opencode.json on top of it, which drags in the real
# config's MCP servers and can hang `init` for minutes. XDG_CONFIG_HOME is what
# actually isolates it.
BASE=/tmp/e39; rm -rf $BASE; mkdir -p $BASE/{proj,cfg}
printf 'alpha\nbeta\ngamma\n' > $BASE/proj/notes.txt
cat > $BASE/cfg/opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/meridian/dist/meridian"],
  "provider": { "anthropic": { "options": { "apiKey": "dummy", "baseURL": "http://127.0.0.1:3499" } } },
  "model": "anthropic/claude-haiku-4-5",
  "small_model": "anthropic/claude-haiku-4-5"
}
JSON

MERIDIAN_TELEMETRY_PERSIST=1 MERIDIAN_TELEMETRY_DB=$BASE/t.db MERIDIAN_PORT=3499 \
  node dist/cli.js > $BASE/proxy.log 2>&1 &
sleep 6

cd $BASE/proj
export OPENCODE_CONFIG_DIR=$BASE/cfg XDG_CONFIG_HOME=$BASE/xdg
OUT=$(opencode run --model anthropic/claude-haiku-4-5 --format json \
  "Read notes.txt and report how many lines it has." 2>&1)
SID=$(echo "$OUT" | grep -o '"sessionID":"[^"]*"' | head -1 | cut -d'"' -f4)
opencode run --model anthropic/claude-haiku-4-5 --session "$SID" --format json \
  "Append a line 'delta' to notes.txt using the edit tool." >/dev/null 2>&1
opencode run --model anthropic/claude-haiku-4-5 --session "$SID" --format json \
  "Read notes.txt and list every line." >/dev/null 2>&1

grep -c session_turn_conflict $BASE/proxy.log     # → 0
grep 'agent=primary' $BASE/proxy.log | head -1    # → sessionWait=0ms, lineage=new
grep -c 'lineage=continuation' $BASE/proxy.log    # → ≥1 per later request
```

**Pass criteria:**
- No `session_turn_conflict` anywhere in the log, and no `"session advanced
  while the request was waiting"` in any turn's JSON output
- The first `agent=primary` request shows `sessionWait=0ms` — it does not queue
  behind the `agent=subagent` title request
- The title request appears with `agent=subagent` and a session key of its own
- Every request after the first carries `lineage=continuation` with a non-zero
  `cache_read`

**Verified:** 2026-08-19, OpenCode 1.18.11. Before the fix, 3/3 runs: the title
request took the lease, the user's turn waited 9,836 ms and returned HTTP 400
`session_turn_conflict`, and OpenCode reported it as a non-retryable `APIError` —
the first turn was simply lost. After: 0 conflicts, `sessionWait=0ms` on the
user's turn, and 6/6 later requests `lineage=continuation` at 83-99% cache hit.

---

## E40: Passthrough digest-turn cap

**What it proves:** that capping `maxTurns` at 1 for passthrough turns removes
the billed digest turn *without* costing the session.

**Why it needs a live SDK:** the thing under test is the SDK's own turn
accounting — when it decides a turn is finished, when it declines to start
another, and whether it still flushes its transcript on the way out. A mocked
SDK can only replay assumptions about that; this asserts them.

```bash
bun scripts/e2e-digest-turn-cap.mjs
```

**Pass criteria** (the script asserts all of these and exits non-zero on any):

- Capped, the tool call still reaches the client, the SDK stops with
  `subtype: error_max_turns`, and **no digest text is generated**
- Uncapped (`maxTurns: 3`) *does* generate digest text, costs more, and emits
  more output tokens on the identical prompt
- The capped session **resumes** at the captured assistant UUID and answers from
  the client's real `tool_result`
- A text-only turn returns `success`, not `error_max_turns`
- Parallel tool calls are all still forwarded

**Do not assert an assistant-message count.** The SDK splits one turn across
several assistant messages — a thinking message, then one per parallel tool
call — so the count tracks the model's phrasing, not turns. The digest turn's
signature is text produced *after* the tool call.

**If the resume check ever fails, take the cap off.** It is the claim #837 was
defending: a lost transcript costs a full cold replay on every tool call, which
is far worse than the digest turn the cap removes.

**Verified:** 2026-08-20, sonnet. Capped vs uncapped on one tool call:
121 vs 244 output tokens and $0.0046 vs $0.0469 (10.3x) in one run, $0.0046 vs
$0.7687 (168x) in another where the uncapped digest turn wrote a large cache
entry. Through the live proxy (E17 shape): output 306 → 144 and cache_read
12k → 4k on the tool turn. The discarded digest text was captured verbatim —
*"I attempted to read that file, but the tool call w…"* — content the client
never sees and the account is billed for.

## E41: Passthrough multi-turn: one call, one answer

**What it proves:** across dependent and parallel forwarded tool calls, the active
SDK session contains exactly one answer per delivered call — the client's real
result — and never replays the forwarding hook's denial.

**Why it needs the real SDK and several turns:** `resumeSessionAt` only trims a
suffix of the source transcript. A plain resume leaves the denial in that source,
and the CLI loader can splice it back on a later turn. Meridian therefore resumes
the assistant checkpoint with the supported `forkSession` option. The child fork
makes the replacement tail durable while the superseded source becomes dead
history. Mocked tests cannot prove the CLI loader or prompt-cache behavior.

Run the full matrix:

```bash
bun scripts/e2e-passthrough-turns.mjs
bun scripts/e2e-passthrough-turns.mjs --stream
PROBE_PARALLEL=1 bun scripts/e2e-passthrough-turns.mjs
PROBE_PARALLEL=1 bun scripts/e2e-passthrough-turns.mjs --stream
```

**Pass criteria** (asserted, non-zero exit on any):

- Chain mode returns three batches of one call; parallel mode returns one batch
  of all three calls. Eventually returning three serial calls does not pass the
  parallel gate.
- The final answer quotes all three delivered results and never claims a call
  went unanswered.
- Every result round advances to a distinct continuation session, proving the
  replacement tail was committed to a fork rather than only rewound for one
  query.
- A follow-up resumes the active fork. Supported `getSessionMessages()` output
  contains exactly one real `tool_result` for every delivered id and no
  forwarding denial for those ids.
- Every continuation, including the follow-up, reads at least 95% of the prior
  turn's `cache_read_input_tokens + cache_creation_input_tokens`.

The fixture uses a disposable SDK working directory: edits to the checkout must not change the SDK's per-query git-status context during this cache benchmark. A git-status change can invalidate the prompt cache even when the session resumes correctly.

The gate resolves Meridian's published session from its own durable store and
uses the supported Agent SDK `getSessionMessages()` API for the history check.
It does not inspect Claude's private persistence format.

**Verified:** 2026-08-27 at implementation SHA `73a966f2`, sonnet, chain and
parallel, stream and non-stream. The active fork held one real answer per
delivered call and every continuation read the prior cached prefix in full.

The same SHA also passed an actual headless OpenCode 1.18.11 gate. It performed
a real read, three parallel reads, two ordinary continuations, a supported
OpenCode revert, a post-undo continuation, and two full Meridian restarts. The
ordinary and cross-process continuations used supported SDK forks with 99–100%
cache reuse. The undo was detected as a prefix rollback and replayed into a
fresh prepared transcript with 98% cache reuse. With
`MERIDIAN_MAX_STORED_SESSIONS=1`, Meridian retained one mapping and exactly its
current and direct-predecessor transcripts. Supported SDK GC then deleted ten
retired transcripts, retained both pinned transcripts, and verified every
history only through `getSessionMessages()`.

## E42: OpenCode V2 beta compatibility

**What it proves:** the V2-native plugin separates OpenCode's primary session,
hidden title/summary work, attached compaction, and child sessions without
changing request bodies. It also proves that durable primary lineage survives
real V2 tools, a Meridian restart, undo, fork, and parallel subagents.

Validate both supported hosts, `0.0.0-beta-18314` and `0.0.0-beta-18866`.
The beta CLI can update itself, so the automated gate verifies its exact version
before and after each run and disables automatic updates. Use isolated installs:

```bash
npm install --prefix /tmp/opencode-18314 @opencode-ai/cli@0.0.0-beta-18314
npm install --prefix /tmp/opencode-18866 @opencode-ai/cli@0.0.0-beta-18866
npm run build
E2E_OPENCODE_BIN=/tmp/opencode-18314/node_modules/.bin/opencode2 bun scripts/e2e-opencode-v2-package.mjs --live --extended
E2E_OPENCODE_BIN=/tmp/opencode-18866/node_modules/.bin/opencode2 bun scripts/e2e-opencode-v2-package.mjs --live --extended
```

Without `--live`, this uses the actual client against a scripted local API. It
requires successful file reading and the exact tool result reaching the API,
continuation, detached title/summary requests, and independent fork/original
histories. `--source` runs setup from TypeScript and loads the source package.
Set `E2E_MERIDIAN_ROOT` to an independently installed `npm pack` consumer to test
the shipped package without development dependencies. Run both betas in source
and consumer modes. `--v1` with the pinned V1 `opencode@1.18.11` executable is the
V1 package compatibility control (install the `opencode-ai` npm package).

`--live --extended` routes actual client traffic through a disposable Meridian
subprocess and Claude Max. It additionally checks a true proxy process restart,
supported undo and compaction APIs, and overlapping general child sessions.
Ordinary and restart continuations must resume a distinct durable SDK fork and
read at least 95% of the previous cached prefix. The local client API uses a
fixture-only password; only its disposable directory receives extra file access.

Run `scripts/e2e-opencode-package-integrity.mjs` and again with `--manifest`,
using the same `E2E_OPENCODE_BIN`. They copy the build into a disposable install,
remove the entry or manifest, and require setup to reject it without changing
the existing configuration. This must fail against the original #924 proposal.

Use an isolated `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`,
`XDG_STATE_HOME`, project directory, and `MERIDIAN_SESSION_STORE_DIR`. The
OpenCode config must load only `dist/meridian-v2` plus the Anthropic provider
pointed at the test Meridian port. Do not use third-party plugins, MCP servers,
custom agents, or unrelated credentials for this gate.

Run this real-client sequence:

1. Start a fresh primary session while the hidden title request runs. The
   primary must answer and the proxy log must show `source=subagent-title`
   separately from `agent=primary`.
2. Continue the same OpenCode session, drive a write/read tool loop, restart
   Meridian while preserving the isolated durable store, and continue again.
3. Run `--fork --agent summary` in a disposable client fork and require
   `source=subagent-summary` with no affinity headers or primary mapping write.
   Its probe message must not enter primary client history.
4. Use V2's supported `/api/session/:id/revert/stage` and `revert/commit`
   endpoints, then continue. Meridian must log `lineage=undo` and the removed
   tool turn must not be visible.
5. Run with `--fork --session <id>`. The fork must get a different OpenCode
   session id, and a later turn on the original must not contain the fork reply.
6. Ask the primary to launch two `general` subagents in parallel. Both child
   requests must show `agent=subagent`, overlap in the proxy, and return to the
   primary without a session conflict.
7. On a persistent V2 API server, call `/api/session/:id/compact`, wait with
   `/api/session/:id/wait`, inspect the supported message API for the compaction
   summary, and continue the primary successfully.

**Pass criteria:**

- The exact V2 version is unchanged at the end of the gate.
- No `session_turn_conflict`, "session advanced while the request was waiting",
  dangling tool envelope, or plugin schema error appears.
- Title and summary are detached with their exact source names. Compaction stays
  attached but is classified as a subagent. Primary and visible child requests
  carry their trusted V2 session identities.
- Ordinary continuation reads the cached prefix; restart continuation uses the
  same durable mapping; undo logs `lineage=undo`; fork and original histories
  remain isolated.
- The packaged `dist/meridian-v2` is the plugin under test, not the TypeScript
  source or a diagnostic plugin.

**Verified:** 2026-08-27 on `0.0.0-beta-18314`. The exact pinned binary returned
`EXACTFIRST`, `EXACTCONT`, `EXACTTOOL`, `EXACTRESTART`, `EXACTSUMMARY`,
`EXACTUNDO`, `EXACTFORK`, `EXACTORIGINAL`,
`EXACTPARALLEL[ALPHA,BRAVO]`, and `EXACTAFTERCOMPACT`. The binary SHA-256 stayed
unchanged through the matrix.

## E43: Passthrough tools in a namespaced client

**What it proves:** a client whose own tool names already carry an MCP
namespace can still receive, execute, and answer a forwarded passthrough call.

**Why it needs the real SDK:** Meridian nests client tools inside its own `oc`
MCP server, so a client that aggregates MCP servers itself — a Claude Code CLI
job with an `oc` server configured, for instance — declares tools like
`mcp__oc__read` that collide with that namespace. The collision broke two
things at once, and only one of them is visible to a mocked SDK:

- **Registration.** The tool was advertised as `mcp__oc__mcp__oc__read`. On SDK
  0.2.141 / CLI 2.1.263 the CLI lists that name but never dispatches it, so the
  PreToolUse hook never fired and nothing was captured (`tools=0/1` in the
  `sdk_termination` line). Non-streaming returned HTTP 500; streaming ended
  `stop_reason: max_tokens` with an inline `error` event.
- **Delivery.** The reverse translation was a blind prefix strip, so the leaked
  tool_use reached the client renamed to `read` — a tool it never declared.

Either half breaks the promise the forwarding hook makes to the model ("the
result will be delivered in a future turn"): a client cannot answer a call it
does not recognize, so that turn never comes, and a coordinator watching the
stalled job re-dispatches it (#967).

```bash
bun scripts/e2e-passthrough-namespaced-tools.mjs
bun scripts/e2e-passthrough-namespaced-tools.mjs --stream
PROBE_MODEL=claude-opus-5 bun scripts/e2e-passthrough-namespaced-tools.mjs
PROBE_MODEL=claude-opus-5 bun scripts/e2e-passthrough-namespaced-tools.mjs --stream
```

**Pass criteria** (asserted per tool shape and response mode, non-zero exit on any):

- The call is dispatched and captured: `stop_reason: tool_use`, exactly one
  tool_use block, no error event.
- The delivered name is byte-identical to what the client declared, and its
  arguments survive.
- Replaying that call's real `tool_result` yields an answer quoting the
  fixture's content, and the answer never claims the call went unanswered.
- The ordinary (`read`) and foreign-namespace (`mcp__zed__read`) controls pass
  in the same process, so a green run cannot come from a dead proxy.

The fixture uses a deliberately short `/tmp` path. Under macOS `mkdtemp`, Opus
truncates a `/private/var/folders/...`-length path in its own tool argument and
says so in its reply — a model artifact that would fail the argument check for a
reason unrelated to what this gate measures.

**Verified:** 2026-09-08 on the fix branch, SDK 0.2.141 / bundled CLI 2.1.259 /
system CLI 2.1.263. All four combinations passed: haiku and `claude-opus-5`,
streaming and non-streaming, subject plus both controls. Against the same commit
without the fix, the subject shape returned HTTP 500 non-streaming and delivered
`read` with `stop_reason: max_tokens` streaming.

## E44: Tier refusal failover

**What it proves:** a credits-era per-tier refusal is classified as a rate limit
and priority routing really moves the request to a healthy profile.

**Why unit tests were not enough.** `classifyError` returned
`rate_limit_error` for the banner as quoted in #962 while the live request still
returned 500 and failed nothing over. The reason is that an API-key or gateway
profile never delivers the banner bare — the SDK splices the upstream status in
front of it:

```
Claude Code returned an error result: API Error: 400 You've reached your Fable limit. Switch to another model to continue.
```

That numeric status sat between the accepted wrappers and the banner and
defeated the line anchor for *every* suffix, including the two that already
worked. Only driving the real failover path surfaced it.

```bash
bun scripts/e2e-tier-refusal-failover.mjs
bun scripts/e2e-tier-refusal-failover.mjs --stream
```

**Pass criteria** (asserted, non-zero exit on any):

- A pre-flight check that the banner classifies as `rate_limit_error` and that
  the type is a failover trigger, so a classifier regression is named as such
  rather than surfacing as a confusing routing failure.
- The real CLI reaches the refusal upstream on every case — a cooldown carried
  over from the previous case cannot let a run skip straight to the fallback.
- Exactly one refused attempt, recorded against the refusing profile with
  status **429**, not 500.
- HTTP 200 overall, exactly one served row, served by the healthy profile, and
  the real Claude Max fallback answers with the run's receipt string.

**What is stubbed, and why that is acceptable.** The refusal is a local fixture
upstream: producing this banner for real means exhausting a real Fable tier on
a real account, which a gate cannot do on demand. The **fallback leg is real** —
a live Claude Max profile answering a live prompt — so what is stubbed is the
condition we cannot cause, not the behavior under test.

**Verified:** 2026-09-08. Both modes pass. Against the contributor's suffix fix
alone the gate fails with the refused attempt recorded 500 and no failover,
which is what identified the missing status allowance.

## E45: Codex auto-defer

**What it proves:** a Codex request past the auto-defer threshold keeps its
tools loaded, and `exec_command` in particular does not have to be discovered
before it can be used.

**Why it needs the real SDK.** `codexTransforms` runs after the shared OpenCode
transform and inherited its `coreToolNames`
(`read, write, edit, bash, glob, grep`). Codex sends none of those names, so
once a session crossed the threshold — trivial for Codex, which inlines every
MCP namespace's tool definitions — the core set matched nothing and **every**
tool was deferred, `exec_command` included. Live pre-fix diagnostic:

```
deferred=40/40 tools (core: read,write,edit,bash,glob,grep)
discovered=1 (exec_command) session_total=1
```

Deferral also has a second cost: `computePassthroughMaxTurns` only returns the
single-turn cap when `singleTurnHandoff` holds, and that requires
`!hasDeferredTools` — so turning deferral on lifted the cap from 1 to 4 and let
the SDK's discarded digest turn generate on the full context.

```bash
bun scripts/e2e-codex-auto-defer.mjs
```

**Pass criteria** (asserted, non-zero exit on any):

- No `deferred=` diagnostic. That line is the observable for
  `hasDeferredTools`, which is what moves the turn cap.
- No `discovered=` diagnostic — `exec_command` is loaded directly rather than
  costing a ToolSearch round trip.
- HTTP 200, at least one `function_call` returned, and one of them named
  `exec_command`. These are regression guards, not discriminators: they pass
  before and after, and exist so a "fix" that merely made the prompt cheaper
  while breaking Codex would still fail.

**What this gate does NOT prove.** The digest-turn cost is real but
scale-dependent — #963 measured 2–3× cache reads per turn on a 680k-token
session, and a 40-tool probe on a short prompt does not reliably provoke the
extra turn. The model-call count is therefore reported, not asserted, so the
gate does not carry a check that looks meaningful and discriminates nothing.

**Verified:** 2026-09-08. Against pre-fix code the first two checks fail with
the diagnostics quoted above; with the fix all five pass.

## E46: Codex namespace and MCP tools

**What it proves:** a Codex session's MCP tools reach Claude, its calls come
back in a form Codex can route, and a turn replaying an MCP result succeeds.

**The shapes were taken from a real capture, not from docs.** codex-cli 0.153.4
was pointed at a recording endpoint with an actual stdio MCP server attached.
It sent 13 top-level tool entries: 10 flat `function`, one `web_search`, and
**2 `namespace` entries holding 7 nested tools**. Feeding that captured request
through the pre-fix translator, 10 tools reached Claude and all 7 namespaced
ones vanished — including Codex's own `multi_agent_v1` namespace
(`spawn_agent`, `wait_agent`, …), so sub-agents were unavailable, not just the
user's MCP server.

```bash
bun scripts/e2e-codex-namespace-tools.mjs
bun scripts/e2e-codex-namespace-tools.mjs --stream
```

**Pass criteria** (asserted, non-zero exit on any):

- The flattened client tool count reaches Claude (`tools=4` for the fixture:
  one flat plus three nested; `web_search` is correctly dropped, having no
  client-side counterpart).
- A `function_call` comes back named as Codex declared it and **carrying its
  `namespace`**. Codex's router resolves `ToolName::new(namespace, name)`, so a
  flattened name is silently unroutable — the call looks fine and never
  dispatches.
- A follow-up turn whose `function_call_output.output` is an **array of content
  items** returns 200 and the model answers from it. MCP tools return arrays;
  passed verbatim they reach Anthropic as `tool_result.content[0].type =
  "input_text"` and 400, killing every turn after an MCP call.

**Harness note.** In streaming, `function_call` arguments arrive as their own
delta events and the completed item can carry an empty `arguments`. The gate
accumulates them before replaying turn 2 — without that it replays an
argument-less call, the model simply calls the tool again, and the run looks
like a broken emitter when the emitter is fine.

**Not covered.** Codex's freeform `apply_patch` (`{type:"custom", format:
{grammar}}`) did not appear in a default-config capture, so the custom-tool
path is covered by unit tests only and is **not** live-verified here.

**Verified:** 2026-09-08, both modes. Against pre-fix code the same gate fails
with `tools=1` and no call returned.

## E47: Codex thread identity

**What it proves:** a Codex conversation keeps its own SDK session when a
sibling flow shares its `prompt_cache_key`.

**The metadata was verified against a real capture**, not read from docs.
codex-cli 0.153.4 sends, inside `client_metadata`:

```
"x-codex-turn-metadata": "{... \"thread_id\":\"<id>\", \"request_kind\":\"turn\",
                           \"thread_source\":\"user\", \"agent_name\":\"/root\" ...}"
```

and for a user-driven thread **`thread_id` equals `prompt_cache_key`**. That
equality is the safety property: keying on the thread cannot re-anchor a session
any existing client already established.

```bash
bun scripts/e2e-codex-thread-identity.mjs
```

**Pass criteria** (asserted, non-zero exit on any):

- A user thread completes two turns and the second is a `continuation` — the
  no-regression property, and the one worth failing loudest.
- A spawned thread (`thread_source: subagent`, own `thread_id`, parent's cache
  key) is admitted and gets its own SDK session.
- A `request_kind: compact` request on the same thread is admitted and does not
  land on the conversation's session.
- **After both siblings, the parent turn is still a `continuation`.**

**Which check actually discriminates.** Only the last one. Pre-fix, each
sibling's first turn also opened its own SDK session, so those two checks pass
either way — they are guards against a worse shape, not evidence. Measured
against pre-fix code the parent's third turn returns `lineage=undo`: the
compaction landed on the conversation's session and the next real turn read as a
rewrite of it. With the fix it is `continuation`.

The gate also asserts the parent still recalls a word from turn 1. That check
passes **both** ways — an `undo` replays the history, so correctness survives
and only cost does not (fresh session, 0% cache). It exists to catch the worse
failure where the parent answers out of a sibling's session.

**Harness note.** `/v1/responses` is stateless; a real Codex client resends the
whole thread as `input` every turn. A harness that sends one message per request
makes every turn a fresh one-message conversation, nothing ever resumes, and it
looks exactly like broken session identity.

**Not covered.** A genuine `thread_source: subagent` request could not be
produced locally — `codex exec` offers `multi_agent_v1.spawn_agent` but does not
spawn, so that shape needs Codex Desktop's interactive flow. The subagent case
here uses the verified metadata wire format rather than a captured subagent
request.

**Verified:** 2026-09-08. All nine checks pass with the fix; pre-fix the
discriminating check fails with `lineage=undo`.

## E48: Responses developer-note cache

**What it proves:** a `developer` item that first appears mid-conversation does
not invalidate the prompt cache for the whole history.

Anthropic caches the prompt as one prefix ordered **tools → system →
messages**. `/v1/responses` folded every `developer`/`system` input item into
the Anthropic `system` block regardless of position, so a note arriving on turn
N rewrote `system` and invalidated everything behind the tools block. Codex
emits exactly these as ordinary conversation events —
`<image_resize_notice>` after `view_image`, `<model_switch>` and
`<collaboration_mode>` on a model change, `<app-context>` on app refresh.

A real codex-cli 0.153.4 capture confirms the harness preamble arrives as a
**leading** `developer` item (`input roles: ["developer","user",...]`). That case
must keep folding into `system`; only a note arriving after the conversation
starts is inlined.

```bash
bun scripts/e2e-responses-developer-cache.mjs
```

**Pass criteria** (asserted, non-zero exit on any):

- Both conversations complete, and the control's second turn reads its prefix
  from cache.
- **The note's turn re-writes no more than 3x the control's `cache_write`.**

**Why the assertion is a ratio, not a hit rate.** Hit percentage does not scale
down to a probe. The reported collapse was on a ~700k-token thread where
`system` sits behind a ~125k tools block, so losing everything behind it cost
240k-584k tokens. In a ~6.5k probe the same bug only moves the rate from 98% to
~86%, which any sensible percentage threshold waves through — an earlier draft
of this gate passed both before and after for exactly that reason. Re-written
tokens are the invariant:

```
pre-fix   A cache_write=99    B cache_write=769   ->  7.8x   FAIL
with fix  A cache_write=117   B cache_write=141   ->  1.2x   PASS
```

The hit rate is still printed, as context rather than as a check.

**Verified:** 2026-09-08. Discriminates as tabled above.

## E49: max_tokens enforcement

**What it proves:** when enabled, the client's `max_tokens` actually bounds
output and a truncated turn says so.

`max_tokens` is required on `/v1/messages` and the contract makes it a hard cap
on thinking plus output, with a cut-off response reporting
`stop_reason: "max_tokens"`. Nothing on that path read it — #874 measured 16 ->
3900 output tokens (244x) and `end_turn` every time.

**Why this needed the real SDK.** The Agent SDK's `Options` has no output cap;
the only lever is the CLI's `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, and when it trips
the CLI **throws** rather than returning a truncated turn. Wiring it up naively
converts a satisfiable request into a hard error. Probed at 64 against CLI
2.1.263, the turn produced genuine text (154 chars) and then threw — the API
really stopped generating, only the shape coming back was wrong. The fix
translates that refusal into the stop reason the wire defines.

```bash
MERIDIAN_ENFORCE_MAX_TOKENS=1   # opt-in; the gate sets this itself
bun scripts/e2e-max-tokens.mjs
```

**Pass criteria** (asserted, non-zero exit on any):

- A tiny cap does not fail the request, reports `stop_reason: max_tokens`, and
  bounds output. The bound is asserted as a large multiple of the cap, not an
  exact count: the cap covers thinking plus text, and the defect was a 244x
  overshoot rather than an off-by-a-few.
- Streaming delivers no error frame and closes as `max_tokens`, including when
  thinking consumed the whole budget and no text was produced — an empty
  response with that stop reason is what the wire defines for it.
- A generous cap is unchanged in both modes.
- **With the flag unset a tiny cap is ignored, exactly as before.** Asserted in
  a second proxy, against the capped run rather than a fixed number.

**Why it is opt-in.** The cap counts thinking plus text, and an agentic turn
spends tokens on thinking the client never sized for. Measured: a 128-token cap
could no longer complete a turn whose visible answer was ~15 tokens, and a
16-token cap produced no text at all. Clients here send caps sized for a direct
answer — OpenCode sends 32000 — so enforcing by default would change behaviour
for every existing caller to close a conformance gap only some of them need.
The capability is exact when asked for, and off otherwise.

**Verified:** 2026-09-08. Ten checks pass. Enabling it turned the reported
16 -> 3900 overshoot into 16 -> 64 with `stop_reason: max_tokens`.

## E50: Passthrough MCP namespace

**What it proves:** an adapter's declared passthrough namespace reaches the
model, and OpenCode's does not move.

In passthrough mode the client's tools are nested inside an SDK MCP server, so
the model reads them as `mcp__<namespace>__<tool>`. That namespace was a module
constant, `oc`, on every adapter — including the LiteLLM/`passthrough` adapter,
whose own file has documented `mcp__litellm__*` since it was written and whose
`getMcpServerName()` was computed and then discarded on exactly the path where
client tools get registered (#893).

**Why the model has to be asked.** `stripMcpPrefix` maps the name back before
the client ever sees it, so nothing errors and no response differs — the effect
exists only in what the model reads. @groundnuty found it by asking the model to
state its own tool name, and that is the only method that proves it.

```bash
bun scripts/e2e-passthrough-mcp-namespace.mjs
```

**Pass criteria** (asserted, non-zero exit on any):

- A LiteLLM-pinned request (`x-meridian-agent: passthrough`) has the model read
  `mcp__litellm__sparql_select`.
- **An OpenCode request still has the model read `mcp__oc__sparql_select`**, and
  explicitly not `mcp__opencode__sparql_select`.

**Why the second check is the important one.** The obvious implementation —
reuse `getMcpServerName()` — returns "opencode" for the OpenCode adapter. That
would rename every client tool from `mcp__oc__read` to `mcp__opencode__read`,
moving the model-visible prompt and therefore the prompt cache for the entire
existing user base, and colliding with the `mcp__opencode__*` names
`passthroughEarlyStop` excludes precisely because they are internal. The
namespace is a separate, explicit adapter method defaulting to `oc` for that
reason.

**Verified:** 2026-09-08. Both namespaces confirmed from the model's own words.

## E51: Boot identity

**What it proves:** a host that cannot produce a boot identity refuses to serve,
says so on `/health`, and an ordinary host is unaffected.

Every session-store write takes a lock stamped with a process incarnation, and
`captureProcessIncarnation` returns undefined without a boot identity — so
`acquireLock` throws and every request that touches a session returns a 500.
`/health` never probed it, so a container missing `/etc/machine-id` reported
`healthy` to Docker's `HEALTHCHECK` and to any orchestrator while serving
nothing, and traffic kept being routed to it. The original occurrence took three
days to find for exactly that reason (#906, split from #903).

**Why this needs a container.** The failure is a property of the HOST. On a
developer machine and on ordinary CI, boot identity is always available, so no
unit test can reach the branch that matters. `oven/bun:1-slim` ships without
`/etc/machine-id`, which is the reported environment verbatim and the same shape
as distroless, scratch, chroot and gVisor images.

```bash
bun scripts/e2e-boot-identity.mjs        # skips cleanly if Docker is absent
```

**Pass criteria** (asserted, non-zero exit on any):

- With no `/etc/machine-id`: `startProxyServer` refuses to start, and the error
  names the missing file rather than repeating "cannot capture lock owner
  process incarnation", which names nothing an operator can act on.
- Under `MERIDIAN_ALLOW_MISSING_BOOT_IDENTITY=1` it starts, and `/health`
  returns **503 `unhealthy`** carrying the verdict and the cause — the honest
  combination when an operator has forced a start.
- **With a valid machine-id the same image starts normally and `/health`
  reports no boot-identity problem.** This is the regression guard: fail-fast
  that false-positives on ordinary deployments would be worse than the bug.

The gate copies the source into a staging directory rather than bind-mounting
the checkout, because `bun install` inside the container would otherwise
overwrite the host's platform-specific `node_modules` — a mounted macOS build
cannot even load libsql on Linux.

**Verified:** 2026-09-08. Eight checks pass across both environments:
`refused=true namesCause=true` / `http=503 unhealthy` without machine-id, and
`refused=false` / `http=200` with it.

## E52: Host identity

**What it proves:** `MERIDIAN_HOST_ID` makes `hostId` stable across a container
restart and distinct across containers that share a baked machine-id.

`linuxLocalBootIdentity` derives `hostId` from the machine-id **and** the
pid-namespace inode, which is wrong twice over inside a container (#905):

- **Not stable.** The inode changes on every `docker restart` while the session
  store survives in the writable layer. A proxy SIGKILLed holding a store lock
  returns with a different `hostId`, so the old lock probes `indeterminate`
  rather than `dead`, is never retired, and every request fails with
  `timed out waiting for lock` until the container is recreated — a permanent
  hang rather than a visible error.
- **Not unique.** Every container from an image tag shares a byte-identical
  `/etc/machine-id`, so `hostId` reduces to that inode, allocated from a fixed
  base at boot. Two freshly-booted hosts sharing a session directory can each
  read the other's LIVE lock as `dead` and delete resources under a running
  owner.

```bash
bun scripts/e2e-host-id.mjs        # skips cleanly if Docker is absent
```

**Pass criteria** (asserted, non-zero exit on any):

- The machine-id survives the restart, isolating the variable.
- The **derived** `hostId` moves with the pid-namespace inode — the reported bug,
  reproduced. Measured: `b16b50f5ed94f77c -> 1af99c215cd93186` across one
  restart with an unchanged machine-id.
- Two containers genuinely differ in pid namespace, and **the same pin yields
  the same `hostId` across them** — the property that makes a restart safe.
- **Distinct pins yield distinct `hostId`s despite a shared machine-id** — the
  property that stops one host retiring another's live lock.

**One conditional check.** Docker occasionally reuses a pid-namespace inode
across a restart. When that happens the instability cannot be observed, so the
gate says so and skips that one assertion rather than failing — the bug is still
real, and a gate whose red is sometimes noise stops being read. The pinned
checks are unconditional.

**Verified:** 2026-09-08. Five checks pass, including reproducing the reported
instability.

## E53: Auto-defer pin

**What it proves:** crossing the auto-defer threshold mid-session no longer
flips deferral, and therefore no longer flips `maxTurns`.

The decision was taken from the LIVE tool count, so one tool added or removed
flipped deferral for every non-core tool at once. That moves the
`anthropic/alwaysLoad` marker on every definition, flips `ENABLE_TOOL_SEARCH`,
and — since #860 — flips `maxTurns`, silently re-enabling the billed digest turn
for that request (#861). OpenCode switching agents, an MCP server connecting or
dropping, or a plugin toggling a tool all trigger it, and none looks to a user
like a cache-affecting change.

```bash
bun scripts/e2e-defer-pin.mjs
```

Two three-turn conversations with identical prompts; only one crosses:

```
A (control)   15 -> 15 -> 15 tools
B (crossing)  15 -> 15 -> 16 tools
```

**Pass criteria** (asserted, non-zero exit on any):

- Both conversations complete.
- **Deferral state is identical on turn 3**, so `maxTurns` did not change under
  a live session. Measured pre-change: `control=false crossing=true`. With the
  pin: both `false`.
- The suppressed flip is logged (`defer_flip suppressed`) rather than hidden,
  which is the observability the issue asked for regardless of which fix landed.

**What this gate deliberately does not assert.** An earlier draft asserted a
cache-write ratio and failed honestly. Adding a tool changes the tool block, and
the tool block is prompt position 0, so the prompt cache is invalidated whatever
the pin does — measured at `cache=0%` on turn 3 even *with* the pin. That cost
is inherent to changing the tool set. The bug was the **amplification** on top
of it, and that is what is asserted. The cache numbers are printed as context.

**Verified:** 2026-09-09. Pre-change the crossing conversation flips to
`deferred=true` on turn 3 and no `defer_flip` line appears; with the pin it
stays `false` and the suppression is logged.

## E54: Lineage divergence reason

**What it proves:** every lineage divergence names why it diverged, and the
remedy the log names for the expensive one actually works.

`classifyLineage` logged four outcomes, and for `diverged` only
`modified-history` and `undo-gap`. Everything else was silent, and the request
line renders every divergence without a cached session as the same literal
`lineage=new`. #820 is the cost of that: 6,514 `lineage=new` requests with zero
explanatory lines, across which the four `classifyLineage` diagnostics all sat
at exactly zero. The most expensive outcome — the headerless tool-result bypass
— is assigned before `classifyLineage` runs, so it printed nothing at all and
was identified only by reading `server.ts`. Two reporters drained a Max
subscription window first, because every one of those requests returns 200.

```bash
bun scripts/e2e-lineage-divergence-reason.mjs
```

A four-round client-driven tool loop on the `pi` adapter in passthrough mode,
run twice — once headerless, once with `x-session-affinity`. 22 filler tools
give the prompt prefix enough mass to clear Anthropic's minimum cacheable
length; without them every round of both loops reports `cache_read=0
cache_write=0` and the cost claim is untestable.

**Pass criteria** (asserted, non-zero exit on any):

- No round in either loop diverges without a `diverged=` reason.
- A headerless tool round names `independent-request:headerless-tool-result`.
- The one-time advice is printed **exactly once** across all rounds of both
  loops, not once per round.
- A first turn under a key that resolved to nothing reports `not-found`, which
  used to be indistinguishable from the bypass.
- The keyed loop resumes on every tool round and prints no `diverged=` at all.
- **The field cache signature is reproduced.** A bypassed round reads the same
  static prefix however far the conversation got, while a resumed round reads
  more as it grows; and a bypassed round pays several times over per round to
  re-write the prefix.

**What this gate deliberately does not assert.** Not every headerless tool
round takes the bypass. A headerless passthrough loop recovers through the
durable checkpoint exactly once: the checkpoint upgrade rewrites the lineage
result but leaves the request independent, so the end-of-turn store is still
skipped and the checkpoint never advances past the first tool call. Every later
round then finds a stale checkpoint and takes the bypass. That is the shape the
field report shows — 6,019 `new` against 10 `continuation` at 1000+ messages —
so the gate asserts that a bypassed round names itself, not that every round is
one. It also does not assert the field's cost magnitude: ~280k cache-write
tokens per turn against ~214 was measured on a 454-message conversation, and a
four-round probe reproduces the direction and the signature, not the size.

**Verified:** 2026-09-09, Haiku 4.5, two consecutive runs. Pre-change the same
rounds print `lineage=new session=new` with no reason and no warning. After:

```
A headerless  round 3  msgs=5  lineage=new           diverged=independent-request:headerless-tool-result  cache_write=1286  cache_read=5789
A headerless  round 4  msgs=7  lineage=new           diverged=independent-request:headerless-tool-result  cache_write=1497  cache_read=5789
B keyed       round 3  msgs=5  lineage=continuation  diverged=—                                           cache_write= 167  cache_read=6752
B keyed       round 4  msgs=7  lineage=continuation  diverged=—                                           cache_write= 166  cache_read=6919
```

`cache_read` pinned at 5789 while the conversation grows is the reporters' own
signature at probe scale; they measured it pinned at 30629 across 12,781 to
13,030 messages. Per-round cache-write ratio measured 7.2x, 7.1x and 6.5x
across three runs.

## E55: Gateway-fronted Claude Code

**What it proves:** a Claude Code session behind an API gateway keeps the
tool-loop exemption it already has on a direct connection — and the change
that delivers it does not turn a silent inefficiency into a hard failure.

The headerless tool-result bypass exempts `adapterBase === "claude-code"`,
because Claude Code owns its tool loop but still expects Meridian to resume the
backing SDK session. Behind LiteLLM the passthrough heuristic claims the
request first, so that exemption was lost — and LiteLLM owns the
`x-litellm-*` namespace for its own Langfuse session tracking and does not
forward `x-litellm-session-id` upstream on the `anthropic/` provider route, so
there was no session key either. Every tool round of the whole agentic loop
took the bypass (#820): 35k-56k cache-write tokens per turn with `cache_read`
pinned at 30629, against 46-53 tokens on a direct connection, and one 764-turn
session accumulating 90M cache-creation tokens.

**Why it needs the real CLI, and why it changed the fix.** The obvious change
was to read `x-claude-code-session-id` as a session key. The header is real —
verified against Claude Code 2.1.266 that it is the CLI session UUID, pinned
exactly by `--session-id` and distinct across sessions. But driving the actual
client showed the CLI reusing one session id across the auxiliary requests it
makes alongside a conversation. Keyed that way, two unrelated first messages
land under one key: classified `unrelated-history`, then refused with
**HTTP 400 "This session advanced while the request was waiting."** A
hand-written two-request probe would never have produced that second request.
So the header identifies the client and nothing else; keying stays on the
conversation fingerprint, exactly as a direct Claude Code request already does.

```bash
bun scripts/e2e-passthrough-claude-code-session.mjs
```

`MERIDIAN_DEFAULT_AGENT=passthrough` resolves the ambiguous `claude-cli/`
User-Agent to the passthrough adapter, reproducing the reported topology
without a LiteLLM instance: same adapter, same absent `x-litellm-session-id`,
same real client. The client runs with its own `CLAUDE_CONFIG_DIR` and a dummy
bearer token; the proxy keeps its real Claude Max authentication. The child
environment is scrubbed of `CLAUDE*` variables so running the gate from inside
Claude Code cannot hand the client a live messaging socket.

**Pass criteria** (asserted, non-zero exit on any):

- All three client invocations exit 0 and answer correctly.
- **No request takes the headerless tool-result bypass.**
- The turn after the tool round reports `lineage=continuation`. Before the fix
  the bypass skipped the end-of-turn store, so nothing was ever written under
  the key and no later turn could resume either.
- **No request classifies `unrelated-history`, and no invocation is refused
  with a 4xx** — the guard against the session-id keying above.
- A second conversation with the same prompt in its own directory does not
  inherit the first: its opening turn resumes nothing, and no session id it
  resumes belongs to the first conversation. Asserted by session id rather than
  by the absence of `continuation` — since #998 a passthrough tool round can
  resume its own session, so the lineage word alone cannot tell "resumed mine"
  from "inherited yours". Whether conversation 2 resumes at all is **not**
  asserted: the real client chooses how many tool rounds to take, so whether a
  checkpoint is stored varies between runs (measured both ways on consecutive
  runs). E56 owns the resume question, which it can assert deterministically
  because it drives the loop itself.

**What this gate deliberately does not assert.** The tool round *itself* still
classifies `not-found`, which is a separate and larger defect tracked in #996:
the passthrough adapter never resumes a tool round even with a session key it
does read, while `pi` and `opencode` resume the identical shape. The entry
stored at a passthrough early stop is a checkpoint boundary that lineage lookup
reports as missing by design, and the recovery path that should upgrade it does
not fire on this adapter. It predates this change and behaves identically with
a forwarded `x-litellm-session-id`, so the gate prints the classification as a
note rather than asserting it. It is also not a LiteLLM integration test — a real gateway would rewrite
the User-Agent and relay the body, which this does not model.

**Verified:** 2026-09-09, Claude Code 2.1.266 client, Haiku 4.5, 7 proxy
requests across three invocations. Pre-change the tool round reports
`diverged=independent-request:headerless-tool-result` and the `--resume`d turn
cannot resume. After:

```
turn 1   tools=0   msgCount=1  lineage=new           diverged=not-found      (auxiliary CLI request)
turn 1   tools=12  msgCount=1  lineage=new           diverged=not-found
turn 1   tools=12  msgCount=3  lineage=new           diverged=not-found      (tool round, no longer bypassed)
turn 2   tools=12  msgCount=5  lineage=continuation
```

Keyed on `x-claude-code-session-id` instead, the same run produced
`diverged=unrelated-history` and `API Error: 400`.

## E56: Namespaced tool-round resume

**What it proves:** a client-driven tool round resumes on **every** adapter,
whatever namespace its client tools sit in.

#983 gave each adapter its own passthrough client-tool namespace, so the
LiteLLM adapter registers client tools as `mcp__litellm__*`. The early-stop
tracker is what freezes the resume checkpoint, and it arms by matching those
names — but `noteAssistantMessage` called `noteAssistantContent` with the
**default** prefix. On that adapter nothing was ever added to `expected`: no
checkpoint UUID was frozen, no `passthroughToolCallIds` were stored, and every
tool round started a fresh SDK session (#996).

`isClientForwardedToolUse` is strict about foreign `mcp__*` names on purpose,
which is exactly what made the missed prefix silent instead of noisy. It took a
cross-adapter A/B and then a bisect to find:

```
15529b12 (pre-#983)  passthrough resumed 3/3 keyed tool rounds
96dc5605 (main)      passthrough resumed 0/3
with the fix         passthrough resumed 3/3
```

```bash
bun scripts/e2e-passthrough-namespace-resume.mjs
```

An identical four-round keyed tool loop on the three adapters that read an
explicit session key and run passthrough tool loops. `passthrough` is the one
that regressed; `pi` and `opencode` are the controls that made the regression
visible as an asymmetry rather than as an absolute.

**Pass criteria** (asserted, non-zero exit on any):

- Every loop completes and runs at least two real tool rounds.
- **Every keyed tool round reports `lineage=continuation`, on every adapter.**
- All three adapters agree on the tool-round shape. This is the assertion that
  actually catches the class of bug: a single-adapter gate would have passed
  throughout, because each adapter looks self-consistent on its own.

**Verified:** 2026-09-09, Haiku 4.5. On main before the fix, `pi` and
`opencode` report `continuation` on all three tool rounds and `passthrough`
reports `new` on all three. After, all three agree.

## Concurrent transcript publication

Run `bun scripts/e2e-publication-lifetime.mjs` and again with `--stream` after lifecycle or publication changes. This gate uses real Claude Max queries and two concurrent HTTP conversations, each with a fresh and resumed turn. A timing hook pauses each request after its real SDK writer lease is released, promotes its request pin as the owning proxy would, and runs a separate collector process before publication. The collector uses zero grace periods and the supported SDK deleter, exercising the destructive race in an isolated session store and disposable project.

Require four successful competing sweeps with no deletions, correct fixture identifiers in both answers, valid response envelopes, durable mappings, and unchanged source transcripts inspected through `getSessionMessages`. To verify rolling upgrades, set `E2E_COLLECTOR_MODULE` to the absolute `src/proxy/sessionLifecycle.ts` path in the previous checkout and repeat. The SDK itself is not mocked.

## Lineage hash integrity and upgrade

Run `bun scripts/e2e-lineage-hash-migration.mjs` and again with `--stream`; repeat with `E2E_MODEL=sonnet`. The gate establishes a real client tool loop whose result comes from a disposable fixture file, then changes only `is_error` in its supplied history. Require fresh replay with the revised metadata, a FAILED answer instead of the original SUCCEEDED answer, and unchanged source history.

A second case installs a persisted mapping containing the legacy digest format for that real source. Require one complete replay with call identity/arguments and result data, then an ordinary continuation with the correct answer. All inspection uses supported SDK `getSessionMessages`. Run the E41 sequential/parallel and undo-gap controls too when changing the encoding.

## Block appends and OpenCode hook removal

Run `bun scripts/e2e-block-continuations.mjs` and again with `--stream`. Run both modes with `E2E_MODEL=sonnet` and `--image` to exercise appended media. The real SDK/HTTP gate executes a fixture-read tool, appends text (and optionally an image) to its completed result slot, and requires continuation with only the new content delivered, no repeated tool call, and the correct answer.

It also removes a recognized OpenCode `{"continue":true}` hook envelope and requires continuation, then removes a meaningful fixture field and requires complete replay without that field in the SDK input or answer. Supported `getSessionMessages` inspection verifies input and source immutability. `--case=append`, `--case=hook` and `--case=drop` select individual cases for before/after comparisons. Run the existing E41, undo-gap and hash-migration controls alongside this gate when changing the classifier.

For growing histories, add `--extended --delay-input-ms=4000`. This supplies appended context followed by the prior assistant reply and a new user question requesting one JSON object. A timing wrapper delays the second SDK input if one is emitted; it still calls the real SDK. The unsafe multi-input path can concatenate two model answers. Require one complete JSON answer with the original record, new suffix and image color, and zero delayed secondary inputs after coalescing.


## Revised-history conflicts and checkpoint fidelity

Run `bun scripts/e2e-modified-history-conflict.mjs` and again with `--stream`. Scheduling gates hold one real SDK turn while a revised, growing request queues under the same OpenCode session. Require complete fresh replay, the new result and supplied assistant decision in schema-validated JSON, an ordinary resumed follow-up, and unchanged source history through supported `getSessionMessages`. SDK/model responses are real.

Run `bun scripts/e2e-duplicate-checkpoint.mjs` in both modes. The real model must emit two identical tool calls; otherwise the fixture precondition fails. Non-streaming currently delivers one call; streaming delivers both before hooks recognize duplication. The stored checkpoint must match the delivered IDs, all returned results must resume, and the source must remain unchanged. This gate does not claim streaming deduplication.

Run `bun scripts/e2e-settlement-proof.mjs` in both modes to verify revised history following a completed real tool checkpoint. Require the supplied decision in the SDK input and answer, unchanged source history, and a resumed ordinary follow-up. Keeping old completed checkpoints must not force future turns to replay.


## Claude Code trailing system reminders

Run `bun scripts/e2e-claude-code-system-delta.mjs` in both modes (`--stream`); repeat with `E2E_MODEL=claude-sonnet-4-6` and the `--image` flag to validate a native image tool result followed by a reminder. Require the actual tool result, reminder identifier and optional image color in the answer, checkpoint resume, no reminder promoted into the SDK system prompt, and unchanged source history through supported `getSessionMessages`.

Repeat the direct gate with `--revise-history` and separately with `--insert-history` in text/image and streaming/non-streaming modes. Edited or inserted user history must replay fresh and deliver its revised or inserted identifier, with no removed identifier, no assistant attribution on the reminder, and the replay history boundary preserved. Matching pending tool IDs alone must never discard earlier edits.

Run the direct gate with `--blank-reminder` in both response modes, with and without `--image`. Whitespace-only text does not qualify for the narrow reminder exception: require fresh replay, the correct tool value/context and optional image color, and unchanged source history.

Run `bun scripts/e2e-claude-code-client.mjs` for the full installed Claude Code 2.1.259 → Meridian → real SDK loop. `E2E_CLAUDE_CLIENT` can name that exact client binary. The fixture isolates the outer client's settings and enables its `CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM` flag; `--bare` suppresses the shape and is unsuitable. The real CLI reads a disposable fixture, sends its native `<total_tokens>` system reminder, then resumes for an ordinary follow-up. Require both proxy continuations to resume, delivery of both reminders to SDK user history, correct answers, and unchanged source history.

`--capture` runs only the real client's wire-format probe against a scripted local endpoint. It does not contact the SDK and is not a substitute for the full E2E gate. The fixture checks the exact client version; newer versions are separate compatibility targets. This case does not validate OpenCode/Orca cross-tool session ownership (#946).

## CLI model-version rejection

Run `E2E_CLAUDE_PATH=/path/to/old/claude bun scripts/e2e-cli-model-version.mjs --expect-rejection` and again with `--stream`. Use an old CLI that actually rejects the default `fable` model (2.1.177 was validated). Require HTTP 400/invalid_request_error or a single actionable SSE invalid_request_error without message_stop, the installed/required versions and override remedy, and exactly one proxy SDK query.

Run the same old binary with `E2E_MODEL=claude-haiku-4-5-20251001`, omitting `--expect-rejection`, in both modes. Then omit both overrides to validate the bundled CLI with `fable` in both modes. Supported requests must return exactly READY. Each run isolates Meridian config, sessions and working directory; it does not change the installed CLI or subscription credentials.


## Client and proxy working-directory boundaries

Build first, then run `bun scripts/e2e-client-cwd.mjs` on macOS or Linux with Claude Max authentication. This uses real HTTP and SDK/model queries, isolated Meridian config, and a query observer that delegates every SDK call. Client instructions are disabled; a marker assertion proves they are absent while the independent CWD note remains.

Both response modes must preserve OpenCode-shaped Windows client paths, execute client read/result loops, and execute proxy-managed reads in the proxy directory. Pi cases use actual POSIX directories with a literal trailing backslash and a symlink followed by `..`; the latter must have a different inode from the proxy directory. Client receipts differ from the proxy decoy. The fixture explicitly specifies literal path joining: this validates context delivery and tool execution under that instruction, not arbitrary model interpretation of unusual filenames. `--pi-only` and `--parent-only` isolate the two path regressions; `E2E_MERIDIAN_ROOT` selects a separately built before/after checkout.

Also run the E42 actual OpenCode gate with `--live --extended --separate-proxy-cwd` and the pinned `E2E_OPENCODE_BIN`. The harness isolates the client HOME/PWD as well as XDG state, while the proxy retains its normal Claude authentication. It asserts the client directory from actual request bodies and stable client system prompts before comparing cache reuse. The manually invoked hidden-summary probe runs in a disposable client fork: this checks stripped headers without switching the primary client agent or injecting its tool-catalog update into primary history. A marker assertion rejects any leak into primary requests. This keeps the client project and configured SDK workdir distinct through tool use, restart, undo, fork, compaction and concurrent children. Run all four E41 modes after CWD/session-identity changes.
