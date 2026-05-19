# Architecture

A proxy that bridges OpenCode (Anthropic API format) to Claude Max (Agent SDK).

## Module Map

```
server.ts          → HTTP routes, SSE streaming, concurrency (orchestration only)
adapter.ts         → AgentAdapter interface (extensibility point)
adapters/
  opencode.ts      → OpenCode-specific: headers, CWD, tool config
  forgecode.ts     → ForgeCode-specific: XML CWD, patch/shell tools, passthrough
  claudecode.ts    → Claude Code native agent
  droid.ts         → Android/Kotlin agent
  crush.ts         → Crush agent
  pi.ts            → Pi agent
  detect.ts        → Agent detection and routing
  passthrough.ts   → Passthrough fallback
query.ts           → buildQueryOptions (shared stream/non-stream SDK call builder)
errors.ts          → classifyError (pure)
models.ts          → mapModelToClaudeModel, resolveClaudeExecutableAsync
tools.ts           → BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME
messages.ts        → normalizeContent, getLastUserMessage (pure)
fileChanges.ts     → PostToolUse hook: file write/edit tracking + summary formatting (pure)
session/
  lineage.ts       → Hashing, lineage verification (PURE — no I/O)
  fingerprint.ts   → extractClientCwd, getConversationFingerprint
  cache.ts         → LRU caches, lookupSession, storeSession (stateful)
```

## Dependency Rules

- **Module Boundaries**: Do not add code to `server.ts` that belongs in a leaf module. If it's pure logic (no HTTP, no Hono), extract it.
- **Pure Modules**: `session/lineage.ts` must stay pure — no side effects, no I/O, no imports from cache or server.
- **Leaf Modules**: `errors.ts`, `models.ts`, `tools.ts`, `messages.ts` must not import from `server.ts` or `session/`. Dependencies flow downward only.
- **No Circular Dependencies**: Enforce acyclic import graph.

## Adapter Pattern

The `AgentAdapter` interface defines how different agents (OpenCode, ForgeCode, Claude Code, etc.) customize behavior:

- Session ID extraction (from headers)
- Working directory detection
- Content normalization
- Tool allowlists
- File change tracking
- System context customization

Each adapter in `adapters/` implements this interface for agent-specific needs.

## Design Patterns

### Context Budget & Progressive Disclosure

Meridian follows the md-codebase pattern (2026): CLAUDE.md is kept lean (~80 lines). OpenCode adapter applies Progressive Disclosure—stripping workflow docs from context for coding tasks. Impact: ~15-20% token reduction per request.

### PreToolUse & PostToolUse Hooks

OpenCode uses SDK hooks to:
- PreToolUse: Fuzzy-match subagent names before SDK processes Task tool
- PostToolUse: Track file changes and append summary block (if applicable to agent)

### Passthrough Mode

When enabled, meridian can proxy directly to OpenAI's API for testing. Controlled by `MERIDIAN_PASSTHROUGH` or `CLAUDE_PROXY_PASSTHROUGH` env var.

### Session Affinity & Lineage Tracking

Sessions tracked via `x-opencode-session` or `x-session-affinity` headers. Lineage verification ensures consistency across multi-turn conversations.

## Testing Strategy

- **Unit tests**: Pure functions (`errors.ts`, `messages.ts`, `session/lineage.ts`) tested directly with no mocks
- **Integration tests**: HTTP layer with mocked SDK, testing adapter behavior end-to-end
- **E2E tests**: Manual tests on real agents (documented in E2E.md), requires Claude Max subscription
- **All tests must pass before changes merge**
