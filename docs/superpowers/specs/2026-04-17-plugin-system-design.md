# Meridian Plugin System — Design Spec

**Date:** 2026-04-17
**Author:** Trevor Walker
**Status:** Approved

## Problem

Users want to customize Meridian's request/response behavior — redirecting system prompts, filtering content, adding telemetry integrations — without modifying Meridian's core. Today, these features get proposed as PRs that add toggles and adapter-specific logic to server.ts, growing the codebase and coupling customizations to the release cycle. Meridian should remain a clean proxy; extensibility should live in user-space.

**Motivating example:** [PR #377](https://github.com/rynfar/meridian/pull/377) adds a `systemPromptAsUserMessage` feature toggle that redirects the client's system prompt into the first user message. This is a valid use case but doesn't belong in core — it's a 20-line transform that any user should be able to write as a plugin.

## Architecture: Adapter Composition

### Interface Split

The current `AgentAdapter` interface (13+ methods) mixes two concerns:

1. **Identity** — who is the agent? Detection, session ID, CWD extraction, content normalization.
2. **Behavior** — what transformations apply? System prompt handling, tool filtering, hooks, streaming preference.

We split these into two interfaces so plugins use the same mechanism as built-in adapter behavior.

#### AgentIdentity (internal, not plugin-accessible)

```ts
interface AgentIdentity {
  name: string
  getSessionId(c: Context): string | undefined
  extractWorkingDirectory(body: any): string | undefined
  normalizeContent(content: any): string
  getMcpServerName(): string
}
```

#### Transform (composable, the plugin contract)

```ts
interface Transform {
  name: string
  description?: string
  version?: string
  adapters?: string[]  // scope to specific adapters, undefined = all

  // v1 hooks
  onRequest?(ctx: RequestContext): RequestContext
  onResponse?(ctx: ResponseContext): ResponseContext
  onTelemetry?(ctx: TelemetryContext): void

  // Roadmap hooks (reserved in interface, not implemented in v1)
  onSession?(ctx: SessionContext): SessionContext
  onToolUse?(ctx: ToolUseContext): ToolUseContext
  onToolResult?(ctx: ToolResultContext): ToolResultContext
  onError?(ctx: ErrorContext): ErrorContext
}
```

### Transform Pipeline

At request time, Meridian builds an ordered transform pipeline:

```
[adapter built-in transforms] → [plugin transforms in user-configured order]
```

Pipeline runner — reduce over transforms, each hook receives the previous hook's output:

```ts
type TransformHook = "onRequest" | "onResponse" | "onTelemetry"
  | "onSession" | "onToolUse" | "onToolResult" | "onError"

function runPipeline<T>(
  transforms: Transform[],
  hook: TransformHook,
  ctx: T,
  adapterName: string,
): T {
  return transforms.reduce((acc, transform) => {
    const fn = transform[hook] as ((ctx: T) => T) | undefined
    if (!fn) return acc
    if (transform.adapters && !transform.adapters.includes(adapterName)) return acc
    return fn(acc)
  }, ctx)
}
```

Plugins receive an immutable context and return a modified copy. No mutation in place.

### Hook Context Types

**RequestContext** — what `onRequest` receives and returns:

```ts
interface RequestContext {
  adapter: string
  model: string
  messages: Message[]
  systemContext?: string
  tools?: Tool[]
  stream: boolean
  workingDirectory: string
  headers: Headers          // readonly
  metadata: Record<string, unknown>  // plugins stash cross-hook state here
}
```

**ResponseContext** — what `onResponse` receives and returns:

```ts
interface ResponseContext {
  adapter: string
  content: ContentBlock[]
  usage?: Usage
  metadata: Record<string, unknown>  // carried from onRequest
}
```

**TelemetryContext** — what `onTelemetry` receives (observe-only, return value ignored):

```ts
interface TelemetryContext {
  adapter: string
  model: string
  requestId: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cacheHitRate: number
}
```

The `metadata` bag lets a plugin pass state from `onRequest` to `onResponse` without global variables.

## Adapter Refactor

Each existing adapter splits into identity + transforms:

| Adapter | Identity keeps | Transforms extracted |
|---|---|---|
| opencode | sessionId, CWD, normalize, MCP name | system addendum, Task tool hook, agent defs, tool filtering |
| crush | sessionId, CWD, normalize, MCP name | tool filtering |
| droid | sessionId, CWD, normalize, MCP name | system-reminder stripping, internal mode forcing |
| pi | sessionId, CWD, normalize, MCP name | passthrough mode, CWD from system prompt |
| forgecode | sessionId, CWD, normalize, MCP name | XML CWD, patch/shell tools, passthrough |
| passthrough | sessionId, CWD, normalize, MCP name | LiteLLM streaming override |

### File structure after refactor

```
src/proxy/
  adapter.ts          → AgentIdentity interface (slimmed down)
  transform.ts        → Transform interface + pipeline runner (NEW)
  adapters/
    opencode.ts       → identity only
    crush.ts          → identity only
    droid.ts          → identity only
    pi.ts             → identity only
    forgecode.ts      → identity only
    passthrough.ts    → identity only
    detect.ts         → unchanged
  transforms/
    opencode.ts       → opencode behavioral transforms (NEW)
    crush.ts          → crush behavioral transforms (NEW)
    droid.ts          → droid behavioral transforms (NEW)
    pi.ts             → pi behavioral transforms (NEW)
    forgecode.ts      → forgecode behavioral transforms (NEW)
    passthrough.ts    → passthrough behavioral transforms (NEW)
```

### server.ts changes

Where server.ts currently calls adapter methods like `adapter.buildSystemContextAddendum()`, `adapter.prefersStreaming()`, etc., those become pipeline calls through `runPipeline()`. A new `resolveTransformPipeline(identity, pluginTransforms)` function builds the ordered chain from the adapter's built-in transforms plus any active plugins.

## Plugin System

### Plugin discovery

Meridian auto-scans `~/.config/meridian/plugins/` for `.ts`/`.js` files at startup. Each file must default-export a `Transform` object (or array of `Transform`s).

### Plugin configuration

`~/.config/meridian/plugins.json` provides explicit control:

```json
{
  "plugins": [
    { "path": "system-prompt-redirect.ts", "enabled": true },
    { "path": "custom-telemetry-logger.ts", "enabled": true },
    { "path": "/absolute/path/to/external-plugin.ts", "enabled": false }
  ]
}
```

**Loading rules:**
- Auto-scanned plugins not in `plugins.json` are appended to the end, enabled by default
- Array order in `plugins.json` = execution order in the pipeline
- `enabled: false` disables without deleting the file
- Absolute paths allow plugins outside the default directory
- Plugins loaded once at startup; `/plugins/reload` endpoint picks up changes without restart
- Failed loads log an error but don't crash — skip that plugin, continue

**Validation at load time:**
- Must default-export an object with `name: string`
- Hook functions must be typeof function
- Unknown adapter names in scope — warn but don't reject
- Duplicate plugin names — second skipped with warning

### Adapter scoping

Plugins declare `adapters: ["opencode", "crush"]` to restrict which adapters they run for. Omitting the field means all adapters. Users can override this in `plugins.json` (future — not in v1).

### Plugin ordering

Pipeline chaining with user-controlled ordering. Plugins don't declare priority numbers — the user decides execution order via `plugins.json` or the UI. Adapter built-in transforms always run first.

### UI at /plugins

- Lists all discovered plugins: name, description, version, status (enabled/disabled/error)
- Shows which hooks each plugin registers
- Shows adapter scope
- Toggle enable/disable (writes to `plugins.json`)
- Reorder via drag or arrow buttons (writes to `plugins.json`)
- Error details for plugins that failed to load

### Example plugin

PR #377's system-prompt-redirect as a plugin:

```ts
import type { Transform } from "@rynfar/meridian"

export default {
  name: "system-prompt-redirect",
  version: "1.0.0",
  description: "Moves client system prompt into the first user message",

  onRequest(ctx) {
    if (!ctx.systemContext) return ctx
    return {
      ...ctx,
      messages: [
        {
          role: "user",
          content: `<system-instructions>\n${ctx.systemContext}\n</system-instructions>`,
        },
        ...ctx.messages,
      ],
      systemContext: undefined,
    }
  },
} satisfies Transform
```

## Implementation Phases

### Phase 1: Adapter refactor (internal, no user-facing change)

**Pre-refactor test backfill:**
Before changing any code, audit every adapter method and server.ts code path being refactored. If it lacks test coverage, write tests against the current behavior first. This establishes a regression baseline.

**Refactor:**
1. Define `AgentIdentity` and `Transform` interfaces in new files
2. Implement pipeline runner with unit tests
3. Split each adapter into identity + transforms
4. Refactor server.ts to use the pipeline instead of direct adapter method calls

**Verification:**
- All original tests (1260+) pass with zero modifications
- All backfilled tests pass with zero modifications
- Any test that needs changing during the refactor is a red flag — either behavior changed or the test was too implementation-coupled

### Phase 2: Plugin system (user-facing)

1. Plugin auto-scan and `plugins.json` loader
2. Plugin validation and error isolation
3. Pipeline integration — insert user plugins after adapter transforms
4. `/plugins` UI page
5. `/plugins/reload` endpoint
6. README section + `PLUGINS.md` authoring guide with roadmap
7. Example plugins shipped in `examples/plugins/`

## Documentation

### README

New `## Plugins` section:
- What plugins are and what they can do
- Quick start — drop a file in `~/.config/meridian/plugins/`, restart
- One example (system prompt redirect)
- Links to `PLUGINS.md` and `/plugins` UI

### PLUGINS.md

- Plugin authoring guide with full `Transform` interface
- All v1 hooks with complete type signatures
- Multiple examples: system prompt redirect, response filter, telemetry webhook
- Config reference (`plugins.json` format, ordering, enable/disable)
- Adapter scoping
- The `metadata` bag for cross-hook state
- Error handling — what happens when a plugin throws
- Testing plugins — how to unit test a transform

### Roadmap (documented in PLUGINS.md)

**Planned hooks:**
- `onSession` — override session resume/undo/diverged decisions
- `onToolUse` — intercept, block, or modify tool calls before SDK execution
- `onToolResult` — observe or transform tool results after execution
- `onError` — custom error handling, logging, retry decisions

**Planned capabilities:**
- Plugin npm packages — install via `npm install meridian-plugin-*`
- Plugin templates — `meridian plugin init` scaffolding
- Hot reload — pick up changes without restart
- Plugin marketplace — community-curated directory

## Testing Strategy

### Phase 1 (refactor)

- **Pre-refactor backfill:** Write tests for any untested adapter method or server.ts code path being refactored
- **Existing suite:** 1260+ tests must pass with zero modifications
- **New pipeline tests:** Unit tests for `runPipeline` — chaining order, adapter scoping, skip behavior
- **Transform unit tests:** Each extracted transform produces identical output to the old adapter method
- **E2E:** Smoke test against local launchd after merge

### Phase 2 (plugin system)

- Plugin loading: auto-scan, explicit config, ordering, enable/disable
- Plugin validation: malformed exports, missing name, invalid hooks
- Pipeline integration: multi-plugin chaining, adapter scoping, metadata passing
- Error isolation: plugin throws, next plugin still runs, proxy doesn't crash
- Example plugin: system-prompt-redirect as integration test
- UI: `/plugins` endpoint returns plugin list, toggle writes config
