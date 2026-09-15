# Development

[← Back to README](../README.md)

Architecture overview, testing, and the programmatic API. See [`ARCHITECTURE.md`](../ARCHITECTURE.md) for the authoritative module map and dependency rules, and [`CLAUDE.md`](../CLAUDE.md) for coding guidelines.

## Work from source

Use Node.js 22+ and the Bun version pinned in `package.json`.

```bash
bun install --frozen-lockfile
npm run build
# Start only when you intend to run the proxy:
npm run proxy:direct
```

The development proxy can use your existing credentials. Tests use a mocked SDK; live E2E is a separate, deliberate step.

## Architecture

[`ARCHITECTURE.md`](../ARCHITECTURE.md) defines the dependency rules. Main source locations:

| Path | Responsibility |
|------|----------------|
| `src/proxy/server.ts` | HTTP orchestration and SDK request lifecycle |
| `src/proxy/adapters/`, `src/proxy/transforms/` | Client-specific behavior and transforms |
| `src/proxy/session/`, `src/proxy/sessionStore.ts` | Lineage, serialization, and durable session mappings |
| `src/proxy/query.ts` | SDK query configuration |
| `src/proxy/openai.ts`, `src/proxy/openaiResponses.ts` | Protocol translation |
| `src/telemetry/` | Metrics, persistence, logs, and web pages |
| `plugin/meridian.ts`, `plugin/meridian-v2.ts` | OpenCode V1 and V2 integration |
| `src/__tests__/` | Unit and mocked HTTP integration tests |

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

Detection is ordered; the first matching signal wins. See [`detect.ts`](../src/proxy/adapters/detect.ts) for the implementation.

| Order | Signal | Result |
|-------|--------|--------|
| 1 | Valid `x-meridian-agent` | Built-in adapter or configured instance |
| 2 | Valid `x-polytoken-session` | Polytoken |
| 3 | Adapter instance match rules | Matching instance |
| 4 | `x-opencode-session` | OpenCode |
| 5 | `jcode/` User-Agent plus valid `x-jcode-session` | Jcode |
| 6 | `opencode/`, `factory-cli/`, `Charm-Crush/`, or Polytoken User-Agent | Corresponding adapter |
| 7 | `x-session-affinity` | OpenCode fallback |
| 8 | `claude-cli/` | Claude Code, unless a valid non-Claude `MERIDIAN_DEFAULT_AGENT` resolves this ambiguous User-Agent |
| 9 | `litellm/` or `x-litellm-*` | Passthrough |
| 10 | No match | Valid `MERIDIAN_DEFAULT_AGENT`, otherwise OpenCode |

The OpenAI endpoint handlers also select adapters on their internal Messages hop. Adapter selection does not itself create reliable session identity; see [session identity](configuration.md#session-identity).

### Adding a New Agent

Implement the `AgentAdapter` interface in `src/proxy/adapters/`. See [`adapters/opencode.ts`](../src/proxy/adapters/opencode.ts) for a reference.

## Testing

```bash
npm test       # typecheck, then unit + integration tests
npm run typecheck # standalone type check
npm run build  # bundle, emit declarations, check Node entrypoints
```

| Tier | What | Speed |
|------|------|-------|
| Unit | Pure functions, no mocks | Fast |
| Integration | HTTP layer with mocked SDK | Fast |
| E2E | Real proxy + real Claude Max ([`E2E.md`](../E2E.md)) | Manual |

Use targeted `bun test src/__tests__/<file>.test.ts` during development, but it does not typecheck. Final code checks are `npm test`, `npm run typecheck`, and `npm run build`; bare all-files `bun test` also misses the package script's mock isolation. Documentation-only changes need content, link, and diff validation.

Follow the [contribution workflow](../.agents/references/contributing.md): work on an isolated feature branch from current `origin/main`, preserve the user's checkout, and open a PR. Product behavior changes require affected-flow live E2E as well as local checks; releases need separate authorization.

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
