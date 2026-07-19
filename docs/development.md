# Development

[← Back to README](../README.md)

Architecture overview, testing, and the programmatic API. See [`ARCHITECTURE.md`](../ARCHITECTURE.md) for the authoritative module map and dependency rules, and [`CLAUDE.md`](../CLAUDE.md) for coding guidelines.

## Architecture
```
src/proxy/
├── server.ts              ← HTTP orchestration (routes, SSE streaming, concurrency)
├── adapter.ts             ← AgentAdapter interface
├── adapters/
│   ├── detect.ts          ← Agent detection from request headers
│   ├── opencode.ts        ← OpenCode adapter
│   ├── forgecode.ts       ← ForgeCode adapter
│   ├── crush.ts           ← Crush adapter
│   ├── droid.ts           ← Droid adapter
│   ├── pi.ts              ← Pi adapter
│   ├── cherry.ts          ← Cherry Studio adapter (internal mode + web search)
│   ├── claudecode.ts      ← Claude Code adapter (remote clients sharing a Max host)
│   ├── openai.ts          ← OpenAI-endpoint adapter (/v1/chat/completions)
│   ├── codex.ts           ← Codex CLI adapter (/v1/responses, forced passthrough)
│   └── passthrough.ts     ← LiteLLM passthrough adapter
├── query.ts               ← SDK query options builder
├── errors.ts              ← Error classification
├── models.ts              ← Model mapping (sonnet/opus/haiku, agentMode)
├── tokenRefresh.ts        ← Cross-platform OAuth token refresh
├── openai.ts              ← OpenAI ↔ Anthropic format translation (pure)
├── openaiResponses.ts     ← OpenAI Responses API ↔ Anthropic translation (pure)
├── setup.ts               ← OpenCode plugin configuration
├── session/
│   ├── lineage.ts         ← Per-message hashing, mutation classification (pure)
│   ├── fingerprint.ts     ← Conversation fingerprinting
│   └── cache.ts           ← LRU session caches
├── profiles.ts            ← Multi-profile: resolve, list, switch auth contexts
├── profileCli.ts          ← CLI commands for profile management
├── sessionStore.ts        ← Cross-proxy file-based session persistence
└── passthroughTools.ts    ← Tool forwarding mode
telemetry/
├── ...
├── profileBar.ts          ← Shared site header (brand, nav, status, active profile)
└── profilePage.ts         ← Profile management page
plugin/
└── meridian.ts            ← OpenCode plugin (session headers + agent mode)
```

### Session Management

Every incoming request is classified:

| Classification | What Happened | Action |
|---------------|---------------|--------|
| **Continuation** | New messages appended | Resume SDK session |
| **Compaction** | Agent summarized old messages | Resume (suffix preserved) |
| **Undo** | User rolled back messages | Fork at rollback point |
| **Diverged** | Completely different conversation | Start fresh |

Sessions are stored in-memory (LRU) and persisted to `~/.cache/meridian/sessions.json` for cross-proxy resume.

### Agent Detection

Agents are identified from request headers automatically:

| Signal | Adapter |
|---|---|
| `x-meridian-agent` header | Explicit override (any adapter) |
| `x-opencode-session` or `x-session-affinity` header | OpenCode |
| `opencode/` User-Agent | OpenCode |
| `factory-cli/` User-Agent | Droid |
| `Charm-Crush/` User-Agent | Crush |
| `claude-cli/` User-Agent | Claude Code (unless `MERIDIAN_DEFAULT_AGENT` overrides — Pi mimics this UA) |
| `litellm/` UA or `x-litellm-*` headers | LiteLLM passthrough |
| *(anything else)* | `MERIDIAN_DEFAULT_AGENT` env var, or OpenCode |

### Adding a New Agent

Implement the `AgentAdapter` interface in `src/proxy/adapters/`. See [`adapters/opencode.ts`](../src/proxy/adapters/opencode.ts) for a reference.

## Testing

```bash
npm test       # unit + integration tests
npm run build  # build with bun + tsc
```

| Tier | What | Speed |
|------|------|-------|
| Unit | Pure functions, no mocks | Fast |
| Integration | HTTP layer with mocked SDK | Fast |
| E2E | Real proxy + real Claude Max ([`E2E.md`](../E2E.md)) | Manual |

## Programmatic API

```typescript
import { startProxyServer } from "@rynfar/meridian"

const instance = await startProxyServer({
  port: 3456,
  host: "127.0.0.1",
  silent: true,
})

// instance.server — underlying http.Server
await instance.close()
```
