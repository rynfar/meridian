# Meridian Plugin Authoring Guide

Plugins let you customize Meridian's request/response behavior without modifying core code. Drop a compiled `.js` file in `~/.config/meridian/plugins/` and restart Meridian, or point `plugins.json` at a file anywhere on disk (useful for plugins installed as their own npm packages or cloned repos).

> **Runtime note.** The plugin loader uses dynamic `import()`. If you run meridian via `bun`, `.ts` plugin files work directly; if you run via `node` (the default for npm installs), plugins must be compiled to `.js`. When in doubt, ship `.js`.

## Quick Start

The fastest path: author the plugin in its own repo, compile to JavaScript, and reference the built file from `plugins.json`.

1. Scaffold a plugin package (TypeScript recommended):
   ```bash
   mkdir my-meridian-plugin && cd my-meridian-plugin
   npm init -y
   npm install --save-peer @rynfar/meridian
   npm install --save-dev typescript
   npx tsc --init
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

Called after the SDK responds. Modify response content before it's sent to the client.

```ts
onResponse(ctx) {
  return {
    ...ctx,
    content: ctx.content.filter(block => block.type !== "thinking"),
  }
}
```

### onTelemetry

Observe-only hook for logging/metrics. Return value is ignored.

```ts
onTelemetry(ctx) {
  console.log(`Request ${ctx.requestId}: ${ctx.inputTokens}in/${ctx.outputTokens}out`)
}
```

## Adapter Scoping

Restrict a plugin to specific adapters:

```ts
export default {
  name: "opencode-only",
  adapters: ["opencode"],
  onRequest(ctx) { /* only runs for OpenCode requests */ },
}
```

Available adapters: `opencode`, `crush`, `droid`, `pi`, `forgecode`, `passthrough`

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

If a plugin throws, it is skipped and the next plugin runs. The proxy never crashes due to a plugin error. Check the `/plugins` UI for error details.

## Testing Plugins

Transforms are pure functions — hand them a context and assert on the return value. You don't need meridian's pipeline runner for unit tests:

```ts
import type { Transform, RequestContext } from "@rynfar/meridian"
import plugin from "./src/index.js"

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
- `onSession` — override session resume/undo/diverged decisions
- `onToolUse` — intercept, block, or modify tool calls before SDK execution
- `onToolResult` — observe or transform tool results after execution
- `onError` — custom error handling, logging, retry decisions

**Planned capabilities:**
- Plugin npm packages — install via `npm install meridian-plugin-*`
- Plugin templates — `meridian plugin init` scaffolding
- Hot reload — pick up changes without restart
- Plugin marketplace — community-curated directory
