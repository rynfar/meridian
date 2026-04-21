/**
 * Plugin invocation stats — unit tests for the tracker and its integration
 * with runTransformHook / runObserveHook.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import {
  registerPluginStats,
  resetAllPluginStats,
  isTrackedPlugin,
  recordInvocation,
  recordError,
  getPluginStats,
} from "../proxy/plugins/stats"
import { runTransformHook, runObserveHook, type Transform, type RequestContext } from "../proxy/transform"

function makeCtx(): RequestContext {
  return {
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
}

describe("plugin stats — direct tracker", () => {
  beforeEach(() => {
    resetAllPluginStats()
  })

  it("reports undefined for unregistered plugin names", () => {
    expect(getPluginStats("not-registered")).toBeUndefined()
  })

  it("registers with empty counters", () => {
    registerPluginStats("p1")
    const s = getPluginStats("p1")
    expect(s).toBeDefined()
    expect(s!.hooks).toEqual({})
    expect(s!.lastInvokedAt).toBeUndefined()
    expect(s!.lastError).toBeUndefined()
  })

  it("accumulates invocations and durations per hook", () => {
    registerPluginStats("p1")
    recordInvocation("p1", "onRequest", 1.5)
    recordInvocation("p1", "onRequest", 2.5)
    recordInvocation("p1", "onResponse", 0.5)
    const s = getPluginStats("p1")!
    expect(s.hooks.onRequest).toEqual({ invocations: 2, errors: 0, totalMs: 4 })
    expect(s.hooks.onResponse).toEqual({ invocations: 1, errors: 0, totalMs: 0.5 })
    expect(s.lastInvokedAt).toBeGreaterThan(0)
  })

  it("records errors with hook + message + timestamp", () => {
    registerPluginStats("p1")
    recordError("p1", "onRequest", new Error("boom"))
    const s = getPluginStats("p1")!
    expect(s.hooks.onRequest).toEqual({ invocations: 0, errors: 1, totalMs: 0 })
    expect(s.lastError?.hook).toBe("onRequest")
    expect(s.lastError?.message).toBe("boom")
    expect(s.lastError?.at).toBeGreaterThan(0)
  })

  it("silently ignores records for unregistered plugins", () => {
    recordInvocation("ghost", "onRequest", 5)
    recordError("ghost", "onRequest", new Error("x"))
    expect(getPluginStats("ghost")).toBeUndefined()
  })

  it("resetAllPluginStats clears everything", () => {
    registerPluginStats("p1")
    recordInvocation("p1", "onRequest", 1)
    resetAllPluginStats()
    expect(getPluginStats("p1")).toBeUndefined()
    expect(isTrackedPlugin("p1")).toBe(false)
  })

  it("re-registering a plugin wipes its prior stats", () => {
    registerPluginStats("p1")
    recordInvocation("p1", "onRequest", 1)
    registerPluginStats("p1")
    const s = getPluginStats("p1")!
    expect(s.hooks).toEqual({})
  })
})

describe("plugin stats — pipeline runner integration", () => {
  beforeEach(() => {
    resetAllPluginStats()
  })

  it("counts onRequest invocations for registered plugins only", () => {
    const registered: Transform = {
      name: "registered",
      onRequest: (ctx) => ({ ...ctx, model: "modified" }),
    }
    const unregistered: Transform = {
      name: "not-registered",
      onRequest: (ctx) => ctx,
    }
    registerPluginStats("registered")

    runTransformHook([registered, unregistered], "onRequest", makeCtx(), "opencode")
    runTransformHook([registered, unregistered], "onRequest", makeCtx(), "opencode")

    expect(getPluginStats("registered")!.hooks.onRequest?.invocations).toBe(2)
    expect(getPluginStats("not-registered")).toBeUndefined()
  })

  it("counts errors when a plugin throws without crashing the pipeline", () => {
    const thrower: Transform = {
      name: "thrower",
      onRequest: () => { throw new Error("intentional") },
    }
    registerPluginStats("thrower")

    const result = runTransformHook([thrower], "onRequest", makeCtx(), "opencode")
    expect(result).toBeDefined()  // pipeline survived
    const s = getPluginStats("thrower")!
    expect(s.hooks.onRequest?.errors).toBe(1)
    expect(s.hooks.onRequest?.invocations).toBe(0)
    expect(s.lastError?.message).toBe("intentional")
  })

  it("does NOT count invocations skipped by adapter scoping", () => {
    const piOnly: Transform = {
      name: "pi-only",
      adapters: ["pi"],
      onRequest: (ctx) => ctx,
    }
    registerPluginStats("pi-only")

    runTransformHook([piOnly], "onRequest", makeCtx(), "opencode")  // skipped
    runTransformHook([piOnly], "onRequest", makeCtx(), "pi")        // counted

    expect(getPluginStats("pi-only")!.hooks.onRequest?.invocations).toBe(1)
  })

  it("runObserveHook also records invocations", () => {
    const observer: Transform = {
      name: "observer",
      onTelemetry: () => { /* no-op */ },
    }
    registerPluginStats("observer")

    runObserveHook([observer], "onTelemetry", { adapter: "opencode" } as any, "opencode")
    runObserveHook([observer], "onTelemetry", { adapter: "opencode" } as any, "opencode")

    expect(getPluginStats("observer")!.hooks.onTelemetry?.invocations).toBe(2)
  })

  it("totalMs accumulates across calls", async () => {
    const slow: Transform = {
      name: "slow",
      onRequest: (ctx) => {
        const start = performance.now()
        while (performance.now() - start < 2) { /* spin */ }
        return ctx
      },
    }
    registerPluginStats("slow")

    runTransformHook([slow], "onRequest", makeCtx(), "opencode")
    runTransformHook([slow], "onRequest", makeCtx(), "opencode")

    const s = getPluginStats("slow")!
    expect(s.hooks.onRequest?.invocations).toBe(2)
    expect(s.hooks.onRequest?.totalMs).toBeGreaterThan(3)  // 2 calls × ~2ms each
  })
})
