# Architecture

A local proxy that bridges supported Anthropic- and OpenAI-compatible clients to Claude through the Agent SDK or Antigravity through the official agy CLI. This document defines the module structure, dependency rules, and design decisions.

## Request Flow

### Antigravity runtime and combined provider service

`backend: "antigravity"` (or `MERIDIAN_BACKEND=antigravity`) selects a separate
runtime at the public server entrypoint before Claude authentication, sessions,
plugins or background maintenance start. Claude remains the default. The
existing `AgentAdapter` describes incoming clients and is not reused as a
backend selector.

`backends/antigravityProtocol.ts` owns pure validation, history identity and
prompt rendering. Its opt-in numeric thinking-budget normalization maps to Gemini
effort variants before continuation identity is calculated; runtime model discovery
checks availability, and responses expose the effective model.
`antigravityRuntime.ts` owns the official CLI subprocesses and loopback MCP transport.
Its bounded interrupted-continuation fingerprints permit only exact completed-result
replay after cancellation joins the old process, before any subsequent client
call was emitted and with native actions disabled. Exact concurrent retries wait
for joining and use the existing result-ID claim; successful replay removes the
exception without clearing consumed IDs. Optional SQLite preserves only the
fingerprints, not in-flight work. `antigravityAttachments.ts` materializes supplied images,
documents and adapted media in a disposable workspace; the hook permits exact
generated paths. `antigravityUrl.ts` validates/pins public HTTPS image downloads;
`antigravityMedia.ts` owns local ffmpeg/Whisper adaptation. `antigravityNative.ts`
defines the separately opted-in browser/subagent policy; browser MCP uses isolated
Chrome. `antigravityProcess.ts` contains platform quoting and process termination.
`antigravityProbe.ts` runs only official version/configuration/model-discovery commands, bounds
output and deadlines, and joins termination (including forced kill) before one
timeout retry for configuration or model discovery (never version or ordinary exits). Failed read-only probes impose a five-second account-check cooldown with Retry-After; generation is never retried by this mechanism. Runtime account validation remains fresh and shared
only among concurrent callers; settings refusals and ordinary command failures
are never retried or replaced with cached authorization.
`antigravityOpenai.ts` validates supported OpenAI subsets before shared translation;
`antigravityOpenaiMedia.ts` preserves original OpenAI attachments while adapting
them into the common media pipeline. `antigravityResponses.ts` holds bounded,
credential-scoped Responses snapshots with one oldest-first count/byte ledger
across volatile payloads and durable metadata (rebuilt from SQLite on startup); `antigravityJobs.ts` owns background
cancellation and bounded event replay. `antigravityReplay.ts` saves terminal text
answers to exact Anthropic tool-result continuations in a separate credential-scoped
budget (128 entries, 16 MiB total, 1 MiB each, 30 minutes). Snapshots are saved
before terminal delivery and replay as JSON or lazily generated SSE without model,
response-hook or usage accounting duplication. Explicit request IDs extend this
same budget to ordinary prompts and tool batches. Identity binds a credential
scope and complete request fingerprint; concurrent duplicates wait with bounded,
abortable waiter sets. Tool batches are saved before the first tool block, preserve
original call IDs on replay, and become non-replayable when their results are
being accepted or consumed. CLI loss still uses completed-history result recovery.
Native-capability requests and OpenAI routes do not use this cache. Pi's example
extension assigns IDs before SDK retries and retains only a request hash/ID for an
exact failed-turn retry. New prompts, session operations, changed payloads and
successful/aborted turns reset that identity. OpenCode's V1 example plugin uses its
public active assistant-message identity because its processor reruns header hooks
on retry; a random ID per header-hook invocation would repeat generation. Its
provider fetch wrapper forwards text events incrementally and holds tool/terminal
events until EOF and message_stop (4 MiB, five minutes, abortable). Interrupted
delivery gets one cache-only JSON recovery with the original request identity;
the wrapper validates every displayed text prefix and message ID before emitting
only the missing suffix and tool batch. Cache misses never generate a replacement.
This preserves incremental display without executing an incomplete tool prefix
and does not alter server request validation or client permissions. Optional `antigravityState.ts` persists
Meridian-owned records in private SQLite with an exclusive lifetime owner guard.
`antigravitySessions.ts` atomically claims exact completed/joined text/client-tool
native mappings and uses the public CLI conversation flag. A separate hash-only unfinished-request journal prevents blind re-execution of
identified Messages requests after an unclean restart when no answer snapshot exists.
It is bounded to 128 entries/30 minutes, refuses admission instead of eviction,
and releases guards after joined cleanup. Backend shutdown waits for identified
request finalizers, including bounded telemetry observers, before closing SQLite.
It does not record external tool outcomes.
In-flight processes never enter that durable session cache; private CLI transcripts are never read.
`antigravitySetup.ts` owns explicit Pi/OpenCode client configuration, separate from
server orchestration. The build packages self-contained retry integrations under
`dist/antigravity-clients`; npm, Nix and Docker installations carry those assets.
Setup prepares edits before writing, preserves unrelated settings, rejects malformed
or conflicting input, creates private backups and uses per-file atomic replacement.
`telemetry/providerSetup.ts` shares pure command generation and setup presentation
between the web provider page and desktop. Desktop clipboard requests contain
choices rather than arbitrary text; the main process validates them against its
current service/model state before copying through Electron. Browser clipboard
denial falls back to manual selection. Neither UI executes the generated command.
Client defaults change only with `--set-default`; model limits are conservative
client settings, not provider-enforced generation caps.
`antigravityPlugins.ts` exposes explicit Antigravity request transforms and isolated
response/telemetry observers, separate from Claude SDK plugins.
`antigravityGrammar.ts` validates custom payloads in bounded worker/Python jobs
before client delivery, never on the HTTP event loop.
`antigravityTokens.ts` provides explicitly labeled, side-effect-free estimates. `antigravityStops.ts` is a pure incremental text-stop matcher.
`antigravitySchema.ts` compiles request-local Ajv validators for client tool
arguments and native structured results. It never fetches remote references or
coerces client data. Tool definitions travel in the prompt as well as MCP, so
model calls do not depend on access to private CLI schema files.
`antigravity.ts` adapts the standard Request/Response
interface to Anthropic JSON/SSE. Only `server.ts` imports Hono and binds the
public listener. Backend modules do not import Claude session or cache modules.

The runtime maps contain live/warm conversations and outstanding tool correlations,
like `sessionTree.ts`; they are not another durable session cache. Tool calls
remain pending inside the official CLI until their client result arrives.
The exact pending assistant prefix also permits appended user steering, either
beside the tool result or in subsequent user messages. New instructions travel
in a separate MCP result envelope field; they do not become tool output and do
not start a second process. Client-owned delegation tools follow the same MCP
path as file tools. Native subagents require an independent operator grant and
inherit the guarded workspace. MCP request identity is scoped per initialized
session, avoiding collisions between native children. The synthetic parallel MCP
tool validates a whole batch before delivery; reverse-order results remain correlated. Tool choice
may change between responses without changing the remaining pending contract.
Client plugin changes to system instructions or tool definitions use completed-
history replay after claiming all results and joining the old pending process.
Model, session, execution controls and delivered history must still match. The
new process installs its own tool catalog and deny hook; telemetry records
`client-context-replay`. Failed preflight releases the replay claim for retry.
Native schema mode permits `finish`, withholds prose and emits only the final
structured result after clean exit. Text stops deliberately terminate and join
the process; they are separate from native token-budget controls.
Completed ordinary requests retain an idle live process. Exact matching history
and contract append only new user messages through official stream stdin. Schema
and stop paths remain one-shot. Changed histories, compaction and expired/restarted
processes replay full client history unless an eligible completed/joined mapping
is restored through the public CLI conversation flag. A complete tool-call/result
request without a live owner also replays,
allowing recovery after expiry or process restart without an extra user message.
A bounded set of consumed tool IDs rejects recent duplicate results without an eligible saved answer; a transient
claim prevents simultaneous recovery during preflight. Consumed ID digests can
persist in the optional Meridian state store; neither mechanism promises
exactly-once external tool execution. Admission may reclaim a process waiting
idle for a tool result or another user turn, joining it before replacement; active responses are never
evicted. A late completed result can use the same replay path. Native Claude transcript lifecycle and lineage persistence cannot be
applied to Antigravity. `ProxyInstance.close()` joins owned subprocesses;
direct fetch embedders use `closeBackend()`. Shutdown also joins workspace cleanup
for processes already removed from admission maps before closing SQLite.

`backend: "combined"` retains the Claude listener and mounts Antigravity at
`/antigravity/*`, with independent admission, processes, quotas and shutdown.
The `/providers` page and `/providers/status` report both without mixing account
identities or quota percentages. `providerStatus.ts` normalizes provider facts;
`telemetry/providerView.ts` is shared pure presentation for the web and desktop.
CLI quota reads are single-flight and cached, preserving stale readings on
failure. Bounded request metadata and native activity optionally persist in Meridian
state; runtime counters are rebuilt from retained exchanges. Claude session-cache
ownership is unchanged.

See [the backend guide](docs/antigravity.md) for the explicit permission opt-in,
capability errors and recovery limits. Contract work is tracked in #1073.

### Default Claude runtime

```
Agent (OpenCode) ──► HTTP POST /v1/messages ──► Proxy Server
                                                    │
                                        ┌───────────┴───────────┐
                                        │   Session Resolution   │
                                        │  (header or fingerprint)│
                                        └───────────┬───────────┘
                                                    │
                                        ┌───────────┴───────────┐
                                        │   Lineage Verification  │
                                        │ (continuation/compaction│
                                        │  /undo/diverged)        │
                                        └───────────┬───────────┘
                                                    │
                                        ┌───────────┴───────────┐
                                        │   Claude Agent SDK      │
                                        │   query() with MCP      │
                                        └───────────┬───────────┘
                                                    │
                                        ┌───────────┴───────────┐
                                        │   Response Streaming    │
                                        │  (SSE, tool_use filter) │
                                        └───────────┬───────────┘
                                                    │
Agent (OpenCode) ◄── SSE Response ◄─────────────────┘
```

## Module Map

Selected modules are shown below; the [development guide](docs/development.md#architecture) provides source entry points for the other adapters and protocol routes.

```
src/
├── proxy/
│   ├── server.ts              ← HTTP layer: routes, SSE streaming, concurrency, request orchestration
│   ├── concurrency.ts         ← Abortable SDK query semaphore and concurrency config parsing
│   ├── requestAbort.ts        ← HTTP request abort → SDK query abort bridge
│   ├── sessionTree.ts         ← Live parent→child request registry; subtree cancellation (PURE bookkeeping)
│   ├── shutdown.ts            ← Bounded HTTP drain and connection tracking
│   ├── adapter.ts             ← AgentAdapter interface (extensibility point for multi-agent support)
│   ├── adapters/
│   │   ├── opencode.ts        ← OpenCode adapter (session headers, CWD extraction, tool config)
│   │   └── forgecode.ts       ← ForgeCode adapter (fingerprint sessions, XML CWD, passthrough)
│   ├── query.ts               ← SDK query options builder (shared between stream/non-stream paths)
│   ├── errors.ts              ← Error classification (SDK errors → HTTP responses)
│   ├── retryAfter.ts          ← Retry-After computation for 429/503/529 (PURE)
│   ├── models.ts              ← Model mapping, Claude executable resolution
│   ├── buildInfo.ts           ← Build provenance: source detection, semver compare (PURE)
│   ├── updateCheck.ts         ← Cached npm registry lookup for the newest published version
│   ├── tools.ts               ← Tool blocking lists, MCP server name, allowed tools
│   ├── messages.ts            ← Content normalization, message parsing
│   ├── replay.ts              ← Pure rendering of assistant calls and tool results for SDK replay
│   ├── types.ts               ← ProxyConfig, ProxyInstance, ProxyServer types
│   ├── session/
│   │   ├── index.ts           ← Barrel export
│   │   ├── lineage.ts         ← Pure functions: hashing, lineage verification
│   │   ├── fingerprint.ts     ← Conversation fingerprinting, client CWD extraction
│   │   ├── cache.ts           ← LRU session caches, lookup/store operations
│   │   ├── turnCoordinator.ts ← Process-wide serialization for reliable session IDs
│   │   ├── crossProcessTurnCoordinator.ts ← Durable coordination across proxy processes
│   │   ├── processIncarnation.ts ← Process/host identity for lock ownership
│   │   └── durableFileSystem.ts ← Durable file operations
│   ├── sessionStore.ts        ← Shared file store (cross-proxy session resume)
│   ├── profiles.ts            ← Multi-profile support: resolve, list, switch auth contexts (leaf)
│   ├── profileCli.ts          ← CLI commands for profile management (leaf, I/O)
│   ├── statusProbe.ts         ← Asks a busy port whether it is Meridian, and collects what / shows
│   ├── agentDefs.ts           ← Subagent definition extraction from tool descriptions
│   ├── agentMatch.ts          ← Fuzzy agent name matching
│   ├── design.ts              ← Claude Design MCP proxy (token store/refresh, auth precedence, login flow)
│   └── passthroughTools.ts    ← Tool forwarding mode (agent handles execution)
├── fileChanges.ts             ← PostToolUse hook: tracks write/edit ops, formats summary
├── mcpTools.ts                ← MCP tool definitions (read, write, edit, bash, glob, grep)
├── logger.ts                  ← Logging with AsyncLocalStorage context
├── utils/
│   └── lruMap.ts              ← Generic LRU map with eviction callbacks
├── telemetry/
│   ├── index.ts               ← Barrel export
│   ├── store.ts               ← Request metrics storage
│   ├── routes.ts              ← Telemetry API endpoints
│   ├── logStore.ts            ← Diagnostic log ring buffer
│   ├── dashboard.ts           ← HTML dashboard
│   ├── pricing.ts             ← Static API list prices + cost estimation (pure)
│   ├── pricingStore.ts        ← User pricing overrides (persisted JSON)
│   ├── profileBar.ts          ← Shared profile switcher bar (injected into HTML pages)
│   ├── profilePage.ts         ← Profile management page HTML
│   ├── cliDashboard.ts        ← The landing page rendered for a terminal (pure)
│   └── types.ts               ← Telemetry types

plugin/                       ← Repository root, alongside src/
├── meridian.ts               ← OpenCode V1 session header plugin
└── meridian-v2.ts            ← OpenCode V2 plugin
```

## Dependency Rules

Dependencies flow **downward**. A module may only import from modules at the same level or below.

```
server.ts (HTTP layer)
    │
    ├── adapter.ts (interface)
    ├── adapters/opencode.ts ──► messages.ts, session/fingerprint.ts, tools.ts
    ├── query.ts ──► adapter.ts, mcpTools.ts, passthroughTools.ts
    ├── errors.ts
    ├── retryAfter.ts
    ├── requestAbort.ts
    ├── sessionTree.ts
    ├── models.ts
    ├── tools.ts
    ├── messages.ts
    ├── session/cache.ts ──► session/lineage.ts ──► messages.ts
    │                    ──► session/fingerprint.ts
    │                    ──► sessionStore.ts
    ├── profiles.ts
    ├── profileCli.ts
    ├── agentDefs.ts
    ├── agentMatch.ts
    ├── fileChanges.ts
    ├── passthroughTools.ts
    ├── mcpTools.ts
    └── telemetry/
```

### Rules

1. **`session/lineage.ts` is pure.** No side effects, no I/O, no caches. Only crypto hashing and comparison logic. Must stay testable without mocks.

2. **`session/cache.ts` owns all mutable session state.** No other module should create or manage LRU caches for sessions.

3. **`errors.ts`, `retryAfter.ts`, `models.ts`, `tools.ts`, `messages.ts`, `profiles.ts`, `profileCli.ts`, `buildInfo.ts`, `updateCheck.ts` are leaf modules.** They must not import from `server.ts`, `session/`, or `adapter.ts`. `buildInfo.ts` and `retryAfter.ts` are additionally pure — every export is a function of its arguments (plus `process.env` for `buildInfo.ts`), so the registry I/O lives in `updateCheck.ts` instead.

4. **`server.ts` is the only module that imports from Hono** or touches HTTP concerns.

5. **No circular dependencies.** If you need to share types, put them in `types.ts` or the relevant leaf module.

6. **`adapter.ts` is an interface only.** No implementation logic. Adapter implementations go in `adapters/`.

7. **`query.ts` builds SDK options through the adapter interface**, never importing tool constants directly.

8. **`sessionTree.ts` holds only live-request bookkeeping.** No HTTP, no I/O, no logging: the caller supplies each entry's abort handle and owns the eviction and telemetry discipline that follows an abort. It must not import from `server.ts`, `session/`, or `adapter.ts`.

## Agent Adapter Pattern

Agent-specific behavior is isolated behind the `AgentAdapter` interface (`adapter.ts`). The proxy calls adapter methods instead of hardcoding agent logic.

### Current Adapters

- **`adapters/opencode.ts`** — OpenCode agent (session headers, `<env>` block parsing, tool mappings, and recognized transient hook envelopes for lineage)
- **`adapters/forgecode.ts`** — ForgeCode agent (fingerprint sessions, `<current_working_directory>` parsing, `patch`/`shell` tool mappings)

### Adding a New Agent

1. Create `adapters/myagent.ts` implementing `AgentAdapter`
2. Wire it into `server.ts` (currently hardcoded to `openCodeAdapter`; future work will auto-detect)
3. No changes needed to `query.ts`, `session/`, or other infrastructure

### What the Adapter Controls

| Method | What It Does |
|--------|-------------|
| `getSessionId(c)` | Extract session ID from request headers |
| `getAgentMode(c, body)` | Normalize an adapter-specific primary/subagent declaration |
| `extractWorkingDirectory(body)` | Parse working directory from request body |
| `normalizeContent(content)` | Normalize message content for hashing |
| `getBlockedBuiltinTools()` | SDK tools replaced by agent's MCP equivalents |
| `getAgentIncompatibleTools()` | SDK tools with no agent equivalent |
| `getMcpServerName()` | MCP server name for tool registration |
| `getAllowedMcpTools()` | MCP tools allowed through the proxy |

### Remaining OpenCode-Specific Code (Not Yet in Adapter)

| Logic | Location | Status |
|-------|----------|--------|
| `buildAgentDefinitions` | `agentDefs.ts`, `transforms/opencode.ts` | Pure OpenCode Task parser invoked by the adapter transform. |
| Passthrough mode | `passthroughTools.ts` | Agent-agnostic but OpenCode-motivated. Keep as-is. |
| `ALLOWED_MCP_TOOLS` usage in `server.ts` | Line ~176 | Used for `buildAgentDefinitions`. Move when adapter handles agent defs. |

## Session Management

Sessions map an agent's conversation ID to a Claude SDK session ID. Two caches work in tandem:

- **Session cache**: keyed by agent header (`x-opencode-session`)
- **Fingerprint cache**: keyed by hash of first user message + working directory (fallback when no header)

**A client's session header is not always a conversation identity.** OpenCode
runs its internal one-shot agents (`title`, `summary`, `compaction`) under the
*user's* session id, so `x-opencode-session` alone named two unrelated
conversations at once — the title prompt and the user's chat. They shared one
lineage and one turn lease, which cost the user's first turn either a 400
`session_turn_conflict` or a cold-cache full replay. `openCodeAdapter.getSessionId`
therefore appends the agent name for non-primary agents (`ses_x#title`), leaving
the primary agent's key byte-identical to the header. An adapter whose client
multiplexes agents over one session id needs the same treatment.

**A session header is identity, never authentication.** Polytoken's native
`X-Polytoken-Session` header is the cleanest example: the trimmed header value
IS the conversation identity — no agent-mode scoping, no lineage
canonicalization, no attestation. A blank/missing native header means "no
identity" rather than an invented fallback key: a headerless tool-result
continuation runs independent (never resumed, nothing stored) via the
existing client-driven-loop guard, and plain text turns keep the generic
fingerprint fallback shared by every headerless client. The polytoken adapter
forces client-owned passthrough unconditionally: instance
`passthrough: false` and global `MERIDIAN_PASSTHROUGH=0` are ineffective for
that base, because the protocol's tool loop lives entirely in the client.

Both are LRU with coordinated eviction — evicting from one removes the corresponding entry in the other.

### Lineage Verification

Every request verifies that incoming messages are a valid continuation of the cached session:

| Classification | Condition | Action |
|---------------|-----------|--------|
| **Continuation** | Full stored prefix hash matches | Resume from the stored message boundary |
| **Compaction** | Suffix preserved, beginning changed | Resume after the matched suffix |
| **Undo** | Prefix preserved, suffix changed | Fork at rollback point |
| **Diverged** | No overlap, unverifiable state, or a changed cached prefix followed by new messages | Start fresh and replay the complete client history |

Lineage verification is side-effect free. A classification may select an SDK
session and a replay boundary, but updated message counts and hashes are only
stored after the upstream request succeeds. When Meridian cannot prove that an
SDK session contains a section of client history, it starts fresh rather than
silently skipping that section.

## Throttling Contract

Meridian's clients are increasingly harnesses that run many concurrent sessions
through one account, so a refusal has to say enough for them to coordinate.

**Every 429, 503, and 529 carries a wait.** `retryAfter.ts` computes the number:
upstream's own `Retry-After` if it survived into the error, then a hint embedded
in the upstream error text, then the account's observed window reset from
`rateLimitStore`, then a per-status constant (60s for a rate limit, 5s for
overload). It is clamped to at least 1 second and at most 24 hours, so no source
can produce "retry immediately" or "retry never". Non-streaming responses carry
it as a real `Retry-After` header; SSE turns carry it as `error.retry_after` in
the error frame, because a stream's headers went out with `message_start` long
before the failure existed. Under priority routing the wait names the *pool's*
earliest opening, not the last account tried.

**A `[1m]` bench is scoped to whatever actually failed.** Extra Usage exhaustion
is an entitlement fact about the account, so it benches the whole profile. A
plain rate limit benches only the session that hit it (`models.ts`,
`recordExtendedContextRateLimited`). Benching the profile on a rate limit
downgraded every concurrent sibling at once, and the model switch cold-caches
each of them — their cached prefixes were built on the 1M model. Clients with no
session identity still bench profile-wide; there is nothing narrower to use.

## Cancellation Contract

Cancellation is per-HTTP-request: `requestAbort.ts` forwards one socket's abort
into that request's SDK abort controller, and the abort path evicts the session
mapping so no interrupted tail stays resumable.

That is not enough for a client whose subagents are separate requests. Prime
Agent's RLM children arrive on their own session keys, so cancelling the parent
left every child running — holding an SDK permit and a turn lease, billing the
subscription until its own socket closed or the lease watchdog tripped.

`sessionTree.ts` closes the gap. A client that knows its own tree stamps the
immediate parent alongside the child's session id (`metadata.user_id` →
`{ session_id, parent_session_id }`); `server.ts` registers that link for the
lifetime of the request and, on a client abort, aborts every live request whose
ancestry reaches the aborted key — through each child's own request abort
controller, so the eviction, permit release, and lease release that follow are
the existing abort path's rather than a second implementation.

Three properties bound it:

- **Abort, not completion.** A parent turn that finishes normally does not
  cancel children; a subagent routinely outlives the turn that spawned it. The
  shutdown path already aborts every request directly, and the lease watchdog is
  a proxy-side fence rather than a user intent, so neither cascades.
- **Live requests only.** An entry exists between "admitted" and "settled". A
  session that was seen once but has nothing in flight is not a cancellation
  target, so the registry is bounded by concurrency, not by history.
- **Self-gating.** Propagation can only reach a request that declared a parent,
  so every client that does not stamp linkage is unaffected with no flag to set.

`POST /v1/sessions/:key/cancel` cancels a subtree explicitly, and
`GET /telemetry/summary` reports the live gauges and cumulative counts under
`sessionTree`.

## Testing Strategy

Three tiers, each catching different classes of bugs:

| Tier | Files | SDK | Speed | Runs In |
|------|-------|-----|-------|---------|
| **Unit** | `src/__tests__/*-unit.test.ts` | None | Fast | CI (`bun test`) |
| **Integration** | `src/__tests__/proxy-*.test.ts` | Mocked | Fast | CI (`bun test`) |
| **E2E** | `E2E.md` | Real (Claude Max) | Slow | Manual, pre-release |

- **Unit tests**: Pure functions, no mocks, no I/O.
- **Integration tests**: HTTP layer with mocked SDK. Deterministic.
- **E2E tests**: Real proxy + real SDK + real Claude Max. See [`E2E.md`](./E2E.md) for runnable procedures covering session continuation, undo, compaction, cross-proxy resume, tool loops, streaming, and telemetry.

All tests import from source modules, not build output.
Tests that need `clearSessionCache` or `createProxyServer` import from `../proxy/server`.

### Test Baseline

Every change must pass all existing unit and integration tests:

```bash
npm test    # runs: bun test
```

E2E tests (`E2E.md`) should be run before releases or after major refactors.

## Adding New Code

### New pure logic (no I/O, no state)
→ Create a new leaf module in `src/proxy/`. Add unit tests.

### New stateful logic (caches, stores)
→ Add to the appropriate existing module (`session/cache.ts`, `sessionStore.ts`). Don't create new caches elsewhere.

### New HTTP endpoints
→ Add to `server.ts`. Keep route handlers thin — delegate to extracted modules.

### New agent support
→ Implement `AgentAdapter` in `src/proxy/adapters/`. See `adapters/opencode.ts` for reference. Do not hardcode agent-specific logic in leaf modules.

## Transcript publication lifetime

`sessionLifecycle.ts` persists a publication lease atomically with each new request target before SDK launch. The lease survives physical SDK writer shutdown and commit until the synchronous durable mapping CAS succeeds, or the request abandons its target. Failed publication restores the lease. Collectors in other processes cannot depend on a proxy instance's private request pins, so they consult these durable leases as well as durable mappings.

Publication leases use the existing unarmed active-lease representation with `purpose: "publication"`. Older collectors also retain them while the owner process is alive; exact process-incarnation death permits recovery. They do not count as exclusive SDK writers, and abandoning publication never removes an actual writer lease. Published transcripts are retained by their durable mappings and become collectible after eviction.

An SDK writer lease is released once its writer has been joined. If the lifecycle lock is busy at that point, the next GC sweep, including the shutdown sweep, retries the release; the completed turn does not fail. On win32 an executor's death does not prove its descendants gone, so a writer lease left by a crashed proxy is recovered only after the host reboots.

`session/lifecycleLockQueue.ts` admits lifecycle transactions in a per-lock-path
FIFO with at most 256 waiting callers. Local waiting does not consume the
two-second external-lock acquisition budget; only the head creates a durable
candidate. A holder stalled for 60 seconds rejects queued/new callers without
unlocking or abandoning its transaction. Capacity and stalled-holder errors are
distinct, defined in the dependency-leaf `session/lifecycleErrors.ts`.
Request admission signals remove queued work and cancel external acquisition,
but a running durable callback always finishes before returning ownership.
Cleanup never receives the canceled admission signal. Publication callbacks
remain synchronous; same-context recursive acquisition is rejected explicitly.

## Lineage hash encoding

`session/lineage.ts` hashes structured v2 records with separate history, message and block domains. Records preserve roles, block and message boundaries, tool call identity/arguments, and result identity/error status. JSON object keys are canonicalized; plain text and a single text block remain equivalent, and opaque thinking/cache hints remain excluded. Display-oriented `normalizeContent` is not a lineage proof.

Existing v1 digests cannot establish a v2 prefix. Their next request on an upgraded proxy safely replays the full supplied history and publishes v2 hashes; subsequent requests on upgraded proxies resume normally. Alternating between old and new proxy versions can repeat this replay cost until all participating proxies are upgraded. This migration relies on complete fresh replay, including completed tool calls/results and media. Stored transcript files are never rewritten to migrate hashes.

## Appended content and transient hooks

A trailing user tool-result slot may gain new content while every stored block remains an exact prefix. Lineage verification allows that continuation and sends only the appended canonical blocks; duplicate result IDs, edits and meaningful removals still replay. This supports text, images and other appended content without treating an ordinary user-message edit as an append-only tool continuation.

The OpenCode adapter separately recognizes complete `user-prompt-submit-hook` JSON envelopes for UserPromptSubmit additional context and common SDK hook-control fields, including `continue`. These per-turn blocks remain in the original SDK request but are excluded from durable lineage comparisons when a durable block remains. Unknown/malformed envelopes, surrounding prose, hook-only messages and assistant-authored lookalikes remain significant. Other adapters do not inherit this rule. A subset of arbitrary user blocks is never sufficient proof of a continuation.

Structured resume deltas are delivered in one SDK user input, matching text-delta delivery. SDK streamed inputs are independently answered live turns; splitting a growing request's appended context from its final question can yield concatenated answers. The shared pure coalescer preserves result wrappers and media order, and also backs fresh replay framing.

## Optional desktop application (preview)

`apps/desktop` is an independent Electron package; headless installations do not
install or import it. The sandboxed renderer calls a narrow preload interface.
The main process validates the sender and performs local HTTP requests against
existing Meridian endpoints. No server API or plugin contract changes are
required. Native Liquid Glass loads only on supported macOS systems.

The renderer keeps page navigation and unsaved forms local. `uiData.ts` filters
request metadata without inspecting arbitrary nested content; direct tests cover
combined searches and the continuation-only low-cache filter.

The app can connect to an external service or own a separate installation.
Managed versions are installed atomically under Electron's user-data directory,
and run through the published CLI under bundled stock Node (avoiding Electron's
native-module ABI). A Node preload watches the parent IPC channel; the CLI owns
its normal signal drain. Startup checks the selected HTTP version and, on macOS,
the listener PID. Failed activations restore the previous selected version.
The tray keeps the app alive when its window closes; explicit quit drains only
its owned child. Crash recovery is bounded to three attempts.

Docker/Nix/other external supervisors retain ownership when the UI connects.
Compatible macOS LaunchAgents can transfer ownership through a confirmed IPC
action. An encrypted journal precedes supervisor changes and remains until the
original supervisor is healthy after return. Recovery recognizes an already
restored supervisor after an interrupted return. The curated plugin installer
uses versioned npm directories and atomic shared-configuration replacement; it
never installs into an externally managed service. See [the desktop README](apps/desktop/README.md) for
implemented scope and remaining live verification.

The menu-bar panel has its own sandboxed renderer and native glass window. IPC
accepts only the exact main frame and local entry URL of either desktop window.
Both render the same manager snapshot and use the same lifecycle/profile actions.
`notifications.ts` separates desktop delivery policy from incident collection;
category preferences, burst thresholds and persisted cooldown timestamps prevent
per-request alerts. Recovery exhaustion is critical; individual child exits remain
in the in-app history.
