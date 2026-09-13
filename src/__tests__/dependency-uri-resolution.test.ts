import { describe, expect, it } from "bun:test"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import * as uri from "fast-uri"

describe("installed MCP schema URI resolution", () => {
  it.each(["http://127。0。0。1/", "http://ＦＯＯ.test/payload"])(
    "canonicalizes the HTTP hostname in %s",
    (input) => {
      const parsed = uri.parse(input)
      expect(parsed.error).toBeUndefined()
      expect(parsed.host).toBe(new URL(input).hostname)
      expect(uri.normalize(input)).toBe(new URL(input).href)
    },
  )

  it("canonicalizes a scheme-relative hostname after resolving its scheme", () => {
    const base = "http://example.test/root"
    const relative = "//127。0。0。1/payload"
    expect(uri.resolve(base, relative)).toBe(new URL(relative, base).href)
  })

  it("resolves a canonical reference to an IDN schema without losing validation", () => {
    const validate = new AjvJsonSchemaValidator().getValidator({
      $id: "http://example.test/root",
      $defs: {
        payload: {
          $id: "http://ＦＯＯ.test/payload",
          type: "object",
          required: ["value"],
          properties: { value: { type: "integer" } },
          additionalProperties: false,
        },
      },
      $ref: "http://foo.test/payload",
    })
    expect(validate({ value: 7 }).valid).toBe(true)
    expect(validate({ value: "7" }).valid).toBe(false)
    expect(validate({ other: 7 }).valid).toBe(false)
    expect(validate({ value: 7, extra: true }).valid).toBe(false)
  })
})
