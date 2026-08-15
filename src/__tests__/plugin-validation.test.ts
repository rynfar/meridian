import { describe, it, expect } from "bun:test"
import { validateTransform } from "../proxy/plugins/validation"
import { listAdapterNames } from "../proxy/adapters/detect"

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

  // #546: openai is a real adapter; plugins targeting it must not warn.
  it("accepts 'openai' as a known adapter without warning", () => {
    const result = validateTransform({
      name: "scoped",
      adapters: ["openai"],
      onRequest: () => {},
    })
    expect(result.valid).toBe(true)
    expect(result.warnings ?? []).not.toContain("openai")
  })

  it("accepts 'jcode' as a known adapter without warning", () => {
    const result = validateTransform({
      name: "scoped",
      adapters: ["jcode"],
      onRequest: () => {},
    })
    expect(result.valid).toBe(true)
    expect(result.warnings ?? []).not.toContain("jcode")
  })
})

// #791: the adapter list used to be hand-maintained here and drifted every
// time an adapter was added — it was missing claude-code, cherry and codex
// before prime missed it again. A plugin scoped to a real adapter was then
// reported as referencing an unknown one, which reads as the plugin being
// wrong rather than the list being stale. Deriving it from the registry is
// what makes that impossible; this pins it.
describe("adapter scoping stays in step with the registry (#791)", () => {
  it("accepts every adapter the registry knows, with no warnings", () => {
    for (const name of listAdapterNames()) {
      const result = validateTransform({ name: "p", adapters: [name], onRequest: () => {} })
      expect(result.valid).toBe(true)
      expect(result.warnings).toBeUndefined()
    }
  })

  it("accepts the adapters added since the hand-kept list was written", () => {
    const result = validateTransform({
      name: "p",
      adapters: ["prime", "claude-code", "cherry", "codex"],
      onRequest: () => {},
    })
    expect(result.valid).toBe(true)
    expect(result.warnings).toBeUndefined()
  })

  it("still warns about an adapter that genuinely does not exist", () => {
    const result = validateTransform({ name: "p", adapters: ["not-an-adapter"], onRequest: () => {} })
    expect(result.valid).toBe(true)
    expect(result.warnings).toEqual(["not-an-adapter"])
  })
})
