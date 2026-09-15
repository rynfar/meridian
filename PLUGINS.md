# Meridian Plugin Authoring Guide

Plugins let you customize Meridian's request behavior and observe lineage decisions without modifying core code. Drop a compiled `.js` file in `~/.config/meridian/plugins/` and restart Meridian, or point `plugins.json` at a file anywhere on disk (useful for plugins installed as their own npm packages or cloned repos).

> **Runtime note.** The plugin loader uses dynamic `import()`. If you run meridian via `bun`, `.ts` plugin files work directly; if you run via `node` (the default for npm installs), plugins must be compiled to `.js`. When in doubt, ship `.js`.

## Hook availability

| Hook | Current HTTP request path |
|------|---------------------------|
| `onRequest` | Called; returned request context is used |
| `onSession` | Called after lineage classification; returned changes do not affect routing |
| `onResponse`, `onTelemetry` | Types/helpers exist, but the HTTP path does not call them |
| `onToolUse`, `onToolResult`, `onError` | Reserved; not wired into the HTTP path |

## Quick Start

The fastest path: author the plugin in its own repo, compile to JavaScript, and reference the built file from `plugins.json`.

1. Scaffold a plugin package (TypeScript recommended):
   ```bash
   mkdir my-meridian-plugin && cd my-meridian-plugin
   npm init -y
   npm pkg set type=module
   npm install --save-peer @rynfar/meridian
   npm install --save-dev typescript
   mkdir src
   npx tsc --init --rootDir src --outDir dist --module NodeNext --target ES2022
   ```

2. Write your plugin (`src/index.ts`):
   ```ts
   import type { Transform, RequestContext } from "@rynfar/meridian"

   const plugin: Transform = {
     name: "my-plugin",
     version: "1.0.0",
     description: "What this plugin does",

     onRequest(ctx: RequestContext): RequestContext {
       return { ...ctx, model: "custom-model" }
     },
   }

   export default plugin
   ```

3. Build it:
   ```bash
   npx tsc
   ```

4. Tell meridian about it via `~/.config/meridian/plugins.json`:
   ```json
   {
     "plugins": [
       { "path": "/absolute/path/to/my-meridian-plugin/dist/index.js", "enabled": true }
     ]
   }
   ```

5. Restart meridian or call `POST /plugins/reload`. Visit `http://localhost:3456/plugins` to confirm it loaded.

## Transform Interface

Plugins export a `Transform` object. Import the types from `@rynfar/meridian`:

```ts
import type { Transform, RequestContext, ResponseContext, TelemetryContext } from "@rynfar/meridian"

interface Transform {
  name: string              // Required: unique plugin name
  description?: string      // Shown in /plugins UI
  version?: string          // Semver version string
  adapters?: string[]       // Restrict to specific adapters (omit = all)

  // v1 hooks
  onRequest?(ctx: RequestContext): RequestContext
  onResponse?(ctx: ResponseContext): ResponseContext
  onTelemetry?(ctx: TelemetryContext): void
}
```

### onRequest

Called before the request is sent to the Claude SDK. Receives the full request context and returns a modified copy.

**Key fields you can modify:**

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Claude model name |
| `messages` | `any[]` | Conversation messages |
| `systemContext` | `string?` | System prompt text |
| `tools` | `any[]?` | Client tool definitions |
| `stream` | `boolean` | Streaming preference |
| `blockedTools` | `string[]` | SDK tools to block |
| `passthrough` | `boolean?` | Enable passthrough mode |
| `supportsThinking` | `boolean` | Forward thinking blocks |
| `metadata` | `Record<string, unknown>` | Plugin-to-plugin state |

**Example — add a system prompt addendum:**
```ts
onRequest(ctx) {
  return {
    ...ctx,
    systemContext: (ctx.systemContext || "") + "\nAlways respond in Spanish.",
  }
}
```

### onResponse

Defined in `Transform`, but the current proxy request path does **not invoke this hook**. The example illustrates its shape for direct pipeline tests; it does not filter live responses.

```ts
onResponse(ctx) {
  return {
    ...ctx,
    content: ctx.content.filter(block => block.type !== "thinking"),
  }
}
```

### onTelemetry

Defined as an observe-only hook, but the current proxy request path does **not invoke it**. Use the telemetry HTTP endpoints for live metrics. Calling it through `runObserveHook` in your own code ignores its return value.

```ts
onTelemetry(ctx) {
  console.log(`Request ${ctx.requestId}: ${ctx.inputTokens}in/${ctx.outputTokens}out`)
}
```

### onSession

The proxy calls this hook after a lineage decision. It exposes the session key, classification, and optional divergence details (digests and content shapes). Return the context, but do not expect modifications to alter core routing: the server ignores the returned value.

```ts
onSession(ctx) {
  console.log(ctx.lineage, ctx.sessionKey, ctx.mismatch)
  return ctx
}
```

## Adapter Scoping

Restrict a plugin to specific adapters:

```ts
export default {
  name: "opencode-only",
  adapters: ["opencode"],
  onRequest(ctx) { return ctx }, // only runs for OpenCode requests
}
```

Canonical adapter names: `opencode`, `crush`, `droid`, `pi`, `prime`, `forgecode`, `passthrough`, `cherry`, `claude-code`, `polytoken`, `openai`, `jcode`, `codex`. Instances inherit their base adapter's plugin scope.

## Plugin Configuration

Control which plugins load, their order, and enable/disable via `~/.config/meridian/plugins.json`:

```json
{
  "plugins": [
    { "path": "/Users/me/repos/my-plugin/dist/index.js", "enabled": true },
    { "path": "other-plugin.js", "enabled": false }
  ]
}
```

**Path resolution:**
- **Absolute paths** (e.g. `/Users/me/repos/my-plugin/dist/index.js`) are loaded directly. Use this for plugins installed in their own repos or via `npm install`.
- **Relative paths** (e.g. `other-plugin.js`) are resolved against `~/.config/meridian/plugins/` and auto-discovered from that directory alongside any files dropped in.

**Behavior:**
- Array order = execution order in the pipeline
- `enabled: false` disables a plugin without deleting the file
- Plugins not listed in `plugins.json` but present in `~/.config/meridian/plugins/` are appended at the end, enabled by default
- Absolute paths work even when `~/.config/meridian/plugins/` doesn't exist — no need to create the auto-scan directory if you only use external plugins

## The Metadata Bag

The following illustrates shared context when hooks are called by a pipeline. The current HTTP path invokes `onRequest` and `onSession`, not `onResponse`.

Pass state between hooks using the `metadata` field:

```ts
onRequest(ctx) {
  return { ...ctx, metadata: { ...ctx.metadata, startTime: Date.now() } }
},
onResponse(ctx) {
  const elapsed = Date.now() - (ctx.metadata.startTime as number)
  console.log(`Request took ${elapsed}ms`)
  return ctx
}
```

## Error Handling

If a hook throws synchronously, the pipeline records the error and continues with the previous context. Import and validation failures are also reported in `/plugins`. Hooks are synchronous; do not return promises or assume the loader isolates arbitrary plugin side effects.

## Testing Plugins

Transforms are pure functions — hand them a context and assert on the return value. You don't need meridian's pipeline runner for unit tests:

```ts
import type { Transform, RequestContext } from "@rynfar/meridian"
const plugin: Transform = {
  name: "uppercase-test",
  onRequest(ctx) {
    return { ...ctx, systemContext: ctx.systemContext?.toUpperCase() }
  },
}

const baseCtx: RequestContext = {
  adapter: "opencode",
  body: {},
  headers: new Headers(),
  model: "sonnet",
  messages: [],
  stream: false,
  workingDirectory: "/tmp",
  blockedTools: [],
  incompatibleTools: [],
  allowedMcpTools: [],
  sdkAgents: {},
  supportsThinking: false,
  shouldTrackFileChanges: true,
  leaksCwdViaSystemReminder: false,
  metadata: {},
}

// Straight unit test — call your hook directly
const result = plugin.onRequest!({ ...baseCtx, systemContext: "hello" })
console.assert(result.systemContext === "HELLO")
```

For integration-style tests (multiple plugins chained, adapter scoping, error isolation), you can import the runtime helpers:

```ts
import { runTransformHook, createRequestContext } from "@rynfar/meridian"

const ctx = createRequestContext({
  adapter: "opencode",
  body: {},
  headers: new Headers(),
  model: "sonnet",
  messages: [],
  stream: false,
  workingDirectory: "/tmp",
})

const result = runTransformHook([plugin], "onRequest", ctx, "opencode")
```

## Plugin Management UI

Visit `http://localhost:3456/plugins` to:
- See all discovered plugins and their status
- View which hooks each plugin registers
- View adapter scope
- Reload plugins without restarting

## Roadmap

**Planned hooks:**
- `onToolUse` — intercept, block, or modify tool calls before SDK execution
- `onToolResult` — observe or transform tool results after execution
- `onError` — custom error handling, logging, retry decisions

**Planned capabilities:**
- Plugin templates — `meridian plugin init` scaffolding
- Automatic file watching — explicit `POST /plugins/reload` already reloads edited entry modules
- Plugin marketplace — community-curated directory
