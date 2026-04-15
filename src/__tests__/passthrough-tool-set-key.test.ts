import { describe, expect, it } from "bun:test"
import { computeToolSetKey } from "../proxy/passthroughTools"

describe("computeToolSetKey", () => {
  it("is stable across input ordering", () => {
    const a = computeToolSetKey([
      { name: "write", input_schema: { type: "object" } },
      { name: "read", input_schema: { type: "object" } },
      { name: "bash", input_schema: { type: "object" } },
    ])
    const b = computeToolSetKey([
      { name: "read", input_schema: { type: "object" } },
      { name: "bash", input_schema: { type: "object" } },
      { name: "write", input_schema: { type: "object" } },
    ])
    expect(a).toBe(b)
  })

  it("is stable across property ordering in input_schema", () => {
    const a = computeToolSetKey([
      { name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ])
    const b = computeToolSetKey([
      { name: "read", input_schema: { properties: { path: { type: "string" } }, type: "object" } },
    ])
    expect(a).toBe(b)
  })

  it("changes when a tool's input schema changes", () => {
    const a = computeToolSetKey([
      { name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ])
    const b = computeToolSetKey([
      { name: "read", input_schema: { type: "object", properties: { path: { type: "number" } } } },
    ])
    expect(a).not.toBe(b)
  })

  it("changes when a tool is added", () => {
    const a = computeToolSetKey([{ name: "read" }])
    const b = computeToolSetKey([{ name: "read" }, { name: "write" }])
    expect(a).not.toBe(b)
  })

  it("changes when defer_loading flips", () => {
    const a = computeToolSetKey([{ name: "read", defer_loading: false }])
    const b = computeToolSetKey([{ name: "read", defer_loading: true }])
    expect(a).not.toBe(b)
  })

  it("treats missing schema as null consistently", () => {
    const a = computeToolSetKey([{ name: "read" }])
    const b = computeToolSetKey([{ name: "read", input_schema: null as any }])
    expect(a).toBe(b)
  })
})
