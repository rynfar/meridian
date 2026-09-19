import { describe, expect, it } from "bun:test"
import { AgSchemaCompiler, agSchemaError } from "../proxy/backends/antigravitySchema"

describe("Antigravity schema boundary", () => {
  it("validates draft 7 and 2020 schemas without coercion or defaults", () => {
    const schemas = new AgSchemaCompiler()
    const schema = { type: "object", properties: { answer: { type: "string" }, count: { type: "integer", default: 7 } }, required: ["answer", "count"], additionalProperties: false }
    for (const dialect of ["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft/2020-12/schema"]) {
      const validate = schemas.compile({ ...schema, $schema: dialect }, "test")
      expect(agSchemaError(validate, { answer: "READY", count: 7 })).toBeUndefined()
      expect(agSchemaError(validate, { output: { answer: "READY", count: 7 } })).toBeDefined()
      const missing = { answer: "READY" }
      expect(agSchemaError(validate, missing)).toBeDefined()
      expect(missing).toEqual({ answer: "READY" })
      expect(agSchemaError(validate, { answer: "READY", count: "7" })).toBeDefined()
    }
  })
  it("enforces array uniqueness, format and local references", () => {
    const validate = new AgSchemaCompiler().compile({ type: "array", uniqueItems: true, items: { $ref: "#/$defs/email" }, $defs: { email: { type: "string", format: "email" } } }, "test")
    expect(agSchemaError(validate, ["a@example.com"])).toBeUndefined()
    expect(agSchemaError(validate, ["a@example.com", "a@example.com"])).toBeDefined()
    expect(agSchemaError(validate, ["not an email"])).toBeDefined()
  })
  it("rejects remote references and async validation before invocation", () => {
    const schemas = new AgSchemaCompiler()
    expect(() => schemas.compile({ $ref: "https://example.com/schema.json" }, "test")).toThrow("unsupported")
    expect(() => schemas.compile({ $async: true, type: "object" }, "test")).toThrow("Async")
  })
})
