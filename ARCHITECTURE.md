# Architecture

A transparent proxy that bridges OpenCode (Anthropic API format) to Claude Max (Agent SDK). This document defines the module structure, dependency rules, and design decisions.

## Request Flow

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

```
src/
├── index.ts                   ← Public API barrel export (startProxyServer, types)
├── env.ts                     ← Environment variable resolution (MERIDIAN_* / CLAUDE_PROXY_*)
├── proxy/
│   ├── server.ts              ← HTTP layer: routes, SSE streaming, request orchestration
│   ├── prepareMessages.ts     ← Message-to-prompt conversion (text and multimodal)
│   ├── retry.ts               ← Transparent retry wrapper (stale session, rate limiting)
│   ├── adapter.ts             ← AgentAdapter interface (extensibility point for multi-agent support)
│   ├── adapters/
│   │   ├── opencode.ts        ← OpenCode adapter (session headers, CWD, tools, agent defs, fuzzy match)
│   │   ├── droid.ts           ← Droid (Factory AI) adapter
│   │   ├── crush.ts           ← Crush (Charm) adapter
│   │   ├── passthrough.ts     ← LiteLLM/generic passthrough adapter
│   │   └── detect.ts          ← Adapter auto-detection from User-Agent
│   ├── query.ts               ← SDK query options builder (shared between stream/non-stream paths)
│   ├── errors.ts              ← Error classification (SDK errors → HTTP responses)
│   ├── models.ts              ← Model mapping, Claude executable resolution
│   ├── tools.ts               ← Shared tool blocking lists (used by all adapters)
│   ├── messages.ts            ← Content normalization, message parsing
│   ├── types.ts               ← ProxyConfig, ProxyInstance, ProxyServer types
│   ├── session/
│   │   ├── index.ts           ← Barrel export
│   │   ├── lineage.ts         ← Pure functions: hashing, lineage verification
│   │   ├── fingerprint.ts     ← Conversation fingerprinting, client CWD extraction
│   │   └── cache.ts           ← LRU session caches, lookup/store operations
│   ├── sessionStore.ts        ← Shared file store (cross-proxy session resume)
│   └── passthroughTools.ts    ← Tool forwarding mode (agent handles execution)
├── fileChanges.ts             ← PostToolUse hook: tracks write/edit ops, formats summary
├── mcpTools.ts                ← MCP tool definitions (read, write, edit, bash, glob, grep)
├── logger.ts                  ← Logging with AsyncLocalStorage context
├── utils/
│   ├── lruMap.ts              ← Generic LRU map with eviction callbacks
│   └── semaphore.ts           ← Counting semaphore for concurrency control
├── telemetry/
│   ├── index.ts               ← Barrel export
│   ├── store.ts               ← Request metrics storage
│   ├── routes.ts              ← Telemetry API endpoints
│   ├── logStore.ts            ← Diagnostic log ring buffer
│   ├── dashboard.ts           ← HTML dashboard
│   └── types.ts               ← Telemetry types
└── plugin/
    └── claude-max-headers.ts  ← OpenCode plugin for session header injection
```

## Dependency Rules

Dependencies flow **downward**. A module may only import from modules at the same level or below.

```
server.ts (HTTP layer)
    │
    ├── prepareMessages.ts (prompt building)
    ├── retry.ts ──► errors.ts, models.ts, query.ts, prepareMessages.ts, session/cache.ts
    ├── adapter.ts (interface)
    ├── adapters/opencode.ts ──► messages.ts, session/fingerprint.ts, tools.ts, fileChanges.ts
    ├── query.ts ──► adapter.ts, mcpTools.ts, passthroughTools.ts
    ├── errors.ts
    ├── models.ts
    ├── tools.ts (shared blocking lists)
    ├── messages.ts
    ├── session/cache.ts ──► session/lineage.ts ──► messages.ts
    │                    ──► session/fingerprint.ts
    │                    ──► sessionStore.ts
    ├── fileChanges.ts
    ├── passthroughTools.ts
    ├── mcpTools.ts
    ├── utils/semaphore.ts
    └── telemetry/
```

### Rules

1. **`session/lineage.ts` is pure.** No side effects, no I/O, no caches. Only crypto hashing and comparison logic. Must stay testable without mocks.

2. **`session/cache.ts` owns all mutable session state.** No other module should create or manage LRU caches for sessions.

3. **`errors.ts`, `models.ts`, `tools.ts`, `messages.ts` are leaf modules.** They must not import from `server.ts`, `session/`, or `adapter.ts`.

4. **`server.ts` is the only module that imports from Hono** or touches HTTP concerns.

5. **No circular dependencies.** If you need to share types, put them in `types.ts` or the relevant leaf module.

6. **`adapter.ts` is an interface only.** No implementation logic. Adapter implementations go in `adapters/`.

7. **`query.ts` builds SDK options through the adapter interface**, never importing tool constants directly.

## Agent Adapter Pattern

Agent-specific behavior is isolated behind the `AgentAdapter` interface (`adapter.ts`). The proxy calls adapter methods instead of hardcoding agent logic.

### Current Adapters

- **`adapters/opencode.ts`** — OpenCode agent (session headers, `<env>` block parsing, tool mappings)

### Adding a New Agent

1. Create `adapters/myagent.ts` implementing `AgentAdapter`
2. Wire it into `server.ts` (currently hardcoded to `openCodeAdapter`; future work will auto-detect)
3. No changes needed to `query.ts`, `session/`, or other infrastructure

### What the Adapter Controls

| Method | What It Does |
|--------|-------------|
| `getSessionId(c)` | Extract session ID from request headers |
| `extractWorkingDirectory(body)` | Parse working directory from request body |
| `normalizeContent(content)` | Normalize message content for hashing |
| `getBlockedBuiltinTools()` | SDK tools replaced by agent's MCP equivalents |
| `getAgentIncompatibleTools()` | SDK tools with no agent equivalent |
| `getMcpServerName()` | MCP server name for tool registration |
| `getAllowedMcpTools()` | MCP tools allowed through the proxy |

### Remaining Shared Code

| Logic | Location | Status |
|-------|----------|--------|
| Passthrough mode | `passthroughTools.ts` | Agent-agnostic. Used by all adapters that support passthrough. |

All agent-specific code (agent definitions, fuzzy matching, MCP tool lists) is now inside individual adapter files.

## Session Management

Sessions map an agent's conversation ID to a Claude SDK session ID. Two caches work in tandem:

- **Session cache**: keyed by agent header (`x-opencode-session`)
- **Fingerprint cache**: keyed by hash of first user message + working directory (fallback when no header)

Both are LRU with coordinated eviction — evicting from one removes the corresponding entry in the other.

### Lineage Verification

Every request verifies that incoming messages are a valid continuation of the cached session:

| Classification | Condition | Action |
|---------------|-----------|--------|
| **Continuation** | Prefix hash matches stored | Resume normally |
| **Compaction** | Suffix preserved, beginning changed | Resume (agent summarized old messages) |
| **Undo** | Prefix preserved, suffix changed | Fork at rollback point |
| **Diverged** | No meaningful overlap | Start fresh session |

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
