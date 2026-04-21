# Plugin System Phase 1: Adapter Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the `AgentAdapter` interface into `AgentIdentity` (5 identity methods) + `Transform` (behavioral hooks), build a pipeline runner, and refactor server.ts to use the pipeline — with zero behavioral change.

**Architecture:** Each adapter keeps its identity methods (session ID, CWD extraction, content normalization, MCP server name) while behavioral methods move into `Transform` objects. A pipeline runner chains adapter transforms at request time. server.ts reads configuration from the pipeline context instead of calling adapter methods directly. Existing adapters re-export composed objects so all 1260+ tests pass without modification.

**Tech Stack:** TypeScript, Bun test runner, Hono (HTTP framework)

**Spec:** `docs/superpowers/specs/2026-04-17-plugin-system-design.md`

**Branch:** `feat/plugin-system-phase1`

---

### Task 1: Create branch and verify baseline

**Files:**
- None (setup only)

- [ ] **Step 1: Create feature branch**

```bash
git checkout main
git pull origin main
git checkout -b feat/plugin-system-phase1
```

- [ ] **Step 2: Verify baseline test count**

```bash
npx bun test 2>&1 | tail -5
```

Expected: `1260 pass, 0 fail` (or current count — record exact number as the baseline)

- [ ] **Step 3: Commit baseline marker**

```bash
git commit --allow-empty -m "chore: start plugin system phase 1 — adapter refactor"
```

---

### Task 2: Define AgentIdentity interface

**Files:**
- Modify: `src/proxy/adapter.ts`

The existing `AgentAdapter` interface stays intact for backward compatibility. We add `AgentIdentity` as a subset interface that adapters will also satisfy.

- [ ] **Step 1: Add AgentIdentity interface above AgentAdapter**

In `src/proxy/adapter.ts`, add before the `AgentAdapter` interface:

```ts
/**
 * Core identity of an agent — detection, session tracking, CWD extraction.
 * This is the minimal interface for agent recognition. Behavioral customization
 * (tool filtering, system prompt modifications, hooks) lives in Transform objects.
 */
export interface AgentIdentity {
  /** Human-readable name for logging and transform scoping */
  readonly name: string

  /**
   * Extract a session ID from the request.
   * Returns undefined if the agent doesn't provide session tracking.
   */
  getSessionId(c: Context): string | undefined

  /**
   * Extract the client's working directory from the request body.
   * Returns undefined to fall back to CLAUDE_PROXY_WORKDIR or process.cwd().
   */
  extractWorkingDirectory(body: any): string | undefined

  /**
   * Content normalization — convert message content to a stable string
   * for hashing. Agents may send content in different formats.
   */
  normalizeContent(content: any): string

  /**
   * The MCP server name used by this agent.
   * Tools are registered as `mcp__{name}__{tool}`.
   */
  getMcpServerName(): string
}
```

- [ ] **Step 2: Make AgentAdapter extend AgentIdentity**

Change the AgentAdapter declaration from:

```ts
export interface AgentAdapter {
  /** Human-readable name for logging */
  readonly name: string
```

To:

```ts
export interface AgentAdapter extends AgentIdentity {
```

And remove the 5 duplicate method declarations from AgentAdapter (name, getSessionId, extractWorkingDirectory, normalizeContent, getMcpServerName) since they're now inherited from AgentIdentity.

- [ ] **Step 3: Run tests**

```bash
npx bun test 2>&1 | tail -5
```

Expected: same pass count, 0 fail. AgentAdapter extends AgentIdentity, so all existing implementations still satisfy it.

- [ ] **Step 4: Commit**

```bash
git add src/proxy/adapter.ts
git commit -m "refactor: extract AgentIdentity interface from AgentAdapter"
```

---

### Task 3: Define Transform interface and pipeline runner

**Files:**
- Create: `src/proxy/transform.ts`

- [ ] **Step 1: Create transform.ts with interfaces and pipeline runner**

```ts
/**
 * Transform pipeline — composable behavioral hooks for request/response processing.
 *
 * Adapters provide built-in transforms; plugins provide user-defined transforms.
 * Both use the same interface. The pipeline runner chains them in order, passing
 * each hook's output as the next hook's input.
 */

import type { FileChange } from "./fileChanges"
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk"

/**
 * A composable unit of request/response behavior.
 * Built-in adapter transforms and user plugins implement this interface.
 */
export interface Transform {
  /** Unique name for logging and UI display */
  name: string
  /** Human-readable description */
  description?: string
  /** Semver version string */
  version?: string
  /** Restrict to specific adapter names. Undefined = all adapters. */
  adapters?: string[]

  // v1 hooks
  onRequest?(ctx: RequestContext): RequestContext
  onResponse?(ctx: ResponseContext): ResponseContext
  onTelemetry?(ctx: TelemetryContext): void

  // Roadmap hooks (reserved, not yet called by the pipeline)
  onSession?(ctx: SessionContext): SessionContext
  onToolUse?(ctx: ToolUseContext): ToolUseContext
  onToolResult?(ctx: ToolResultContext): ToolResultContext
  onError?(ctx: ErrorContext): ErrorContext
}

/**
 * Request-time context. Transforms modify this to configure SDK behavior.
 * Immutable-in, modified-out — transforms return a new object.
 */
export interface RequestContext {
  /** Adapter name (readonly — set by pipeline runner) */
  readonly adapter: string
  /** Raw request body (readonly — use specific fields to modify) */
  readonly body: any
  /** Request headers (readonly) */
  readonly headers: Headers

  // Modifiable request fields
  model: string
  messages: any[]
  systemContext?: string
  tools?: any[]
  stream: boolean
  workingDirectory: string

  // SDK configuration (set by adapter transforms)
  blockedTools: readonly string[]
  incompatibleTools: readonly string[]
  allowedMcpTools: readonly string[]
  coreToolNames?: readonly string[]
  sdkAgents: Record<string, any>
  sdkHooks?: any
  passthrough?: boolean
  settingSources?: SettingSource[]
  supportsThinking: boolean
  shouldTrackFileChanges: boolean
  leaksCwdViaSystemReminder: boolean
  prefersStreaming?: boolean
  extractFileChangesFromToolUse?: (toolName: string, toolInput: unknown) => FileChange[]

  // Plugin-to-plugin state
  metadata: Record<string, unknown>
}

/**
 * Response-time context. Transforms can modify response content.
 */
export interface ResponseContext {
  readonly adapter: string
  content: any[]
  usage?: any
  metadata: Record<string, unknown>
}

/**
 * Telemetry context. Observe-only — return value is ignored.
 */
export interface TelemetryContext {
  readonly adapter: string
  readonly model: string
  readonly requestId: string
  readonly durationMs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheCreationTokens: number
  readonly cacheHitRate: number
}

// Roadmap context types (reserved, not yet used)
export interface SessionContext { readonly adapter: string; [key: string]: unknown }
export interface ToolUseContext { readonly adapter: string; [key: string]: unknown }
export interface ToolResultContext { readonly adapter: string; [key: string]: unknown }
export interface ErrorContext { readonly adapter: string; [key: string]: unknown }

/** Hook names that transform request/response data (return value used) */
export type TransformHook = "onRequest" | "onResponse" | "onSession" | "onToolUse" | "onToolResult" | "onError"

/** Hook names that are observe-only (return value ignored) */
export type ObserveHook = "onTelemetry"

/**
 * Run a data-transforming hook through the pipeline.
 * Each transform receives the previous transform's output.
 * Transforms scoped to other adapters are skipped.
 */
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
    return fn.call(transform, acc)
  }, ctx)
}

/**
 * Run an observe-only hook through the pipeline.
 * All matching transforms are called; return values are ignored.
 */
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
    fn.call(transform, ctx)
  }
}

/**
 * Build the ordered transform pipeline for a request.
 * Adapter built-in transforms run first, then plugins in config order.
 */
export function buildPipeline(
  adapterTransforms: readonly Transform[],
  pluginTransforms: readonly Transform[],
): Transform[] {
  return [...adapterTransforms, ...pluginTransforms]
}

/**
 * Create the initial RequestContext from HTTP request data.
 * Adapter transforms will populate SDK configuration fields.
 */
export function createRequestContext(params: {
  adapter: string
  body: any
  headers: Headers
  model: string
  messages: any[]
  systemContext?: string
  tools?: any[]
  stream: boolean
  workingDirectory: string
}): RequestContext {
  return {
    adapter: params.adapter,
    body: params.body,
    headers: params.headers,
    model: params.model,
    messages: params.messages,
    systemContext: params.systemContext,
    tools: params.tools,
    stream: params.stream,
    workingDirectory: params.workingDirectory,
    // Defaults — adapter transforms override these
    blockedTools: [],
    incompatibleTools: [],
    allowedMcpTools: [],
    sdkAgents: {},
    supportsThinking: false,
    shouldTrackFileChanges: true,
    leaksCwdViaSystemReminder: false,
    metadata: {},
  }
}
```

- [ ] **Step 2: Run tests (no tests use this yet, just verify no import errors)**

```bash
npx bun test 2>&1 | tail -5
```

Expected: same pass count, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add src/proxy/transform.ts
git commit -m "feat: add Transform interface and pipeline runner"
```

---

### Task 4: Unit tests for pipeline runner

**Files:**
- Create: `src/__tests__/transform-pipeline.test.ts`

- [ ] **Step 1: Write pipeline runner tests**

```ts
import { describe, it, expect } from "bun:test"
import {
  runTransformHook,
  runObserveHook,
  buildPipeline,
  createRequestContext,
  type Transform,
  type RequestContext,
  type TelemetryContext,
} from "../proxy/transform"

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return createRequestContext({
    adapter: "test",
    body: {},
    headers: new Headers(),
    model: "sonnet",
    messages: [],
    stream: false,
    workingDirectory: "/tmp",
    ...overrides,
  })
}

describe("runTransformHook", () => {
  it("returns context unchanged when no transforms have the hook", () => {
    const t: Transform = { name: "noop" }
    const ctx = makeCtx()
    const result = runTransformHook([t], "onRequest", ctx, "test")
    expect(result).toEqual(ctx)
  })

  it("chains transforms in order", () => {
    const t1: Transform = {
      name: "first",
      onRequest: (ctx) => ({ ...ctx, model: ctx.model + "-a" }),
    }
    const t2: Transform = {
      name: "second",
      onRequest: (ctx) => ({ ...ctx, model: ctx.model + "-b" }),
    }
    const ctx = makeCtx({ model: "base" })
    const result = runTransformHook([t1, t2], "onRequest", ctx, "test")
    expect(result.model).toBe("base-a-b")
  })

  it("skips transforms scoped to other adapters", () => {
    const t: Transform = {
      name: "opencode-only",
      adapters: ["opencode"],
      onRequest: (ctx) => ({ ...ctx, model: "changed" }),
    }
    const ctx = makeCtx({ model: "original" })
    const result = runTransformHook([t], "onRequest", ctx, "crush")
    expect(result.model).toBe("original")
  })

  it("runs transforms scoped to the matching adapter", () => {
    const t: Transform = {
      name: "opencode-only",
      adapters: ["opencode"],
      onRequest: (ctx) => ({ ...ctx, model: "changed" }),
    }
    const ctx = makeCtx({ model: "original" })
    const result = runTransformHook([t], "onRequest", ctx, "opencode")
    expect(result.model).toBe("changed")
  })

  it("runs transforms with no adapter scope for all adapters", () => {
    const t: Transform = {
      name: "global",
      onRequest: (ctx) => ({ ...ctx, model: "global" }),
    }
    const ctx = makeCtx()
    const result = runTransformHook([t], "onRequest", ctx, "anything")
    expect(result.model).toBe("global")
  })

  it("preserves metadata across transforms", () => {
    const t1: Transform = {
      name: "set-meta",
      onRequest: (ctx) => ({
        ...ctx,
        metadata: { ...ctx.metadata, key: "value" },
      }),
    }
    const t2: Transform = {
      name: "read-meta",
      onRequest: (ctx) => ({
        ...ctx,
        model: ctx.metadata.key === "value" ? "from-meta" : "no-meta",
      }),
    }
    const ctx = makeCtx()
    const result = runTransformHook([t1, t2], "onRequest", ctx, "test")
    expect(result.model).toBe("from-meta")
    expect(result.metadata.key).toBe("value")
  })

  it("does not mutate the original context", () => {
    const t: Transform = {
      name: "mutator",
      onRequest: (ctx) => ({ ...ctx, model: "changed" }),
    }
    const ctx = makeCtx({ model: "original" })
    runTransformHook([t], "onRequest", ctx, "test")
    expect(ctx.model).toBe("original")
  })
})

describe("runObserveHook", () => {
  it("calls all matching transforms", () => {
    const calls: string[] = []
    const t1: Transform = {
      name: "logger1",
      onTelemetry: () => { calls.push("t1") },
    }
    const t2: Transform = {
      name: "logger2",
      onTelemetry: () => { calls.push("t2") },
    }
    const ctx: TelemetryContext = {
      adapter: "test",
      model: "sonnet",
      requestId: "req-1",
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheHitRate: 0,
    }
    runObserveHook([t1, t2], "onTelemetry", ctx, "test")
    expect(calls).toEqual(["t1", "t2"])
  })

  it("skips transforms scoped to other adapters", () => {
    const calls: string[] = []
    const t: Transform = {
      name: "scoped",
      adapters: ["opencode"],
      onTelemetry: () => { calls.push("called") },
    }
    const ctx: TelemetryContext = {
      adapter: "crush",
      model: "sonnet",
      requestId: "req-1",
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheHitRate: 0,
    }
    runObserveHook([t], "onTelemetry", ctx, "crush")
    expect(calls).toEqual([])
  })
})

describe("buildPipeline", () => {
  it("orders adapter transforms before plugin transforms", () => {
    const adapter: Transform = { name: "adapter-t" }
    const plugin: Transform = { name: "plugin-t" }
    const pipeline = buildPipeline([adapter], [plugin])
    expect(pipeline.map((t) => t.name)).toEqual(["adapter-t", "plugin-t"])
  })

  it("returns empty array when no transforms", () => {
    expect(buildPipeline([], [])).toEqual([])
  })
})

describe("createRequestContext", () => {
  it("sets defaults for SDK configuration fields", () => {
    const ctx = makeCtx()
    expect(ctx.blockedTools).toEqual([])
    expect(ctx.incompatibleTools).toEqual([])
    expect(ctx.allowedMcpTools).toEqual([])
    expect(ctx.sdkAgents).toEqual({})
    expect(ctx.supportsThinking).toBe(false)
    expect(ctx.shouldTrackFileChanges).toBe(true)
    expect(ctx.leaksCwdViaSystemReminder).toBe(false)
    expect(ctx.metadata).toEqual({})
  })
})
```

- [ ] **Step 2: Run the new tests**

```bash
npx bun test src/__tests__/transform-pipeline.test.ts
```

Expected: all pass.

- [ ] **Step 3: Run full suite to verify no regressions**

```bash
npx bun test 2>&1 | tail -5
```

Expected: baseline + new tests, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/transform-pipeline.test.ts
git commit -m "test: add pipeline runner unit tests"
```

---

### Task 5: Extract OpenCode adapter transforms

**Files:**
- Create: `src/proxy/transforms/opencode.ts`
- Modify: `src/proxy/adapters/opencode.ts` (add getTransforms export, keep AgentAdapter intact)

This is the reference implementation — OpenCode is the most complex adapter with buildSdkAgents, buildSdkHooks, and buildSystemContextAddendum. Other adapters follow this pattern.

- [ ] **Step 1: Create transforms/opencode.ts**

```ts
/**
 * OpenCode behavioral transforms.
 *
 * Extracted from the OpenCode adapter — these transforms provide
 * OpenCode-specific SDK configuration through the pipeline.
 */

import type { Transform, RequestContext } from "../transform"
import { extractFileChangesFromBash, type FileChange } from "../fileChanges"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, ALLOWED_MCP_TOOLS } from "../tools"
import { buildAgentDefinitions } from "../agentDefs"
import { fuzzyMatchAgentName } from "../agentMatch"

export const openCodeTransforms: Transform[] = [
  {
    name: "opencode-core",
    adapters: ["opencode"],

    onRequest(ctx: RequestContext): RequestContext {
      const body = ctx.body

      // Tool configuration
      const blockedTools = BLOCKED_BUILTIN_TOOLS
      const incompatibleTools = CLAUDE_CODE_ONLY_TOOLS
      const allowedMcpTools = ALLOWED_MCP_TOOLS
      const coreToolNames: readonly string[] = ["read", "write", "edit", "bash", "glob", "grep"]

      // Passthrough mode (env var, default true)
      const envVal = process.env.MERIDIAN_PASSTHROUGH ?? process.env.CLAUDE_PROXY_PASSTHROUGH
      const passthrough = !(envVal === "0" || envVal === "false" || envVal === "no")

      // SDK agents (parse Task tool description)
      let sdkAgents: Record<string, any> = {}
      if (Array.isArray(body.tools)) {
        const taskTool = body.tools.find((t: any) => t.name === "task" || t.name === "Task")
        if (taskTool?.description) {
          sdkAgents = buildAgentDefinitions(taskTool.description, [...allowedMcpTools])
        }
      }

      // SDK hooks (fuzzy-match agent names in Task tool)
      let sdkHooks: any = undefined
      const validAgentNames = Object.keys(sdkAgents)
      if (validAgentNames.length > 0) {
        sdkHooks = {
          PreToolUse: [{
            matcher: "Task",
            hooks: [async (input: any) => ({
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                updatedInput: {
                  ...input.tool_input,
                  subagent_type: fuzzyMatchAgentName(
                    String(input.tool_input?.subagent_type || ""),
                    validAgentNames
                  ),
                },
              },
            })],
          }],
        }
      }

      // System context addendum (agent name hints)
      let systemContext = ctx.systemContext
      if (validAgentNames.length > 0 && systemContext !== undefined) {
        systemContext += `\n\nIMPORTANT: When using the task/Task tool, the subagent_type parameter must be one of these exact values (case-sensitive, lowercase): ${validAgentNames.join(", ")}. Do NOT capitalize or modify these names.`
      } else if (validAgentNames.length > 0) {
        systemContext = `IMPORTANT: When using the task/Task tool, the subagent_type parameter must be one of these exact values (case-sensitive, lowercase): ${validAgentNames.join(", ")}. Do NOT capitalize or modify these names.`
      }

      // File change extraction function
      const extractFileChangesFromToolUse = (toolName: string, toolInput: unknown): FileChange[] => {
        const input = toolInput as Record<string, unknown> | null | undefined
        const filePath = input?.filePath ?? input?.file_path ?? input?.path
        const lowerName = toolName.toLowerCase()
        if (lowerName === "write" && filePath) {
          return [{ operation: "wrote", path: String(filePath) }]
        }
        if ((lowerName === "edit" || lowerName === "multiedit") && filePath) {
          return [{ operation: "edited", path: String(filePath) }]
        }
        if (lowerName === "bash" && input?.command) {
          return extractFileChangesFromBash(String(input.command))
        }
        return []
      }

      return {
        ...ctx,
        blockedTools,
        incompatibleTools,
        allowedMcpTools,
        coreToolNames,
        passthrough,
        sdkAgents,
        sdkHooks,
        systemContext,
        supportsThinking: true,
        shouldTrackFileChanges: false,
        extractFileChangesFromToolUse,
      }
    },
  },
]
```

- [ ] **Step 2: Add getTransforms export to adapters/opencode.ts**

Add at the bottom of `src/proxy/adapters/opencode.ts`:

```ts
import { openCodeTransforms } from "../transforms/opencode"

/** Adapter transforms for pipeline integration */
export { openCodeTransforms }
```

- [ ] **Step 3: Run tests**

```bash
npx bun test 2>&1 | tail -5
```

Expected: same pass count, 0 fail. The adapter still exports all original methods — transforms are additive.

- [ ] **Step 4: Commit**

```bash
git add src/proxy/transforms/opencode.ts src/proxy/adapters/opencode.ts
git commit -m "refactor: extract OpenCode behavioral transforms"
```

---

### Task 6: Extract transforms for remaining adapters

**Files:**
- Create: `src/proxy/transforms/crush.ts`
- Create: `src/proxy/transforms/droid.ts`
- Create: `src/proxy/transforms/pi.ts`
- Create: `src/proxy/transforms/forgecode.ts`
- Create: `src/proxy/transforms/passthrough.ts`
- Modify: `src/proxy/adapters/crush.ts` (add getTransforms re-export)
- Modify: `src/proxy/adapters/droid.ts` (add getTransforms re-export)
- Modify: `src/proxy/adapters/pi.ts` (add getTransforms re-export)
- Modify: `src/proxy/adapters/forgecode.ts` (add getTransforms re-export)
- Modify: `src/proxy/adapters/passthrough.ts` (add getTransforms re-export)

Each follows the same pattern as OpenCode but simpler — most adapters return empty/undefined for hooks, agents, and addendum.

- [ ] **Step 1: Create transforms/crush.ts**

```ts
import type { Transform, RequestContext } from "../transform"
import { extractFileChangesFromBash, type FileChange } from "../fileChanges"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

const CRUSH_MCP_SERVER_NAME = "crush"
const CRUSH_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${CRUSH_MCP_SERVER_NAME}__read`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__write`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__edit`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__bash`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__glob`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__grep`,
]

export const crushTransforms: Transform[] = [
  {
    name: "crush-core",
    adapters: ["crush"],
    onRequest(ctx: RequestContext): RequestContext {
      const extractFileChangesFromToolUse = (toolName: string, toolInput: unknown): FileChange[] => {
        const input = toolInput as Record<string, unknown> | null | undefined
        const filePath = input?.file_path ?? input?.path
        if (toolName === "write" && filePath) return [{ operation: "wrote", path: String(filePath) }]
        if ((toolName === "edit" || toolName === "patch") && filePath) return [{ operation: "edited", path: String(filePath) }]
        if (toolName === "bash" && input?.command) return extractFileChangesFromBash(String(input.command))
        return []
      }

      return {
        ...ctx,
        blockedTools: BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
        allowedMcpTools: CRUSH_ALLOWED_MCP_TOOLS,
        sdkAgents: {},
        supportsThinking: true,
        extractFileChangesFromToolUse,
      }
    },
  },
]
```

- [ ] **Step 2: Create transforms/droid.ts**

```ts
import type { Transform, RequestContext } from "../transform"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

const DROID_MCP_SERVER_NAME = "droid"
const DROID_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${DROID_MCP_SERVER_NAME}__read`,
  `mcp__${DROID_MCP_SERVER_NAME}__write`,
  `mcp__${DROID_MCP_SERVER_NAME}__edit`,
  `mcp__${DROID_MCP_SERVER_NAME}__bash`,
  `mcp__${DROID_MCP_SERVER_NAME}__glob`,
  `mcp__${DROID_MCP_SERVER_NAME}__grep`,
]

export const droidTransforms: Transform[] = [
  {
    name: "droid-core",
    adapters: ["droid"],
    onRequest(ctx: RequestContext): RequestContext {
      return {
        ...ctx,
        blockedTools: BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
        allowedMcpTools: DROID_ALLOWED_MCP_TOOLS,
        sdkAgents: {},
        passthrough: false,
        leaksCwdViaSystemReminder: true,
      }
    },
  },
]
```

- [ ] **Step 3: Create transforms/pi.ts**

```ts
import type { Transform, RequestContext } from "../transform"
import { extractFileChangesFromBash, type FileChange } from "../fileChanges"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

const PI_MCP_SERVER_NAME = "pi"
const PI_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${PI_MCP_SERVER_NAME}__read`,
  `mcp__${PI_MCP_SERVER_NAME}__write`,
  `mcp__${PI_MCP_SERVER_NAME}__edit`,
  `mcp__${PI_MCP_SERVER_NAME}__bash`,
  `mcp__${PI_MCP_SERVER_NAME}__glob`,
  `mcp__${PI_MCP_SERVER_NAME}__grep`,
]

export const piTransforms: Transform[] = [
  {
    name: "pi-core",
    adapters: ["pi"],
    onRequest(ctx: RequestContext): RequestContext {
      const extractFileChangesFromToolUse = (toolName: string, toolInput: unknown): FileChange[] => {
        const input = toolInput as Record<string, unknown> | null | undefined
        const filePath = input?.filePath ?? input?.file_path ?? input?.path
        if (toolName === "write" && filePath) return [{ operation: "wrote", path: String(filePath) }]
        if (toolName === "edit" && filePath) return [{ operation: "edited", path: String(filePath) }]
        if (toolName === "bash" && input?.command) return extractFileChangesFromBash(String(input.command))
        return []
      }

      return {
        ...ctx,
        blockedTools: BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
        allowedMcpTools: PI_ALLOWED_MCP_TOOLS,
        sdkAgents: {},
        supportsThinking: true,
        extractFileChangesFromToolUse,
      }
    },
  },
]
```

- [ ] **Step 4: Create transforms/forgecode.ts**

```ts
import type { Transform, RequestContext } from "../transform"
import { extractFileChangesFromBash, type FileChange } from "../fileChanges"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

const FORGECODE_MCP_SERVER_NAME = "forgecode"
const FORGECODE_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${FORGECODE_MCP_SERVER_NAME}__read`,
  `mcp__${FORGECODE_MCP_SERVER_NAME}__write`,
  `mcp__${FORGECODE_MCP_SERVER_NAME}__edit`,
  `mcp__${FORGECODE_MCP_SERVER_NAME}__bash`,
  `mcp__${FORGECODE_MCP_SERVER_NAME}__glob`,
  `mcp__${FORGECODE_MCP_SERVER_NAME}__grep`,
]

export const forgeCodeTransforms: Transform[] = [
  {
    name: "forgecode-core",
    adapters: ["forgecode"],
    onRequest(ctx: RequestContext): RequestContext {
      const extractFileChangesFromToolUse = (toolName: string, toolInput: unknown): FileChange[] => {
        const input = toolInput as Record<string, unknown> | null | undefined
        const filePath = input?.file_path ?? input?.filePath ?? input?.path
        if (toolName === "write" && filePath) return [{ operation: "wrote", path: String(filePath) }]
        if ((toolName === "patch" || toolName === "multi_patch") && filePath) return [{ operation: "edited", path: String(filePath) }]
        if (toolName === "shell" && input?.command) return extractFileChangesFromBash(String(input.command))
        return []
      }

      return {
        ...ctx,
        blockedTools: BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
        allowedMcpTools: FORGECODE_ALLOWED_MCP_TOOLS,
        sdkAgents: {},
        extractFileChangesFromToolUse,
      }
    },
  },
]
```

- [ ] **Step 5: Create transforms/passthrough.ts**

```ts
import type { Transform, RequestContext } from "../transform"

const MCP_SERVER_NAME = "litellm"
const ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${MCP_SERVER_NAME}__read`,
  `mcp__${MCP_SERVER_NAME}__write`,
  `mcp__${MCP_SERVER_NAME}__edit`,
  `mcp__${MCP_SERVER_NAME}__bash`,
  `mcp__${MCP_SERVER_NAME}__glob`,
  `mcp__${MCP_SERVER_NAME}__grep`,
]

export const passthroughTransforms: Transform[] = [
  {
    name: "passthrough-core",
    adapters: ["passthrough"],
    onRequest(ctx: RequestContext): RequestContext {
      return {
        ...ctx,
        blockedTools: [],
        incompatibleTools: [],
        allowedMcpTools: ALLOWED_MCP_TOOLS,
        sdkAgents: {},
        passthrough: true,
        prefersStreaming: ctx.body?.stream === true,
      }
    },
  },
]
```

- [ ] **Step 6: Add re-exports to each adapter file**

Add to the bottom of each adapter file:

`src/proxy/adapters/crush.ts`:
```ts
import { crushTransforms } from "../transforms/crush"
export { crushTransforms }
```

`src/proxy/adapters/droid.ts`:
```ts
import { droidTransforms } from "../transforms/droid"
export { droidTransforms }
```

`src/proxy/adapters/pi.ts`:
```ts
import { piTransforms } from "../transforms/pi"
export { piTransforms }
```

`src/proxy/adapters/forgecode.ts`:
```ts
import { forgeCodeTransforms } from "../transforms/forgecode"
export { forgeCodeTransforms }
```

`src/proxy/adapters/passthrough.ts`:
```ts
import { passthroughTransforms } from "../transforms/passthrough"
export { passthroughTransforms }
```

- [ ] **Step 7: Run full test suite**

```bash
npx bun test 2>&1 | tail -5
```

Expected: same pass count, 0 fail. All changes are additive — existing adapter interfaces unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/proxy/transforms/ src/proxy/adapters/
git commit -m "refactor: extract behavioral transforms for all adapters"
```

---

### Task 7: Create adapter-to-transforms registry

**Files:**
- Create: `src/proxy/transforms/registry.ts`

A lookup function that maps adapter names to their built-in transforms. server.ts will use this to resolve the pipeline.

- [ ] **Step 1: Create registry.ts**

```ts
/**
 * Adapter transform registry.
 *
 * Maps adapter names to their built-in Transform arrays.
 * server.ts uses this to build the transform pipeline per request.
 */

import type { Transform } from "../transform"
import { openCodeTransforms } from "./opencode"
import { crushTransforms } from "./crush"
import { droidTransforms } from "./droid"
import { piTransforms } from "./pi"
import { forgeCodeTransforms } from "./forgecode"
import { passthroughTransforms } from "./passthrough"

const ADAPTER_TRANSFORMS: Record<string, readonly Transform[]> = {
  opencode: openCodeTransforms,
  crush: crushTransforms,
  droid: droidTransforms,
  pi: piTransforms,
  forgecode: forgeCodeTransforms,
  passthrough: passthroughTransforms,
}

/**
 * Get the built-in transforms for an adapter.
 * Returns empty array for unknown adapters (safe fallback).
 */
export function getAdapterTransforms(adapterName: string): readonly Transform[] {
  return ADAPTER_TRANSFORMS[adapterName] ?? []
}
```

- [ ] **Step 2: Run tests**

```bash
npx bun test 2>&1 | tail -5
```

Expected: same pass count, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add src/proxy/transforms/registry.ts
git commit -m "feat: add adapter transform registry"
```

---

### Task 8: Verify transform parity with adapter methods

**Files:**
- Create: `src/__tests__/transform-parity.test.ts`

Critical tests that verify each adapter's transforms produce the same output as the original adapter methods. This is the safety net for the server.ts migration.

- [ ] **Step 1: Write parity tests**

```ts
/**
 * Transform parity tests.
 *
 * Verify that each adapter's extracted transforms produce configuration
 * identical to the original adapter methods. This is the regression safety
 * net — if any test here fails, the transform extraction changed behavior.
 */

import { describe, it, expect } from "bun:test"
import { createRequestContext, runTransformHook } from "../proxy/transform"
import { openCodeTransforms } from "../proxy/transforms/opencode"
import { crushTransforms } from "../proxy/transforms/crush"
import { droidTransforms } from "../proxy/transforms/droid"
import { piTransforms } from "../proxy/transforms/pi"
import { forgeCodeTransforms } from "../proxy/transforms/forgecode"
import { passthroughTransforms } from "../proxy/transforms/passthrough"
import { openCodeAdapter } from "../proxy/adapters/opencode"
import { crushAdapter } from "../proxy/adapters/crush"
import { droidAdapter } from "../proxy/adapters/droid"
import { piAdapter } from "../proxy/adapters/pi"
import { forgeCodeAdapter } from "../proxy/adapters/forgecode"
import { passthroughAdapter } from "../proxy/adapters/passthrough"

function makeCtx(adapter: string, body: any = {}) {
  return createRequestContext({
    adapter,
    body,
    headers: new Headers(),
    model: "sonnet",
    messages: [],
    stream: false,
    workingDirectory: "/tmp",
  })
}

describe("OpenCode transform parity", () => {
  it("matches blockedTools", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    expect([...ctx.blockedTools]).toEqual([...openCodeAdapter.getBlockedBuiltinTools()])
  })

  it("matches incompatibleTools", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    expect([...ctx.incompatibleTools]).toEqual([...openCodeAdapter.getAgentIncompatibleTools()])
  })

  it("matches allowedMcpTools", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    expect([...ctx.allowedMcpTools]).toEqual([...openCodeAdapter.getAllowedMcpTools()])
  })

  it("matches coreToolNames", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    expect([...ctx.coreToolNames!]).toEqual([...openCodeAdapter.getCoreToolNames!()])
  })

  it("matches supportsThinking", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    expect(ctx.supportsThinking).toBe(openCodeAdapter.supportsThinking!())
  })

  it("matches shouldTrackFileChanges", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    expect(ctx.shouldTrackFileChanges).toBe(openCodeAdapter.shouldTrackFileChanges!())
  })

  it("matches buildSdkAgents with no Task tool", () => {
    const body = { tools: [] }
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode", body), "opencode")
    expect(ctx.sdkAgents).toEqual(openCodeAdapter.buildSdkAgents!(body, openCodeAdapter.getAllowedMcpTools()))
  })

  it("matches buildSystemContextAddendum with no agents", () => {
    const body = { tools: [] }
    const ctx = runTransformHook(
      openCodeTransforms,
      "onRequest",
      { ...makeCtx("opencode", body), systemContext: "test" },
      "opencode",
    )
    // No agents → no addendum → systemContext unchanged
    expect(ctx.systemContext).toBe("test")
  })

  it("matches file change extraction for write tool", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    const changes = ctx.extractFileChangesFromToolUse!("write", { filePath: "/test.ts" })
    const expected = openCodeAdapter.extractFileChangesFromToolUse!("write", { filePath: "/test.ts" })
    expect(changes).toEqual(expected)
  })

  it("matches file change extraction for edit tool", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    const changes = ctx.extractFileChangesFromToolUse!("edit", { filePath: "/test.ts" })
    const expected = openCodeAdapter.extractFileChangesFromToolUse!("edit", { filePath: "/test.ts" })
    expect(changes).toEqual(expected)
  })
})

describe("Crush transform parity", () => {
  it("matches blockedTools", () => {
    const ctx = runTransformHook(crushTransforms, "onRequest", makeCtx("crush"), "crush")
    expect([...ctx.blockedTools]).toEqual([...crushAdapter.getBlockedBuiltinTools()])
  })

  it("matches allowedMcpTools", () => {
    const ctx = runTransformHook(crushTransforms, "onRequest", makeCtx("crush"), "crush")
    expect([...ctx.allowedMcpTools]).toEqual([...crushAdapter.getAllowedMcpTools()])
  })

  it("matches supportsThinking", () => {
    const ctx = runTransformHook(crushTransforms, "onRequest", makeCtx("crush"), "crush")
    expect(ctx.supportsThinking).toBe(crushAdapter.supportsThinking!())
  })

  it("matches file change extraction", () => {
    const ctx = runTransformHook(crushTransforms, "onRequest", makeCtx("crush"), "crush")
    expect(ctx.extractFileChangesFromToolUse!("write", { file_path: "/a.ts" }))
      .toEqual(crushAdapter.extractFileChangesFromToolUse!("write", { file_path: "/a.ts" }))
  })
})

describe("Droid transform parity", () => {
  it("matches passthrough (always false)", () => {
    const ctx = runTransformHook(droidTransforms, "onRequest", makeCtx("droid"), "droid")
    expect(ctx.passthrough).toBe(droidAdapter.usesPassthrough!())
  })

  it("matches leaksCwdViaSystemReminder", () => {
    const ctx = runTransformHook(droidTransforms, "onRequest", makeCtx("droid"), "droid")
    expect(ctx.leaksCwdViaSystemReminder).toBe(droidAdapter.leaksCwdViaSystemReminder!())
  })
})

describe("Pi transform parity", () => {
  it("matches supportsThinking", () => {
    const ctx = runTransformHook(piTransforms, "onRequest", makeCtx("pi"), "pi")
    expect(ctx.supportsThinking).toBe(piAdapter.supportsThinking!())
  })

  it("matches file change extraction", () => {
    const ctx = runTransformHook(piTransforms, "onRequest", makeCtx("pi"), "pi")
    expect(ctx.extractFileChangesFromToolUse!("write", { filePath: "/a.ts" }))
      .toEqual(piAdapter.extractFileChangesFromToolUse!("write", { filePath: "/a.ts" }))
  })
})

describe("ForgeCode transform parity", () => {
  it("matches file change extraction for patch tool", () => {
    const ctx = runTransformHook(forgeCodeTransforms, "onRequest", makeCtx("forgecode"), "forgecode")
    expect(ctx.extractFileChangesFromToolUse!("patch", { file_path: "/a.ts" }))
      .toEqual(forgeCodeAdapter.extractFileChangesFromToolUse!("patch", { file_path: "/a.ts" }))
  })

  it("matches file change extraction for shell tool", () => {
    const ctx = runTransformHook(forgeCodeTransforms, "onRequest", makeCtx("forgecode"), "forgecode")
    expect(ctx.extractFileChangesFromToolUse!("shell", { command: "echo hi > /tmp/a" }))
      .toEqual(forgeCodeAdapter.extractFileChangesFromToolUse!("shell", { command: "echo hi > /tmp/a" }))
  })
})

describe("Passthrough (LiteLLM) transform parity", () => {
  it("matches passthrough (always true)", () => {
    const ctx = runTransformHook(passthroughTransforms, "onRequest", makeCtx("passthrough"), "passthrough")
    expect(ctx.passthrough).toBe(passthroughAdapter.usesPassthrough!())
  })

  it("matches prefersStreaming with stream=true", () => {
    const ctx = runTransformHook(
      passthroughTransforms,
      "onRequest",
      makeCtx("passthrough", { stream: true }),
      "passthrough",
    )
    expect(ctx.prefersStreaming).toBe(passthroughAdapter.prefersStreaming!({ stream: true }))
  })

  it("matches prefersStreaming with stream=false", () => {
    const ctx = runTransformHook(
      passthroughTransforms,
      "onRequest",
      makeCtx("passthrough", { stream: false }),
      "passthrough",
    )
    expect(ctx.prefersStreaming).toBe(passthroughAdapter.prefersStreaming!({ stream: false }))
  })

  it("matches empty blockedTools", () => {
    const ctx = runTransformHook(passthroughTransforms, "onRequest", makeCtx("passthrough"), "passthrough")
    expect([...ctx.blockedTools]).toEqual([...passthroughAdapter.getBlockedBuiltinTools()])
  })
})
```

- [ ] **Step 2: Run parity tests**

```bash
npx bun test src/__tests__/transform-parity.test.ts
```

Expected: all pass. If any fail, the transform extraction diverged from the adapter — fix before proceeding.

- [ ] **Step 3: Run full suite**

```bash
npx bun test 2>&1 | tail -5
```

Expected: baseline + new tests, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/transform-parity.test.ts
git commit -m "test: add transform-adapter parity tests"
```

---

### Task 9: Full verification and E2E

**Files:**
- None (verification only)

At this point, Phase 1 has:
- `AgentIdentity` interface extracted from `AgentAdapter`
- `Transform` interface + pipeline runner with tests
- All 6 adapters have extracted transforms with parity tests
- Transform registry maps adapter names to transforms
- All existing tests pass unchanged

The server.ts migration to USE the pipeline (replacing direct adapter method calls) is a large change that should be its own focused effort. This task verifies everything is solid before that work begins.

- [ ] **Step 1: Run full test suite**

```bash
npx bun test 2>&1 | tail -5
```

Expected: baseline + new tests (pipeline runner + parity), 0 fail.

- [ ] **Step 2: Verify no existing test files were modified**

```bash
git diff main -- 'src/__tests__/*.test.ts' | head -5
```

Expected: only NEW test files appear (transform-pipeline.test.ts, transform-parity.test.ts). No modifications to existing test files.

- [ ] **Step 3: Review the diff**

```bash
git diff main --stat
```

Verify: new files only (transform.ts, transforms/*.ts, registry.ts, new test files) + minimal modifications to existing files (adapter.ts interface extraction, adapter files re-export additions).

- [ ] **Step 4: Restart launchd and smoke test**

```bash
launchctl unload ~/Library/LaunchAgents/com.rynfar.meridian.plist && launchctl load ~/Library/LaunchAgents/com.rynfar.meridian.plist
curl -s http://127.0.0.1:3456/health
```

Expected: healthy response (this build doesn't change runtime behavior yet, but confirms it compiles and starts).

---

### Task 10: Migrate server.ts to use transform pipeline (future)

> **Note:** This task is the next major step but is intentionally left as a placeholder in this plan. It involves refactoring ~20 call sites in server.ts (2249 lines) to read from the pipeline context instead of calling adapter methods directly. It should be planned as a dedicated sub-task once Tasks 1-9 are merged and stable.
>
> The foundation from Tasks 1-9 makes this migration safe: parity tests verify transforms match adapter methods, so replacing `adapter.getBlockedBuiltinTools()` with `pipelineCtx.blockedTools` is a mechanical substitution verified by the existing test suite.
>
> This can be done incrementally — migrate one call site at a time, run tests after each.
