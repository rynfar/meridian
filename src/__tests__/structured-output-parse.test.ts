/**
 * Unit tests for src/proxy/structuredOutput.ts - pure parsing/normalization.
 * No I/O, no mocks required.
 */

import { describe, it, expect } from "bun:test"
import { parseOutputFormat } from "../proxy/structuredOutput"

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["a"],
  properties: { a: { type: "integer" } },
}

function parseSchema(input: Record<string, unknown>) {
  const result = parseOutputFormat({ format: { type: "json_schema", schema: input } })
  if (!result.ok) throw new Error(`expected ok, got: ${result.message}`)
  return result.value as { type: "json_schema"; schema: Record<string, unknown> }
}

describe("parseOutputFormat - $schema handling", () => {
  it("strips a root-level $schema before reaching the SDK", () => {
    // Any dialect but draft-07 makes the model fail to submit its structured
    // result, which surfaces as a 500. The keyword constrains nothing, so it
    // is dropped rather than passed through.
    const value = parseSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...schema,
    })
    expect(value.schema).toEqual(schema)
    expect("$schema" in value.schema).toBe(false)
  })

  it("strips the draft-07 $schema too, for one consistent shape", () => {
    const value = parseSchema({ $schema: "http://json-schema.org/draft-07/schema#", ...schema })
    expect(value.schema).toEqual(schema)
  })

  it("leaves a schema without $schema untouched", () => {
    const value = parseSchema({ ...schema })
    expect(value.schema).toEqual(schema)
  })

  it("does not mutate the caller's schema object", () => {
    const input = { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema }
    parseSchema(input)
    expect(input.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
  })

  it("keeps a nested $schema, which the SDK already tolerates", () => {
    // Only the root keyword breaks submission. Rewriting deeper would risk
    // clobbering a property legitimately named `$schema`.
    const nested = {
      type: "object",
      properties: {
        p: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
      },
    }
    expect(parseSchema(nested).schema).toEqual(nested)
  })
})
