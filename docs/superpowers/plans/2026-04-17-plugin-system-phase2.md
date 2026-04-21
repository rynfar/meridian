# Plugin System Phase 2: Pipeline Integration + Plugin Loading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the transform pipeline into server.ts (replacing direct adapter method calls), then add the user-facing plugin system — auto-scan, config, validation, UI, and docs.

**Architecture:** server.ts runs the transform pipeline at request start, producing a `RequestContext` with all behavioral values. Adapter methods that currently configure tools/passthrough/thinking/etc. are replaced with reads from the pipeline context. query.ts gets updated to accept pipeline values instead of an adapter reference. Plugins are loaded from `~/.config/meridian/plugins/` at startup, validated, and inserted into the pipeline after adapter transforms.

**Tech Stack:** TypeScript, Bun test runner, Hono (HTTP framework), Claude Agent SDK

**Spec:** `docs/superpowers/specs/2026-04-17-plugin-system-design.md`

**Branch:** `feat/plugin-system-phase2` (based on `feat/plugin-system-phase1`)

**Baseline:** 1296 tests passing (1260 original + 36 Phase 1)

---

## File Structure

```
src/proxy/
  server.ts           — MODIFY: run pipeline, replace ~18 adapter calls with ctx reads, add /plugins routes
  query.ts            — MODIFY: accept pipeline values instead of adapter reference
  transform.ts        — EXISTS (Phase 1)
  transforms/
    registry.ts       — EXISTS (Phase 1)
    opencode.ts       — EXISTS (Phase 1)
    crush.ts          — EXISTS (Phase 1)
    droid.ts          — EXISTS (Phase 1)
    pi.ts             — EXISTS (Phase 1)
    forgecode.ts      — EXISTS (Phase 1)
    passthrough.ts    — EXISTS (Phase 1)
  plugins/
    loader.ts         — NEW: auto-scan, plugins.json parsing, plugin loading
    validation.ts     — NEW: validate Transform exports at load time
    types.ts          — NEW: PluginConfig, PluginEntry, PluginStatus types
    pluginPage.ts     — NEW: /plugins UI HTML page
src/__tests__/
  plugin-loader.test.ts      — NEW: loader tests
  plugin-validation.test.ts  — NEW: validation tests
  server-pipeline.test.ts    — NEW: verify server.ts uses pipeline (integration)
examples/plugins/
  system-prompt-redirect.ts  — NEW: example plugin
PLUGINS.md                   — NEW: authoring guide
```

---

### Task 1: Migrate query.ts to accept pipeline values

**Files:**
- Modify: `src/proxy/query.ts`
- Test: existing tests (no new tests — this is a signature change verified by existing suite)

query.ts currently imports `AgentAdapter` and calls `adapter.getBlockedBuiltinTools()`, `adapter.getAgentIncompatibleTools()`, `adapter.getMcpServerName()`, `adapter.getAllowedMcpTools()`. Replace these with direct values passed via QueryContext.

- [ ] **Step 1: Update QueryContext to accept pipeline values**

In `src/proxy/query.ts`, replace the `adapter` field with pipeline values:

```ts
// Remove this:
import type { AgentAdapter } from "./adapter"

// In QueryContext interface, replace:
//   /** The agent adapter providing tool configuration */
//   adapter: AgentAdapter
// With:
  /** Blocked SDK built-in tools (from pipeline) */
  blockedTools: readonly string[]
  /** Agent-incompatible tools (from pipeline) */
  incompatibleTools: readonly string[]
  /** MCP server name for this adapter */
  mcpServerName: string
  /** Allowed MCP tools (from pipeline) */
  allowedMcpTools: readonly string[]
```

- [ ] **Step 2: Update buildQueryOptions to use the new fields**

Replace lines 119-122 of `buildQueryOptions`:

```ts
// Old:
const blockedTools = [...adapter.getBlockedBuiltinTools(), ...adapter.getAgentIncompatibleTools()]
const mcpServerName = adapter.getMcpServerName()
const allowedMcpTools = [...adapter.getAllowedMcpTools()]

// New (in the destructure at top):
blockedTools, incompatibleTools, mcpServerName, allowedMcpTools,

// And at usage site:
const allBlockedTools = [...blockedTools, ...incompatibleTools]
```

Then replace `blockedTools` with `allBlockedTools` in the two `disallowedTools` spreads below (lines ~151 and ~158), and replace `mcpServerName` / `allowedMcpTools` references as needed (they're already the right names, just different source).

- [ ] **Step 3: Run tests**

```bash
npx bun test 2>&1 | tail -5
```

This will fail — server.ts passes `adapter` to buildQueryOptions. That's expected. We fix it in Task 2. For now, verify the type errors are only in server.ts, not query.ts itself:

```bash
npx bun build src/proxy/query.ts --no-bundle 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/proxy/query.ts
git commit -m "refactor: replace adapter reference in QueryContext with pipeline values"
```

---

### Task 2: Wire transform pipeline into server.ts

**Files:**
- Modify: `src/proxy/server.ts`

This is the core migration. At the top of the request handler, run the transform pipeline to produce a `RequestContext`, then replace adapter behavioral method calls with reads from the pipeline context.

- [ ] **Step 1: Add pipeline imports to server.ts**

Add near the top imports:

```ts
import { runTransformHook, buildPipeline, createRequestContext, type RequestContext } from "./transform"
import { getAdapterTransforms } from "./transforms/registry"
```

- [ ] **Step 2: Run the pipeline after adapter detection**

After `const adapter = detectAdapter(c)` (around line 289) and after `systemContext` is built from `body.system` (around line 338), add the pipeline execution. Insert after the systemContext construction (after line 338):

```ts
        // --- Transform pipeline ---
        // Run adapter transforms to populate SDK configuration.
        // Plugin transforms will be added here in Phase 2.
        const adapterTransforms = getAdapterTransforms(adapter.name)
        const pipeline = buildPipeline(adapterTransforms, [])
        const pipelineCtx = runTransformHook(pipeline, "onRequest", createRequestContext({
          adapter: adapter.name,
          body,
          headers: c.req.raw.headers,
          model,
          messages: body.messages || [],
          systemContext,
          tools: body.tools,
          stream: body.stream ?? false,
          workingDirectory,
        }), adapter.name)
```

- [ ] **Step 3: Replace adapter behavioral calls with pipeline context reads**

Replace each adapter behavioral method call:

**Line ~310** — `adapter.prefersStreaming?.(body)`:
```ts
// Old:
const adapterStreamPref = adapter.prefersStreaming?.(body)
const stream = adapterStreamPref !== undefined ? adapterStreamPref : (body.stream ?? false)

// New:
const stream = pipelineCtx.prefersStreaming !== undefined ? pipelineCtx.prefersStreaming : (body.stream ?? false)
```

**Line ~482-487** — SDK agents and system context:
```ts
// Old:
const sdkAgents = adapter.buildSdkAgents?.(body, adapter.getAllowedMcpTools()) ?? {}
...
systemContext += adapter.buildSystemContextAddendum?.(body, sdkAgents) ?? ""

// New:
const sdkAgents = pipelineCtx.sdkAgents
const validAgentNames = Object.keys(sdkAgents)
...
// System context addendum is already applied by the transform
systemContext = pipelineCtx.systemContext ?? systemContext
```

**Line ~493** — sanitize options:
```ts
// Old:
stripSystemReminder: adapter.leaksCwdViaSystemReminder?.() ?? false,

// New:
stripSystemReminder: pipelineCtx.leaksCwdViaSystemReminder,
```

**Line ~643** — passthrough mode:
```ts
// Old:
const adapterPassthrough = adapter.usesPassthrough?.()
const passthrough = adapterPassthrough !== undefined ? adapterPassthrough : envBool("PASSTHROUGH")

// New:
const passthrough = pipelineCtx.passthrough !== undefined ? pipelineCtx.passthrough : envBool("PASSTHROUGH")
```

**Line ~653** — setting sources:
```ts
// Old:
: adapter.getSettingSources?.() ?? []

// New:
: pipelineCtx.settingSources ?? []
```

**Line ~677** — core tool names for passthrough MCP:
```ts
// Old:
passthroughMcp = createPassthroughMcpServer(requestTools, adapter.getCoreToolNames?.())

// New:
passthroughMcp = createPassthroughMcpServer(requestTools, pipelineCtx.coreToolNames ? [...pipelineCtx.coreToolNames] : undefined)
```

**Line ~689** — core tool names for deferred count:
```ts
// Old:
const coreNames = adapter.getCoreToolNames?.()

// New:
const coreNames = pipelineCtx.coreToolNames ? [...pipelineCtx.coreToolNames] : undefined
```

**Line ~702** — MCP prefix:
```ts
// Old:
const mcpPrefix = `mcp__${adapter.getMcpServerName()}__`

// New:
const mcpPrefix = `mcp__${adapter.getMcpServerName()}__`
// NOTE: getMcpServerName stays on the adapter (identity method)
```

**Line ~704** — file change tracking:
```ts
// Old:
&& adapter.shouldTrackFileChanges?.() !== false

// New:
&& pipelineCtx.shouldTrackFileChanges
```

**Line ~739** — SDK hooks:
```ts
// Old:
...(adapter.buildSdkHooks?.(body, sdkAgents) ?? {}),

// New:
...(pipelineCtx.sdkHooks ?? {}),
```

**Lines ~969, ~1436** — thinking support:
```ts
// Old:
!adapter.supportsThinking?.()

// New:
!pipelineCtx.supportsThinking
```

**Lines ~1041-1044, ~1607-1610** — file change extraction:
```ts
// Old:
adapter.extractFileChangesFromToolUse
adapter.extractFileChangesFromToolUse.bind(adapter)

// New:
pipelineCtx.extractFileChangesFromToolUse
pipelineCtx.extractFileChangesFromToolUse
// No .bind() needed — it's a standalone function, not a method
```

- [ ] **Step 4: Update the buildQueryOptions call sites**

server.ts calls `buildQueryOptions(...)` in two places (streaming and non-streaming). Update both to pass pipeline values instead of `adapter`:

```ts
// Old:
adapter,

// New:
blockedTools: pipelineCtx.blockedTools,
incompatibleTools: pipelineCtx.incompatibleTools,
mcpServerName: adapter.getMcpServerName(),
allowedMcpTools: pipelineCtx.allowedMcpTools,
```

Remove `adapter` from both QueryContext constructions.

- [ ] **Step 5: Run tests**

```bash
npx bun test 2>&1 | tail -5
```

Expected: 1296 pass, 0 fail. The parity tests guarantee transforms produce identical output.

- [ ] **Step 6: Commit**

```bash
git add src/proxy/server.ts
git commit -m "refactor: wire transform pipeline into server.ts request handler"
```

---

### Task 3: Plugin types and validation

**Files:**
- Create: `src/proxy/plugins/types.ts`
- Create: `src/proxy/plugins/validation.ts`
- Create: `src/__tests__/plugin-validation.test.ts`

- [ ] **Step 1: Create types.ts**

```ts
import type { Transform } from "../transform"

export interface PluginEntry {
  path: string
  enabled: boolean
}

export interface PluginConfig {
  plugins: PluginEntry[]
}

export type PluginStatus = "active" | "disabled" | "error"

export interface LoadedPlugin {
  name: string
  description?: string
  version?: string
  adapters?: string[]
  hooks: string[]
  status: PluginStatus
  error?: string
  path: string
  transform: Transform
}
```

- [ ] **Step 2: Add error isolation to the pipeline runner**

In `src/proxy/transform.ts`, update `runTransformHook` to catch plugin errors gracefully:

```ts
export function runTransformHook<T>(
  transforms: readonly Transform[],
  hook: TransformHook,
  ctx: T,
  adapterName: string,
): T {
  return transforms.reduce<T>((acc, transform) => {
    const fn = transform[hook] as ((ctx: T) => T) | undefined
    if (!fn) return acc
    if (transform.adapters && !transform.adapters.includes(adapterName)) return acc
    try {
      return fn.call(transform, acc)
    } catch (err) {
      console.error(`[PLUGIN] Transform "${transform.name}" threw in ${hook}: ${err instanceof Error ? err.message : String(err)}`)
      return acc
    }
  }, ctx)
}
```

Same for `runObserveHook`:

```ts
export function runObserveHook<T>(
  transforms: readonly Transform[],
  hook: ObserveHook,
  ctx: T,
  adapterName: string,
): void {
  for (const transform of transforms) {
    const fn = transform[hook] as ((ctx: T) => void) | undefined
    if (!fn) continue
    if (transform.adapters && !transform.adapters.includes(adapterName)) continue
    try {
      fn.call(transform, ctx)
    } catch (err) {
      console.error(`[PLUGIN] Transform "${transform.name}" threw in ${hook}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
```

- [ ] **Step 3: Write validation tests**

```ts
import { describe, it, expect } from "bun:test"
import { validateTransform } from "../proxy/plugins/validation"

describe("validateTransform", () => {
  it("accepts a valid transform with name and onRequest", () => {
    const result = validateTransform({
      name: "test-plugin",
      onRequest: (ctx: any) => ctx,
    })
    expect(result.valid).toBe(true)
    expect(result.hooks).toEqual(["onRequest"])
  })

  it("accepts a transform with all v1 hooks", () => {
    const result = validateTransform({
      name: "full-plugin",
      onRequest: (ctx: any) => ctx,
      onResponse: (ctx: any) => ctx,
      onTelemetry: () => {},
    })
    expect(result.valid).toBe(true)
    expect(result.hooks).toEqual(["onRequest", "onResponse", "onTelemetry"])
  })

  it("accepts a transform with only name (no hooks)", () => {
    const result = validateTransform({ name: "noop" })
    expect(result.valid).toBe(true)
    expect(result.hooks).toEqual([])
  })

  it("rejects null/undefined", () => {
    expect(validateTransform(null).valid).toBe(false)
    expect(validateTransform(undefined).valid).toBe(false)
  })

  it("rejects non-object values", () => {
    expect(validateTransform("string").valid).toBe(false)
    expect(validateTransform(42).valid).toBe(false)
  })

  it("rejects object without name", () => {
    const result = validateTransform({ onRequest: () => {} })
    expect(result.valid).toBe(false)
    expect(result.error).toContain("name")
  })

  it("rejects object with non-string name", () => {
    const result = validateTransform({ name: 123 })
    expect(result.valid).toBe(false)
    expect(result.error).toContain("name")
  })

  it("rejects hooks that are not functions", () => {
    const result = validateTransform({ name: "bad", onRequest: "not a function" })
    expect(result.valid).toBe(false)
    expect(result.error).toContain("onRequest")
  })

  it("warns on unknown adapter names but still validates", () => {
    const result = validateTransform({
      name: "scoped",
      adapters: ["opencode", "unknown-agent"],
    })
    expect(result.valid).toBe(true)
    expect(result.warnings).toContain("unknown-agent")
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx bun test src/__tests__/plugin-validation.test.ts 2>&1
```

Expected: FAIL (validateTransform doesn't exist yet)

- [ ] **Step 4: Create validation.ts**

```ts
const KNOWN_ADAPTERS = ["opencode", "crush", "droid", "pi", "forgecode", "passthrough"]
const KNOWN_HOOKS = ["onRequest", "onResponse", "onTelemetry", "onSession", "onToolUse", "onToolResult", "onError"]

export interface ValidationResult {
  valid: boolean
  hooks: string[]
  error?: string
  warnings?: string[]
}

export function validateTransform(exported: unknown): ValidationResult {
  if (exported == null || typeof exported !== "object") {
    return { valid: false, hooks: [], error: "Plugin must export an object" }
  }

  const obj = exported as Record<string, unknown>

  if (typeof obj.name !== "string" || obj.name.length === 0) {
    return { valid: false, hooks: [], error: "Plugin must have a name: string property" }
  }

  const hooks: string[] = []
  for (const hook of KNOWN_HOOKS) {
    if (obj[hook] !== undefined) {
      if (typeof obj[hook] !== "function") {
        return { valid: false, hooks: [], error: `${hook} must be a function, got ${typeof obj[hook]}` }
      }
      hooks.push(hook)
    }
  }

  const warnings: string[] = []
  if (Array.isArray(obj.adapters)) {
    for (const adapter of obj.adapters) {
      if (typeof adapter === "string" && !KNOWN_ADAPTERS.includes(adapter)) {
        warnings.push(adapter)
      }
    }
  }

  return {
    valid: true,
    hooks,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
```

- [ ] **Step 5: Run validation tests**

```bash
npx bun test src/__tests__/plugin-validation.test.ts
```

Expected: all pass.

- [ ] **Step 6: Run full suite**

```bash
npx bun test 2>&1 | tail -5
```

Expected: baseline + new tests, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add src/proxy/plugins/ src/__tests__/plugin-validation.test.ts
git commit -m "feat: add plugin types and transform validation"
```

---

### Task 4: Plugin loader

**Files:**
- Create: `src/proxy/plugins/loader.ts`
- Create: `src/__tests__/plugin-loader.test.ts`

- [ ] **Step 1: Write loader tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { loadPlugins, parsePluginConfig } from "../proxy/plugins/loader"

describe("parsePluginConfig", () => {
  it("returns empty array for missing file", () => {
    const result = parsePluginConfig("/nonexistent/plugins.json")
    expect(result).toEqual([])
  })

  it("returns empty array for invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-test-"))
    const configPath = join(dir, "plugins.json")
    writeFileSync(configPath, "not json")
    const result = parsePluginConfig(configPath)
    expect(result).toEqual([])
    rmSync(dir, { recursive: true })
  })

  it("parses valid plugins.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-test-"))
    const configPath = join(dir, "plugins.json")
    writeFileSync(configPath, JSON.stringify({
      plugins: [
        { path: "a.ts", enabled: true },
        { path: "b.ts", enabled: false },
      ]
    }))
    const result = parsePluginConfig(configPath)
    expect(result).toEqual([
      { path: "a.ts", enabled: true },
      { path: "b.ts", enabled: false },
    ])
    rmSync(dir, { recursive: true })
  })
})

describe("loadPlugins", () => {
  let pluginDir: string

  beforeEach(() => {
    pluginDir = mkdtempSync(join(tmpdir(), "meridian-plugins-"))
  })

  afterEach(() => {
    rmSync(pluginDir, { recursive: true, force: true })
  })

  it("returns empty array when plugin directory does not exist", async () => {
    const result = await loadPlugins("/nonexistent/plugins")
    expect(result).toEqual([])
  })

  it("loads a valid plugin from directory", async () => {
    writeFileSync(join(pluginDir, "test-plugin.ts"), `
      export default {
        name: "test-plugin",
        version: "1.0.0",
        onRequest: (ctx) => ctx,
      }
    `)
    const result = await loadPlugins(pluginDir)
    expect(result.length).toBe(1)
    expect(result[0].name).toBe("test-plugin")
    expect(result[0].status).toBe("active")
    expect(result[0].hooks).toContain("onRequest")
  })

  it("skips non-ts/js files", async () => {
    writeFileSync(join(pluginDir, "readme.md"), "# Not a plugin")
    writeFileSync(join(pluginDir, "valid.ts"), `
      export default { name: "valid", onRequest: (ctx) => ctx }
    `)
    const result = await loadPlugins(pluginDir)
    expect(result.length).toBe(1)
    expect(result[0].name).toBe("valid")
  })

  it("marks invalid plugins as error", async () => {
    writeFileSync(join(pluginDir, "bad.ts"), `
      export default { notAName: true }
    `)
    const result = await loadPlugins(pluginDir)
    expect(result.length).toBe(1)
    expect(result[0].status).toBe("error")
    expect(result[0].error).toContain("name")
  })

  it("skips duplicate plugin names", async () => {
    writeFileSync(join(pluginDir, "a.ts"), `
      export default { name: "dupe", onRequest: (ctx) => ctx }
    `)
    writeFileSync(join(pluginDir, "b.ts"), `
      export default { name: "dupe", onRequest: (ctx) => ({ ...ctx, model: "changed" }) }
    `)
    const result = await loadPlugins(pluginDir)
    const active = result.filter(p => p.status === "active")
    const skipped = result.filter(p => p.status === "error")
    expect(active.length).toBe(1)
    expect(skipped.length).toBe(1)
    expect(skipped[0].error).toContain("duplicate")
  })

  it("respects plugins.json enabled flag", async () => {
    writeFileSync(join(pluginDir, "disabled.ts"), `
      export default { name: "disabled-plugin", onRequest: (ctx) => ctx }
    `)
    const configPath = join(pluginDir, "plugins.json")
    writeFileSync(configPath, JSON.stringify({
      plugins: [{ path: "disabled.ts", enabled: false }]
    }))
    const result = await loadPlugins(pluginDir, configPath)
    expect(result.length).toBe(1)
    expect(result[0].status).toBe("disabled")
  })

  it("respects plugins.json ordering", async () => {
    writeFileSync(join(pluginDir, "a.ts"), `
      export default { name: "alpha", onRequest: (ctx) => ctx }
    `)
    writeFileSync(join(pluginDir, "b.ts"), `
      export default { name: "beta", onRequest: (ctx) => ctx }
    `)
    const configPath = join(pluginDir, "plugins.json")
    writeFileSync(configPath, JSON.stringify({
      plugins: [
        { path: "b.ts", enabled: true },
        { path: "a.ts", enabled: true },
      ]
    }))
    const result = await loadPlugins(pluginDir, configPath)
    const active = result.filter(p => p.status === "active")
    expect(active[0].name).toBe("beta")
    expect(active[1].name).toBe("alpha")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx bun test src/__tests__/plugin-loader.test.ts 2>&1 | head -20
```

Expected: FAIL (loadPlugins doesn't exist yet)

- [ ] **Step 3: Create loader.ts**

```ts
import { readdirSync, readFileSync, existsSync } from "fs"
import { join, isAbsolute, extname } from "path"
import type { Transform } from "../transform"
import type { PluginEntry, PluginConfig, LoadedPlugin } from "./types"
import { validateTransform } from "./validation"

export function parsePluginConfig(configPath: string): PluginEntry[] {
  if (!existsSync(configPath)) return []
  try {
    const raw = readFileSync(configPath, "utf-8")
    const parsed = JSON.parse(raw) as PluginConfig
    return Array.isArray(parsed.plugins) ? parsed.plugins : []
  } catch {
    return []
  }
}

export async function loadPlugins(
  pluginDir: string,
  configPath?: string,
): Promise<LoadedPlugin[]> {
  if (!existsSync(pluginDir)) return []

  const config = configPath ? parsePluginConfig(configPath) : []
  const configMap = new Map(config.map(e => [e.path, e]))

  // Discover plugin files
  let filenames: string[]
  try {
    filenames = readdirSync(pluginDir).filter(f => {
      const ext = extname(f)
      return ext === ".ts" || ext === ".js"
    })
  } catch {
    return []
  }

  // Order: plugins.json entries first (in order), then auto-discovered
  const ordered: Array<{ filename: string; entry?: PluginEntry }> = []
  const seen = new Set<string>()

  for (const entry of config) {
    const filename = isAbsolute(entry.path) ? entry.path : entry.path
    if (filenames.includes(filename) || isAbsolute(entry.path)) {
      ordered.push({ filename, entry })
      seen.add(filename)
    }
  }
  for (const filename of filenames) {
    if (!seen.has(filename)) {
      ordered.push({ filename })
    }
  }

  const loaded: LoadedPlugin[] = []
  const seenNames = new Set<string>()

  for (const { filename, entry } of ordered) {
    const filePath = isAbsolute(filename) ? filename : join(pluginDir, filename)

    if (entry && !entry.enabled) {
      loaded.push({
        name: filename,
        status: "disabled",
        hooks: [],
        path: filePath,
        transform: { name: filename },
      })
      continue
    }

    try {
      const mod = await import(filePath)
      const exported = mod.default ?? mod

      // Support single Transform or array of Transforms
      const transforms = Array.isArray(exported) ? exported : [exported]

      for (const item of transforms) {
        const validation = validateTransform(item)
        if (!validation.valid) {
          loaded.push({
            name: filename,
            status: "error",
            error: validation.error,
            hooks: [],
            path: filePath,
            transform: { name: filename },
          })
          continue
        }

        const transform = item as Transform

        if (seenNames.has(transform.name)) {
          loaded.push({
            name: transform.name,
            status: "error",
            error: `Skipped: duplicate plugin name "${transform.name}"`,
            hooks: validation.hooks,
            path: filePath,
            transform,
          })
          continue
        }

        seenNames.add(transform.name)
        loaded.push({
          name: transform.name,
          description: transform.description,
          version: transform.version,
          adapters: transform.adapters,
          hooks: validation.hooks,
          status: "active",
          path: filePath,
          transform,
        })
      }
    } catch (err) {
      loaded.push({
        name: filename,
        status: "error",
        error: `Failed to load: ${err instanceof Error ? err.message : String(err)}`,
        hooks: [],
        path: filePath,
        transform: { name: filename },
      })
    }
  }

  return loaded
}

export function getActiveTransforms(plugins: LoadedPlugin[]): Transform[] {
  return plugins
    .filter(p => p.status === "active")
    .map(p => p.transform)
}
```

- [ ] **Step 4: Run loader tests**

```bash
npx bun test src/__tests__/plugin-loader.test.ts
```

Expected: all pass.

- [ ] **Step 5: Run full suite**

```bash
npx bun test 2>&1 | tail -5
```

Expected: baseline + new tests, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/proxy/plugins/loader.ts src/__tests__/plugin-loader.test.ts
git commit -m "feat: add plugin loader with auto-scan and config support"
```

---

### Task 5: Integrate plugins into server.ts pipeline

**Files:**
- Modify: `src/proxy/server.ts`

Wire the plugin loader into server startup and the request pipeline. Add `/plugins/reload` endpoint.

- [ ] **Step 1: Add plugin loading at startup**

In server.ts, add imports:

```ts
import { loadPlugins, getActiveTransforms } from "./plugins/loader"
import type { LoadedPlugin } from "./plugins/types"
```

In the `startProxyServer` function, after the existing setup code (around where `const app = new Hono()` is), add plugin loading:

```ts
  // Load plugins from ~/.config/meridian/plugins/
  const pluginDir = join(homedir(), ".config", "meridian", "plugins")
  const pluginConfigPath = join(pluginDir, "plugins.json")
  let loadedPlugins: LoadedPlugin[] = []
  let pluginTransforms: Transform[] = []
  try {
    loadedPlugins = await loadPlugins(pluginDir, pluginConfigPath)
    pluginTransforms = getActiveTransforms(loadedPlugins)
    if (loadedPlugins.length > 0) {
      const active = loadedPlugins.filter(p => p.status === "active").length
      const disabled = loadedPlugins.filter(p => p.status === "disabled").length
      const errored = loadedPlugins.filter(p => p.status === "error").length
      console.error(`[PROXY] Plugins loaded: ${active} active, ${disabled} disabled, ${errored} errors`)
    }
  } catch (err) {
    console.error(`[PROXY] Plugin loading failed: ${err instanceof Error ? err.message : String(err)}`)
  }
```

Add `homedir` import from `node:os` if not already present.

- [ ] **Step 2: Update pipeline to include plugin transforms**

In the request handler, where we currently have:

```ts
const pipeline = buildPipeline(adapterTransforms, [])
```

Change to:

```ts
const pipeline = buildPipeline(adapterTransforms, pluginTransforms)
```

- [ ] **Step 3: Add /plugins/reload endpoint**

After the existing `/profiles` routes, add:

```ts
  app.post("/plugins/reload", async (c) => {
    try {
      loadedPlugins = await loadPlugins(pluginDir, pluginConfigPath)
      pluginTransforms = getActiveTransforms(loadedPlugins)
      const active = loadedPlugins.filter(p => p.status === "active").length
      console.error(`[PROXY] Plugins reloaded: ${active} active`)
      return c.json({
        success: true,
        plugins: loadedPlugins.map(p => ({
          name: p.name,
          status: p.status,
          hooks: p.hooks,
          ...(p.error ? { error: p.error } : {}),
        })),
      })
    } catch (err) {
      return c.json({ success: false, error: String(err) }, 500)
    }
  })
```

- [ ] **Step 4: Add /plugins/list API endpoint**

```ts
  app.get("/plugins/list", (c) => {
    return c.json({
      plugins: loadedPlugins.map(p => ({
        name: p.name,
        description: p.description,
        version: p.version,
        adapters: p.adapters,
        hooks: p.hooks,
        status: p.status,
        path: p.path,
        ...(p.error ? { error: p.error } : {}),
      })),
    })
  })
```

- [ ] **Step 5: Run tests**

```bash
npx bun test 2>&1 | tail -5
```

Expected: all pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/proxy/server.ts
git commit -m "feat: integrate plugin loader into server startup and pipeline"
```

---

### Task 6: Plugins UI page

**Files:**
- Create: `src/proxy/plugins/pluginPage.ts`
- Modify: `src/proxy/server.ts` (add GET /plugins route)

- [ ] **Step 1: Create pluginPage.ts**

Follow the same CSS pattern as `src/telemetry/landing.ts` (dark theme with violet accents):

```ts
export const pluginPageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian — Plugins</title>
<style>
  :root {
    --bg: #0f0b1a; --surface: #1a1030; --surface2: #221840; --border: #2d2545;
    --text: #e0e7ff; --muted: #8b8aa0; --accent: #8b5cf6; --accent2: #6366f1;
    --green: #3fb950; --yellow: #d29922; --red: #f85149;
    --violet: #a78bfa; --lavender: #c4b5fd;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         background: var(--bg); color: var(--text); line-height: 1.6; min-height: 100vh; }
  .container { max-width: 720px; margin: 0 auto; padding: 32px 24px; }

  .header { display: flex; align-items: center; gap: 16px; margin-bottom: 6px; }
  .header h1 { font-size: 24px; font-weight: 700; }
  .tagline { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .back-link { color: var(--accent); text-decoration: none; font-size: 13px; }
  .back-link:hover { text-decoration: underline; }

  .actions { display: flex; gap: 12px; margin-bottom: 24px; }
  .btn { padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border);
         background: var(--surface); color: var(--text); cursor: pointer; font-size: 13px; }
  .btn:hover { background: var(--surface2); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: white; }
  .btn.primary:hover { background: var(--accent2); }

  .plugin-list { display: flex; flex-direction: column; gap: 12px; }
  .plugin-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; }
  .plugin-card.error { border-color: var(--red); }
  .plugin-card.disabled { opacity: 0.6; }
  .plugin-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .plugin-name { font-weight: 600; font-size: 15px; }
  .plugin-version { color: var(--muted); font-size: 12px; }
  .status-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 500; }
  .status-badge.active { background: rgba(63,185,80,0.15); color: var(--green); }
  .status-badge.disabled { background: rgba(139,138,160,0.15); color: var(--muted); }
  .status-badge.error { background: rgba(248,81,73,0.15); color: var(--red); }
  .plugin-desc { color: var(--muted); font-size: 13px; margin-bottom: 8px; }
  .plugin-meta { display: flex; gap: 16px; font-size: 12px; color: var(--muted); }
  .plugin-error { color: var(--red); font-size: 12px; margin-top: 8px; padding: 8px;
                  background: rgba(248,81,73,0.08); border-radius: 6px; }
  .toggle-btn { background: none; border: 1px solid var(--border); color: var(--muted);
                padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; margin-left: auto; }
  .toggle-btn:hover { border-color: var(--accent); color: var(--text); }

  .empty { text-align: center; padding: 48px 24px; color: var(--muted); }
  .empty code { background: var(--surface2); padding: 2px 6px; border-radius: 4px; font-size: 13px; }
</style>
</head>
<body>
<div class="container">
  <a href="/" class="back-link">← Back to Meridian</a>
  <div class="header"><h1>Plugins</h1></div>
  <p class="tagline">Transform request and response behavior with composable plugins</p>

  <div class="actions">
    <button class="btn primary" onclick="reloadPlugins()">Reload Plugins</button>
  </div>

  <div id="plugin-list" class="plugin-list">
    <div class="empty">Loading...</div>
  </div>
</div>
<script>
async function fetchPlugins() {
  const res = await fetch('/plugins/list')
  const data = await res.json()
  renderPlugins(data.plugins || [])
}

function renderPlugins(plugins) {
  const container = document.getElementById('plugin-list')
  if (plugins.length === 0) {
    container.innerHTML = '<div class="empty">No plugins found.<br>Drop <code>.ts</code> or <code>.js</code> files in <code>~/.config/meridian/plugins/</code> and reload.</div>'
    return
  }
  container.innerHTML = plugins.map(p => {
    const statusClass = p.status
    return '<div class="plugin-card ' + statusClass + '">' +
      '<div class="plugin-header">' +
        '<span class="plugin-name">' + esc(p.name) + '</span>' +
        (p.version ? '<span class="plugin-version">v' + esc(p.version) + '</span>' : '') +
        '<span class="status-badge ' + statusClass + '">' + p.status + '</span>' +
      '</div>' +
      (p.description ? '<div class="plugin-desc">' + esc(p.description) + '</div>' : '') +
      '<div class="plugin-meta">' +
        (p.hooks.length > 0 ? '<span>Hooks: ' + p.hooks.join(', ') + '</span>' : '') +
        (p.adapters ? '<span>Adapters: ' + p.adapters.join(', ') + '</span>' : '<span>All adapters</span>') +
      '</div>' +
      (p.error ? '<div class="plugin-error">' + esc(p.error) + '</div>' : '') +
    '</div>'
  }).join('')
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML }

async function reloadPlugins() {
  const btn = document.querySelector('.btn.primary')
  btn.textContent = 'Reloading...'
  btn.disabled = true
  try {
    await fetch('/plugins/reload', { method: 'POST' })
    await fetchPlugins()
  } finally {
    btn.textContent = 'Reload Plugins'
    btn.disabled = false
  }
}

fetchPlugins()
</script>
</body>
</html>`
```

- [ ] **Step 2: Add /plugins route to server.ts**

After the `/plugins/list` and `/plugins/reload` routes, add:

```ts
  app.get("/plugins", async (c) => {
    const { pluginPageHtml } = await import("./plugins/pluginPage")
    return c.html(pluginPageHtml)
  })
```

- [ ] **Step 3: Run tests**

```bash
npx bun test 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/proxy/plugins/pluginPage.ts src/proxy/server.ts
git commit -m "feat: add /plugins UI page"
```

---

### Task 7: Example plugin + documentation

**Files:**
- Create: `examples/plugins/system-prompt-redirect.ts`
- Create: `PLUGINS.md`
- Modify: `README.md` (add Plugins section)

- [ ] **Step 1: Create example plugin**

```ts
/**
 * System Prompt Redirect
 *
 * Moves the client's system prompt into the first user message.
 * Useful for agents that need the system prompt visible in the
 * conversation history rather than as a separate API parameter.
 *
 * Drop this file in ~/.config/meridian/plugins/ to activate.
 */

import type { Transform, RequestContext } from "../../src/proxy/transform"

export default {
  name: "system-prompt-redirect",
  version: "1.0.0",
  description: "Moves client system prompt into the first user message",

  onRequest(ctx: RequestContext): RequestContext {
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

- [ ] **Step 2: Create PLUGINS.md**

```markdown
# Meridian Plugin Authoring Guide

Plugins let you customize Meridian's request/response behavior without modifying core code. Drop a `.ts` or `.js` file in `~/.config/meridian/plugins/` and restart Meridian.

## Quick Start

1. Create the plugins directory:
   ```bash
   mkdir -p ~/.config/meridian/plugins
   ```

2. Create a plugin file (e.g., `~/.config/meridian/plugins/my-plugin.ts`):
   ```ts
   export default {
     name: "my-plugin",
     version: "1.0.0",
     description: "What this plugin does",

     onRequest(ctx) {
       // Modify the request context and return it
       return { ...ctx, model: "custom-model" }
     },
   }
   ```

3. Restart Meridian or call `POST /plugins/reload`

4. Check `http://localhost:3456/plugins` to verify your plugin loaded

## Transform Interface

Plugins export a `Transform` object with optional hooks:

```ts
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

Control ordering and enable/disable via `~/.config/meridian/plugins/plugins.json`:

```json
{
  "plugins": [
    { "path": "system-prompt-redirect.ts", "enabled": true },
    { "path": "custom-logger.ts", "enabled": false }
  ]
}
```

- Array order = execution order in the pipeline
- `enabled: false` disables without deleting the file
- Plugins not in `plugins.json` are appended at the end, enabled by default

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

Test a transform in isolation:

```ts
import { createRequestContext, runTransformHook } from "@rynfar/meridian/transform"

const myPlugin = { name: "test", onRequest: (ctx) => ({ ...ctx, model: "custom" }) }

const ctx = createRequestContext({
  adapter: "opencode",
  body: {},
  headers: new Headers(),
  model: "sonnet",
  messages: [],
  stream: false,
  workingDirectory: "/tmp",
})

const result = runTransformHook([myPlugin], "onRequest", ctx, "opencode")
console.assert(result.model === "custom")
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
```

- [ ] **Step 3: Add Plugins section to README.md**

Read the existing README.md, then add a `## Plugins` section after the existing feature sections. Keep it concise:

```markdown
## Plugins

Extend Meridian's behavior with composable plugins — no core modifications needed.

**Quick start:** Drop a `.ts` or `.js` file in `~/.config/meridian/plugins/` and restart.

```ts
// ~/.config/meridian/plugins/my-plugin.ts
export default {
  name: "my-plugin",
  onRequest(ctx) {
    // modify request context
    return { ...ctx, systemContext: ctx.systemContext + "\nBe concise." }
  },
}
```

- **Manage plugins** at `http://localhost:3456/plugins`
- **Reload without restart:** `POST /plugins/reload`
- **Full guide:** See [PLUGINS.md](PLUGINS.md)
```

- [ ] **Step 4: Commit**

```bash
git add examples/plugins/system-prompt-redirect.ts PLUGINS.md README.md
git commit -m "docs: add PLUGINS.md authoring guide, example plugin, and README section"
```

---

### Task 8: Full verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run full test suite**

```bash
npx bun test 2>&1 | tail -5
```

Expected: baseline + new tests, 0 fail.

- [ ] **Step 2: Verify no existing test files modified**

```bash
git diff feat/plugin-system-phase1 -- 'src/__tests__/*.test.ts' --name-only | grep -v 'plugin-\|server-pipeline'
```

Expected: no output (only new test files, no modifications to existing tests).

- [ ] **Step 3: Review the diff**

```bash
git diff feat/plugin-system-phase1 --stat
```

Verify the changes are as expected.

- [ ] **Step 4: Restart launchd and smoke test**

```bash
launchctl unload ~/Library/LaunchAgents/com.rynfar.meridian.plist && launchctl load ~/Library/LaunchAgents/com.rynfar.meridian.plist
sleep 2
curl -s http://127.0.0.1:3456/health
curl -s http://127.0.0.1:3456/plugins/list
```

Expected: healthy response + empty plugins list (no plugins installed in default dir).

- [ ] **Step 5: Test plugin loading manually**

```bash
mkdir -p ~/.config/meridian/plugins
cat > ~/.config/meridian/plugins/test-plugin.ts << 'EOF'
export default {
  name: "smoke-test",
  version: "1.0.0",
  description: "Smoke test plugin — does nothing",
  onRequest(ctx) { return ctx },
}
EOF
curl -s -X POST http://127.0.0.1:3456/plugins/reload | jq .
```

Expected: plugin shows as active with onRequest hook.

- [ ] **Step 6: Clean up test plugin**

```bash
rm ~/.config/meridian/plugins/test-plugin.ts
curl -s -X POST http://127.0.0.1:3456/plugins/reload | jq .
```

Expected: empty plugins list.
